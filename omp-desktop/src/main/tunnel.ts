import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { get } from "node:https";
import { join } from "node:path";
import { app } from "electron";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

function findOnPath(name: string): string | null {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [name], {
      encoding: "utf8",
      windowsHide: true,
    });
    const first = out.split(/\\r?\\n/).map((l) => l.trim()).find(Boolean);
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

const TARGET = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
const MIRRORS = [
  TARGET,
  `https://ghproxy.net/${TARGET}`,
  `https://mirror.ghproxy.com/${TARGET}`,
  `https://gh-proxy.com/${TARGET}`,
];

const binPath = () => join(app.getPath("userData"), "bin", "cloudflared.exe");

function download(url: string, dest: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    get(url, { headers: { "user-agent": "omp-desktop" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        void download(res.headers.location, dest, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed: HTTP ${res.statusCode}`));
        return;
      }
      mkdirSync(join(dest, ".."), { recursive: true });
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve()));
      out.on("error", reject);
    }).on("error", reject);
  });
}

export class Tunnel {
  private proc: ChildProcessWithoutNullStreams | null = null;
  url: string | null = null;
  state: "stopped" | "starting" | "running" | "error" = "stopped";
  error: string | null = null;

  constructor(private onUpdate: (info: { state: Tunnel["state"]; url: string | null; error: string | null }) => void) {}

  private notify(): void {
    this.onUpdate({ state: this.state, url: this.url, error: this.error });
  }

  async ensureBinary(): Promise<string> {
    const bin = binPath();
    if (existsSync(bin)) return bin;
    const existing = findOnPath("cloudflared");
    if (existing) return existing;
    this.state = "starting";
    this.notify();
    let lastError: unknown = null;
    for (const url of MIRRORS) {
      try {
        await download(url, bin);
        if (existsSync(bin)) return bin;
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      `下载失败（${String((lastError as Error)?.message ?? lastError)}）。可以手动下载 cloudflared.exe 放到 ${bin}，或 winget install Cloudflare.cloudflared`,
    );
  }

  async start(port: number, opts?: { mode?: "quick" | "named" | "local"; token?: string; hostname?: string; name?: string }): Promise<void> {
    if (this.proc) return;
    this.state = "starting";
    this.error = null;
    this.url = null;
    this.notify();
    let bin: string;
    try {
      bin = await this.ensureBinary();
    } catch (err: any) {
      this.state = "error";
      this.error = `cloudflared 下载失败：${String(err?.message ?? err)}`;
      this.notify();
      return;
    }
    const named = opts?.mode === "named" && opts.token;
    const local = opts?.mode === "local" && opts.name;
    if ((named || local) && opts?.hostname) this.url = `https://${opts.hostname.replace(/^https?:\/\//, "")}`;
    let args: string[];
    if (named) {
      args = ["tunnel", "--no-autoupdate", "--protocol", "http2", "--edge-ip-version", "4", "run", "--token", opts!.token!];
    } else if (local) {
      const config = join(homedir(), ".cloudflared", "config.yml");
      args = existsSync(config)
        ? ["tunnel", "--no-autoupdate", "--protocol", "http2", "--edge-ip-version", "4", "--config", config, "run", opts!.name!]
        : ["tunnel", "--no-autoupdate", "--protocol", "http2", "--edge-ip-version", "4", "run", opts!.name!];
    } else {
      args = ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"];
    }
    const proc = spawn(bin, args, { windowsHide: true });
    this.proc = proc;

    const scan = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (named || local) {
        if (/Registered tunnel connection|Connection .* registered/i.test(text)) {
          this.state = "running";
          this.error = null;
          this.notify();
        }
        const err = /ERR (.*)/.exec(text);
        if (err) {
          this.error = err[1].trim().slice(0, 200);
          this.notify();
        }
        return;
      }
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
      if (match && match[0] !== this.url) {
        this.url = match[0];
        this.state = "running";
        this.notify();
      }
    };
    proc.stdout.on("data", scan);
    proc.stderr.on("data", scan);
    proc.on("exit", (code) => {
      this.proc = null;
      if (this.state !== "stopped") {
        this.state = "error";
        this.error = `cloudflared 退出（code ${code}）`;
        this.notify();
      }
    });
    proc.on("error", (err) => {
      this.state = "error";
      this.error = String(err.message);
      this.notify();
    });
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
    this.url = null;
    this.state = "stopped";
    this.error = null;
    this.notify();
  }
}







