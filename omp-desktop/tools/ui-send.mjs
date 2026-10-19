/** 模拟真人操作：往输入框打字并点发送，然后截图。 */
import { writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT ?? "9333";
const TEXT = process.argv[2] ?? "你好";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
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

await send("Page.enable");

const typed = await send("Runtime.evaluate", {
  expression: `(() => {
    const ta = document.querySelector('.composer textarea');
    if (!ta) return 'no-textarea';
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(TEXT)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = document.querySelector('.composer .send');
    btn?.click();
    return 'sent:' + (btn ? btn.textContent : 'no-button');
  })()`,
  returnByValue: true,
});
console.log("[ui] ", typed?.result?.value);

await wait(Number(process.env.WAIT_MS ?? 10000));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot?.data) {
  writeFileSync(process.env.SHOT ?? "shot-ui.png", Buffer.from(shot.data, "base64"));
  console.log("[ui] screenshot ->", process.env.SHOT ?? "shot-ui.png");
}
const body = await send("Runtime.evaluate", {
  expression: `document.body.innerText.slice(0, 1200)`,
  returnByValue: true,
});
console.log("[ui] body =\n", body?.result?.value);
ws.close();
process.exit(0);
