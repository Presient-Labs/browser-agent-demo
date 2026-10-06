import net from "node:net";
import dgram from "node:dgram";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startStack, ScriptedProvider, SITE, type Stack } from "./helpers.js";
import { ALL_MARKERS } from "../site/src/data.js";

let s: Stack;
beforeAll(async () => { s = await startStack(); });
afterAll(async () => { if (s) s.bridge.testSeam = undefined; await s?.close(); });
const TASK = "Find SYN-1042 and report its balance.";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const happy = () => new ScriptedProvider([
  { name: "lookup_record", input: { record_id: "SYN-1042" } }, { name: "open_record", input: { link_id: "r1" } }, { name: "inspect", input: { region: "record" } },
  { name: "finish", input: { status: "found", record_id: "SYN-1042", fields: { balance: "1284.55" } } },
]);
const noValue = (r: any, p: ScriptedProvider) => {
  const blob = JSON.stringify(r) + JSON.stringify(p.seen.slice(0, 99));
  expect(blob).not.toContain("1284.55");
  for (const m of ALL_MARKERS) expect(blob).not.toContain(m);
};

describe("review: TOCTOU between guard and extraction (deterministic seam)", () => {
  it("control: without any mutation the same flow succeeds (the seam test is not vacuous)", async () => {
    s.bridge.testSeam = undefined;
    const r = await s.run(TASK, happy());
    expect(r.status).toBe("success");
  });
  it("credential field injected AFTER the guard, BEFORE extraction => paused, data dropped", async () => {
    s.bridge.testSeam = { beforeExtract: async (p) => { await p.evaluate(() => { const i = document.createElement("input"); i.type = "password"; document.body.appendChild(i); }); } };
    const p = happy(); const r = await s.run(TASK, p); s.bridge.testSeam = undefined;
    expect(r.status).toBe("human_action_required");
    noValue(r, p);
  });
  it("location rewritten (pushState) AFTER the guard, BEFORE extraction => blocked, data dropped", async () => {
    s.bridge.testSeam = { beforeExtract: async (p) => { await p.evaluate(() => history.pushState({}, "", "/records/SYN-1042/delete")); } };
    const p = happy(); const r = await s.run(TASK, p); s.bridge.testSeam = undefined;
    expect(r.status).toBe("blocked");
    noValue(r, p);
  });
  it("credential field injected AFTER extraction => post-check discards the data", async () => {
    s.bridge.testSeam = { afterExtract: async (p) => { await p.evaluate(() => { const i = document.createElement("input"); i.type = "password"; document.body.appendChild(i); }); } };
    const p = happy(); const r = await s.run(TASK, p); s.bridge.testSeam = undefined;
    expect(r.status).toBe("human_action_required");
    noValue(r, p);
  });
  it("timer-flip fixture: password input appears after goto settles => paused before the value reaches the model", async () => {
    const p = new ScriptedProvider([{ name: "navigate", input: { url: `${SITE}/fixtures/flip-auth` } }, { name: "inspect", input: { region: "record" } }]);
    p.onCall = async (n) => { if (n === 2) await sleep(900); };
    const r = await s.run(TASK, p);
    expect(r.status).toBe("human_action_required");
    noValue(r, p);
  });
});

describe("review: browser-level egress containment (preconnect / dns-prefetch / WebRTC)", () => {
  it("TCP and UDP listeners on another loopback port receive nothing from a hostile page", async () => {
    let tcp = 0, udp = 0;
    const t = net.createServer((c) => { tcp++; c.destroy(); });
    const u = dgram.createSocket("udp4"); u.on("message", () => { udp++; });
    await new Promise<void>((r) => t.listen(4102, "127.0.0.1", () => r()));
    await new Promise<void>((r) => u.bind(4102, "127.0.0.1", () => r()));
    const p = new ScriptedProvider([{ name: "navigate", input: { url: `${SITE}/fixtures/egress` } }, { name: "inspect", input: { region: "results" } }]);
    p.onCall = async (n) => { if (n === 2) await sleep(2500); };
    await s.run(TASK, p);
    await sleep(500);
    t.close(); u.close();
    expect({ tcp, udp }).toEqual({ tcp: 0, udp: 0 });
  });
});
