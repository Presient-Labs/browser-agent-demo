import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
const out = new URL("./dist/", import.meta.url).pathname;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({ entryPoints: ["src/background.ts", "src/sidepanel.ts"], outdir: out, bundle: true, format: "esm", target: "chrome114", logLevel: "warning" });
for (const f of ["manifest.json", "sidepanel.html", "sidepanel.css"]) await cp(f, out + f);
console.log("extension built ->", out);
