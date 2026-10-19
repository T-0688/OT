const list=await (await fetch(`http://127.0.0.1:9335/json/list`)).json();
const page=list.find(t=>t.type==="page");
const ws=new WebSocket(page.webSocketDebuggerUrl);
let id=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result??m.error);pending.delete(m.id);}};
await new Promise(r=>ws.onopen=r);
const send=(m,p={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async e=>(await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true}))?.result?.value;
await ev(`window.api.remoteTunnel(true)`);
for (let i=0;i<20;i++) {
  const s = JSON.parse(await ev(`window.api.remoteStatus().then(s=>JSON.stringify(s))`));
  console.log(i*3+"s", s.tunnelState, s.tunnelUrl ?? "", s.error ?? "");
  if (s.tunnelState === "running" || s.tunnelState === "error") break;
  await new Promise(r=>setTimeout(r,3000));
}
process.exit(0);
