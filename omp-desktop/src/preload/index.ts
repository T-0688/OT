import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, RendererApi, StartOptions } from "../shared/types.js";

const api: RendererApi = {
  agents: () => ipcRenderer.invoke("agents:list"),
  sessions: () => ipcRenderer.invoke("agent:sessions"),
  openSession: (id: string) => ipcRenderer.invoke("agent:open", id),
  start: (options?: StartOptions) => ipcRenderer.invoke("agent:start", options),
  resume: (id: string) => ipcRenderer.invoke("agent:resume", id),
  prompt: (text: string, images?: any[]) => ipcRenderer.invoke("agent:prompt", text, images),
  renameSession: (id: string, title: string) => ipcRenderer.invoke("agent:rename", id, title),
  deleteSession: (id: string) => ipcRenderer.invoke("agent:delete", id),
  searchMessages: (q: string) => ipcRenderer.invoke("agent:search", q),
  respondPermissionBg: (sessionId: string, toolCallId: string, optionId: string) => ipcRenderer.invoke("agent:permission-bg", sessionId, toolCallId, optionId),
  respondPermission: (toolCallId: string, optionId: string) =>
    ipcRenderer.invoke("agent:permission", toolCallId, optionId),
  setConfig: (configId: string, value: string) => ipcRenderer.invoke("agent:config", configId, value),
  cancel: () => ipcRenderer.invoke("agent:cancel"),
  pickDirectory: () => ipcRenderer.invoke("dialog:pickDirectory"),
  wallpaper: () => ipcRenderer.invoke("system:wallpaper"),
  pickImage: () => ipcRenderer.invoke("system:pickImage"),
  readImage: (path: string) => ipcRenderer.invoke("system:readImage", path),
  pickFiles: () => ipcRenderer.invoke("dialog:pickFiles"),
  setApprovalMode: (mode: "ask" | "auto") => ipcRenderer.invoke("agent:approval", mode),
  skills: () => ipcRenderer.invoke("skills:list"),
  openPath: (path: string) => ipcRenderer.invoke("skills:open", path),
  settings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch: any) => ipcRenderer.invoke("settings:save", patch),
  openDataDir: () => ipcRenderer.invoke("app:openDataDir"),
  appVersion: () => ipcRenderer.invoke("app:version"),
  weWallpapers: () => ipcRenderer.invoke("we:scan"),
  mediaUrl: (path: string) => `ompmedia://local/?path=${encodeURIComponent(path)}`,
  searchFiles: (root: string, query: string) => ipcRenderer.invoke("fs:search", root, query),
  readFile: (path: string) => ipcRenderer.invoke("fs:read", path),
  addCustomModel: (input: unknown) => ipcRenderer.invoke("models:addCustom", input),
  getBalance: () => ipcRenderer.invoke("balance:get"),
  testPush: () => ipcRenderer.invoke("push:test"),
  translateThinking: (text: string) => ipcRenderer.invoke("think:translate", text),
  healthCheck: () => ipcRenderer.invoke("health:check"),
  modelPricing: () => ipcRenderer.invoke("models:pricing"),
  providerBalances: () => ipcRenderer.invoke("balance:providers"),
  searchSessions: (q: string) => ipcRenderer.invoke("sessions:search", q),
  saveSchedule: (task: any) => ipcRenderer.invoke("schedules:save", task),
  deleteSchedule: (id: string) => ipcRenderer.invoke("schedules:delete", id),
  runSchedule: (id: string) => ipcRenderer.invoke("schedules:run", id),
  listTasks: () => ipcRenderer.invoke("tasks:list"),
  cancelTask: (id: string) => ipcRenderer.invoke("tasks:cancel", id),
  openTask: (id: string) => ipcRenderer.invoke("tasks:open", id),
  deepseekModels: () => ipcRenderer.invoke("models:deepseek"),
  lanUrls: () => ipcRenderer.invoke("net:lan"),
  uploadNow: () => ipcRenderer.invoke("github:uploadNow"),
  fixGitignore: () => ipcRenderer.invoke("github:fixGitignore"),
  remoteStatus: () => ipcRenderer.invoke("remote:status"),
  remoteStart: () => ipcRenderer.invoke("remote:start"),
  remoteStop: () => ipcRenderer.invoke("remote:stop"),
  remoteTunnel: (on: boolean) => ipcRenderer.invoke("remote:tunnel", on),
  startScreenshot: () => ipcRenderer.invoke("screenshot:start"),

  onAskSelection: (cb: (text: string) => void) => {
    const handler = (_e: unknown, text: string) => cb(text);
    ipcRenderer.on("menu:ask-selection", handler as never);
    return () => ipcRenderer.removeListener("menu:ask-selection", handler as never);
  },

  onScreenshot: (cb: (base64: string) => void) => {
    const handler = (_e: unknown, base64: string) => cb(base64);
    ipcRenderer.on("screenshot:capture", handler as never);
    return () => ipcRenderer.removeListener("screenshot:capture", handler as never);
  },

  onRemoteClients: (cb: (count: number) => void) => {
    const handler = (_e: unknown, count: number) => cb(count);
    ipcRenderer.on("remote:clients", handler as never);
    return () => ipcRenderer.removeListener("remote:clients", handler as never);
  },
  onRemoteTunnel: (cb: (url: string) => void) => {
    const handler = (_e: unknown, status: unknown) => cb(String(status ?? ""));
    ipcRenderer.on("remote:tunnel", handler as never);
    return () => ipcRenderer.removeListener("remote:tunnel", handler as never);
  },
  saveCheckpoint: (sessionId: string, turnId: string, path: string, oldText: string | null) =>
    ipcRenderer.invoke("checkpoint:save", sessionId, turnId, path, oldText),
  restoreCheckpointRange: (sessionId: string, turnIds: string[]) => ipcRenderer.invoke("checkpoint:restore-range", sessionId, turnIds),
  restoreCheckpoint: (sessionId: string, turnId: string) => ipcRenderer.invoke("checkpoint:restore", sessionId, turnId),
  revealInFolder: (path: string) => ipcRenderer.invoke("fs:reveal", path),
  openWith: (path: string) => ipcRenderer.invoke("fs:openWith", path),
  clearSessions: () => ipcRenderer.invoke("sessions:clear"),
  onEvent: (cb: (event: AgentEvent) => void) => {
    const listener = (_e: unknown, event: AgentEvent) => cb(event);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
};

contextBridge.exposeInMainWorld("api", api);


































