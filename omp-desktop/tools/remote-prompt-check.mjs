const token = "b40754fdfc0ec730838ad9e2";
const ws = new WebSocket(`ws://127.0.0.1:7788/ws?token=${token}`);
const seen = [];
await new Promise((resolve) => {
  ws.onopen = () => { ws.send(JSON.stringify({ type: "prompt", text: "只回复两个字：在的" })); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    seen.push(m.t + (m.text ? `(${m.text.slice(0, 12)})` : ""));
  };
  setTimeout(resolve, 16000);
});
console.log("events:", seen.slice(0, 20).join(" | "));
ws.close();
process.exit(0);
