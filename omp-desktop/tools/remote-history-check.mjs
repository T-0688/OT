const token = process.argv[2];
const res = await fetch(`http://127.0.0.1:7788/api/sessions?token=${token}`);
const data = await res.json();
const ws = new WebSocket(`ws://127.0.0.1:7788/ws?token=${token}`);
const seen = [];
await new Promise((resolve) => {
  ws.onopen = () => setTimeout(() => ws.send(JSON.stringify({ type: "open", id: data.sessions[1].id })), 400);
  ws.onmessage = (e) => { const m = JSON.parse(e.data); seen.push(m.t + (m.history ? `[${m.history.length}]` : "")); };
  setTimeout(resolve, 12000);
});
console.log("events:", seen.join(" | "));
ws.close();
process.exit(0);
