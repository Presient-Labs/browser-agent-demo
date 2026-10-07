import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { startStack, ScriptedProvider, SITE, type Stack } from "./helpers.js";
import { createBackend } from "../backend/src/server.js";
import { FakeProvider } from "../backend/src/providers/fake.js";
import { extensionIdFromManifest } from "../backend/src/extension-id.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HAS_DISPLAY = !!process.env.DISPLAY;
const d = HAS_DISPLAY ? describe : describe.skip;
const EXT_DIR = new URL("../extension/dist", import.meta.url).pathname;
const SECRET = "panel-loss-secret";
const waitText = (pg: Page, sel: string, text: string, timeout = 15000) =>
  pg.waitForFunction(([q, t]) => (document.querySelector(q as string) as HTMLElement | null)?.innerText?.toLowerCase().includes((t as string).toLowerCase()), [sel, text], { timeout });
const disabled = (pg: Page, sel: string) => pg.evaluate((q) => (document.querySelector(q) as HTMLButtonElement).disabled, sel);

d("N7: panel after the backend goes away (headed Chromium under Xvfb)", () => {
  let s: Stack; let br: Browser; let panel: Page; let extId = "";
  const mk = (provider: any) => createBackend({ cfg: s.cfg, provider, audit: s.audit, bridge: s.bridge, secret: SECRET, cdpUrl: s.browser.cdpUrl, expectBrowser: async () => ({ nonce: s.browser.nonce, userDataDir: s.browser.userDataDir, allowPorts: s.browser.allowPorts }), allowedOrigins: [`chrome-extension://${extId}`] });
  async function connectPanel() {
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await panel.fill("#secret", SECRET); await panel.click("#connect-btn");
    await panel.waitForFunction(() => !(document.getElementById("task") as HTMLElement).hidden);
  }
  beforeAll(async () => {
    execSync("npm run build -w extension", { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
    extId = extensionIdFromManifest(JSON.parse(readFileSync(EXT_DIR + "/manifest.json", "utf8")));
    s = await startStack({ BACKEND_PORT: "4200" }, { headed: true, extensionDir: EXT_DIR });
    br = await chromium.connectOverCDP(s.browser.cdpUrl);
    panel = br.contexts()[0].pages()[0] ?? (await br.contexts()[0].newPage());
  });
  afterAll(async () => { try { await br?.close(); } catch {} await s?.close(); });

  it("backend stopped while idle, then Run pressed: Disconnected shown, Run enabled, next action suggested", async () => {
    const be = mk(new FakeProvider("happy")); await be.listen();
    await connectPanel();
    await be.close();
    await waitText(panel, "#conn-msg", "disconnected");
    await panel.click("#run-btn");
    await waitText(panel, "#state", "disconnected");
    expect(`run enabled: ${!(await disabled(panel, "#run-btn"))}`).toBe("run enabled: true");
    const msg = await panel.innerText("#conn-msg");
    expect(`next-action hint: ${/restart|reconnect/i.test(msg)}`).toBe("next-action hint: true");
  });

  it("backend lost DURING a running task: panel resets running, shows Disconnected, Run re-enabled", async () => {
    const slow = new ScriptedProvider([{ name: "navigate", input: { url: `${SITE}/` } }, { name: "navigate", input: { url: `${SITE}/` } }], async () => { await sleep(1500); });
    const be = mk(slow); await be.listen();
    await connectPanel();
    await panel.click("#run-btn");
    await waitText(panel, "#state", "running");
    await be.close();
    await waitText(panel, "#state", "disconnected");
    expect(`run enabled: ${!(await disabled(panel, "#run-btn"))}`).toBe("run enabled: true");
    expect(`stop disabled: ${await disabled(panel, "#stop-btn")}`).toBe("stop disabled: true");
  });
});
