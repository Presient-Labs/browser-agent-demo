import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { chromeArgs, chromiumPath, verifyDedicatedArgs } from "../backend/src/browser/launch.js";
import { BrowserBridge } from "../backend/src/browser/bridge.js";
import { AuditStore } from "../backend/src/audit.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EXP = { nonce: "n0nce", userDataDir: "/tmp/bad-profile-abc123", allowPorts: [4100, 4200] };
const good = () => chromeArgs({ port: 9555, userDataDir: EXP.userDataDir, nonce: EXP.nonce, allowLoopbackPorts: EXP.allowPorts });
const swap = (args: string[], prefix: string, repl?: string) => args.filter((a) => !a.startsWith(prefix)).concat(repl ? [repl] : []);

describe("N2: dedicated-browser validator", () => {
  it("positive control: the launcher's own args verify", () => { expect(verifyDedicatedArgs(good(), EXP)).toBe(true); });
  it.each([
    ["missing nonce", (a: string[]) => swap(a, "--bad-launch-nonce")],
    ["wrong nonce", (a: string[]) => swap(a, "--bad-launch-nonce", "--bad-launch-nonce=zzz")],
    ["wrong profile dir", (a: string[]) => swap(a, "--user-data-dir", "--user-data-dir=/tmp/bad-profile-other")],
    ["wildcard bypass list", (a: string[]) => swap(a, "--proxy-bypass-list", "--proxy-bypass-list=<-loopback>;*")],
    ["extra allowed port", (a: string[]) => swap(a, "--proxy-bypass-list", "--proxy-bypass-list=<-loopback>;127.0.0.1:4100;127.0.0.1:4200;127.0.0.1:9999")],
    ["missing background flag --disable-background-networking", (a: string[]) => a.filter((x) => x !== "--disable-background-networking")],
    ["missing --no-pings", (a: string[]) => a.filter((x) => x !== "--no-pings")],
    ["missing --disable-sync", (a: string[]) => a.filter((x) => x !== "--disable-sync")],
    ["dns prefetch enabled", (a: string[]) => a.filter((x) => x !== "--dns-prefetch-disable")],
  ])("rejects: %s", (_n, mut) => { expect(verifyDedicatedArgs(mut(good()), EXP)).toBe(false); });
});

describe("N2: backend refuses a look-alike browser (negative browser HAS --enable-automation, so the validator itself decides)", () => {
  it("marker flags + bad-profile-* dir + automation but NO launch nonce => BROWSER_NOT_DEDICATED", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bad-profile-"));
    const args = ["--headless=new", "--no-sandbox", ...chromeArgs({ port: 9555, userDataDir: dir, allowLoopbackPorts: [4100, 4200] })]; // no nonce flag
    expect(args.includes("--enable-automation")).toBe(true);
    const proc = spawn(chromiumPath(), args, { stdio: "ignore" });
    try {
      for (let i = 0; i < 60; i++) { try { await fetch("http://127.0.0.1:9555/json/version"); break; } catch { await sleep(200); } }
      const bridge = new BrowserBridge("http://127.0.0.1:4100", new AuditStore());
      await expect(bridge.connect("http://127.0.0.1:9555", { nonce: "expected-nonce", userDataDir: dir, allowPorts: [4100, 4200] })).rejects.toThrow("BROWSER_NOT_DEDICATED");
      expect(bridge.connected).toBe(false);
    } finally { proc.kill("SIGKILL"); await sleep(500); }
  });
});
