import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { startWebApp, type WebApp } from "../web/src/app.js";

let app: WebApp;
let viewer: Browser;
beforeAll(async () => {
  app = await startWebApp({
    port: 4300, host: "127.0.0.1", allowFake: true, noSandbox: process.env.NO_SANDBOX === "1",
    spendFile: join(mkdtempSync(join(tmpdir(), "web-e2e-")), "spend.json"),
    env: { ANTHROPIC_API_KEY: "", RETRY_BACKOFF_MS: "1" },
  });
  viewer = await chromium.launch();
});
afterAll(async () => { await viewer?.close(); await app?.close(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = async (page: import("playwright").Page, sel: string) => ((await page.locator(sel).first().textContent()) ?? "").trim();

describe("live demo page (FAKE model)", () => {
  it("on a phone, a preset runs live: a browser frame appears and the result is shown", async () => {
    const page = await viewer.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${app.port}/`);
    expect(await text(page, ".banner")).toBe("Synthetic data — not a real patient system");
    await page.getByRole("button", { name: /Look up a claim/ }).click();
    await page.locator("#result").waitFor({ state: "visible", timeout: 60_000 });
    expect(await page.locator("#frame").getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
    expect(await text(page, ".result-status")).toContain("Done");
    expect(await text(page, "#mode")).toContain("FAKE model");
    // No horizontal page scroll at phone width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.close();
  });

  it("the blocked-write preset shows the block, and the site change counter stays at 0", async () => {
    const page = await viewer.newPage();
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.getByRole("button", { name: /Try to submit a form/ }).click();
    await page.locator("#result").waitFor({ state: "visible", timeout: 60_000 });
    expect(await text(page, ".result-status")).toContain("Blocked");
    expect(await page.locator(".steps .blocked").count()).toBeGreaterThan(0);
    const rows = await page.locator("#result dl").evaluate((dl) => Object.fromEntries([...dl.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent])));
    expect(rows["Site change counter"]).toBe("0");
    await page.close();
  });

  it("a free-text task without a record id is refused on the page with a plain message", async () => {
    const page = await viewer.newPage();
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.fill("#free-text", "what is the balance");
    await page.click("#free button");
    await page.locator("#form-msg").waitFor({ state: "visible" });
    expect(await text(page, "#form-msg")).toBe("Name exactly one record ID, like SYN-1042.");
    await page.close();
  });

  it("restarts the browser once if it dies; after a second death it reports down and plays the recorded run", async () => {
    const first = app.browser();
    first!.proc.kill("SIGKILL");
    for (let i = 0; i < 80 && !(app.browser() !== first && app.health().browser === "up"); i++) await sleep(250);
    expect(app.browser()).not.toBe(first);
    expect(app.health().browser).toBe("up");
    app.browser()!.proc.kill("SIGKILL");
    for (let i = 0; i < 40 && app.health().browser !== "down"; i++) await sleep(250);
    expect(app.health()).toMatchObject({ browser: "down", live: false });
    const r = await fetch(`http://127.0.0.1:${app.port}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: "lookup" }) });
    const { run_id } = await r.json();
    const events = await (await fetch(`http://127.0.0.1:${app.port}/api/runs/${run_id}/events`)).text();
    expect(events).toContain('"reason":"browser_down"');
  });
});
