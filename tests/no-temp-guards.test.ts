import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { walk } from "./leak.js";

describe("shipping hygiene", () => {
  it("no disabled-guard markers (TEMP:) anywhere under backend/src", () => {
    const root = new URL("../backend/src", import.meta.url).pathname;
    const bad = walk(root).filter((f) => /TEMP:/.test(readFileSync(f, "utf8")));
    expect(bad.map((f) => f.slice(root.length))).toEqual([]);
  });
});
