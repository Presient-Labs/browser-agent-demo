import net from "node:net";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { expectLacks } from "./leak.js";
import { startStack, ScriptedProvider, SITE, type Stack } from "./helpers.js";

let s: Stack;
beforeAll(async () => { s = await startStack(); });
afterAll(async () => { await s?.close(); });
const TASK = "Find SYN-1042 and report its balance.";
const events = (id: string) => s.audit.list(id);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function listener(port: number) {
  let conns = 0;
  const srv = net.createServer((c) => { conns++; c.destroy(); });
  return new Promise<{ conns: () => number; close: () => void }>((res) => srv.listen(port, "127.0.0.1", () => res({ conns: () => conns, close: () => srv.close() })));
}

describe("review finding 1: WebSocket egress", () => {
  it("a page-opened WebSocket to another loopback port never connects; metadata event recorded; task blocked", async () => {
    const l = await listener(4102);
    const p = new ScriptedProvider([{ name: "navigate", input: { url: `${SITE}/fixtures/websocket` } }]);
    const r = await s.run(TASK, p);
    await sleep(500);
    const n = l.conns(); l.close();
    expect(n).toBe(0);
    expect(r.status).toBe("blocked");
    expect(events(r.task_id).some((e) => e.category === "websocket" && e.outcome === "blocked" && e.code === "WEBSOCKET_NOT_ALLOWED")).toBe(true);
  });
});

describe("review finding 2a: credential form inside an iframe", () => {
  it("auth pause fires even though the main frame has no password field; nothing extracted", async () => {
    const p = new ScriptedProvider([{ name: "navigate", input: { url: `${SITE}/fixtures/iframe-login` } }, { name: "inspect", input: { region: "results" } }]);
    const r = await s.run(TASK, p);
    expect(r.status).toBe("human_action_required");
    expect(events(r.task_id).some((e) => e.category === "inspect")).toBe(false);
  });
});

describe("review finding 2b: page changes location after goto()", () => {
  it("history.pushState to a non-approved route => extraction refused", async () => {
    const p = new ScriptedProvider([{ name: "navigate", input: { url: `${SITE}/fixtures/pushstate` } }, { name: "inspect", input: { region: "record" } }]);
    p.onCall = async (n) => { if (n === 2) await sleep(900); };
    const r = await s.run(TASK, p);
    expect(r.status).toBe("blocked");
    expect(events(r.task_id).some((e) => e.category === "inspect" && e.outcome === "ok")).toBe(false);
    expectLacks("model-visible text", JSON.stringify(p.seen), "1284.55");
  });
  it("client-side location.assign to the auth route => paused before extraction", async () => {
    const p = new ScriptedProvider([{ name: "navigate", input: { url: `${SITE}/fixtures/client-redirect` } }, { name: "inspect", input: { region: "results" } }]);
    p.onCall = async (n) => { if (n === 2) await sleep(900); };
    const r = await s.run(TASK, p);
    expect(r.status).toBe("human_action_required");
    expect(events(r.task_id).some((e) => e.category === "inspect" && e.outcome === "ok")).toBe(false);
  });
});
