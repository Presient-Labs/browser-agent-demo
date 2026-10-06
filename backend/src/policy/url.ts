export type PolicyCode =
  | "OK"
  | "MALFORMED_URL"
  | "BAD_SCHEME"
  | "USERINFO_FORBIDDEN"
  | "ORIGIN_NOT_ALLOWED"
  | "WRITE_METHOD"
  | "WRITE_ROUTE"
  | "ROUTE_NOT_ALLOWED"
  | "POPUP_NOT_ALLOWED" | "WEBSOCKET_NOT_ALLOWED" | "EXTRACTION_URL_CHANGED";

export interface Decision { allow: boolean; code: PolicyCode; category: "navigate" | "subresource" | "write" | "offsite" | "popup" }

/** Approved READ routes on the controlled synthetic site (route semantics, not HTTP-verb semantics). */
const READ_ROUTES: RegExp[] = [
  /^\/$/,
  /^\/search$/,
  /^\/records\/SYN-\d{4}$/,
  /^\/login-challenge$/,
  /^\/redirect-offsite$/, // fixtures used to prove redirect checks
  /^\/redirect-onsite$/,
  /^\/fixtures\/(popup|auto-write|offsite-subresource|websocket|iframe-login|pushstate|client-redirect|egress|flip-auth)$/,
];
const WRITE_ROUTE = /\/(update|submit|delete|save|send)(\/|$)|^\/api\/|^\/login-challenge\/submit$/;

/** Parses and validates a URL string against an exact scheme/host/port origin. Never throws. */
export function checkUrl(raw: string, allowedOrigin: string): { ok: true; url: URL } | { ok: false; code: PolicyCode } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048 || /[\s\\\u0000-\u001f]/.test(raw)) return { ok: false, code: "MALFORMED_URL" };
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, code: "MALFORMED_URL" }; }
  if (u.protocol !== "http:") return { ok: false, code: "BAD_SCHEME" };
  if (u.username || u.password) return { ok: false, code: "USERINFO_FORBIDDEN" };
  const a = new URL(allowedOrigin);
  const port = (x: URL) => x.port || (x.protocol === "https:" ? "443" : "80");
  if (u.hostname !== a.hostname || port(u) !== port(a) || u.protocol !== a.protocol) return { ok: false, code: "ORIGIN_NOT_ALLOWED" };
  return { ok: true, url: u };
}

export function classifyRequest(
  req: { url: string; method: string; isNavigation: boolean },
  allowedOrigin: string,
): Decision {
  const category = req.isNavigation ? "navigate" : "subresource";
  if (req.url === "about:blank") return { allow: true, code: "OK", category };
  const c = checkUrl(req.url, allowedOrigin);
  if (!c.ok) {
    const offsite = c.code === "ORIGIN_NOT_ALLOWED" || c.code === "USERINFO_FORBIDDEN";
    return { allow: false, code: c.code, category: offsite || c.code === "BAD_SCHEME" || c.code === "MALFORMED_URL" ? "offsite" : category };
  }
  const path = c.url.pathname;
  if (req.method.toUpperCase() !== "GET") return { allow: false, code: "WRITE_METHOD", category: "write" };
  if (WRITE_ROUTE.test(path)) return { allow: false, code: "WRITE_ROUTE", category: "write" };
  if (!READ_ROUTES.some((r) => r.test(path))) return { allow: false, code: "ROUTE_NOT_ALLOWED", category };
  return { allow: true, code: "OK", category };
}
