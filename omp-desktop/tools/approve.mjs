/** 点掉授权弹窗并截图。 */
import { writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT ?? "9333";
const LABEL = process.env.LABEL ?? "Allow once";
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

const clicked = await send("Runtime.evaluate", {
  expression: `(() => {
    const btns = [...document.querySelectorAll('.modal-actions .btn')];
    const b = btns.find(x => x.textContent.trim() === ${JSON.stringify(LABEL)}) ?? btns.find(x => /allow/i.test(x.textContent));
    if (!b) return 'no-modal';
    b.click();
    return 'clicked:' + b.textContent;
  })()`,
  returnByValue: true,
});
console.log("[approve]", clicked?.result?.value);

await wait(Number(process.env.WAIT_MS ?? 12000));
const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot?.data) {
  writeFileSync(process.env.SHOT ?? "shot-approved.png", Buffer.from(shot.data, "base64"));
  console.log("[approve] screenshot ->", process.env.SHOT ?? "shot-approved.png");
}
const body = await send("Runtime.evaluate", { expression: `document.body.innerText.slice(0, 1500)`, returnByValue: true });
console.log("[approve] body =\n", body?.result?.value);
ws.close();
process.exit(0);
