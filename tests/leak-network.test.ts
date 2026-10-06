import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startStack, installNetGuard, ScriptedProvider, SITE, CDP_PORT, type Stack } from "./helpers.js";
import { scanText, scanDir, snapshot } from "./leak.js";
import { ALL_MARKERS } from "../site/src/data.js";

const REPO = new URL("..", import.meta.url).pathname;
const skipRepo = (p: string) => /node_modules|\/\.git|\/test-output|extension\/dist/.test(p);
let s: Stack; let guard: ReturnType<typeof installNetGuard>;
const chromeSamples = new Set<string>();

function chromePids(root: number): Set<number> {
  const pids = new Set<number>([root]);
  const ents = readdirSync("/proc").filter((x) => /^\d+$/.test(x));
  const ppid = new Map<number, number>();
  for (const e of ents) { try { const st = readFileSync(`/proc/${e}/stat`, "utf8"); ppid.set(Number(e), Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1])); } catch {} }
  for (let ch = true; ch;) { ch = false; for (const [p, pp] of ppid) if (pids.has(pp) && !pids.has(p)) { pids.add(p); ch = true; } }
  return pids;
}
function sampleChrome() {
  try {
    const pids = chromePids(s.browser.proc.pid!);
    const out = execSync("ss -tnpH", { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const m = /pid=(\d+)/.exec(line); if (!m || !pids.has(Number(m[1]))) continue;
      const cols = line.trim().split(/\s+/); const peer = cols[4] ?? "";
      if (!/^(127\.0\.0\.1|\[::1\])/.test(peer)) chromeSamples.add(peer);
    }
  } catch { /* ss unavailable */ }
}

beforeAll(async () => { guard = installNetGuard(); s = await startStack(); });
afterAll(async () => { guard.restore(); await s?.close(); });

describe("9 leak markers", () => {
  it("scanner can fail (positive control): detects a planted marker, reports only an ID", () => {
    const hits = scanText(`noise ${ALL_MARKERS[0]} noise`);
    expect(hits).toEqual(["M0"]);
    expect(hits.join()).not.toContain("LEAKMARK");
  });
  it("no markers in logs, audit events, progress or errors across success / not_found / conflict / blocked / auth tasks; no files written", async () => {
    const before = snapshot(REPO, skipRepo);
    const tasks: [string, any][] = [
      ["Find SYN-1042 and report its claim status and balance.", "happy"], ["Find SYN-1001 and report its payer.", "happy"],
      ["Find SYN-9999 and report its balance.", "happy"], ["Find SYN-2077 and report its balance.", "happy"],
      ["Find SYN-3001 and report its claim status.", "gullible"], ["Find SYN-1042 and report its balance.", "login"], ["Find SYN-1042 and report its balance.", "writer"],
    ];
    const errs: string[] = [];
    for (const [t, sc] of tasks) { const r = await s.run(t, sc); errs.push(r.message, r.next_action, r.code); }
    const channels = { logs: s.logs.join("\n"), audit: JSON.stringify(s.audit.list()), progress: s.progress.join("\n"), errors: errs.join("\n") };
    for (const [name, text] of Object.entries(channels)) expect({ name, ids: scanText(text) }).toEqual({ name, ids: [] });
    const after = snapshot(REPO, skipRepo);
    expect([...after.keys()].filter((k) => !before.has(k) || before.get(k) !== after.get(k))).toEqual([]);
  });
  it("residual Chrome profile artifacts: measured (disposable dir) and reported", () => {
    const hits = scanDir(s.browser.userDataDir);
    // Informational + asserted: with an isolated non-persistent context, record values should not be on disk.
    console.log(`PROFILE-RESIDUE: files with markers = ${hits.length}${hits.length ? " ids=" + hits.flatMap((h) => h.ids).join(",") : ""}`);
    expect(hits.map((h) => h.ids)).toEqual([]);
  });
});

describe("14 runtime network", () => {
  it("CDP port is bound to loopback only", () => {
    const l = execSync("ss -ltnH", { encoding: "utf8" }).split("\n").filter((x) => x.includes(`:${CDP_PORT} `));
    expect(l.length).toBeGreaterThan(0);
    for (const x of l) expect(x).toMatch(/127\.0\.0\.1:/);
  });
  it("app traffic: only the approved site (+ loopback CDP) was contacted by the Node process; Chrome non-loopback sockets reported separately", async () => {
    guard.attempts.length = 0; chromeSamples.clear();
    const iv = setInterval(sampleChrome, 100);
    const hitsBefore = s.evil.hits().length;
    const r = await s.run("Find SYN-1042 and report its claim status and balance.", "happy");
    await new Promise((x) => setTimeout(x, 4000)); // idle window to catch background traffic
    clearInterval(iv);
    expect(r.status).toBe("success");
    const targets = new Set(guard.attempts.map((a) => a.replace(/^localhost:/, "127.0.0.1:")));
    const allowed = new Set([`127.0.0.1:4100`, `127.0.0.1:${CDP_PORT}`]);
    expect([...targets].filter((t) => !allowed.has(t))).toEqual([]);
    expect(s.evil.hits().length).toBe(hitsBefore);
    console.log(`NETWORK: node connect targets = ${JSON.stringify([...targets])}`);
    console.log(`NETWORK: chrome non-loopback peers observed (UNCONTAINED by app-level interception; sampled ss) = ${JSON.stringify([...chromeSamples])}`);
  });
  it("blocked off-site request is attempted at the app layer only as an audited block, never as a socket to it", async () => {
    guard.attempts.length = 0;
    await s.run("Find SYN-1042 and report its balance.", new ScriptedProvider([{ name: "navigate", input: { url: "http://127.0.0.1:4101/exfil" } }]));
    expect(guard.attempts.some((a) => a.endsWith(":4101"))).toBe(false);
  });
});
void SITE;
