import { writeFileSync } from "node:fs";
const PORT = process.env.CDP_PORT ?? "9336";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;

const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==";
await ev(`(async () => {
  const bytes = Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0));
  const file = new File([bytes], 'pixel.png', { type: 'image/png' });
  const dt = new DataTransfer(); dt.items.add(file);
  const ta = document.querySelector('.composer textarea');
  ta.focus();
  ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 500));
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '用 read 工具看一下这张图，告诉我它大概是什么颜色');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.composer .send')?.click();
  return 'sent';
})()`);

await wait(12000);
let clicked = await ev(`(() => { const b = [...document.querySelectorAll('.modal-actions .btn')].find(x => /allow/i.test(x.textContent)); if (b) { b.click(); return b.textContent; } return 'none'; })()`);
console.log("[img] approve =", clicked);
await wait(12000);
clicked = await ev(`(() => { const b = [...document.querySelectorAll('.modal-actions .btn')].find(x => /allow/i.test(x.textContent)); if (b) { b.click(); return b.textContent; } return 'none'; })()`);
console.log("[img] approve2 =", clicked);
await wait(8000);
console.log("[img] status =", await ev(`document.querySelector('.statusbar')?.innerText`));
console.log("[img] body tail =\n" + (await ev(`document.body.innerText.slice(-700)`)));
const r = await send("Page.captureScreenshot", { format: "png" });
if (r?.data) { writeFileSync("shot-image-sent.png", Buffer.from(r.data, "base64")); console.log("saved"); }
ws.close(); process.exit(0);
