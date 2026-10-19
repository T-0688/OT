const PORT="9336";
const list=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page=list.find(t=>t.type==="page");
const ws=new WebSocket(page.webSocketDebuggerUrl);
let id=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result??m.error);pending.delete(m.id);}};
await new Promise(r=>ws.onopen=r);
const send=(m,p={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async e=>(await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true}))?.result?.value;
console.log(await ev(`(() => {
  const cs = getComputedStyle(document.documentElement);
  const keys = ['--dsw-font-family','--dsw-static-neutral-50','--dsw-static-neutral-bluish-00','--dsw-static-red-900','--dsw-alias-bg-layer-1','--dsw-alias-bg-base','--dsw-alias-label-primary'];
  return JSON.stringify({theme: document.documentElement.dataset.theme, v: Object.fromEntries(keys.map(k => [k, cs.getPropertyValue(k).trim().slice(0,40)]))});
})()`));
process.exit(0);
