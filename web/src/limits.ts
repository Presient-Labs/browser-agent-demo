import { readFileSync, writeFileSync, renameSync } from "node:fs";

/** Per-key rolling-window counter (the key is the client IP). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private limit = 5, private windowMs = 3_600_000, private now: () => number = Date.now) {}

  /** Records the hit and returns null, or returns the whole minutes (>= 1) until a slot frees. */
  take(key: string): number | null {
    const t = this.now();
    const live = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (live.length >= this.limit) {
      this.hits.set(key, live);
      return Math.max(1, Math.ceil((live[0] + this.windowMs - t) / 60_000));
    }
    live.push(t);
    this.hits.set(key, live);
    return null;
  }
}

interface SpendState { day: string; usd: number }

/** Daily model spend (UTC day), kept in a small JSON file so a restart does not reset it. */
export class SpendLedger {
  private state: SpendState;
  constructor(private file: string, private capUsd = 3, private reserveUsd = 0.15, private now: () => Date = () => new Date()) {
    this.state = this.load();
  }

  private today() { return this.now().toISOString().slice(0, 10); }

  private load(): SpendState {
    let raw: string;
    try { raw = readFileSync(this.file, "utf8"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { day: this.today(), usd: 0 }; // missing: a fresh day
      return { day: this.today(), usd: this.capUsd }; // unreadable (EACCES, EISDIR, ...): fail closed for today
    }
    try {
      const j = JSON.parse(raw) as Partial<SpendState>;
      if (typeof j.day === "string" && typeof j.usd === "number" && Number.isFinite(j.usd) && j.usd >= 0) return { day: j.day, usd: j.usd };
    } catch { /* corrupt: fall through */ }
    return { day: this.today(), usd: this.capUsd }; // unreadable: fail closed for today
  }

  private roll() { if (this.state.day !== this.today()) this.state = { day: this.today(), usd: 0 }; }

  spentToday(): number { this.roll(); return this.state.usd; }

  /** A run may start only if even its maximum cost cannot take the day over the cap. */
  canStart(): boolean { return this.spentToday() < this.capUsd - this.reserveUsd; }

  add(usd: number): void {
    this.roll();
    if (Number.isFinite(usd) && usd > 0) this.state.usd += usd;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }
}

/** Traefik appends the connecting client's address as the LAST X-Forwarded-For entry; earlier entries are client-supplied. */
export function clientIp(xff: string | string[] | undefined, remote: string | undefined): string {
  const header = Array.isArray(xff) ? xff.join(",") : xff ?? "";
  const last = header.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return (last || remote || "unknown").replace(/^::ffff:/, "");
}
