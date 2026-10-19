const t0 = Date.now();
const ws = new WebSocket("ws://127.0.0.1:7788/ws?token=50628324ae47c2c19567d9a8");
let bytes = 0, hello = 0;
ws.onmessage = (e) => {
  bytes += e.data.length;
  const m = JSON.parse(e.data);
  if (m.t === "hello") {
    hello = e.data.length;
    console.log("hello bytes:", hello, "lines:", (m.history||[]).length);
    console.log("first paint ms:", Date.now() - t0);
  }
};
setTimeout(() => { console.log("total bytes:", bytes); process.exit(0); }, 4000);
