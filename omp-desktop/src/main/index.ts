import { app, BrowserWindow, dialog, ipcMain, Menu, net, Notification, protocol, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { AgentSession } from "./agent/session.js";
import { findAgent, listAgents } from "./agents.js";
import { SessionStore } from "./store.js";
import { dropCheckpoints, restoreCheckpoint, saveCheckpoint } from "./checkpoints.js";
import { RemoteServer } from "./remote.js";
import { Tunnel } from "./tunnel.js";
import { SettingsStore } from "./settings.js";
import type { AgentEvent, AppSettings, ConfigOption, SkillInfo, StartOptions, WeWallpaper } from "../shared/types.js";

protocol.registerSchemesAsPrivileged([
  { scheme: "ompmedia", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let win: BrowserWindow | null = null;
let session: AgentSession | null = null;
let store: SessionStore | null = null;
let settings: SettingsStore | null = null;
let lastConfig: ConfigOption[] = [];

let remote: RemoteServer | null = null;
let tunnel: Tunnel | null = null;
let currentSessionId: string | null = null;
let currentAgentId = "omp";
let sessionCwd = process.env.OMP_CWD ?? process.cwd();

function emit(event: AgentEvent): void {
  if (event.t === "ready") {
    currentSessionId = event.sessionId;
    sessionCwd = event.cwd;
    currentAgentId = event.agentId;
    lastConfig = event.configOptions ?? [];
  }

  win?.webContents.send("agent:event", event);
  remote?.ingest(event);

  if (event.t === "turn_end") notifyTurnDone();
  if (event.t === "ready") win?.flashFrame(false);

  if (store && currentSessionId && event.t !== "log" && event.t !== "agent_exit" && event.t !== "ready") {
    // 只有真正产生了内容才建索引，避免每启动一次就多一个空会话
    if (!store.get(currentSessionId)) {
      const now = new Date().toISOString();
      store.create({
        id: currentSessionId,
        agentId: currentAgentId,
        cwd: sessionCwd,
        title: "新会话",
        createdAt: now,
        updatedAt: now,
      });
    }
    store.append(currentSessionId, event);
  }
}

function notifyTurnDone(): void {
  if (!win || win.isFocused()) return;
  win.flashFrame(true);
  if (!Notification.isSupported()) return;
  const note = new Notification({
    title: "OT",
    body: "这一轮跑完了",
    silent: false,
  });
  note.on("click", () => {
    win?.show();
    win?.focus();
    win?.flashFrame(false);
  });
  note.show();
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0d10",
    autoHideMenuBar: true,
    title: "OT",
    icon: join(import.meta.dirname, "../../build/icon.png"),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));

  // 外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => {
    win = null;
  });
}

function disposeSession(): void {
  session?.dispose();
  session = null;
}

function saveImages(images: { data: string; mimeType: string; name?: string }[]): string[] {
  if (!images.length) return [];
  const dir = join(app.getPath("temp"), "omp-desktop-images");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (const img of images) {
    const ext = img.mimeType.includes("jpeg") ? ".jpg" : img.mimeType.includes("webp") ? ".webp" : img.mimeType.includes("gif") ? ".gif" : ".png";
    const file = join(dir, `${randomUUID()}${ext}`);
    try {
      writeFileSync(file, Buffer.from(img.data, "base64"));
      paths.push(file);
    } catch {
      /* 落盘失败就不带这张 */
    }
  }
  return paths;
}

function dataUrlOf(path: string): string | null {
  try {
    const buf = readFileSync(path);
    if (buf.length > 16 * 1024 * 1024) return null;
    const lower = path.toLowerCase();
    const mime = lower.endsWith(".png")
      ? "image/png"
      : lower.endsWith(".webp")
        ? "image/webp"
        : lower.endsWith(".bmp")
          ? "image/bmp"
          : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function readWallpaper(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("reg", ["query", "HKCU\\Control Panel\\Desktop", "/v", "WallPaper"], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const match = String(stdout).match(/WallPaper\s+REG_SZ\s+(.+)/);
      if (!match) return resolve(null);
      const path = match[1].trim();
      if (!existsSync(path)) return resolve(null);
      resolve(dataUrlOf(path));
    });
  });
}

const WE_APP_ID = "431960";

