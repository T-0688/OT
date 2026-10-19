import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";
const s = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, "ot", "settings.json"), "utf8"));
const url = `ws://127.0.0.1:${s.remotePort || 7788}/ws?token=${encodeURIComponent(s.remoteToken)}`;
const ws = new WebSocket(url);
let reply = "";
ws.on("open", () => setTimeout(() => ws.send(JSON.stringify({ type: "prompt", text: "只回复 OK，不要解释" })), 500));
ws.on("message", (raw) => {
  const ev = JSON.parse(String(raw));
  if (ev.t === "text") reply += ev.text;
  if (ev.t === "turn_end") { console.log("REPLY:", JSON.stringify(reply)); process.exit(0); }
  if (ev.t === "error") { console.log("ERR:", ev.message); process.exit(1); }
});
setTimeout(() => { console.log("TIMEOUT, partial:", JSON.stringify(reply)); process.exit(2); }, 60000);
