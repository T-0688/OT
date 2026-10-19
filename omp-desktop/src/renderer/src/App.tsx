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
} from "../../shared/types.js";
import { compactDiff, diffLines, type DiffLine } from "./diff.js";

type Item =
  | { kind: "user"; id: string; text: string; images?: ImagePart[] }
  | { kind: "assistant"; id: string; text: string; thinking: string; streaming: boolean }
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
  | { kind: "turn"; id: string; ms: number; tokens: number; at: number; userText?: string };

type PendingPermission = { id: string; title: string; options: PermissionChoice[] };
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
  const [attachments, setAttachments] = useState<ImagePart[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [approval, setApproval] = useState<"ask" | "auto">("ask");
  const [plusOpen, setPlusOpen] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);

  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("omp.theme") as "dark" | "light") || "dark",
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [failedText, setFailedText] = useState<string | null>(null);

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
  const [totalTokens, setTotalTokens] = useState(0);
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string; name: string } | null>(null);
  const [wsMenu, setWsMenu] = useState<{ x: number; y: number; cwd: string; name: string; pinned: boolean } | null>(null);
  const [wsEditing, setWsEditing] = useState<{ cwd: string; value: string } | null>(null);
  const [collapsedWs, setCollapsedWs] = useState<Set<string>>(new Set());
  const [expandedWs, setExpandedWs] = useState<Set<string>>(new Set());
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const started = useRef(false);
  const lastUser = useRef("");
  const pending = useRef({ text: "", thinking: "", timer: 0 });
  const turnStart = useRef(Date.now());

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
          queue("text", ev.text);
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
          setUsage({ cost: ev.costUsd, used: ev.used, size: ev.size });
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
            },
          ]);
          break;
        }
        case "error":
          flush();
          setStatus("error");
          setRunning(false);
          setFailedText(lastUser.current || null);
          break;
        case "log":
          setLogs((prev) => [...prev.slice(-80), ev.text]);
          break;
        case "agent_exit":
          flush();
          setStatus("exited");
          setRunning(false);
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
    const offClients = window.api.onRemoteClients((n) => setPhoneOnline(n > 0));
    void window.api.remoteStatus().then((st) => { if (!st.running) setPhoneOnline(false); }).catch(() => {});
    return offClients;
  }, []);
  useEffect(() => {
    const off = window.api.onEvent(handleEvent);
    void (async () => {
      setAgents(await window.api.agents());
      await refreshSessions();
    })();
    if (!started.current) {
      started.current = true;
      void window.api.start().catch((err) => {
        setStatus("error");
        setItems([{ kind: "note", id: uid("n"), text: `无法启动 agent：${err?.message ?? err}` }]);
      });
    }
    return off;
  }, [handleEvent, refreshSessions]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = async (text?: string, images?: ImagePart[]) => {
    const extra = files.length ? `\n\n[附带的文件]\n${files.map((f) => `- ${f}`).join("\n")}` : "";
    const content = ((text ?? draft).trim() + extra).trim();
    const imgs = images ?? attachments;
    if ((!content && imgs.length === 0) || running || !sessionId) return;
    if (!text) {
      setDraft("");
      setAttachments([]);
      setFiles([]);
    }
    lastUser.current = content;
    turnStart.current = Date.now();
    setRunning(true);
    setStatus("running");
    stickToBottom.current = true;
    const res = await window.api.prompt(content, imgs.length ? imgs : undefined);
    if (!res.ok) {
      setRunning(false);
      setStatus("error");
      setFailedText(content);
    }
  };

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
  };

  const choose = async (option: PermissionChoice) => {
    if (!permission) return;
    const current = permission;
    setPermission(null);
    await window.api.respondPermission(current.id, option.optionId);
  };

  const newSession = async (nextAgent = agentId, nextCwd?: string) => {
    setItems([]);
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
    for (const ev of data.events) {
      replay = applyToItems(replay, ev);
      if (ev.t === "ready") {
        configs = ev.configOptions ?? [];
        agent = ev.agentId;
      }
    }
    setItems(replay);
    setStats({});
    setUsage({});
    setConfigOptions(configs);
    setAgentId(agent);
    setSessionId(meta.id);
    setCwd(meta.cwd);
    setPermission(null);
    setStatus("connecting");
    setRunning(false);
    setFailedText(null);
    stickToBottom.current = true;
    await window.api.resume(meta.id);
  };

  const changeDir = async () => {
    const dir = await window.api.pickDirectory();
    if (!dir) return;
    await newSession(agentId, dir);
  };

  const setConfig = async (id: string, value: string) => {
    setConfigOptions((prev) => prev.map((o) => (o.id === id ? { ...o, currentValue: value } : o)));
    await window.api.setConfig(id, value);
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
        return it.text;
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
    models?.options?.find((o) => o.value === models.currentValue)?.name ?? String(models?.currentValue ?? "");
  const detectedAgents = useMemo(() => agents.filter((a) => a.detected || a.id === agentId), [agents, agentId]);
  const hitMap = useMemo(() => new Map(hits.map((h) => [h.id, h])), [hits]);

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
  const turnCount = useMemo(() => items.filter((i) => i.kind === "turn").length + (running ? 1 : 0), [items, running]);
  const ctxPct = usage.size ? Math.min(100, ((usage.used ?? 0) / usage.size) * 100) : 0;
  const cost = useMemo(() => {
    if (typeof usage.cost === "number" && usage.cost > 0) return usage.cost;
    const pIn = appSettings?.priceIn ?? 0;
    const pOut = appSettings?.priceOut ?? 0;
    const inTok = stats.inputTokens ?? 0;
    const outTok = stats.outputTokens ?? 0;
    return (inTok * pIn + outTok * pOut) / 1_000_000;
  }, [usage.cost, appSettings?.priceIn, appSettings?.priceOut, stats.inputTokens, stats.outputTokens]);
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
      list.push({
        key: ws,
        cwd: ws,
        name: ws.split(/[\\/]/).filter(Boolean).pop() || ws,
        items: map.get(ws) ?? [],
        pinned: true,
      });
    }
    for (const [cwd, items] of map) {
      if (seen.has(cwd) || hiddenWorkspaces.includes(cwd)) continue;
      list.push({ key: cwd, cwd, name: cwd.split(/[\\/]/).filter(Boolean).pop() || cwd, items, pinned: false });
    }
    return list.sort((a, b) => {
      const at = a.items[0]?.updatedAt ?? "";
      const bt = b.items[0]?.updatedAt ?? "";
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return at < bt ? 1 : -1;
    });
  }, [filteredSessions, workspaces, hiddenWorkspaces]);

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
    setDraft(userText);
    setFailedText(null);
    setRunning(false);
    await window.api.start({ agentId, cwd });
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
    const checkpointTurnId = (items[userIdx] as { id: string }).id;
    const restore = sessionIdRef.current
      ? await window.api.restoreCheckpoint(sessionIdRef.current, checkpointTurnId)
      : { restored: 0, removed: 0, failed: 0 };
    setItems(items.slice(0, userIdx));
    if (restore.restored || restore.removed || restore.failed) {
      setItems((prev) => [
        ...prev,
        {
          kind: "note",
          id: `note-${Date.now()}`,
          text: `已回退：恢复 ${restore.restored} 个文件${restore.removed ? `、删除 ${restore.removed} 个新建文件` : ""}${restore.failed ? `、${restore.failed} 个失败` : ""}`,
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
            <div className="session-name">{s.title || "新会话"}</div>
            <div className="session-meta">
              {relTime(s.updatedAt)}
              {hit ? ` · ${hit.count} 条匹配` : ""}
            </div>
            {hit?.snippet ? <div className="session-snippet">{hit.snippet}</div> : null}
          </button>
        )}
        <div className="session-actions">
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
      { id: "dir", label: "切换工作目录…", run: () => void changeDir() },
      { id: "theme", label: `切换主题（当前：${theme === "dark" ? "深色" : "浅色"}）`, run: () => setTheme(theme === "dark" ? "light" : "dark") },
      { id: "bg-solid", label: `背景：纯色${bgMode === "solid" ? "（当前）" : ""}`, run: () => setBgMode("solid") },
      { id: "bg-wall", label: `背景：桌面壁纸${bgMode === "wallpaper" ? "（当前）" : ""}`, run: () => setBgMode("wallpaper") },
      { id: "bg-custom", label: `背景：选择图片…${bgMode === "custom" ? "（当前）" : ""}`, run: () => void chooseWallpaper() },
      { id: "skills", label: "打开技能面板", run: () => setView("skills") },
      { id: "settings", label: "打开设置", run: () => setView("settings") },
      { id: "copy", label: "复制整段对话（Markdown）", run: () => void copyTranscript() },
      { id: "bottom", label: "滚动到底部", run: () => { stickToBottom.current = true; const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; } },
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
        setPermission(null);
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
            <button className="nav-kbd" onClick={() => setPaletteOpen(true)} title="命令面板 (Ctrl+K)">
              ⌘K
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
                {groups.map((g) => {
                  const open = !collapsedWs.has(g.key);
                  const limit = expandedWs.has(g.key) ? g.items.length : 4;
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
            <span className="version">v1.3.0</span>
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
            items.map((item, i) => (
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
        <div
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
                  options={models.options}
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
                <button className="send-icon stop" onClick={() => void stop()} title="停止">
                  <Icon name="stop" size={14} />
                </button>
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

        <div className="statusbar">
          <span className={`state ${status}`}>
            {status === "ready"
              ? "就绪"
              : status === "running"
                ? "运行中"
                : status === "connecting"
                  ? "连接中"
                  : status === "exited"
                    ? "已退出"
                    : "出错"}
          </span>
          {modelLabel ? <span className="stat">{modelLabel}</span> : null}
          <span className="stat ring-stat" title={`上下文 ${fmtTokens(usage.used ?? 0)} / ${usage.size ? fmtTokens(usage.size) : "?"}`}>
            <svg width="16" height="16" viewBox="0 0 16 16" className="ctx-ring">
              <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2" />
              <circle
                cx="8"
                cy="8"
                r="6.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={`${Math.min(100, ctxPct) * 0.402} 100`}
                transform="rotate(-90 8 8)"
              />
            </svg>
            {usage.size ? fmtTokens(usage.size) : "—"}
            <span className="muted">{ctxPct.toFixed(0)}%</span>
          </span>
          {stats.speed ? (
            <span className="stat" title="本回合输出速度">
              {stats.speed >= 10 ? stats.speed.toFixed(0) : stats.speed.toFixed(1)} tok/s
            </span>
          ) : null}
          <span className="stat" title="累计消耗 tokens">
            {fmtTokens(totalTokens)} tok
          </span>
          <span className="stat" title="会话轮次">
            第 {turnCount} 轮
          </span>
          <span className="stat" title="本次会话花费">
            ${cost.toFixed(4)}
          </span>
          {(appSettings?.balanceStart ?? 0) > 0 ? (
            <span className="stat balance" title="剩余额度（设置里可改初始余额）">
              余 ${Math.max(0, (appSettings?.balanceStart ?? 0) - cost).toFixed(2)}
            </span>
          ) : null}
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
    return <div className="msg note">{item.text}</div>;
  }

  if (item.kind === "turn") {
    const at = new Date(item.at);
    return (
      <div className="turn-meta">
        <span className="turn-check">✓</span>
        <span>已完成</span>
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
          <details className="thinking" open={reasoning === "full"}>
            <summary>思考过程</summary>
            <div className="thinking-body">{item.thinking}</div>
          </details>
        ) : null}
        {item.text ? (
          <div className="markdown">
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{item.text}</Markdown>
          </div>
        ) : null}
        {item.streaming && !item.text ? <div className="typing" /> : null}
      </div>
    );
  }

  return (
    <div className={`tool ${item.status}`}>
      <div className="tool-head">
        <span className="tool-icon">{item.toolKind === "execute" ? "$" : item.toolKind === "edit" ? "±" : "◆"}</span>
        <span className="tool-title">{item.title}</span>
        <span className="tool-status">{STATUS_LABEL[item.status] ?? item.status}</span>
      </div>
      {item.diff ? <DiffView diff={item.diff} /> : null}
      {item.text && !item.diff ? <pre className="tool-output">{item.text}</pre> : null}
      {item.text && item.diff ? (
        <details className="tool-extra">
          <summary>原始输出</summary>
          <pre className="tool-output">{item.text}</pre>
        </details>
      ) : null}
    </div>
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
              <div className="skill-desc">{s.description || "（无描述）"}</div>
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

  useEffect(() => {
    void window.api.appVersion().then(setVersion).catch(() => setVersion(""));
    void window.api.remoteStatus().then((status) => {
      setRemote(status);
      setTunnelOn(status.tunnelState !== "stopped");
    });
    return window.api.onRemoteTunnel((status) => setRemote(status as RemoteStatus));
  }, []);

  if (!settings) return <div className="panel-empty">读取设置…</div>;

  const modelValue = settings.defaultModel || String(models?.currentValue ?? "");
  const modeValue = settings.defaultMode || String(modes?.currentValue ?? "");

  return (
    <div className="panel settings">
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

      <section className="set-group">
        <h3>模型与 Agent</h3>
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

      <section className="set-group">
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

      <section className="set-group">
        <h3>手机访问</h3>
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
          手机浏览器打开上面的地址即可查看会话、回消息、批权限。同一个 Wi‑Fi 用本机地址；要在外面用就打开 Cloudflare 隧道（首次会自动下载 cloudflared）。关掉软件服务就停。
        </div>
      </section>
      <section className="set-group">
        <h3>计费</h3>
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
      <section className="set-group">
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

      <section className="set-group">
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

      <section className="set-group">
        <h3>关于</h3>
        <div className="set-row">
          <label>版本</label>
          <span className="set-hint">
            OT {version || "—"} · {agents.filter((a) => a.detected).map((a) => `${a.name} ${a.version ?? ""}`).join(" / ")}
          </span>
        </div>
      </section>
    </div>
  );
}
export type { DiffLine };








































































































