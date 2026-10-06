import { defineConfig } from "vitest/config";
// Real-provider smoke test only. Reads the repo-local .env (the documented config path) if present.
try { process.loadEnvFile(new URL("../.env", import.meta.url).pathname); } catch { /* none */ }
export default defineConfig({
  test: { include: ["tests/real-provider.test.ts"], root: new URL("..", import.meta.url).pathname, fileParallelism: false, testTimeout: 180_000, hookTimeout: 60_000, reporters: ["default", "json"], outputFile: { json: "test-output/real-results.json" } },
});
