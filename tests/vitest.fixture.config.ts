import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tests/fixtures-leak/*.fixture.ts"], root: new URL("..", import.meta.url).pathname, reporters: ["default", "json"], outputFile: { json: `${process.env.OUT_DIR ?? "test-output"}/results.json` } },
});
