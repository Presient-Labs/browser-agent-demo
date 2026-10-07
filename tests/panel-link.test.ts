import { describe, it, expect } from "vitest";
import { safeSourceLink } from "../extension/src/links.js";

const SITE = "http://127.0.0.1:4100";
describe("N4: the panel only links read-route source URLs on the allowed site", () => {
  it.each([[`${SITE}/records/SYN-1042`], [`${SITE}/search?q=SYN-1042`]])("links %s", (u) => { expect(safeSourceLink(u, SITE)).toBe(u); });
  it.each([
    [`${SITE}/records/SYN-1042/delete`], [`${SITE}/records/SYN-1042/submit`], [`${SITE}/records/SYN-1042/update`], [`${SITE}/api/mutate`],
    ["http://127.0.0.1:4101/records/SYN-1042"], ["javascript:alert(1)"], [`${SITE}/__test/mutations`], [`${SITE}/records/SYN-1042#x`], [""], ["not a url"],
  ])("does NOT link %s", (u) => { expect(safeSourceLink(u, SITE)).toBe(null); });
});
