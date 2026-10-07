import http from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "./config.js";
import type { AuditStore } from "./audit.js";
import { TaskRunner, type TaskResult } from "./coordinator.js";
import { BrowserBridge } from "./browser/bridge.js";
import type { ModelProvider } from "./providers/types.js";
import { log } from "./logger.js";

export const UNSUPPORTED = [
  "write actions / approvals", "file downloads", "screenshots / vision", "resume after login (human_action_required is terminal)",
  "mid-task redirect", "persistence / crash recovery", "OpenAI provider (adapter is a stub)",
];

export interface BackendOpts {
  cfg: Config;
  provider: ModelProvider;
  audit: AuditStore;
  bridge: BrowserBridge;
  secret: string;
  cdpUrl: string;
  /** Resolves the launch-bound expectation (nonce + profile dir from the launcher handoff). Rejects => not connected. */
  expectBrowser: () => Promise<import("./browser/launch.js").DedicatedExpect>;
  allowedOrigins: string[]; // exact extension origins, e.g. chrome-extension://<id>
}

const eq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createBackend(o: BackendOpts) {
  const { cfg, audit } = o;
  const runner = new TaskRunner(cfg, o.provider, o.bridge, audit, (e) => broadcast({ type: "progress", task_id: e.task_id, text: e.text }));
  const socks = new Set<WebSocket>();
  let lastResult: TaskResult | undefined;
  const broadcast = (m: unknown) => { const s = JSON.stringify(m); socks.forEach((w) => w.readyState === 1 && w.send(s)); };
  audit.onEvent((ev) => broadcast({ type: "audit", event: ev }));

  const hostOk = (h: string | undefined) => !!h && (h === `127.0.0.1:${cfg.backendPort}` || h === `localhost:${cfg.backendPort}` || /^127\.0\.0\.1:\d+$/.test(h));
  // A missing Origin is NOT acceptable: only the approved extension origin may drive the API (the session secret alone is not enough).
  const originOk = (origin: string | undefined) => origin !== undefined && o.allowedOrigins.includes(origin);
  const status = () => ({
    mode: o.provider.mode, provider: o.provider.id, model: o.provider.model,
    running: runner.active, browser_connected: o.bridge.connected, synthetic_only: true,
    allowed_site: cfg.siteOrigin, unsupported: UNSUPPORTED,
    budgets: cfg.budgets, rates_usd_per_mtok: cfg.rates, cost_label: "estimate",
  });

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin as string | undefined;
    const reject = (code: number, error: string, cat: "api_auth" = "api_auth") => {
      audit.record({ task_id: "api", category: cat, outcome: "rejected", code: error });
      res.writeHead(code, { "content-type": "application/json", ...(origin && originOk(origin) ? corsHeaders(origin) : {}) });
      res.end(JSON.stringify({ error })); // generic, redacted
    };
    const corsHeaders = (org: string) => ({
      "access-control-allow-origin": org, "vary": "Origin",
      "access-control-allow-headers": "content-type, x-demo-session", "access-control-allow-methods": "GET, POST, OPTIONS",
    });
    if (!hostOk(req.headers.host)) return reject(403, "FORBIDDEN");
    if (!originOk(origin)) return reject(403, "FORBIDDEN");
    if (req.method === "OPTIONS") {
      if (origin === undefined) return reject(403, "FORBIDDEN");
      res.writeHead(204, corsHeaders(origin)); return res.end();
    }
    const sess = req.headers["x-demo-session"];
    if (typeof sess !== "string" || !eq(sess, o.secret)) return reject(401, "UNAUTHENTICATED");

    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...(origin ? corsHeaders(origin) : {}) });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/api/status") return json(200, status());
      if (req.method === "GET" && url.pathname === "/api/audit") return json(200, { events: audit.list(url.searchParams.get("task_id") ?? undefined) });
      if (req.method === "GET" && url.pathname === "/api/result") return json(200, { result: lastResult ?? null });

      if (req.method === "POST") {
        if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return reject(415, "UNSUPPORTED_MEDIA_TYPE");
        let body = ""; let size = 0;
        for await (const ch of req) { size += (ch as Buffer).length; if (size > 4096) return reject(413, "TOO_LARGE"); body += ch; }
        let parsed: any;
        try { parsed = JSON.parse(body || "{}"); } catch { return reject(400, "BAD_REQUEST"); }

        if (url.pathname === "/api/tasks") {
          if (typeof parsed.task !== "string" || parsed.task.trim().length === 0 || parsed.task.length > 500) return reject(400, "BAD_REQUEST");
          if (runner.active) return reject(409, "TASK_ALREADY_RUNNING");
          runner.active = true; // claim synchronously (before any await): no duplicate starts
          if (!o.bridge.connected) {
            try { await o.bridge.connect(o.cdpUrl, await o.expectBrowser()); } catch { runner.active = false; return reject(503, "BROWSER_NOT_CONNECTED"); }
          }
          const task_id = randomUUID();
          broadcast({ type: "state", state: { ...status(), running: true }, task_id });
          void runner.run(parsed.task.trim(), task_id).then((r) => {
            lastResult = r; broadcast({ type: "result", result: r }); broadcast({ type: "state", state: status() });
          }).catch(() => { log("task_crash"); runner.active = false; });
          return json(202, { task_id });
        }
        if (url.pathname === "/api/tasks/stop") { runner.stop(); return json(200, { stopping: runner.active }); }
      }
      return reject(404, "NOT_FOUND");
    } catch { return reject(500, "INTERNAL_ERROR"); }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin as string | undefined;
    if (req.url !== "/ws" || !hostOk(req.headers.host) || origin === undefined || !originOk(origin)) {
      audit.record({ task_id: "api", category: "api_auth", outcome: "rejected", code: "WS_FORBIDDEN" });
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let authed = false;
      const t = setTimeout(() => ws.close(4001, "auth timeout"), 5000);
      ws.on("message", (d) => {
        try {
          const m = JSON.parse(d.toString());
          if (!authed) {
            if (m?.type === "auth" && typeof m.secret === "string" && eq(m.secret, o.secret)) {
              authed = true; clearTimeout(t); socks.add(ws);
              ws.send(JSON.stringify({ type: "state", state: status() }));
              ws.send(JSON.stringify({ type: "audit_backlog", events: audit.list() }));
            } else { audit.record({ task_id: "api", category: "api_auth", outcome: "rejected", code: "WS_UNAUTHENTICATED" }); ws.close(4003, "unauthorized"); }
          }
        } catch { ws.close(4000, "bad"); }
      });
      ws.on("close", () => { socks.delete(ws); clearTimeout(t); });
    });
  });

  return {
    server, runner,
    listen: () => new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(cfg.backendPort, cfg.host, () => resolve((server.address() as any).port));
    }),
    close: () => new Promise<void>((r) => { wss.clients.forEach((c) => c.terminate()); server.closeAllConnections(); server.close(() => r()); }),
  };
}
