import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, net, Notification, protocol, screen, shell } from "electron";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { tmpdir } from "node:os";
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

function agentExtraArgs(): string[] {
  const cfg = settings?.get();
  const args: string[] = [];
  for (const dir of cfg?.extraDirs ?? []) {
    if (dir && existsSync(dir)) args.push(`--add-dir=${dir}`);
  }
  if (cfg?.prewalk) args.push("--prewalk");
  if (cfg?.smolModel) args.push(`--smol=${cfg.smolModel}`);
  if (cfg?.slowModel) args.push(`--slow=${cfg.slowModel}`);
  if (cfg?.planModel) args.push(`--plan=${cfg.planModel}`);
  return args;
}

function emit(event: AgentEvent): void {
  if (event.t === "ready") {
    currentSessionId = event.sessionId;
    sessionCwd = event.cwd;
    currentAgentId = event.agentId;
    lastConfig = event.configOptions ?? [];
    settings?.save({ lastSessionId: event.sessionId });
  }

  win?.webContents.send("agent:event", event);
  remote?.ingest(event);

  if (event.t === "usage") {
    if (typeof event.costUsd === "number") lastUsageCost = event.costUsd;
    if (typeof event.used === "number") lastUsageUsed = event.used;
    if (typeof event.size === "number") lastUsageSize = event.size;
  }
  if (event.t === "user" && detectGithubIntent(event.text)) githubIntent = true;
  if (event.t === "turn_end") {
    notifyTurnDone();
    if (currentSessionId) {
      const meta = store?.get(currentSessionId);
      remote?.notify("OT", "当前任务完成", currentSessionId);
      const u = event.usage;
      const tok = (u?.inputTokens ?? 0) + (u?.cachedReadTokens ?? 0) + (u?.outputTokens ?? 0);
      store?.addTurnStats(currentSessionId, tok, lastUsageCost, lastUsageUsed, lastUsageSize);
    }
    if (githubIntent && settings?.get().githubAutoUpload) void autoUpload(sessionCwd);
  }
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
    body: "当前任务完成",
    silent: false,
  });
  note.on("click", () => {
    win?.show();
    win?.focus();
    win?.flashFrame(false);
  });
  note.show();
}

let shotWin: BrowserWindow | null = null;

