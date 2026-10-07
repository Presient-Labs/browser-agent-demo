import http from "node:http";
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startStack, ScriptedProvider, SITE, type Stack } from "./helpers.js";
import { expectEq } from "./leak.js";
import { BrowserBridge } from "../backend/src/browser/bridge.js";
import { TaskRunner } from "../backend/src/coordinator.js";
import { createBackend } from "../backend/src/server.js";
import { FakeProvider } from "../backend/src/providers/fake.js";
import { extensionIdFromManifest } from "../backend/src/extension-id.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TASK = "Find SYN-1042 and report its balance.";
const EXT = `chrome-extension://${extensionIdFromManifest(JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8")))}`;
const SECRET = "lifecycle-secret";
let s: Stack;
beforeAll(async () => { s = await startStack(); });
afterAll(async () => { if (s) s.bridge.testSeam = undefined; await s?.close(); });

function call(port: number, method: string, path: string, body?: unknown) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path, headers: { "x-demo-session": SECRET, "content-type": "application/json", origin: EXT } }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode!, json: b ? JSON.parse(b) : {} }));
    });
    r.on("error", reject); r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe("N3a: Stop during the initial CDP connect survives", () => {
  it("Stop arriving while the backend is still connecting => task ends stopped, browser never touches the site", async () => {
    await fetch(`${SITE}/__test/reset`);
    const slow = new BrowserBridge(s.cfg.siteOrigin, s.audit);
    const realConnect = slow.connect.bind(slow);
    slow.connect = async (u: string, e: any) => { await sleep(900); return realConnect(u, e); };
    const be = createBackend({ cfg: s.cfg, provider: new FakeProvider("happy"), audit: s.audit, bridge: slow, secret: SECRET, cdpUrl: s.browser.cdpUrl, expectBrowser: async () => ({ nonce: s.browser.nonce, userDataDir: s.browser.userDataDir, allowPorts: s.browser.allowPorts }), allowedOrigins: [EXT] });
    const port = await be.listen();
    try {
      const start = call(port, "POST", "/api/tasks", { task: TASK }); // the handler is still awaiting the CDP connect
      await sleep(250);
      await call(port, "POST", "/api/tasks/stop", {});
      expectEq("start accepted", (await start).status, 202);
      let res: any = null;
      for (let i = 0; i < 100 && !res; i++) { await sleep(200); res = (await call(port, "GET", "/api/result")).json.result; }
      expectEq("status", res?.status, "stopped");
      const hits = ((await (await fetch(`${SITE}/__test/requests`)).json()) as string[]).filter((x) => !x.includes("__test"));
      expectEq("site requests", hits, []);
    } finally { await be.close(); await slow.disconnect(); }
  });
});

describe("N3b: context creation is abortable", () => {
  it("deadline during a stalled newContext ends the task promptly and no context is left behind", async () => {
    const baseline = s.bridge.contextCount();
    s.bridge.testSeam = { beforeNewContext: async () => { await sleep(2500); } };
    const cfg = { ...s.cfg, budgets: { ...s.cfg.budgets, wallTimeMs: 600 } };
    const t0 = Date.now();
    const r = await new TaskRunner(cfg, new ScriptedProvider([{ name: "navigate", input: { url: `${SITE}/` } }]), s.bridge, s.audit).run(TASK);
    const elapsed = Date.now() - t0;
    s.bridge.testSeam = undefined;
    expectEq("code", r.code, "WALL_TIME_BUDGET");
    expect(`elapsed<1500: ${elapsed < 1500}`).toBe("elapsed<1500: true");
    await sleep(3500); // let the late newContext resolve; it must have been closed
    expectEq("leftover contexts", s.bridge.contextCount(), baseline);
  });
});

describe("N3c: cleanup completes before the task is 'inactive'; an old close cannot clear a newer task", () => {
  it("runner.active stays true until the browser cleanup has finished", async () => {
    s.bridge.testSeam = { beforeClose: async () => { await sleep(900); } };
    const runner = new TaskRunner(s.cfg, new FakeProvider("happy"), s.bridge, s.audit);
    const p = runner.run(TASK);
    let activeDuringCleanup: boolean | undefined;
    for (let i = 0; i < 300; i++) {
      await sleep(50);
      if (s.audit.list().some((e) => e.category === "task" && e.code === "OK" && e.task_id === runner.taskId)) { activeDuringCleanup = runner.active; break; }
    }
    await p; s.bridge.testSeam = undefined;
    expectEq("active during cleanup", activeDuringCleanup, true);
    expectEq("active after", runner.active, false);
  });
  it("a slow closeTaskTab of task A does not wipe task B's context/page", async () => {
    await s.bridge.openTaskTab("A");
    let n = 0;
    s.bridge.testSeam = { beforeClose: async () => { if (n++ === 0) await sleep(800); } };
    const closing = s.bridge.closeTaskTab();
    await sleep(50);
    await s.bridge.openTaskTab("B");
    await closing;
    expectEq("B still has a tab", s.bridge.hasTab, true);
    s.bridge.testSeam = undefined;
    await s.bridge.closeTaskTab();
  });
});
