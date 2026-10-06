// Installs (or with --uninstall removes) the bridge as a LaunchAgent that starts at login, and builds the plugin.
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_DIR } from "../bridge/config.ts";

const LABEL = "com.pen2figma.bridge";
const plist = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const uid = process.getuid!();
const run = (cmd: string) => { try { execSync(cmd, { stdio: "ignore" }); } catch {} };

run(`launchctl bootout gui/${uid}/${LABEL}`);
if (process.argv.includes("--uninstall")) {
  rmSync(plist, { force: true });
  console.log("bridge uninstalled");
  process.exit(0);
}

execSync("node scripts/build.ts", { stdio: "inherit" });
const log = join(CONFIG_DIR, "bridge.log");
mkdirSync(join(homedir(), "Library/LaunchAgents"), { recursive: true });
writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${resolve("bridge/server.ts")}</string></array>
  <key>WorkingDirectory</key><string>${resolve(".")}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`);
execSync(`launchctl bootstrap gui/${uid} ${plist}`);
console.log(`bridge installed and running (log: ${log})`);
