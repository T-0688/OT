/** M6 验收：diff 卡片、浅色主题、命令面板。 */
import { writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT ?? "9334";
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
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
const shot = async (file) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (r?.data) {
    writeFileSync(file, Buffer.from(r.data, "base64"));
    console.log("[m6] shot ->", file);
  }
};

// 1. diff 卡片
await evaluate(`document.querySelector('.main').scrollTop = 0`);
await wait(600);
console.log(
  "[m6] diff stats =",
  await evaluate(`JSON.stringify({
    diffCards: document.querySelectorAll('.diff').length,
    added: document.querySelectorAll('.diff-line.add').length,
    removed: document.querySelectorAll('.diff-line.del').length,
    path: document.querySelector('.diff-path')?.textContent ?? null
  })`),
);
await shot("shot-diff-card.png");

// 2. 浅色主题
await evaluate(`document.querySelector('.ghost.icon')?.click()`);
await wait(700);
console.log("[m6] theme =", await evaluate(`document.documentElement.dataset.theme`));
await shot("shot-light.png");

// 3. 命令面板
await evaluate(`document.querySelector('.mini')?.click()`);
await wait(700);
console.log(
  "[m6] palette =",
  await evaluate(`JSON.stringify([...document.querySelectorAll('.palette-item')].map(b => b.innerText))`),
);
await shot("shot-palette.png");

// 关掉面板、切回深色
await evaluate(`document.querySelector('.palette-input')?.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
await evaluate(`document.querySelector('.ghost.icon')?.click()`);
ws.close();
process.exit(0);
