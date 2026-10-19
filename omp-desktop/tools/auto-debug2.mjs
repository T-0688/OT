const PORT = "9336";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.consoleAPICalled") logs.push(m.params.args.map(a => a.value ?? a.description).join(" "));
  if (m.method === "Runtime.exceptionThrown") logs.push("EXC: " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); }
};
await new Promise((r) => (ws.onopen = r));
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
await send("Runtime.enable");
await send("Log.enable");

await ev(`[...document.querySelectorAll('.side-tabs button')].find(b => b.textContent === '自动化')?.click()`);
await wait(600);
await ev(`document.querySelector('.panel-head .btn.primary')?.click()`);
await wait(800);
console.log("form open =", await ev(`!!document.querySelector('.card.form')`));
await ev(`(() => {
  const setV = (el, v) => { const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const inputs = [...document.querySelectorAll('.card.form input')];
  setV(inputs[0], 'UI 冒烟');
  setV(document.querySelector('.card.form textarea'), '只回复 OK');
  return inputs[0].value;
})()`);
await wait(400);
console.log("name value =", await ev(`document.querySelector('.card.form input').value`));
console.log("click save =", await ev(`(() => { const b = [...document.querySelectorAll('.card.form .btn')].find(x => x.textContent.trim() === '保存'); if (!b) return 'no-button'; b.click(); return 'ok'; })()`));
await wait(1500);
console.log("form open after save =", await ev(`!!document.querySelector('.card.form')`));
console.log("list =", await ev(`window.api.automations().then(r => JSON.stringify(r.map(t => t.name)))`));
console.log("console =", JSON.stringify(logs.slice(-6)));
ws.close(); process.exit(0);
