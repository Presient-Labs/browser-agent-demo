// Runs vitest with ALL of its stdout/stderr captured, then scans that capture AND test-output/ for synthetic leak markers.
// The scan runs whether vitest passed or failed. On a leak only marker IDs are printed (captured output is NOT echoed).
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { scanDir, scanText } from "../tests/leak.js";

const root = new URL("..", import.meta.url).pathname;
mkdirSync(root + "test-output", { recursive: true });
const r = spawnSync(root + "node_modules/.bin/vitest", ["run", "--config", "tests/vitest.config.ts", ...process.argv.slice(2)], { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, env: process.env });
const captured = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
const streamIds = scanText(captured);
const fileHits = scanDir(root + "test-output");
let leaked = false;
if (streamIds.length) { leaked = true; console.error(`LEAK-SCAN FAIL: captured vitest stdout/stderr contains synthetic markers ids=${streamIds.join(",")} (output withheld)`); }
if (fileHits.length) { leaked = true; console.error("LEAK-SCAN FAIL: persisted test-output files contain synthetic markers:"); for (const h of fileHits) console.error(`  ${h.file}: ${h.ids.join(",")}`); }
if (!leaked) { process.stdout.write(captured); console.log("LEAK-SCAN OK: no synthetic leak markers in captured stdout/stderr or test-output/"); }
const rc = r.status ?? 1;
console.log(`TEST EXIT: vitest=${rc} leak=${leaked ? 1 : 0}`);
process.exit(rc !== 0 || leaked ? 1 : 0);
