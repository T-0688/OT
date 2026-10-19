import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
const file = "C:\\Users\\Kepler\\.dsh\\sessions\\--D-.Daily-DeepSeek~0020Harness--\\session-31f9b441-2c68-4a69-852a-39638209920a\\session.v4.jsonl.zstd";
const buf = readFileSync(file);
let text;
try { text = zstdDecompressSync(buf).toString("utf8"); } catch (e) { console.log("decompress failed:", e.message); process.exit(1); }
const lines = text.split("\n").filter(Boolean);
console.log("lines:", lines.length);
const kinds = {};
for (const line of lines) {
  try { const o = JSON.parse(line); const k = o.role ?? o.type ?? o.kind ?? "?"; kinds[k] = (kinds[k] ?? 0) + 1; } catch {}
}
console.log(JSON.stringify(kinds));
const users = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(o => o && (o.role === "user" || o.type === "user"));
console.log("user entries:", users.length);
console.log("sample:", JSON.stringify(users[0]).slice(0, 300));
