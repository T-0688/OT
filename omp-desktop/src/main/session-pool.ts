import type { AgentEvent } from "../shared/types.js";
import type { AgentSession } from "./agent/session.js";

type Emit = (ev: AgentEvent) => void;

/**
 * 后台会话池：允许除了桌面当前会话之外，再跑若干独立会话。
 * 每个会话有自己的 emitter，事件按会话 id 落到 store，互不干扰。
 */
export class SessionPool {
  private map = new Map<string, AgentSession>();
  private busy = new Set<string>();
  private lastSeen = new Map<string, number>();

  constructor(
    private createSession: (onEvent: Emit) => AgentSession,
    private onEvent: (id: string, ev: AgentEvent) => void,
    private onBound: (id: string, session: AgentSession) => void = () => {},
  ) {}

  has(id: string): boolean {
    return this.map.has(id);
  }

  get(id: string): AgentSession | undefined {
    return this.map.get(id);
  }

  get size(): number {
    return this.map.size;
  }

  ids(): string[] {
    return [...this.map.keys()];
  }

  isBusy(id: string): boolean {
    return this.busy.has(id);
  }

  async start(opts: {
    cwd: string;
    autoApprove: boolean;
    extraArgs?: string[];
    onId?: (id: string) => void;
  }): Promise<{ id: string; session: AgentSession }> {
    let bound = "";
    const session = this.createSession((ev) => {
      if (ev.t === "ready") bound = ev.sessionId;
      this.lastSeen.set(ev.t === "ready" ? ev.sessionId : bound, Date.now());
      this.onEvent(bound, ev);
    });
    session.setAutoApprove(opts.autoApprove);
    if (opts.extraArgs?.length) session.setExtraArgs(opts.extraArgs);
    const id = await session.start(opts.cwd);
    this.map.set(id, session);
    if (bound) this.map.set(bound, session);
    this.lastSeen.set(id, Date.now());
    this.onBound(id, session);
    opts.onId?.(id);
    return { id, session };
  }

  async resume(opts: {
    id: string;
    cwd: string;
    autoApprove: boolean;
    extraArgs?: string[];
  }): Promise<AgentSession> {
    const existing = this.map.get(opts.id);
    if (existing) return existing;
    const session = this.createSession((ev) => this.onEvent(opts.id, ev));
    session.setAutoApprove(opts.autoApprove);
    if (opts.extraArgs?.length) session.setExtraArgs(opts.extraArgs);
    await session.resume(opts.id, opts.cwd);
    this.map.set(opts.id, session);
    this.lastSeen.set(opts.id, Date.now());
    this.onBound(opts.id, session);
    return session;
  }

  async prompt(id: string, text: string): Promise<void> {
    const session = this.map.get(id);
    if (!session) throw new Error(`会话 ${id} 不在后台池里`);
    if (this.busy.has(id)) throw new Error("会话正在运行，稍后再发");
    this.busy.add(id);
    try {
      await session.prompt(text, []);
    } finally {
      this.busy.delete(id);
    }
  }

  cancel(id: string): void {
    this.map.get(id)?.cancel();
  }

  respondPermission(id: string, toolCallId: string, optionId: string): void {
    this.map.get(id)?.respondPermission(toolCallId, optionId);
  }

  /** 回收闲置太久、且当前没在跑的后台会话 */
  sweep(idleMs: number): string[] {
    const now = Date.now();
    const dropped: string[] = [];
    for (const [id, session] of this.map) {
      if (this.busy.has(id)) continue;
      const seen = this.lastSeen.get(id) ?? 0;
      if (now - seen < idleMs) continue;
      try {
        session.dispose();
      } catch {
        /* ignore */
      }
      this.map.delete(id);
      this.lastSeen.delete(id);
      dropped.push(id);
    }
    return dropped;
  }

  snapshot(): { id: string; busy: boolean; lastSeen: number }[] {
    return [...this.map.keys()].map((id) => ({
      id,
      busy: this.busy.has(id),
      lastSeen: this.lastSeen.get(id) ?? 0,
    }));
  }

  dispose(id: string): void {
    const s = this.map.get(id);
    if (!s) return;
    try {
      s.dispose();
    } catch {
      /* ignore */
    }
    this.map.delete(id);
  }

  disposeAll(): void {
    for (const id of [...this.map.keys()]) this.dispose(id);
  }
}



