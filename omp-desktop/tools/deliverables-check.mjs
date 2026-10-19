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
await wait(1500);
// 展开全部会话，找到 scratch-demo 那条
await ev(`[...document.querySelectorAll('.ws-more')].forEach(b=>b.click())`);
await wait(500);
console.log("sessions =", await ev(`JSON.stringify([...document.querySelectorAll('.session-name')].map(n=>n.textContent).slice(0,10))`));
await ev(`(() => { const b=[...document.querySelectorAll('.session-main')].find(x=>x.textContent.includes('scratch-demo')); b?.click(); })()`);
await wait(5000);
console.log("rail =", await ev(`JSON.stringify({cards: document.querySelectorAll('.file-card').length, names: [...document.querySelectorAll('.file-name')].map(n=>n.textContent)})`));
await ev(`document.querySelector('.file-card .mini')?.click()`);
await wait(1200);
console.log("preview =", await ev(`JSON.stringify({pane: !!document.querySelector('.preview-pane'), name: document.querySelector('.preview-name')?.textContent, code: !!document.querySelector('.preview-code')})`));
const shot=await Promise.race([send("Page.captureScreenshot",{format:"png"}),new Promise(r=>setTimeout(()=>r(null),15000))]);
if (shot?.data){writeFileSync("shot-deliverables.png",Buffer.from(shot.data,"base64"));console.log("saved");}
process.exit(0);
