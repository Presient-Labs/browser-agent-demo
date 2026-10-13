import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { createWebServer, type RunService } from "../web/src/server.js";
import type { RunEvent } from "../web/src/runs.js";

const RUN_ID = "11111111-2222-3333-4444-555555555555";
const seen: { ip: string; body: unknown }[] = [];
let throwOnSubmit = false;
const service: RunService = {
  presets: () => [{ id: "lookup", label: "Look up a claim", shows: "x" }],
  has: (id) => id === RUN_ID,
  submit: (ip, body) => {
    if (throwOnSubmit) throw new Error("secret internal detail");
    seen.push({ ip, body });
    return { ok: true, runId: RUN_ID, position: 0 };
  },
  subscribe: (id, fn) => {
    if (id !== RUN_ID) return null;
    const evs: RunEvent[] = [{ type: "started", mode: "FAKE", model: "fake", preset: "lookup" }, { type: "progress", text: "Step 1" }, { type: "end" }];
    setTimeout(() => evs.forEach(fn), 10);
    return () => {};
  },
};
let base = "";
let close: () => void = () => {};
beforeAll(async () => {
  const srv = createWebServer({ service, publicDir: new URL("../web/public", import.meta.url).pathname, health: () => ({ browser: "up", mode: "FAKE", live: true }) });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  close = () => srv.close();
});
afterAll(() => close());

describe("web server", () => {
  it("serves the page with strict security headers", async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await r.text()).toContain("Synthetic data — not a real patient system");
  });

  it("answers unknown paths with a generic 404 and never serves files outside the list", async () => {
    for (const p of ["/nope", "/package.json", "/web/src/server.ts", "/recorded/", "/index.html"]) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(404);
    }
  });

  it("lists presets and health as JSON", async () => {
    expect(await (await fetch(`${base}/api/presets`)).json()).toEqual([{ id: "lookup", label: "Look up a claim", shows: "x" }]);
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ browser: "up", mode: "FAKE", live: true });
  });

  it("accepts a run, keyed on the last forwarded hop", async () => {
    const r = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "6.6.6.6, 203.0.113.9" }, body: JSON.stringify({ preset: "lookup" }) });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ run_id: RUN_ID, position: 0 });
    expect(seen.at(-1)).toEqual({ ip: "203.0.113.9", body: { preset: "lookup" } });
  });

  it("rejects an oversized body with 413 and bad JSON with 400", async () => {
    const big = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(5000) }) });
    expect(big.status).toBe(413);
    const bad = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
    expect(bad.status).toBe(400);
  });

  it("never leaks an internal error", async () => {
    throwOnSubmit = true;
    const r = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    throwOnSubmit = false;
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(text).toBe('{"error":"INTERNAL"}');
  });

  it("streams a run's events as server-sent events and ends the stream at the end", async () => {
    const r = await fetch(`${base}/api/runs/${RUN_ID}/events`);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const body = await r.text(); // resolves when the server ends the stream
    const events = body.split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));
    expect(events.map((e) => e.type)).toEqual(["started", "progress", "end"]);
    expect((await fetch(`${base}/api/runs/99999999-2222-3333-4444-555555555555/events`)).status).toBe(404);
  });

  it("serves the recorded video with byte ranges, which iOS Safari needs", async () => {
    const r = await fetch(`${base}/recorded/run.mp4`, { headers: { range: "bytes=0-99" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toMatch(/^bytes 0-99\/\d+$/);
    expect((await r.arrayBuffer()).byteLength).toBe(100);
    const tail = await fetch(`${base}/recorded/run.mp4`, { headers: { range: "bytes=-10" } });
    expect(tail.status).toBe(206);
    expect((await tail.arrayBuffer()).byteLength).toBe(10);
  });
});
