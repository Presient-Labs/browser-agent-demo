import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { startWebApp, type WebApp } from "../web/src/app.js";

// The page is meant to be served at shawndemos.com/browser-agent/ with Traefik removing the prefix before the request
// reaches the app. This proxy does the same: /browser-agent/x reaches the app as /x, anything outside the prefix is 404.
const PREFIX = "/browser-agent";
let app: WebApp;
let proxy: Server;
let proxyPort = 0;
let viewer: Browser;
beforeAll(async () => {
  app = await startWebApp({
    port: 4300, host: "127.0.0.1", allowFake: true, noSandbox: process.env.NO_SANDBOX === "1",
    spendFile: join(mkdtempSync(join(tmpdir(), "web-prefix-")), "spend.json"),
    env: { ANTHROPIC_API_KEY: "", RETRY_BACKOFF_MS: "1" },
  });
  proxy = createServer((req, res) => {
    const url = req.url ?? "/";
    if (!url.startsWith(`${PREFIX}/`)) { res.writeHead(404).end(); return; }
    const upstream = request({ host: "127.0.0.1", port: app.port, path: url.slice(PREFIX.length), method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyPort = (proxy.address() as AddressInfo).port;
  viewer = await chromium.launch();
});
afterAll(async () => {
  await viewer?.close();
  await new Promise((r) => proxy?.close(r));
  await app?.close();
});

describe("served under /browser-agent/ behind a prefix-stripping proxy", () => {
  it("loads every file and runs a preset live without any request leaving the prefix", async () => {
    const page = await viewer.newPage();
    const failed: string[] = [];
    page.on("response", (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    page.on("requestfailed", (r) => failed.push(`failed ${new URL(r.url()).pathname}`));
    await page.goto(`http://127.0.0.1:${proxyPort}${PREFIX}/`);
    expect(await page.locator(".banner").first().textContent()).toContain("Synthetic data");
    await page.getByRole("button", { name: /Look up a claim/ }).click();
    await page.locator("#result").waitFor({ state: "visible", timeout: 60_000 });
    expect(await page.locator("#frame").getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
    expect(failed).toEqual([]);
    await page.close();
  });

  it("the recorded run video resolves under the prefix", async () => {
    const page = await viewer.newPage();
    await page.goto(`http://127.0.0.1:${proxyPort}${PREFIX}/`);
    const src = await page.locator("#recorded-video").evaluate((v) => (v as HTMLVideoElement).src);
    expect(new URL(src).pathname).toBe(`${PREFIX}/recorded/run.mp4`);
    const r = await fetch(src, { headers: { range: "bytes=0-99" } });
    expect(r.status).toBe(206);
    await page.close();
  });
});
