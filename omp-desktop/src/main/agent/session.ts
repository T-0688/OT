import { spawn, type ChildProcess } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentEvent, ConfigOption, ImagePart, PermissionChoice, ToolDiff } from "../../shared/types.js";
import type { AgentDef } from "../agents.js";

type Emit = (event: AgentEvent) => void;

/**
 * 一个 agent 子进程 = 一个会话。
 * 这里是全项目唯一"认识某个 agent"的地方：负责 spawn，以及把 ACP 的 update 翻译成 AgentEvent。
 * 换 agent 到 M5 之后只需要改 agents.ts 里的启动命令。
 */
export class AgentSession {
  private child: ChildProcess | null = null;
  private ctx: any = null;
  private sessionId: string | null = null;
  private pendingPermissions = new Map<string, (result: any) => void>();
  private closeConnection: (() => void) | null = null;
  private loadingHistory = false;
  private autoApprove = false;
  private onReady: ((id: string) => void) | null = null;
  private onError: ((err: unknown) => void) | null = null;

  private extraArgs: string[] = [];

  setExtraArgs(args: string[]): void {
    this.extraArgs = args;
  }

  constructor(
    private readonly agent: AgentDef,
    private readonly emit: Emit,
    private readonly options: { autoApprove?: boolean } = {},
  ) {}

  get agentId(): string {
    return this.agent.id;
  }

  async start(cwd: string): Promise<string> {
    return this.begin(cwd);
  }

  async resume(sessionId: string, cwd: string): Promise<string> {
    return this.begin(cwd, sessionId);
  }

  private begin(cwd: string, resumeId?: string): Promise<string> {
    const ready = new Promise<string>((resolve, reject) => {
      this.onReady = resolve;
      this.onError = reject;
    });
    void this.run(cwd, resumeId).catch((err) => {
      const message = String(err?.message ?? err);
      this.emit({ t: "error", message });
      this.onError?.(err);
    });
    return ready;
  }

  private async run(cwd: string, resumeId?: string): Promise<void> {
    const child = spawn(this.agent.command, [...this.agent.args, ...this.extraArgs], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      windowsHide: true,
    });
    this.child = child;

    child.on("error", (err) => {
      this.emit({ t: "error", message: `无法启动 ${this.agent.command}：${err.message}` });
      this.onError?.(err);
      this.closeConnection?.();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.emit({ t: "log", text });
    });

    child.on("exit", (code) => {
      this.emit({ t: "agent_exit", code });
      this.closeConnection?.();
      for (const [, resolve] of this.pendingPermissions) resolve({ outcome: { outcome: "cancelled" } });
      this.pendingPermissions.clear();
    });

