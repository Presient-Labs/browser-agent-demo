import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import { verifyDedicatedArgs } from "./launch.js";
import { classifyRequest, checkUrl, type Decision, type PolicyCode } from "../policy/url.js";
import type { AuditStore } from "../audit.js";
import { log } from "../logger.js";

export interface Violation { code: PolicyCode; category: Decision["category"] }

/**
 * Fixed, server-owned page scripts, written as PLAIN JS strings and run ONLY in a CDP isolated world (Page.createIsolatedWorld).
 * An isolated world has its own pristine JS builtins/DOM wrappers, so a hostile page that overrides document.querySelector,
 * Element.prototype.* etc. in its own (main) world cannot influence what these scripts see. The model never supplies code.
 */
const CRED_SELECTOR = 'input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[name*="otp" i], input[name*="mfa" i]';
const AUTH_SRC = `(function(){ return Document.prototype.querySelectorAll.call(document, ${JSON.stringify(CRED_SELECTOR)}).length > 0; })`;
/** Fields the agent may ever read. Anything else (including hidden/undeclared data-* elements) is ignored. */
export const EXTRACTABLE_FIELDS = ["claim_status", "balance", "payer", "service_date", "notes"] as const;
const COMBINED_SRC = `(function(arg){
  var kind = arg.kind, caps = arg.caps, allow = arg.allow;
  var Dp = Document.prototype, Ep = Element.prototype;
  var href = location.href;
  var auth = Dp.querySelectorAll.call(document, ${JSON.stringify(CRED_SELECTOR)}).length > 0;
  if (auth) return { href: href, auth: true, truncated: false, bytes: 0, data: null };
  var attr = function(el, n){ return Ep.getAttribute.call(el, n) || ""; };
  var visible = function(el){ try { var cs = getComputedStyle(el); return cs.display !== "none" && cs.visibility !== "hidden" && el.getClientRects().length > 0; } catch (e) { return false; } };
  var bytes = 0, truncated = false;
  var take = function(n){ bytes += n; if (bytes > caps.maxBytes) { truncated = true; return false; } return true; };
  if (kind === "record") {
    var root = Dp.querySelector.call(document, '[data-agent-region="record"]');
    if (!root) return { href: href, auth: false, truncated: false, bytes: 0, data: null };
    var rid = attr(root, "data-record-id").slice(0, 16);
    var nodes = Ep.querySelectorAll.call(root, "[data-field]");
    var fields = [];
    for (var i = 0; i < nodes.length && i < caps.maxScan; i++) {
      var el = nodes[i];
      var name = attr(el, "data-field");
      if (allow.indexOf(name) < 0 || !visible(el)) continue;
      if (fields.length >= caps.maxFields) { truncated = true; break; }
      var src = attr(el, "data-source").slice(0, caps.maxSource);
      if (!/^[A-Za-z ]{0,40}$/.test(src)) src = "";
      var tc = el.firstChild && el.childNodes.length === 1 && el.firstChild.nodeType === 3 ? el.firstChild.data : (el.textContent || "");
      var val = String(tc).trim().slice(0, caps.maxChars);
      if (!take(name.length + src.length + val.length + 20)) break;
      fields.push({ field: name, source: src, value: val });
    }
    if (nodes.length > caps.maxScan) truncated = true;
    return { href: href, auth: false, truncated: truncated, bytes: bytes, data: { recordId: rid, fields: fields } };
  }
  var rroot = Dp.querySelector.call(document, '[data-agent-region="results"]');
  if (!rroot) return { href: href, auth: false, truncated: false, bytes: 0, data: null };
  var lis = Ep.querySelectorAll.call(rroot, "[data-agent-result]");
  var items = [];
  for (var j = 0; j < lis.length && j < caps.maxScan; j++) {
    if (items.length >= caps.maxResults) { truncated = true; break; }
    var li = lis[j];
    var a = Ep.querySelector.call(li, "a");
    var h = a ? String(a.href).slice(0, 300) : "";
    var r = attr(li, "data-record-id").slice(0, 16);
    if (!take(h.length + r.length + 20)) break;
    items.push({ record_id: r, href: h });
  }
  if (lis.length > caps.maxScan) truncated = true;
  return { href: href, auth: false, truncated: truncated, bytes: bytes, data: { items: items } };
})`;

