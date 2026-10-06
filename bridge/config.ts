// Port + shared key, generated once and shared by the bridge and the plugin build.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".pen2figma");
const CONFIG = join(CONFIG_DIR, "config.json");

export function loadConfig(): { port: number; key: string } {
  if (!existsSync(CONFIG)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG, JSON.stringify({ port: 7741, key: randomBytes(24).toString("hex") }, null, 2), { mode: 0o600 });
  }
  return JSON.parse(readFileSync(CONFIG, "utf8"));
}
