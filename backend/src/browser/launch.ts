import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
}
export interface DedicatedBrowser {
  proc: ChildProcess;
  port: number;
  cdpUrl: string;
  userDataDir: string;
  version: string;
  close: () => Promise<void>;
}

export const chromiumPath = () => chromium.executablePath();

export function chromeArgs(o: LaunchOpts & { userDataDir: string }): string[] {
  const a = [
    `--user-data-dir=${o.userDataDir}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${o.port}`,
    // ---- browser-level egress containment (covers what request interception cannot see) ----
    "--proxy-server=http://127.0.0.1:9", // dead proxy: any non-bypassed connection fails
    // <-loopback> removes Chrome's implicit "all loopback bypasses the proxy" rule; only listed host:ports are direct.
    `--proxy-bypass-list=<-loopback>;${(o.allowLoopbackPorts ?? [4100, 4200]).map((p) => `127.0.0.1:${p}`).join(";")}`,
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--dns-prefetch-disable",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--no-first-run", "--no-default-browser-check",
    // minimise persistence + background traffic (does NOT make Chrome silent; see ARCHITECTURE.md)
    "--disable-background-networking", "--disable-sync", "--disable-component-update", "--disable-default-apps",
    "--disable-breakpad", "--disable-crash-reporter", "--disable-domain-reliability", "--disable-client-side-phishing-detection",
    "--no-pings", "--metrics-recording-only", "--password-store=basic", "--use-mock-keychain",
    "--disk-cache-size=1", "--media-cache-size=1", "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
    "--disable-search-engine-choice-screen",
    "--disable-popup-blocking", // so popup attempts reach (and are closed/audited by) our own policy
    "about:blank",
  ];
  if (o.extensionDir) a.unshift(`--load-extension=${o.extensionDir}`, `--disable-extensions-except=${o.extensionDir}`);
  if (o.headless) a.unshift("--headless=new");
  if (o.noSandbox) a.unshift("--no-sandbox");
  return a;
}

/** Launch Playwright's bundled Chromium (Chrome for Testing) with a disposable profile, CDP on 127.0.0.1 only. */
export async function launchDedicatedBrowser(o: LaunchOpts): Promise<DedicatedBrowser> {
  const userDataDir = o.userDataDir ?? (await mkdtemp(join(tmpdir(), "bad-profile-")));
  const proc = spawn(chromiumPath(), chromeArgs({ ...o, userDataDir }), { stdio: "ignore", detached: false });
  let exited = false;
  proc.once("exit", () => { exited = true; });
  const cdpUrl = `http://127.0.0.1:${o.port}`;
  let version = "";
  for (let i = 0; i < 100 && !version; i++) {
    if (exited) throw new Error("BROWSER_EXITED_EARLY");
    try {
      const r = await fetch(`${cdpUrl}/json/version`);
      version = ((await r.json()) as { Browser: string }).Browser;
    } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  if (!version) { proc.kill("SIGKILL"); throw new Error("BROWSER_CDP_TIMEOUT"); }
  return {
    proc, port: o.port, cdpUrl, userDataDir, version,
    close: async () => {
      if (!exited) { proc.kill("SIGTERM"); await new Promise((r) => { proc.once("exit", r); setTimeout(r, 3000); }); if (!exited) proc.kill("SIGKILL"); }
      if (!o.userDataDir) await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
