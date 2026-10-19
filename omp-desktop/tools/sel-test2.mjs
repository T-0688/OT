const PORT = "9342";
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && !t.url.includes("ot-shot-overlay"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
const box = JSON.parse(await ev(`(() => { const nodes=[...document.querySelectorAll('.md, .markdown, .msg.assistant')]; for (const n of nodes) { const r=n.getBoundingClientRect(); if (r.top>100 && r.bottom<650 && r.width>200 && n.innerText.length>40) { return JSON.stringify({x:r.x+20,y:r.y+10,w:Math.min(400,r.width-30),h:16}); } } return 'null'; })()`));
console.log("box:", JSON.stringify(box));
if (box) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + box.w, y: box.y + box.h, button: "left" });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + box.w, y: box.y + box.h, button: "left", clickCount: 1 });
  console.log("selection:", await ev(`window.getSelection().toString().slice(0,100)`));
  console.log("copyable:", await ev(`document.queryCommandSupported && document.queryCommandSupported('copy')`));
}
process.exit(0);
