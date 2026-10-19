import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AppSettings } from "../shared/types.js";

export const DEFAULT_SETTINGS: AppSettings = {
  defaultAgent: "omp",
  defaultModel: "",
  defaultMode: "",
  defaultCwd: "",
  notifyOnTurnEnd: true,
  theme: "light",
  background: "solid",
  customBackgroundPath: "",
  zoom: 1,
  weWallpaper: null,
  workspaces: [],
  workspaceNames: {},
  hiddenWorkspaces: [],
  remoteEnabled: false,
  remotePort: 7788,
  tunnelEnabled: false,
  tunnelMode: "quick",
  tunnelName: "",
  remoteToken: "",
  reasoningDisplay: "summary",
  bgShade: 0.55,
  bgBlur: 12,
  priceIn: 0,
  priceOut: 0,
  priceCacheIn: 0,
  deepseekPricing: true,
  offPeakFactor: 0.5,
  balanceStart: 0,
  extraDirs: [],
  prewalk: false,
  smolModel: "",
  slowModel: "",
  planModel: "",
  deepseekApiKey: "",
  githubAutoUpload: false,
  githubBlockSecrets: true,
  customModels: [],
  tunnelToken: "",
  tunnelHostname: "",
  sessionView: "grouped",
  defaultThinking: "",
  approvalMode: "ask",
};

/** 应用设置：一个 JSON 文件，缺字段用默认值补齐，方便以后加新项。 */
export class SettingsStore {
  private current: AppSettings;

  constructor(private readonly file: string) {
    this.current = this.load();
  }

  load(): AppSettings {
    let data: Partial<AppSettings> = {};
    if (existsSync(this.file)) {
      try {
        data = JSON.parse(readFileSync(this.file, "utf8"));
      } catch {
        data = {};
      }
    }
    this.current = { ...DEFAULT_SETTINGS, ...data };
    return this.current;
  }

  get(): AppSettings {
    return this.current;
  }

  save(patch: Partial<AppSettings>): AppSettings {
    this.current = { ...this.current, ...patch };
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.current, null, 2), "utf8");
    } catch {
      /* 写失败不让 UI 崩 */
    }
    return this.current;
  }
}
















