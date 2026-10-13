import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import { verifyDedicatedArgs, type DedicatedExpect } from "./launch.js";
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
/** Credential-field search that also descends into OPEN shadow roots (closed ones are covered by the CDP pierce scan in isAuthPage). */
const HAS_CRED_SRC = `function hasCred(root, depth){
  var Ep = Element.prototype;
  var sel = ${JSON.stringify(CRED_SELECTOR)};
  var qs = (root.nodeType === 9 ? Document.prototype.querySelectorAll : (root.nodeType === 11 ? DocumentFragment.prototype.querySelectorAll : Ep.querySelectorAll));
  if (qs.call(root, sel).length > 0) return true;
  if (depth > 8) return true; // absurd nesting: fail closed
  var all = qs.call(root, "*");
  for (var i = 0; i < all.length && i < 5000; i++) { var sr = all[i].shadowRoot; if (sr && hasCred(sr, depth + 1)) return true; }
  return false;
}`;
const AUTH_SRC = `(function(){ ${HAS_CRED_SRC} return hasCred(document, 0); })`;
/** Fields the agent may ever read. Anything else (including hidden/undeclared data-* elements) is ignored. */
export const EXTRACTABLE_FIELDS = ["claim_status", "balance", "payer", "service_date", "notes"] as const;
const COMBINED_SRC = `(function(arg){
  ${HAS_CRED_SRC}
  var kind = arg.kind, caps = arg.caps, allow = arg.allow;
  var Dp = Document.prototype, Ep = Element.prototype;
  var href = location.href;
  var auth = hasCred(document, 0);
  if (auth) return { href: href, auth: true, truncated: false, bytes: 0, data: null };
  var attr = function(el, n){ return Ep.getAttribute.call(el, n) || ""; };
  // own rendering of one element: display, visibility, opacity, hidden/aria-hidden attributes, non-empty box
  var ownVisible = function(el){
    try {
      var cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || parseFloat(cs.opacity) === 0) return false;
      if (Ep.hasAttribute.call(el, "hidden") || attr(el, "aria-hidden") === "true") return false;
      return el.getClientRects().length > 0;
    } catch (e) { return false; }
  };
  var chainVisible = function(el){ for (var n = el; n && n.nodeType === 1; n = n.parentElement) { if (!ownVisible(n)) return false; } return true; };
  // visible text only: walk descendants, skipping any subtree whose element is not visibly rendered
  var collect = function(node, st){
    if (st.len > caps.maxChars) { st.cut = true; return; } // content remains but the cap stopped collection: a lossy cut
    if (node.nodeType === 3) { var t = String(node.data).replace(/\\s+/g, " "); st.out += t; st.len += t.length; return; }
    if (node.nodeType !== 1) return;
    if (st.top !== node && !ownVisible(node)) return;
    for (var c = node.firstChild; c; c = c.nextSibling) collect(c, st);
  };
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
      if (allow.indexOf(name) < 0 || !chainVisible(el)) continue;
      if (fields.length >= caps.maxFields) { truncated = true; break; }
      var src = attr(el, "data-source");
      if (src.length > caps.maxSource) { truncated = true; }
      src = src.slice(0, caps.maxSource);
      if (!/^[A-Za-z ]{0,40}$/.test(src)) src = "";
      var st = { out: "", len: 0, top: el, cut: false };
      collect(el, st);
      var val = st.out.trim();
      if (st.cut || val.length > caps.maxChars) { truncated = true; val = val.slice(0, caps.maxChars); }
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
    if (!chainVisible(li)) continue;
    var a = Ep.querySelector.call(li, "a");
    var h = a ? String(a.href) : "";
    if (h.length > 300) truncated = true;
    h = h.slice(0, 300);
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
  testSeam?: { beforeExtract?: (p: Page) => Promise<void>; afterExtract?: (p: Page) => Promise<void>; beforeGoto?: () => Promise<void>; afterPostCheck?: (p: Page) => Promise<void>; beforeNewContext?: () => Promise<void>; beforeClose?: () => Promise<void> };
  constructor(private siteOrigin: string, private audit: AuditStore) {}

  /** Connect to the dedicated browser over loopback CDP only. */
  async connect(cdpUrl: string, expect: DedicatedExpect) {
    const u = new URL(cdpUrl);
    if (u.hostname !== "127.0.0.1") throw new Error("CDP_NOT_LOOPBACK");
    const browser = await chromium.connectOverCDP(cdpUrl);
    // Refuse any browser that is not the one our launcher spawned with the required containment flags/profile.
    let ok = false;
    try {
      const sess = await browser.newBrowserCDPSession();
      const { arguments: args } = (await sess.send("Browser.getBrowserCommandLine" as any)) as { arguments: string[] };
      ok = verifyDedicatedArgs(args, expect);
    } catch { ok = false; }
    if (!ok) { try { await browser.close(); } catch { /* disconnect */ } throw new Error("BROWSER_NOT_DEDICATED"); }
    this.browser = browser;
  }
  get connected() { return !!this.browser?.isConnected(); }

  /** One fresh, isolated (non-persistent) context + ONE task tab per task. Nothing else is ever controlled. */
  async openTaskTab(taskId: string, signal?: AbortSignal) {
    if (!this.browser) throw new Error("NOT_CONNECTED");
    if (this.keepTabOpenForDemo) await this.closeTaskTab(true);
    this.taskId = taskId;
    this.violation = undefined;
    // Context creation is abortable: Playwright sends newContext with no timeout, so race it against the task signal and
    // close the context if it resolves after the abort (no leaked contexts, no further setup).
    const browser = this.browser;
    const ctxP = (async () => { await this.testSeam?.beforeNewContext?.(); return browser.newContext({ acceptDownloads: false, serviceWorkers: "block", viewport: { width: 1100, height: 760 } }); })();
    let ctx: BrowserContext;
    try {
      ctx = await new Promise<BrowserContext>((res, rej) => {
        if (signal?.aborted) return rej(new Error("ABORTED"));
        const on = () => rej(new Error("ABORTED"));
        signal?.addEventListener("abort", on, { once: true });
        ctxP.then((c) => { signal?.removeEventListener("abort", on); res(c); }, (e) => { signal?.removeEventListener("abort", on); rej(e); });
      });
    } catch (e) {
      void ctxP.then((c) => c.close(), () => {}).catch(() => {});
      throw e;
    }
    this.context = ctx;
    const myCtx = ctx;
    await this.context.route("**/*", async (route) => {
      if (this.context !== myCtx) { try { await route.abort("aborted"); } catch { /* closed */ } return; } // stale task: touch no shared state
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
    if (this.onFrame) await this.startScreencast(this.cdp);
    await this.page.goto("about:blank");
  }

  /** CDP screencast of the task tab, throttled to at most 5 frames per second. Stops when the task context closes. */
  private async startScreencast(cdp: CDPSession) {
    let last = 0;
    cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      const now = Date.now();
      if (now - last < 200) return;
      last = now;
      this.onFrame?.(f.data);
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800 });
  }

  get hasTab() { return !!this.context && !!this.page; }
  contextCount() { return this.browser?.contexts().length ?? 0; }
  /** Captures and clears THIS task's handles synchronously, then closes them: a slow close can never clear a newer task's state. */
  /** DEMO-ONLY (set by scripts/demo-run.ts, never by the API/model/tests): keep the last task tab on screen until the next task starts. */
  keepTabOpenForDemo = false;
  /** Hosted live demo only: receives base64 JPEG frames of the task tab. Unset (default) => no screencast is started. */
  onFrame?: (jpegBase64: string) => void;
  private pendingCloses = new Set<Promise<void>>();
  /** Resolves when every close started so far (including abort-triggered ones) has finished. */
  async settleCloses() { while (this.pendingCloses.size) await Promise.allSettled([...this.pendingCloses]); }
  closeTaskTab(force = false): Promise<void> {
    if (this.keepTabOpenForDemo && !force) return Promise.resolve();
    const p = this.closeTaskTabInner();
    this.pendingCloses.add(p);
    void p.finally(() => this.pendingCloses.delete(p));
    return p;
  }
  private async closeTaskTabInner() {
    const ctx = this.context;
    this.context = undefined; this.page = undefined; this.cdp = undefined;
    await this.testSeam?.beforeClose?.();
    try { await ctx?.close(); } catch { /* ignore */ }
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
    // Closed shadow roots (invisible to page script) are exposed by CDP's pierced DOM tree: scan it for credential inputs too.
    try {
      const doc = (await this.cdp!.send("DOM.getDocument", { depth: -1, pierce: true })) as any;
      const stack = [doc.root];
      let seen = 0;
      while (stack.length) {
        const n = stack.pop();
        if (++seen > 20000) return true; // absurd DOM: fail closed
        if (n.nodeType === 1 && String(n.nodeName).toUpperCase() === "INPUT") {
          const at: Record<string, string> = {};
          for (let i = 0; i + 1 < (n.attributes?.length ?? 0); i += 2) at[String(n.attributes[i]).toLowerCase()] = String(n.attributes[i + 1]);
          if ((at.type ?? "").toLowerCase() === "password" || /one-time-code|current-password/i.test(at.autocomplete ?? "") || /otp|mfa/i.test(at.name ?? "")) return true;
        }
        for (const k of ["children", "shadowRoots"]) for (const c of n[k] ?? []) stack.push(c);
        if (n.contentDocument) stack.push(n.contentDocument);
      }
    } catch { return true; } // cannot inspect => fail closed
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
    await this.testSeam?.afterPostCheck?.(this.page!);
    if (await this.isAuthPage()) return { kind: "auth" as const };
    // the LAST thing before returning: re-validate the route after every await above
    const last = classifyRequest({ url: this.page!.url(), method: "GET", isNavigation: true }, this.siteOrigin);
    if (!last.allow || this.page!.url() !== one.href) return this.blockedExtraction(last.category, last.allow ? "ROUTE_NOT_ALLOWED" : last.code);
    return { kind: "ok" as const, data: one.data, truncated: one.truncated, bytes: one.bytes, href: one.href };
  }
  private blockedExtraction(category: Decision["category"], code: PolicyCode) {
    this.audit.record({ task_id: this.taskId, category: "inspect", outcome: "blocked", code: "EXTRACTION_URL_CHANGED" });
    this.violation ??= { code: "EXTRACTION_URL_CHANGED", category };
    return { kind: "blocked" as const, code };
  }
  async extractRecord(maxBytes = 4000) {
    const r = await this.extract("record", maxBytes);
    return r.kind === "ok" ? { kind: "ok" as const, data: r.data as (RecordData & { truncated?: boolean }) | null, truncated: r.truncated, bytes: r.bytes, href: r.href } : r;
  }
  async extractResults(maxBytes = 4000) {
    const r = await this.extract("results", maxBytes);
    return r.kind === "ok" ? { kind: "ok" as const, data: r.data as ResultsData | null, truncated: r.truncated, bytes: r.bytes, href: r.href } : r;
  }
  async close() { await this.closeTaskTab(true); try { await this.browser?.close(); } catch { /* ignore */ } }
  async disconnect() { await this.closeTaskTab(); this.browser = undefined; }
}
