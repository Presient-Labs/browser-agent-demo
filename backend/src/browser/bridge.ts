import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { classifyRequest, checkUrl, type Decision, type PolicyCode } from "../policy/url.js";
import type { AuditStore } from "../audit.js";
import { log } from "../logger.js";

export interface Violation { code: PolicyCode; category: Decision["category"] }

/** Fixed, server-owned page scripts. The model never supplies code or selectors. */
const AUTH_SCRIPT = () =>
  !!document.querySelector('input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[name*="otp" i], input[name*="mfa" i]');
const RECORD_SCRIPT = () => {
  const root = document.querySelector('[data-agent-region="record"]');
  if (!root) return null;
  const fields: { field: string; source: string; value: string }[] = [];
  root.querySelectorAll("[data-field]").forEach((el) => {
    fields.push({ field: el.getAttribute("data-field") || "", source: el.getAttribute("data-source") || "", value: (el.textContent || "").trim().slice(0, 400) });
  });
  return { recordId: root.getAttribute("data-record-id") || "", fields };
};
const RESULTS_SCRIPT = () => {
  const root = document.querySelector('[data-agent-region="results"]');
  if (!root) return null;
  const items: { record_id: string; href: string }[] = [];
  root.querySelectorAll("[data-agent-result]").forEach((li) => {
    const a = li.querySelector("a");
    items.push({ record_id: li.getAttribute("data-record-id") || "", href: a ? (a as HTMLAnchorElement).href : "" });
  });
  return { items };
};

export class BrowserBridge {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private taskId = "";
  private violation?: Violation;
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
        if (d.allow) return await route.continue();
        this.audit.record({ task_id: this.taskId, category: d.category === "navigate" ? "navigate" : d.category === "popup" ? "popup" : "subresource", outcome: "blocked", code: d.code, started });
        if (!isFavicon) this.violation ??= { code: d.code, category: d.category };
        log("request_blocked", { code: d.code });
        await route.abort("blockedbyclient");
      } catch { /* page/context already closed */ }
    });
    // Popups are never allowed: close immediately (their own requests are also routed/blocked).
    this.context.on("page", (p) => {
      if (p === this.page) return;
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

  /** Boolean only: no DOM content ever crosses to Node for this check. */
  async isAuthPage(): Promise<boolean> {
    if (!this.page) return false;
    const u = checkUrl(this.page.url(), this.siteOrigin);
    if (u.ok && /^\/(login|signin|sign-in|auth|sso|oauth)/i.test(u.url.pathname)) return true;
    return this.page.evaluate(AUTH_SCRIPT);
  }
  async extractRecord() { return this.page!.evaluate(RECORD_SCRIPT); }
  async extractResults() { return this.page!.evaluate(RESULTS_SCRIPT); }
  async close() { await this.closeTaskTab(); try { await this.browser?.close(); } catch { /* ignore */ } }
  async disconnect() { await this.closeTaskTab(); this.browser = undefined; }
}
