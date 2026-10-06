import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, it, expect } from "vitest";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("finding 9: launcher script cleans its disposable profile on SIGTERM", () => {
  it("profile directory is gone after the launcher exits", async () => {
    const proc = spawn(process.execPath, ["--import", "tsx", "scripts/launch-browser.ts"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, HEADLESS: "1", CDP_PORT: "9666", NO_SANDBOX: process.env.NO_SANDBOX ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; proc.stdout.on("data", (d) => (out += d)); proc.stderr.on("data", () => {});
    for (let i = 0; i < 100 && !/disposable profile/.test(out); i++) await sleep(200);
    const dir = /disposable profile[^:]*: (\S+)/.exec(out)?.[1] ?? "";
    expect(dir).toContain("bad-profile-");
    expect(existsSync(dir)).toBe(true);
    const exited = new Promise<void>((r) => proc.on("exit", () => r()));
    proc.kill("SIGTERM");
    await Promise.race([exited, sleep(15000)]);
    await sleep(1500);
    expect(existsSync(dir)).toBe(false);
  });
});

