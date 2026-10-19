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
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
console.log("[final] bg=", await ev(`document.documentElement.dataset.bg`), " status=", await ev(`document.querySelector('.statusbar')?.innerText.replace(/\\n/g,' | ')`));
await ev(`document.querySelector('.main').scrollTop = 0`);
await wait(500);
const r = await send("Page.captureScreenshot", { format: "png" });
if (r?.data) { writeFileSync("shot-wallpaper-final.png", Buffer.from(r.data, "base64")); console.log("saved"); }
ws.close(); process.exit(0);
