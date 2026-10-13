import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStack, type Stack } from "./helpers.js";
import { RunManager, type RunEvent, type RunManagerDeps } from "../web/src/runs.js";
import { RateLimiter, SpendLedger } from "../web/src/limits.js";
import type { BrowserBridge } from "../backend/src/browser/bridge.js";

let s: Stack;
beforeAll(async () => { s = await startStack(); });
afterAll(async () => { await s?.close(); });

const spendFile = () => join(mkdtempSync(join(tmpdir(), "web-runs-")), "spend.json");
function manager(over: Partial<RunManagerDeps> = {}) {
  return new RunManager({
    cfg: s.cfg, bridge: s.bridge, audit: s.audit, realProvider: null, allowFake: true,
    spend: new SpendLedger(spendFile()), limiter: new RateLimiter(), mutations: () => s.site.mutations(), ...over,
  });
}
/** Collects a run's events until "end". */
function collect(m: RunManager, id: string): Promise<RunEvent[]> {
  return new Promise((resolve) => {
    const got: RunEvent[] = [];
    m.subscribe(id, (e) => { got.push(e); if (e.type === "end") resolve(got); });
  });
}
const ok = (r: ReturnType<RunManager["submit"]>) => { if (!r.ok) throw new Error(r.error); return r; };

describe("RunManager", () => {
  it("runs a preset and streams started, frames, progress, audit, result and end, in that order", async () => {
    const m = manager();
    const r = ok(m.submit("1.1.1.1", { preset: "lookup" }));
    expect(r.position).toBe(0);
    const ev = await collect(m, r.runId);
    const types = ev.map((e) => e.type);
    expect(types[0]).toBe("started");
    expect(types).toContain("frame");
    expect(types).toContain("progress");
    expect(types).toContain("audit");
    expect(types.at(-2)).toBe("result");
    expect(types.at(-1)).toBe("end");
    const res = ev.find((e) => e.type === "result");
    expect(res && res.type === "result" && res.result.status).toBe("success");
  });

  it("runs one at a time, in order, and tells the second visitor its place", async () => {
    const m = manager();
    const a = ok(m.submit("1.1.1.2", { preset: "lookup" }));
    const b = ok(m.submit("1.1.1.3", { preset: "sources" }));
    expect([a.position, b.position]).toEqual([0, 1]);
    const order: string[] = [];
    m.subscribe(a.runId, (e) => { if (e.type === "end") order.push("a-end"); });
    const evB = await collect(m, b.runId);
    order.push("b-done");
    expect(order).toEqual(["a-end", "b-done"]);
    expect(evB[0]).toEqual({ type: "queued", position: 1 });
  });

  it("events never leak between runs: each run's audit events carry only its own task id", async () => {
    const m = manager();
    const a = ok(m.submit("1.1.1.4", { preset: "lookup" }));
    const b = ok(m.submit("1.1.1.5", { preset: "write" }));
    const [ea, eb] = await Promise.all([collect(m, a.runId), collect(m, b.runId)]);
    const ids = (ev: RunEvent[]) => new Set(ev.flatMap((e) => (e.type === "audit" ? [e.event.task_id] : [])));
    expect(ids(ea).size).toBe(1);
    expect(ids(eb).size).toBe(1);
    expect([...ids(ea)][0]).not.toBe([...ids(eb)][0]);
  });

  it("a late subscriber gets the replay and the end", async () => {
    const m = manager();
    const r = ok(m.submit("1.1.1.6", { preset: "lookup" }));
    await collect(m, r.runId);
    const replay = await collect(m, r.runId);
    expect(replay.map((e) => e.type)).toContain("result");
    expect(replay.at(-1)).toEqual({ type: "end" });
  });

  // Every test waits for the runs it started: all managers share ONE browser bridge, which runs one task at a time.
  it("refuses a full queue with 503", async () => {
    const m = manager({ maxQueue: 1 });
    const a = ok(m.submit("2.0.0.1", { preset: "lookup" })); // starts at once
    const b = ok(m.submit("2.0.0.2", { preset: "lookup" })); // waits
    const third = m.submit("2.0.0.3", { preset: "lookup" });
    expect(third).toMatchObject({ ok: false, status: 503, error: "QUEUE_FULL" });
    await Promise.all([collect(m, a.runId), collect(m, b.runId)]);
  });

  it("refuses a sixth run from one IP within the hour with 429 and the minutes left", async () => {
    const t = 0;
    const m = manager({ limiter: new RateLimiter(5, 3_600_000, () => t) });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(ok(m.submit("3.3.3.3", { preset: "lookup" })).runId);
    expect(m.submit("3.3.3.3", { preset: "lookup" })).toMatchObject({ ok: false, status: 429, error: "RATE_LIMITED", retryAfterMin: 60 });
    await Promise.all(ids.map((id) => collect(m, id)));
  });

  it("rejects an unknown preset and bad free text with 400 and a plain message", () => {
    const m = manager();
    expect(m.submit("4.4.4.4", { preset: "nope" })).toMatchObject({ ok: false, status: 400, error: "UNKNOWN_PRESET" });
    expect(m.submit("4.4.4.4", { text: "hello" })).toMatchObject({ ok: false, status: 400, error: "BAD_TASK" });
  });

  it("falls back to the recorded run, without starting the agent, when the cap is reached", async () => {
    const f = spendFile();
    writeFileSync(f, JSON.stringify({ day: new Date().toISOString().slice(0, 10), usd: 2.9 }));
    const m = manager({ spend: new SpendLedger(f) });
    const starts = s.audit.list().filter((e) => e.code === "TASK_START").length;
    const r = ok(m.submit("5.5.5.5", { preset: "lookup" }));
    expect(await collect(m, r.runId)).toEqual([{ type: "fallback", reason: "cap" }, { type: "end" }]);
    expect(s.audit.list().filter((e) => e.code === "TASK_START").length).toBe(starts);
  });

  it("falls back with no_key when there is no key and FAKE is not allowed, and browser_down when the browser is gone", async () => {
    const noKey = manager({ allowFake: false });
    const a = ok(noKey.submit("6.6.6.1", { preset: "lookup" }));
    expect((await collect(noKey, a.runId))[0]).toEqual({ type: "fallback", reason: "no_key" });
    const down = manager({ bridge: { connected: false } as unknown as BrowserBridge });
    const b = ok(down.submit("6.6.6.2", { preset: "lookup" }));
    expect((await collect(down, b.runId))[0]).toEqual({ type: "fallback", reason: "browser_down" });
  });

  it("adds each run's estimated cost to the day's spend", async () => {
    const spend = new SpendLedger(spendFile());
    const m = manager({ spend });
    const r = ok(m.submit("7.7.7.7", { preset: "lookup" }));
    await collect(m, r.runId);
    expect(spend.spentToday()).toBeGreaterThan(0);
  });
});
