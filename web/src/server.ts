import http from "node:http";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { clientIp } from "./limits.js";
import type { RunEvent, SubmitResult } from "./runs.js";

export interface RunService {
  presets(): { id: string; label: string; shows: string }[];
  submit(ip: string, body: { preset?: unknown; text?: unknown }): SubmitResult;
  subscribe(id: string, fn: (e: RunEvent) => void): (() => void) | null;
  has(id: string): boolean;
}

export interface WebServerOpts {
  service: RunService;
  publicDir: string;
  health: () => Record<string, unknown>;
  maxBodyBytes?: number;
}

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

/** The ONLY files ever served. Paths are matched exactly; nothing is resolved from the URL. */
const STATIC: Record<string, [file: string, type: string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/recorded/run.mp4": ["recorded/run.mp4", "video/mp4"],
};

const RUN_EVENTS = /^\/api\/runs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/events$/;

export function createWebServer(o: WebServerOpts): http.Server {
  const max = o.maxBodyBytes ?? 2048;

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { ...SECURITY_HEADERS, "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage): Promise<string | null> => new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] ?? 0) > max) { req.resume(); return resolve(null); }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => { size += c.length; if (size > max) over = true; else chunks.push(c); });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

  const sendStatic = async (req: http.IncomingMessage, res: http.ServerResponse, [file, type]: [string, string]) => {
    const full = join(o.publicDir, file);
    const st = await stat(full).catch(() => null);
    if (!st) return json(res, 404, { error: "NOT_FOUND" });
    const video = type === "video/mp4";
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (video && m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : st.size - Number(m[2]); // "bytes=-N" is the last N bytes
      let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start < 0) start = 0;
      if (start > end || start >= st.size) { res.writeHead(416, { ...SECURITY_HEADERS, "content-range": `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...SECURITY_HEADERS, "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": String(end - start + 1), "cache-control": "public, max-age=3600" });
      createReadStream(full, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": type, "content-length": String(st.size), ...(video ? { "accept-ranges": "bytes" } : {}), "cache-control": file.endsWith(".html") ? "no-store" : "public, max-age=300" });
    createReadStream(full).pipe(res);
  };

  const stream = (req: http.IncomingMessage, res: http.ServerResponse, id: string) => {
    if (!o.service.has(id)) return json(res, 404, { error: "NOT_FOUND" });
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    let ended = false;
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    let unsubscribe: (() => void) | null = null;
    const stop = () => { if (ended) return; ended = true; clearInterval(heartbeat); unsubscribe?.(); };
    req.on("close", stop); // the run continues; only this listener goes
    unsubscribe = o.service.subscribe(id, (e) => {
      if (ended) return;
      res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (e.type === "end") { stop(); res.end(); }
    });
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://local").pathname;
    if (req.method === "GET" && Object.hasOwn(STATIC, path)) return sendStatic(req, res, STATIC[path]);
    if (req.method === "GET" && path === "/api/health") return json(res, 200, o.health());
    if (req.method === "GET" && path === "/api/presets") return json(res, 200, o.service.presets());
    if (req.method === "POST" && path === "/api/runs") {
      const raw = await readBody(req);
      if (raw === null) return json(res, 413, { error: "TOO_LARGE" });
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: "BAD_JSON" }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "BAD_JSON" });
      const r = o.service.submit(clientIp(req.headers["x-forwarded-for"], req.socket.remoteAddress), body as { preset?: unknown; text?: unknown });
      if (r.ok) return json(res, 202, { run_id: r.runId, position: r.position });
      return json(res, r.status, { error: r.error, message: r.message, ...(r.retryAfterMin ? { retry_after_min: r.retryAfterMin } : {}) });
    }
    const m = RUN_EVENTS.exec(path);
    if (req.method === "GET" && m) return stream(req, res, m[1]);
    return json(res, 404, { error: "NOT_FOUND" });
  };

  return http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: "INTERNAL" });
      else res.destroy();
    });
  });
}
