const port = "9346";
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === "page" && !t.url.includes("ot-shot-overlay"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;

// 模拟手机客户端
const client = new WebSocket("ws://127.0.0.1:7788/ws?token=50628324ae47c2c19567d9a8");
const msgs = [];
client.onmessage = (e) => { const m = JSON.parse(e.data); msgs.push(m.t); if (m.t === "notify") console.log("NOTIFY:", JSON.stringify(m)); };
await new Promise((r) => { client.onopen = r; });
await wait(800);

await ev(`(() => { const ta=document.querySelector('.composer textarea'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(ta,'只回复 OK'); ta.dispatchEvent(new Event('input',{bubbles:true})); })()`);
await wait(200);
await ev(`document.querySelector('.send-icon:not(.stop)')?.click()`);
for (let i=0;i<25;i++){ await wait(1000); if (msgs.includes("notify")) break; }
console.log("types seen:", msgs.slice(-8).join(","));
client.close();
process.exit(0);
