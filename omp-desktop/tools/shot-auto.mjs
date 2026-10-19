import { writeFileSync } from "node:fs";
const PORT = "9336";
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const race = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

await race(send("Runtime.evaluate", { expression: `[...document.querySelectorAll('.side-tabs button')].find(b => b.textContent === '自动化')?.click()`, returnByValue: true }), 5000);
await new Promise((r) => setTimeout(r, 1500));
const shot = await race(send("Page.captureScreenshot", { format: "png" }), 15000);
if (shot?.data) { writeFileSync("shot-automations.png", Buffer.from(shot.data, "base64")); console.log("saved", shot.data.length); }
else console.log("screenshot timeout");
process.exit(0);
