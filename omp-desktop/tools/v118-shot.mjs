import { writeFileSync } from "node:fs";
const PORT = "9342";
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
  await new Promise(r => ws.onopen = r);
  const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  return { send, ws };
}
const mainList = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = mainList.find(t => t.type === "page");
const main = await connect(page);
const ev = async e => (await main.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
await ev(`window.api.startScreenshot()`);
await wait(2500);
const list2 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
console.log("targets:", list2.map(t => t.url.slice(0, 60)));
const overlay = list2.find(t => t.url.includes("ot-shot-overlay"));
if (!overlay) { console.log("no overlay"); process.exit(1); }
const ov = await connect(overlay);
const metrics = await ov.send("Page.getLayoutMetrics");
console.log("overlay size:", JSON.stringify(metrics.cssVisualViewport));
await ov.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 200, y: 150, button: "left", clickCount: 1 });
await ov.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 420, button: "left" });
await ov.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 600, y: 420, button: "left", clickCount: 1 });
await wait(1500);
const after = await ev(`JSON.stringify({ chips: document.querySelectorAll('.attach-chip, .attachments img, .composer-attachments img').length, text: document.body.innerText.includes('screenshot') })`);
console.log("after:", after);
const shot = await main.send("Page.captureScreenshot", { format: "png" });
if (shot?.data) writeFileSync("shot-1.18.png", Buffer.from(shot.data, "base64"));
process.exit(0);
