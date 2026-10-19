import { writeFileSync } from "node:fs";
const list=await (await fetch(`http://127.0.0.1:9335/json/list`)).json();
const page=list.find(t=>t.type==="page");
const ws=new WebSocket(page.webSocketDebuggerUrl);
let id=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result??m.error);pending.delete(m.id);}};
await new Promise(r=>ws.onopen=r);
const send=(m,p={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async e=>(await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true}))?.result?.value;
await new Promise(r=>setTimeout(r,1000));
console.log(await ev(`JSON.stringify({version: document.querySelector('.version')?.textContent, nav: [...document.querySelectorAll('.nav-item')].map(b=>b.textContent.trim()), phone: document.querySelector('.phone-state')?.textContent.trim(), statusbar: document.querySelector('.statusbar')?.innerText.replace(/\\n/g,' | ').slice(0,120)})`));
const shot=await send("Page.captureScreenshot",{format:"png"});
if(shot?.data){writeFileSync("shot-1.3.png",Buffer.from(shot.data,"base64"));console.log("saved");}
process.exit(0);
