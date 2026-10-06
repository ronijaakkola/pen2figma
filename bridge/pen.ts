// Client for Pen's own MCP server binary (stdio JSON-RPC). It forwards calls to the running Pen app.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

const BIN = "/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class Pen {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private ready: Promise<void> | null = null;

  private start(): Promise<void> {
    const proc = spawn(BIN, ["--app", "desktop", "--agent", "pen2figma"]);
    this.proc = proc;
    createInterface({ input: proc.stdout }).on("line", line => {
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
    proc.stderr.resume();
    proc.on("exit", () => {
      for (const p of this.pending.values()) p.reject(new Error("Pen MCP server exited"));
      this.pending.clear();
      this.proc = null;
      this.ready = null;
    });
    return (async () => {
      await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pen2figma", version: "1" } });
      this.notify("notifications/initialized");
      // The server needs a moment to hand-shake with the app; calls sent too early hang for ~60 s.
      for (let i = 0; ; i++) {
        try { await this.rpc("tools/call", { name: "get_app_state", arguments: {} }, 1000); return; }
        catch (e) { if (i > 40) throw e; await new Promise(r => setTimeout(r, 250)); }
      }
    })();
  }

  private rpc(method: string, params: unknown, timeoutMs = 30000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pen ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      this.proc!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private notify(method: string) {
    this.proc!.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  private async call(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.ready) this.ready = this.start();
    try { await this.ready; } catch (e) { this.proc?.kill(); throw e; }
    const r = await this.rpc("tools/call", { name, arguments: args });
    const text = (r.content || []).map((c: any) => c.text || "").join("\n");
    if (r.isError) throw new Error(text);
    return text;
  }

  appState(): Promise<string> {
    return this.call("get_app_state", {});
  }

  execute(filePath: string, input: string): Promise<string> {
    return this.call("execute", { filePath, input });
  }

  warm() {
    if (!this.ready) this.ready = this.start();
    return this.ready;
  }
}

export function activeFile(state: string): string {
  const m = state.match(/Currently active canvas editor: `([^`]+)`/);
  if (!m) throw new Error("No active Pen canvas");
  return m[1];
}

export function selectedIds(state: string): string[] {
  const line = state.split("\n").find(l => l.includes("Selected nodes:")) ?? "";
  return [...line.matchAll(/`([^`]+)`/g)].map(m => m[1]);
}