function steamLibraries(): string[] {
  const roots = new Set<string>();
  const steamPath = (() => {
    try {
      const out = execFileSync("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"], { windowsHide: true }).toString();
      const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
      return m ? m[1].trim().replace(/\//g, "\\") : null;
    } catch {
      return null;
    }
  })();
  if (steamPath) roots.add(steamPath);
  for (const guess of [
    "C:\\Program Files (x86)\\Steam",
    "C:\\Program Files\\Steam",
    "D:\\Steam",
    "E:\\SteamLibrary",
    "D:\\SteamLibrary",
  ]) {
    if (existsSync(guess)) roots.add(guess);
  }
  // libraryfolders.vdf 里的其他盘
  for (const root of [...roots]) {
    const vdf = join(root, "steamapps", "libraryfolders.vdf");
    if (!existsSync(vdf)) continue;
    try {
      const text = readFileSync(vdf, "utf8");
      for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) roots.add(m[1].replace(/\\\\/g, "\\"));
    } catch {
      /* ignore */
    }
  }
  return [...roots];
}

function scanWallpaperEngine(): WeWallpaper[] {
  const out: WeWallpaper[] = [];
  for (const lib of steamLibraries()) {
    const content = join(lib, "steamapps", "workshop", "content", WE_APP_ID);
    if (!existsSync(content)) continue;
    let dirs: string[] = [];
    try {
      dirs = readdirSync(content);
    } catch {
      continue;
    }
    for (const id of dirs) {
      const dir = join(content, id);
      const project = join(dir, "project.json");
      if (!existsSync(project)) continue;
      try {
        const data = JSON.parse(readFileSync(project, "utf8").replace(/^\uFEFF/, ""));
        const type = String(data.type ?? "");
        const file = data.file ? join(dir, String(data.file)) : "";
        const playable = ["video", "image"].includes(type) && file && existsSync(file) ? file : "";
        const previewName = String(data.preview ?? "");
        // scene/web 的 project.json 通常还有 preview
        const preview = previewName && existsSync(join(dir, previewName)) ? join(dir, previewName) : "";
        out.push({
          id,
          title: String(data.title ?? id),
          type: type || "unknown",
          dir,
          media: playable,
          preview,
        });
      } catch {
        /* 坏项目跳过 */
      }
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}
function searchFiles(root: string, query: string): { path: string; name: string }[] {
  const q = (query ?? "").trim().toLowerCase();
  if (!root || !q || !existsSync(root)) return [];
  const skip = new Set(["node_modules", ".git", "dist", "out", "release", ".next", ".cache", "target", "build"]);
  const results: { path: string; name: string }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (results.length >= 200 || depth > 6) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= 200) return;
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name.toLowerCase().includes(q)) {
        results.push({ path: full, name: entry.name });
      }
    }
  };
  walk(root, 0);
  return results.slice(0, 60);
}

function listSkills(): Promise<SkillInfo[]> {
  return new Promise((resolve) => {
    execFile(
      "omp",
      ["skill", "list", "--json"],
      { timeout: 20_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const data = JSON.parse(String(stdout));
          const list = (data.skills ?? []).map((s: any) => ({
            name: String(s.name ?? ""),
            description: String(s.description ?? "").trim(),
            filePath: String(s.filePath ?? ""),
            baseDir: String(s.baseDir ?? ""),
            source: String(s.source ?? ""),
            hide: Boolean(s.hide),
          }));
          resolve(list.filter((s: SkillInfo) => s.name && !s.hide));
        } catch {
          resolve([]);
        }
      },
    );
  });
}

async function applyDefaults(): Promise<void> {
  if (!session || !settings) return;
  const s = settings.get();
  const model = lastConfig.find((o) => o.category === "model");
  const mode = lastConfig.find((o) => o.category === "mode");
  const thinking = lastConfig.find(
    (o) => o.id === "thinking" || o.category === "thought_level" || o.category === "thinking",
  );
  let changed = false;
  try {
    if (s.defaultModel && model && model.currentValue !== s.defaultModel) {
      await session.setConfig(model.id, s.defaultModel);
      model.currentValue = s.defaultModel;
      changed = true;
    }
    if (s.defaultMode && mode && mode.currentValue !== s.defaultMode) {
      await session.setConfig(mode.id, s.defaultMode);
      mode.currentValue = s.defaultMode;
      changed = true;
    }
    if (s.defaultThinking && thinking && thinking.currentValue !== s.defaultThinking) {
      await session.setConfig(thinking.id, s.defaultThinking);
      thinking.currentValue = s.defaultThinking;
      changed = true;
    }
  } catch {
    /* agent 不认这个值就算了 */
  }
  if (changed && currentSessionId) {
    emit({
      t: "ready",
      sessionId: currentSessionId,
      cwd: sessionCwd,
      agentId: currentAgentId,
      configOptions: lastConfig,
    });
  }
}

