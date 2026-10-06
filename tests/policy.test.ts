import { describe, it, expect } from "vitest";
import { checkUrl, classifyRequest } from "../backend/src/policy/url.js";
import { validateCall, TOOL_NAMES } from "../backend/src/tools.js";
import { AuditStore } from "../backend/src/audit.js";
import { resolveProvider } from "../backend/src/providers/registry.js";
import { loadConfig } from "../backend/src/config.js";

const ORIGIN = "http://127.0.0.1:4100";
const cls = (url: string, method = "GET", nav = true) => classifyRequest({ url, method, isNavigation: nav }, ORIGIN);

describe("allowlist (exact scheme/host/port)", () => {
  it("allows approved read routes", () => {
    for (const u of ["/", "/search?q=SYN-1042", "/records/SYN-1042", "/login-challenge"]) expect(cls(ORIGIN + u).allow).toBe(true);
  });
  it.each([
    ["wrong port", "http://127.0.0.1:4101/"],
    ["wrong host name for same machine", "http://localhost:4100/"],
    ["deceptive subdomain", "http://127.0.0.1.evil.example:4100/"],
    ["userinfo trick", "http://127.0.0.1:4100@evil.example/"],
    ["userinfo creds", "http://user:pw@127.0.0.1:4100/"],
    ["https scheme", "https://127.0.0.1:4100/"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,hi"],
    ["file scheme", "file:///etc/passwd"],
    ["blob scheme", "blob:http://127.0.0.1:4100/x"],
    ["malformed", "http://"],
    ["backslash host confusion", "http://127.0.0.1:4100\\@evil.example/"],
    ["whitespace", "http://127.0.0.1:4100/ x"],
    ["empty", ""],
    ["unicode lookalike host", "http://127.0.0.1。evil.example:4100/"],
  ])("blocks %s", (_n, url) => { expect(cls(url).allow).toBe(false); });
  it("checkUrl never throws on garbage", () => {
    for (const g of ["%%%", "http://[::1", "\u0000", "a".repeat(5000)]) expect(checkUrl(g, ORIGIN).ok).toBe(false);
  });
});

describe("read-only route semantics (not HTTP-verb semantics)", () => {
  it("blocks non-GET even on approved routes", () => { expect(cls(ORIGIN + "/search", "POST").code).toBe("WRITE_METHOD"); });
  it("blocks a GET that would mutate (route semantics)", () => {
    expect(cls(ORIGIN + "/records/SYN-1042/delete").code).toBe("WRITE_ROUTE");
    expect(cls(ORIGIN + "/records/SYN-1042/submit").allow).toBe(false);
    expect(cls(ORIGIN + "/api/mutate").allow).toBe(false);
  });
  it("blocks unknown routes and the test-only endpoints", () => {
    expect(cls(ORIGIN + "/__test/mutations").allow).toBe(false);
    expect(cls(ORIGIN + "/records/..%2f..%2fadmin").allow).toBe(false);
  });
  it("subresources follow the same rules", () => { expect(cls("http://127.0.0.1:4101/pixel.png", "GET", false).allow).toBe(false); });
});

describe("tool schemas", () => {
  it("exposes only the five constrained tools", () => { expect(TOOL_NAMES.sort()).toEqual(["finish", "inspect", "lookup_record", "navigate", "open_record"]); });
  it.each([
    ["unknown tool", "run_js", { code: "1" }],
    ["inspect free-form selector", "inspect", { region: "body" }],
    ["inspect extra key", "inspect", { region: "record", selector: "#x" }],
    ["lookup bad id", "lookup_record", { record_id: "SYN-1; DROP" }],
    ["lookup short id", "lookup_record", { record_id: "SYN-12" }],
    ["open bad link", "open_record", { link_id: "../../x" }],
    ["navigate non-string", "navigate", { url: 5 }],
    ["finish unknown field", "finish", { status: "found", record_id: "SYN-1042", fields: { ssn: "x" } }],
    ["finish bad status", "finish", { status: "great", record_id: "SYN-1042", fields: {} }],
    ["prototype key", "__proto__", {}],
  ])("rejects %s", (_n, name, input) => { expect(validateCall(name, input).ok).toBe(false); });
  it("accepts valid calls", () => {
    expect(validateCall("lookup_record", { record_id: "SYN-1042" }).ok).toBe(true);
    expect(validateCall("finish", { status: "found", record_id: "SYN-1042", fields: { balance: "1.00" } }).ok).toBe(true);
  });
});

describe("audit store is metadata-only", () => {
  it("refuses free text in the code field", () => {
    const a = new AuditStore();
    const e = a.record({ task_id: "t", category: "navigate", outcome: "blocked", code: "http://x/?name=Jane Doe" });
    expect(e.code).toBe("UNKNOWN_CODE");
    expect(Object.keys(e).sort()).toEqual(["action_id", "category", "code", "duration_ms", "event_id", "outcome", "task_id", "ts"]);
  });
});

describe("provider approval (pure config checks)", () => {
  const base = { approvedModels: ["anthropic:claude-sonnet-5-5"], anthropicApiKey: "k" };
  it("rejects unknown provider, unapproved model, and fake without factory", () => {
    expect(() => resolveProvider({ ...base, provider: "evilcorp", model: "x" })).toThrow("PROVIDER_NOT_APPROVED");
    expect(() => resolveProvider({ ...base, provider: "anthropic", model: "claude-other" })).toThrow("PROVIDER_NOT_APPROVED");
    expect(() => resolveProvider({ ...base, provider: "openai", model: "gpt-x" })).toThrow("PROVIDER_NOT_APPROVED");
    expect(() => resolveProvider({ ...base, provider: "fake", model: "x" })).toThrow("PROVIDER_NOT_APPROVED");
  });
  it("missing key => PROVIDER_NO_KEY", () => {
    expect(() => resolveProvider({ ...base, anthropicApiKey: "", provider: "anthropic", model: "claude-sonnet-5-5" })).toThrow("PROVIDER_NO_KEY");
  });
  it("config has no user-settable endpoint", () => {
    const c = loadConfig({ ANTHROPIC_BASE_URL: "http://evil", PROVIDER_ENDPOINT: "http://evil" });
    expect(JSON.stringify(c)).not.toContain("evil");
  });
});
