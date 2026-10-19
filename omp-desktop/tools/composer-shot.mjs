import { writeFileSync } from "node:fs";
const PORT="9335";
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
await wait(1500);
console.log("statusbar =", await ev(`document.querySelector('.statusbar')?.innerText.replace(/\\n/g,' | ')`));
console.log("composer =", await ev(`JSON.stringify({plus:!!document.querySelector('.icon-btn'), perm:document.querySelector('.perm-select')?.value, model:document.querySelector('.model-select')?.value, think:document.querySelector('.think-select')?.value})`));
const shot=await race(send("Page.captureScreenshot",{format:"png"}),15000);
if (shot?.data){writeFileSync("shot-composer-final.png",Buffer.from(shot.data,"base64"));console.log("saved");}
process.exit(0);
