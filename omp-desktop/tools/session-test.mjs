/** 验证 M4：点开历史会话 → 恢复 → 追问，检查上下文是否接上。 */
import { writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT ?? "9333";
const ASK = process.argv[2] ?? "刚才的暗号是什么？只回复暗号本身";
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

await wait(1500);

const before = await evaluate(`JSON.stringify([...document.querySelectorAll('.session-item')].map(b => b.innerText))`);
console.log("[m4] sidebar sessions =", before);

const clicked = await evaluate(`(() => {
  const b = document.querySelector('.session-item');
  if (!b) return 'no-session';
  b.click();
  return 'clicked:' + b.innerText.replace(/\\n/g, ' / ');
})()`);
console.log("[m4] click ->", clicked);

await wait(5000);

const status = await evaluate(`document.querySelector('.statusbar')?.innerText`);
console.log("[m4] status =", status);

const typed = await evaluate(`(() => {
  const ta = document.querySelector('.composer textarea');
  if (!ta) return 'no-textarea';
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(ASK)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.composer .send')?.click();
  return 'sent';
})()`);
console.log("[m4] follow-up ->", typed);

await wait(Number(process.env.WAIT_MS ?? 12000));
const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot?.data) {
  writeFileSync(process.env.SHOT ?? "shot-m4.png", Buffer.from(shot.data, "base64"));
  console.log("[m4] screenshot ->", process.env.SHOT ?? "shot-m4.png");
}
console.log("[m4] body =\n", await evaluate(`document.body.innerText.slice(0, 1200)`));
ws.close();
process.exit(0);
