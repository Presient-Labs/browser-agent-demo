import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RateLimiter, SpendLedger, clientIp } from "../web/src/limits.js";

describe("RateLimiter", () => {
  it("allows 5 hits per rolling hour per key, then says how many minutes are left", () => {
    let t = 0;
    const rl = new RateLimiter(5, 3_600_000, () => t);
    for (let i = 0; i < 5; i++) expect(rl.take("1.2.3.4")).toBeNull();
    expect(rl.take("1.2.3.4")).toBe(60);
    expect(rl.take("5.6.7.8")).toBeNull(); // keys are independent
    t = 30 * 60_000;
    expect(rl.take("1.2.3.4")).toBe(30);
    t = 3_600_000; // the first hit leaves the window
    expect(rl.take("1.2.3.4")).toBeNull();
  });
});

describe("SpendLedger", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "web-spend-"));
  const day = (iso: string) => () => new Date(iso);

  it("starts a run only while spend is below the cap minus the per-run reserve", () => {
    const f = join(dir(), "spend.json");
    const s = new SpendLedger(f, 3, 0.15, day("2026-10-13T10:00:00Z"));
    expect(s.spentToday()).toBe(0);
    expect(s.canStart()).toBe(true);
    s.add(2.84);
    expect(s.canStart()).toBe(true);
    s.add(0.02);
    expect(s.canStart()).toBe(false); // 2.86 is not below 2.85
  });

  it("persists across a restart and resets on a new UTC day", () => {
    const f = join(dir(), "spend.json");
    new SpendLedger(f, 3, 0.15, day("2026-10-13T23:00:00Z")).add(1.5);
    expect(new SpendLedger(f, 3, 0.15, day("2026-10-13T23:59:00Z")).spentToday()).toBeCloseTo(1.5);
    expect(new SpendLedger(f, 3, 0.15, day("2026-10-14T00:01:00Z")).spentToday()).toBe(0);
  });

  it("a corrupt spend file fails closed: the day counts as fully spent", () => {
    const f = join(dir(), "spend.json");
    writeFileSync(f, "{not json");
    const s = new SpendLedger(f, 3, 0.15, day("2026-10-13T10:00:00Z"));
    expect(s.canStart()).toBe(false);
  });

  it("an unreadable spend file (not just a corrupt one) fails closed; only a missing file means $0", () => {
    const d = dir();
    const asDir = join(d, "spend.json");
    mkdirSync(asDir); // readFileSync throws EISDIR, as it would throw EACCES without read permission
    expect(new SpendLedger(asDir, 3, 0.15, day("2026-10-13T10:00:00Z")).canStart()).toBe(false);
    expect(new SpendLedger(join(d, "absent.json"), 3, 0.15, day("2026-10-13T10:00:00Z")).canStart()).toBe(true);
  });

  it("ignores negative or non-numeric costs and writes the file atomically", () => {
    const f = join(dir(), "spend.json");
    const s = new SpendLedger(f, 3, 0.15, day("2026-10-13T10:00:00Z"));
    s.add(-5); s.add(Number.NaN); s.add(0.25);
    expect(s.spentToday()).toBeCloseTo(0.25);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ day: "2026-10-13", usd: 0.25 });
    expect(existsSync(`${f}.tmp`)).toBe(false);
  });
});

describe("clientIp", () => {
  it("only the last forwarded hop counts, because Traefik appends the real client", () => {
    expect(clientIp("6.6.6.6, 203.0.113.9", "172.18.0.2")).toBe("203.0.113.9");
    expect(clientIp(["6.6.6.6", "203.0.113.9"], "172.18.0.2")).toBe("203.0.113.9");
  });
  it("falls back to the socket address, without the IPv4-mapped prefix", () => {
    expect(clientIp(undefined, "::ffff:10.0.0.7")).toBe("10.0.0.7");
    expect(clientIp("", undefined)).toBe("unknown");
  });
});
