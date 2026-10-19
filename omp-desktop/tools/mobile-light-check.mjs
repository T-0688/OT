import { writeFileSync } from "node:fs";
const list = await (await fetch("http://127.0.0.1:9562/json/list")).json();
const target = list.find(t => t.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send("Page.enable");
await send("Page.navigate", { url: "file:///D:/.Daily/DeepSeek%20Harness/mobile/index.html?host=127.0.0.1:7788&token=50628324ae47c2c19567d9a8" });
await new Promise(r => setTimeout(r, 3000));
await ev(`applyTheme('light')`);
await ev(`openSheet()`);
await new Promise(r => setTimeout(r, 1500));
const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot?.data) { writeFileSync("shot-mobile-light.png", Buffer.from(shot.data, "base64")); console.log("saved"); }
process.exit(0);
