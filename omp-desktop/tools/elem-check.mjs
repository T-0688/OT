const list=await (await fetch(`http://127.0.0.1:9336/json/list`)).json();
const page=list.find(t=>t.type==="page");
const ws=new WebSocket(page.webSocketDebuggerUrl);
let id=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result??m.error);pending.delete(m.id);}};
await new Promise(r=>ws.onopen=r);
const send=(m,p={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async e=>(await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true}))?.result?.value;
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='设置'); b?.click(); })()`);
await new Promise(r=>setTimeout(r,800));
console.log(await ev(`(() => {
  const el = document.elementFromPoint(100, 300);
  const cs = getComputedStyle(el);
  return JSON.stringify({tag: el.tagName, cls: el.className, bg: cs.backgroundColor, rect: el.getBoundingClientRect().toJSON(), mainPad: getComputedStyle(document.querySelector('.main')).paddingLeft});
})()`));
process.exit(0);
