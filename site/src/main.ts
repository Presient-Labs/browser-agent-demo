import { startSite } from "./server.js";
const port = Number(process.env.SITE_PORT ?? 4100);
const h = await startSite({ port, testEndpoints: process.env.SITE_TEST_ENDPOINTS === "1" });
console.log(`[site] synthetic records site on http://127.0.0.1:${h.port} (SYNTHETIC - NOT REAL PATIENT DATA)`);
