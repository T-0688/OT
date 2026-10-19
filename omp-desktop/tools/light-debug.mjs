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
  const out = { theme: document.documentElement.dataset.theme,
    bgBase: cs.getPropertyValue('--dsw-alias-bg-base').trim(),
    bluish00: cs.getPropertyValue('--dsw-static-neutral-bluish-00').trim(),
    rules: [] };
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules } catch { continue }
    for (const r of rules) {
      if (r.selectorText && r.selectorText.includes('data-theme="light"')) {
        out.rules.push({ sel: r.selectorText.slice(0,60), len: r.style.length, bgBase: r.style.getPropertyValue('--dsw-alias-bg-base') });
      }
    }
  }
  return JSON.stringify(out);
})()`));
process.exit(0);
