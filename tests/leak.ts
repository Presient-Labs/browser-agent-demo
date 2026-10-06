import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALL_MARKERS } from "../site/src/data.js";

/** Returns marker IDs (M0, M1...) found. NEVER returns the marker text or surrounding content. */
export function scanText(text: string, markers: string[] = ALL_MARKERS): string[] {
  return markers.map((m, i) => (text.includes(m) ? `M${i}` : "")).filter(Boolean);
}
export function walk(dir: string, skip: (p: string) => boolean = () => false, out: string[] = []): string[] {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    if (skip(p)) continue;
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, skip, out); else if (st.size < 64 * 1024 * 1024) out.push(p);
  }
  return out;
}
/** Scans files (as latin1 so binary files work). Returns {file-relative-to-dir, markerIds}; never content. */
export function scanDir(dir: string, skip?: (p: string) => boolean) {
  const hits: { file: string; ids: string[] }[] = [];
  for (const f of walk(dir, skip)) {
    let t = ""; try { t = readFileSync(f, "latin1"); } catch { continue; }
    const ids = scanText(t);
    if (ids.length) hits.push({ file: f.slice(dir.length), ids });
  }
  return hits;
}
export const snapshot = (dir: string, skip: (p: string) => boolean) =>
  new Map(walk(dir, skip).map((f) => { const st = statSync(f); return [f, `${st.size}:${st.mtimeMs}`] as const; }));

/** Content-safe assertion: on failure only marker IDs are shown, never the text. */
import { expect } from "vitest";
export function expectNoMarkers(label: string, text: string) {
  const ids = scanText(text);
  expect(`${label}: ${ids.length ? "LEAK ids=" + ids.join(",") : "clean"}`).toBe(`${label}: clean`);
}

/** Content-safe presence checks: failures print only the label, never the text or the needle. */
export function expectHas(label: string, text: string, needle: string) { expect(`${label}: ${text.includes(needle) ? "present" : "ABSENT"}`).toBe(`${label}: present`); }
export function expectLacks(label: string, text: string, needle: string) { expect(`${label}: ${text.includes(needle) ? "PRESENT" : "absent"}`).toBe(`${label}: absent`); }
