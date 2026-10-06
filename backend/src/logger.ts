/** Safe logger: only fixed event names + safe codes. Never pass content. Sink is injectable so tests can scan it. */
export type LogSink = (line: string) => void;
let sink: LogSink = (l) => console.log(l);
export const setLogSink = (s: LogSink) => { sink = s; };
export function log(event: string, fields: Record<string, string | number | boolean> = {}) {
  const safe = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 64) : v}`).join(" ");
  sink(`${new Date().toISOString()} ${event}${safe ? " " + safe : ""}`);
}
