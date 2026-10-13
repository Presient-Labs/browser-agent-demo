import { startWebApp } from "./app.js";
import { log } from "../../backend/src/logger.js";

try { process.loadEnvFile(new URL("../../.env", import.meta.url).pathname); } catch { /* the container passes env directly */ }
const app = await startWebApp({
  port: Number(process.env.WEB_PORT ?? 4300),
  spendFile: process.env.SPEND_FILE ?? "/data/spend.json",
  allowFake: process.env.WEB_ALLOW_FAKE === "1",
  noSandbox: process.env.NO_SANDBOX === "1",
});
log("web_listening", { port: app.port, mode: app.health().mode });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { void app.close().finally(() => process.exit(0)); });
