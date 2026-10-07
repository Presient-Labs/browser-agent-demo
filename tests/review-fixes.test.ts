import http from "node:http";
import { inspect } from "node:util";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { startStack, siteCounter, ScriptedProvider, RecordingProvider, SITE, type Stack } from "./helpers.js";
import { expectNoMarkers } from "./leak.js";
import { TaskRunner } from "../backend/src/coordinator.js";
import { BrowserBridge } from "../backend/src/browser/bridge.js";
import { AuditStore } from "../backend/src/audit.js";
import { AnthropicProvider } from "../backend/src/providers/anthropic.js";
import { chromiumPath } from "../backend/src/browser/launch.js";
import { TOOL_DEFS } from "../backend/src/tools.js";
import { FakeProvider } from "../backend/src/providers/fake.js";

let s: Stack;
beforeAll(async () => { s = await startStack(); await fetch(`${SITE}/__test/reset`); });
afterAll(async () => { if (s) s.bridge.testSeam = undefined; await s?.close(); });
const TASK = "Find SYN-1042 and report its balance.";
const nav = (path: string) => ({ name: "navigate", input: { url: `${SITE}${path}` } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const siteHits = async () => ((await (await fetch(`${SITE}/__test/requests`)).json()) as string[]).filter((x) => !x.includes("__test"));
const events = (id: string) => s.audit.list(id);

describe("finding 1: redirect CHAIN enforcement", () => {
  it("allowed -> allowed -> write-route chain is blocked and never mutates", async () => {
    await fetch(`${SITE}/__test/reset`);
    const r = await s.run(TASK, new ScriptedProvider([nav("/fixtures/chain-bad-1")]));
    expect(r.status).toBe("blocked");
    expect(await siteCounter()).toBe(0);
  });
  it("chain ending off-site is blocked and never reaches the destination", async () => {
    const before = s.evil.hits().length;
    const r = await s.run(TASK, new ScriptedProvider([nav("/fixtures/chain-offsite-1")]));
    expect(r.status).toBe("blocked");
    expect(s.evil.hits().length).toBe(before);
  });
  it("redirect loop is bounded by a hop cap and blocked", async () => {
    const r = await s.run(TASK, new ScriptedProvider([nav("/fixtures/loop")]));
    expect(r.status).toBe("blocked");
  });
  it("control: a harmless 2-hop chain really lands on the results page and extraction works", async () => {
    const r = await s.run(TASK, new ScriptedProvider([nav("/fixtures/chain-ok-1"), { name: "inspect", input: { region: "results" } }]));
    expect(r.status).not.toBe("blocked");
    expect(events(r.task_id).some((e) => e.category === "inspect" && e.outcome === "ok")).toBe(true);
  });
});

describe("finding 2: hostile page JS cannot defeat auth detection or widen extraction", () => {
  const flow = (path: string) => new ScriptedProvider([nav(path), { name: "inspect", input: { region: "record" } }, { name: "finish", input: { status: "found", record_id: "SYN-1042", fields: { balance: "1284.55" } } }]);
  it("page overrides document/Element query APIs to hide the password form => still paused; token never reaches the model", async () => {
    const rec = new RecordingProvider(flow("/fixtures/hostile-auth"));
    const r = await s.run(TASK, rec);
    expect(r.status).toBe("human_action_required");
    expect(rec.sent.join("\n").includes("AUTHSECRET")).toBe(false);
  });
  it("hidden and non-allow-listed fields are never extracted; visible allowed field still is", async () => {
    const rec = new RecordingProvider(flow("/fixtures/hidden-field"));
    const r = await s.run(TASK, rec);
    expect(rec.sent.join("\n").includes("AUTHSECRET")).toBe(false);
    expect(r.status).toBe("success");
    expect(r.fields.balance).toBe("1284.55");
  });
});

describe("finding 3: provider redirects (real SDK transport, loopback servers)", () => {
  it("307 from the approved endpoint is not followed: second listener receives 0 requests", async () => {
    const second: string[] = [];
    const s2 = http.createServer((q, r) => { second.push(`${q.method} ${q.url}`); q.resume(); r.end("{}"); });
    await new Promise<void>((r) => s2.listen(4302, "127.0.0.1", () => r()));
    const s1 = http.createServer((q, r) => { q.resume(); r.writeHead(307, { location: "http://127.0.0.1:4302/steal" }); r.end(); });
    await new Promise<void>((r) => s1.listen(4301, "127.0.0.1", () => r()));
    const p = new AnthropicProvider("claude-sonnet-5-5", "sk-test-not-real", { testOnlyBaseURL: "http://127.0.0.1:4301" });
    await expect(p.complete({ system: "s", messages: [{ role: "user", text: TASK }], tools: TOOL_DEFS })).rejects.toBeTruthy();
    await sleep(300);
    s1.closeAllConnections(); s2.closeAllConnections(); s1.close(); s2.close();
    expect(second.length).toBe(0);
  });
});

describe("finding 4: SDK logging is explicitly off", () => {
  it("ANTHROPIC_LOG=debug does not make the SDK log provider error bodies", async () => {
    const marker = "LEAKMARK-1042-7f81e7Z";
    const spy: string[] = [];
    const orig: Record<string, any> = {};
    for (const k of ["debug", "log", "info", "warn", "error"] as const) { orig[k] = console[k]; (console as any)[k] = (...a: any[]) => { spy.push(inspect(a, { depth: 6, breakLength: Infinity })); }; }
    const prev = process.env.ANTHROPIC_LOG; process.env.ANTHROPIC_LOG = "debug";
    try {
      const f = (async () => new Response(`echo ${marker}`, { status: 500, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
      const p = new AnthropicProvider("claude-sonnet-5-5", "sk-test-not-real", { fetch: f });
      await p.complete({ system: "s", messages: [{ role: "user", text: TASK }], tools: TOOL_DEFS }).catch(() => {});
    } finally { for (const k of Object.keys(orig)) (console as any)[k] = orig[k]; if (prev === undefined) delete process.env.ANTHROPIC_LOG; else process.env.ANTHROPIC_LOG = prev; }
    expectNoMarkers("sdk console output", spy.join("\n"));
  });
});

describe("finding 5: Stop cancels in-flight browser work", () => {
  it("Stop during navigation: no auth check, no extraction after it; task context closed; result stopped", async () => {
    const counts = { auth: 0, extract: 0 };
    const b: any = s.bridge; const oa = b.isAuthPage.bind(b), oe = b.extractResults.bind(b);
    b.isAuthPage = async () => { counts.auth++; return oa(); }; b.extractResults = async () => { counts.extract++; return oe(); };
    const p = new ScriptedProvider([{ name: "lookup_record", input: { record_id: "SYN-1042" } }]);
    const runner = s.runner(p);
    s.bridge.testSeam = { beforeGoto: async () => { runner.stop(); } };
    const r = await runner.run(TASK);
    s.bridge.testSeam = undefined; b.isAuthPage = oa; b.extractResults = oe;
    expect(r.status).toBe("stopped");
    expect(counts).toEqual({ auth: 0, extract: 0 });
  });
});

describe("finding 6: wall-time is a task-wide deadline", () => {
  const short = () => ({ ...s.cfg, budgets: { ...s.cfg.budgets, wallTimeMs: 1000 } });
  it("a tool request that arrives after the deadline is NOT executed", async () => {
    await fetch(`${SITE}/__test/reset`);
    const p = new ScriptedProvider([nav("/")], async (n) => { if (n === 1) await sleep(1800); });
    const r = await new TaskRunner(short(), p, s.bridge, s.audit).run(TASK);
    expect(r.code).toBe("WALL_TIME_BUDGET");
    expect(await siteHits()).toEqual([]);
  });
  it("a provider that never answers cannot hold the task past the deadline", async () => {
    const hang = { id: "fake", mode: "FAKE" as const, model: "hang", complete: () => new Promise<never>(() => {}) };
    const t0 = Date.now();
    const r = await new TaskRunner(short(), hang, s.bridge, s.audit).run(TASK);
    expect(r.code).toBe("WALL_TIME_BUDGET");
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});

describe("finding 7: extraction is bounded INSIDE the page", () => {
  it("6000 oversized elements => capped count/size, truncated flag", async () => {
    await s.bridge.openTaskTab("t-huge");
    expect(await s.bridge.goto(`${SITE}/fixtures/huge`)).toBe("ok");
    const t0 = Date.now();
    const ex: any = await s.bridge.extractRecord();
    await s.bridge.closeTaskTab();
    expect(ex.kind).toBe("ok");
    expect(ex.data.fields.length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(ex.data).length).toBeLessThanOrEqual(s.cfg.budgets.maxInspectChars + 200);
    expect(ex.truncated).toBe(true);
    void t0;
  });
});

describe("finding 8: backend refuses a browser it did not launch", () => {
  it("attaching to a plain Chromium without the containment flags is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rogue-"));
    const proc = spawn(chromiumPath(), ["--headless=new", "--no-sandbox", `--user-data-dir=${dir}`, "--remote-debugging-port=9555", "--remote-debugging-address=127.0.0.1", "about:blank"], { stdio: "ignore" });
    try {
      for (let i = 0; i < 60; i++) { try { await fetch("http://127.0.0.1:9555/json/version"); break; } catch { await sleep(200); } }
      const bridge = new BrowserBridge(s.cfg.siteOrigin, new AuditStore());
      await expect(bridge.connect("http://127.0.0.1:9555", { nonce: "x", userDataDir: dir, allowPorts: [4100, 4200] })).rejects.toThrow("BROWSER_NOT_DEDICATED");
      expect(bridge.connected).toBe(false);
    } finally { proc.kill("SIGKILL"); await sleep(500); }
  });
  it("the dedicated browser (launcher flags) is accepted", async () => { expect(s.bridge.connected).toBe(true); });
});

describe("finding 11: record identifiers must be exact", () => {
  it.each([["SYN-10420"], ["xSYN-1042"], ["SYN-104"], ["SYN-1042 and SYN-1001"], ["SYN-1042x"]])("%s is rejected without touching the browser", async (id) => {
    await fetch(`${SITE}/__test/reset`);
    const r = await s.run(`Find ${id} and report its balance.`, new FakeProvider("happy"));
    expect(r.code).toBe("TASK_UNPARSEABLE");
    expect(await siteHits()).toEqual([]);
  });
  it("a well-formed id still works", async () => {
    const r = await s.run("Find SYN-1042, then report its balance.", new FakeProvider("happy"));
    expect(r.status).toBe("success");
  });
});
