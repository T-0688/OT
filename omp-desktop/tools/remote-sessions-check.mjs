const token = process.argv[2];
const base = "http://127.0.0.1:7788";
const res = await fetch(`${base}/api/sessions?token=${token}`);
const data = await res.json();
console.log("sessions:", data.sessions.length, "current:", data.current);
console.log("first:", JSON.stringify(data.sessions[0]?.title));
const ws = new WebSocket(`ws://127.0.0.1:7788/ws?token=${token}`);
const seen = [];
const target = data.sessions[1]?.id;
await new Promise((resolve) => {
  ws.onopen = () => setTimeout(() => ws.send(JSON.stringify({ type: "open", id: target })), 400);
  ws.onmessage = (e) => { const m = JSON.parse(e.data); seen.push(m.t + (m.title ? `(${m.title.slice(0,10)})` : "")); };
  setTimeout(resolve, 12000);
});
console.log("events:", seen.slice(0, 12).join(" | "));
ws.close();
process.exit(0);
