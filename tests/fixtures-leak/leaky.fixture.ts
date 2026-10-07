import { it, expect } from "vitest";
import { ALL_MARKERS } from "../../site/src/data.js";
// Deliberately content-bearing failure + stdout line: used ONLY by tests/leakwrap.test.ts to prove the wrapper never persists them.
it("prints a marker to stdout", () => { console.log("planted " + ALL_MARKERS[0]); });
it("fails with a marker in the assertion message", () => { expect(ALL_MARKERS[1]).toBe("something else"); });
