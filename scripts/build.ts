// Builds the Figma plugin into plugin/dist, baking in the bridge port + key. PEN2FIGMA_DEBUG=1 adds PNG snapshots.
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadConfig } from "../bridge/config.ts";

const { port, key } = loadConfig();
const debug = process.env.PEN2FIGMA_DEBUG === "1";
mkdirSync("plugin/dist", { recursive: true });
await build({ entryPoints: ["plugin/code.ts"], bundle: true, outfile: "plugin/dist/code.js", target: "es2017", define: { DEBUG: String(debug) } });
const ui = readFileSync("plugin/ui.html", "utf8").replace("__PORT__", String(port)).replace("__KEY__", key).replace("__DEBUG__", String(debug));
writeFileSync("plugin/dist/ui.html", ui);
const manifest = JSON.parse(readFileSync("plugin/manifest.json", "utf8"));
if (manifest.networkAccess.devAllowedDomains[0] !== `http://localhost:${port}`) console.warn(`plugin/manifest.json devAllowedDomains must be http://localhost:${port}`);
console.log(`plugin built${debug ? " (debug)" : ""} → plugin/manifest.json`);
