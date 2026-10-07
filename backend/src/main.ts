import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { AuditStore } from "./audit.js";
import { BrowserBridge } from "./browser/bridge.js";
import { createBackend } from "./server.js";
import { resolveProviderAudited } from "./bootstrap.js";
import { FakeProvider, type FakeScript } from "./providers/fake.js";
import { extensionIdFromManifest } from "./extension-id.js";
import { log } from "./logger.js";
import { readHandoff } from "./browser/launch.js";

try { process.loadEnvFile(new URL("../../.env", import.meta.url).pathname); } catch { /* no .env: fine */ }
const cfg = loadConfig();
const audit = new AuditStore();
const provider = resolveProviderAudited(cfg, audit, {
  fakeFactory: () => new FakeProvider((process.env.FAKE_SCRIPT as FakeScript) || "happy"),
});
const manifestPath = new URL("../../extension/manifest.json", import.meta.url).pathname;
const extId = extensionIdFromManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
const secret = randomBytes(24).toString("base64url");
const bridge = new BrowserBridge(cfg.siteOrigin, audit);
const backend = createBackend({
  cfg, provider, audit, bridge, secret,
  cdpUrl: `http://127.0.0.1:${cfg.cdpPort}`,
  expectBrowser: () => readHandoff(cfg.cdpPort, [Number(new URL(cfg.siteOrigin).port), cfg.backendPort]),
  allowedOrigins: [`chrome-extension://${extId}`],
});
const port = await backend.listen();
log("backend_listening", { host: cfg.host, port });
// The secret is printed ONCE, to the operator's terminal only (not via the logger).
console.log("\n=======================================================");
console.log(` MODE: ${provider.mode}  provider=${provider.id}  model=${provider.model}`);
console.log(` Session secret (paste into the side panel): ${secret}`);
console.log("=======================================================\n");
