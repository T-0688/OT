const PORT = process.env.PORT || "9337";
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
await ev(`(() => { const ta = document.querySelector('.composer textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '用 800 字介绍深海生物，分小节'); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await wait(200);
await ev(`document.querySelector('.send-icon:not(.stop)')?.click()`);
let seen = false;
for (let i = 0; i < 40; i++) {
  await wait(250);
  const s = await ev(`JSON.stringify({ stop: !!document.querySelector('.send-icon.stop'), live: document.querySelector('.stat.live')?.textContent || null })`);
  const o = JSON.parse(s);
  if (o.stop || o.live) { console.log("seen:", s); seen = true; break; }
}
if (!seen) console.log("never running within 10s");
await ev(`document.querySelector('.send-icon.stop')?.click()`);
process.exit(0);
