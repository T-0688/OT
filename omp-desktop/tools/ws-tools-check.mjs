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
const shot=async (f)=>{const r=await Promise.race([send("Page.captureScreenshot",{format:"png"}),new Promise(r=>setTimeout(()=>r(null),15000))]); if(r?.data){writeFileSync(f,Buffer.from(r.data,"base64"));console.log("saved",f);}};
await wait(1800);
console.log("tools =", await ev(`JSON.stringify({seg:[...document.querySelectorAll('.seg.tiny button')].map(b=>b.textContent), add: !!document.querySelector('.tool-btn')})`));
// 文件搜索
await ev(`(() => {
  const s = document.querySelector('.search');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(s, 'App');
  s.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await wait(1500);
console.log("file hits =", await ev(`JSON.stringify({panel: !!document.querySelector('.file-hits'), n: document.querySelectorAll('.file-hit').length, first: document.querySelector('.file-hit-name')?.textContent})`));
await shot("shot-workspace-tools.png");
// 平铺视图
await ev(`[...document.querySelectorAll('.seg.tiny button')].find(b=>b.textContent==='按时间')?.click()`);
await wait(800);
console.log("flat =", await ev(`document.querySelectorAll('.session-item').length`));
process.exit(0);
