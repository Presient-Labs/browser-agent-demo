import net from "node:net";
import http from "node:http";
import { startSite, type SiteHandle } from "../site/src/server.js";
import { launchDedicatedBrowser, type DedicatedBrowser } from "../backend/src/browser/launch.js";
import { BrowserBridge } from "../backend/src/browser/bridge.js";
import { AuditStore } from "../backend/src/audit.js";
import { loadConfig, type Config } from "../backend/src/config.js";
import { TaskRunner, type TaskResult } from "../backend/src/coordinator.js";
import { FakeProvider, type FakeScript } from "../backend/src/providers/fake.js";
import type { ModelProvider } from "../backend/src/providers/types.js";
import { setLogSink } from "../backend/src/logger.js";

export const SITE = "http://127.0.0.1:4100";
export const EVIL = "http://127.0.0.1:4101";
export const CDP_PORT = 9333;

export interface Evil { hits: () => string[]; close: () => Promise<void> }
export function startEvil(): Promise<Evil> {
  const hits: string[] = [];
  const s = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(200, { "content-type": "text/html" }); res.end("<h1>EVIL</h1>"); });
  return new Promise((resolve, reject) => {
    s.once("error", reject);
    s.listen(4101, "127.0.0.1", () => resolve({ hits: () => [...hits], close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }) }));
  });
}

/** Records every outbound socket connect made by this Node process. */
export function installNetGuard() {
  const orig = net.Socket.prototype.connect;
  const attempts: string[] = [];
  (net.Socket.prototype as any).connect = function (...args: any[]) {
    let a = args[0];
    if (Array.isArray(a)) a = a[0]; // Node passes normalized [options, cb]
    if (a && typeof a === "object") attempts.push(`${a.host ?? a.path ?? "?"}:${a.port ?? ""}`);
    else if (typeof a === "number") attempts.push(`${args[1] ?? "localhost"}:${a}`);
    return (orig as any).apply(this, args);
  };
  return { attempts, restore: () => { net.Socket.prototype.connect = orig; } };
}

export interface Stack {
  site: SiteHandle; evil: Evil; browser: DedicatedBrowser; bridge: BrowserBridge; audit: AuditStore;
  cfg: Config; logs: string[]; progress: string[];
  runner: (p: ModelProvider) => TaskRunner;
  run: (task: string, script?: FakeScript | ModelProvider) => Promise<TaskResult>;
  close: () => Promise<void>;
}

export async function startStack(cfgOverride: Record<string, string> = {}, browserOpts: { headed?: boolean; extensionDir?: string } = {}): Promise<Stack> {
  const site = await startSite({ port: 4100, testEndpoints: true });
  const evil = await startEvil();
  const noSandbox = process.env.NO_SANDBOX === "1";
  const browser = await launchDedicatedBrowser({ port: CDP_PORT, headless: !browserOpts.headed, noSandbox, extensionDir: browserOpts.extensionDir });
  const audit = new AuditStore();
  const cfg = loadConfig({ RETRY_BACKOFF_MS: "1", ...cfgOverride });
  const logs: string[] = [];
  const progress: string[] = [];
  setLogSink((l) => logs.push(l));
  const bridge = new BrowserBridge(cfg.siteOrigin, audit);
  await bridge.connect(browser.cdpUrl);
  const stack: Stack = {
    site, evil, browser, bridge, audit, cfg, logs, progress,
    runner: (p) => new TaskRunner(cfg, p, bridge, audit, (e) => progress.push(e.text)),
    run: async (task, s = "happy") => {
      const p = typeof s === "string" ? new FakeProvider(s) : s;
      return new TaskRunner(cfg, p, bridge, audit, (e) => progress.push(e.text)).run(task);
    },
    close: async () => { try { await bridge.close(); } catch {} await browser.close(); await evil.close(); await site.close(); },
  };
  return stack;
}

export const siteCounter = async () => ((await (await fetch(`${SITE}/__test/mutations`)).json()) as { mutations: number }).mutations;

import type { ProviderRequest, ProviderResponse, Msg } from "../backend/src/providers/types.js";
/** Provider that replays a fixed list of tool calls, then gives up (uncertain finish). */
export class ScriptedProvider implements ModelProvider {
  readonly id = "fake"; readonly mode = "FAKE" as const; readonly model = "scripted";
  calls = 0; seen: Msg[][] = [];
  constructor(private steps: { name: string; input: unknown }[], public onCall?: (n: number) => void | Promise<void>) {}
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls++; this.seen.push(JSON.parse(JSON.stringify(req.messages)));
    await this.onCall?.(this.calls);
    const s = this.steps[this.calls - 1] ?? { name: "finish", input: { status: "uncertain", record_id: "SYN-1042", fields: {} } };
    return { toolCalls: [{ id: `s${this.calls}`, name: s.name, input: s.input }], usage: { inputTokens: 100, outputTokens: 10 } };
  }
}
/** Wraps any provider and records everything the model is sent (to prove what did / did not reach it). */
export class RecordingProvider implements ModelProvider {
  sent: string[] = [];
  constructor(private inner: ModelProvider) {}
  get id() { return this.inner.id; } get mode() { return this.inner.mode; } get model() { return this.inner.model; }
  async complete(req: ProviderRequest) { this.sent.push(JSON.stringify(req.messages)); return this.inner.complete(req); }
}
