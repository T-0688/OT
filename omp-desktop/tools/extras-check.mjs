/** 锦上添花验收：代码高亮、重命名、全文搜索、图片粘贴。 */
import { writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT ?? "9336";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result ?? m.error);
    pending.delete(m.id);
  }
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
const shot = async (file) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (r?.data) {
    writeFileSync(file, Buffer.from(r.data, "base64"));
    console.log("[x] shot ->", file);
  }
};

// 打开一个带代码块的旧会话
await ev(`document.querySelector('.session-item .session-main')?.click()`);
await wait(4500);
console.log(
  "[x] highlight =",
  await ev(`JSON.stringify({kw: document.querySelectorAll('.hljs-keyword').length, str: document.querySelectorAll('.hljs-string').length, code: document.querySelectorAll('.markdown pre code').length})`),
);

// 重命名第一个会话
await ev(`document.querySelector('.session-item .session-actions button')?.click()`);
await wait(400);
await ev(`(() => {
  const input = document.querySelector('.rename-input');
  if (!input) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'RENAMED-BY-TEST');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return 'renamed';
})()`);
await wait(900);
console.log("[x] sidebar =", await ev(`JSON.stringify([...document.querySelectorAll('.session-name')].map(n => n.textContent))`));

// 全文搜索
await ev(`(() => {
  const s = document.querySelector('.search');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(s, 'scratch-demo');
  s.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await wait(1200);
console.log(
  "[x] search =",
  await ev(`JSON.stringify({
    items: [...document.querySelectorAll('.session-item')].length,
    meta: [...document.querySelectorAll('.session-meta')].map(n => n.textContent),
    snippet: document.querySelector('.session-snippet')?.textContent ?? null
  })`),
);
await shot("shot-search.png");

// 清空搜索
await ev(`(() => {
  const s = document.querySelector('.search');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(s, '');
  s.dispatchEvent(new Event('input', { bubbles: true }));
})()`);

// 粘贴一张 2x2 红色 PNG
await wait(500);
console.log(
  "[x] paste =",
  await ev(`(async () => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==';
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], 'pixel.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ta = document.querySelector('.composer textarea');
    ta.focus();
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 600));
    return document.querySelectorAll('.attachment').length;
  })()`),
);
await shot("shot-image.png");
ws.close();
process.exit(0);
