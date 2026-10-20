#!/usr/bin/env node
/**
 * ot-control MCP server
 * 给 agent 一组工具，操作本机 OT 的会话：
 *   - list_sessions        列出所有会话（标题/目录/最后活跃）
 *   - send_message         给某个会话发一句话（后台执行，不切换桌面视图）
 *   - start_session        新建后台会话（指定工作目录）
 *   - wait_reply           等某会话这一轮跑完，取回复文本
 *
 * 走 OT 的本地 HTTP API（127.0.0.1），token 从 %APPDATA%\ot\settings.json 读。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const settingsFile = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "ot", "settings.json");
const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
const PORT = process.env.OT_PORT ?? settings.remotePort ?? 7788;
const TOKEN = process.env.OT_TOKEN ?? settings.remoteToken ?? "";
const BASE = `http://127.0.0.1:${PORT}`;

async function api(pathname, init = {}) {
  const url = `${BASE}${pathname}${pathname.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}`;
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`${pathname} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return data;
}

const TOOLS = [
  {
    name: "list_sessions",
    description: "列出本机 OT 的所有会话（id、标题、工作目录、更新时间）。给别的会话发消息前先用它找到目标。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "send_message",
    description: "给指定会话发一条消息，在后台执行，不会切换桌面当前视图。返回后可以用 wait_reply 等结果。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "目标会话 id（来自 list_sessions）" },
        text: { type: "string", description: "要发的内容" },
      },
      required: ["session_id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "start_session",
    description: "新建一个后台会话，指定工作目录。返回新会话 id。",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string", description: "工作目录绝对路径" } },
      required: ["cwd"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_reply",
    description: "等某个会话完成当前这一轮，返回这一轮的助手回复文本。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        timeout_seconds: { type: "number", description: "默认 180" },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
];

function lastTurn(events) {
  let startIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].t === "user") {
      startIdx = i;
      break;
    }
  }
  const slice = startIdx >= 0 ? events.slice(startIdx) : events;
  const text = slice
    .filter((e) => e.t === "text")
    .map((e) => e.text)
    .join("");
  const ended = slice.some((e) => e.t === "turn_end");
  return { text, ended };
}

async function callTool(name, args) {
  if (name === "list_sessions") {
    const data = await api("/api/sessions");
    const rows = (data.sessions ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      updatedAt: s.updatedAt,
    }));
    return JSON.stringify({ current: data.current ?? null, sessions: rows }, null, 2);
  }
  if (name === "send_message") {
    const data = await api("/api/send", {
      method: "POST",
      body: JSON.stringify({ sessionId: args.session_id, text: args.text }),
    });
    return JSON.stringify(data);
  }
  if (name === "start_session") {
    const data = await api("/api/start", {
      method: "POST",
      body: JSON.stringify({ cwd: args.cwd }),
    });
    return JSON.stringify(data);
  }
  if (name === "wait_reply") {
    const timeout = Math.min(900, Number(args.timeout_seconds ?? 180)) * 1000;
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const data = await api(`/api/events?sessionId=${encodeURIComponent(args.session_id)}&limit=400`);
      const { text, ended } = lastTurn(data.events ?? []);
      if (ended && text) return text;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return "（等待超时，目标会话可能还在跑）";
  }
  throw new Error(`unknown tool: ${name}`);
}

/* ---------------- MCP stdio ---------------- */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    void handle(req);
  }
});

async function handle(req) {
  const { id, method, params } = req;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ot-control", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    try {
      const text = await callTool(params.name, params.arguments ?? {});
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text }], isError: false },
      });
    } catch (err) {
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true },
      });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}
