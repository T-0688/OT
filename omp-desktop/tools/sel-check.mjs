const PORT = "9342";
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && !t.url.includes("ot-shot-overlay"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
console.log(await ev(`JSON.stringify({
  body: getComputedStyle(document.body).userSelect,
  app: getComputedStyle(document.querySelector('.app')).userSelect,
  main: getComputedStyle(document.querySelector('.main')||document.body).userSelect,
  md: (()=>{const n=document.querySelector('.markdown, .md, .msg.assistant'); return n?getComputedStyle(n).userSelect:'none-found';})(),
  drag: getComputedStyle(document.querySelector('.topbar')||document.body).webkitAppRegion
})`));
process.exit(0);
