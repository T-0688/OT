const PORT = process.env.PORT || "9337";
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: false }))?.result?.value;
await wait(500);
await send("Runtime.evaluate", { expression: `void window.api.prompt('从 1 数到 60，每行一个数字')`, returnByValue: true });
for (const t of [1200, 2500, 4000]) {
  await wait(t === 1200 ? 1200 : 1300);
  console.log(t, "live:", await ev(`document.querySelector('.stat.live')?.textContent || 'none'`), "| stop:", await ev(`(() => { const b=document.querySelector('.send-icon.stop'); return b ? getComputedStyle(b).backgroundColor : 'none'; })()`));
}
await send("Runtime.evaluate", { expression: `document.querySelector('.send-icon.stop')?.click()` });
process.exit(0);
