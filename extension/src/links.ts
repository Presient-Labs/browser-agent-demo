/**
 * The panel renders a source URL as a clickable link ONLY if it is a plain read route on the allowed site.
 * Anything else (write routes, other origins, fragments, test endpoints, non-http schemes) is shown as inert text.
 */
export function safeSourceLink(raw: string, allowedSite: string): string | null {
  try {
    const u = new URL(raw); const a = new URL(allowedSite);
    if (u.protocol !== "http:" || u.origin !== a.origin || u.username || u.password || u.hash) return null;
    const read = /^\/records\/SYN-\d{4}$/.test(u.pathname) || (u.pathname === "/search" && /^\?q=SYN-\d{4}$/.test(u.search));
    return read && u.href === raw ? raw : null;
  } catch { return null; }
}