export interface RecordData { recordId: string; fields: { field: string; source: string; value: string }[] }
export interface ResultsData { items: { record_id: string; href: string }[] }
const MAX_REDIRECT_HOPS = 5;

export class BrowserBridge {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private taskId = "";
  private violation?: Violation;
  private cdp?: CDPSession;
  private redirectTarget?: string;
  /** TEST-ONLY seam (not reachable from the model, the API or the extension): runs page mutations at precise points. */
  testSeam?: { beforeExtract?: (p: Page) => Promise<void>; afterExtract?: (p: Page) => Promise<void>; beforeGoto?: () => Promise<void> };
  constructor(private siteOrigin: string, private audit: AuditStore) {}

  /** Connect to the dedicated browser over loopback CDP only. */
  async connect(cdpUrl: string) {
    const u = new URL(cdpUrl);
    if (u.hostname !== "127.0.0.1") throw new Error("CDP_NOT_LOOPBACK");
    const browser = await chromium.connectOverCDP(cdpUrl);
    // Refuse any browser that is not the one our launcher spawned with the required containment flags/profile.
    let ok = false;
    try {
      const sess = await browser.newBrowserCDPSession();
      const { arguments: args } = (await sess.send("Browser.getBrowserCommandLine" as any)) as { arguments: string[] };
      ok = verifyDedicatedArgs(args);
    } catch { ok = false; }
    if (!ok) { try { await browser.close(); } catch { /* disconnect */ } throw new Error("BROWSER_NOT_DEDICATED"); }
    this.browser = browser;
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
          // Chromium must NEVER follow a redirect on its own: Playwright does not re-run this handler for hops after the
          // first (redirectedFrom requests are continued). So every redirect is turned into an abort here; goto() re-issues
          // the (policy-checked) target as a brand-new navigation, which comes back through this handler.
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
            if (req.isNavigationRequest() && req.frame() === this.page?.mainFrame()) this.redirectTarget = next;
            return await route.abort("aborted");
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
    this.cdp = await this.context.newCDPSession(this.page);
    await this.page.goto("about:blank");
  }

  async closeTaskTab() {
    try { await this.context?.close(); } catch { /* ignore */ }
    this.context = undefined; this.page = undefined; this.cdp = undefined;
  }

  takeViolation(): Violation | undefined { return this.violation; }
  currentUrl() { return this.page?.url() ?? ""; }

