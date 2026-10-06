import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { classifyRequest, checkUrl, type Decision, type PolicyCode } from "../policy/url.js";
import type { AuditStore } from "../audit.js";
import { log } from "../logger.js";

export interface Violation { code: PolicyCode; category: Decision["category"] }

/** Fixed, server-owned page scripts. The model never supplies code or selectors. */
const AUTH_SCRIPT = () =>
  !!document.querySelector('input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[name*="otp" i], input[name*="mfa" i]');
/** Single-turn: URL + credential-field check + extraction in one page evaluation (fixed, server-owned code). */
const COMBINED_SCRIPT = (kind: "record" | "results") => {
  const href = location.href;
  const auth = !!document.querySelector('input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[name*="otp" i], input[name*="mfa" i]');
  if (auth) return { href, auth, data: null as any };
  if (kind === "record") {
    const root = document.querySelector('[data-agent-region="record"]');
    if (!root) return { href, auth, data: null as any };
    const fields: { field: string; source: string; value: string }[] = [];
    root.querySelectorAll("[data-field]").forEach((el) => fields.push({ field: el.getAttribute("data-field") || "", source: el.getAttribute("data-source") || "", value: (el.textContent || "").trim().slice(0, 400) }));
    return { href, auth, data: { recordId: root.getAttribute("data-record-id") || "", fields } as any };
  }
  const root = document.querySelector('[data-agent-region="results"]');
  if (!root) return { href, auth, data: null as any };
  const items: { record_id: string; href: string }[] = [];
  root.querySelectorAll("[data-agent-result]").forEach((li) => { const a = li.querySelector("a"); items.push({ record_id: li.getAttribute("data-record-id") || "", href: a ? (a as HTMLAnchorElement).href : "" }); });
  return { href, auth, data: { items } as any };
};

export class BrowserBridge {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private taskId = "";
  private violation?: Violation;
  /** TEST-ONLY seam (not reachable from the model, the API or the extension): runs page mutations at precise points. */
  testSeam?: { beforeExtract?: (p: Page) => Promise<void>; afterExtract?: (p: Page) => Promise<void> };
  constructor(private siteOrigin: string, private audit: AuditStore) {}

  /** Connect to the dedicated browser over loopback CDP only. */
  async connect(cdpUrl: string) {
    const u = new URL(cdpUrl);
    if (u.hostname !== "127.0.0.1") throw new Error("CDP_NOT_LOOPBACK");
    this.browser = await chromium.connectOverCDP(cdpUrl);
  }
  get connected() { return !!this.browser?.isConnected(); }

  /** One fresh, isolated (non-persistent) context + ONE task tab per task. Nothing else is ever controlled. */
  async openTaskTab(taskId: string) {
    if (!this.browser) throw new Error("NOT_CONNECTED");
    this.taskId = taskId;
    this.violation = undefined;
    this.context = await this.browser.newContext({ acceptDownloads: false, serviceWorkers: "block", viewport: { width: 1100, height: 760 } });
    await this.context.route("**/*", async (route) => {
      const req = route.request();
      const url = req.url();
      const d = classifyRequest({ url, method: req.method(), isNavigation: req.isNavigationRequest() }, this.siteOrigin);
      const started = Date.now();
      const isFavicon = (() => { try { return new URL(url).pathname === "/favicon.ico"; } catch { return false; } })();
      try {
        if (d.allow) {
          // Fetch WITHOUT following redirects so each redirect hop is policy-checked BEFORE any request is sent to it.
          // (route.continue() lets Chromium follow redirects; a hop to an off-site host was observed to reach the destination.)
          const resp = await route.fetch({ maxRedirects: 0 });
          const st = resp.status();
          const loc = resp.headers()["location"];
          if (st >= 300 && st < 400 && loc) {
            let next = "";
            try { next = new URL(loc, url).toString(); } catch { /* malformed -> blocked below */ }
            const rd = classifyRequest({ url: next, method: "GET", isNavigation: req.isNavigationRequest() }, this.siteOrigin);
            if (!rd.allow) {
              this.audit.record({ task_id: this.taskId, category: "navigate", outcome: "blocked", code: rd.code, started });
              this.violation ??= { code: rd.code, category: rd.category };
              log("redirect_blocked", { code: rd.code });
              return await route.abort("blockedbyclient");
            }
          }
          return await route.fulfill({ response: resp });
        }
        this.audit.record({ task_id: this.taskId, category: d.category === "navigate" ? "navigate" : d.category === "popup" ? "popup" : "subresource", outcome: "blocked", code: d.code, started });
        if (!isFavicon) this.violation ??= { code: d.code, category: d.category };
        log("request_blocked", { code: d.code });
        await route.abort("blockedbyclient");
      } catch { /* page/context already closed */ }
    });
    // WebSockets are NOT covered by context.route(). The synthetic site needs none, so every socket is refused and
    // never connected to its target (we do not call connectToServer()).
    await this.context.routeWebSocket(/.*/, (ws) => {
      this.audit.record({ task_id: this.taskId, category: "websocket", outcome: "blocked", code: "WEBSOCKET_NOT_ALLOWED" });
      this.violation ??= { code: "WEBSOCKET_NOT_ALLOWED", category: "offsite" };
      log("websocket_blocked");
      void ws.close({ code: 1008, reason: "blocked" });
    });
    // Popups are never allowed: close immediately (their own requests are also routed/blocked).
    let claimed = false; // the first page of this fresh context is our own task tab
    this.context.on("page", (p) => {
      if (!claimed) { claimed = true; return; }
      this.audit.record({ task_id: this.taskId, category: "popup", outcome: "blocked", code: "POPUP_NOT_ALLOWED" });
      this.violation ??= { code: "POPUP_NOT_ALLOWED", category: "popup" };
      p.close().catch(() => {});
    });
    this.page = await this.context.newPage();
    await this.page.goto("about:blank");
  }

