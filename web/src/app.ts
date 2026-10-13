import { startSite } from "../../site/src/server.js";
import { launchDedicatedBrowser, type DedicatedBrowser } from "../../backend/src/browser/launch.js";
import { BrowserBridge } from "../../backend/src/browser/bridge.js";
import { AuditStore } from "../../backend/src/audit.js";
import { loadConfig } from "../../backend/src/config.js";
import { resolveProviderAudited } from "../../backend/src/bootstrap.js";
import { log } from "../../backend/src/logger.js";
import { RateLimiter, SpendLedger } from "./limits.js";
import { RunManager } from "./runs.js";
import { createWebServer } from "./server.js";

export interface WebAppOpts {
  port: number;
  host?: string; // default 0.0.0.0 (inside the container; Traefik is the only way in)
  spendFile: string;
  allowFake: boolean;
  env?: Record<string, string | undefined>;
  noSandbox?: boolean;
}
export interface WebApp {
  port: number;
  manager: RunManager;
  health(): { browser: "up" | "down"; mode: "REAL" | "FAKE" | "NONE"; live: boolean };
  browser(): DedicatedBrowser | null;
  close(): Promise<void>;
}

export async function startWebApp(o: WebAppOpts): Promise<WebApp> {
  const env = o.env ?? process.env;
  const key = env.ANTHROPIC_API_KEY ?? "";
  const cfg = loadConfig({ ...env, PROVIDER: key ? "anthropic" : "fake", MAX_MODEL_CALLS: env.MAX_MODEL_CALLS || "8", WALL_TIME_MS: env.WALL_TIME_MS || "90000" });
  const audit = new AuditStore();
  const realProvider = key ? resolveProviderAudited(cfg, audit) : null;
  const sitePort = Number(new URL(cfg.siteOrigin).port);
  const site = await startSite({ port: sitePort, testEndpoints: false });
  const bridge = new BrowserBridge(cfg.siteOrigin, audit);

  let browser: DedicatedBrowser | null = null;
  let restarts = 0;
  let closing = false;
  const startBrowser = async (): Promise<void> => {
    const b = await launchDedicatedBrowser({ port: cfg.cdpPort, headless: true, noSandbox: o.noSandbox, allowLoopbackPorts: [sitePort] });
    browser = b;
    await bridge.connect(b.cdpUrl, { nonce: b.nonce, userDataDir: b.userDataDir, allowPorts: b.allowPorts });
    b.proc.once("exit", () => {
      if (closing) return;
      if (restarts++ < 1) { log("browser_restart", {}); void startBrowser().catch(() => log("browser_restart_failed", {})); }
      else log("browser_down", {});
    });
  };
  await startBrowser();

  const manager = new RunManager({
    cfg, bridge, audit, realProvider, allowFake: o.allowFake,
    spend: new SpendLedger(o.spendFile), limiter: new RateLimiter(), mutations: () => site.mutations(),
  });
  const health = () => ({
    browser: (bridge.connected ? "up" : "down") as "up" | "down",
    mode: (realProvider ? "REAL" : o.allowFake ? "FAKE" : "NONE") as "REAL" | "FAKE" | "NONE",
    live: manager.fallbackReason() === null,
  });
  const server = createWebServer({ service: manager, publicDir: new URL("../public", import.meta.url).pathname, health });
  await new Promise<void>((resolve) => server.listen(o.port, o.host ?? "0.0.0.0", () => resolve()));

  return {
    port: o.port,
    manager,
    health,
    browser: () => browser,
    close: async () => {
      closing = true;
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      try { await bridge.close(); } catch { /* already gone */ }
      await browser?.close();
      await site.close();
    },
  };
}
