import { writeFileSync } from "node:fs";
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const list=await (await fetch(`http://127.0.0.1:9336/json/list`)).json();
const page=list.find(t=>t.type==="page");
const ws=new WebSocket(page.webSocketDebuggerUrl);
let id=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result??m.error);pending.delete(m.id);}};
await new Promise(r=>ws.onopen=r);
const send=(m,p={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async e=>(await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true}))?.result?.value;
await ev(`[...document.querySelectorAll('.side-tabs button')].find(b=>b.textContent.includes('会话'))?.click()`);
await wait(1200);
const shot=await Promise.race([send("Page.captureScreenshot",{format:"png"}),new Promise(r=>setTimeout(()=>r(null),15000))]);
if (shot?.data){writeFileSync("shot-bg-chat.png",Buffer.from(shot.data,"base64"));console.log("saved light");}
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='设置'); b?.click(); })()`);
await wait(600);
await ev(`[...document.querySelectorAll('.seg button')].find(b=>b.textContent==='深色')?.click()`);
await wait(1200);
const shot2=await Promise.race([send("Page.captureScreenshot",{format:"png"}),new Promise(r=>setTimeout(()=>r(null),15000))]);
if (shot2?.data){writeFileSync("shot-bg-dark.png",Buffer.from(shot2.data,"base64"));console.log("saved dark");}
process.exit(0);
