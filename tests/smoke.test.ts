import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startStack, type Stack } from "./helpers.js";
let s: Stack;
beforeAll(async () => { s = await startStack(); });
afterAll(async () => { await s?.close(); });
describe("smoke", () => {
  it("happy", async () => {
    const r = await s.run("Find synthetic record SYN-1042 and report its claim status and balance.");
    console.log(JSON.stringify(r), s.progress, JSON.stringify(s.audit.list()));
    expect(r.status).toBe("success");
  });
});
