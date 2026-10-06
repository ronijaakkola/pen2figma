// Local bridge: the Figma plugin asks it for Pen frames; it reads them from the running Pen app.
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pen, activeFile, selectedIds } from "./pen.ts";
import { loadConfig } from "./config.ts";

const { port, key } = loadConfig();
const ICON_DIR = fileURLToPath(new URL("../node_modules/lucide-static/icons/", import.meta.url));
const SNAP_DIR = fileURLToPath(new URL("../snapshots/", import.meta.url));
const GET_OPTS = "{resolveVariables:true,resolveInstances:true,includePathGeometry:true}";
const pen = new Pen();

function printed(out: string): string {
  return out.split("## Print output\n")[1] ?? "";
}

async function readFrames(ids?: string[]) {
  const state = await pen.appState();
  const file = activeFile(state);
  if (!ids?.length) ids = selectedIds(state);
  if (!ids.length) throw new Error("Nothing selected in Pen");
  const warnings: string[] = [];
  let out: string;
  // One execute: the trees, then the resolved bounds of every node (Pen's layout is the source of truth for sizes).
  // A missing ID fails the whole execute, so drop it and retry.
  for (;;) {
    out = await pen.execute(file, `for (const id of ${JSON.stringify(ids)}) {
      const b = {}; Get(id, (n, c) => { b[n.id] = [c.bounds.x, c.bounds.y, c.bounds.width, c.bounds.height]; return undefined }, ${GET_OPTS});
      Print(JSON.stringify({id, tree: Get(id, ${GET_OPTS}), bounds: b}));
    }`).catch(e => e.message);
    const missing = out.match(/Can't find node '([^']+)'/)?.[1];
    if (!missing) break;
    warnings.push(`Pen node ${missing} not found`);
    ids = ids.filter(i => i !== missing);
    if (!ids.length) throw new Error(warnings.join(", "));
  }
  if (out.startsWith("### Failure")) throw new Error(out.slice(0, 500));
  const found = printed(out).split("\n").filter(l => l.trim()).map(l => JSON.parse(l));

  const icons: Record<string, string> = {};
  const images: Record<string, string> = {};
  const walk = (n: any) => {
    if (n.type === "icon" && n.icon) {
      const lib = n.library || "lucide";
      const k = `${lib}:${n.icon}`;
      const p = join(ICON_DIR, `${n.icon}.svg`);
      if (!(k in icons)) {
        if (lib === "lucide" && existsSync(p)) icons[k] = readFileSync(p, "utf8");
        else warnings.push(`Icon ${k} not available, placeholder used`);
        icons[k] ??= "";
      }
    }
    for (const f of [n.fill, n.stroke].flat()) {
      if (f?.type !== "image" || !f.url || f.url in images) continue;
      const p = resolve(dirname(file), f.url);
      if (existsSync(p)) images[f.url] = readFileSync(p).toString("base64");
      else warnings.push(`Image ${f.url} not found next to the .pen file`);
    }
    (n.children || []).forEach(walk);
  };
  found.forEach(f => walk(f.tree));
  return { file, frames: found, icons, images, warnings };
}

function body(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let s = "";
    req.on("data", c => (s += c));
    req.on("end", () => ok(s));
    req.on("error", fail);
  });
}

const handler = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  const url = new URL(req.url!, "http://x");
  if (url.searchParams.get("key") !== key) { res.writeHead(401).end(); return; }
  const send = (status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
  };
  try {
    if (url.pathname === "/health") {
      await pen.warm();
      send(200, { ok: true });
    } else if (url.pathname === "/frames") {
      const ids = url.searchParams.get("ids")?.split(/[\s,]+/).filter(Boolean);
      const t = Date.now();
      const r = await readFrames(ids);
      console.log(`frames ${r.frames.map(f => f.id).join(",")} read in ${Date.now() - t} ms`);
      send(200, r);
    } else if (url.pathname === "/snapshot" && req.method === "POST") {
      // Debug builds of the plugin post PNGs of finished copies here for visual comparison.
      const { name, png } = JSON.parse(await body(req));
      mkdirSync(SNAP_DIR, { recursive: true });
      writeFileSync(join(SNAP_DIR, `${name.replace(/[^\w-]/g, "_")}.figma.png`), Buffer.from(png, "base64"));
      send(200, { ok: true });
    } else send(404, { error: "not found" });
  } catch (e: any) {
    send(500, { error: e.message });
  }
};

// "localhost" may resolve to either loopback address, so listen on both (never on the network).
createServer(handler).listen(port, "127.0.0.1");
createServer(handler).listen(port, "::1", () => {
  console.log(`pen2figma bridge on http://localhost:${port}`);
  pen.warm().catch(e => console.error("Pen not reachable yet:", e.message));
});