  async closeTaskTab() {
    try { await this.context?.close(); } catch { /* ignore */ }
    this.context = undefined; this.page = undefined;
  }

  takeViolation(): Violation | undefined { return this.violation; }
  currentUrl() { return this.page?.url() ?? ""; }

  /** Pre-validated navigation. The caller has already classified the URL; redirects are re-checked by route(). */
  async goto(url: string): Promise<"ok" | "failed"> {
    if (!this.page) throw new Error("NO_TAB");
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await this.page.waitForTimeout(350); // let page scripts attempt anything prohibited; route() records it
      // final-URL re-check (defence in depth)
      const final = classifyRequest({ url: this.page.url(), method: "GET", isNavigation: true }, this.siteOrigin);
      if (!final.allow) { this.violation ??= { code: final.code, category: final.category }; return "failed"; }
      return "ok";
    } catch {
      return "failed";
    }
  }

  /** Boolean only: no DOM content ever crosses to Node for this check. Checks the URL and EVERY frame (incl. iframes). */
  async isAuthPage(): Promise<boolean> {
    if (!this.page) return false;
    const u = checkUrl(this.page.url(), this.siteOrigin);
    if (u.ok && /^\/(login|signin|sign-in|auth|sso|oauth)/i.test(u.url.pathname)) return true;
    for (const f of this.page.frames()) {
      const fu = f.url();
      if (fu && fu !== "about:blank") {
        const c = checkUrl(fu, this.siteOrigin);
        if (c.ok && /^\/(login|signin|sign-in|auth|sso|oauth)/i.test(c.url.pathname)) return true;
      }
      try { if (await f.evaluate(AUTH_SCRIPT)) return true; } catch { return true; } // unreadable frame => fail closed
    }
    return false;
  }

  /** Re-validated immediately before EVERY extraction: current URL still approved, and not an auth page (any frame). */
  private async guardExtract(): Promise<{ kind: "auth" } | { kind: "blocked"; code: PolicyCode } | null> {
    if (!this.page) return { kind: "blocked", code: "ROUTE_NOT_ALLOWED" };
    const d = classifyRequest({ url: this.page.url(), method: "GET", isNavigation: true }, this.siteOrigin);
    if (!d.allow) {
      this.audit.record({ task_id: this.taskId, category: "inspect", outcome: "blocked", code: "EXTRACTION_URL_CHANGED" });
      this.violation ??= { code: "EXTRACTION_URL_CHANGED", category: d.category };
      return { kind: "blocked", code: d.code };
    }
    if (await this.isAuthPage()) return { kind: "auth" };
    return null;
  }
  /**
   * check -> extract -> re-check. The main-frame read is ONE evaluate that returns {href, auth, data} in a single JS turn,
   * so a page timer cannot slip between the check and the read. After the read the URL and ALL frames are re-checked;
   * on any failure or difference the data is dropped here and never returned to the coordinator (or model).
   */
  private async extract(kind: "record" | "results") {
    const g = await this.guardExtract(); if (g) return g;
    await this.testSeam?.beforeExtract?.(this.page!);
    const one = await this.page!.evaluate(COMBINED_SCRIPT, kind);
    const d = classifyRequest({ url: one.href, method: "GET", isNavigation: true }, this.siteOrigin);
    if (!d.allow) return this.blockedExtraction(d.category, d.code);
    if (one.auth) return { kind: "auth" as const };
    await this.testSeam?.afterExtract?.(this.page!);
    const after = classifyRequest({ url: this.page!.url(), method: "GET", isNavigation: true }, this.siteOrigin);
    if (!after.allow || this.page!.url() !== one.href) return this.blockedExtraction(after.category, after.allow ? "ROUTE_NOT_ALLOWED" : after.code);
    if (await this.isAuthPage()) return { kind: "auth" as const };
    return { kind: "ok" as const, data: one.data };
  }
  private blockedExtraction(category: Decision["category"], code: PolicyCode) {
    this.audit.record({ task_id: this.taskId, category: "inspect", outcome: "blocked", code: "EXTRACTION_URL_CHANGED" });
    this.violation ??= { code: "EXTRACTION_URL_CHANGED", category };
    return { kind: "blocked" as const, code };
  }
  async extractRecord() {
    const r = await this.extract("record");
    return r.kind === "ok" ? { kind: "ok" as const, data: r.data as { recordId: string; fields: { field: string; source: string; value: string }[] } | null } : r;
  }
  async extractResults() {
    const r = await this.extract("results");
    return r.kind === "ok" ? { kind: "ok" as const, data: r.data as { items: { record_id: string; href: string }[] } | null } : r;
  }
  async close() { await this.closeTaskTab(); try { await this.browser?.close(); } catch { /* ignore */ } }
  async disconnect() { await this.closeTaskTab(); this.browser = undefined; }
}
