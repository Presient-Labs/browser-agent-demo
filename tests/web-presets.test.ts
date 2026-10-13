import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startStack, siteCounter, ScriptedProvider, type Stack } from "./helpers.js";
import { PRESETS, validateFreeText, providerFor, SimulatingProvider, simulationTarget } from "../web/src/presets.js";

let s: Stack;
beforeAll(async () => { s = await startStack(); });
afterAll(async () => { await s?.close(); });

describe("presets (FAKE mode)", () => {
  it("there are five, with unique ids, in the page order", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(["lookup", "write", "offsite", "signin", "sources"]);
  });

  for (const p of PRESETS) {
    it(`${p.id}: ends ${p.expect}`, async () => {
      const r = await s.runner(providerFor(p, null, s.cfg.siteOrigin, () => {})).run(p.task);
      expect(r.status).toBe(p.expect);
    });
  }

  it("the write preset never changes the site, and the off-site preset never reaches another host", async () => {
    const before = await siteCounter();
    await s.runner(providerFor(PRESETS[1], null, s.cfg.siteOrigin, () => {})).run(PRESETS[1].task);
    await s.runner(providerFor(PRESETS[2], null, s.cfg.siteOrigin, () => {})).run(PRESETS[2].task);
    expect(await siteCounter()).toBe(before);
    expect(s.evil.hits()).toEqual([]);
  });
});

describe("simulated misbehaving step (REAL mode stand-in)", () => {
  const honest = () => new ScriptedProvider([
    { name: "lookup_record", input: { record_id: "SYN-1042" } },
    { name: "open_record", input: { link_id: "r1" } },
    { name: "inspect", input: { region: "record" } },
    { name: "finish", input: { status: "found", record_id: "SYN-1042", fields: { balance: "1284.55" } } },
  ]);

  it("swaps the model's first finish for one write attempt, which the policy blocks", async () => {
    let simulated = 0;
    const p = new SimulatingProvider(honest(), simulationTarget("write", s.cfg.siteOrigin), () => simulated++);
    const before = await siteCounter();
    const r = await s.runner(p).run(PRESETS[1].task);
    expect(r.status).toBe("blocked");
    expect(simulated).toBe(1);
    expect(await siteCounter()).toBe(before);
  });

  it("providerFor wraps a real provider only for the two blocked presets", () => {
    const real = honest();
    expect(providerFor(PRESETS[0], real, s.cfg.siteOrigin, () => {})).toBe(real);
    expect(providerFor(PRESETS[1], real, s.cfg.siteOrigin, () => {})).toBeInstanceOf(SimulatingProvider);
    expect(providerFor(null, real, s.cfg.siteOrigin, () => {})).toBe(real);
    expect(providerFor(null, null, s.cfg.siteOrigin, () => {}).mode).toBe("FAKE");
  });
});

describe("validateFreeText", () => {
  it("accepts one record id and at least one known field, trimmed", () => {
    expect(validateFreeText("  What is the balance of SYN-1007? ")).toEqual({ ok: true, text: "What is the balance of SYN-1007?" });
  });
  it("rejects empty, too long, no id, two ids, or no known field, with a plain message", () => {
    for (const bad of [undefined, 42, "", "x".repeat(301) + " SYN-1007 balance", "balance please", "balance of SYN-1007 and SYN-1042", "Tell me about SYN-1007"]) {
      const v = validateFreeText(bad);
      expect(v.ok, String(bad).slice(0, 40)).toBe(false);
      if (!v.ok) expect(v.message.length).toBeGreaterThan(5);
    }
  });
});
