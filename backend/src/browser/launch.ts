import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

export interface LaunchOpts {
  port: number;
  extensionDir?: string;
  headless?: boolean; // true => --headless=new (tests). false => headed (needs a display, e.g. xvfb-run)
  userDataDir?: string; // default: fresh mktemp dir, deleted on close
  noSandbox?: boolean;
  /** Loopback ports Chrome may reach directly (synthetic site + backend). Everything else goes to a dead proxy. */
  allowLoopbackPorts?: number[];
  /** Extra Chrome flags. Used ONLY by the demo recorder (--test-type hides infobars); no containment flag is ever removed. */
  extraArgs?: string[];
}
export interface DedicatedBrowser {
  proc: ChildProcess;
  port: number;
  cdpUrl: string;
  userDataDir: string;
  nonce: string;
  allowPorts: number[];
  version: string;
  close: () => Promise<void>;
}

/**
 * Containment/provenance check against the browser's REAL command line (CDP Browser.getBrowserCommandLine).
 * The backend refuses any browser that does not carry every flag our launcher sets and a disposable bad-profile- dir.
 */
/** Flags the launcher always sets besides the egress group; the backend requires every one of them. */
export const BACKGROUND_FLAGS = [
  "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-sync", "--disable-component-update", "--disable-default-apps",
  "--disable-breakpad", "--disable-crash-reporter", "--disable-domain-reliability", "--disable-client-side-phishing-detection",
  "--no-pings", "--metrics-recording-only", "--password-store=basic", "--use-mock-keychain",
  "--disk-cache-size=1", "--media-cache-size=1",
  "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
  "--disable-search-engine-choice-screen", "--disable-popup-blocking",
];
export interface DedicatedExpect { nonce: string; userDataDir: string; allowPorts: number[] }
export const bypassListFor = (ports: number[]) => `<-loopback>;${ports.map((p) => `127.0.0.1:${p}`).join(";")}`;

/**
 * Exact validation against the browser's REAL command line (CDP Browser.getBrowserCommandLine): launch-bound (per-launch nonce
 * + the exact profile directory the launcher created), exact egress configuration, and every background-network flag.
 */
export function verifyDedicatedArgs(args: string[], expect: DedicatedExpect): boolean {
  if (!expect?.nonce || !expect.userDataDir) return false;
  const has = (x: string) => args.includes(x);
  const val = (k: string) => args.find((a) => a.startsWith(k + "="))?.slice(k.length + 1);
  return (
    val("--bad-launch-nonce") === expect.nonce &&
    has("--bad-dedicated-browser") && has("--enable-automation") &&
    val("--user-data-dir") === expect.userDataDir &&
    /(^|\/)bad-profile-[A-Za-z0-9]+$/.test(expect.userDataDir) &&
    val("--remote-debugging-address") === "127.0.0.1" &&
    val("--proxy-server") === "http://127.0.0.1:9" &&
    val("--proxy-bypass-list") === bypassListFor(expect.allowPorts) &&
    val("--host-resolver-rules") === "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" &&
    has("--dns-prefetch-disable") &&
    val("--force-webrtc-ip-handling-policy") === "disable_non_proxied_udp" &&
    val("--webrtc-ip-handling-policy") === "disable_non_proxied_udp" &&
    BACKGROUND_FLAGS.every(has)
  );
}

export const chromiumPath = () => chromium.executablePath();

export function chromeArgs(o: LaunchOpts & { userDataDir: string; nonce?: string }): string[] {
  const a = [
    "--bad-dedicated-browser", "--enable-automation", /* required for CDP Browser.getBrowserCommandLine (provenance check) */ ...(o.nonce ? [`--bad-launch-nonce=${o.nonce}`] : []), // provenance markers checked over CDP by the backend
    `--user-data-dir=${o.userDataDir}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${o.port}`,
    // ---- browser-level egress containment (covers what request interception cannot see) ----
    "--proxy-server=http://127.0.0.1:9", // dead proxy: any non-bypassed connection fails
    // <-loopback> removes Chrome's implicit "all loopback bypasses the proxy" rule; only listed host:ports are direct.
    `--proxy-bypass-list=${bypassListFor(o.allowLoopbackPorts ?? [4100, 4200])}`,
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--dns-prefetch-disable",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    ...BACKGROUND_FLAGS,
    "about:blank",
  ];
  if (o.extensionDir) a.unshift(`--load-extension=${o.extensionDir}`, `--disable-extensions-except=${o.extensionDir}`);
  if (o.extraArgs) a.unshift(...o.extraArgs);
  if (o.headless) a.unshift("--headless=new");
  if (o.noSandbox) a.unshift("--no-sandbox");
  return a;
}

