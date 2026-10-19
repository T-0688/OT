const PORT = "9343";
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && !t.url.includes("ot-shot-overlay"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
console.log("counts:", await ev(`JSON.stringify({ md: document.querySelectorAll('.markdown').length, msgs: document.querySelectorAll('.msg').length })`));
const sel = await ev(`(() => { const ns=[...document.querySelectorAll('.markdown')]; const n=ns[ns.length-1]; if(!n) return 'none'; const range=document.createRange(); range.selectNodeContents(n); const s=getSelection(); s.removeAllRanges(); s.addRange(range); return s.toString().slice(0,40); })()`);
console.log("selected:", sel);
for (const type of ["rawKeyDown","keyUp"]) {
  await send("Input.dispatchKeyEvent", { type, modifiers: 2, key: "c", code: "KeyC", windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67 });
}
await wait(600);
console.log("clipboard:", (await ev(`navigator.clipboard.readText().then(t=>t.slice(0,40)).catch(e=>'ERR '+e.message)`)));
process.exit(0);
