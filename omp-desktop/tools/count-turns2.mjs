import { readFileSync } from "node:fs";
import * as fzstd from "fzstd";
const file = "C:\\Users\\Kepler\\.dsh\\sessions\\--D-.Daily-DeepSeek~0020Harness--\\session-31f9b441-2c68-4a69-852a-39638209920a\\session.v4.jsonl.zstd";
const buf = readFileSync(file);
const out = fzstd.decompress(buf);
const text = Buffer.from(out).toString("utf8");
const lines = text.split("\n").filter(Boolean);
console.log("bytes:", out.length, "lines:", lines.length);
const kinds = {};
for (const line of lines) { try { const o = JSON.parse(line); const k = o.role ?? o.type ?? o.kind ?? "?"; kinds[k] = (kinds[k] ?? 0) + 1; } catch {} }
console.log(JSON.stringify(kinds));
