/**
 * 验收脚本：通过 CDP 连上已启动的 Electron 窗口，发一条 prompt 并截图。
 * 用法：node tools/verify.mjs
 */
import { writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT ?? "9222";
const OUT = process.env.SHOT ?? "shot.png";
const PROMPT = process.argv[2];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
if (!page) {
  console.error("no page target", list);
  process.exit(1);
}
console.log("[verify] page =", page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? msg.error);
    pending.delete(msg.id);
  }
};
await new Promise((r) => (ws.onopen = r));

const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

await send("Runtime.enable");
await send("Page.enable");

const shot = async (file) => {
  const res = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (res?.data) {
    writeFileSync(file, Buffer.from(res.data, "base64"));
    console.log("[verify] screenshot ->", file);
  } else {
    console.error("[verify] screenshot failed", res);
  }
};

// 等 UI 挂载、会话就绪
await wait(2500);

const state = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    hasApi: !!window.api,
    text: document.body.innerText.slice(0, 400)
  })`,
  returnByValue: true,
  awaitPromise: true,
});
console.log("[verify] state =", state?.result?.value ?? state);

await shot(OUT);

if (PROMPT) {
  const r = await send("Runtime.evaluate", {
    expression: `void window.api.prompt(${JSON.stringify(PROMPT)}); "sent"`,
    returnByValue: true,
  });
  console.log("[verify] prompt ->", r?.result?.value ?? r);
  await wait(Number(process.env.WAIT_MS ?? 9000));

  const modal = await send("Runtime.evaluate", {
    expression: `JSON.stringify([...document.querySelectorAll('.modal-actions .btn')].map(b => b.textContent))`,
    returnByValue: true,
  });
  console.log("[verify] permission buttons =", modal?.result?.value);
  await shot(OUT.replace(/\.png$/, "-after.png"));

  // 如果弹了授权框，点第一个"允许"
  const clicked = await send("Runtime.evaluate", {
    expression: `(() => {
      const btns = [...document.querySelectorAll('.modal-actions .btn')];
      const allow = btns.find(b => /允许|allow/i.test(b.textContent));
      if (allow) { allow.click(); return "clicked:" + allow.textContent; }
      return "no-modal";
    })()`,
    returnByValue: true,
  });
  console.log("[verify] approve ->", clicked?.result?.value);

  await wait(Number(process.env.WAIT_MS2 ?? 10000));
  await shot(OUT.replace(/\.png$/, "-final.png"));
  const after = await send("Runtime.evaluate", {
    expression: `document.body.innerText.slice(0, 2000)`,
    returnByValue: true,
  });
  console.log("[verify] body after =\n", after?.result?.value);
}

ws.close();
process.exit(0);