    const output = new WritableStream<Uint8Array>({
      write: (chunk) => {
        child.stdin?.write(Buffer.from(chunk));
      },
    });
    const input = new ReadableStream<Uint8Array>({
      start: (controller) => {
        child.stdout?.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
        child.on("close", () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
    });

    const stream = acp.ndJsonStream(output, input);

    const app = acp
      .client({ name: "omp-desktop" })
      .onNotification("session/update", ({ params }: any) => this.handleUpdate(params))
      .onRequest("session/request_permission", async ({ params }: any) => this.handlePermission(params))
      .onRequest("fs/read_text_file", async ({ params }: any) => {
        throw new Error(`fs/read_text_file not implemented: ${params?.path}`);
      })
      .onRequest("fs/write_text_file", async ({ params }: any) => {
        throw new Error(`fs/write_text_file not implemented: ${params?.path}`);
      });

    await app.connectWith(stream, async (ctx: any) => {
      this.ctx = ctx;
      const init = await ctx.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "omp-desktop", version: "0.1.0" },
      });
      this.emit({
        t: "log",
        text: `${this.agent.name}: ACP v${init.protocolVersion} · loadSession=${init.agentCapabilities?.loadSession ?? false}`,
      });

      let payload: any;
      if (resumeId) {
        // agent 会用 session/update 重放历史；我们已经从 JSONL 渲染了，先吞掉
        this.loadingHistory = true;
        try {
          payload = await ctx.request("session/load", { sessionId: resumeId, cwd, mcpServers: [] });
        } finally {
          this.loadingHistory = false;
        }
        this.sessionId = resumeId;
      } else {
        payload = await ctx.request("session/new", { cwd, mcpServers: [] });
        this.sessionId = payload.sessionId;
      }

      const configOptions: ConfigOption[] = (payload?.configOptions ?? []).map((o: any) => ({
        id: o.id,
        name: o.name,
        category: o.category ?? null,
        type: o.type,
        currentValue: o.currentValue ?? null,
        options: (o.options ?? []).map((c: any) => ({ value: c.value, name: c.name, description: c.description })),
      }));

      this.emit({
        t: "ready",
        sessionId: this.sessionId!,
        cwd,
        agentId: this.agent.id,
        configOptions,
      });
      this.onReady?.(this.sessionId!);

      await new Promise<void>((resolve) => {
        this.closeConnection = resolve;
      });
    });
  }

  private handleUpdate(params: any): void {
    if (this.loadingHistory) return;
    const update = params?.update;
    if (!update) return;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textOf(update.content);
        if (text) this.emit({ t: "text", text });
        break;
      }
      case "agent_thought_chunk": {
        const text = textOf(update.content);
        if (text) this.emit({ t: "thinking", text });
        break;
      }
      case "user_message_chunk":
        break;
      case "tool_call":
        this.emit({
          t: "tool_start",
          id: update.toolCallId,
          title: update.title ?? "tool",
          toolKind: update.kind ?? undefined,
          status: update.status ?? undefined,
          input: update.rawInput ?? undefined,
        });
        break;
      case "tool_call_update":
        this.emit({
          t: "tool_update",
          id: update.toolCallId,
          title: update.title ?? undefined,
          status: update.status ?? undefined,
          text: collectText(update.content),
          diff: collectDiff(update.content),
        });
        break;
      case "usage_update":
        this.emit({ t: "usage", used: update.used, size: update.size, costUsd: update.cost?.amount });
        break;
      case "available_commands_update":
      case "session_info_update":
      case "current_mode_update":
        break;
      default:
        this.emit({ t: "log", text: `[update] ${update.sessionUpdate}` });
        break;
    }
  }

  private async handlePermission(params: any): Promise<any> {
    const id: string = params.toolCall?.toolCallId ?? `perm_${Date.now()}`;
    const options: PermissionChoice[] = (params.options ?? []).map((o: any) => ({
      optionId: o.optionId,
      name: o.name,
      kind: o.kind,
    }));
    if (this.options.autoApprove || this.autoApprove) {
      const pick =
        options.find((o) => o.kind === "allow_always") ??
        options.find((o) => o.kind === "allow_once") ??
        options[0];
      return pick
        ? { outcome: { outcome: "selected", optionId: pick.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }

    this.emit({
      t: "permission",
      id,
      title: params.toolCall?.title ?? "工具调用需要授权",
      toolKind: params.toolCall?.kind ?? undefined,
      options,
    });

    return await new Promise((resolve) => {
      this.pendingPermissions.set(id, (result) => {
        this.emit({ t: "permission_resolved", id, optionId: result?.optionId });
        resolve(result);
      });
    });
  }

  setAutoApprove(value: boolean): void {
    this.autoApprove = value;
  }

  async respondPermission(toolCallId: string, optionId: string): Promise<void> {
    const resolve = this.pendingPermissions.get(toolCallId);
    if (!resolve) return;
    this.pendingPermissions.delete(toolCallId);
    resolve({ outcome: { outcome: "selected", optionId } });
  }

  async prompt(text: string, images?: ImagePart[]): Promise<any> {
    if (!this.ctx || !this.sessionId) throw new Error("会话尚未就绪");
    const result = await this.ctx.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [
        ...(text.trim() ? [{ type: "text" as const, text }] : []),
        ...(images ?? []).map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
      ],
    });
    this.emit({
      t: "turn_end",
      stopReason: result?.stopReason ?? "end_turn",
      usage: result?.usage,
    });
    return result;
  }

  async cancel(): Promise<void> {
    if (!this.ctx || !this.sessionId) return;
    await this.ctx.notify("session/cancel", { sessionId: this.sessionId });
  }

  async setConfig(configId: string, value: string): Promise<void> {
    if (!this.ctx || !this.sessionId) throw new Error("会话尚未就绪");
    await this.ctx.request("session/set_config_option", { sessionId: this.sessionId, configId, value });
  }

  dispose(): void {
    try {
      this.child?.stdin?.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (this.child && !this.child.killed) this.child.kill();
    }, 300);
  }
}

function textOf(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (content.type === "text") return content.text ?? "";
  if (content.type === "content" && content.content?.type === "text") return content.content.text ?? "";
  return "";
}

function collectText(content: any): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const entry of content) {
    let text = "";
    if (entry?.type === "content" && entry.content?.type === "text") text = entry.content.text ?? "";
    else if (entry?.type === "text") text = entry.text ?? "";
    if (!text) continue;
    // omp 会把同一次输出重复放进 content（原文 + rawOutput 回显），去掉相邻重复项
    if (parts.length && parts[parts.length - 1].trim() === text.trim()) continue;
    parts.push(text);
  }
  const joined = parts.join("\n").trim();
  return joined || undefined;
}

function collectDiff(content: any): ToolDiff | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const entry of content) {
    if (entry?.type === "diff") {
      return { path: entry.path, oldText: entry.oldText ?? null, newText: entry.newText ?? "" };
    }
  }
  return undefined;
}








