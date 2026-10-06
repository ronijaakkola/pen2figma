# pen2figma

Copies Pen.dev frames into Figma in about a second — no AI model involved. Select frames in Pen, click **Copy Pen selection** in the Figma plugin, and Figma copies appear next to whatever you have selected in Figma (or in the middle of the view).

How it works: a small background **bridge** on your Mac reads frames from the running Pen app, and a private **Figma plugin** fetches them over `localhost` and builds the nodes. See `CONTEXT.md` for terms and `docs/adr/` for why it's built this way.

## Requirements

- Apple Silicon Mac
- Pen.dev desktop app, with the file you copy from open
- Figma **desktop** app (development plugins don't run in the browser)
- Node.js 24+
- The fonts your designs use, installed locally (missing fonts fall back to Inter with a warning)

## Setup (once)

```sh
git clone <repo-url> ~/Projects/pen2figma
cd ~/Projects/pen2figma
npm install
npm run install-bridge
```

`install-bridge` generates your own secret key in `~/.pen2figma/config.json`, builds the plugin with it, and starts the bridge at login (log: `~/.pen2figma/bridge.log`).

Then in Figma desktop: **Plugins → Development → Import plugin from manifest…** → `~/Projects/pen2figma/plugin/manifest.json`.

## Use

1. Open the **pen2figma** plugin in Figma (it should say “Connected to Pen”). Keep it open.
2. Select one or more frames in Pen → click **Copy Pen selection**. Or type Pen IDs (e.g. `pO0Ah cdKeP`) and press Enter.
3. Each copy is a new Figma frame; earlier copies are never touched.

## Troubleshooting

- **“Bridge not running”** — `npm run install-bridge` again, check `~/.pen2figma/bridge.log`.
- **“Bridge rejected key”** — the plugin was built with a different key; run `npm run build` and reopen the plugin.
- **Uninstall** — `npm run uninstall-bridge`, then remove the plugin in Figma.