function resolveInitialCwd(): string {
  if (process.env.OMP_CWD) return process.env.OMP_CWD;
  const saved = settings?.get().defaultCwd;
  if (saved && existsSync(saved)) return saved;
  const last = store?.list()[0];
  if (last && existsSync(last.cwd)) return last.cwd;
  return app.getPath("home");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("com.local.ompdesktop");
    app.setPath("userData", join(app.getPath("appData"), "omp-desktop"));
    Menu.setApplicationMenu(null);

    settings = new SettingsStore(join(app.getPath("userData"), "settings.json"));
    if (!settings.get().remoteToken) {
      settings.save({ remoteToken: randomBytes(12).toString("hex") });
    }
    store = new SessionStore(app.getPath("userData"));
    store.init();

    protocol.handle("ompmedia", (request) => {
      try {
        const url = new URL(request.url);
        const path = url.searchParams.get("path");
        if (!path || !existsSync(path)) return new Response("not found", { status: 404 });
        const ext = extname(path).toLowerCase();
        const mime =
          ext === ".mp4"
            ? "video/mp4"
            : ext === ".webm"
              ? "video/webm"
              : ext === ".gif"
                ? "image/gif"
                : ext === ".png"
                  ? "image/png"
                  : ext === ".webp"
                    ? "image/webp"
                    : ext === ".bmp"
                      ? "image/bmp"
                      : "image/jpeg";
        const data = readFileSync(path);
        const range = request.headers.get("range");
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          const start = m && m[1] ? Number(m[1]) : 0;
          const end = m && m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
          const chunk = data.subarray(start, end + 1);
          return new Response(new Uint8Array(chunk), {
            status: 206,
            headers: {
              "content-type": mime,
              "content-length": String(chunk.length),
              "content-range": `bytes ${start}-${end}/${data.length}`,
              "accept-ranges": "bytes",
            },
          });
        }
        return new Response(new Uint8Array(data), {
          status: 200,
          headers: { "content-type": mime, "content-length": String(data.length), "accept-ranges": "bytes" },
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    });

    const userData = app.getPath("userData");

    const notifyUser = (title: string, body: string) => {
      if (!Notification.isSupported()) return;
      const note = new Notification({ title, body });
      note.on("click", () => {
        win?.show();
        win?.focus();
      });
      note.show();
    };

    const promptCurrent = async (text: string) => {
      if (!session) return;
      emit({ t: "user", text });
      try {
        await session.prompt(text);
      } catch (err: any) {
        emit({ t: "error", message: String(err?.message ?? err) });
      }
    };

   sessionCwd = resolveInitialCwd();

    createWindow();

    ipcMain.handle("agents:list", () => listAgents());

    // 技能：直接问 omp 自己（它会汇总 ~/.agents/skills 等来源），保证和 agent 看到的一致
    ipcMain.handle("settings:get", () => settings!.get());
    ipcMain.handle("settings:save", (_e, patch: Partial<AppSettings>) => settings!.save(patch));
    ipcMain.handle("app:openDataDir", () => shell.openPath(app.getPath("userData")));
    ipcMain.handle("app:version", () => app.getVersion());
    ipcMain.handle("we:scan", () => scanWallpaperEngine());

    ipcMain.handle("fs:search", (_e, root: string, query: string) => searchFiles(root, query));

    ipcMain.handle("checkpoint:save", (_e, sessionId: string, turnId: string, path: string, oldText: string | null) => {
      saveCheckpoint(sessionId, turnId, path, oldText);
    });

    ipcMain.handle("checkpoint:restore", (_e, sessionId: string, turnId: string) => restoreCheckpoint(sessionId, turnId));

    ipcMain.handle("fs:reveal", (_e, path: string) => {
      shell.showItemInFolder(path);
    });

    ipcMain.handle("fs:openWith", (_e, path: string) => {
      if (process.platform === "win32") {
        try {
          execFile("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", path], { windowsHide: true });
          return { ok: true };
        } catch (err: any) {
          return { ok: false, error: String(err?.message ?? err) };
        }
      }
      void shell.openPath(path);
      return { ok: true };
    });

    ipcMain.handle("fs:read", (_e, path: string) => {
      try {
        if (!path || !existsSync(path)) return { ok: false, error: "文件不存在" };
        const buf = readFileSync(path);
        if (buf.length > 2 * 1024 * 1024) return { ok: false, error: "文件超过 2MB，请用系统程序打开" };
        return { ok: true, text: buf.toString("utf8") };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    });
    ipcMain.handle("sessions:clear", () => {
      store!.clearAll();
      currentSessionId = null;
    });

    ipcMain.handle("dialog:pickFiles", async () => {
      if (!win) return [];
      const result = await dialog.showOpenDialog(win, {
        properties: ["openFile", "multiSelections"],
        title: "选择要附带的文件",
      });
      return result.canceled ? [] : result.filePaths;
    });

    ipcMain.handle("agent:approval", (_e, mode: "ask" | "auto") => {
      session?.setAutoApprove(mode === "auto");
      settings?.save({ approvalMode: mode });
    });

    ipcMain.handle("skills:list", () => listSkills());
    ipcMain.handle("skills:open", (_e, path: string) => shell.openPath(path));

    ipcMain.handle("agent:sessions", () => store!.list());

    ipcMain.handle("agent:open", (_e, id: string) => {
      const meta = store!.get(id);
      if (!meta) return null;
      return { meta, events: store!.read(id) };
    });

    ipcMain.handle("agent:start", async (_e, options?: StartOptions) => {
      if (options?.cwd) sessionCwd = options.cwd;
      const s = settings!.get();
      const agent = findAgent(options?.agentId ?? s.defaultAgent ?? currentAgentId);
      disposeSession();
      currentSessionId = null;
      currentAgentId = agent.id;
      session = new AgentSession(agent, emit);
      session.setAutoApprove(s.approvalMode === "auto");
      const sessionId = await session.start(sessionCwd);
      await applyDefaults();
      return { sessionId };
    });

    ipcMain.handle("agent:resume", async (_e, id: string) => {
      const meta = store!.get(id);
      if (!meta) return { ok: false, error: "会话不存在" };
      disposeSession();
      sessionCwd = meta.cwd;
      currentAgentId = meta.agentId;
      currentSessionId = id;
      session = new AgentSession(findAgent(meta.agentId), emit);
      try {
        await session.resume(id, meta.cwd);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    });

    ipcMain.handle("agent:prompt", async (_e, text: string, images?: any[]) => {
      if (!session) return { ok: false, error: "会话尚未就绪" };
      emit({ t: "user", text, images });

      // agent 侧（omp）对 ACP 内联图片会转成 local:// 再读，实际读不到；
      // 落成本地文件、把路径附在正文里，任何有文件工具的 agent 都能看。
      const saved = saveImages(images ?? []);
      const augmented =
        saved.length > 0
          ? `${text}${text ? "\n\n" : ""}[附带的图片文件]\n${saved.map((p) => `- ${p}`).join("\n")}`
          : text;
      try {
        await session.prompt(augmented, []);
        return { ok: true };
      } catch (err: any) {
        emit({ t: "error", message: String(err?.message ?? err) });
        return { ok: false, error: String(err?.message ?? err) };
      }
    });

    const remoteStatus = () => ({
      running: remote?.running ?? false,
      url: remote?.running ? `http://127.0.0.1:${settings?.get().remotePort ?? 7788}/?token=${remote.token}` : null,
      tunnelState: tunnel?.state ?? "stopped",
      tunnelUrl: tunnel?.url ?? null,
      error: tunnel?.error ?? null,
    });

    // 开机/重启后自动恢复手机访问
    setTimeout(() => {
      const cfg = settings?.get();
      if (!cfg?.remoteEnabled) return;
      const port = cfg.remotePort ?? 7788;
      const stableToken = settings!.get().remoteToken;
      remote ??= new RemoteServer(port, {
        sessions: () => (store?.list() ?? []).map((m) => ({ id: m.id, title: m.title, cwd: m.cwd, updatedAt: m.updatedAt })),
        open: async (id: string) => {
          const meta = store?.get(id);
          if (!meta) return { ok: false, error: "会话不存在" };
          try {
            disposeSession();
            sessionCwd = meta.cwd;
            currentAgentId = meta.agentId;
            currentSessionId = id;
            session = new AgentSession(findAgent(meta.agentId), emit);
            await session.resume(id, meta.cwd);
            return { ok: true, title: meta.title };
          } catch (err: any) {
            return { ok: false, error: String(err?.message ?? err) };
          }
        },
        history: (id: string) => store?.read(id) ?? [],
        prompt: async (text: string, images?: { data: string; mimeType: string; name?: string }[]) => {
          try {
            emit({ t: "user", text });
            await session?.prompt(text, images);
            return { ok: true };
          } catch (err: any) {
            return { ok: false, error: String(err?.message ?? err) };
          }
        },
        permission: (id: string, optionId: string) => void session?.respondPermission(id, optionId),
        cancel: () => void session?.cancel(),
        snapshot: () => ({
          id: currentSessionId ?? "",
          title: store?.get(currentSessionId ?? "")?.title ?? "OT",
          cwd: sessionCwd,
          status: "idle",
          agent: currentAgentId,
          model: "",
        }),
      }, stableToken);
      void remote.start().then(() => {
        if (!cfg.tunnelEnabled) return;
        tunnel ??= new Tunnel(() => win?.webContents.send("remote:tunnel", remoteStatus()));
        void tunnel.start(port, { mode: cfg.tunnelMode, token: cfg.tunnelToken, hostname: cfg.tunnelHostname, name: cfg.tunnelName });
      });
    }, 3000);
    ipcMain.handle("remote:status", () => remoteStatus());

    ipcMain.handle("remote:start", async () => {
      const s = settings?.get();
      const port = s?.remotePort ?? 7788;
      const stableToken = settings!.get().remoteToken;
      remote ??= new RemoteServer(port, {
        sessions: () => (store?.list() ?? []).map((m) => ({ id: m.id, title: m.title, cwd: m.cwd, updatedAt: m.updatedAt })),
        open: async (id: string) => {
          const meta = store?.get(id);
          if (!meta) return { ok: false, error: "会话不存在" };
          try {
            disposeSession();
            sessionCwd = meta.cwd;
            currentAgentId = meta.agentId;
            currentSessionId = id;
            session = new AgentSession(findAgent(meta.agentId), emit);
            await session.resume(id, meta.cwd);
            return { ok: true, title: meta.title };
          } catch (err: any) {
            return { ok: false, error: String(err?.message ?? err) };
          }
        },
        prompt: async (text: string, images?: { data: string; mimeType: string; name?: string }[]) => {
          try {
            emit({ t: "user", text });
            await session?.prompt(text, images);
            return { ok: true };
          } catch (err: any) {
            return { ok: false, error: String(err?.message ?? err) };
          }
        },
        history: (id: string) => store?.read(id) ?? [],
        permission: (id: string, optionId: string) => void session?.respondPermission(id, optionId),
        cancel: () => void session?.cancel(),
        snapshot: () => ({
          id: currentSessionId ?? "",
          title: store?.get(currentSessionId ?? "")?.title ?? "OT",
          cwd: sessionCwd,
          status: "idle",
          agent: currentAgentId,
          model: "",
        }),
      }, stableToken);
      await remote.start();
      if (s?.tunnelEnabled) {
        tunnel ??= new Tunnel(() => win?.webContents.send("remote:tunnel", remoteStatus()));
        void tunnel.start(port, { mode: s.tunnelMode, token: s.tunnelToken, hostname: s.tunnelHostname, name: s.tunnelName });
      }
      return remoteStatus();
    });

    ipcMain.handle("remote:stop", async () => {
      tunnel?.stop();
      await remote?.stop();
      remote = null;
      return remoteStatus();
    });

    ipcMain.handle("remote:tunnel", async (_e, on: boolean) => {
      const port = settings?.get().remotePort ?? 7788;
      if (on) {
        const cfg = settings!.get();
        tunnel ??= new Tunnel(() => win?.webContents.send("remote:tunnel", remoteStatus()));
        void tunnel.start(port, { mode: cfg.tunnelMode, token: cfg.tunnelToken, hostname: cfg.tunnelHostname, name: cfg.tunnelName });
      } else {
        tunnel?.stop();
      }
      return remoteStatus();
    });
    ipcMain.handle("agent:permission", async (_e, toolCallId: string, optionId: string) => {
      await session?.respondPermission(toolCallId, optionId);
    });

    ipcMain.handle("agent:config", async (_e, configId: string, value: string) => {
      try {
        await session?.setConfig(configId, value);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    });

    ipcMain.handle("agent:rename", (_e, id: string, title: string) => {
      store?.rename(id, title);
    });

    ipcMain.handle("agent:delete", (_e, id: string) => {
      store?.remove(id);
    });

    ipcMain.handle("agent:search", (_e, q: string) => store?.search(q) ?? []);

    ipcMain.handle("agent:cancel", async () => {
      await session?.cancel();
    });

    ipcMain.handle("system:wallpaper", () => readWallpaper());

    ipcMain.handle("system:pickImage", async () => {
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        properties: ["openFile"],
        title: "选择背景图片",
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
      });
      const path = result.filePaths[0];
      if (result.canceled || !path) return null;
      const dataUrl = dataUrlOf(path);
      return dataUrl ? { path, dataUrl } : null;
    });

    ipcMain.handle("system:readImage", (_e, path: string) => (existsSync(path) ? dataUrlOf(path) : null));

    ipcMain.handle("dialog:pickDirectory", async () => {
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
        title: "选择工作目录",
        defaultPath: sessionCwd,
      });
      if (result.canceled || !result.filePaths[0]) return null;
      return result.filePaths[0];
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    disposeSession();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    disposeSession();
  });
}











































