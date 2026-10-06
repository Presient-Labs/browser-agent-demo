import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "*.test.ts"],
    root: new URL("..", import.meta.url).pathname,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ["default", "json"],
    outputFile: { json: "test-output/results.json" },
    exclude: ["**/node_modules/**", "**/real-provider*.test.ts"],
    env: { ANTHROPIC_API_KEY: "" },
  },
});
