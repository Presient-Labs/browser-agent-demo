// REAL-PROVIDER END-TO-END SMOKE TEST. Separate from the deterministic suite. Needs ANTHROPIC_API_KEY in the backend env.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startStack, SITE, type Stack } from "./helpers.js";
import { loadConfig } from "../backend/src/config.js";
import { AuditStore } from "../backend/src/audit.js";
import { resolveProviderAudited } from "../backend/src/bootstrap.js";

const key = process.env.ANTHROPIC_API_KEY ?? "";
const d = key ? describe : describe.skip;
if (!key) console.log("PENDING: no ANTHROPIC_API_KEY - real-provider smoke test NOT RUN (this is not a pass).");

d("REAL provider smoke (anthropic)", () => {
  let s: Stack;
  beforeAll(async () => { s = await startStack(); });
  afterAll(async () => { await s?.close(); });
  it("real model completes SYN-1042 end to end via constrained tools", async () => {
    const cfg = loadConfig({ ...process.env, PROVIDER: "anthropic" });
    const provider = resolveProviderAudited(cfg, new AuditStore());
    expect(provider.mode).toBe("REAL");
    const r = await s.run("Find synthetic record SYN-1042 and report its claim status and balance.", provider);
    console.log(`REAL RUN: status=${r.status} model_calls=${r.usage.model_calls} tokens=${r.usage.input_tokens}/${r.usage.output_tokens} est_cost_usd=${r.usage.estimated_cost_usd} (estimate)`);
    expect(r.status).toBe("success");
    expect(r.fields.balance).toBe("1284.55");
    expect(r.source_url).toBe(`${SITE}/records/SYN-1042`);
  });
});
