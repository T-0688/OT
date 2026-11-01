import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type {
  AgentEvent,
  AgentInfo,
  ConfigOption,
  PermissionChoice,
  AppSettings,
  ImagePart,
  SearchHit,
  SkillInfo,
  SessionMeta,
  ToolDiff,
  WeWallpaper,
  RemoteStatus,
  ConfigChoice,
} from "../../shared/types.js";
import { compactDiff, diffLines, type DiffLine } from "./diff.js";
import {
  entryOf,
  loadStore,
  NEW_SESSION_KEY,
  persistStore,
  withDraft,
  withQueue,
  type ComposerStore,
  type QueuedMessage,
} from "./composer-state.js";

type Item =
  | { kind: "user"; id: string; text: string; images?: ImagePart[] }
  | { kind: "assistant"; id: string; text: string; thinking: string; thinkingZh?: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      title: string;
      status: string;
      toolKind?: string;
      text: string;
      diff?: ToolDiff;
    }
  | { kind: "note"; id: string; text: string }
  | { kind: "turn"; id: string; ms: number; tokens: number; at: number; userText?: string; stopReason?: string };

type PendingPermission = { id: string; title: string; options: PermissionChoice[]; sessionId?: string };
type Status = "connecting" | "ready" | "running" | "exited" | "error";
type PaletteCommand = { id: string; label: string; hint?: string; run: () => void };


let seq = 0;
const uid = (prefix: string) => `${prefix}_${++seq}`;

function appendAssistant(items: Item[], text: string): Item[] {
  const last = items[items.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...items, { kind: "assistant", id: uid("a"), text, thinking: "", streaming: true }];
}

function appendThinking(items: Item[], text: string): Item[] {
  const last = items[items.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    return [...items.slice(0, -1), { ...last, thinking: last.thinking + text }];
  }
  return [...items, { kind: "assistant", id: uid("a"), text: "", thinking: text, streaming: true }];
}

function closeAssistant(items: Item[]): Item[] {
  const last = items[items.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    return [...items.slice(0, -1), { ...last, streaming: false }];
  }
  return items;
}

/** 同一套映射：实时事件与历史重放都走这里。 */
function applyToItems(items: Item[], ev: AgentEvent): Item[] {
  switch (ev.t) {
    case "user":
      return [...closeAssistant(items), { kind: "user", id: uid("u"), text: ev.text, images: ev.images }];
    case "note":
      return [...closeAssistant(items), { kind: "note", id: uid("n"), text: ev.text }];
    case "text":
      return appendAssistant(items, ev.text);
    case "thinking":
      return appendThinking(items, ev.text);
    case "tool_start":
      return [
        ...closeAssistant(items),
        {
          kind: "tool",
          id: ev.id,
          title: ev.title,
          status: ev.status ?? "pending",
          toolKind: ev.toolKind,
          text: "",
        },
      ];
    case "tool_update":
      return items.map((it) =>
        it.kind === "tool" && it.id === ev.id
          ? {
              ...it,
              title: ev.title ?? it.title,
              status: ev.status ?? it.status,
              text: ev.text ?? it.text,
              diff: ev.diff ?? it.diff,
            }
          : it,
      );
    case "turn_end":
      return closeAssistant(items);
    default:
      return items;
  }
}

