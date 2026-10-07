import http from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { startStack, type Stack } from "./helpers.js";
import { createBackend } from "../backend/src/server.js";
import { FakeProvider } from "../backend/src/providers/fake.js";
import { extensionIdFromManifest } from "../backend/src/extension-id.js";
import { expectNoMarkers } from "./leak.js";

const SECRET = "test-secret-0123456789";
const EXT = `chrome-extension://${extensionIdFromManifest(JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8")))}`;
const BAD_ORIGINS = ["https://evil.example", "http://127.0.0.1:4101", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "null"];

let s: Stack; let be: ReturnType<typeof createBackend>; let port = 0;
beforeAll(async () => {
  s = await startStack({ BACKEND_PORT: "4200" });
  be = createBackend({ cfg: s.cfg, provider: new FakeProvider("happy"), audit: s.audit, bridge: s.bridge, secret: SECRET, cdpUrl: s.browser.cdpUrl, expectBrowser: async () => ({ nonce: s.browser.nonce, userDataDir: s.browser.userDataDir, allowPorts: s.browser.allowPorts }), allowedOrigins: [EXT] });
  port = await be.listen();
});
afterAll(async () => { await be?.close(); await s?.close(); });

function req(method: string, path: string, o: { headers?: Record<string, string>; body?: string; host?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path, headers: { host: o.host ?? `127.0.0.1:${port}`, ...(o.headers ?? {}) } }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    r.on("error", reject); if (o.body) r.write(o.body); r.end();
  });
}
const good = { "x-demo-session": SECRET, "content-type": "application/json", origin: EXT };
const TASK = JSON.stringify({ task: "Find SYN-1042 and report its claim status and balance." });

describe("12 backend authentication / origin", () => {
  it("binds to loopback only", () => { expect((be.server.address() as any).address).toBe("127.0.0.1"); });
  it("no secret => 401, and no task started", async () => {
    const r = await req("POST", "/api/tasks", { headers: { "content-type": "application/json", origin: EXT }, body: TASK });
    expect(r.status).toBe(401); expect(be.runner.active).toBe(false);
  });
  it("wrong secret => 401 (redacted body)", async () => {
    const r = await req("POST", "/api/tasks", { headers: { ...good, "x-demo-session": "nope" }, body: TASK });
    expect(r.status).toBe(401); expect(JSON.parse(r.body)).toEqual({ error: "UNAUTHENTICATED" });
  });
  for (const o of BAD_ORIGINS) {
    it(`valid secret but unapproved origin ${o} => 403, no CORS grant, no task`, async () => {
      const r = await req("POST", "/api/tasks", { headers: { ...good, origin: o }, body: TASK });
      expect(r.status).toBe(403); expect(r.headers["access-control-allow-origin"]).toBeUndefined(); expect(be.runner.active).toBe(false);
    });
  }
  it("CORS preflight is refused for foreign origins and granted only to the extension", async () => {
    const bad = await req("OPTIONS", "/api/tasks", { headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(bad.status).toBe(403); expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    const ok = await req("OPTIONS", "/api/tasks", { headers: { origin: EXT, "access-control-request-method": "POST" } });
    expect(ok.status).toBe(204); expect(ok.headers["access-control-allow-origin"]).toBe(EXT);
  });
  it("DNS-rebinding style Host header is rejected", async () => {
    const r = await req("GET", "/api/status", { headers: good, host: "evil.example:4200" });
    expect(r.status).toBe(403);
  });
  it("review #10: a request with a valid secret but NO Origin header is rejected (HTTP), no task started", async () => {
    const r = await req("POST", "/api/tasks", { headers: { "x-demo-session": SECRET, "content-type": "application/json" }, body: TASK });
    expect(r.status).toBe(403); expect(be.runner.active).toBe(false);
    expect((await req("GET", "/api/status", { headers: { "x-demo-session": SECRET } })).status).toBe(403);
    expect((await req("POST", "/api/tasks/stop", { headers: { "x-demo-session": SECRET, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
  });
  it("mutating endpoint requires JSON content type", async () => {
    const r = await req("POST", "/api/tasks", { headers: { ...good, "content-type": "text/plain" }, body: TASK });
    expect(r.status).toBe(415);
  });
  it("malformed / oversize bodies are rejected without echo", async () => {
    expect((await req("POST", "/api/tasks", { headers: good, body: "{nope" })).status).toBe(400);
    expect((await req("POST", "/api/tasks", { headers: good, body: JSON.stringify({ task: "x".repeat(5000) }) })).status).toBe(413);
  });
  it("authenticated status shows mode FAKE and unsupported capabilities", async () => {
    const r = await req("GET", "/api/status", { headers: good });
    const j = JSON.parse(r.body);
    expect(r.status).toBe(200); expect(j.mode).toBe("FAKE"); expect(j.unsupported.length).toBeGreaterThan(3);
    expect(r.body.includes("sk-")).toBe(false);
  });
  it("auth failures were recorded as metadata-only audit events", () => {
    const ev = s.audit.list("api");
    expect(ev.length).toBeGreaterThan(5);
    expect(ev.every((e) => e.category === "api_auth" && e.outcome === "rejected")).toBe(true);
  });

  const wsTry = (origin: string | undefined, secret?: string) => new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: origin ? { origin } : {} });
    ws.on("open", () => { if (secret !== undefined) ws.send(JSON.stringify({ type: "auth", secret })); else ws.send(JSON.stringify({ type: "auth", secret: "x" })); });
    ws.on("message", (d) => { resolve("msg:" + JSON.parse(d.toString()).type); ws.close(); });
    ws.on("unexpected-response", () => resolve("rejected-upgrade"));
    ws.on("close", () => resolve("closed")); ws.on("error", () => resolve("rejected-upgrade"));
  });
  it("WebSocket: foreign or missing origin rejected at upgrade", async () => {
    expect(await wsTry("https://evil.example", SECRET)).toBe("rejected-upgrade");
    expect(await wsTry(undefined, SECRET)).toBe("rejected-upgrade");
  });
  it("WebSocket: right origin but wrong secret is closed without data", async () => { expect(await wsTry(EXT, "wrong")).toBe("closed"); });
  it("WebSocket: right origin + secret gets state", async () => { expect(await wsTry(EXT, SECRET)).toBe("msg:state"); });

  it("full API task run via HTTP+WS: duplicate start is refused; WS progress/audit frames are content-free", async () => {
    const frames: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: EXT } });
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ type: "auth", secret: SECRET }));
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    const first = await req("POST", "/api/tasks", { headers: good, body: TASK });
    expect(first.status).toBe(202);
    const second = await req("POST", "/api/tasks", { headers: good, body: TASK });
    expect(second.status).toBe(409);
    for (let i = 0; i < 100 && !frames.some((f) => f.type === "result"); i++) await new Promise((r) => setTimeout(r, 100));
    const result = frames.find((f) => f.type === "result")?.result;
    expect(result?.status).toBe("success");
    expect(result.fields.balance).toBe("1284.55");
    const nonResult = JSON.stringify(frames.filter((f) => f.type !== "result"));
    expectNoMarkers("ws frames", nonResult);
    ws.close();
  });
});
