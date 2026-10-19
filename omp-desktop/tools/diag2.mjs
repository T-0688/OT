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
  const pick = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return { bg: cs.backgroundColor, color: cs.color, opacity: cs.opacity, filter: cs.filter, colorScheme: cs.colorScheme }; };
  return JSON.stringify({
    theme: document.documentElement.dataset.theme,
    newChat: pick('.new-chat'),
    search: pick('.search'),
    select: pick('.select'),
    mode: pick('.ef-select.mode .ef-select-btn'),
    send: pick('.send-icon'),
    rootColorScheme: getComputedStyle(document.documentElement).colorScheme
  });
})()`));
process.exit(0);
