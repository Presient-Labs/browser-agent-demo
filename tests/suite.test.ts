import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startStack, siteCounter, SITE, type Stack } from "./helpers.js";
import { FakeProvider, type FakeScript } from "../backend/src/providers/fake.js";

interface Case { id: number; name: string; task: string; script: FakeScript; status: string; check?: (r: any) => boolean }
export const SUITE: Case[] = [
  { id: 1, name: "SYN-1042 claim status + balance", task: "Find SYN-1042 and report its claim status and balance.", script: "happy", status: "success", check: (r) => r.fields.balance === "1284.55" && r.fields.claim_status === "Pending - Payer Review" && r.source_url === `${SITE}/records/SYN-1042` },
  { id: 2, name: "SYN-1001 payer + service date", task: "Find SYN-1001 and report its payer and service date.", script: "happy", status: "success", check: (r) => Object.keys(r.fields).length === 2 },
  { id: 3, name: "SYN-1015 balance", task: "Find SYN-1015 and report its balance.", script: "happy", status: "success" },
  { id: 4, name: "unknown record SYN-9999", task: "Find SYN-9999 and report its balance.", script: "happy", status: "not_found", check: (r) => Object.keys(r.fields).length === 0 },
  { id: 5, name: "conflicting SYN-2077 claim status", task: "Find SYN-2077 and report its claim status.", script: "happy", status: "uncertain", check: (r) => r.code === "CONFLICTING_EVIDENCE" },
  { id: 6, name: "non-conflicting field on SYN-2077", task: "Find SYN-2077 and report its payer.", script: "happy", status: "success" },
  { id: 7, name: "prompt injection SYN-3001", task: "Find SYN-3001 and report its claim status.", script: "gullible", status: "blocked" },
  { id: 8, name: "login challenge", task: "Find SYN-1042 and report its balance.", script: "login", status: "human_action_required" },
  { id: 9, name: "write attempt", task: "Find SYN-1042 and report its balance.", script: "writer", status: "blocked" },
  { id: 10, name: "off-site navigation", task: "Find SYN-1042 and report its balance.", script: "offsite", status: "blocked" },
];

let s: Stack;
beforeAll(async () => { s = await startStack(); await fetch(`${SITE}/__test/reset`); });
afterAll(async () => { await s?.close(); });

describe("declared 10-task deterministic suite (fake provider, real browser)", () => {
  const passed: number[] = [];
  for (const c of SUITE) {
    it(`task ${c.id}: ${c.name} -> ${c.status}`, async () => {
      const r = await s.run(c.task, new FakeProvider(c.script));
      expect(r.status).toBe(c.status);
      if (c.check) expect(c.check(r)).toBe(true);
      passed.push(c.id);
    });
  }
  it("suite summary", async () => {
    console.log(`SUITE RESULT: ${passed.length}/${SUITE.length} tasks passed (provider=FAKE, browser=real Chromium)`);
    console.log(`SUITE mutation counter after all 10 tasks (expect 0): ${await siteCounter()}`);
    expect(passed.length).toBe(SUITE.length);
    expect(await siteCounter()).toBe(0);
  });
});
