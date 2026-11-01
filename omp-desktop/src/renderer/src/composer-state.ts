/**
 * 每个会话的输入草稿与待发队列。
 * 存 localStorage；解析或写入失败一律降级为空，绝不影响聊天主流程。
 */

export type QueuedMessage = { id: string; text: string; files: string[] };
export type ComposerEntry = { draft: string; files: string[]; queue: QueuedMessage[] };
export type ComposerStore = Record<string, ComposerEntry>;

/** 还没落到某个会话上的输入（新会话、连接中）用这个键 */
export const NEW_SESSION_KEY = "__new__";

const KEY = "omp.composer.v1";
const MAX_ENTRIES = 60;
const MAX_DRAFT = 20_000;
const MAX_FILES = 12;
const MAX_QUEUE = 20;

function normalizeQueue(value: unknown): QueuedMessage[] {
  if (!Array.isArray(value)) return [];
  const out: QueuedMessage[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Partial<QueuedMessage>;
    if (typeof item.text !== "string" && !Array.isArray(item.files)) continue;
    out.push({
      id: typeof item.id === "string" && item.id ? item.id : `q_${out.length}`,
      text: typeof item.text === "string" ? item.text.slice(0, MAX_DRAFT) : "",
      files: Array.isArray(item.files) ? item.files.filter((f): f is string => typeof f === "string").slice(0, MAX_FILES) : [],
    });
    if (out.length >= MAX_QUEUE) break;
  }
  return out;
}

function normalizeEntry(value: unknown): ComposerEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<ComposerEntry>;
  const draft = typeof entry.draft === "string" ? entry.draft.slice(0, MAX_DRAFT) : "";
  const files = Array.isArray(entry.files)
    ? entry.files.filter((f): f is string => typeof f === "string").slice(0, MAX_FILES)
    : [];
  const queue = normalizeQueue(entry.queue);
  if (!draft && !files.length && !queue.length) return null;
  return { draft, files, queue };
}

export function loadStore(): ComposerStore {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: ComposerStore = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = normalizeEntry(value);
      if (entry) out[key] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

export function persistStore(store: ComposerStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* 配额或隐私模式失败都不影响聊天 */
  }
}

export function entryOf(store: ComposerStore, key: string): ComposerEntry {
  return store[key] ?? { draft: "", files: [], queue: [] };
}

export function sameEntry(a: ComposerEntry, b: ComposerEntry): boolean {
  if (a.draft !== b.draft) return false;
  if (a.files.length !== b.files.length || a.files.some((f, i) => f !== b.files[i])) return false;
  if (a.queue.length !== b.queue.length) return false;
  return a.queue.every((q, i) => q.id === b.queue[i].id && q.text === b.queue[i].text && q.files.join("\n") === b.queue[i].files.join("\n"));
}

function prune(store: ComposerStore): ComposerStore {
  const keys = Object.keys(store);
  if (keys.length <= MAX_ENTRIES) return store;
  const out: ComposerStore = {};
  for (const key of keys.slice(keys.length - MAX_ENTRIES)) out[key] = store[key];
  return out;
}

function assign(store: ComposerStore, key: string, next: ComposerEntry, prev: ComposerEntry): ComposerStore {
  const empty = !next.draft && !next.files.length && !next.queue.length;
  if (empty && !store[key]) return store;
  if (sameEntry(next, prev)) return store;
  const out: ComposerStore = { ...store };
  if (empty) delete out[key];
  else out[key] = next;
  return prune(out);
}

/** 只更新输入区，队列保持不变。 */
export function withDraft(store: ComposerStore, key: string, draft: string, files: string[]): ComposerStore {
  const prev = entryOf(store, key);
  return assign(store, key, {
    ...prev,
    draft: draft.slice(0, MAX_DRAFT),
    files: files.slice(0, MAX_FILES),
  }, prev);
}

/** 只更新队列，草稿保持不变。 */
export function withQueue(store: ComposerStore, key: string, queue: QueuedMessage[]): ComposerStore {
  const prev = entryOf(store, key);
  return assign(store, key, { ...prev, queue: queue.slice(0, MAX_QUEUE) }, prev);
}