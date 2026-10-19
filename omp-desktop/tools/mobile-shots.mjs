import { writeFileSync } from "node:fs";
const url = process.argv[2];
const list = await (await fetch("http://127.0.0.1:9557/json/list")).json();
const target = list.find(t => t.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send("Page.enable");
await send("Page.navigate", { url });
await new Promise(r => setTimeout(r, 3500));
const shot1 = await send("Page.captureScreenshot", { format: "png" });
if (shot1?.data) { writeFileSync("shot-mobile-chat.png", Buffer.from(shot1.data, "base64")); console.log("saved chat"); }
await ev(`document.getElementById('listBtn').click()`);
await new Promise(r => setTimeout(r, 1800));
console.log("sessions =", await ev(`document.querySelectorAll('.sess').length`));
const shot2 = await send("Page.captureScreenshot", { format: "png" });
if (shot2?.data) { writeFileSync("shot-mobile-sessions.png", Buffer.from(shot2.data, "base64")); console.log("saved list"); }
process.exit(0);

