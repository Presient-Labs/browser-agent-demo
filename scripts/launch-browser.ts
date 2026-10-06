// Launches the DEDICATED demo browser: Playwright's bundled Chromium (Chrome for Testing), disposable profile,
// CDP on 127.0.0.1 only, extension loaded via --load-extension. Needs a display (see launch-browser.sh for Xvfb).
import { existsSync } from "node:fs";
import { loadConfig } from "../backend/src/config.js";
import { launchDedicatedBrowser } from "../backend/src/browser/launch.js";

try { process.loadEnvFile(new URL("../.env", import.meta.url).pathname); } catch { /* optional */ }
const cfg = loadConfig();
if (!existsSync(cfg.extensionDir + "/manifest.json")) { console.error("Extension not built. Run: npm run build -w extension"); process.exit(1); }
const sitePort = Number(new URL(cfg.siteOrigin).port);
const b = await launchDedicatedBrowser({
  port: cfg.cdpPort, headless: process.env.HEADLESS === "1", extensionDir: cfg.extensionDir, noSandbox: process.env.NO_SANDBOX === "1",
  allowLoopbackPorts: [sitePort, cfg.backendPort],
});
console.log(`[browser] ${b.version}`);
console.log(`[browser] CDP (loopback only): ${b.cdpUrl}`);
console.log(`[browser] disposable profile (deleted on exit): ${b.userDataDir}`);
console.log(`[browser] extension: ${cfg.extensionDir}`);
// Every shutdown path (SIGINT/SIGTERM or Chromium closed by the user) goes through ONE awaited cleanup before exiting.
let stopping: Promise<void> | undefined;
const stop = () => (stopping ??= (async () => { try { await b.close(); } finally { process.exit(0); } })());
process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
b.proc.on("exit", () => { void stop(); });
