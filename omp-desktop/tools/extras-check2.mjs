import { writeFileSync } from "node:fs";
const PORT = process.env.CDP_PORT ?? "9336";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;

// 1) 带图发送
await ev(`(() => {
  const ta = document.querySelector('.composer textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '这张图是什么颜色？只回一个词');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.composer .send')?.click();
  return 'sent';
})()`);
await wait(14000);
console.log("[x2] status =", await ev(`document.querySelector('.statusbar')?.innerText`));
console.log("[x2] user imgs =", await ev(`document.querySelectorAll('.bubble-images img').length`));
console.log("[x2] last =", await ev(`document.body.innerText.slice(-500)`));
const r = await send("Page.captureScreenshot", { format: "png" });
if (r?.data) writeFileSync("shot-image-sent.png", Buffer.from(r.data, "base64"));

// 2) 删除会话（跳过原生确认框）
await ev(`window.confirm = () => true`);
const before = await ev(`document.querySelectorAll('.session-item').length`);
await ev(`document.querySelectorAll('.session-item')[0]?.querySelectorAll('.session-actions button')[1]?.click()`);
await wait(1200);
const after = await ev(`document.querySelectorAll('.session-item').length`);
console.log("[x2] delete:", before, "->", after);
ws.close(); process.exit(0);
