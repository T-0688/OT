/** 主进程与渲染进程共用的类型。UI 只认这些事件，不认任何具体 agent。 */

export type ConfigChoice = {
  value: string;
  name: string;
  description?: string | null;
};

export type ConfigOption = {
  id: string;
  name: string;
  category?: string | null;
  type?: "select" | "boolean";
  currentValue?: string | boolean | null;
  options?: ConfigChoice[];
};

export type PermissionChoice = {
  optionId: string;
  name: string;
  kind: string;
};

export type RemoteStatus = {
  running: boolean;
  url: string | null;
  tunnelState: "stopped" | "starting" | "running" | "error";
  tunnelUrl: string | null;
  error: string | null;
};

export type ToolDiff = {
  path: string;
  oldText?: string | null;
  newText: string;
};

export type ImagePart = {
  data: string;
  mimeType: string;
  name?: string;
};

export type SearchHit = { id: string; count: number; snippet: string };

export type AgentEvent =
  | { t: "user"; text: string; images?: ImagePart[] }
  | { t: "ready"; sessionId: string; cwd: string; agentId: string; configOptions: ConfigOption[] }
  | { t: "text"; text: string }
  | { t: "thinking"; text: string }
  | { t: "tool_start"; id: string; title: string; toolKind?: string; status?: string; input?: unknown }
  | { t: "tool_update"; id: string; title?: string; status?: string; text?: string; diff?: ToolDiff }
  | {
      t: "permission";
      id: string;
      title: string;
      toolKind?: string;
      options: PermissionChoice[];
    }
  | { t: "permission_resolved"; id: string; optionId?: string }
  | { t: "usage"; used?: number; size?: number; costUsd?: number }
  | {
      t: "turn_end";
      stopReason: string;
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedReadTokens?: number };
    }
  | { t: "note"; text: string }
  | { t: "error"; message: string }
  | { t: "log"; text: string }
  | { t: "agent_exit"; code: number | null };

/** 落盘的会话元数据。 */
export type SessionMeta = {
  id: string;
  agentId: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  stats?: { tokens: number; cost: number; turns: number; used?: number; size?: number; cachePct?: number };
};

export type AgentInfo = {
  id: string;
  name: string;
  command: string;
  detected: boolean;
  version?: string;
};

export type StartOptions = {
  agentId?: string;
  cwd?: string;
};

export type WeWallpaper = {
  id: string;
  title: string;
  type: string;
  dir: string;
  media: string;
  preview: string;
};

export type ScheduleTask = {
  id: string;
  title: string;
  cwd: string;
  prompt: string;
  everyMinutes: number;
  dailyAt: string;
  enabled: boolean;
  lastRunAt?: string;
};

export type AppSettings = {
  defaultAgent: string;
  defaultModel: string;
  defaultMode: string;
  defaultCwd: string;
  notifyOnTurnEnd: boolean;
  theme: "dark" | "light";
  background: "solid" | "wallpaper" | "custom" | "we";
  customBackgroundPath: string;
  zoom: number;
  weWallpaper: WeWallpaper | null;
  workspaces: string[];
  workspaceNames: Record<string, string>;
  hiddenWorkspaces: string[];
  remoteEnabled: boolean;
  remotePort: number;
  tunnelEnabled: boolean;
  tunnelMode: "quick" | "named" | "local";
  tunnelName: string;
  remoteToken: string;
  reasoningDisplay: "full" | "summary" | "hidden";
  translateProvider: "local" | "omp" | "deepseek" | "off";
  translateAllowCloud: boolean;
  showTools: boolean;
  pinnedSessions: string[];
  providerBalanceUrls: Record<string, string>;
  schedules: ScheduleTask[];
  bgShade: number;
  bgBlur: number;
  priceIn: number;
  priceOut: number;
  priceCacheIn: number;
  deepseekPricing: boolean;
  offPeakFactor: number;
  balanceStart: number;
  extraDirs: string[];
  prewalk: boolean;
  smolModel: string;
  slowModel: string;
  planModel: string;
  deepseekApiKey: string;
  githubAutoUpload: boolean;
  githubBlockSecrets: boolean;
  officialModelsOnly: boolean;
  lastSessionId: string;
  pushProvider: "off" | "ntfy" | "bark";
  pushNtfyServer: string;
  pushNtfyTopic: string;
  pushNtfyUser: string;
  pushNtfyPass: string;
  pushBarkUrl: string;
  pushClickBase: string;
  pushDeepLink: boolean;
  customModels: { name: string; baseUrl: string; apiKey: string; modelId: string; api: string }[];
  tunnelToken: string;
  tunnelHostname: string;
  sessionView: "grouped" | "flat";
  defaultThinking: string;
  approvalMode: "ask" | "auto";
};

