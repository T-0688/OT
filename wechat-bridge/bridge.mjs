#!/usr/bin/env node
/**
 * OT ⇄ 微信 ClawBot（iLink）桥接
 *
 * 只出不进：所有请求都是本机发往 ilinkai.weixin.qq.com 的出站请求。
 * 微信消息 → 本地 OT（ws://127.0.0.1:7788/ws）→ agent 回复 → sendmessage 发回微信。
 *
 * 用法：
 *   node bridge.mjs login     # 扫码绑定，生成 qr.png
 *   node bridge.mjs run       # 开始转发（常驻）
 *   node bridge.mjs status    # 看绑定与连接状态
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import WebSocket from "ws";
import QRCode from "qrcode";

const BASE = "https://ilinkai.weixin.qq.com";
const APP_ID = "bot";
const CHANNEL_VERSION = "2.4.10";
const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 10);
const DATA_DIR = path.join(process.env.APPDATA ?? os.homedir(), "ot-wechat");
const ACCOUNT_FILE = path.join(DATA_DIR, "account.json");
const SEEN_FILE = path.join(DATA_DIR, "seen.json");
const BOT_AGENT = "OT-bridge/1.0";

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ───────────────────────── 基础工具 ───────────────────────── */

function wechatUin() {
  const n = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(n), "utf8").toString("base64");
}

function headers(token) {
  const h = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": wechatUin(),
    "iLink-App-Id": APP_ID,
    "iLink-App-ClientVersion": CLIENT_VERSION,
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

async function post(endpoint, body, token, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${BASE}/${endpoint}`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(fixIds(text)) : {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function get(endpoint, token, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${BASE}/${endpoint}`, { headers: headers(token), signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(fixIds(text)) : {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 微信的 msg_id / message_id 是 uint64，直接 JSON.parse 会丢精度，这里先转成字符串 */
function fixIds(text) {
  const fields = new Set(["message_id", "msg_id", "svr_id"]);
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') {
      out += text[i++];
      continue;
    }
    const start = i++;
    let esc = false;
    while (i < text.length) {
      const ch = text[i++];
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') break;
    }
    const tokenStr = text.slice(start, i);
    out += tokenStr;
    let cursor = i;
    while (/\s/.test(text[cursor] ?? "")) cursor++;
    if (text[cursor] !== ":") continue;
    let key;
    try {
      key = JSON.parse(tokenStr);
    } catch {
      continue;
    }
    out += text.slice(i, cursor + 1);
    cursor++;
    i = cursor;
    if (!fields.has(key)) continue;
    let v = cursor;
    while (/\s/.test(text[v] ?? "")) v++;
    const numStart = v;
    if (text[v] === "-") v++;
    while (/\d/.test(text[v] ?? "")) v++;
    if (v > numStart) {
      out += text.slice(i, numStart) + `"${text.slice(numStart, v)}"`;
      i = v;
    }
  }
  return out;
}

const LOG_FILE = path.join(DATA_DIR, "bridge.log");

function log(...args) {
  const line = `[${new Date().toLocaleTimeString("zh-CN")}] ${args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")}`;
  console.log(line);
  try {
    const stat = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
    if (stat && stat.size > 2 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

function loadAccount() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveAccount(data) {
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(data, null, 2), "utf8");
}

function loadSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")));
  } catch {
    return new Set();
  }
}

function saveSeen(set) {
  const arr = [...set].slice(-500);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(arr), "utf8");
}

/* ───────────────────────── OT 侧配置 ───────────────────────── */

function otConfig() {
  const file = path.join(process.env.APPDATA ?? "", "ot", "settings.json");
  let token = process.env.OT_TOKEN ?? "";
  let port = Number(process.env.OT_PORT ?? 0);
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    token = token || s.remoteToken || "";
    port = port || Number(s.remotePort || 0);
  } catch {
    /* ignore */
  }
  return { token, port: port || 7788 };
}

/* ───────────────────────── 登录 / 扫码 ───────────────────────── */

