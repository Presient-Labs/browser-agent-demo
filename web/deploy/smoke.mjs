// Smoke test against a running live-demo server: run one preset and print a content-free summary.
// Usage: node web/deploy/smoke.mjs <preset> [base]   e.g. node web/deploy/smoke.mjs lookup http://127.0.0.1:4300
const [preset = "lookup", base = "http://127.0.0.1:4300"] = process.argv.slice(2);
const r = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset }) });
const sub = await r.json();
if (r.status !== 202) { console.log("refused", r.status, JSON.stringify(sub)); process.exit(1); }
const body = await (await fetch(`${base}/api/runs/${sub.run_id}/events`)).text();
const events = body.split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));
const counts = {};
for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
const res = events.find((e) => e.type === "result");
const fb = events.find((e) => e.type === "fallback");
const blocked = events.filter((e) => e.type === "audit" && e.event.outcome === "blocked").map((e) => `${e.event.category}:${e.event.code}`);
console.log(JSON.stringify({
  preset, counts,
  status: res?.result.status, code: res?.result.code, mutations: res?.mutations,
  has_source: Boolean(res?.result.source_url), model_calls: res?.result.usage.model_calls,
  usd: res?.result.usage.estimated_cost_usd, blocked, fallback: fb?.reason ?? null,
}));
