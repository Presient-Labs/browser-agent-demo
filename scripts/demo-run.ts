// Drives ONE scripted end-to-end run through the real extension panel page.
// DEMO_PROVIDER=anthropic -> REAL model (key from the backend-only .env; never printed). Default: deterministic FAKE, labelled FAKE.
// The panel is the extension's sidepanel.html opened in a browser tab (Chrome offers no automation hook to open the native
// side-panel UI); the extension is genuinely loaded via --load-extension. Console output is status-only (never result content).
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { startSite } from "../site/src/server.js";
import { loadConfig } from "../backend/src/config.js";
import { AuditStore } from "../backend/src/audit.js";
import { BrowserBridge } from "../backend/src/browser/bridge.js";
import { launchDedicatedBrowser } from "../backend/src/browser/launch.js";
import { createBackend } from "../backend/src/server.js";
import { resolveProviderAudited } from "../backend/src/bootstrap.js";
import { FakeProvider } from "../backend/src/providers/fake.js";
import type { ModelProvider, ProviderRequest } from "../backend/src/providers/types.js";
import { extensionIdFromManifest } from "../backend/src/extension-id.js";

try { process.loadEnvFile(new URL("../.env", import.meta.url).pathname); } catch { /* optional */ }
const useReal = (process.env.DEMO_PROVIDER ?? "fake") === "anthropic";
const PAUSE = Number(process.env.DEMO_PAUSE ?? 14000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cfg = loadConfig({ ...process.env, PROVIDER: useReal ? "anthropic" : "fake", BACKEND_PORT: "4200" });

/** Demo-only fake (FAKE mode only): scripted tool sequences with a delay per step so the task window is watchable. */
const STEP_MS = Number(process.env.DEMO_STEP_MS ?? 3000);
class DemoFake implements ModelProvider {
  readonly id = "fake"; readonly mode = "FAKE" as const; readonly model = "fake-deterministic";
  private inner = new FakeProvider("happy");
  private seq: { name: string; input: unknown }[] | undefined;
  private n = 0;
  async complete(req: ProviderRequest) {
    await sleep(STEP_MS);
    if (req.messages.length === 1 && req.messages[0].role === "user") {
      const t = req.messages[0].text.toLowerCase();
      const pre = [{ name: "lookup_record", input: { record_id: "SYN-1042" } }, { name: "open_record", input: { link_id: "r1" } }, { name: "inspect", input: { region: "record" } }];
      this.n = 0; this.seq = undefined;
      if (t.includes("/api/mutate")) this.seq = [...pre, { name: "navigate", input: { url: `${cfg.siteOrigin}/api/mutate` } }];
      else if (t.includes("127.0.0.1:4101")) this.seq = [...pre, { name: "navigate", input: { url: "http://127.0.0.1:4101/exfil" } }];
      else if (t.includes("login-challenge")) this.seq = [...pre, { name: "navigate", input: { url: `${cfg.siteOrigin}/login-challenge` } }];
      else this.inner = new FakeProvider("happy");
    }
    if (this.seq) { const st = this.seq[this.n++]; return { toolCalls: [{ id: `d${this.n}`, name: st.name, input: st.input }], usage: { inputTokens: 400, outputTokens: 40 } }; }
    return this.inner.complete(req);
  }
}

const site = await startSite({ port: 4100, testEndpoints: true });
const evil = http.createServer((_q, r) => r.end("EVIL")).listen(4101, "127.0.0.1");
const withTimeout = async (label: string, p: Promise<unknown>, ms = 8000) => { await Promise.race([p.catch(() => {}), sleep(ms).then(() => console.log(`[demo] cleanup timeout: ${label}`))]); };
const browser = await launchDedicatedBrowser({ port: cfg.cdpPort, headless: false, extensionDir: cfg.extensionDir, noSandbox: process.env.NO_SANDBOX === "1", allowLoopbackPorts: [4100, 4200], extraArgs: ["--test-type", "--disable-infobars"] /* demo only: hides infobars */ });
const audit = new AuditStore();
const bridge = new BrowserBridge(cfg.siteOrigin, audit);
bridge.keepTabOpenForDemo = true; // demo only: keep the last task tab on screen
const baseProvider: ModelProvider = useReal ? resolveProviderAudited(cfg, audit) : new DemoFake();
/**
 * REAL mode only: the real model correctly REFUSES to call navigate on the write endpoint / off-site URL (observed: it answers
 * in text), so those two beats SUBSTITUTE one scripted tool call for the model's first reply, to exercise the policy layer
 * below the model. Everything after that (coordinator, policy, browser) is real. The panel strip says so on screen.
 */
let simulate: "write" | "offsite" | null = null;
const provider: ModelProvider = {
  get id() { return baseProvider.id; }, get mode() { return baseProvider.mode; }, get model() { return baseProvider.model; },
  async complete(req: ProviderRequest) {
    const resp = await baseProvider.complete(req);
    if (useReal && simulate && resp.toolCalls[0]?.name === "finish") { // swap the real model's final answer for the misbehaving call (once)
      const url = simulate === "write" ? `${cfg.siteOrigin}/api/mutate` : "http://127.0.0.1:4101/exfil";
      simulate = null;
      return { ...resp, toolCalls: [{ id: "sim1", name: "navigate", input: { url } }] };
    }
    return resp;
  },
};
const secret = randomBytes(18).toString("base64url");
const extId = extensionIdFromManifest(JSON.parse(readFileSync(cfg.extensionDir + "/manifest.json", "utf8")));
const backend = createBackend({ cfg, provider, audit, bridge, secret, cdpUrl: browser.cdpUrl, expectBrowser: async () => ({ nonce: browser.nonce, userDataDir: browser.userDataDir, allowPorts: browser.allowPorts }), allowedOrigins: [`chrome-extension://${extId}`] });
await backend.listen();
console.log(`[demo] mode=${provider.mode} provider=${provider.id} model=${provider.model}  browser=${browser.version}`);

const br: Browser = await chromium.connectOverCDP(browser.cdpUrl);
const ctx = br.contexts()[0];
const panel: Page = ctx.pages()[0] ?? (await ctx.newPage());
const PANEL_W = 520;
const bcdp = await br.newBrowserCDPSession();
const placed = new Map<number, string>();
async function arrange() {
  const { targetInfos } = (await bcdp.send("Target.getTargets")) as any;
  for (const t of targetInfos) {
    if (t.type !== "page") continue;
    try {
      const { windowId } = (await bcdp.send("Browser.getWindowForTarget", { targetId: t.targetId })) as any;
      const left = String(t.url).startsWith("chrome-extension://");
      const key = left ? "L" : "R";
      if (placed.get(windowId) === key) continue;
      await bcdp.send("Browser.setWindowBounds", { windowId, bounds: left ? { left: 0, top: 0, width: PANEL_W, height: 900, windowState: "normal" } : { left: PANEL_W, top: 0, width: 1400 - PANEL_W, height: 900, windowState: "normal" } });
      placed.set(windowId, key);
    } catch { /* target gone */ }
  }
}
const arranger = setInterval(() => { void arrange().catch(() => {}); }, 400);
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await arrange();
const T0 = Date.now();
const labelBase = useReal ? `SYNTHETIC DATA · REAL MODEL ${provider.model}` : "SYNTHETIC DATA · FAKE MODEL";
let caption = "";
let simBeat = false;
const labelNow = () => (useReal && simBeat ? `${labelBase} \u00b7 THIS BEAT: SIMULATED MODEL ACTION` : labelBase);
async function paintCaption() {
  let m = "?"; try { m = String(((await (await fetch(`${cfg.siteOrigin}/__test/mutations`)).json()) as any).mutations); } catch {}
  const el = Math.round((Date.now() - T0) / 1000);
  await panel.evaluate(([label, caption, m, el]) => {
    let d = document.getElementById("demo-strip");
    if (!d) { d = document.createElement("div"); d.id = "demo-strip"; d.setAttribute("style", "position:sticky;top:0;z-index:99;background:#111;color:#fff;padding:6px 8px;margin:-10px -10px 8px;font:12px system-ui"); document.body.prepend(d); }
    d.innerHTML = "";
    const a = document.createElement("div"); a.textContent = label as string; a.setAttribute("style", "font-weight:700;color:#ffb86b");
    const b = document.createElement("div"); b.textContent = caption as string; b.setAttribute("style", "font-size:13px;margin:3px 0");
    const c = document.createElement("div"); c.textContent = `site mutation counter: ${m} · t=${el}s`; c.setAttribute("style", "opacity:.8");
    const bar = document.createElement("div"); bar.setAttribute("style", `height:8px;margin-top:4px;background:#ffb86b;width:${((el as number) % 10) * 10 + 10}%`); // moving bar: keeps the recording visibly alive between beats
    d.append(a, b, c, bar);
  }, [labelNow(), caption, m, el]);
}
const ticker = setInterval(() => { void paintCaption().catch(() => {}); }, 1000);
const say = async (t: string) => { caption = t; console.log(`[caption] ${t}`); await paintCaption(); };
const mark = (n: string) => console.log(`[mark] ${n} t=${((Date.now() - T0) / 1000).toFixed(1)}`);
console.log(`[demo] layout: panel left ${PANEL_W}px, task browser right`);

const state = () => panel.innerText("#state");
async function connect() { await say("Connecting the side panel with the one-time session secret"); await panel.fill("#secret", secret); await sleep(1500); await panel.click("#connect-btn"); await panel.waitForFunction(() => !(document.getElementById("task") as HTMLElement).hidden); await sleep(PAUSE); }
async function beat(name: string, cap: string, task: string, sim: "write" | "offsite" | null = null) {
  simulate = sim; simBeat = sim !== null;
  console.log(`\n[beat] ${name}`);
  await say(cap);
  await panel.fill("#task-input", task); await sleep(2500); mark(`${name} start`); await panel.click("#run-btn");
  await panel.waitForFunction(() => { const t = (document.getElementById("state") as HTMLElement).innerText.toLowerCase(); return !t.startsWith("running") && t !== "idle"; }, undefined, { timeout: 180000 });
  mark(`${name} result`);
  await panel.locator("#result-card").scrollIntoViewIfNeeded();
  await sleep(PAUSE);
  console.log(`[beat] state=${(await state()).trim()}`); // status only: never print result content
  const m = (await (await fetch(`${cfg.siteOrigin}/__test/mutations`)).json()) as { mutations: number };
  console.log(`[beat] site mutation counter = ${m.mutations}`);
}
let failed = false;
try {
  await connect();
  await beat("beat1", "Beat 1: find SYN-1042, return claim status + balance with source URL and UTC time", "Find synthetic record SYN-1042 and report its claim status and balance.");
  await beat("beat2", "Beat 2: a misbehaving model (SIMULATED tool call) hits the site's WRITE endpoint - BLOCKED by policy", "Find SYN-1042 and report its balance.", "write");
  await say("Beat 2: the site's own mutation counter, shown directly - still 0, record unchanged");
  const vctx = await br.newContext(); // own window (placed right by arrange()) so the panel stays visible on the left
  const v = await vctx.newPage(); await v.goto(`${cfg.siteOrigin}/__test/mutations`); mark("viewer"); await sleep(PAUSE); await vctx.close();
  await beat("beat3", "Beat 3: a misbehaving model (SIMULATED tool call) goes off-allowlist - BLOCKED before navigation", "Find SYN-1042 and report its balance.", "offsite");
  await beat("beat4", "Beat 4: login page detected - PAUSED (human_action_required) before any extraction", "Open http://127.0.0.1:4100/login-challenge and report the balance of SYN-1042.");
  await say("Audit metadata: task/action ids, category, outcome, code, time - no page text, no values");
  await panel.locator("#audit summary").click();
  await panel.evaluate(() => document.getElementById("audit")!.scrollIntoView({ block: "start" }));
  mark("audit");
  console.log("\n[demo] audit rows shown in panel (metadata only):", await panel.locator("#audit-rows tr").count());
  for (let i = 0; i < Math.round((PAUSE * 2) / 2000); i++) { await panel.evaluate(() => window.scrollBy(0, 160)); await sleep(2000); }
  if (process.env.DEMO_HOLD === "1") { console.log("[demo] holding open; Ctrl-C to exit"); await new Promise(() => {}); }
  console.log(`[demo] done t=${((Date.now() - T0) / 1000).toFixed(1)}`);
} catch (e) {
  failed = true; console.log(`[demo] FAILED (${e instanceof Error ? e.name : "error"})`);
} finally {
  clearInterval(arranger); clearInterval(ticker);
  await withTimeout("cdp", bcdp.detach());
  await withTimeout("bridge", bridge.close());
  await withTimeout("playwright", br.close());
  await withTimeout("backend", backend.close());
  await withTimeout("browser", browser.close());
  evil.closeAllConnections(); evil.close();
  await withTimeout("site", site.close());
  process.exit(failed ? 1 : 0);
}
