const base = "http://127.0.0.1:7788";
const token = "b40754fdfc0ec730838ad9e2";
const html = await (await fetch(`${base}/?token=${token}`)).text();
console.log("page bytes:", html.length, "has ws:", html.includes("/ws?token="));
const bad = await fetch(`${base}/?token=nope`);
console.log("bad token status:", bad.status);
const ws = new WebSocket(`ws://127.0.0.1:7788/ws?token=${token}`);
const seen = [];
await new Promise((resolve, reject) => {
  ws.onopen = () => console.log("ws open");
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    seen.push(m.t);
    if (m.t === "hello") console.log("hello:", JSON.stringify({ title: m.title, cwd: m.cwd, history: (m.history || []).length }));
  };
  ws.onerror = reject;
  setTimeout(resolve, 2500);
});
console.log("events:", seen.join(","));
ws.close();
process.exit(0);
