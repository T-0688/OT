import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentEvent } from "../shared/types.js";

export type RemoteHooks = {
  sessions: () => { id: string; title: string; cwd: string; updatedAt?: string }[];
  open: (id: string) => Promise<{ ok: boolean; title?: string; error?: string }>;
  start: (cwd: string, agentId?: string) => Promise<{ ok: boolean; error?: string; sessionId?: string }>;
  /** 在后台池里新建会话（不切换桌面视图） */
  startBackground: (cwd: string, agentId?: string) => Promise<{ ok: boolean; error?: string; sessionId?: string }>;
  /** 给指定会话发消息（后台执行，不切视图） */
  promptSession: (id: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  prompt: (text: string, images?: { data: string; mimeType: string; name?: string }[]) => Promise<{ ok: boolean; error?: string }>;
  permission: (id: string, optionId: string) => void;
  cancel: () => void;
  snapshot: () => { id: string; title: string; cwd: string; status: string; agent: string; model: string };
  history: (id: string) => AgentEvent[];
  onClients?: (count: number) => void;
  onThinkingDone?: (text: string) => void;
};

type ChatLine = { role: "user" | "agent" | "tool" | "note"; text: string };

import PAGE from "./mobile-page.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export class RemoteServer {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private history: ChatLine[] = [];
  private clients = new Set<WebSocket>();
  private thinking = "";
  status = "idle";
  currentId = "";
  readonly token: string;

  constructor(
    private port: number,
    private hooks: RemoteHooks,
    token?: string,
  ) {
    this.token = token && token.length > 0 ? token : randomBytes(12).toString("hex");
  }

  get running(): boolean {
    return this.http !== null;
  }

  private push(line: ChatLine): void {
    this.history.push(line);
    if (this.history.length > 300) this.history.splice(0, this.history.length - 300);
  }

  broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState === 1) client.send(data);
    }
  }

  pushThinkingZh(text: string): void {
    if (text) this.broadcast({ t: "thinking_zh", text });
  }

  /** 把桌面侧的事件转成手机能看的内容 */
  ingest(event: AgentEvent): void {
    switch (event.t) {
      case "user": {
        const line = { role: "user" as const, text: event.text };
        this.push(line);
        this.broadcast({ t: "user", text: line.text });
        break;
      }
      case "text": {
        const last = this.history[this.history.length - 1];
        if (last && last.role === "agent") last.text += event.text;
        else this.push({ role: "agent", text: event.text });
        this.broadcast({ t: "text", text: event.text });
        break;
      }
      case "thinking": {
        if (!event.text) break;
        this.thinking += event.text;
        this.broadcast({ t: "thinking", text: event.text });
        break;
      }
      case "tool_start":
      case "tool_update": {
        const title = String((event as { title?: string }).title ?? "");
        if (title && event.t === "tool_start") {
          this.push({ role: "tool", text: title });
          this.broadcast({ t: "tool", title });
        }
        break;
      }
      case "permission":
        this.broadcast({
          t: "permission",
          id: event.id,
          title: event.title,
          options: event.options,
        });
        break;
      case "turn_end": {
        this.broadcast({ t: "turn_end" });
        this.status = "idle";
        const t = this.thinking.trim();
        this.thinking = "";
        if (t) this.hooks.onThinkingDone?.(t);
        break;
      }
        break;
      case "ready":
        this.history = [];
        this.status = "idle";
        this.currentId = event.sessionId;
        break;
      case "error":
        this.broadcast({ t: "note", text: `出错了：${event.message}` });
        break;
    }
  }

  async start(): Promise<{ url: string; token: string }> {
    if (this.http) return { url: this.url(), token: this.token };
    const server = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server, path: "/ws", perMessageDeflate: { threshold: 512 } });
    this.wss.on("connection", (socket, req) => this.handleWs(socket, req));
    await new Promise<void>((resolve) => {
      // 绑 0.0.0.0，手机在同一 Wi-Fi 下才能直连；失败再退回回环
      const fallback = () => {
        try {
          server.listen(this.port, "127.0.0.1", () => resolve());
        } catch {
          resolve();
        }
      };
      server.once("error", fallback);
      server.listen(this.port, "0.0.0.0", () => {
        server.removeListener("error", fallback);
        resolve();
      });
    });
    this.http = server;
    return { url: this.url(), token: this.token };
  }

  notify(title: string, body: string, sessionId?: string): void {
    const payload = JSON.stringify({ t: "notify", title, body, sessionId: sessionId ?? null });
    for (const client of this.clients) {
      try {
        client.send(payload);
      } catch {
        /* ignore */
      }
    }
  }
  async stop(): Promise<void> {
    for (const client of this.clients) client.close();
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
    const server = this.http;
    this.http = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private url(): string {
    return `http://127.0.0.1:${this.port}/?token=${this.token}`;
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
    if (parsed.pathname === "/manifest.webmanifest") {
      res.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          name: "OT",
          short_name: "OT",
          start_url: "/",
          scope: "/",
          display: "standalone",
          background_color: "#151517",
          theme_color: "#151517",
          icons: [
            { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
            { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
          ],
        }),
      );
      return;
    }
    if (parsed.pathname === "/icon-192.png" || parsed.pathname === "/icon-512.png") {
      const file = parsed.pathname === "/icon-192.png" ? "icon-192.png" : "icon-512.png";
      try {
        const buf = readFileSync(join(app.getAppPath(), "build", file));
        res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
        res.end(buf);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    if (parsed.pathname === "/api/sessions") {
      if (parsed.searchParams.get("token") !== this.token) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ sessions: this.hooks.sessions(), current: this.hooks.snapshot().title ? this.currentId : null }));
      return;
    }
    if (parsed.pathname === "/api/start" || parsed.pathname === "/api/send") {
      const tokenOk =
        parsed.searchParams.get("token") === this.token ||
        (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") === this.token;
      if (!tokenOk) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy();
      });
      req.on("end", () => {
        void (async () => {
          try {
            const data = JSON.parse(body || "{}");
            let result: { ok: boolean; error?: string; sessionId?: string };
            if (parsed.pathname === "/api/start") {
              result = await this.hooks.startBackground(String(data.cwd ?? ""), data.agentId);
            } else {
              const id = String(data.sessionId ?? "");
              if (!id) result = { ok: false, error: "缺少 sessionId" };
              else result = await this.hooks.promptSession(id, String(data.text ?? ""));
            }
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
            res.end(JSON.stringify(result));
          } catch (err: any) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
          }
        })();
      });
      return;
    }
    if (parsed.pathname === "/api/events") {
      if (parsed.searchParams.get("token") !== this.token) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const id = parsed.searchParams.get("sessionId") ?? "";
      const limit = Math.min(500, Number(parsed.searchParams.get("limit") ?? 80));
      const events = id ? this.hooks.history(id).slice(-limit) : [];
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ sessionId: id, events }));
      return;
    }
    if (parsed.pathname === "/setup.sh") {
      if (parsed.searchParams.get("token") !== this.token) {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        res.end("unauthorized");
        return;
      }
      try {
        const script = readFileSync(join(app.getAppPath(), "tools", "frps-setup.sh"));
        res.writeHead(200, { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" });
        res.end(script);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
      return;
    }
    if (parsed.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (parsed.searchParams.get("token") !== this.token) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("unauthorized");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(PAGE);
  }

  private handleWs(socket: WebSocket, req: IncomingMessage): void {
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
    if (parsed.searchParams.get("token") !== this.token) {
      socket.close();
      return;
    }
    this.clients.add(socket);
    this.hooks.onClients?.(this.clients.size);
    const snap = this.hooks.snapshot();
    socket.send(
      JSON.stringify({
        t: "hello",
        id: this.currentId,
        title: snap.title,
        cwd: snap.cwd,
        status: this.status === "running" ? "running" : "idle",
        history: this.history,
      }),
    );
    socket.on("close", () => {
      this.clients.delete(socket);
      this.hooks.onClients?.(this.clients.size);
    });
    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; text?: string; id?: string; optionId?: string; name?: string; data?: string; images?: { data: string; mimeType: string; name?: string }[] };
        if (msg.type === "file" && msg.id && msg.data) {
          try {
            const dir = join(tmpdir(), "ot-mobile");
            mkdirSync(dir, { recursive: true });
            const safeName = String(msg.name ?? "file").replace(/[^\w.\-]+/g, "_").slice(-80);
            const target = join(dir, `${Date.now()}-${safeName}`);
            writeFileSync(target, Buffer.from(String(msg.data), "base64"));
            socket.send(JSON.stringify({ t: "file_saved", id: msg.id, path: target }));
          } catch (err: any) {
            socket.send(JSON.stringify({ t: "note", text: `文件保存失败：${String(err?.message ?? err)}` }));
          }
        }
        if (msg.type === "prompt" && (msg as any).sessionId && msg.text) {
          void this.hooks.promptSession(String((msg as any).sessionId), String(msg.text));
        } else if (msg.type === "prompt" && (msg.text || (msg as any).images?.length)) {
          void this.hooks.prompt(String(msg.text ?? ""), (msg as any).images);
        }
        if (msg.type === "permission" && msg.id && msg.optionId) this.hooks.permission(msg.id, msg.optionId);
        if (msg.type === "cancel") this.hooks.cancel();
        if (msg.type === "ping") socket.send(JSON.stringify({ t: "pong" }));
        if (msg.type === "sessions") {
          socket.send(JSON.stringify({ t: "sessions", list: this.hooks.sessions(), current: this.currentId }));
        }
        if (msg.type === "start" && (msg as any).cwd) {
          void this.hooks.start(String((msg as any).cwd), (msg as any).agentId).then((r) => {
            socket.send(JSON.stringify({ t: "start_result", ...r }));
          });
        }
        if (msg.type === "open" && msg.id) {
          this.history = [];
          this.broadcast({ t: "reset" });
          void this.hooks.open(msg.id).then((r) => {
            if (r.ok) {
              this.currentId = msg.id!;
              this.history = [];
              for (const ev of this.hooks.history(msg.id)) {
                if (ev.t === "user") this.history.push({ role: "user", text: ev.text });
                else if (ev.t === "text") {
                  const last = this.history[this.history.length - 1];
                  if (last && last.role === "agent") last.text += ev.text;
                  else this.history.push({ role: "agent", text: ev.text });
                } else if (ev.t === "tool_start" || ev.t === "tool_update") {
                  const title = String((ev as { title?: string }).title ?? "");
                  if (title && ev.t === "tool_start") this.history.push({ role: "tool", text: title });
                }
              }
              this.broadcast({ t: "hello", id: msg.id, title: r.title ?? "", cwd: "", status: "idle", history: this.history });
            } else {
              this.broadcast({ t: "note", text: r.error ?? "切换失败" });
            }
          });
        }
      } catch {
        /* ignore */
      }
    });
  }
}

export function remotePageSize(): number {
  return esc(PAGE).length;
}



























