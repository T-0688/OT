import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, SessionMeta } from "../shared/types.js";

type Index = { sessions: SessionMeta[] };

/**
 * 每会话一个 JSONL（只追加），元数据放 index.json。
 * 关掉应用再打开，历史还在；重放就是把 JSONL 读出来逐条喂给 UI。
 */
export class SessionStore {
  private readonly dir: string;
  private readonly indexPath: string;
  private index: Index = { sessions: [] };

  constructor(private readonly root: string) {
    this.dir = join(root, "sessions");
    this.indexPath = join(this.dir, "index.json");
  }

  init(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    if (existsSync(this.indexPath)) {
      try {
        this.index = JSON.parse(readFileSync(this.indexPath, "utf8"));
        if (!Array.isArray(this.index.sessions)) this.index = { sessions: [] };
      } catch {
        this.index = { sessions: [] };
      }
    }
  }

  private flush(): void {
    this.index.sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), "utf8");
  }

  list(): SessionMeta[] {
    return [...this.index.sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  addTurnStats(id: string, tokens: number, cost: number, used = 0, size = 0): void {
    const meta = this.get(id);
    if (!meta) return;
    const prev = meta.stats ?? { tokens: 0, cost: 0, turns: 0 };
    meta.stats = {
      tokens: prev.tokens + Math.max(0, Math.round(tokens)),
      cost: typeof cost === "number" && cost > 0 ? cost : prev.cost,
      turns: prev.turns + 1,
      used: used || prev.used,
      size: size || prev.size,
    };
    this.flush();
  }

  get(id: string): SessionMeta | undefined {
    return this.index.sessions.find((s) => s.id === id);
  }

  file(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  create(meta: SessionMeta): void {
    if (!this.get(meta.id)) this.index.sessions.push(meta);
    else Object.assign(this.get(meta.id)!, meta);
    this.flush();
  }

  append(id: string, event: AgentEvent): void {
    try {
      appendFileSync(this.file(id), JSON.stringify(event) + "\n", "utf8");
    } catch {
      /* 落盘失败不应该影响对话 */
    }
    const meta = this.get(id);
    if (meta) {
      meta.updatedAt = new Date().toISOString();
      if (event.t === "user" && (!meta.title || meta.title === "新会话")) {
        meta.title = event.text.slice(0, 48) || "新会话";
      }
      this.flush();
    }
  }

  read(id: string): AgentEvent[] {
    const path = this.file(id);
    if (!existsSync(path)) return [];
    const out: AgentEvent[] = [];
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 跳过坏行 */
      }
    }
    return out;
  }

  rename(id: string, title: string): void {
    const meta = this.get(id);
    if (!meta) return;
    meta.title = title.slice(0, 120) || "新会话";
    meta.updatedAt = new Date().toISOString();
    this.flush();
  }

  remove(id: string): void {
    this.index.sessions = this.index.sessions.filter((s) => s.id !== id);
    this.flush();
    try {
      unlinkSync(this.file(id));
    } catch {
      /* 文件可能已不存在 */
    }
  }

  clearAll(): void {
    for (const meta of this.index.sessions) {
      try {
        unlinkSync(this.file(meta.id));
      } catch {
        /* ignore */
      }
    }
    this.index.sessions = [];
    this.flush();
  }

  /** 在消息正文（含工具输出）里做全文搜索。 */
  search(query: string): { id: string; count: number; snippet: string }[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const hits: { id: string; count: number; snippet: string }[] = [];
    for (const meta of this.index.sessions) {
      let count = 0;
      let snippet = "";
      for (const ev of this.read(meta.id)) {
        const text =
          ev.t === "user" || ev.t === "text" || ev.t === "thinking"
            ? ev.text
            : ev.t === "tool_update"
              ? (ev.text ?? "") + " " + (ev.title ?? "")
              : ev.t === "tool_start"
                ? ev.title
                : "";
        if (!text) continue;
        const idx = text.toLowerCase().indexOf(q);
        if (idx < 0) continue;
        count++;
        if (!snippet) {
          const start = Math.max(0, idx - 40);
          snippet = text.slice(start, start + 120).replace(/\s+/g, " ");
        }
      }
      if (count > 0) hits.push({ id: meta.id, count, snippet });
    }
    return hits.sort((a, b) => b.count - a.count).slice(0, 30);
  }
}