async function login() {
  const existing = loadAccount();
  log("请求微信二维码…");
  const qr = await post("ilink/bot/get_bot_qrcode?bot_type=3", {
    local_token_list: existing?.token ? [existing.token] : [],
  });
  if (!qr.qrcode) throw new Error(`没有拿到 qrcode: ${JSON.stringify(qr).slice(0, 200)}`);
  const link = qr.qrcode_img_content ?? "";
  log("二维码链接:", link || "(无链接，用下面的二维码图片扫描)");

  if (link) {
    const png = path.join(DATA_DIR, "qr.png");
    await QRCode.toFile(png, link, { width: 480, margin: 2 });
    log("二维码已保存:", png);
    log("用手机微信扫码（约 5 分钟内有效）");
  }

  const started = Date.now();
  while (Date.now() - started < 5 * 60_000) {
    let status;
    try {
      status = await get(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`, "", 35_000);
    } catch (err) {
      log("轮询失败，重试:", String(err).slice(0, 120));
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    const s = status.status;
    if (s === "scaned") log("已扫码，请在手机上确认…");
    else if (s === "scaned_but_redirect") log("已扫码，等待跳转确认…");
    else if (s === "expired") {
      log("二维码已过期，请重新运行 login");
      return;
    } else if (s === "confirmed") {
      if (!status.ilink_bot_id || !status.bot_token) throw new Error("确认了但缺少凭证");
      saveAccount({
        token: status.bot_token,
        botId: status.ilink_bot_id,
        userId: status.ilink_user_id ?? "",
        baseUrl: status.baseurl ?? BASE,
        boundUser: "",
        savedAt: new Date().toISOString(),
      });
      log("绑定成功！bot_id =", status.ilink_bot_id);
      log("下一步：node bridge.mjs run");
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  log("登录超时，请重新运行 login");
}

/* ───────────────────────── 与 OT 对话 ───────────────────────── */

let pending = Promise.resolve();

function askOt(text) {
  const run = async () => {
    const { token, port } = otConfig();
    if (!token) throw new Error("读不到 OT 的 remoteToken，请确认 OT 已运行过");
    const url = `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let reply = "";
      let settled = false;
      const finish = (value, err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        err ? reject(err) : resolve(value);
      };
      const timer = setTimeout(() => finish(reply || "（超时，agent 还在跑，稍后可以再问一次）"), 240_000);

      ws.on("open", () => {
        setTimeout(() => ws.send(JSON.stringify({ type: "prompt", text })), 600);
      });
      ws.on("message", (raw) => {
        let ev;
        try {
          ev = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (ev.t === "text") reply += ev.text;
        else if (ev.t === "turn_end") finish(reply || "（没有文本回复）");
        else if (ev.t === "error") finish("", new Error(ev.message || "agent 报错"));
        else if (ev.t === "note") reply += (reply ? "\n" : "") + ev.text;
        else if (ev.t === "permission") {
          // 微信端无法点按钮，默认拒绝危险操作，避免卡死
          ws.send(JSON.stringify({ type: "permission", id: ev.id, optionId: "reject" }));
        }
      });
      ws.on("error", (err) => finish("", err));
      ws.on("close", () => finish(reply || "（连接被关闭）"));
    });
  };
  const chained = pending.then(run, run);
  pending = chained.catch(() => {});
  return chained;
}

/* ───────────────────────── 发送微信 ───────────────────────── */

function plainText(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-z]*\n?/g, "").replace(/```/g, ""))
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "· ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^\s{2,}/gm, "")
    .trim();
}

async function sendText(account, to, text, contextToken) {
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: `ot-${crypto.randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: plainText(text).slice(0, 4000) } }],
      ...(contextToken ? { context_token: contextToken } : {}),
    },
    base_info: baseInfo(),
  };
  const res = await post("ilink/bot/sendmessage", body, account.token, 20_000);
  if (res.ret && res.ret !== 0) throw new Error(`sendmessage ret=${res.ret} ${res.errmsg ?? ""}`);
  return res;
}

/* ───────────────────────── 主循环 ───────────────────────── */

async function run() {
  const account = loadAccount();
  if (!account?.token) {
    log("还没绑定，先运行: node bridge.mjs login");
    process.exit(1);
  }
  const seen = loadSeen();
  let buf = "";
  let backoff = 1000;

  log("已启动，等待微信消息…（Ctrl+C 退出）");

  for (;;) {
    let resp;
    try {
      resp = await post(
        "ilink/bot/getupdates",
        { get_updates_buf: buf, base_info: baseInfo() },
        account.token,
        40_000,
      );
      backoff = 1000;
    } catch (err) {
      const msg = String(err);
      if (/ret["':\s-]*-14|凭证|token.*expired/i.test(msg)) {
        log("错误 -14：微信凭证已过期，请重新运行 node bridge.mjs login 扫码");
      } else {
        log("拉取消息失败，稍后重试:", msg.slice(0, 160));
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(30_000, backoff * 2);
      continue;
    }

    if (resp.ret && resp.ret !== 0) {
      log(`getupdates ret=${resp.ret} ${resp.errmsg ?? ""}`);
      if (resp.ret === -14) log("凭证过期：请重新 node bridge.mjs login 扫码");
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    if (typeof resp.get_updates_buf === "string") buf = resp.get_updates_buf;

    for (const msg of resp.msgs ?? []) {
      const id = String(msg.message_id ?? msg.msg_id ?? "");
      if (id && seen.has(id)) continue;
      if (id) {
        seen.add(id);
        saveSeen(seen);
      }
      if ((msg.message_type ?? 1) !== 1) continue; // 只处理用户消息

      const from = msg.from_user_id ?? "";
      const ctx = msg.context_token ?? "";
      const text = (msg.item_list ?? [])
        .filter((it) => it.type === 1 && it.text_item?.text != null)
        .map((it) => String(it.text_item.text))
        .join("\n")
        .trim();

      if (!from || !text) continue;

      // 第一次收到消息时绑定这个用户，之后只认他
      if (!account.boundUser) {
        account.boundUser = from;
        saveAccount(account);
        log("已绑定唯一用户:", from);
      } else if (account.boundUser !== from) {
        log("忽略非绑定用户:", from);
        continue;
      }

      log("收到微信消息:", text.slice(0, 60));
      try {
        const reply = await askOt(text);
        await sendText(account, from, reply, ctx);
        log("已回复");
      } catch (err) {
        log("处理失败:", String(err).slice(0, 200));
        try {
          await sendText(account, from, `出错了：${String(err).slice(0, 200)}`, ctx);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

function status() {
  const account = loadAccount();
  if (!account?.token) {
    console.log("未绑定");
    return;
  }
  console.log("bot_id:", account.botId);
  console.log("绑定用户:", account.boundUser || "（等第一条消息）");
  console.log("保存时间:", account.savedAt);
  const { token, port } = otConfig();
  console.log("OT 端口:", port, token ? "（token 已读到）" : "（没读到 token）");
}

const cmd = process.argv[2] ?? "run";
if (cmd === "login") await login();
else if (cmd === "status") status();
else await run();


