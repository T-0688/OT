import { writeFileSync } from "node:fs";
const token = "f1b0987be0e5eba82c53ae89";
const url = `http://127.0.0.1:7788/?token=${token}`;
const created = await (await fetch(`http://127.0.0.1:9335/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json();
const ws = new WebSocket(created.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send("Page.enable");
await send("Page.navigate", { url });
await new Promise(r => setTimeout(r, 3500));
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
if (shot?.data) { writeFileSync("shot-mobile.png", Buffer.from(shot.data, "base64")); console.log("saved"); }
process.exit(0);
