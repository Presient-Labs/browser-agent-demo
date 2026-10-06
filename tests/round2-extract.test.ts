import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startStack, ScriptedProvider, RecordingProvider, SITE, type Stack } from "./helpers.js";
import { expectLacks, expectHas, expectEq } from "./leak.js";

let s: Stack;
beforeAll(async () => { s = await startStack(); });
afterAll(async () => { if (s) s.bridge.testSeam = undefined; await s?.close(); });
const TASK = "Find SYN-1042 and report its balance.";
const nav = (path: string) => ({ name: "navigate", input: { url: `${SITE}${path}` } });
const insp = { name: "inspect", input: { region: "record" } };
const fin = (fields: Record<string, string>) => ({ name: "finish", input: { status: "found", record_id: "SYN-1042", fields } });

describe("N1: only visibly rendered text is extracted; shadow-root credentials pause", () => {
  it("hidden/aria-hidden/opacity:0/visibility:hidden descendants and opacity:0 fields never reach the model", async () => {
    const rec = new RecordingProvider(new ScriptedProvider([nav("/fixtures/n1-hidden-desc"), insp, fin({ balance: "1284.55" })]));
    const r = await s.run(TASK, rec);
    expectLacks("model-visible text", rec.sent.join("\n"), "AUTHSECRET");
    expectEq("status", r.status, "success");
    expectEq("balance", r.fields.balance, "1284.55");
  });
  for (const mode of ["open", "closed"]) {
    it(`password form inside a ${mode} shadow root => human_action_required; nothing extracted`, async () => {
      const rec = new RecordingProvider(new ScriptedProvider([nav(`/fixtures/n1-shadow-${mode}`), insp, fin({ balance: "1284.55" })]));
      const r = await s.run(TASK, rec);
      expectEq("status", r.status, "human_action_required");
      expectLacks("model-visible text", rec.sent.join("\n"), "AUTHSECRET");
      expectLacks("model-visible text", rec.sent.join("\n"), "1284.55");
    });
  }
});

describe("N4: source URL comes from the extraction turn; a late route change cannot produce a mutation link", () => {
  it("pushState to /delete during the final auth check => blocked, no source_url pointing at the write route", async () => {
    s.bridge.testSeam = { afterPostCheck: async (p) => { await p.evaluate(() => history.pushState({}, "", "/records/SYN-1042/delete")); } };
    const r = await s.run(TASK, new ScriptedProvider([{ name: "lookup_record", input: { record_id: "SYN-1042" } }, { name: "open_record", input: { link_id: "r1" } }, insp, fin({ balance: "1284.55" })]));
    s.bridge.testSeam = undefined;
    expect(`${r.status} srcWrite=${/delete|update|submit/.test(r.source_url ?? "")}`).toBe("blocked srcWrite=false");
  });
});

describe("N5: lossy extraction is never verified as success", () => {
  it("whitespace padding cannot hide a qualification: model answering the prefix is not success", async () => {
    const r = await s.run("Find SYN-1042 and report its claim status.", new ScriptedProvider([nav("/fixtures/n5-spaces"), insp, { name: "finish", input: { status: "found", record_id: "SYN-1042", fields: { claim_status: "Paid" } } }]));
    expectEq("status", r.status, "uncertain");
  });
  it("a value longer than the per-field cap is truncated => uncertain even if the model repeats the kept prefix", async () => {
    const r = await s.run("Find SYN-1042 and report its payer.", new ScriptedProvider([nav("/fixtures/n5-long"), insp, { name: "finish", input: { status: "found", record_id: "SYN-1042", fields: { payer: "A".repeat(400) } } }]));
    expectEq("status", r.status, "uncertain");
  });
  it("repeated truncated searches hit the aggregate extraction budget", async () => {
    const cfg = { ...s.cfg, budgets: { ...s.cfg.budgets, maxTotalExtractedChars: 5000 } };
    const { TaskRunner } = await import("../backend/src/coordinator.js");
    const steps = [nav("/fixtures/huge-results"), ...Array.from({ length: 8 }, () => ({ name: "inspect", input: { region: "results" } }))];
    const r = await new TaskRunner(cfg, new ScriptedProvider(steps), s.bridge, s.audit).run(TASK);
    expectEq("code", r.code, "EXTRACTION_BUDGET");
  });
});
void expectHas;
