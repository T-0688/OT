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
await wait(1200);
// 打开右键菜单 → 重命名
await ev(`(() => { const el = document.querySelector('.ws-head'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 10 })); })()`);
await wait(400);
await ev(`[...document.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('重命名'))?.click()`);
await wait(400);
console.log("editing =", await ev(`!!document.querySelector('.ws-rename')`));
await ev(`(() => {
  const input = document.querySelector('.ws-rename');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'OMP 主工作区');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})()`);
await wait(900);
console.log("name =", await ev(`document.querySelector('.ws-name')?.textContent`));
const shot=await Promise.race([send("Page.captureScreenshot",{format:"png"}),new Promise(r=>setTimeout(()=>r(null),15000))]);
if (shot?.data){writeFileSync("shot-ws-rename.png",Buffer.from(shot.data,"base64"));console.log("saved");}
process.exit(0);