/** Launch Playwright's bundled Chromium (Chrome for Testing) with a disposable profile, CDP on 127.0.0.1 only. */
export async function launchDedicatedBrowser(o: LaunchOpts): Promise<DedicatedBrowser> {
  const userDataDir = o.userDataDir ?? (await mkdtemp(join(tmpdir(), "bad-profile-")));
  const cdpUrl = `http://127.0.0.1:${o.port}`;
  // The port must be FREE: otherwise whatever answers on it is not the browser we are about to spawn.
  let busy = false;
  try { await fetch(`${cdpUrl}/json/version`); busy = true; } catch { /* free */ }
  if (busy) { if (!o.userDataDir) await rm(userDataDir, { recursive: true, force: true }); throw new Error("CDP_PORT_IN_USE"); }
  const nonce = randomBytes(12).toString("hex");
  const proc = spawn(chromiumPath(), chromeArgs({ ...o, userDataDir, nonce }), { stdio: "ignore", detached: false });
  let exited = false;
  proc.once("exit", () => { exited = true; });
  let version = "";
  for (let i = 0; i < 100 && !version; i++) {
    if (exited) throw new Error("BROWSER_EXITED_EARLY");
    try {
      const r = await fetch(`${cdpUrl}/json/version`);
      version = ((await r.json()) as { Browser: string }).Browser;
    } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  const cleanupDir = async () => { if (!o.userDataDir) await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); };
  if (!version) { proc.kill("SIGKILL"); await cleanupDir(); throw new Error("BROWSER_CDP_TIMEOUT"); }
  // Prove the responder is OUR process: its real command line must carry our per-launch nonce.
  let mine = false;
  try {
    const b = await chromium.connectOverCDP(cdpUrl);
    const sess = await b.newBrowserCDPSession();
    const { arguments: args } = (await sess.send("Browser.getBrowserCommandLine" as any)) as { arguments: string[] };
    mine = verifyDedicatedArgs(args, { nonce, userDataDir, allowPorts: o.allowLoopbackPorts ?? [4100, 4200] });
    await b.close().catch(() => {});
  } catch { mine = false; }
  if (!mine) { proc.kill("SIGKILL"); await cleanupDir(); throw new Error("BROWSER_NOT_OURS"); }
  return {
    proc, port: o.port, cdpUrl, userDataDir, nonce, allowPorts: o.allowLoopbackPorts ?? [4100, 4200], version,
    close: async () => {
      if (!exited) { proc.kill("SIGTERM"); await new Promise((r) => { proc.once("exit", r); setTimeout(r, 3000); }); if (!exited) proc.kill("SIGKILL"); }
      await cleanupDir(); // always runs, also when Chromium had already exited on its own
    },
  };
}

/** Launcher -> backend handoff: the nonce and profile dir of THE browser the launcher spawned (file mode 0600, removed on close). */
export const handoffPath = (port: number) => join(tmpdir(), `bad-launch-${port}.json`);
export async function writeHandoff(b: DedicatedBrowser) {
  await writeFile(handoffPath(b.port), JSON.stringify({ nonce: b.nonce, userDataDir: b.userDataDir, pid: b.proc.pid }), { mode: 0o600 });
}
export async function removeHandoff(port: number) { await rm(handoffPath(port), { force: true }); }
export async function readHandoff(port: number, allowPorts: number[]): Promise<DedicatedExpect> {
  const j = JSON.parse(await readFile(handoffPath(port), "utf8")) as { nonce: string; userDataDir: string };
  return { nonce: j.nonce, userDataDir: j.userDataDir, allowPorts };
}
