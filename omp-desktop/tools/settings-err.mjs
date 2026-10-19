const PORT = "9349";
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && !t.url.includes("ot-shot-overlay"));
if (!page) { console.log("no page"); process.exit(0); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    console.log("EXCEPTION:", d.text, d.exception?.description?.split("\n")[0]);
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    console.log("CONSOLE ERR:", m.params.args.map(a => a.value || a.description).join(" ").slice(0, 200));
  }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); }
};
await new Promise(r => ws.onopen = r);
const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
await send("Runtime.enable");
await wait(300);
console.log("view before:", await ev(`document.querySelector('.app')?.dataset.view`));
await ev(`(() => { const b=[...document.querySelectorAll('.side-foot button, button')].find(x=>x.textContent.includes('设置')); if (b) b.click(); })()`);
await wait(1500);
console.log("view after:", await ev(`document.querySelector('.app')?.dataset.view`));
console.log("body text:", await ev(`document.body.innerText.slice(0,150)`));
process.exit(0);
