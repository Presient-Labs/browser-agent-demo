import net from "node:net";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startStack, installNetGuard, type Stack } from "./helpers.js";
import { loadConfig } from "../backend/src/config.js";
import { AuditStore } from "../backend/src/audit.js";
import { resolveProviderAudited } from "../backend/src/bootstrap.js";
import { AnthropicProvider } from "../backend/src/providers/anthropic.js";
import { OpenAIProviderStub } from "../backend/src/providers/openai.js";
import { FakeProvider } from "../backend/src/providers/fake.js";
import { TaskRunner } from "../backend/src/coordinator.js";
import { TOOL_DEFS } from "../backend/src/tools.js";
import { leakMarkerFor } from "../site/src/data.js";
import { expectLacks } from "./leak.js";

const TASK = "Find SYN-1042 and report its balance.";

describe("10 unapproved provider => no network call, safe rejection event", () => {
  it("net guard can see connections (positive control)", async () => {
    const g = installNetGuard();
    const srv = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise<void>((r) => { const c = net.connect(port, "127.0.0.1", () => { c.destroy(); r(); }); });
    srv.close(); g.restore();
    expect(g.attempts.some((a) => a.endsWith(`:${port}`))).toBe(true);
  });
  it.each([
    ["unknown provider", { PROVIDER: "evilcorp", MODEL: "m", ANTHROPIC_API_KEY: "sk-test" }],
    ["unapproved model on approved provider", { PROVIDER: "anthropic", MODEL: "claude-haiku-9", ANTHROPIC_API_KEY: "sk-test" }],
    ["openai not in approved list", { PROVIDER: "openai", MODEL: "gpt-x", ANTHROPIC_API_KEY: "sk-test" }],
    ["fake requested without a test factory", { PROVIDER: "fake" }],
  ])("%s", async (_n, env) => {
    const g = installNetGuard();
    let fetchCalls = 0; const origFetch = globalThis.fetch;
    globalThis.fetch = (async (...a: any[]) => { fetchCalls++; return (origFetch as any)(...a); }) as any;
    const audit = new AuditStore();
    try {
      expect(() => resolveProviderAudited(loadConfig(env), audit)).toThrow("PROVIDER_NOT_APPROVED");
    } finally { globalThis.fetch = origFetch; g.restore(); }
    expect(g.attempts).toEqual([]);
    expect(fetchCalls).toBe(0);
    const ev = audit.list();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ category: "provider_config", outcome: "rejected", code: "PROVIDER_NOT_APPROVED" });
  });
  it("openai adapter is an explicit stub that fails safely with no network", async () => {
    const g = installNetGuard();
    const p = new OpenAIProviderStub("gpt-x");
    await expect(p.complete()).rejects.toMatchObject({ code: "PROVIDER_NOT_IMPLEMENTED" });
    g.restore(); expect(g.attempts).toEqual([]);
  });
});

describe("11 provider outage (browser + coordinator)", () => {
  let s: Stack;
  beforeAll(async () => { s = await startStack(); });
  afterAll(async () => { await s?.close(); });

  it("fake outage: bounded retries, safe error code, no payload in audit/logs", async () => {
    const p = new FakeProvider("outage");
    const r = await s.run(TASK, p);
    expect(r.status).toBe("error");
    expect(r.code).toBe("PROVIDER_UNAVAILABLE");
    expect(p.calls).toBe(s.cfg.budgets.maxRetries + 1);
    const blob = JSON.stringify(s.audit.list(r.task_id)) + s.logs.join("\n");
    expectLacks("audit+logs", blob, "SYN-1042");
    expectLacks("audit+logs", blob, "Find ");
  });
  it("transient outage recovers within the retry bound", async () => {
    const p = new FakeProvider("outage_then_ok", { failures: 2 });
    const r = await s.run(TASK, p);
    expect(r.status).toBe("success");
    expect(p.calls).toBe(2 + 4);
  });

  const mockFetch = (status: number, body: unknown, seen: { url: string; headers: Record<string, string>; body: string }[]) =>
    (async (url: any, init: any) => {
      seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body ?? "") });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

  it("REAL Anthropic adapter against an injected 500 (no network): bounded retries, error body never leaks", async () => {
    const seen: any[] = [];
    const marker = leakMarkerFor(1042);
    const provider = new AnthropicProvider("claude-sonnet-5-5", "sk-test-not-real", { fetch: mockFetch(500, { type: "error", error: { type: "api_error", message: `echo ${marker}` } }, seen) });
    const r = await new TaskRunner(s.cfg, provider, s.bridge, s.audit).run(TASK);
    expect(r.status).toBe("error");
    expect(r.code).toBe("PROVIDER_UNAVAILABLE");
    expect(seen.length).toBe(s.cfg.budgets.maxRetries + 1);
    const blob = JSON.stringify(r) + JSON.stringify(s.audit.list(r.task_id)) + s.logs.join("\n");
    expectLacks("result+audit+logs", blob, marker);
    expect(seen[0].url.startsWith("https://api.anthropic.com/")).toBe(true);
  });
  it("REAL Anthropic adapter: 401 maps to PROVIDER_AUTH and is NOT retried", async () => {
    const seen: any[] = [];
    const provider = new AnthropicProvider("claude-sonnet-5-5", "sk-test-not-real", { fetch: mockFetch(401, { type: "error", error: { type: "authentication_error", message: "x" } }, seen) });
    const r = await new TaskRunner(s.cfg, provider, s.bridge, s.audit).run(TASK);
    expect(r.code).toBe("PROVIDER_AUTH");
    expect(seen.length).toBe(1);
  });
  it("REAL Anthropic adapter request shape: approved endpoint, 5 constrained tools, key only in header, no telemetry headers; parses tool_use", async () => {
    const seen: any[] = [];
    const resp = { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "tool_use", stop_sequence: null,
      content: [{ type: "tool_use", id: "tu_1", name: "lookup_record", input: { record_id: "SYN-1042" } }], usage: { input_tokens: 123, output_tokens: 45 } };
    const provider = new AnthropicProvider("claude-sonnet-5-5", "sk-test-not-real", { fetch: mockFetch(200, resp, seen) });
    const out = await provider.complete({ system: "s", messages: [{ role: "user", text: TASK }], tools: TOOL_DEFS });
    expect(out.toolCalls).toEqual([{ id: "tu_1", name: "lookup_record", input: { record_id: "SYN-1042" } }]);
    expect(out.usage).toEqual({ inputTokens: 123, outputTokens: 45 });
    const body = JSON.parse(seen[0].body);
    expect(body.tools.map((t: any) => t.name).sort()).toEqual(["finish", "inspect", "lookup_record", "navigate", "open_record"]);
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(seen[0].body).not.toContain("sk-test-not-real");
    expect(Object.keys(seen[0].headers).filter((h) => h.startsWith("x-stainless"))).toEqual([]);
  });
});
