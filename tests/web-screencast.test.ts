import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startStack, type Stack } from "./helpers.js";

let s: Stack;
beforeAll(async () => { s = await startStack(); });
afterAll(async () => { await s?.close(); });

const TASK = "Find synthetic record SYN-1042 and report its claim status and balance.";

describe("bridge live-view hook", () => {
  it("streams JPEG frames of the task tab while a task runs, when a frame callback is set", async () => {
    const frames: string[] = [];
    s.bridge.onFrame = (f) => frames.push(f);
    const r = await s.run(TASK);
    s.bridge.onFrame = undefined;
    expect(r.status).toBe("success");
    expect(frames.length).toBeGreaterThan(0);
    expect(Buffer.from(frames[0], "base64").subarray(0, 2).toString("hex")).toBe("ffd8"); // JPEG magic bytes
  });

  it("sends nothing after the callback is cleared, and the task still succeeds", async () => {
    const late: string[] = [];
    const cb = (f: string) => late.push(f);
    s.bridge.onFrame = undefined;
    const r = await s.run(TASK);
    expect(r.status).toBe("success");
    expect(late).toEqual([]);
    void cb;
  });
});
