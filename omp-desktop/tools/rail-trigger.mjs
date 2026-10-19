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
console.log("send =", await ev(`window.api.prompt('把 scratch-demo.ts 里的 VERSION 改成 2，改完只回 done').then(r=>JSON.stringify(r))`));
await wait(15000);
for (let i=0;i<3;i++) {
  const clicked = await ev(`(() => { const b = [...document.querySelectorAll('.modal-actions .btn')].find(x => /allow/i.test(x.textContent)); if (b) { b.click(); return b.textContent; } return 'none'; })()`);
  if (clicked === 'none') break;
  console.log("approve:", clicked);
  await wait(8000);
}
await wait(4000);
console.log("state =", await ev(`JSON.stringify({tools: document.querySelectorAll('.tool').length, diffs: document.querySelectorAll('.diff').length, cards: document.querySelectorAll('.file-card').length})`));
process.exit(0);
