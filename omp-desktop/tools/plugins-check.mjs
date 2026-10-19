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
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
const shot = async (f) => { const r = await send("Page.captureScreenshot", { format: "png" }); if (r?.data) { writeFileSync(f, Buffer.from(r.data, "base64")); console.log("shot ->", f); } };

// 插件面板
await ev(`[...document.querySelectorAll('.side-tabs button')].find(b => b.textContent === '插件')?.click()`);
await wait(1500);
console.log("[ui] plugins =", await ev(`JSON.stringify([...document.querySelectorAll('.card-title')].map(n => n.innerText))`));
console.log("[ui] commands =", await ev(`JSON.stringify([...document.querySelectorAll('.card-actions button')].map(b => b.textContent))`));
await shot("shot-plugins.png");
console.log("[ui] run hello =", await ev(`[...document.querySelectorAll('.card-actions button')].find(b => b.textContent.includes('打招呼'))?.click(); 'clicked'`));
await wait(1200);

// 自动化面板：新建 + 立即运行
await ev(`[...document.querySelectorAll('.side-tabs button')].find(b => b.textContent === '自动化')?.click()`);
await wait(500);
await ev(`document.querySelector('.panel-head .btn.primary')?.click()`);
await wait(600);
console.log("[ui] form =", await ev(`JSON.stringify({labels: [...document.querySelectorAll('.card.form label')].map(l => l.textContent.slice(0,8)), inputs: document.querySelectorAll('.card.form input').length})`));
await ev(`(() => {
  const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const inputs = [...document.querySelectorAll('.card.form input')];
  const name = inputs.find(i => i.type === 'text' || !i.type);
  set(name, '自动冒烟测试');
  const ta = document.querySelector('.card.form textarea');
  set(ta, '只回复两个字：OK');
  const sel = document.querySelector('.card.form select');
  sel.value = 'interval'; sel.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await wait(500);
await ev(`(() => {
  const num = document.querySelector('.card.form input[type=number]');
  if (num) { const s = Object.getOwnPropertyDescriptor(num.constructor.prototype, 'value').set; s.call(num, '30'); num.dispatchEvent(new Event('input', { bubbles: true })); }
  [...document.querySelectorAll('.card.form .card-actions .btn')].find(b => b.textContent === '保存')?.click();
})()`);
await wait(1200);
console.log("[ui] tasks =", await ev(`JSON.stringify([...document.querySelectorAll('.card-title')].map(n => n.innerText))`));
console.log("[ui] run now =", await ev(`[...document.querySelectorAll('.card-actions button')].find(b => b.textContent === '立即运行')?.click(); 'clicked'`));
await wait(18000);
console.log("[ui] task cards =", await ev(`document.querySelector('.panel')?.innerText.slice(0, 700)`));
await shot("shot-automations.png");
ws.close(); process.exit(0);