const STATUS_LABEL: Record<string, string> = {
  pending: "待执行",
  in_progress: "执行中",
  completed: "完成",
  failed: "失败",
};

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} 分 ${s} 秒` : `${m} 分`;
}

function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  if (min < 60) return rest ? `${min} 分 ${rest} 秒` : `${min} 分钟`;
  const hour = Math.floor(min / 60);
  return `${hour} 小时 ${min % 60} 分`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function timeLabel(iso: string): string {  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<Status>("connecting");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string>("");
  const [configOptions, setConfigOptions] = useState<ConfigOption[]>([]);
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [usage, setUsage] = useState<{ cost?: number; used?: number; size?: number }>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [stats, setStats] = useState<{
    speed?: number;
    outputTokens?: number;
    inputTokens?: number;
    cachePct?: number;
  }>({});

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentId, setAgentId] = useState("omp");
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [query, setQuery] = useState("");
  const [contentHits, setContentHits] = useState<{ id: string; title: string; cwd: string; role: string; snippet: string }[]>([]);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [tasks, setTasks] = useState<{ id: string; busy: boolean; lastSeen: number; title: string; cwd: string; status?: string }[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const [modelPrices, setModelPrices] = useState<{ selector: string; input: number; output: number; cacheRead: number }[]>([]);
  const [taskNotice, setTaskNotice] = useState("");
  const [attachments, setAttachments] = useState<ImagePart[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [pendingQueue, setPendingQueue] = useState<QueuedMessage[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [approval, setApproval] = useState<"ask" | "auto">("ask");
  const [plusOpen, setPlusOpen] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);

  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("omp.theme") as "dark" | "light") || "light",
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [failedText, setFailedText] = useState<string | null>(null);
  const [configNotice, setConfigNotice] = useState("");

  const [bgMode, setBgMode] = useState<"solid" | "wallpaper" | "custom" | "we">(
    () => (localStorage.getItem("omp.bg") as "solid" | "wallpaper" | "custom" | "we") || "solid",
  );
  const [wallpaper, setWallpaper] = useState<string | null>(null);
  const [weList, setWeList] = useState<WeWallpaper[]>([]);
  const [wePicker, setWePicker] = useState(false);

  const [view, setView] = useState<"chat" | "skills" | "settings">("chat");
  const [skillList, setSkillList] = useState<SkillInfo[]>([]);
  const [skillQuery, setSkillQuery] = useState("");
  const [fileHits, setFileHits] = useState<{ path: string; name: string }[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const turnIdRef = useRef<string>("");
  const snapshotted = useRef<Set<string>>(new Set());
  const [phoneOnline, setPhoneOnline] = useState(false);
  const [balance, setBalance] = useState<{ total?: number; currency?: string }>({});
  const [officialModels, setOfficialModels] = useState<string[] | null>(null);
  const [liveSpeed, setLiveSpeed] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const liveChars = useRef(0);
  const liveSamples = useRef<{ t: number; n: number }[]>([]);
  const liveStart = useRef(0);
  const [totalTokens, setTotalTokens] = useState(0);
  const [sessionCost, setSessionCost] = useState(0);
  const [sessionTurnBase, setSessionTurnBase] = useState(0);
  const [autoOpen, setAutoOpen] = useState<SessionMeta | null>(null);
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string; name: string } | null>(null);
  const [wsMenu, setWsMenu] = useState<{ x: number; y: number; cwd: string; name: string; pinned: boolean } | null>(null);
  const [wsEditing, setWsEditing] = useState<{ cwd: string; value: string } | null>(null);
  const [collapsedWs, setCollapsedWs] = useState<Set<string>>(new Set());
  const [expandedWs, setExpandedWs] = useState<Set<string>>(new Set());
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const scrollGuard = useRef(0);
  const started = useRef(false);
  const lastUser = useRef("");
  const pending = useRef({ text: "", thinking: "", timer: 0 });
  const turnStart = useRef(Date.now());
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [composerStore, setComposerStore] = useState<ComposerStore>(() => loadStore());
  const storeRef = useRef(composerStore);
  storeRef.current = composerStore;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const filesRef = useRef(files);
  filesRef.current = files;
  const pendingQueueRef = useRef(pendingQueue);
  pendingQueueRef.current = pendingQueue;
  const queuePausedRef = useRef(queuePaused);
  queuePausedRef.current = queuePaused;
  const runningRef = useRef(running);
  const lastEventAt = useRef(Date.now());
  runningRef.current = running;
  const composerKey = sessionId ?? NEW_SESSION_KEY;
  const composerKeyRef = useRef(composerKey);
  const [flushTick, setFlushTick] = useState(0);

  // 切换到另一个会话：先存下当前输入，再载入目标会话的草稿与队列
  useEffect(() => {
    const prevKey = composerKeyRef.current;
    if (prevKey === composerKey) return;
    const saved = withDraft(storeRef.current, prevKey, draftRef.current, filesRef.current);
    storeRef.current = saved;
    setComposerStore(saved);
    persistStore(saved);
    composerKeyRef.current = composerKey;
    const entry = entryOf(saved, composerKey);
    setDraft(entry.draft);
    setFiles(entry.files);
    setPendingQueue(entry.queue);
    setQueuePaused(false);
  }, [composerKey]);

  useEffect(() => {
    const next = withDraft(storeRef.current, composerKeyRef.current, draft, files);
    if (next === storeRef.current) return;
    storeRef.current = next;
    setComposerStore(next);
    persistStore(next);
  }, [draft, files]);

  useEffect(() => {
    const next = withQueue(storeRef.current, composerKeyRef.current, pendingQueue);
    if (next === storeRef.current) return;
    storeRef.current = next;
    setComposerStore(next);
    persistStore(next);
  }, [pendingQueue]);

  // 输入框随内容增高，最多 180px 后内部滚动
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("omp.theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("omp.bg", bgMode);
    document.documentElement.dataset.bg = bgMode === "solid" ? "solid" : "image";
    if (bgMode === "solid") return;
    if (bgMode === "we") return;
    if (bgMode === "wallpaper") {
      void window.api.wallpaper().then((dataUrl) => setWallpaper(dataUrl));
    } else {
      const path = localStorage.getItem("omp.bg.customPath");
      if (path) void window.api.readImage(path).then((dataUrl) => setWallpaper(dataUrl));
    }
  }, [bgMode]);

  useEffect(() => {
    document.body.style.backgroundImage = "";
  }, [bgMode]);

  const selectWe = async (item: WeWallpaper) => {
    const next = await window.api.saveSettings({ background: "we", weWallpaper: item });
    setAppSettings(next);
    setBgMode("we");
    setWePicker(false);
  };

  const openWePicker = async () => {
    setWePicker(true);
    if (weList.length === 0) setWeList(await window.api.weWallpapers());
  };

  const flush = useCallback(() => {
    pending.current.timer = 0;
    const { text, thinking } = pending.current;
    pending.current.text = "";
    pending.current.thinking = "";
    if (thinking) setItems((p) => appendThinking(p, thinking));
    if (text) setItems((p) => appendAssistant(p, text));
  }, []);

  const queue = useCallback(
    (kind: "text" | "thinking", chunk: string) => {
      pending.current[kind] += chunk;
      if (!pending.current.timer) pending.current.timer = window.setTimeout(flush, 16);
    },
    [flush],
  );

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await window.api.sessions());
    } catch {
      /* ignore */
    }
  }, []);

  const handleEvent = useCallback(
    (ev: AgentEvent) => {
      lastEventAt.current = Date.now();
      switch (ev.t) {
        case "ready":
          setSessionId(ev.sessionId);
          sessionIdRef.current = ev.sessionId;
          setCwd(ev.cwd);
          setAgentId(ev.agentId);
          setConfigOptions(ev.configOptions ?? []);
                    setStatus("ready");
          break;
        case "text":
          liveChars.current += estimateTokens(ev.text);
          liveSamples.current.push({ t: Date.now(), n: estimateTokens(ev.text) });
          if (liveSamples.current.length > 400) liveSamples.current.splice(0, 200);
          queue("text", ev.text);
          if (stickToBottom.current) {
            requestAnimationFrame(() => {
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            });
          }
          break;
        case "thinking":
          queue("thinking", ev.text);
          break;
        case "permission":
          setPermission({ id: ev.id, title: ev.title, options: ev.options });
          break;
        case "permission_resolved":
          setPermission((p) => (p && p.id === ev.id ? null : p));
          break;
        case "usage":
          setUsage((prev) => ({
            used: ev.used ?? prev.used,
            size: ev.size ?? prev.size,
            cost: ev.costUsd ?? prev.cost,
          }));
          break;
        case "tool_update":
          if (ev.diff && ev.diff.path && sessionIdRef.current && turnIdRef.current && ev.diff.oldText !== undefined) {
            const key = ev.diff.path.toLowerCase();
            if (!snapshotted.current.has(key)) {
              snapshotted.current.add(key);
              void window.api.saveCheckpoint(
                sessionIdRef.current,
                turnIdRef.current,
                ev.diff.path,
                ev.diff.oldText ?? null,
              );
            }
          }
          break;
        case "turn_end": {
          flush();
          setRunning(false);
          setStatus("ready");
          setLiveSpeed(0);
          setFailedText(null);
          const seconds = (Date.now() - turnStart.current) / 1000;
          const out = ev.usage?.outputTokens ?? 0;
          const inp = ev.usage?.inputTokens ?? 0;
          const cached = ev.usage?.cachedReadTokens ?? 0;
          if (out > 0 && seconds > 0) {
            setStats((prev) => ({
              ...prev,
              speed: out / seconds,
              outputTokens: out,
              inputTokens: inp,
              cachePct: inp + cached > 0 ? (cached / (inp + cached)) * 100 : prev.cachePct,
            }));
          }
          // 这一轮结束：把最后一条思考翻成中文（展示在收起的折叠块里）
          {
            const list = itemsRef.current;
            for (let i = list.length - 1; i >= 0; i--) {
              const it = list[i];
              if (it.kind === "assistant" && it.thinking && !it.thinkingZh) {
                const raw = it.thinking;
                const idx = i;
                void window.api.translateThinking(raw).then((zh) => {
                  if (!zh) return;
                  setItems((cur) => cur.map((x, j) => (j === idx ? { ...x, thinkingZh: zh } : x)));
                });
                break;
              }
            }
          }
          void refreshSessions();
          setTotalTokens((n) => n + inp + cached + out);
          setItems((prev) => [
            ...prev,
            {
              kind: "turn",
              id: `turn-${Date.now()}`,
              ms: Math.max(0, Math.round(seconds * 1000)),
              tokens: inp + cached + out,
              at: Date.now(),
              userText: lastUser.current,
              stopReason: ev.stopReason,
            },
          ]);
          if (ev.stopReason === "end_turn") setFlushTick((t) => t + 1);
          else if (pendingQueueRef.current.length) setQueuePaused(true);
          break;
        }
        case "error":
          {
            const list = itemsRef.current;
            for (let k = list.length - 1; k >= 0; k--) {
              const it = list[k];
              if (it.kind === "assistant" && it.thinking && !it.thinkingZh) {
                const raw = it.thinking;
                const idx = k;
                void window.api.translateThinking(raw).then((zh) => {
                  if (!zh) return;
                  setItems((cur) => cur.map((x, j) => (j === idx ? { ...x, thinkingZh: zh } : x)));
                });
                break;
              }
            }
          }
          flush();
          setStatus("error");
          setRunning(false);
          setFailedText(lastUser.current || null);
          if (pendingQueueRef.current.length) setQueuePaused(true);
          break;
        case "log":
          setLogs((prev) => [...prev.slice(-80), ev.text]);
          break;
        case "agent_exit":
          flush();
          setStatus("exited");
          setRunning(false);
          if (pendingQueueRef.current.length) setQueuePaused(true);
          break;
      }
      if (ev.t !== "text" && ev.t !== "thinking") {
        setItems((prev) => applyToItems(prev, ev));
      }
    },
    [flush, queue, refreshSessions],
  );

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--bg-shade", String(appSettings?.bgShade ?? 0.55));
    root.style.setProperty("--bg-blur", `${appSettings?.bgBlur ?? 12}px`);
  }, [appSettings?.bgShade, appSettings?.bgBlur]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - liveStart.current) / 1000;
      const recent = liveSamples.current.filter((x) => now - x.t <= 3000);
      liveSamples.current = recent;
      if (recent.length >= 2) {
        const sum = recent.reduce((a, b) => a + b.n, 0);
        const span = Math.max(0.5, (now - recent[0].t) / 1000);
        setLiveSpeed(sum / span);
      } else if (!recent.length) {
        setLiveSpeed(0);
      }
      setElapsedSec(Math.max(0, Math.round(elapsed)));
    }, 500);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (!appSettings?.deepseekApiKey?.trim() || !appSettings?.officialModelsOnly) {
      setOfficialModels(null);
      return;
    }
    const t = setTimeout(() => {
      void window.api.deepseekModels().then((r) => setOfficialModels(r.ok && r.ids.length ? r.ids : null)).catch(() => setOfficialModels(null));
    }, 800);
    return () => clearTimeout(t);
  }, [appSettings?.deepseekApiKey, appSettings?.officialModelsOnly]);
  useEffect(() => {
    const load = () => {
      void window.api
        .getBalance()
        .then((r) => setBalance(r.ok ? { total: r.total, currency: r.currency } : {}))
        .catch(() => setBalance({}));
    };
    const key = appSettings?.deepseekApiKey?.trim();
    if (!key) {
      setBalance({});
      return;
    }
    const debounce = setTimeout(load, 600);
    const timer = setInterval(load, 120_000);
    return () => {
      clearTimeout(debounce);
      clearInterval(timer);
    };
  }, [appSettings?.deepseekApiKey]);
  useEffect(() => {
    const offClients = window.api.onRemoteClients((n) => setPhoneOnline(n > 0));
    void window.api.remoteStatus().then((st) => { if (!st.running) setPhoneOnline(false); }).catch(() => {});
    return offClients;
  }, []);
  useEffect(() => {
    const off = window.api.onAskSelection((text) => {
      setDraft((prev) => (prev ? `${prev}\n\n${text}` : text));
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLTextAreaElement>(".composer textarea");
        el?.focus();
      });
    });
    return off;
  }, []);
  useEffect(() => {
    const off = window.api.onScreenshot((base64) => {
      setAttachments((prev) => [...prev, { data: base64, mimeType: "image/png", name: "screenshot.png" }].slice(0, 6));
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLTextAreaElement>(".composer textarea");
        el?.focus();
      });
    });
    return off;
  }, []);
  useEffect(() => {
    const off = window.api.onEvent(handleEvent);
    void (async () => {
      setAgents(await window.api.agents());
      await refreshSessions();
    })();
    if (!started.current) {
      started.current = true;
      void (async () => {
        try {
          const st = await window.api.settings();
          const list = await window.api.sessions();
          const last = st.lastSessionId ? list.find((x) => x.id === st.lastSessionId) : null;
          if (last) {
            setAutoOpen(last);
            return;
          }
        } catch {
          /* ignore */
        }
        void window.api.start().catch((err) => {
          setStatus("error");
          setItems([{ kind: "note", id: uid("n"), text: `无法启动 agent：${err?.message ?? err}` }]);
        });
      })();
    }
    return off;
  }, [handleEvent, refreshSessions]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (Date.now() < scrollGuard.current) return;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(stickToBottom.current);
  };

  /** 真正把一条消息交给 agent；返回是否已经发出。 */
  const dispatch = async (text: string, filePaths: string[], imgs: ImagePart[]): Promise<boolean> => {
    if (runningRef.current || !sessionIdRef.current) return false;
    const extra = filePaths.length ? `\n\n[附带的文件]\n${filePaths.map((f) => `- ${f}`).join("\n")}` : "";
    const content = (text.trim() + extra).trim();
    if (!content && imgs.length === 0) return false;
    lastUser.current = content;
    turnStart.current = Date.now();
    liveChars.current = 0;
    liveSamples.current = [];
    liveStart.current = Date.now();
    setLiveSpeed(0);
    setElapsedSec(0);
    setRunning(true);
    setStatus("running");
    stickToBottom.current = true;
    const res = await window.api.prompt(content, imgs.length ? imgs : undefined);
    if (!res.ok) {
      setRunning(false);
      setStatus("error");
      setFailedText(content);
      return false;
    }
    return true;
  };

  const send = async (text?: string, images?: ImagePart[]) => {
    const imgs = images ?? attachments;
    if (text !== undefined) {
      // 重试等外部调用：输入区维持原样
      await dispatch(text, files, imgs);
      return;
    }
    const textNow = draft;
    const filesNow = files;
    if (!textNow.trim() && !filesNow.length && !imgs.length) return;
    setDraft("");
    setAttachments([]);
    setFiles([]);
    const ok = await dispatch(textNow, filesNow, imgs);
    if (!ok) {
      // 没发出去就把输入还给你，避免丢内容
      setDraft(textNow);
      setFiles(filesNow);
      setAttachments(imgs);
    }
  };

  /** 本轮运行中：把当前输入排进待发队列。 */
  const enqueueDraft = () => {
    const text = draft.trim();
    if (!text && !files.length) return;
    setPendingQueue((cur) => [...cur, { id: `q_${Date.now()}_${cur.length}`, text, files: [...files] }].slice(0, 20));
    setDraft("");
    setFiles([]);
    setQueuePaused(false);
  };

  // 本轮正常跑完后按顺序发出下一条；停止或出错会暂停，避免误发
  useEffect(() => {
    if (!flushTick) return;
    if (runningRef.current || queuePausedRef.current || !sessionIdRef.current) return;
    const next = pendingQueueRef.current[0];
    if (!next) return;
    setPendingQueue((cur) => cur.filter((item) => item.id !== next.id));
    void (async () => {
      const ok = await dispatch(next.text, next.files, []);
      if (ok) return;
      setPendingQueue((cur) => [next, ...cur.filter((item) => item.id !== next.id)]);
      setQueuePaused(true);
    })();
  }, [flushTick]);

  const chooseWallpaper = async () => {
    const picked = await window.api.pickImage();
    if (!picked) return;
    localStorage.setItem("omp.bg.customPath", picked.path);
    setWallpaper(picked.dataUrl);
    setBgMode("custom");
  };

  const loadSkills = useCallback(async () => {
    try {
      setSkillList(await window.api.skills());
    } catch {
      setSkillList([]);
    }
  }, []);

  useEffect(() => {
    void window.api.settings().then((s) => {
      setAppSettings(s);
      setTheme(s.theme);
      setBgMode(s.background);
      if (s.customBackgroundPath) localStorage.setItem("omp.bg.customPath", s.customBackgroundPath);
      document.documentElement.style.zoom = String(s.zoom || 1);
      setApproval(s.approvalMode ?? "ask");
      void window.api.setApprovalMode(s.approvalMode ?? "ask");
    });
  }, []);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const useSkill = (skill: SkillInfo) => {
    setView("chat");
    setDraft(`使用「${skill.name}」技能：`);
    setItems((prev) => [
      ...prev,
      { kind: "note", id: uid("n"), text: `已把「${skill.name}」填进输入框，补上任务再发送即可。` },
    ]);
  };


  const addImages = async (files: File[]) => {
    const next: ImagePart[] = [];
    for (const file of files.slice(0, 4)) {
      if (!file.type.startsWith("image/") || file.size > 4 * 1024 * 1024) continue;
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
      });
      const comma = dataUrl.indexOf(",");
      const mime = dataUrl.slice(5, dataUrl.indexOf(";")) || file.type;
      next.push({ data: dataUrl.slice(comma + 1), mimeType: mime, name: file.name || "image" });
    }
    if (next.length) setAttachments((prev) => [...prev, ...next].slice(0, 6));
  };

  const commitRename = async () => {
    if (!editing) return;
    const title = editing.title.trim();
    setEditing(null);
    if (!title) return;
    await window.api.renameSession(editing.id, title);
    await refreshSessions();
  };

  const removeSession = async (meta: SessionMeta) => {
    if (!window.confirm(`删除会话「${meta.title || "新会话"}」？\n只删本地记录，不影响 agent 自己的会话文件。`)) return;
    await window.api.deleteSession(meta.id);
    if ((appSettings?.pinnedSessions ?? []).includes(meta.id)) {
      const saved = await window.api.saveSettings({ pinnedSessions: (appSettings?.pinnedSessions ?? []).filter((x) => x !== meta.id) });
      setAppSettings(saved);
    }
    if (meta.id === sessionId) {
      setItems([]);
      setSessionId(null);
      setStatus("connecting");
    }
    await refreshSessions();
  };

  const stop = async () => {
    await window.api.cancel();
    flush();
    setRunning(false);
    setStatus("ready");
    if (pendingQueueRef.current.length) setQueuePaused(true);
  };

  const choose = async (option: PermissionChoice) => {
    if (!permission) return;
    const current = permission;
    setPermission(null);
    if (current.sessionId) await window.api.respondPermissionBg(current.sessionId, current.id, option.optionId);
    else await window.api.respondPermission(current.id, option.optionId);
  };

  const newSession = async (nextAgent = agentId, nextCwd?: string) => {
    setItems([]);
    setTotalTokens(0);
    setSessionCost(0);
    setSessionTurnBase(0);
    setStats({});
    setUsage({});
    setSessionId(null);
    setConfigOptions([]);
    setPermission(null);
    setUsage({});
    setFailedText(null);
    setStatus("connecting");
    setAgentId(nextAgent);
    if (nextCwd) setCwd(nextCwd);
    await window.api.start({ agentId: nextAgent, cwd: nextCwd ?? cwd ?? undefined });
  };

  const openSession = async (meta: SessionMeta) => {
    const data = await window.api.openSession(meta.id);
    if (!data) return;
    let replay: Item[] = [];
    let configs: ConfigOption[] = [];
    let agent = meta.agentId;
    let rTokens = 0;
    let rTurns = 0;
    let rUsed = 0;
    let rSize = 0;
    let rCost = 0;
    for (const ev of data.events) {
      replay = applyToItems(replay, ev);
      if (ev.t === "ready") {
        configs = ev.configOptions ?? [];
        agent = ev.agentId;
      }
      if (ev.t === "usage") {
        if (typeof ev.used === "number") rUsed = ev.used;
        if (typeof ev.size === "number") rSize = ev.size;
        if (typeof ev.costUsd === "number") rCost = ev.costUsd;
      }
      if (ev.t === "turn_end") {
        rTurns += 1;
        const u = ev.usage;
        rTokens += (u?.inputTokens ?? 0) + (u?.cachedReadTokens ?? 0) + (u?.outputTokens ?? 0);
      }
    }
    setItems(replay);
    setTotalTokens(Math.max(meta.stats?.tokens ?? 0, rTokens));
    setSessionCost(Math.max(meta.stats?.cost ?? 0, rCost));
    setSessionTurnBase(Math.max(meta.stats?.turns ?? 0, rTurns));
    const st = meta.stats;
    const used = rUsed || st?.used || 0;
    const size = rSize || st?.size || 0;
    const cost = Math.max(st?.cost ?? 0, rCost);
    const restoredUsage = { used, size, cost: cost || undefined };
    setUsage(restoredUsage);
    setStats({ cachePct: st?.cachePct ?? 0 });
    setConfigOptions(configs);
    setAgentId(agent);
    setSessionId(meta.id);
    setCwd(meta.cwd);
    setPermission(null);
    setStatus("connecting");
    setRunning(false);
    setFailedText(null);
    stickToBottom.current = true;
    void window.api.saveSettings({ lastSessionId: meta.id });
    await window.api.resume(meta.id);
    // agent 加载会话时可能推送一条空 usage，稍后再兜底一次
    setTimeout(() => {
      setUsage((prev) => (prev.used || prev.size ? prev : restoredUsage));
    }, 1200);
  };

  useEffect(() => {
    if (!autoOpen) return;
    const target = autoOpen;
    setAutoOpen(null);
    void openSession(target);
  }, [autoOpen]);

  const changeDir = async () => {
    const dir = await window.api.pickDirectory();
    if (!dir) return;
    await newSession(agentId, dir);
  };

  const setConfig = async (id: string, value: string) => {
    const target = sessionIdRef.current;
    setConfigNotice("");
    try {
      const result = await window.api.setConfig(id, value);
      if (target !== sessionIdRef.current) return;
      if (!result.ok) {
        setConfigNotice(`切换失败：${result.error || "Agent 未接受此设置"}`);
        return;
      }
      setConfigOptions((prev) => prev.map((o) => (o.id === id ? { ...o, currentValue: value } : o)));
    } catch (err) {
      if (target === sessionIdRef.current) setConfigNotice(`切换失败：${String(err?.message ?? err)}`);
    }
  };

  const updateSettings = async (patch: Partial<AppSettings>) => {
    const next = await window.api.saveSettings(patch);
    setAppSettings(next);
    if (patch.theme) setTheme(patch.theme);
    if (patch.background) setBgMode(patch.background);
    if (typeof patch.zoom === "number") document.documentElement.style.zoom = String(patch.zoom);
    if (patch.customBackgroundPath) localStorage.setItem("omp.bg.customPath", patch.customBackgroundPath);
    if (patch.defaultModel && models) await setConfig(models.id, patch.defaultModel);
    if (patch.defaultMode && modes) await setConfig(modes.id, patch.defaultMode);
  };

  const copyTranscript = async () => {
    const text = items
      .map((it) => {
        if (it.kind === "user") return `## 你\n\n${it.text}`;
        if (it.kind === "assistant") return `## agent\n\n${it.text}`;
        if (it.kind === "tool") return `\`\`\`\n${it.title}\n${it.text}\n\`\`\``;
        return it.kind === "note" ? it.text : "";
      })
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  const models = configOptions.find((o) => o.category === "model");
  const modes = configOptions.find((o) => o.category === "mode");
  const thinking = configOptions.find(
    (o) => o.id === "thinking" || o.category === "thought_level" || o.category === "thinking",
  );
  const sessionTitle = items.find((i) => i.kind === "user")?.text.slice(0, 48) || "新会话";
  const modelLabel =
    (() => {
      const cur = String(models?.currentValue ?? "");
      const name = models?.options?.find((o) => o.value === cur)?.name ?? cur;
      const prefix = cur.includes("/") ? cur.split("/")[0] + "/" : "";
      return prefix + name;
    })();

  // 运行中显示"在干什么"，而不是笼统的 Thinking
  const progressLabel = useMemo(() => {
    if (!running) return "";
    if (permission) return `等待授权：${permission.title}`;
    let steps = 0;
    let current = "";
    for (const item of items) {
      if (item.kind !== "tool") continue;
      steps++;
      if (item.status === "in_progress" || item.status === "pending") current = item.title;
      else if (item.status === "failed") current = `失败：${item.title}`;
    }
    if (current) return current;
    return steps > 0 ? `已执行 ${steps} 步` : "思考中…";
  }, [items, running, permission]);
  const detectedAgents = useMemo(() => agents.filter((a) => a.detected || a.id === agentId), [agents, agentId]);
  const hitMap = useMemo(() => new Map(hits.map((h) => [h.id, h])), [hits]);
  useEffect(() => {
    void window.api.modelPricing().then(setModelPrices).catch(() => setModelPrices([]));
  }, []);

  useEffect(() => {
    const load = () => {
      void window.api.listTasks().then(setTasks).catch(() => setTasks([]));
    };
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  // 看门狗：90 秒没有任何事件就自动停止，避免无限“运行中”
  useEffect(() => {
    const timer = setInterval(() => {
      if (!runningRef.current) return;
      if (Date.now() - lastEventAt.current < 90_000) return;
      void window.api.cancel();
      setRunning(false);
      setStatus("error");
      setItems((prev) => [
        ...prev,
        { kind: "note", id: `note-${Date.now()}`, text: "模型 90 秒没有响应，已自动停止。请换模型或重试。" },
      ]);
    }, 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setContentHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void window.api.searchSessions(q).then(setContentHits).catch(() => setContentHits([]));
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);
  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        s.agentId.includes(q) ||
        hitMap.has(s.id),
    );
  }, [sessions, query, hitMap]);

  const workspaces = appSettings?.workspaces ?? [];
  const hiddenWorkspaces = appSettings?.hiddenWorkspaces ?? [];

  const turnList = useMemo(
    () =>
      items
        .filter((i) => i.kind === "user")
        .map((i) => ({
          id: i.id,
          label: (i.kind === "user" ? i.text : "").replace(/\s+/g, " ").slice(0, 40) || "（图片/空消息）",
        })),
    [items],
  );

  const [activeTurn, setActiveTurn] = useState<string | null>(null);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !turnList.length) return;
    const onScroll = () => {
      const top = scroller.scrollTop + 90;
      let current = turnList[0]?.id ?? null;
      for (const t of turnList) {
        const el = document.getElementById(`turn-${t.id}`);
        if (el && el.offsetTop <= top) current = t.id;
      }
      setActiveTurn(current);
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [turnList]);

  const jumpToTurn = (id: string) => {
    const el = document.getElementById(`turn-${id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  useEffect(() => {
    const last = items[items.length - 1];
    if (last?.kind === "user" && last.id !== turnIdRef.current) {
      turnIdRef.current = last.id;
      snapshotted.current.clear();
    }
  }, [items]);
  const modelOptions = useMemo(() => {
    const all = models?.options ?? [];
    const withPrefix = (list: ConfigChoice[]) => list.map((o) => ({ ...o, name: o.value.includes("/") ? o.value.split("/")[0] + "/" + o.name : o.name }));
    const current = String(models?.currentValue ?? "");
    if (!officialModels || !officialModels.length) return withPrefix(all);
    return withPrefix(all.filter((o) => {
      if (!o.value.startsWith("deepseek/")) return true;
      const id = o.value.slice("deepseek/".length);
      return officialModels.includes(id) || o.value === current;
    }));
  }, [models?.options, models?.currentValue, officialModels]);
  const turnCount = useMemo(() => Math.max(items.filter((i) => i.kind === "turn").length, sessionTurnBase) + (running ? 1 : 0), [items, running, sessionTurnBase]);
  const ctxPct = usage.size ? Math.min(100, ((usage.used ?? 0) / usage.size) * 100) : 0;
  const isOffPeak = useMemo(() => {
    const now = new Date();
    const m = now.getUTCHours() * 60 + now.getUTCMinutes();
    // DeepSeek 谷时：16:30–00:30 UTC
    return m >= 16 * 60 + 30 || m < 30;
  }, [usage.cost, turnCount]);

  const cost = useMemo(() => {
    if (typeof usage.cost === "number" && usage.cost > 0) return usage.cost;
    if (sessionCost > 0) return sessionCost;
    const selector = String(models?.currentValue ?? "");
    const price = modelPrices.find((p) => p.selector === selector);
    const pIn = price?.input ?? appSettings?.priceIn ?? 0;
    const pOut = price?.output ?? appSettings?.priceOut ?? 0;
    const pCache = price?.cacheRead ?? (appSettings?.priceCacheIn || pIn * 0.1);
    const factor = selector.startsWith("deepseek/") && appSettings?.deepseekPricing && isOffPeak ? (appSettings?.offPeakFactor ?? 0.5) : 1;
    const totalIn = stats.inputTokens ?? 0;
    const hitRate = Math.min(100, Math.max(0, stats.cachePct ?? 0)) / 100;
    const cachedTok = totalIn * hitRate;
    const missTok = totalIn - cachedTok;
    const outTok = stats.outputTokens ?? 0;
    return ((missTok * pIn + cachedTok * pCache + outTok * pOut) * factor) / 1_000_000;
  }, [usage.cost, appSettings?.priceIn, appSettings?.priceOut, appSettings?.priceCacheIn, appSettings?.deepseekPricing, appSettings?.offPeakFactor, isOffPeak, stats.inputTokens, stats.outputTokens, stats.cachePct, modelPrices, models?.currentValue]);
  const rails = useMemo(() => {
    const map = new Map<number, { path: string; name: string }[]>();
    let current: { path: string; name: string }[] = [];
    const seen = new Set<string>();
    const flush = (index: number) => {
      if (current.length) map.set(index, current);
    };
    items.forEach((item, i) => {
      if (item.kind === "user") {
        flush(i - 1);
        current = [];
        seen.clear();
        return;
      }
      if (item.kind === "tool" && item.diff?.path) {
        const path = item.diff.path;
        if (!seen.has(path)) {
          seen.add(path);
          current.push({ path, name: path.split(/[\\/]/).pop() || path });
        }
      }
      if (i === items.length - 1) flush(i);
    });
    return map;
  }, [items]);
  const groups = useMemo(() => {
    const pinnedIds = new Set(appSettings?.pinnedSessions ?? []);
    const map = new Map<string, SessionMeta[]>();
    for (const s of filteredSessions) {
      const key = s.cwd || "（未指定目录）";
      const arr = map.get(key) ?? [];
      arr.push(s);
      map.set(key, arr);
    }
    const list: { key: string; cwd: string; name: string; items: SessionMeta[]; pinned: boolean }[] = [];
    const seen = new Set<string>();
    for (const ws of workspaces) {
      if (seen.has(ws) || hiddenWorkspaces.includes(ws)) continue;
      seen.add(ws);
      list.push({ key: ws, cwd: ws, name: ws.split(/[\\/]/).filter(Boolean).pop() || ws, items: map.get(ws) ?? [], pinned: true });
    }
    for (const [cwd, items] of map) {
      if (seen.has(cwd) || hiddenWorkspaces.includes(cwd)) continue;
      list.push({ key: cwd, cwd, name: cwd.split(/[\\/]/).filter(Boolean).pop() || cwd, items, pinned: false });
    }
    for (const group of list) {
      group.items.sort((a, b) => {
        const ap = pinnedIds.has(a.id) ? 1 : 0;
        const bp = pinnedIds.has(b.id) ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return a.updatedAt < b.updatedAt ? 1 : -1;
      });
    }
    return list.sort((a, b) => {
      const at = a.items[0]?.updatedAt ?? "";
      const bt = b.items[0]?.updatedAt ?? "";
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return at < bt ? 1 : -1;
    });
  }, [filteredSessions, workspaces, hiddenWorkspaces, appSettings?.pinnedSessions]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || !cwd) {
      setFileHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void window.api.searchFiles(cwd, q).then(setFileHits);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, cwd]);

  const addWorkspace = async () => {
    const dir = await window.api.pickDirectory();
    if (!dir) return;
    const next = [...(appSettings?.workspaces ?? [])];
    if (!next.includes(dir)) next.push(dir);
    const hidden = (appSettings?.hiddenWorkspaces ?? []).filter((w) => w !== dir);
    const saved = await window.api.saveSettings({ workspaces: next, hiddenWorkspaces: hidden });
    setAppSettings(saved);
  };

  const removeWorkspace = async (dir: string) => {
    const next = (appSettings?.workspaces ?? []).filter((w) => w !== dir);
    const hidden = [...(appSettings?.hiddenWorkspaces ?? []), dir];
    const saved = await window.api.saveSettings({ workspaces: next, hiddenWorkspaces: hidden });
    setAppSettings(saved);
  };

  const enterWorkspace = async (dir: string) => {
    setItems([]);
    setConfigOptions([]);
    setSessionId(null);
    setStatus("connecting");
    await window.api.start({ agentId, cwd: dir });
  };

  const insertPath = (path: string) => {
    setDraft((prev) => (prev ? `${prev} ${path}` : path));
    setQuery("");
    setFileHits([]);
  };
  const wsName = (cwd: string) => appSettings?.workspaceNames?.[cwd] || cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;

  const renameWorkspace = async (cwd: string, value: string) => {
    const name = value.trim();
    setWsEditing(null);
    const next = { ...(appSettings?.workspaceNames ?? {}) };
    if (name) next[cwd] = name;
    else delete next[cwd];
    const saved = await window.api.saveSettings({ workspaceNames: next });
    setAppSettings(saved);
  };

  const removeWorkspaceByPath = async (cwd: string) => {
    const pinned = (appSettings?.workspaces ?? []).includes(cwd);
    const names = { ...(appSettings?.workspaceNames ?? {}) };
    delete names[cwd];
    const nextWorkspaces = pinned ? (appSettings?.workspaces ?? []).filter((w) => w !== cwd) : (appSettings?.workspaces ?? []);
    const hidden = pinned ? (appSettings?.hiddenWorkspaces ?? []) : [...(appSettings?.hiddenWorkspaces ?? []), cwd];
    const saved = await window.api.saveSettings({
      workspaces: nextWorkspaces,
      workspaceNames: names,
      hiddenWorkspaces: hidden,
    });
    setAppSettings(saved);
  };
  const forkTurn = async (turnId: string) => {
    const idx = items.findIndex((i) => i.id === turnId);
    if (idx < 0) return;
    let userText = "";
    for (let i = idx; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "user") { userText = it.text; break; }
    }
    setItems([]);
    setTotalTokens(0);
    setSessionCost(0);
    setSessionTurnBase(0);
    setDraft(userText);
    setFailedText(null);
    setRunning(false);
    const history = items
      .slice(0, idx)
      .filter((it) => it.kind === "user" || it.kind === "assistant")
      .map((it) => `${it.kind === "user" ? "用户" : "助手"}：${(it as { text: string }).text}`)
      .join("\n")
      .slice(-6000);
    await window.api.start({ agentId, cwd });
    if (history && userText) {
      setDraft("");
      await window.api.prompt(
        `[以下是从另一个会话分叉过来的历史，供你了解上下文]\n${history}\n\n[请继续处理：]\n${userText}`,
      );
    }
  };
  const rollbackTurn = async (turnId: string) => {
    const idx = items.findIndex((i) => i.id === turnId);
    if (idx < 0) return;
    let userIdx = -1;
    for (let i = idx; i >= 0; i--) {
      if (items[i].kind === "user") {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return;
    const text = items[userIdx].kind === "user" ? (items[userIdx] as { text: string }).text : "";
    const rangeIds = items.slice(userIdx).filter((it) => it.kind === "user").map((it) => it.id);
    const restore = sessionIdRef.current
      ? await window.api.restoreCheckpointRange(sessionIdRef.current, rangeIds)
      : { restored: 0, removed: 0, failed: 0 };
    setItems(items.slice(0, userIdx));
    if (restore.restored || restore.removed || restore.failed) {
      setItems((prev) => [
        ...prev,
        {
          kind: "note",
          id: `note-${Date.now()}`,
          text: `已回退：恢复 ${restore.restored} 个文件${restore.removed ? `、删除 ${restore.removed} 个新建文件` : ""}${restore.failed ? `、${restore.failed} 个失败` : ""}（agent 上下文已重置，历史仅本地保留）`,
        },
      ]);
    }
    setDraft(text);
    setFailedText(null);
    setRunning(false);
    // 新开会话清空 agent 上下文，但保留界面上的历史
    await window.api.start({ agentId, cwd });
  };
  const toggleWs = (key: string) =>
    setCollapsedWs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const expandWs = (key: string) => setExpandedWs((prev) => new Set(prev).add(key));

  const pinnedSet = new Set(appSettings?.pinnedSessions ?? []);
  const togglePin = async (id: string) => {
    const list = appSettings?.pinnedSessions ?? [];
    const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    const saved = await window.api.saveSettings({ pinnedSessions: next });
    setAppSettings(saved);
  };
  const statusFor = (id: string): "" | "running" | "permission" | "failed" => {
    if (id === sessionId) {
      if (permission) return "permission";
      if (running) return "running";
      if (status === "error") return "failed";
      return "";
    }
    const t = tasks.find((x) => x.id === id);
    if (!t) return "";
    if (t.status === "permission") return "permission";
    if (t.status === "failed") return "failed";
    if (t.busy || t.status === "running") return "running";
    return "";
  };
  const renderSessionRow = (s: SessionMeta) => {
    const hit = hitMap.get(s.id);
    return (
      <div key={s.id} className={`session-item ${s.id === sessionId ? "active" : ""}`}>
        {editing?.id === s.id ? (
          <input
            autoFocus
            className="rename-input"
            value={editing.title}
            onChange={(e) => setEditing({ id: s.id, title: e.target.value })}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename();
              if (e.key === "Escape") setEditing(null);
            }}
          />
        ) : (
          <button
            className="session-main"
            onClick={() => void openSession(s)}
            onDoubleClick={() => setEditing({ id: s.id, title: s.title })}
            title={`${s.cwd}\n${s.agentId}\n双击重命名`}
          >
            <div className="session-name">
              {s.title || "新会话"}
              {(() => {
                const st = statusFor(s.id);
                if (!st) return null;
                const label = st === "running" ? "运行中" : st === "permission" ? "待授权" : "失败";
                return <span className={`sess-badge ${st}`}>{label}</span>;
              })()}
            </div>
            <div className="session-meta">
              {relTime(s.updatedAt)}
              {hit ? ` · ${hit.count} 条匹配` : ""}
            </div>
            {hit?.snippet ? <div className="session-snippet">{hit.snippet}</div> : null}
          </button>
        )}
        <div className="session-actions">
          <button onClick={() => void togglePin(s.id)} title={pinnedSet.has(s.id) ? "取消置顶" : "置顶"}>
            {pinnedSet.has(s.id) ? "★" : "☆"}
          </button>
          <button onClick={() => setEditing({ id: s.id, title: s.title })} title="重命名">
            ✎
          </button>
          <button onClick={() => void removeSession(s)} title="删除">
            ✕
          </button>
        </div>
      </div>
    );
  };
  useEffect(() => {
    let alive = true;
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void window.api.searchMessages(q).then((result) => {
        if (alive) setHits(result);
      });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);

  const commands: PaletteCommand[] = useMemo(() => {
    const list: PaletteCommand[] = [
      { id: "new", label: "新会话", hint: "Ctrl+N", run: () => void newSession() },
      { id: "shot", label: "截屏提问", hint: "Ctrl+Shift+A", run: () => void window.api.startScreenshot() },
      { id: "dir", label: "切换工作目录…", run: () => void changeDir() },
      { id: "theme", label: `切换主题（当前：${theme === "dark" ? "深色" : "浅色"}）`, run: () => setTheme(theme === "dark" ? "light" : "dark") },
      { id: "bg-solid", label: `背景：纯色${bgMode === "solid" ? "（当前）" : ""}`, run: () => setBgMode("solid") },
      { id: "bg-wall", label: `背景：桌面壁纸${bgMode === "wallpaper" ? "（当前）" : ""}`, run: () => setBgMode("wallpaper") },
      { id: "bg-custom", label: `背景：选择图片…${bgMode === "custom" ? "（当前）" : ""}`, run: () => void chooseWallpaper() },
      { id: "skills", label: "打开技能面板", run: () => setView("skills") },
      { id: "settings", label: "打开设置", run: () => setView("settings") },
      { id: "copy", label: "复制整段对话（Markdown）", run: () => void copyTranscript() },
      { id: "bottom", label: "滚动到底部", run: () => { scrollGuard.current = Date.now() + 600; stickToBottom.current = true; const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; setAtBottom(true); } },
    ];
    if (failedText) list.unshift({ id: "retry", label: "重试上一条", run: () => void send(failedText) });
    for (const a of detectedAgents) {
      list.push({ id: `agent-${a.id}`, label: `切换到 Agent：${a.name}`, run: () => void newSession(a.id) });
    }
    for (const skill of skillList.slice(0, 20)) {
      list.push({
        id: `skill-${skill.name}`,
        label: `技能：${skill.name}`,
        run: () => useSkill(skill),
      });
    }    for (const s of sessions.slice(0, 5)) {
      list.push({ id: `open-${s.id}`, label: `打开会话：${s.title}`, run: () => void openSession(s) });
    }
    return list;
  }, [agents, detectedAgents, failedText, sessions, skillList, theme]);

  const filteredCommands = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
  }, [commands, paletteQuery]);

  useEffect(() => {
    setPaletteIndex(0);
  }, [paletteQuery, paletteOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        setPaletteQuery("");
      } else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void newSession();
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession]);

  const runCommand = (cmd: PaletteCommand) => {
    setPaletteOpen(false);
    setPaletteQuery("");
    cmd.run();
  };

  return (
    <div className="app" data-view={view}>
      {bgMode !== "solid" ? (
        <div className="bg-layer">
          {bgMode === "we" && appSettings?.weWallpaper?.media && appSettings.weWallpaper.type === "video" ? (
            <video
              src={window.api.mediaUrl(appSettings.weWallpaper.media)}
              autoPlay
              muted
              loop
              playsInline
            />
          ) : bgMode === "we" && appSettings?.weWallpaper?.preview ? (
            <img src={window.api.mediaUrl(appSettings.weWallpaper.preview)} alt="" />
          ) : bgMode === "we" && appSettings?.weWallpaper?.media ? (
            <img src={window.api.mediaUrl(appSettings.weWallpaper.media)} alt="" />
          ) : wallpaper ? (
            <img src={wallpaper} alt="" />
          ) : null}
          <div className="bg-shade" />
        </div>
      ) : null}


        <aside className="sidebar">
          <div className="brand">
          <span className="logo" />
          <span className="brand-name">OT</span>
          <span className={`phone-state ${phoneOnline ? "on" : ""}`} title={phoneOnline ? "手机已连接" : "手机未连接"}>
            <Icon name="phone" size={12} />
            {phoneOnline ? "已连接" : "未连接"}
          </span>
          <span className={`dot ${status}`} />
        </div>

          <div className="side-nav">
            <button className="nav-item" onClick={() => void newSession(agentId)} title="新建对话（Ctrl+N）">
              <Icon name="plus" size={15} />
              新建对话
            </button>
            <button
              className={`nav-item ${view === "skills" ? "on" : ""}`}
              onClick={() => setView("skills")}
              title="技能（SKILL.md）"
            >
              <Icon name="sparkle" size={15} />
              技能
            </button>
            <button
              className={`nav-item ${view === "chat" ? "on" : ""}`}
              onClick={() => setView("chat")}
              title="会话"
            >
              <Icon name="chat" size={15} />
              会话
            </button>
            <button className="nav-item" onClick={() => setTasksOpen(true)} title="后台任务">
              <Icon name="fork" size={15} />
              任务
            </button>

          </div>
          {view === "chat" ? (
            <>
              <input
                className="search"
                placeholder="搜索会话…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="side-tools">
                <span className="tool-label">工作区</span>
                <button className="tool-btn" onClick={() => void addWorkspace()} title="添加工作区">
                  <Icon name="plus" size={13} />
                </button>
              </div>

              {fileHits.length ? (
                <div className="file-hits">
                  <div className="hits-title">
                    文件 <span>{fileHits.length}</span>
                  </div>
                  {fileHits.slice(0, 8).map((f) => (
                    <button key={f.path} className="file-hit" onClick={() => insertPath(f.path)} title={f.path}>
                      <span className="file-hit-name">{f.name}</span>
                      <span className="file-hit-dir">
                        {f.path.slice(cwd ? cwd.length + 1 : 0).split(/[\\/]/).slice(0, -1).join("/")}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="session-list">
                {filteredSessions.length === 0 ? (
                  <div className="side-empty">{query ? "没有匹配的会话" : "还没有历史会话"}</div>
                ) : null}
                {query.trim().length >= 2 && contentHits.length > 0 ? (
                  <div className="side-hits">
                    <div className="side-hits-head">内容匹配 · {contentHits.length}</div>
                    {contentHits.slice(0, 8).map((h) => {
                      const meta = sessions.find((x) => x.id === h.id);
                      return (
                        <button
                          key={`${h.id}-${h.snippet.slice(0, 12)}-${Math.random()}`}
                          className="side-hit"
                          onClick={() => {
                            if (meta) void openSession(meta);
                          }}
                          title={h.cwd}
                        >
                          <span className="side-hit-title">{h.title}</span>
                          <span className="side-hit-snippet">{h.snippet}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}                {groups.map((g) => {
                  const open = !collapsedWs.has(g.key);
                  const pinnedCount = g.items.filter((x) => pinnedSet.has(x.id)).length;
                  const limit = expandedWs.has(g.key) ? g.items.length : Math.max(4, pinnedCount);
                  return (
                    <div className="ws" key={g.key}>
                      <div
                        className={`ws-head ${g.cwd === cwd ? "current" : ""}`}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setWsMenu({
                            x: e.clientX,
                            y: e.clientY,
                            cwd: g.cwd,
                            name: wsName(g.cwd),
                            pinned: g.pinned,
                          });
                        }}
                      >
                        {wsEditing?.cwd === g.cwd ? (
                          <input
                            autoFocus
                            className="ws-rename"
                            value={wsEditing.value}
                            onChange={(e) => setWsEditing({ cwd: g.cwd, value: e.target.value })}
                            onBlur={() => void renameWorkspace(g.cwd, wsEditing.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void renameWorkspace(g.cwd, wsEditing.value);
                              if (e.key === "Escape") setWsEditing(null);
                            }}
                          />
                        ) : (
                          <button className="ws-toggle" onClick={() => toggleWs(g.key)} title={g.cwd}>
                            <span className={`ws-caret ${open ? "open" : ""}`}>
                              <Icon name="chevron" size={11} />
                            </span>
                            <span className="ws-icon">
                              <Icon name="folder" size={13} />
                            </span>
                            <span className="ws-name">{wsName(g.cwd)}</span>
                          </button>
                        )}
                        <span className="ws-count">{g.items.length}</span>
                        <button
                          className="ws-add"
                          title="在此工作区新建对话"
                          onClick={() => void enterWorkspace(g.cwd)}
                        >
                          <Icon name="plus" size={12} />
                        </button>
                      </div>
                      {open ? (
                        <>
                          {g.items.slice(0, limit).map((s) => renderSessionRow(s))}
                          {g.items.length > limit ? (
                            <button className="ws-more" onClick={() => expandWs(g.key)}>
                              展开其余 {g.items.length - limit} 个会话
                            </button>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="side-hint">
              技能是 SKILL.md 能力包，agent 会自己判断何时使用。
            </div>
          )}
          <div className="side-bottom">
            <span className="version">v1.75.0</span>
            <button
              className="foot-btn icon-only"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              title={theme === "dark" ? "切换到浅色" : "切换到深色"}
            >
              <Icon name={theme === "dark" ? "moon" : "sun"} size={14} />
            </button>
            <button
              className={`foot-btn ${view === "settings" ? "on" : ""}`}
              onClick={() => setView("settings")}
              title="设置"
            >
              <Icon name="gear" size={14} />
              设置
            </button>
          </div>
        </aside>
      {tasksOpen ? (
        <div className="task-modal" onClick={() => setTasksOpen(false)}>
          <div className="task-card" onClick={(e) => e.stopPropagation()}>
            <div className="task-head">
              <span>后台任务</span>
              <button className="ghost" onClick={() => setTasksOpen(false)}>关闭</button>
            </div>
            {taskNotice ? <div className="task-notice" role="status">{taskNotice}</div> : null}
            {tasks.length === 0 ? <div className="side-empty">没有正在运行的后台会话</div> : null}
            {tasks.map((t) => (
              <div className="task-row" key={t.id}>
                <div className="task-main">
                  <div className="task-title">{t.title}</div>
                  <div className="task-sub">{t.cwd} · {t.busy ? "运行中" : "空闲"}</div>
                </div>
                <button className="ghost" onClick={async () => {
                  setTaskNotice("");
                  const meta = await window.api.openTask(t.id);
                  if (!meta) {
                    setTaskNotice("任务仍在运行，暂不切换会话；完成后可查看结果。");
                    return;
                  }
                  setTasksOpen(false);
                  void openSession(meta);
                }}>查看</button>
                <button className="ghost" onClick={async () => {
                  await window.api.cancelTask(t.id);
                  setTasks(await window.api.listTasks());
                }}>停止</button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="right">
      <header className="topbar">


        <div className="topbar-title">{sessionTitle}</div>
        <div className="spacer" />
      </header>


        <main className="main" ref={scrollRef} onScroll={onScroll}>
          {view === "skills" ? (
            <SkillsPanel
              skills={skillList}
              query={skillQuery}
              onQuery={setSkillQuery}
              onReload={() => void loadSkills()}
              onUse={useSkill}
              onOpen={(path) => void window.api.openPath(path)}
            />          ) : view === "settings" ? (
            <SettingsPanel
              settings={appSettings}
              models={models}
              modes={modes}
              agents={agents}
              onChange={(patch) => void updateSettings(patch)}
              onPickCwd={async () => {
                const dir = await window.api.pickDirectory();
                if (dir) await updateSettings({ defaultCwd: dir });
              }}
              onPickWe={() => void openWePicker()}
              onPickBackground={async () => {
                const picked = await window.api.pickImage();
                if (!picked) return;
                await updateSettings({ background: "custom", customBackgroundPath: picked.path });
              }}
              onOpenDataDir={() => void window.api.openDataDir()}
              onBack={() => setView("chat")}
              currentAgent={agentId}
              onSwitchAgent={(id) => void newSession(id)}
              onClearSessions={async () => {
                if (!window.confirm("清空所有本地会话记录？\n（不影响 agent 自己的会话文件）")) return;
                await window.api.clearSessions();
                const cleared = await window.api.saveSettings({ pinnedSessions: [] });
                setAppSettings(cleared);
                setItems([]);
                setSessionId(null);
                await refreshSessions();
              }}
            />
          ) : items.length === 0 ? (
            <div className="empty">
              <h1>开始对话</h1>
              <p>omp 会在你选择的工作目录里干活。工具调用、命令输出、授权请求都会显示在这里。</p>
              <p className="empty-sub">
                {agents.find((a) => a.id === agentId)?.name ?? agentId}
                {modelLabel ? ` · ${modelLabel}` : ""} · Ctrl+K 打开命令面板
              </p>
            </div>
          ) : (
            items.filter((item) => item.kind !== "tool" || appSettings?.showTools).map((item, i) => (
              <Fragment key={item.id}>
                <Message item={item} onRollback={(id) => void rollbackTurn(id)} onFork={(id) => void forkTurn(id)} reasoning={appSettings?.reasoningDisplay ?? "summary"} />
                {rails.get(i)?.length ? (
                  <FileRail
                    files={rails.get(i)!}
                    onMenu={(e, file) => setFileMenu({ x: e.clientX, y: e.clientY, path: file.path, name: file.name })}
                  />
                ) : null}
              </Fragment>
            ))
          )}
        {!atBottom && items.length > 0 ? (
          <button
            className="to-bottom"
            onClick={() => {
              scrollGuard.current = Date.now() + 600;
              stickToBottom.current = true;
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
              setAtBottom(true);
            }}
          >
            ↓ 回到最新
          </button>
        ) : null}
        </main>

        {turnList.length > 1 ? (
          <div className="turn-rail">
            {turnList.map((t) => (
              <button
                key={t.id}
                className={`turn-tick ${activeTurn === t.id ? "on" : ""}`}
                title={t.label}
                onClick={() => jumpToTurn(t.id)}
              />
            ))}
          </div>
        ) : null}

      <footer className="composer-wrap">
        {configNotice ? <div className="composer-notice" role="status">{configNotice}<button className="ghost" onClick={() => setConfigNotice("")}>关闭</button></div> : null}
        {failedText ? (
          <div className="retry-bar">
            <span>上一条失败了</span>
            <button className="btn small" onClick={() => void send(failedText)}>
              重试
            </button>
            <button className="btn small muted" onClick={() => setFailedText(null)}>
              忽略
            </button>
          </div>
        ) : null}

        {showLogs ? (
          <div className="logs-pop">
            {logs.length === 0 ? (
              <div className="log">（无）</div>
            ) : (
              logs.map((l, i) => (
                <div className="log" key={i}>
                  {l}
                </div>
              ))
            )}
          </div>
        ) : null}

                <div className="composer-meta">
          <button className="meta-pill" onClick={() => void changeDir()} title={cwd || "选择工作目录"}>
            <Icon name="folder" size={13} />
            <span className="meta-label">{cwd.split(/[\\/]/).filter(Boolean).pop() || "选择工作区"}</span>
            <Icon name="chevron" size={11} />
          </button>
          {modes?.options?.length ? (
            <Select
              className="mode"
              icon={<Icon name="sliders" size={13} />}
              value={String(modes.currentValue ?? "")}
              options={modes.options.map((o) => ({
                ...o,
                name: o.value === "default" ? "标准模式" : o.value === "plan" ? "计划模式" : o.name,
              }))}
              onChange={(v) => void setConfig(modes.id, v)}
              title="模式"
            />
          ) : null}
        </div>
        <div className={`think-badge ${running ? "on" : ""}`}>
          <span className="think-orb" />
          <span className="think-text">{progressLabel || "OT Thinking…"}</span>
          {running ? <span className="think-time">{formatElapsed(elapsedSec)}</span> : null}
        </div>
        {pendingQueue.length ? (
          <div className="queue-bar">
            <div className="queue-head">
              <span>{queuePaused ? "待发（已暂停）" : "待发"}</span>
              <span className="queue-count">{pendingQueue.length} 条</span>
              <span className="spacer" />
              <button className="ghost" onClick={() => setQueuePaused((v) => !v)}>{queuePaused ? "继续" : "暂停"}</button>
              <button className="ghost" onClick={() => setPendingQueue([])}>清空</button>
            </div>
            {pendingQueue.map((item, i) => (
              <div className="queue-item" key={item.id}>
                <span className="queue-index">{i + 1}</span>
                <textarea
                  className="queue-text"
                  value={item.text}
                  rows={1}
                  onChange={(e) =>
                    setPendingQueue((cur) => cur.map((x) => (x.id === item.id ? { ...x, text: e.target.value } : x)))
                  }
                />
                {item.files.length ? <span className="queue-files">{item.files.length} 个文件</span> : null}
                <button className="ghost" onClick={() => setPendingQueue((cur) => cur.filter((x) => x.id !== item.id))} title="移除这条">
                  移除
                </button>
              </div>
            ))}
          </div>
        ) : null}        <div
          className="composer"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            const dropped = Array.from(e.dataTransfer.files);
            const images = dropped.filter((f) => f.type.startsWith("image/"));
            if (images.length) {
              e.preventDefault();
              void addImages(images);
            }
          }}
        >
          {attachments.length || files.length ? (
            <div className="attachments">
              {attachments.map((a, i) => (
                <div className="attachment" key={`img-${i}`}>
                  <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name ?? "image"} />
                  <button onClick={() => setAttachments((prev) => prev.filter((_, k) => k !== i))} title="移除">
                    ×
                  </button>
                </div>
              ))}
              {files.map((f, i) => (
                <div className="file-chip" key={`f-${i}`} title={f}>
                  <span className="file-name">{f.split(/[\\/]/).pop()}</span>
                  <button onClick={() => setFiles((prev) => prev.filter((_, k) => k !== i))} title="移除">
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <textarea
            ref={inputRef}
            className="composer-input"
            value={draft}
            placeholder={status === "ready" ? "发消息或创建任务，/ 调用指令，@ 文件或对话" : "等待会话就绪…"}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
              if (!pasted.length) return;
              e.preventDefault();
              void addImages(pasted);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                enqueueDraft();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            disabled={!sessionId}
          />

          <div className="composer-toolbar">
            <div className="ct-left">
              <div className="plus-wrap">
                <button className="icon-btn" onClick={() => setPlusOpen((v) => !v)} title="更多" aria-label="更多">
                  <Icon name="plus" size={16} />
                </button>
                {plusOpen ? (
                  <>
                    <div className="plus-backdrop" onClick={() => setPlusOpen(false)} />
                    <div className="plus-menu">
                      <button
                        onClick={async () => {
                          setPlusOpen(false);
                          const picked = await window.api.pickFiles();
                          if (picked.length) setFiles((prev) => [...prev, ...picked].slice(0, 12));
                        }}
                      >
                        <Icon name="folder" size={14} />
                        上传文件…
                      </button>
                      <button
                        onClick={async () => {
                          setPlusOpen(false);
                          const picked = await window.api.pickImage();
                          if (picked) {
                            const comma = picked.dataUrl.indexOf(",");
                            setAttachments((prev) =>
                              [
                                ...prev,
                                {
                                  data: picked.dataUrl.slice(comma + 1),
                                  mimeType: picked.dataUrl.slice(5, picked.dataUrl.indexOf(";")),
                                  name: picked.path.split(/[\\/]/).pop() ?? "image",
                                },
                              ].slice(0, 6),
                            );
                          }
                        }}
                      >
                        <Icon name="image" size={14} />
                        上传图片…
                      </button>
                      <button
                        onClick={() => {
                          setPlusOpen(false);
                          void changeDir();
                        }}
                      >
                        <Icon name="folder" size={14} />
                        切换工作目录…
                      </button>
                      <button
                        onClick={() => {
                          setPlusOpen(false);
                          setView("skills");
                        }}
                      >
                        <Icon name="sparkle" size={14} />
                        技能
                      </button>
                      <button
                        onClick={() => {
                          setPlusOpen(false);
                          setPaletteOpen(true);
                        }}
                      >
                        <Icon name="command" size={14} />
                        命令面板
                      </button>
                      <button
                        onClick={() => {
                          setPlusOpen(false);
                          setShowLogs((v) => !v);
                        }}
                      >
                        <Icon name="terminal" size={14} />
                        日志
                      </button>
                    </div>
                  </>
                ) : null}
              </div>

              <Select
                className="perm"
                icon={<Icon name="shield" size={13} />}
                value={approval}
                options={[
                  { value: "ask", name: "询问权限" },
                  { value: "auto", name: "完全权限" },
                ]}
                onChange={(mode) => {
                  setApproval(mode as "ask" | "auto");
                  void window.api.setApprovalMode(mode as "ask" | "auto");
                }}
                title="工具调用权限"
              />
            </div>

            <div className="ct-right">
              {models?.options?.length ? (
                <Select
                  className="model"
                  value={String(models.currentValue ?? "")}
                  options={modelOptions}
                  onChange={(v) => void setConfig(models.id, v)}
                  title="模型"
                />
              ) : null}
              {usage.used ? (
                <span className="ctx-pill" title={`上下文 ${usage.used} / ${usage.size ?? "?"}`}>
                  {fmtTokens(usage.used)}
                </span>
              ) : null}
              {thinking?.options?.length ? (
                <Select
                  className="think"
                  value={String(thinking.currentValue ?? "")}
                  options={thinking.options}
                  onChange={(v) => void setConfig(thinking.id, v)}
                  title="速率 / 思考档位"
                />
              ) : null}
              {running ? (
                <>
                  <button
                    className="send-icon queue"
                    onClick={enqueueDraft}
                    disabled={!draft.trim() && !files.length}
                    title="加入待发（本轮结束后按顺序发送）"
                  >
                    <Icon name="plus" size={15} />
                  </button>
                  <button className="send-icon stop" onClick={() => void stop()} title="停止">
                    <Icon name="stop" size={14} />
                  </button>
                </>
              ) : (
                <button
                  className="send-icon"
                  onClick={() => void send()}
                  disabled={(!draft.trim() && attachments.length === 0 && files.length === 0) || !sessionId}
                  title="发送"
                >
                  <Icon name="arrow-up" size={15} />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="statusbar expanded">
          <span className={`state ${status}`}>
            {status === "ready" ? "就绪" : status === "running" ? "运行中" : status === "connecting" ? "连接中" : status === "exited" ? "已退出" : "出错"}
          </span>
          <span className="stat ring-stat" title={`上下文 ${fmtTokens(usage.used ?? 0)} / ${usage.size ? fmtTokens(usage.size) : "?"}`}>
            <svg width="16" height="16" viewBox="0 0 16 16" className="ctx-ring">
              <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2" />
              <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${Math.min(100, ctxPct) * 0.402} 100`} transform="rotate(-90 8 8)" />
            </svg>
            <span className="muted">{ctxPct.toFixed(0)}%</span>
          </span>
          <span className="stat" title="本次会话花费">
            <MiniIcon kind="coin" /> ${cost.toFixed(4)}
          </span>
          {running && liveSpeed > 0 ? (
            <span className="stat live" title="实时输出速度">
              <MiniIcon kind="bolt" /> ~{liveSpeed >= 10 ? liveSpeed.toFixed(0) : liveSpeed.toFixed(1)} tok/s
            </span>
          ) : stats.speed ? (
            <span className="stat" title="本回合速度">
              <MiniIcon kind="bolt" /> {stats.speed >= 10 ? stats.speed.toFixed(0) : stats.speed.toFixed(1)} tok/s
            </span>
          ) : null}
          {(stats.cachePct ?? 0) > 0 ? (
            <span className="stat" title="缓存命中率">
              <MiniIcon kind="db" /> {stats.cachePct.toFixed(0)}%
            </span>
          ) : null}
          <span className="stat" title="会话累计">
            <MiniIcon kind="sum" /> {fmtTokens(totalTokens)} tok · {turnCount} 轮
          </span>
          {appSettings?.deepseekPricing ? (
            <span className="stat" title="DeepSeek 计费时段">
              <MiniIcon kind="clock" /> {isOffPeak ? "谷时" : "峰时"}
            </span>
          ) : null}
          <span className="stat" title="余额">
            <MiniIcon kind="wallet" />
            {balance.total != null
              ? `${balance.currency === "USD" ? "$" : "¥"}${balance.total.toFixed(2)}`
              : `$${Math.max(0, (appSettings?.balanceStart ?? 0) - cost).toFixed(2)}`}
          </span>
          <span className="spacer" />
          <span className="stat muted">ACP · {agentId}</span>
        </div>
      </footer>
      </div>
      {wePicker ? (
        <div className="modal-backdrop" onClick={() => setWePicker(false)}>
          <div className="we-picker" onClick={(e) => e.stopPropagation()}>
            <div className="we-head">
              <span>Wallpaper Engine 壁纸</span>
              <span className="we-count">{weList.length} 个</span>
            </div>
            <div className="we-grid">
              {weList.length === 0 ? <div className="we-empty">没有找到壁纸（检查 Steam 库或 431960 创意工坊目录）</div> : null}
              {weList.map((w) => (
                <button key={w.id} className="we-item" onClick={() => void selectWe(w)} title={`${w.title}\n${w.type}`}>
                  <div className="we-thumb">
                    {w.preview ? (
                      <img src={window.api.mediaUrl(w.preview)} alt="" />
                    ) : (
                      <div className="we-none">无预览</div>
                    )}
                    <span className={`we-type ${w.type}`}>{w.type || "?"}</span>
                  </div>
                  <div className="we-title">{w.title}</div>
                </button>
              ))}
            </div>
            <div className="we-foot">
              视频壁纸静音循环播放；场景 / 网页壁纸暂用预览图代替。
            </div>
          </div>
        </div>
      ) : null}
      {wsMenu ? (
        <>
          <div
            className="ctx-backdrop"
            onClick={() => setWsMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setWsMenu(null);
            }}
          />
          <div className="ctx-menu" style={{ left: wsMenu.x, top: wsMenu.y }}>
            <button
              className="ctx-item"
              onClick={() => {
                setWsEditing({ cwd: wsMenu.cwd, value: wsMenu.name });
                setWsMenu(null);
              }}
            >
              重命名…
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                void window.api.openPath(wsMenu.cwd);
                setWsMenu(null);
              }}
            >
              在资源管理器中打开
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                void navigator.clipboard.writeText(wsMenu.cwd);
                setWsMenu(null);
              }}
            >
              复制路径
            </button>
            {
              <>
                <div className="ctx-sep" />
                <button
                  className="ctx-item danger"
                  onClick={() => {
                    void removeWorkspaceByPath(wsMenu.cwd);
                    setWsMenu(null);
                  }}
                >
                  移除工作区
                </button>
              </>
            }
          </div>
        </>
      ) : null}
      {fileMenu ? (
        <>
          <div
            className="ctx-backdrop"
            onClick={() => setFileMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setFileMenu(null);
            }}
          />
          <div className="ctx-menu" style={{ left: fileMenu.x, top: fileMenu.y }}>
            <button
              className="ctx-item"
              onClick={() => {
                void window.api.openPath(fileMenu.path);
                setFileMenu(null);
              }}
            >
              打开
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                void window.api.openWith(fileMenu.path);
                setFileMenu(null);
              }}
            >
              打开方式…
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                void window.api.revealInFolder(fileMenu.path);
                setFileMenu(null);
              }}
            >
              打开所在文件夹
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                void navigator.clipboard.writeText(fileMenu.path);
                setFileMenu(null);
              }}
            >
              复制路径
            </button>
          </div>
        </>
      ) : null}
      {permission ? (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-kicker">需要授权</div>
            <div className="modal-title">{permission.title}</div>
            <div className="modal-actions">
              {permission.options.map((o) => (
                <button
                  key={o.optionId}
                  className={`btn ${
                    o.kind.startsWith("allow_always") ? "primary" : o.kind.startsWith("allow") ? "ok" : "muted"
                  }`}
                  onClick={() => void choose(o)}
                >
                  {o.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {paletteOpen ? (
        <div className="modal-backdrop" onClick={() => setPaletteOpen(false)}>
          <div className="palette" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              className="palette-input"
              placeholder="输入命令…"
              value={paletteQuery}
              onChange={(e) => setPaletteQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setPaletteIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setPaletteIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const cmd = filteredCommands[paletteIndex];
                  if (cmd) runCommand(cmd);
                }
              }}
            />
            <div className="palette-list">
              {filteredCommands.length === 0 ? <div className="palette-empty">没有匹配命令</div> : null}
              {filteredCommands.map((c, i) => (
                <button
                  key={c.id}
                  className={`palette-item ${i === paletteIndex ? "active" : ""}`}
                  onMouseEnter={() => setPaletteIndex(i)}
                  onClick={() => runCommand(c)}
                >
                  <span>{c.label}</span>
                  {c.hint ? <span className="palette-hint">{c.hint}</span> : null}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MiniIcon({ kind, size = 12 }: { kind: "bolt" | "db" | "sum" | "clock" | "wallet" | "coin"; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (kind) {
    case "bolt":
      return <svg {...common}><path d="M9 2 4 9h3l-1 5 5-7H8l1-5Z" /></svg>;
    case "db":
      return <svg {...common}><ellipse cx="8" cy="4" rx="4.6" ry="1.8" /><path d="M3.4 4v8c0 1 2 1.8 4.6 1.8s4.6-.8 4.6-1.8V4" /><path d="M3.4 8c0 1 2 1.8 4.6 1.8S12.6 9 12.6 8" /></svg>;
    case "sum":
      return <svg {...common}><path d="M12 3H5l4 5-4 5h7" /></svg>;
    case "clock":
      return <svg {...common}><circle cx="8" cy="8" r="5.4" /><path d="M8 4.8V8l2.2 1.6" /></svg>;
    case "wallet":
      return <svg {...common}><rect x="2.6" y="4" width="10.8" height="8.4" rx="2" /><path d="M2.6 6.4h10.8" /><circle cx="11" cy="9.4" r="0.9" fill="currentColor" stroke="none" /></svg>;
    default:
      return <svg {...common}><circle cx="8" cy="8" r="5.4" /><path d="M10 6.2c-.5-.7-1.2-1-2-1-1.2 0-2 .6-2 1.5 0 1 1 1.2 2 1.5 1.1.3 2 .6 2 1.6 0 .9-.9 1.5-2 1.5-.9 0-1.7-.4-2.1-1.1" /></svg>;
  }
}

function Icon({ name, size = 15 }: { name: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "plus":
      return (
        <svg {...common}>
          <path d="M8 3.2v9.6M3.2 8h9.6" />
        </svg>
      );
    case "arrow-up":
      return (
        <svg {...common}>
          <path d="M8 13V3.4M3.8 7.4 8 3.2l4.2 4.2" />
        </svg>
      );
    case "stop":
      return (
        <svg {...common}>
          <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="2" fill="currentColor" stroke="none" />
        </svg>
      );
    case "moon":
      return (
        <svg {...common}>
          <path d="M13 9.4A5.4 5.4 0 1 1 6.6 3 4.4 4.4 0 0 0 13 9.4Z" />
        </svg>
      );
    case "sun":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1.6v1.4M8 13v1.4M1.6 8H3M13 8h1.4M3.5 3.5l1 1M11.5 11.5l1 1M12.5 3.5l-1 1M4.5 11.5l-1 1" />
        </svg>
      );
    case "gear":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 1.8v1.4M8 12.8v1.4M2.4 8H1M15 8h-1.4M4 4l-1-1M13 13l-1-1M12 4l1-1M4 12l-1 1" />
        </svg>
      );
    case "terminal":
      return (
        <svg {...common}>
          <rect x="1.8" y="3" width="12.4" height="10" rx="2.2" />
          <path d="m4.6 6.4 2 1.6-2 1.6M8.6 10.4h3" />
        </svg>
      );
    case "chat":
      return (
        <svg {...common}>
          <path d="M13.4 7.6c0 2.7-2.4 4.9-5.4 4.9-.7 0-1.4-.1-2-.3l-2.6.9.8-2.3a4.6 4.6 0 0 1-1-2.9C3.2 5 5.6 2.8 8.6 2.8s4.8 2.2 4.8 4.8Z" />
        </svg>
      );
    case "sparkle":
      return (
        <svg {...common}>
          <path d="M8 2.6 9.3 6l3.4 1.3-3.4 1.3L8 12l-1.3-3.4L3.3 7.3 6.7 6 8 2.6Z" />
          <path d="M12.4 11.4l.6 1.4 1.4.6-1.4.6-.6 1.4" opacity=".55" />
        </svg>
      );
    case "folder":
      return (
        <svg {...common}>
          <path d="M2 5.2c0-.9.7-1.6 1.6-1.6h2l1.3 1.6h5.5c.9 0 1.6.7 1.6 1.6v4c0 .9-.7 1.6-1.6 1.6H3.6A1.6 1.6 0 0 1 2 10.8V5.2Z" />
        </svg>
      );
    case "image":
      return (
        <svg {...common}>
          <rect x="2" y="3" width="12" height="10" rx="2.2" />
          <circle cx="6" cy="6.6" r="1.1" />
          <path d="m3.4 11.4 3-2.6 2.2 1.8 2-1.6 2.2 2" />
        </svg>
      );
    case "command":
      return (
        <svg {...common}>
          <path d="M6 3.4a1.6 1.6 0 1 0-1.6 1.6H11a1.6 1.6 0 1 0-1.4-1.6v8.6A1.6 1.6 0 1 0 11 10.6H4.4A1.6 1.6 0 1 0 6 12.2V3.4Z" />
        </svg>
      );
    case "sliders":
      return (
        <svg {...common}>
          <path d="M3 5.2h10M3 10.8h10" />
          <circle cx="6.2" cy="5.2" r="1.6" fill="var(--panel)" />
          <circle cx="10" cy="10.8" r="1.6" fill="var(--panel)" />
        </svg>
      );
    case "undo":
      return (
        <svg {...common}>
          <path d="M3.2 6.4h6.1a3.2 3.2 0 0 1 0 6.4H6" />
          <path d="M5.4 3.9 2.9 6.4l2.5 2.5" />
        </svg>
      );
    case "phone":
      return (
        <svg {...common}>
          <rect x="4.6" y="1.8" width="6.8" height="12.4" rx="1.8" />
          <path d="M7 13.2h2" />
        </svg>
      );
    case "fork":
      return (
        <svg {...common}>
          <circle cx="4.5" cy="3.5" r="1.6" />
          <circle cx="4.5" cy="12.5" r="1.6" />
          <circle cx="11.5" cy="6" r="1.6" />
          <path d="M4.5 5.1v5.8M6.1 3.9h2.6c1.2 0 2 .8 2 2v.2" />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path d="M8 2.2 3.4 4v3.7c0 2.4 1.8 4.4 4.6 6.1 2.8-1.7 4.6-3.7 4.6-6.1V4L8 2.2Z" />
        </svg>
      );
    case "chevron":
      return (
        <svg {...common}>
          <path d="m4.2 6.2 3.8 3.6 3.8-3.6" />
        </svg>
      );
    default:
      return null;
  }
}
function Select({
  value,
  options,
  onChange,
  className = "",
  icon,
  title,
}: {
  value: string;
  options: { value: string; name: string }[];
  onChange: (value: string) => void;
  className?: string;
  icon?: React.ReactNode;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <div className={`ef-select ${className}`}>
      <button className="ef-select-btn" onClick={() => setOpen((v) => !v)} title={title}>
        {icon ? <span className="ef-select-icon">{icon}</span> : null}
        <span className="ef-select-label">{current?.name ?? value ?? "—"}</span>
        <span className={`ef-select-caret ${open ? "open" : ""}`}>
          <Icon name="chevron" size={11} />
        </span>
      </button>
      {open ? (
        <>
          <div className="ef-select-backdrop" onClick={() => setOpen(false)} />
          <div className="ef-select-menu">
            {options.map((o) => (
              <button
                key={o.value}
                className={`ef-select-item ${o.value === value ? "on" : ""}`}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {o.name}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
const TEXT_EXT = new Set([
  "md", "markdown", "txt", "log", "json", "jsonc", "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "css", "scss", "html", "htm", "xml", "yml", "yaml", "py", "rs", "go", "sh", "ps1", "sql",
  "toml", "ini", "csv", "env", "gitignore",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"]);

function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
}

function FileRail({
  files,
  onMenu,
}: {
  files: { path: string; name: string }[];
  onMenu: (e: React.MouseEvent, file: { path: string; name: string }) => void;
}) {
  return (
    <div className="file-rail">
      {files.map((f) => {
        const ext = extOf(f.path);
        const isImage = IMAGE_EXT.has(ext);
        return (
          <div
            className="file-card"
            key={f.path}
            title={`${f.path}\n单击打开 · 右键更多`}
            onClick={() => void window.api.openPath(f.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu(e, f);
            }}
          >
            {isImage ? (
              <img className="file-thumb" src={window.api.mediaUrl(f.path)} alt="" />
            ) : (
              <div className="file-ext">{ext ? ext.slice(0, 4).toUpperCase() : "FILE"}</div>
            )}
            <div className="file-info">
              <div className="file-name">{f.name}</div>
              <div className="file-dir">{f.path.replace(/[\\/][^\\/]+$/, "")}</div>
            </div>
            <span className="file-open-hint">↗</span>
          </div>
        );
      })}
    </div>
  );
}
function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy-btn"
      title={label}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* 复制失败不假装成功 */
        }
      }}
    >
      {done ? "已复制" : label}
    </button>
  );
}

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [done, setDone] = useState(false);
  return (
    <div className="code-wrap">
      <button
        className="code-copy"
        onClick={async () => {
          const text = ref.current?.innerText ?? "";
          try {
            await navigator.clipboard.writeText(text);
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          } catch {
            /* ignore */
          }
        }}
      >
        {done ? "已复制" : "复制代码"}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

function Message({ item, onRollback, onFork, reasoning = "summary" }: { item: Item; onRollback?: (id: string) => void; onFork?: (id: string) => void; reasoning?: "full" | "summary" | "hidden" }) {
  if (item.kind === "user") {
    return (
      <div className="msg user" id={`turn-${item.id}`}>
        {item.images?.length ? (
          <div className="bubble-images">
            {item.images.map((img, i) => (
              <img key={i} src={`data:${img.mimeType};base64,${img.data}`} alt={img.name ?? "image"} />
            ))}
          </div>
        ) : null}
        {item.text ? <div className="bubble">{item.text}</div> : null}
      </div>
    );
  }

  if (item.kind === "note") {
    const needsFix = item.text.includes("[fix-gitignore]");
    const text = item.text.replace("[fix-gitignore]", "").trimEnd();
    return (
      <div className="msg note">
        <span className="note-text">{text}</span>
        {needsFix ? (
          <button
            className="note-btn"
            onClick={() => void window.api.fixGitignore()}
            title="把命中的文件规则写进 .gitignore"
          >
            一键写入 .gitignore
          </button>
        ) : null}
      </div>
    );
  }

  if (item.kind === "turn") {
    const at = new Date(item.at);
    return (
      <div className={`turn-meta ${item.stopReason === "cancelled" ? "cancelled" : item.stopReason && item.stopReason !== "end_turn" ? "interrupted" : "completed"}`}>
        <span className="turn-check">{item.stopReason === "cancelled" ? "■" : item.stopReason && item.stopReason !== "end_turn" ? "!" : "✓"}</span>
        <span>{item.stopReason === "cancelled" ? "已停止" : item.stopReason && item.stopReason !== "end_turn" ? "已中断" : "已完成"}</span>
        <span className="turn-sep">·</span>
        <span>用时 {fmtDuration(item.ms)}</span>
        <span className="turn-sep">·</span>
        <span>{fmtTokens(item.tokens)} tok</span>
        <span className="turn-sep">·</span>
        <span>{at.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
        <button className="turn-btn" onClick={() => onRollback?.(item.id)} title="回退到这一轮之前（含文件快照）">
          <Icon name="undo" size={12} />
          回退
        </button>
        <button className="turn-btn" onClick={() => onFork?.(item.id)} title="从这一轮 fork 一个新对话">
          <Icon name="fork" size={12} />
          fork
        </button>
      </div>
    );
  }

  if (item.kind === "assistant") {
    return (
      <div className="msg assistant">
        {item.thinking && reasoning !== "hidden" ? (
          <details className="thinking" open={item.streaming}>
            <summary>{item.streaming ? "思考中…" : "思考过程（中文）"}</summary>
            <div className="thinking-body">{item.thinkingZh || item.thinking}</div>
          </details>
        ) : null}
        {item.text ? (
          <div className="markdown-wrap">
            <CopyButton text={item.text} />
            <div className="markdown">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: CodeBlock }}>{item.text}</Markdown>
            </div>
          </div>
        ) : null}
        {item.streaming && !item.text ? <div className="typing" /> : null}
      </div>
    );
  }

  const hasDetail = Boolean(item.diff || item.text);
  return (
    <details className={`tool ${item.status}`}>
      <summary className="tool-head">
        <span className="tool-icon">{item.toolKind === "execute" ? "$" : item.toolKind === "edit" ? "±" : "◆"}</span>
        <span className="tool-title">{item.title}</span>
        <span className="tool-status">{STATUS_LABEL[item.status] ?? item.status}</span>
        {hasDetail ? <span className="tool-hint">展开</span> : null}
      </summary>
      {item.diff ? <DiffView diff={item.diff} /> : null}
      {item.text && !item.diff ? <pre className="tool-output">{item.text}</pre> : null}
      {item.text && item.diff ? <pre className="tool-output">{item.text}</pre> : null}
    </details>
  );
}

function DiffView({ diff }: { diff: ToolDiff }) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => diffLines(diff.oldText ?? "", diff.newText ?? ""), [diff.oldText, diff.newText]);
  const shown = expanded ? lines : compactDiff(lines, 2);
  const added = lines.filter((l) => l.type === "add").length;
  const removed = lines.filter((l) => l.type === "del").length;

  return (
    <div className="diff">
      <div className="diff-head">
        <span className="diff-path">{diff.path}</span>
        <span className="diff-stat">
          <span className="plus">+{added}</span> <span className="minus">-{removed}</span>
        </span>
        <button className="mini" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "折叠" : "展开全部"}
        </button>
      </div>
      <div className="diff-body">
        {shown.map((l, i) =>
          l.type === "gap" ? (
            <div className="diff-line gap" key={i}>
              {l.text}
            </div>
          ) : (
            <div className={`diff-line ${l.type}`} key={i}>
              <span className="diff-no">{l.type === "add" ? "" : l.no}</span>
              <span className="diff-sign">{l.type === "add" ? "+" : l.type === "del" ? "-" : " "}</span>
              <span className="diff-text">{l.text || " "}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

const SKILL_ZH: Record<string, string> = {
  "1password": "1Password CLI：安装、登录、读取/注入密钥",
  "aminer-data-search": "AMiner 学术检索：学者、论文、机构、期刊、专利",
  "architecture-designer": "系统架构设计与评审、技术选型",
  "automation-workflows": "设计自动化工作流，减少重复劳动",
  "backtest-expert": "交易策略回测方法与稳健性检验",
  "blog-writer": "按你的风格写博客长文并发布",
  "brainstorming": "动手前先梳理需求与方案",
  "clawdefender": "提示注入/命令注入等安全检测与净化",
  "code": "编码流程：计划、实现、验证、测试",
  "content-strategy": "内容营销策略与选题日历",
  "copywriting": "落地页/邮件/广告的转化文案",
  "executing-plans": "按既定实施计划分步执行并检查",
  "feishu-chat-history": "拉取并总结飞书群聊记录",
  "feishu-cron-reminder": "定时把提醒发到飞书",
  "feishu-doc": "读取飞书文档/表格并转 Markdown",
  "feishu-perm": "飞书文档与文件的权限管理",
  "feishu-screenshot": "截图并发送到飞书",
  "feishu-send-file": "通过 API 向飞书发送文件",
  "ffmpeg-video-editor": "用自然语言生成 ffmpeg 剪辑命令",
  "find-skills": "发现并安装新的 agent 技能",
  "frontend-design": "产出有设计感的前端界面",
  "git-essentials": "Git 常用命令与分支协作",
  "interview-designer": "依据简历设计结构化面试",
  "market-research": "市场规模、竞品与机会评估",
  "obsidian-ontology-sync": "Obsidian 笔记与本体图谱双向同步",
  "opencode-controller": "用斜杠命令驱动 Opencode",
  "research-paper-writer": "按 IEEE/ACM 规范撰写学术论文",
  "security-auditor": "代码安全审计（OWASP、鉴权、注入等）",
  "self-improving": "复盘纠错，从反馈中持续改进",
  "seo": "SEO 审计、关键词与内容优化",
  "seo-content-writer": "写 SEO 友好的博客与文章",
  "session-logs": "检索并分析历史会话日志",
  "skill-creator": "创建或更新技能（SKILL.md）",
  "skill-vetter": "安装技能前的安全审查",
  "social-content": "社交媒体内容策划与排期",
  "supabase-postgres-best-practices": "Supabase / Postgres 性能最佳实践",
  "tmux": "远程操控 tmux 会话",
  "ui-ux-pro-max": "UI/UX 设计规范与界面打磨建议",
  "video-frames": "用 ffmpeg 抽帧或截取片段",
  "writing-plans": "把需求写成可执行的分步计划",
};
function SkillsPanel({
  skills,
  query,
  onQuery,
  onReload,
  onUse,
  onOpen,
}: {
  skills: SkillInfo[];
  query: string;
  onQuery: (q: string) => void;
  onReload: () => void;
  onUse: (skill: SkillInfo) => void;
  onOpen: (path: string) => void;
}) {
  const q = query.trim().toLowerCase();
  const shown = q
    ? skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    : skills;

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>技能</h2>
          <p>
            来自 agent 的技能清单（`omp skill list`）。技能是 SKILL.md 能力包，agent 会按任务自己挑用。
            共 {skills.length} 个。
          </p>
        </div>
        <div className="panel-actions">
          <button className="pill-btn" onClick={() => void window.api.openPath("https://github.com/can1357/oh-my-pi#skills")}>
            <Icon name="sparkle" size={13} />
            技能商店
          </button>
          <button className="ghost" onClick={onReload}>
            刷新
          </button>
        </div>
      </div>

      <input
        className="search"
        placeholder="搜索技能名或描述…"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />

      {shown.length === 0 ? (
        <div className="panel-empty">{skills.length === 0 ? "没有读到技能（omp skill list 返回空）" : "没有匹配的技能"}</div>
      ) : null}

      <div className="skill-list">
        {shown.map((s) => (
          <div className="skill-row" key={s.name + s.baseDir}>
            <div className="skill-main">
              <div className="skill-name">
                {s.name}
                <span className="skill-source">{s.source.replace("agents:", "")}</span>
              </div>
              <div className="skill-desc zh">{SKILL_ZH[s.name] ?? s.description}</div>
              {SKILL_ZH[s.name] ? <div className="skill-desc orig">{s.description}</div> : null}
              <div className="skill-path">{s.baseDir}</div>
            </div>
            <div className="skill-actions">
              <button className="btn small" onClick={() => onUse(s)}>
                用这个
              </button>
              <button className="btn small muted" onClick={() => onOpen(s.baseDir)} title="在资源管理器中打开目录">
                目录
              </button>
              <button className="btn small muted" onClick={() => onOpen(s.filePath)} title="打开 SKILL.md">
                文件
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
function SettingsPanel({
  settings,
  models,
  modes,
  agents,
  onChange,
  onPickCwd,
  onPickBackground,
  onPickWe,
  onOpenDataDir,
  onClearSessions,
  onBack,
  currentAgent,
  onSwitchAgent,
}: {
  settings: AppSettings | null;
  models: ConfigOption | undefined;
  modes: ConfigOption | undefined;
  agents: AgentInfo[];
  onChange: (patch: Partial<AppSettings>) => void;
  onPickCwd: () => void;
  onPickBackground: () => void;
  onPickWe: () => void;
  onOpenDataDir: () => void;
  onClearSessions: () => void;
  onBack: () => void;
  currentAgent: string;
  onSwitchAgent: (id: string) => void;
}) {
  const [version, setVersion] = useState("");
  const [remote, setRemote] = useState<RemoteStatus>({
    running: false,
    url: null,
    tunnelState: "stopped",
    tunnelUrl: null,
    error: null,
  });
  const [tunnelOn, setTunnelOn] = useState(false);
  const [cmName, setCmName] = useState("");
  const [cmBase, setCmBase] = useState("");
  const [cmId, setCmId] = useState("");
  const [cmKey, setCmKey] = useState("");
  const [cmMsg, setCmMsg] = useState("");
  const [lanList, setLanList] = useState<string[]>([]);
  const [pushMsg, setPushMsg] = useState("");
  const [health, setHealth] = useState<Record<string, boolean> | null>(null);
  const [balances, setBalances] = useState<{ provider: string; ok: boolean; amount?: number; currency?: string; error?: string; detail?: string; models?: { model: string; requests: number; cost: number; tokens: number }[] }[]>([]);
  useEffect(() => {
    void window.api.providerBalances().then(setBalances).catch(() => setBalances([]));
  }, []);
  const [schedForm, setSchedForm] = useState<{ title: string; cwd: string; prompt: string; everyMinutes: number } | null>(null);
  const [setTab, setSetTab] = useState<"general" | "models" | "balance" | "mobile" | "github" | "data">("general");

  useEffect(() => {
    if (setTab !== "mobile") return;
    void window.api.lanUrls().then(setLanList).catch(() => setLanList([]));
  }, [setTab]);

  useEffect(() => {
    void window.api.appVersion().then(setVersion).catch(() => setVersion(""));
    void window.api.remoteStatus().then((status) => {
      setRemote(status);
      setTunnelOn(status.tunnelState !== "stopped");
    });
    return window.api.onRemoteTunnel((status) => setRemote(status as unknown as RemoteStatus));
  }, []);

  if (!settings) return <div className="panel-empty">读取设置…</div>;

  const modelValue = settings.defaultModel || String(models?.currentValue ?? "");
  const modeValue = settings.defaultMode || String(modes?.currentValue ?? "");

  return (
    <div className="panel settings" data-tab={setTab}>
      <div className="settings-bar">
        <button className="settings-back" onClick={onBack}>← 返回</button>
        <span className="settings-bar-title">设置</span>
      </div>
      <div className="panel-head">
        <div>
          <h2>设置</h2>
          <p>改动即时生效并写入 `settings.json`；模型/模式的默认值会在每个新会话启动后自动套用。</p>
        </div>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav">
          {([
            ["general", "通用设置", "sliders"],
            ["models", "模型与 Agent", "sparkle"],
            ["balance", "账号与余额", "shield"],
            ["mobile", "手机访问", "phone"],
            ["github", "GitHub", "fork"],
            ["data", "数据与关于", "folder"],
          ] as const).map(([id, label, icon]) => (
            <button
              key={id}
              className={`settings-nav-item ${setTab === id ? "on" : ""}`}
              onClick={() => setSetTab(id)}
            >
              <Icon name={icon} size={14} />
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-content">

      <section className="set-group" data-cat="models">
        <h3>模型与 Agent</h3>
        <div className="set-row">
          <label>只显示官方可用模型</label>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.officialModelsOnly}
              onChange={(e) => onChange({ officialModelsOnly: e.target.checked })}
            />
            <span>{settings.officialModelsOnly ? "开启" : "关闭"}</span>
          </label>
        </div>
        <div className="set-hint">开启后，`deepseek/` 的模型会用你的 API Key 调 `/models` 校验，没开通的型号不再显示（第三方 provider 不受影响）。</div>
        <div className="set-row">
          <label>默认模型</label>
          {models?.options?.length ? (
            <select value={modelValue} onChange={(e) => onChange({ defaultModel: e.target.value })}>
              <option value="">跟随 agent 默认</option>
              {models.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="set-hint">{settings.defaultModel || "启动一个会话后可选择"}</span>
          )}
        </div>
        <div className="set-row">
          <label>默认模式</label>
          <select value={modeValue} onChange={(e) => onChange({ defaultMode: e.target.value })}>
            <option value="">跟随 agent 默认</option>
            {(modes?.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div className="set-row">
          <label>当前 Agent</label>
          <select value={currentAgent} onChange={(e) => onSwitchAgent(e.target.value)}>
            {agents
              .filter((a) => a.detected)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.version ? ` · ${a.version}` : ""}
                </option>
              ))}
          </select>
        </div>
        <div className="set-row">
          <label>默认 Agent</label>
          <select value={settings.defaultAgent} onChange={(e) => onChange({ defaultAgent: e.target.value })}>
            {agents
              .filter((a) => a.detected)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.version ? ` · ${a.version}` : ""}
                </option>
              ))}
          </select>
        </div>
        <div className="set-row">
          <label>附加目录</label>
          <div className="set-inline">
            <button
              className="ghost"
              onClick={async () => {
                const dir = await window.api.pickDirectory();
                if (!dir) return;
                const next = [...(settings.extraDirs ?? [])];
                if (!next.includes(dir)) next.push(dir);
                onChange({ extraDirs: next });
              }}
            >
              添加目录…
            </button>
            <span className="set-hint">agent 可访问的工作区之外目录（omp --add-dir）</span>
          </div>
        </div>
        {(settings.extraDirs ?? []).map((dir) => (
          <div className="set-row" key={dir}>
            <label />
            <div className="set-inline">
              <input readOnly value={dir} className="grow" />
              <button
                className="ghost danger"
                onClick={() => onChange({ extraDirs: (settings.extraDirs ?? []).filter((d) => d !== dir) })}
              >
                移除
              </button>
            </div>
          </div>
        ))}
        <div className="set-row">
          <label>prewalk（省 token）</label>
          <label className="switch">
            <input type="checkbox" checked={settings.prewalk} onChange={(e) => onChange({ prewalk: e.target.checked })} />
            <span>{settings.prewalk ? "开启" : "关闭"}</span>
          </label>
        </div>
        <div className="set-hint">
          prewalk 会在计划阶段结束后自动切到便宜模型执行，省 token；需要配置 smol 模型（omp --smol）。
        </div>
        <div className="set-row">
          <label>默认工作目录</label>
          <div className="set-inline">
            <input
              value={settings.defaultCwd}
              placeholder="留空 = 上次使用的目录"
              onChange={(e) => onChange({ defaultCwd: e.target.value })}
            />
            <button className="ghost" onClick={onPickCwd}>
              选择…
            </button>
          </div>
        </div>
      </section>

      <section className="set-group" data-cat="models">
        <h3>模型角色</h3>
        <div className="set-row">
          <label>smol（轻任务）</label>
          <input className="grow" placeholder="例如 deepseek/deepseek-flash" value={settings.smolModel} onChange={(e) => onChange({ smolModel: e.target.value })} />
        </div>
        <div className="set-row">
          <label>slow（深度推理）</label>
          <input className="grow" placeholder="例如 deepseek/deepseek-reasoner" value={settings.slowModel} onChange={(e) => onChange({ slowModel: e.target.value })} />
        </div>
        <div className="set-row">
          <label>plan（规划）</label>
          <input className="grow" placeholder="留空跟随默认" value={settings.planModel} onChange={(e) => onChange({ planModel: e.target.value })} />
        </div>
        <div className="set-hint">写入启动参数 --smol / --slow / --plan；agent 会按任务自动挑模型。</div>
      </section>

      <section className="set-group" data-cat="models">
        <h3>自定义模型（OpenAI 兼容）</h3>
        {(settings.customModels ?? []).map((m) => (
          <div className="set-row" key={m.name}>
            <label>{m.name}</label>
            <span className="set-hint">{m.modelId} · {m.baseUrl}</span>
          </div>
        ))}
        <div className="set-row">
          <label>名称</label>
          <input className="grow" placeholder="my-model" value={cmName} onChange={(e) => setCmName(e.target.value)} />
        </div>
        <div className="set-row">
          <label>Base URL</label>
          <input className="grow" placeholder="https://api.example.com/v1" value={cmBase} onChange={(e) => setCmBase(e.target.value)} />
        </div>
        <div className="set-row">
          <label>模型 ID</label>
          <input className="grow" placeholder="gpt-4o-mini" value={cmId} onChange={(e) => setCmId(e.target.value)} />
        </div>
        <div className="set-row">
          <label>API Key</label>
          <input className="grow" type="password" placeholder="sk-..." value={cmKey} onChange={(e) => setCmKey(e.target.value)} />
        </div>
        <div className="set-row">
          <label />
          <div className="set-inline">
            <button
              className="ghost"
              onClick={async () => {
                const res = await window.api.addCustomModel({ name: cmName, baseUrl: cmBase, apiKey: cmKey, modelId: cmId, api: "openai-completions" });
                if (!res.ok) { setCmMsg(res.error ?? "失败"); return; }
                const next = [...(settings.customModels ?? []), { name: cmName, baseUrl: cmBase, apiKey: cmKey, modelId: cmId, api: "openai-completions" }];
                onChange({ customModels: next });
                setCmName(""); setCmBase(""); setCmId(""); setCmKey("");
                setCmMsg("已写入 models.yml，重开会话后可用");
              }}
            >
              添加到 models.yml
            </button>
            {cmMsg ? <span className="set-hint">{cmMsg}</span> : null}
          </div>
        </div>
        <div className="set-hint">写入 ~/.omp/agent/models.yml（会留 .bak 备份），之后在模型下拉里出现。</div>
      </section>

      <section className="set-group" data-cat="github">
        <h3>GitHub</h3>
        <div className="set-row">
          <label>自动上传</label>
          <label className="switch">
            <input type="checkbox" checked={settings.githubAutoUpload} onChange={(e) => onChange({ githubAutoUpload: e.target.checked })} />
            <span>{settings.githubAutoUpload ? "开启" : "关闭"}</span>
          </label>
        </div>
        <div className="set-row">
          <label>拦截敏感文件</label>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.githubBlockSecrets}
              onChange={(e) => onChange({ githubBlockSecrets: e.target.checked })}
            />
            <span>{settings.githubBlockSecrets ? "开启" : "关闭"}</span>
          </label>
        </div>
        <div className="set-row">
          <label>立即上传一次</label>
          <div className="set-inline">
            <button
              className="ghost"
              onClick={async () => {
                const res = await window.api.uploadNow();
                setCmMsg(res.ok ? "已触发上传（看对话里的提示）" : `失败：${res.error}`);
              }}
            >
              上传当前工作区
            </button>
          </div>
        </div>        <div className="set-hint">开启后：会话里你说过「上传/推送到 GitHub」，之后每轮结束会自动 commit + push；没有远端仓库时会用本机 git 凭据自动建一个公开仓库。</div>
      </section>
      <section className="set-group" data-cat="general">
        <h3>外观</h3>
        <div className="set-row">
          <label>主题</label>
          <div className="seg">
            <button className={settings.theme === "dark" ? "on" : ""} onClick={() => onChange({ theme: "dark" })}>
              深色
            </button>
            <button className={settings.theme === "light" ? "on" : ""} onClick={() => onChange({ theme: "light" })}>
              浅色
            </button>
          </div>
        </div>
        <div className="set-row">
          <label>背景</label>
          <div className="seg">
            <button className={settings.background === "solid" ? "on" : ""} onClick={() => onChange({ background: "solid" })}>
              纯色
            </button>
            <button
              className={settings.background === "wallpaper" ? "on" : ""}
              onClick={() => onChange({ background: "wallpaper" })}
            >
              桌面壁纸
            </button>
            <button className={settings.background === "custom" ? "on" : ""} onClick={onPickBackground}>
              自选图片…
            </button>
            <button className={settings.background === "we" ? "on" : ""} onClick={onPickWe}>
              Wallpaper Engine…
            </button>
          </div>
        </div>
        <div className="set-row">
          <label>推理显示</label>
          <div className="seg">
            {(["full", "summary", "hidden"] as const).map((mode) => (
              <button
                key={mode}
                className={settings.reasoningDisplay === mode ? "on" : ""}
                onClick={() => onChange({ reasoningDisplay: mode })}
              >
                {mode === "full" ? "完整" : mode === "summary" ? "摘要" : "隐藏"}
              </button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <label>背景遮罩</label>
          <input
            type="range"
            min={10}
            max={95}
            value={Math.round((settings.bgShade ?? 0.55) * 100)}
            onChange={(e) => onChange({ bgShade: Number(e.target.value) / 100 })}
          />
          <span className="set-hint">{Math.round((settings.bgShade ?? 0.55) * 100)}%</span>
        </div>
        <div className="set-row">
          <label>背景模糊</label>
          <input
            type="range"
            min={0}
            max={40}
            value={settings.bgBlur ?? 12}
            onChange={(e) => onChange({ bgBlur: Number(e.target.value) })}
          />
          <span className="set-hint">{settings.bgBlur ?? 12}px</span>
        </div>
        <div className="set-row">
          <label>工具调用</label>
          <div className="seg">
            <button className={settings.showTools ? "on" : ""} onClick={() => onChange({ showTools: true })}>
              显示
            </button>
            <button className={!settings.showTools ? "on" : ""} onClick={() => onChange({ showTools: false })}>
              隐藏
            </button>
          </div>
        </div>
        <div className="set-row">
          <label>思考翻译</label>
          <div className="seg">
            {[["local", "本地 Ollama"], ["omp", "OMP 模型"], ["deepseek", "DeepSeek"], ["off", "不翻译"]].map(([v, label]) => (
              <button key={v} className={(settings.translateProvider ?? "local") === v ? "on" : ""} onClick={() => onChange({ translateProvider: v as any })}>
                {label}
              </button>
            ))}
          </div>
        </div>        <div className="set-row">
          <label>界面缩放</label>
          <div className="seg">
            {[0.9, 1, 1.1].map((z) => (
              <button key={z} className={settings.zoom === z ? "on" : ""} onClick={() => onChange({ zoom: z })}>
                {Math.round(z * 100)}%
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="set-group" data-cat="mobile">
        <h3>手机访问</h3>
        <div className="set-row">
          <label>局域网地址</label>
          <div className="set-inline">
            {lanList.length === 0 ? <span className="set-hint">没有检测到局域网 IPv4 地址</span> : null}
            {lanList.map((u) => (
              <button
                key={u}
                className="ghost"
                title="点击复制；手机与电脑同一 Wi-Fi 时用它更快"
                onClick={() => void navigator.clipboard.writeText(u)}
              >
                {u.replace(/\?.*/, "")}
              </button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <label>定时任务</label>
          <div className="set-inline">
            <button className="ghost" onClick={() => setSchedForm({ title: "", cwd: settings.defaultCwd || "", prompt: "", everyMinutes: 60 })}>
              添加
            </button>
            <span className="set-hint">到点自动在后台跑，结果走推送</span>
          </div>
        </div>
        {(settings.schedules ?? []).map((t) => (
          <div className="set-row" key={t.id}>
            <label>{t.title}</label>
            <span className="set-hint">
              {t.everyMinutes > 0 ? `${t.everyMinutes} 分钟一次` : t.dailyAt ? `每天 ${t.dailyAt}` : "未设频率"} · {t.enabled ? "启用" : "停用"}
            </span>
            <div className="set-inline">
              <button className="ghost" onClick={() => void window.api.runSchedule(t.id)}>
                立即运行
              </button>
              <button className="ghost" onClick={async () => {
                const next = (settings.schedules ?? []).map((x) => (x.id === t.id ? { ...x, enabled: !x.enabled } : x));
                await onChange({ schedules: next } as any);
              }}>
                {t.enabled ? "停用" : "启用"}
              </button>
              <button className="ghost" onClick={async () => {
                const next = await window.api.deleteSchedule(t.id);
                await onChange({ schedules: next } as any);
              }}>
                删除
              </button>
            </div>
          </div>
        ))}
        {schedForm ? (
          <div className="set-row">
            <label>新任务</label>
            <div className="set-inline" style={{ flexWrap: "wrap", gap: 6 }}>
              <input placeholder="名称" value={schedForm.title} onChange={(e) => setSchedForm({ ...schedForm, title: e.target.value })} />
              <input placeholder="工作目录" value={schedForm.cwd} onChange={(e) => setSchedForm({ ...schedForm, cwd: e.target.value })} />
              <input placeholder="提示词" value={schedForm.prompt} onChange={(e) => setSchedForm({ ...schedForm, prompt: e.target.value })} />
              <input type="number" min={1} style={{ width: 70 }} value={schedForm.everyMinutes} onChange={(e) => setSchedForm({ ...schedForm, everyMinutes: Number(e.target.value) })} />
              <button className="ghost" onClick={async () => {
                if (!schedForm.title || !schedForm.cwd || !schedForm.prompt) return;
                const next = await window.api.saveSchedule({
                  id: `s-${Date.now()}`,
                  title: schedForm.title,
                  cwd: schedForm.cwd,
                  prompt: schedForm.prompt,
                  everyMinutes: schedForm.everyMinutes,
                  dailyAt: "",
                  enabled: true,
                });
                await onChange({ schedules: next } as any);
                setSchedForm(null);
              }}>
                保存
              </button>
              <button className="ghost" onClick={() => setSchedForm(null)}>取消</button>
            </div>
          </div>
        ) : null}        <div className="set-row">
          <label>系统状态</label>
          <div className="set-inline">
            <button
              className="ghost"
              onClick={async () => {
                setHealth(await window.api.healthCheck());
              }}
            >
              检查
            </button>
            {health ? (
              <span className="set-hint">
                {Object.entries(health)
                  .map(([k, v]) => `${k}${v ? "✓" : "×"}`)
                  .join("  ")}
              </span>
            ) : null}
          </div>
        </div>        <div className="set-row">
          <label>手机推送</label>
          <div className="seg">
            {[["off", "关闭"], ["ntfy", "ntfy"], ["bark", "Bark"]].map(([v, label]) => (
              <button key={v} className={settings.pushProvider === v ? "on" : ""} onClick={() => onChange({ pushProvider: v as any })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {settings.pushProvider === "ntfy" ? (
          <>
            <div className="set-row">
              <label>ntfy 服务器</label>
              <input className="grow" value={settings.pushNtfyServer} onChange={(e) => onChange({ pushNtfyServer: e.target.value })} placeholder="https://ntfy.sh" />
            </div>
            <div className="set-row">
              <label>ntfy 用户名</label>
              <input className="grow" value={settings.pushNtfyUser} onChange={(e) => onChange({ pushNtfyUser: e.target.value })} placeholder="留空表示公共服务器" />
            </div>
            <div className="set-row">
              <label>ntfy 密码</label>
              <input className="grow" type="password" value={settings.pushNtfyPass} onChange={(e) => onChange({ pushNtfyPass: e.target.value })} placeholder="和手机端一致" />
            </div>            <div className="set-row">
              <label>ntfy 主题（topic）</label>
              <input className="grow" value={settings.pushNtfyTopic} onChange={(e) => onChange({ pushNtfyTopic: e.target.value })} placeholder="随便起一个，手机订阅同名主题" />
            </div>
          </>
        ) : null}
        {settings.pushProvider === "bark" ? (
          <div className="set-row">
            <label>Bark 地址</label>
            <input className="grow" value={settings.pushBarkUrl} onChange={(e) => onChange({ pushBarkUrl: e.target.value })} placeholder="https://api.day.app/你的key" />
          </div>
        ) : null}
        {settings.pushProvider !== "off" ? (
          <>
          <div className="set-row">
            <label>点击跳转</label>
            <div className="seg">
              <button className={settings.pushDeepLink !== false ? "on" : ""} onClick={() => onChange({ pushDeepLink: true })}>
                直接打开 App
              </button>
              <button className={settings.pushDeepLink === false ? "on" : ""} onClick={() => onChange({ pushDeepLink: false })}>
                打开浏览器
              </button>
            </div>
          </div>
            <div className="set-row">
              <label>点击跳转地址</label>
              <input className="grow" value={settings.pushClickBase} onChange={(e) => onChange({ pushClickBase: e.target.value })} placeholder="http://120.26.20.154:17788" />
            </div>
            <div className="set-row">
              <label />
              <div className="set-inline">
                <button
                  className="ghost"
                  onClick={async () => {
                    const r = await window.api.testPush();
                    setPushMsg(r.ok ? "已发送，检查手机" : `失败：${r.error}`);
                  }}
                >
                  发送测试推送
                </button>
                {pushMsg ? <span className="set-hint">{pushMsg}</span> : null}
              </div>
            </div>
          </>
        ) : null}        <div className="set-hint">同一 Wi-Fi 下把手机连接地址换成局域网地址，比走 Cloudflare 隧道快很多（长按手机顶部标题可修改）。</div>
        <div className="set-row">
          <label>开启远程服务</label>
          <label className="switch">
            <input
              type="checkbox"
              checked={remote.running}
              onChange={async (e) => {
                const next = e.target.checked ? await window.api.remoteStart() : await window.api.remoteStop();
                setRemote(next);
              }}
            />
            <span>{remote.running ? "已开启" : "关闭"}</span>
          </label>
        </div>
            <div className="set-row">
              <label>隧道类型</label>
              <div className="seg">
                <button
                  className={settings.tunnelMode === "quick" ? "on" : ""}
                  onClick={() => onChange({ tunnelMode: "quick" })}
                >
                  快速（临时地址）
                </button>
                <button
                  className={settings.tunnelMode === "named" ? "on" : ""}
                  onClick={() => onChange({ tunnelMode: "named" })}
                >
                  命名（token）
                </button>
                <button
                  className={settings.tunnelMode === "local" ? "on" : ""}
                  onClick={() => onChange({ tunnelMode: "local" })}
                >
                  本地凭据
                </button>
              </div>
            </div>
            {settings.tunnelMode === "local" ? (
              <>
                <div className="set-row">
                  <label>隧道名称</label>
                  <input
                    className="grow"
                    placeholder="omp"
                    value={settings.tunnelName}
                    onChange={(e) => onChange({ tunnelName: e.target.value })}
                  />
                </div>
                <div className="set-row">
                  <label>公网域名</label>
                  <input
                    className="grow"
                    placeholder="omp.example.com"
                    value={settings.tunnelHostname}
                    onChange={(e) => onChange({ tunnelHostname: e.target.value })}
                  />
                </div>
              </>
            ) : null}
            {settings.tunnelMode === "named" ? (
              <>
                <div className="set-row">
                  <label>隧道 token</label>
                  <input
                    className="grow"
                    placeholder="Cloudflare 后台创建的隧道 token"
                    value={settings.tunnelToken}
                    onChange={(e) => onChange({ tunnelToken: e.target.value })}
                  />
                </div>
                <div className="set-row">
                  <label>公网域名</label>
                  <input
                    className="grow"
                    placeholder="omp.example.com"
                    value={settings.tunnelHostname}
                    onChange={(e) => onChange({ tunnelHostname: e.target.value })}
                  />
                </div>
              </>
            ) : null}
        {remote.running ? (
          <>
            <div className="set-row">
              <label>本机地址</label>
              <div className="set-inline">
                <input readOnly value={remote.url ?? ""} className="grow" />
                <button className="ghost" onClick={() => void navigator.clipboard.writeText(remote.url ?? "")}>
                  复制
                </button>
              </div>
            </div>
            <div className="set-row">
              <label>Cloudflare 隧道</label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={tunnelOn}
                  onChange={async (e) => {
                    setTunnelOn(e.target.checked);
                    setRemote(await window.api.remoteTunnel(e.target.checked));
                  }}
                />
                <span>
                  {remote.tunnelState === "running"
                    ? "已连线"
                    : remote.tunnelState === "starting"
                      ? "连接中…"
                      : remote.tunnelState === "error"
                        ? "出错"
                        : "关闭"}
                </span>
              </label>
            </div>
            {remote.tunnelUrl ? (
              <div className="set-row">
                <label>公网地址</label>
                <div className="set-inline">
                  <input readOnly value={`${remote.tunnelUrl}/?token=${new URL(remote.url ?? "http://x").searchParams.get("token") ?? ""}`} className="grow" />
                  <button
                    className="ghost"
                    onClick={() => {
                      const token = new URL(remote.url ?? "http://x").searchParams.get("token") ?? "";
                      void navigator.clipboard.writeText(`${remote.tunnelUrl}/?token=${token}`);
                    }}
                  >
                    复制
                  </button>
                </div>
              </div>
            ) : null}
            {remote.error ? (
              <div className="set-row">
                <label>隧道状态</label>
                <span className="set-hint">{remote.error}</span>
              </div>
            ) : null}
          </>
        ) : null}
        <div className="set-hint">
          手机浏览器打开上面的地址即可查看会话、回消息、批权限。同一个 Wi‑Fi 用本机地址；要在外面用走 frp 地址。Cloudflare 隧道已移除。
        </div>
      </section>
      <section className="set-group" data-cat="balance">
        <h3>供应商余额</h3>
        <div className="set-row">
          <label>刷新</label>
          <div className="set-inline">
            <button className="ghost" onClick={async () => setBalances(await window.api.providerBalances())}>
              查询全部
            </button>
            <span className="set-hint">DeepSeek 自动查询；其它供应商可填自定义余额接口</span>
          </div>
        </div>
        {balances.map((b) => (
          <div className="set-row" key={b.provider}>
            <label>{b.provider}</label>
            <span className="set-hint" style={{ minWidth: 90 }}>
              {b.ok ? `${b.currency ?? ""} ${Number(b.amount ?? 0).toFixed(2)}${b.detail ? `（${b.detail}）` : ""}` : b.error ?? "不可用"}
            </span>
            {b.models?.length ? (
              <div className="set-hint" style={{ flexBasis: "100%", paddingLeft: 8 }}>
                {b.models
                  .slice()
                  .sort((x, y) => y.cost - x.cost)
                  .slice(0, 6)
                  .map((m) => `${m.model} $${m.cost.toFixed(2)}（${m.requests} 次）`)
                  .join("  ·  ")}
              </div>
            ) : null}
            <input
              className="grow"
              placeholder="自定义余额接口 URL（Bearer 供应商 key）"
              value={settings.providerBalanceUrls?.[b.provider] ?? ""}
              onChange={(e) => onChange({ providerBalanceUrls: { ...(settings.providerBalanceUrls ?? {}), [b.provider]: e.target.value } })}
            />
          </div>
        ))}
      </section>
      <section className="set-group" data-cat="balance">
        <h3>计费</h3>
        <div className="set-row">
          <label>DeepSeek 峰谷计费</label>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.deepseekPricing}
              onChange={(e) => onChange({ deepseekPricing: e.target.checked })}
            />
            <span>{settings.deepseekPricing ? "开启" : "关闭"}</span>
          </label>
        </div>
        <div className="set-row">
          <label>缓存命中价（$ / 1M）</label>
          <input
            className="grow"
            type="number"
            step="0.001"
            value={settings.priceCacheIn ?? 0}
            onChange={(e) => onChange({ priceCacheIn: Number(e.target.value) })}
          />
        </div>
        <div className="set-row">
          <label>谷时折扣</label>
          <input
            className="grow"
            type="number"
            step="0.05"
            min={0}
            max={1}
            value={settings.offPeakFactor ?? 0.5}
            onChange={(e) => onChange({ offPeakFactor: Number(e.target.value) })}
          />
        </div>
        <div className="set-hint">
          DeepSeek 官方谷时（UTC 16:30–00:30，北京时间 00:30–08:30）按「谷时折扣」计价；价格填 0 时用 agent 回报的金额。
        </div>
        <div className="set-row">
          <label>输入价格（$ / 1M）</label>
          <input
            className="grow"
            type="number"
            step="0.01"
            value={settings.priceIn ?? 0}
            onChange={(e) => onChange({ priceIn: Number(e.target.value) })}
          />
        </div>
        <div className="set-row">
          <label>输出价格（$ / 1M）</label>
          <input
            className="grow"
            type="number"
            step="0.01"
            value={settings.priceOut ?? 0}
            onChange={(e) => onChange({ priceOut: Number(e.target.value) })}
          />
        </div>
        <div className="set-row">
          <label>DeepSeek API Key</label>
          <div className="set-inline">
            <input
              className="grow"
              type="password"
              placeholder="sk-...（用于实时查询余额）"
              value={settings.deepseekApiKey}
              onChange={(e) => onChange({ deepseekApiKey: e.target.value })}
            />
            <button
              className="ghost"
              onClick={async () => {
                const r = await window.api.getBalance();
                setCmMsg(r.ok ? `余额：${r.total?.toFixed(2)} ${r.currency ?? ""}` : `查询失败：${r.error}`);
              }}
            >
              查询余额
            </button>
            {cmMsg && cmMsg.startsWith("余额") ? <span className="set-hint">{cmMsg}</span> : null}
          </div>
        </div>        <div className="set-row">
          <label>初始余额（$）</label>
          <input
            className="grow"
            type="number"
            step="1"
            value={settings.balanceStart ?? 0}
            onChange={(e) => onChange({ balanceStart: Number(e.target.value) })}
          />
        </div>
        <div className="set-hint">填了初始余额，状态栏会显示「余 $x.xx」。价格填 0 时用 agent 回报的金额。</div>
      </section>
      <section className="set-group" data-cat="general">
        <h3>通知</h3>
        <div className="set-row">
          <label>回合完成时通知</label>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.notifyOnTurnEnd}
              onChange={(e) => onChange({ notifyOnTurnEnd: e.target.checked })}
            />
            <span>{settings.notifyOnTurnEnd ? "开启" : "关闭"}</span>
          </label>
        </div>
      </section>

      <section className="set-group" data-cat="data">
        <h3>数据</h3>
        <div className="set-row">
          <label>本地数据</label>
          <div className="set-inline">
            <button className="ghost" onClick={onOpenDataDir}>
              打开数据目录
            </button>
            <button className="ghost danger" onClick={onClearSessions}>
              清空会话记录
            </button>
          </div>
        </div>
      </section>

      <section className="set-group" data-cat="data">
        <h3>关于</h3>
        <div className="set-row">
          <label>版本</label>
          <span className="set-hint">
            OT {version || "—"} · {agents.filter((a) => a.detected).map((a) => `${a.name} ${a.version ?? ""}`).join(" / ")}
          </span>
        </div>
      </section>
        </div>
      </div>
    </div>
  );
}
export type { DiffLine };























































































































































































































































