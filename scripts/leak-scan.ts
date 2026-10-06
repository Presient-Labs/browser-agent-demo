// Post-run scan of persisted test output. On failure prints ONLY marker IDs + file names, never content.
import { scanDir } from "../tests/leak.js";
const root = new URL("..", import.meta.url).pathname;
const hits = scanDir(root + "test-output");
if (hits.length) {
  console.error("LEAK-SCAN FAIL: synthetic markers found in persisted test output:");
  for (const h of hits) console.error(`  ${h.file}: ${h.ids.join(",")}`);
  process.exit(1);
}
console.log("LEAK-SCAN OK: no synthetic leak markers in test-output/");
