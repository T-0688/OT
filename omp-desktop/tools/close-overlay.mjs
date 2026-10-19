const t = await (await fetch('http://127.0.0.1:9342/json/list')).json();
const o = t.find(x=>x.url.includes('ot-shot-overlay'));
if (o) { const ws = new WebSocket(o.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r); ws.send(JSON.stringify({id:1,method:'Page.close'})); await new Promise(r=>setTimeout(r,300)); }
process.exit(0);