async function startScreenshot(): Promise<void> {
  if (shotWin) return;
  try {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const scale = display.scaleFactor || 1;
    const width = Math.round(display.size.width * scale);
    const height = Math.round(display.size.height * scale);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width, height },
      fetchWindowIcons: false,
    });
    const source = sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0];
    if (!source) return;
    const png = source.thumbnail.toPNG();
    const imgPath = join(tmpdir(), `ot-shot-${Date.now()}.png`);
    writeFileSync(imgPath, png);

    const overlay = join(tmpdir(), "ot-shot-overlay.html");
    writeFileSync(
      overlay,
      `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;cursor:crosshair;font-family:system-ui}
#wrap{position:fixed;inset:0;background:rgba(0,0,0,.35)}
#img{position:absolute;inset:0;width:100%;height:100%;object-fit:fill;user-select:none;-webkit-user-drag:none}
#sel{position:absolute;border:1px solid #4c8dff;background:rgba(76,141,255,.14);display:none;pointer-events:none}
#hint{position:fixed;top:14px;left:50%;transform:translateX(-50%);background:rgba(17,18,22,.86);color:#fff;padding:6px 12px;border-radius:8px;font-size:12px}
</style>
<div id="wrap"><img id="img" src="__IMG__"><div id="sel"></div></div>
<div id="hint">拖动选择区域 · Esc 取消</div>
<script>
const { ipcRenderer } = require('electron');
const img = document.getElementById('img');
const sel = document.getElementById('sel');
let sx=0, sy=0, dragging=false;
img.addEventListener('mousedown', (e) => { dragging=true; sx=e.clientX; sy=e.clientY; sel.style.display='block'; sel.style.left=sx+'px'; sel.style.top=sy+'px'; sel.style.width='0px'; sel.style.height='0px'; });
window.addEventListener('mousemove', (e) => { if(!dragging) return; const x=Math.min(e.clientX,sx), y=Math.min(e.clientY,sy); const w=Math.abs(e.clientX-sx), h=Math.abs(e.clientY-sy); sel.style.left=x+'px'; sel.style.top=y+'px'; sel.style.width=w+'px'; sel.style.height=h+'px'; });
window.addEventListener('mouseup', async (e) => {
  if(!dragging) return; dragging=false;
  const x=Math.min(e.clientX,sx), y=Math.min(e.clientY,sy);
  const w=Math.abs(e.clientX-sx), h=Math.abs(e.clientY-sy);
  if (w<4 || h<4) { ipcRenderer.send('shot:cancel'); return; }
  const img0 = new Image(); img0.src = img.src;
  await new Promise((r)=>{ if(img0.complete) r(); else img0.onload=r; });
  const dpr = img0.naturalWidth / window.innerWidth;
  const c = document.createElement('canvas');
  c.width = Math.round(w*dpr); c.height = Math.round(h*dpr);
  c.getContext('2d').drawImage(img0, x*dpr, y*dpr, w*dpr, h*dpr, 0, 0, c.width, c.height);
  ipcRenderer.send('shot:done', c.toDataURL('image/png'));
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') ipcRenderer.send('shot:cancel'); });
</script>`.replace("__IMG__", `file:///${imgPath.replace(/\\/g, "/")}`),
      "utf8",
    );

    shotWin = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    shotWin.setAlwaysOnTop(true, "screen-saver");
    await shotWin.loadFile(overlay);
    shotWin.on("closed", () => {
      shotWin = null;
    });
  } catch (err) {
    console.error("screenshot failed", err);
  }
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

  if (HEADLESS) {
    win.hide();
    win.setSkipTaskbar(true);
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));

  // 外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // 右键菜单：复制/全选/粘贴，让对话里的文字随时能复制
  win.webContents.on("context-menu", (_e, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    items.push({ role: "copy", label: "复制", enabled: Boolean(params.selectionText) });
    items.push({ role: "selectAll", label: "全选" });
    if (params.isEditable) items.push({ role: "paste", label: "粘贴" });
    if (params.selectionText) {
      items.push({ type: "separator" });
      items.push({
        label: "用这段文字提问",
        click: () => win?.webContents.send("menu:ask-selection", params.selectionText),
      });
    }
    Menu.buildFromTemplate(items).popup({ window: win ?? undefined });
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

let githubIntent = false;
let lastUsageCost = 0;
let lastUsageUsed = 0;
let lastUsageSize = 0;

function detectGithubIntent(text: string): boolean {
  return /(上传|推送|推到|提交|同步).{0,8}(github|git|仓库)/i.test(text) || /github.{0,8}(上传|推送|提交)/i.test(text);
}

function gitRun(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function ghCredential(): { user: string; token: string } | null {
  try {
    const out = execFileSync("git", ["credential", "fill"], {
      encoding: "utf8",
      input: "protocol=https\nhost=github.com\n\n",
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const user = /username=(.+)/.exec(out)?.[1]?.trim() ?? "";
    const token = /password=(.+)/.exec(out)?.[1]?.trim() ?? "";
    return user && token ? { user, token } : null;
  } catch {
    return null;
  }
}

const OT_INSTANCE = process.env.OT_INSTANCE ?? "";
/** 微信专用实例：独立数据目录、独立端口、无窗口、自动开一个会话 */
const HEADLESS = OT_INSTANCE === "wechat";

// 必须在 ready 之前设置 userData，否则 Chromium 的 ProcessSingleton 会把第二个实例踢掉
if (HEADLESS) {
  app.setPath("userData", join(app.getPath("appData"), "ot-wechat-instance"));
}

const SENSITIVE_PATTERNS = [
  /(^|\/)\.env($|\.)/i,
  /\.env\.(local|dev|prod|production|staging)$/i,
  /\.(pem|key|p12|pfx|keystore|jks|ppk)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)\.(npmrc|pypirc|netrc|git-credentials)$/i,
  /(^|\/)(credentials|secrets?)\.(json|ya?ml|toml|ini)$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.ssh\//i,
];

function sensitiveHits(files: string[]): string[] {
  return files.filter((f) => SENSITIVE_PATTERNS.some((re) => re.test(f)));
}

function gitignoreRules(files: string[]): string[] {
  const rules = new Set<string>();
  for (const f of files) {
    const base = f.split("/").pop() ?? f;
    if (/^\.env($|\.)/i.test(base)) rules.add(".env*");
    else if (/\.(pem|key|p12|pfx|keystore|jks|ppk)$/i.test(base)) rules.add(`*.${base.split(".").pop()}`);
    else if (/^id_(rsa|dsa|ecdsa|ed25519)$/i.test(base)) rules.add("id_*");
    else if (f.startsWith(".ssh/")) rules.add(".ssh/");
    else if (f.startsWith(".aws/")) rules.add(".aws/");
    else rules.add(f);
  }
  return [...rules];
}

function fixGitignore(cwd: string): { ok: boolean; added: number; error?: string } {
  try {
    let root = cwd;
    try {
      root = gitRun(cwd, ["rev-parse", "--show-toplevel"]).trim();
    } catch {
      return { ok: false, added: 0, error: "当前目录不是 git 仓库" };
    }
    const staged = gitRun(root, ["status", "--porcelain", "--untracked-files=all"])
      .split(/\r?\n/)
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
    const hits = sensitiveHits(staged);
    if (!hits.length) return { ok: true, added: 0 };
    const file = join(root, ".gitignore");
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    const rules = gitignoreRules(hits).filter((r) => !existing.split(/\r?\n/).includes(r));
    if (!rules.length) return { ok: true, added: 0 };
    const block = `${existing && !existing.endsWith("\n") ? "\n" : ""}\n# OT 自动补充（敏感文件）\n${rules.join("\n")}\n`;
    writeFileSync(file, existing + block, "utf8");
    return { ok: true, added: rules.length };
  } catch (err: any) {
    return { ok: false, added: 0, error: String(err?.message ?? err) };
  }
}
async function autoUpload(cwd: string): Promise<void> {
  const cfg = settings!.get();
  try {
    let root = cwd;
    try {
      root = gitRun(cwd, ["rev-parse", "--show-toplevel"]).trim();
    } catch {
      gitRun(cwd, ["init"]);
      root = cwd;
    }
    if (!gitRun(root, ["status", "--porcelain"]).trim()) return;
    gitRun(root, ["add", "-A"]);
    if (settings?.get().githubBlockSecrets) {
      const staged = gitRun(root, ["diff", "--cached", "--name-only"]).split(/\r?\n/).filter(Boolean);
      const hits = sensitiveHits(staged);
      if (hits.length) {
        try { gitRun(root, ["reset"]); } catch { /* ignore */ }
        emit({
          t: "note",
          text: `已拦截自动上传：检测到敏感文件\n${hits.slice(0, 8).map((f) => `· ${f}`).join("\n")}\n请先加入 .gitignore 或从工作区移除。[fix-gitignore]`,
        });
        return;
      }
    }
    gitRun(root, ["-c", "user.name=T-Kepler", "-c", "user.email=2521674913@qq.com", "commit", "-m", `chore: auto upload ${new Date().toISOString().slice(0, 19)}`]);
    let hasRemote = true;
    try {
      gitRun(root, ["remote", "get-url", "origin"]);
    } catch {
      hasRemote = false;
    }
    if (!hasRemote) {
      const cred = ghCredential();
      if (!cred) {
        emit({ t: "note", text: "自动上传失败：本机没有 GitHub 凭据（git credential）" });
        return;
      }
      const name = (root.split(/[\\/]/).filter(Boolean).pop() ?? "ot-project").toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
      const res = await fetch("https://api.github.com/user/repos", {
        method: "POST",
        headers: { Authorization: `token ${cred.token}`, Accept: "application/vnd.github+json", "User-Agent": "ot" },
        body: JSON.stringify({ name, private: false, description: "Created by OT auto-upload" }),
      });
      if (!res.ok && res.status !== 422) {
        emit({ t: "note", text: `自动上传失败：创建仓库 HTTP ${res.status}` });
        return;
      }
      gitRun(root, ["remote", "add", "origin", `https://github.com/${cred.user}/${name}.git`]);
      gitRun(root, ["branch", "-M", "main"]);
      gitRun(root, ["push", "-u", "origin", "main"]);
      emit({ t: "note", text: `已上传到 https://github.com/${cred.user}/${name}` });
    } else {
      gitRun(root, ["push"]);
      emit({ t: "note", text: "已自动提交并推送改动" });
    }
  } catch (err: any) {
    emit({ t: "note", text: `自动上传失败：${String(err?.message ?? err).slice(0, 200)}` });
  }
}
function modelsFile(): string {
  return join(app.getPath("home"), ".omp", "agent", "models.yml");
}

function yamlQuote(value: string): string {
  return JSON.stringify(value ?? "");
}

function addCustomModel(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  api: string;
}): { ok: boolean; error?: string } {
  try {
    const file = modelsFile();
    const slug = (input.name || input.modelId || "custom").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug || !input.baseUrl || !input.modelId) return { ok: false, error: "名称/地址/模型 ID 不能为空" };
    let text = existsSync(file) ? readFileSync(file, "utf8") : "providers:\n";
    if (!/^providers:\s*$/m.test(text)) text = "providers:\n" + text;
    if (new RegExp(`^  ${slug}:\\s*$`, "m").test(text)) return { ok: false, error: `provider 名「${slug}」已存在` };
    const block = [
      `  ${slug}:`,
      `    baseUrl: ${yamlQuote(input.baseUrl)}`,
      `    api: ${input.api || "openai-completions"}`,
      input.apiKey ? `    apiKey: ${yamlQuote(input.apiKey)}` : "",
      "    models:",
      `      - id: ${yamlQuote(input.modelId)}`,
      `        name: ${yamlQuote(input.name || input.modelId)}`,
      "",
    ]
      .filter(Boolean)
      .join("\n");
    text = text.replace(/^providers:\s*$/m, (line) => `${line}\n${block}`);
    writeFileSync(`${file}.bak`, readFileSync(file, "utf8"));
    writeFileSync(file, text, "utf8");
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

async function fetchBalance(): Promise<{ ok: boolean; currency?: string; total?: number; error?: string }> {
  const key = settings?.get().deepseekApiKey?.trim();
  if (!key) return { ok: false, error: "未配置 DeepSeek API Key" };
  try {
    const res = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data: any = await res.json();
    const info = data?.balance_infos?.[0];
    if (!info) return { ok: false, error: "没有余额信息" };
    return { ok: true, currency: info.currency ?? "CNY", total: Number(info.total_balance ?? 0) };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
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
  app.setName("OT");

app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("com.local.ot");

    globalShortcut.register("CommandOrControl+Shift+A", () => {
      void startScreenshot();
    });
    ipcMain.handle("screenshot:start", () => void startScreenshot());
    ipcMain.on("shot:cancel", () => {
      shotWin?.close();
    });
    ipcMain.on("shot:done", (_e, dataUrl: string) => {
      shotWin?.close();
      const base64 = String(dataUrl ?? "").split(",")[1] ?? "";
      if (!base64) return;
      win?.show();
      win?.focus();
      win?.webContents.send("screenshot:capture", base64);
    });
    // 数据目录统一为 OT；把旧的 omp-desktop 内容合并进来（只补不删）
    const dataDir = join(app.getPath("appData"), HEADLESS ? "ot-wechat-instance" : "OT");
    const legacyDir = join(app.getPath("appData"), "omp-desktop");
    if (!HEADLESS && existsSync(legacyDir) && !existsSync(join(dataDir, "settings.json"))) {
      // 只迁移我们自己的数据（仅首次），避免碰到 Chromium 正在占用的缓存/锁文件
      for (const item of ["settings.json", "sessions", "checkpoints", "bin"]) {
        const from = join(legacyDir, item);
        if (!existsSync(from)) continue;
        try {
          cpSync(from, join(dataDir, item), { recursive: true, force: true });
        } catch {
          /* 单项失败不影响其它 */
        }
      }
    }
    app.setPath("userData", dataDir);
    // 保留一个隐藏的编辑菜单，Ctrl+C/V/X/A 才有加速键
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "编辑",
        submenu: [
          { role: "undo", label: "撤销" },
          { role: "redo", label: "重做" },
          { type: "separator" },
          { role: "cut", label: "剪切" },
          { role: "copy", label: "复制" },
          { role: "paste", label: "粘贴" },
          { role: "selectAll", label: "全选" },
        ],
      },
    ]),
  );

    settings = new SettingsStore(join(app.getPath("userData"), "settings.json"));
    if (!settings.get().remoteToken) {
      settings.save({ remoteToken: randomBytes(12).toString("hex") });
    }
    if (HEADLESS) {
      settings.save({ remoteEnabled: true, remotePort: 7789, approvalMode: "auto" });
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
      session.setAutoApprove(settings!.get().approvalMode === "auto");
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

    // 微信专用实例：启动时直接开一个会话，工作目录由 OT_CWD 指定
    if (HEADLESS) {
      setTimeout(async () => {
        try {
          const cwd = process.env.OT_CWD || "D:\\\\.Daily\\\\ot-wechat";
          const cfg = settings!.get();
          const agent = findAgent(cfg.defaultAgent);
          sessionCwd = cwd;
          currentAgentId = agent.id;
          session = new AgentSession(agent, emit);
          session.setAutoApprove(true);
          session.setExtraArgs(agentExtraArgs());
          await session.start(cwd);
        } catch (err) {
          console.error("headless session start failed", err);
        }
      }, 1200);
    }

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
      session.setAutoApprove(settings!.get().approvalMode === "auto");
        session.setExtraArgs(agentExtraArgs());
            await session.resume(id, meta.cwd);
            return { ok: true, title: meta.title };
          } catch (err: any) {
            return { ok: false, error: String(err?.message ?? err) };
          }
        },
        start: async (cwd: string, agentId?: string) => {
          try {
            disposeSession();
            const s = settings!.get();
            const agent = findAgent(agentId ?? s.defaultAgent ?? currentAgentId);
            currentSessionId = null;
            currentAgentId = agent.id;
            if (cwd) sessionCwd = cwd;
            session = new AgentSession(agent, emit);
            session.setAutoApprove(s.approvalMode === "auto");
            session.setExtraArgs(agentExtraArgs());
            await session.start(sessionCwd);
            await applyDefaults();
            return { ok: true };
          } catch (err: any) {
            return { ok: false, error: String(err?.message ?? err) };
          }
        },
        history: (id: string) => store?.read(id) ?? [],
        onClients: (count: number) => win?.webContents.send("remote:clients", count),
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
    ipcMain.handle("models:addCustom", (_e, input: { name: string; baseUrl: string; apiKey: string; modelId: string; api: string }) =>
      addCustomModel(input),
    );

    ipcMain.handle("balance:get", () => fetchBalance());

    ipcMain.handle("net:lan", () => {
      const port = settings?.get().remotePort ?? 7788;
      const token = settings?.get().remoteToken ?? "";
      const urls: string[] = [];
      for (const list of Object.values(networkInterfaces())) {
        for (const info of list ?? []) {
          if (info.family === "IPv4" && !info.internal) {
            urls.push(`http://${info.address}:${port}/?token=${token}`);
          }
        }
      }
      return urls;
    });

    ipcMain.handle("models:deepseek", async () => {
      const key = settings?.get().deepseekApiKey?.trim();
      if (!key) return { ok: false, ids: [] as string[], error: "未配置 Key" };
      try {
        const res = await fetch("https://api.deepseek.com/models", {
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        });
        if (!res.ok) return { ok: false, ids: [] as string[], error: `HTTP ${res.status}` };
        const data: any = await res.json();
        return { ok: true, ids: (data?.data ?? []).map((m: any) => String(m.id)) };
      } catch (err: any) {
        return { ok: false, ids: [] as string[], error: String(err?.message ?? err) };
      }
    });
    ipcMain.handle("github:fixGitignore", () => {
      const res = fixGitignore(sessionCwd);
      if (res.ok) {
        emit({ t: "note", text: res.added ? `已写入 .gitignore（${res.added} 条规则），可以再次上传了。` : "没有需要新增的规则（可能已在 .gitignore 里）。" });
      } else {
        emit({ t: "note", text: `写入 .gitignore 失败：${res.error}` });
      }
      return res;
    });

    ipcMain.handle("github:uploadNow", async () => {
      try {
        await autoUpload(sessionCwd);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    });
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
      session.setAutoApprove(settings!.get().approvalMode === "auto");
        session.setExtraArgs(agentExtraArgs());
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
        start: async (cwd: string, agentId?: string) => {
          try {
            disposeSession();
            const s = settings!.get();
            const agent = findAgent(agentId ?? s.defaultAgent ?? currentAgentId);
            currentSessionId = null;
            currentAgentId = agent.id;
            if (cwd) sessionCwd = cwd;
            session = new AgentSession(agent, emit);
            session.setAutoApprove(s.approvalMode === "auto");
            session.setExtraArgs(agentExtraArgs());
            await session.start(sessionCwd);
            await applyDefaults();
            return { ok: true };
          } catch (err: any) {
            return { ok: false, error: String(err?.message ?? err) };
          }
        },
        history: (id: string) => store?.read(id) ?? [],
        onClients: (count: number) => win?.webContents.send("remote:clients", count),
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

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });

  app.on("window-all-closed", () => {
    disposeSession();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    disposeSession();
  });
}
















































































