import { writeFileSync } from "node:fs";
const PORT="9336";
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const list=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page=list.find(t=>t.type==="page");
const ws=new WebSocket(page.webSocketDebuggerUrl);
let id=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result??m.error);pending.delete(m.id);}};
await new Promise(r=>ws.onopen=r);
const send=(m,p={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async e=>(await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true}))?.result?.value;
const race=(p,ms)=>Promise.race([p,new Promise(r=>setTimeout(()=>r(null),ms))]);

await ev(`[...document.querySelectorAll('.sidebar-foot .link')].find(b=>b.textContent==='设置')?.click()`);
await wait(1200);
console.log("[set] rows =", await ev(`JSON.stringify([...document.querySelectorAll('.set-row')].map(r=>r.innerText.replace(/\\n/g,' | ')))`));
console.log("[set] model options =", await ev(`document.querySelectorAll('.set-group select')[0]?.options.length`));
console.log("[set] current =", await ev(`document.querySelectorAll('.set-group select')[0]?.value`));
// 换模型
console.log("[set] change =", await ev(`(() => {
  const sel = document.querySelectorAll('.set-group select')[0];
  if (!sel || sel.options.length < 2) return 'no-options';
  const target = [...sel.options].map(o => o.value).find(v => v && v !== sel.value);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, target);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'set:' + target;
})()`));
await wait(2500);
console.log("[set] statusbar =", await ev(`document.querySelector('.statusbar')?.innerText.replace(/\\n/g,' | ')`));
// 切浅色
await ev(`[...document.querySelectorAll('.seg button')].find(b=>b.textContent==='浅色')?.click()`);
await wait(900);
console.log("[set] theme =", await ev(`document.documentElement.dataset.theme`));
const shot = await race(send("Page.captureScreenshot",{format:"png"}),15000);
if (shot?.data) { writeFileSync("shot-settings.png", Buffer.from(shot.data,"base64")); console.log("saved"); }
process.exit(0);
