import { writeFileSync } from "node:fs";
const PORT = process.env.CDP_PORT ?? "9335";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;

if ((await ev(`document.documentElement.dataset.theme`)) === "light") {
  await ev(`document.querySelector('.ghost.icon')?.click()`);
  await wait(400);
}
await ev(`document.querySelectorAll('.session-item .session-main')[0]?.click()`);
await wait(5000);
await ev(`document.querySelector('.main').scrollTop = document.querySelector('.main').scrollHeight`);
await wait(800);
console.log("[final]", await ev(`JSON.stringify({imgs: document.querySelectorAll('.bubble-images img').length, sessions: document.querySelectorAll('.session-item').length, hl: document.querySelectorAll('.hljs-keyword').length})`));
const r = await send("Page.captureScreenshot", { format: "png" });
if (r?.data) { writeFileSync("shot-extras.png", Buffer.from(r.data, "base64")); console.log("saved"); }
ws.close(); process.exit(0);
