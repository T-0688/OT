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
await ev(`(() => { const ta = document.querySelector('.composer textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '写一篇 1500 字关于火山的文章'); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await wait(200);
await ev(`document.querySelector('.send-icon:not(.stop)')?.click()`);
for (let i = 0; i < 12; i++) {
  await wait(800);
  console.log(i, await ev(`JSON.stringify({ running: !!document.querySelector('.send-icon.stop'), status: document.querySelector('.statusbar')?.innerText.replace(/\\n/g,' | ') })`));
}
await ev(`document.querySelector('.send-icon.stop')?.click()`);
process.exit(0);