  /** Pre-validated navigation. Redirects are followed HERE, one policy-checked hop at a time (see the route handler). */
  async goto(first: string): Promise<"ok" | "failed"> {
    if (!this.page) throw new Error("NO_TAB");
    let url = first;
    try {
      for (let hop = 0; ; hop++) {
        if (hop > MAX_REDIRECT_HOPS) {
          this.audit.record({ task_id: this.taskId, category: "navigate", outcome: "blocked", code: "REDIRECT_LIMIT" });
          this.violation ??= { code: "REDIRECT_LIMIT", category: "navigate" };
          return "failed";
        }
        this.redirectTarget = undefined;
        await this.testSeam?.beforeGoto?.();
        try { await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 }); }
        catch (e) { if (!this.redirectTarget) throw e; }
        if (this.violation) return "failed";
        if (!this.redirectTarget) break;
        url = this.redirectTarget;
      }
      await this.page.waitForTimeout(350); // let page scripts attempt anything prohibited; route() records it
      const final = classifyRequest({ url: this.page.url(), method: "GET", isNavigation: true }, this.siteOrigin);
      if (!final.allow) { this.violation ??= { code: final.code, category: final.category }; return "failed"; }
      return "ok";
    } catch {
      return "failed";
    }
  }

  private async frameTree(): Promise<{ id: string; url: string }[]> {
    const t = (await this.cdp!.send("Page.getFrameTree")) as any;
    const out: { id: string; url: string }[] = [];
    const walk = (n: any) => { out.push({ id: n.frame.id, url: n.frame.url }); (n.childFrames ?? []).forEach(walk); };
    walk(t.frameTree);
    return out;
  }
  private async isolatedEval<T>(frameId: string, src: string, arg: unknown): Promise<T> {
    const w = (await this.cdp!.send("Page.createIsolatedWorld", { frameId, worldName: "agent-readonly" })) as { executionContextId: number };
    const r = (await this.cdp!.send("Runtime.evaluate", { expression: `(${src})(${JSON.stringify(arg ?? null)})`, contextId: w.executionContextId, returnByValue: true })) as any;
    if (r.exceptionDetails) throw new Error("EVAL_FAILED");
    return r.result.value as T;
  }

  /** Boolean only: no DOM content ever crosses to Node for this check. Checks the URL and EVERY frame (incl. iframes). */
  async isAuthPage(): Promise<boolean> {
    if (!this.page) return false;
    const u = checkUrl(this.page.url(), this.siteOrigin);
    if (u.ok && /^\/(login|signin|sign-in|auth|sso|oauth)/i.test(u.url.pathname)) return true;
    let frames: { id: string; url: string }[];
    try { frames = await this.frameTree(); } catch { return true; } // fail closed
    for (const f of frames) {
      if (f.url && f.url !== "about:blank") {
        const c = checkUrl(f.url, this.siteOrigin);
        if (c.ok && /^\/(login|signin|sign-in|auth|sso|oauth)/i.test(c.url.pathname)) return true;
      }
      try { if (await this.isolatedEval<boolean>(f.id, AUTH_SRC, null)) return true; } catch { return true; } // unreadable frame => fail closed
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
  private async extract(kind: "record" | "results", maxBytes: number) {
    const g = await this.guardExtract(); if (g) return g;
    await this.testSeam?.beforeExtract?.(this.page!);
    const mainId = (await this.frameTree())[0].id;
    const caps = { maxFields: 40, maxChars: 400, maxSource: 40, maxResults: 20, maxScan: 2000, maxBytes };
    const one = await this.isolatedEval<{ href: string; auth: boolean; truncated: boolean; bytes: number; data: any }>(mainId, COMBINED_SRC, { kind, caps, allow: EXTRACTABLE_FIELDS });
    const d = classifyRequest({ url: one.href, method: "GET", isNavigation: true }, this.siteOrigin);
    if (!d.allow) return this.blockedExtraction(d.category, d.code);
    if (one.auth) return { kind: "auth" as const };
    await this.testSeam?.afterExtract?.(this.page!);
    const after = classifyRequest({ url: this.page!.url(), method: "GET", isNavigation: true }, this.siteOrigin);
    if (!after.allow || this.page!.url() !== one.href) return this.blockedExtraction(after.category, after.allow ? "ROUTE_NOT_ALLOWED" : after.code);
    if (await this.isAuthPage()) return { kind: "auth" as const };
    return { kind: "ok" as const, data: one.data, truncated: one.truncated, bytes: one.bytes };
  }
  private blockedExtraction(category: Decision["category"], code: PolicyCode) {
    this.audit.record({ task_id: this.taskId, category: "inspect", outcome: "blocked", code: "EXTRACTION_URL_CHANGED" });
    this.violation ??= { code: "EXTRACTION_URL_CHANGED", category };
    return { kind: "blocked" as const, code };
  }
  async extractRecord(maxBytes = 4000) {
    const r = await this.extract("record", maxBytes);
    return r.kind === "ok" ? { kind: "ok" as const, data: r.data as (RecordData & { truncated?: boolean }) | null, truncated: r.truncated, bytes: r.bytes } : r;
  }
  async extractResults(maxBytes = 4000) {
    const r = await this.extract("results", maxBytes);
    return r.kind === "ok" ? { kind: "ok" as const, data: r.data as ResultsData | null, truncated: r.truncated, bytes: r.bytes } : r;
  }
  async close() { await this.closeTaskTab(); try { await this.browser?.close(); } catch { /* ignore */ } }
  async disconnect() { await this.closeTaskTab(); this.browser = undefined; }
}
