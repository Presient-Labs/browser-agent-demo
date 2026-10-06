import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { startStack, type Stack } from "./helpers.js";
import { createBackend } from "../backend/src/server.js";
import { FakeProvider } from "../backend/src/providers/fake.js";
import { extensionIdFromManifest } from "../backend/src/extension-id.js";
import { ALL_MARKERS } from "../site/src/data.js";

const HAS_DISPLAY = !!process.env.DISPLAY;
const EXT_DIR = new URL("../extension/dist", import.meta.url).pathname;
const SECRET = "panel-test-secret-abcdef";
const waitText = (pg: Page, sel: string, text: string, timeout = 15000) =>
  pg.waitForFunction(([q, t]) => (document.querySelector(q as string) as HTMLElement | null)?.innerText?.includes(t as string), [sel, text], { timeout });
const isHidden = (pg: Page, sel: string) => pg.evaluate((q) => (document.querySelector(q) as HTMLElement).hidden, sel);
const isDisabled = (pg: Page, sel: string) => pg.evaluate((q) => (document.querySelector(q) as HTMLButtonElement).disabled, sel);
const d = HAS_DISPLAY ? describe : describe.skip;

d("extension side panel (headed Chromium under Xvfb, extension LOADED via --load-extension)", () => {
  let s: Stack; let be: ReturnType<typeof createBackend>; let br: Browser; let panel: Page; let extId = "";
  beforeAll(async () => {
    execSync("npm run build -w extension", { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
    extId = extensionIdFromManifest(JSON.parse(readFileSync(EXT_DIR + "/manifest.json", "utf8")));
    s = await startStack({ BACKEND_PORT: "4200" }, { headed: true, extensionDir: EXT_DIR });
    be = createBackend({ cfg: s.cfg, provider: new FakeProvider("happy"), audit: s.audit, bridge: s.bridge, secret: SECRET, cdpUrl: s.browser.cdpUrl, allowedOrigins: [`chrome-extension://${extId}`] });
    await be.listen();
    br = await chromium.connectOverCDP(s.browser.cdpUrl);
    panel = (br.contexts()[0].pages()[0]) ?? (await br.contexts()[0].newPage());
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  });
  afterAll(async () => { try { await br?.close(); } catch {} await be?.close(); await s?.close(); });

  it("extension service worker is registered under the manifest-derived id", async () => {
    const sw = br.contexts()[0].serviceWorkers().map((w) => w.url());
    const t = await (await fetch(`${s.browser.cdpUrl}/json/list`)).json() as { url: string }[];
    expect([...sw, ...t.map((x) => x.url)].some((u) => u.startsWith(`chrome-extension://${extId}/`))).toBe(true);
  });
  it("wrong secret does not connect", async () => {
    await panel.fill("#secret", "wrong"); await panel.click("#connect-btn");
    await waitText(panel, "#conn-msg", "Connection refused");
    expect(await isHidden(panel, "#task")).toBe(true);
  });
  it("right secret connects; mode badge shows FAKE; synthetic badge visible; unsupported list shown", async () => {
    await panel.fill("#secret", SECRET); await panel.click("#connect-btn");
    await panel.waitForFunction(() => !(document.getElementById("task") as HTMLElement).hidden);
    await waitText(panel, "#mode-badge", "MODE: FAKE");
    await waitText(panel, ".badge.synth", "SYNTHETIC");
    await panel.locator("#unsupported summary").click();
    await waitText(panel, "#unsupported-list", "screenshots");
  });
  it("runs the SYN-1042 task from the panel: result card with source URL and UTC time; audit table has metadata only", async () => {
    await panel.click("#run-btn");
    try { await waitText(panel, "#state", "SUCCESS", 30000); } catch (e) {
      console.log("DIAG state=", await panel.innerText("#state"), "result=", await panel.innerText("#result-body").catch(() => ""), "progress=", await panel.innerText("#progress"));
      throw e;
    }
    const card = await panel.locator("#result-body").innerText();
    expect(card).toContain("1284.55"); expect(card).toContain("Pending - Payer Review");
    expect(card).toContain("http://127.0.0.1:4100/records/SYN-1042");
    expect(card).toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/);
    expect(card).toContain("estimate");
    await panel.locator("#audit summary").click();
    const audit = await panel.locator("#audit-rows").innerText();
    expect(audit.length).toBeGreaterThan(20);
    for (const m of ALL_MARKERS) expect(audit).not.toContain(m);
    expect(audit).not.toContain("1284.55");
    const progress = await panel.locator("#progress").innerText();
    expect(progress).not.toContain("1284.55");
  });
  it("panel keeps no state in browser storage", async () => {
    const st = await panel.evaluate(() => ({ ls: localStorage.length, ss: sessionStorage.length, ck: document.cookie }));
    expect(st).toEqual({ ls: 0, ss: 0, ck: "" });
  });
  it("buttons are keyboard-reachable (Run focusable, Stop disabled when idle)", async () => {
    expect(await panel.evaluate(() => { const b = document.getElementById("run-btn") as HTMLButtonElement; b.focus(); return document.activeElement === b && b.tabIndex >= 0; })).toBe(true);
    expect(await isDisabled(panel, "#stop-btn")).toBe(true);
  });
});
