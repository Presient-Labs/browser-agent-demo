import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { scanDir, scanText } from "./leak.js";

const root = new URL("..", import.meta.url).pathname;
describe("N6: the test wrapper never leaves content-bearing artifacts behind, even when a test fails", () => {
  it("failing content-bearing fixture => run fails, withheld output, and NO file under the output dir contains a marker", () => {
    const out = mkdtempSync(join(tmpdir(), "leakwrap-"));
    const r = spawnSync(root + "node_modules/.bin/tsx", [root + "scripts/run-tests.ts"], { cwd: root, encoding: "utf8", env: { ...process.env, RUN_CONFIG: "tests/vitest.fixture.config.ts", OUT_DIR: out } });
    expect(`wrapper exit nonzero: ${r.status !== 0}`).toBe("wrapper exit nonzero: true");
    expect(`wrapper stdout leak ids: ${scanText((r.stdout ?? "") + (r.stderr ?? "")).join(",") || "none"}`).toBe("wrapper stdout leak ids: none");
    const hits = scanDir(out);
    expect(`persisted artifacts with markers: ${hits.map((h) => h.file + ":" + h.ids.join("+")).join(",") || "none"}`).toBe("persisted artifacts with markers: none");
    expect(readdirSync(out).length).toBeGreaterThan(0); // a (redacted) report still exists
  });
});
