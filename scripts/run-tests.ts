// Runs vitest with ALL of its stdout/stderr captured, then scans that capture AND the JSON report for synthetic leak markers.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDir, scanText } from "../tests/leak.js";

const root = new URL("..", import.meta.url).pathname;
const outDir = process.env.OUT_DIR ?? root + "test-output";
mkdirSync(outDir, { recursive: true });
const config = process.env.RUN_CONFIG ?? "tests/vitest.config.ts";
const REAL = process.argv.includes("--real");
const reportName = REAL ? "real-results.json" : "results.json";
// vitest writes its raw JSON report to a PRIVATE temp dir; only a redacted copy is ever placed in the output dir.
const priv = mkdtempSync(join(tmpdir(), "vitest-raw-"));
const r = spawnSync(root + "node_modules/.bin/vitest", ["run", "--config", REAL ? "tests/vitest.real.config.ts" : config, `--outputFile.json=${priv}/${reportName}`, ...process.argv.slice(2).filter((a) => a !== "--real")], { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, env: process.env });
const redactDeep = (v: any): any => {
  if (typeof v === "string") { const ids = scanText(v); return ids.length ? `[REDACTED content-bearing text; marker ids ${ids.join(",")}]` : v; }
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
};
const rawPath = `${priv}/${reportName}`;
if (existsSync(rawPath)) { try { writeFileSync(`${outDir}/${reportName}`, JSON.stringify(redactDeep(JSON.parse(readFileSync(rawPath, "utf8"))))); } catch { /* unreadable report: nothing persisted */ } }
rmSync(priv, { recursive: true, force: true });
const captured = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
const streamIds = scanText(captured);
const fileHits = scanDir(outDir);
let leaked = false;
if (streamIds.length) { leaked = true; console.error(`LEAK-SCAN FAIL: captured vitest stdout/stderr contains synthetic markers ids=${streamIds.join(",")} (output withheld)`); }
if (fileHits.length) { leaked = true; console.error("LEAK-SCAN FAIL: persisted test-output files contain synthetic markers:"); for (const h of fileHits) console.error(`  ${h.file}: ${h.ids.join(",")}`); }
if (!leaked) { process.stdout.write(captured); console.log("LEAK-SCAN OK: no synthetic leak markers in captured stdout/stderr or test-output/"); }
const rc = r.status ?? 1;
console.log(`TEST EXIT: vitest=${rc} leak=${leaked ? 1 : 0}`);
process.exit(rc !== 0 || leaked ? 1 : 0);