export type SkillInfo = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  hide: boolean;
};
export type RendererApi = {
  agents(): Promise<AgentInfo[]>;
  sessions(): Promise<SessionMeta[]>;
  openSession(id: string): Promise<{ meta: SessionMeta; events: AgentEvent[] } | null>;
  start(options?: StartOptions): Promise<{ sessionId: string }>;
  resume(id: string): Promise<{ ok: boolean; error?: string }>;
  prompt(text: string, images?: ImagePart[]): Promise<{ ok: boolean; error?: string }>;
  renameSession(id: string, title: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  searchMessages(query: string): Promise<SearchHit[]>;
  respondPermission(toolCallId: string, optionId: string): Promise<void>;
  respondPermissionBg(sessionId: string, toolCallId: string, optionId: string): Promise<boolean>;
  setConfig(configId: string, value: string): Promise<{ ok: boolean; error?: string }>;
  cancel(): Promise<void>;
  pickDirectory(): Promise<string | null>;
  wallpaper(): Promise<string | null>;
  pickImage(): Promise<{ path: string; dataUrl: string } | null>;
  pickFiles(): Promise<string[]>;
  setApprovalMode(mode: "ask" | "auto"): Promise<void>;
  readImage(path: string): Promise<string | null>;

  skills(): Promise<SkillInfo[]>;
  openPath(path: string): Promise<void>;
  settings(): Promise<AppSettings>;
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  openDataDir(): Promise<void>;
  appVersion(): Promise<string>;
  weWallpapers(): Promise<WeWallpaper[]>;
  mediaUrl(path: string): string;
  searchFiles(root: string, query: string): Promise<{ path: string; name: string }[]>;
  readFile(path: string): Promise<{ ok: boolean; text?: string; error?: string }>;
  remoteStatus(): Promise<RemoteStatus>;
  remoteStart(): Promise<RemoteStatus>;
  remoteStop(): Promise<RemoteStatus>;
  remoteTunnel(on: boolean): Promise<RemoteStatus>;
  addCustomModel(input: { name: string; baseUrl: string; apiKey: string; modelId: string; api: string }): Promise<{ ok: boolean; error?: string }>;
  getBalance(): Promise<{ ok: boolean; currency?: string; total?: number; error?: string }>;
  testPush(): Promise<{ ok: boolean; error?: string }>;
  translateThinking(text: string): Promise<string>;
  healthCheck(): Promise<Record<string, boolean>>;
  modelPricing(): Promise<{ selector: string; input: number; output: number; cacheRead: number }[]>;
  providerBalances(): Promise<{ provider: string; ok: boolean; amount?: number; currency?: string; error?: string; detail?: string; models?: { model: string; requests: number; cost: number; tokens: number }[] }[]>;
  searchSessions(q: string): Promise<{ id: string; title: string; cwd: string; role: string; snippet: string }[]>;
  saveSchedule(task: ScheduleTask): Promise<ScheduleTask[]>;
  deleteSchedule(id: string): Promise<ScheduleTask[]>;
  runSchedule(id: string): Promise<boolean>;
  listTasks(): Promise<{ id: string; busy: boolean; lastSeen: number; title: string; cwd: string; status?: "idle" | "running" | "permission" | "failed" }[]>;
  cancelTask(id: string): Promise<boolean>;
  openTask(id: string): Promise<SessionMeta | null>;
  onRemoteClients(cb: (n: number) => void): void;
  onRemoteTunnel(cb: (url: string | null) => void): void;
  deepseekModels(): Promise<{ ok: boolean; ids: string[]; error?: string }>;
  lanUrls(): Promise<string[]>;
  onScreenshot(cb: (base64: string) => void): () => void;
  startScreenshot(): Promise<void>;
  onAskSelection(cb: (text: string) => void): () => void;
  uploadNow(): Promise<{ ok: boolean; error?: string }>;
  fixGitignore(): Promise<{ ok: boolean; added: number; error?: string }>;
  saveCheckpoint(sessionId: string, turnId: string, path: string, oldText: string | null): Promise<void>;
  restoreCheckpoint(sessionId: string, turnId: string): Promise<{ restored: number; removed: number; failed: number }>;
  restoreCheckpointRange(sessionId: string, turnIds: string[]): Promise<{ restored: number; removed: number; failed: number }>;
  revealInFolder(path: string): Promise<void>;
  openWith(path: string): Promise<{ ok: boolean; error?: string }>;
  clearSessions(): Promise<void>;
  onEvent(cb: (event: AgentEvent) => void): () => void;
};


















































declare global {
  interface Window {
    api: RendererApi;
  }
}










