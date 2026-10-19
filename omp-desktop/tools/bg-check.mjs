const list=await (await fetch(`http://127.0.0.1:9336/json/list`)).json();
const page=list.find(t=>t.type==="page");
const ws=new WebSocket(page.webSocketDebuggerUrl);
let id=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result??m.error);pending.delete(m.id);}};
await new Promise(r=>ws.onopen=r);
const send=(m,p={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async e=>(await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true}))?.result?.value;
console.log("state =", await ev(`JSON.stringify({bg: document.documentElement.dataset.bg, layer: !!document.querySelector('.bg-layer'), children: document.querySelector('.bg-layer')?.innerHTML.slice(0,120)})`));
// 打开设置，点桌面壁纸
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='设置'); b?.click(); })()`);
await new Promise(r=>setTimeout(r,800));
await ev(`[...document.querySelectorAll('.seg button')].find(b=>b.textContent.includes('桌面壁纸'))?.click()`);
await new Promise(r=>setTimeout(r,1500));
console.log("after =", await ev(`JSON.stringify({bg: document.documentElement.dataset.bg, layer: !!document.querySelector('.bg-layer'), layerBg: document.querySelector('.bg-layer') ? getComputedStyle(document.querySelector('.bg-layer')).backgroundImage.slice(0,80) : null, panelBg: getComputedStyle(document.querySelector('.panel.settings')).backgroundColor})`));
process.exit(0);
