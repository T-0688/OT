import { execFile } from "node:child_process";
import type { AgentInfo } from "../shared/types.js";

/**
 * Agent 注册表 —— 换 Agent 的入口。
 * 只要对方支持 ACP（`<cmd> acp` 或类似启动方式），加一条就完事。
 */
export type AgentDef = {
  id: string;
  name: string;
  command: string;
  args: string[];
};

export const AGENTS: AgentDef[] = [
  {
    id: "omp",
    name: "Oh My Pi",
    command: process.env.OMP_BIN ?? "omp",
    args: ["acp"],
  },
  {
    id: "claude",
    name: "Claude Code (ACP)",
    command: "claude-code-acp",
    args: [],
  },
  {
    id: "custom",
    name: "自定义 ACP",
    command: process.env.ACP_BIN ?? "omp",
    args: (process.env.ACP_ARGS ?? "acp").split(" ").filter(Boolean),
  },
];

export function findAgent(id: string | undefined): AgentDef {
  return AGENTS.find((a) => a.id === id) ?? AGENTS[0];
}

/** 探测命令是否存在，尽量拿到版本号。 */
export function detectAgent(def: AgentDef): Promise<AgentInfo> {
  return new Promise((resolve) => {
    execFile(def.command, ["--version"], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({ id: def.id, name: def.name, command: def.command, detected: false });
        return;
      }
      const version = String(stdout).trim().split(/\r?\n/)[0].slice(0, 40);
      resolve({ id: def.id, name: def.name, command: def.command, detected: true, version });
    });
  });
}

export async function listAgents(): Promise<AgentInfo[]> {
  return Promise.all(AGENTS.map(detectAgent));
}
