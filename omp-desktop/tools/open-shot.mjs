import { writeFileSync } from "node:fs";
const PORT = process.env.CDP_PORT ?? "9334";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;

if ((await evaluate(`document.documentElement.dataset.theme`)) === "light") {
  await evaluate(`document.querySelector('.ghost.icon')?.click()`);
  await wait(400);
}
await evaluate(`document.querySelector('.session-item')?.click()`);
await wait(4500);
await evaluate(`document.querySelector('.diff')?.scrollIntoView({block:'center'})`);
await wait(900);
console.log("[final]", await evaluate(`JSON.stringify({theme: document.documentElement.dataset.theme, diff: !!document.querySelector('.diff'), sessions: document.querySelectorAll('.session-item').length})`));
const r = await send("Page.captureScreenshot", { format: "png" });
if (r?.data) { writeFileSync(process.env.SHOT ?? "shot-final.png", Buffer.from(r.data, "base64")); console.log("saved"); }
ws.close(); process.exit(0);
