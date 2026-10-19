import fs from "node:fs";
const src = fs.readFileSync("bridge.mjs", "utf8");
const m = src.match(/function fixIds\(text\) \{[\s\S]*?\n\}\n/);
const body = m[0].replace("function fixIds(text) {", "").replace(/\n\}\s*$/, "");
const fn = new Function("text", body);
const sample = '{"msg_id":"v1:77374","message_id":1234567890123456789,"x":1}';
const out = fn(sample);
console.log("out:", out);
console.log("parsed:", JSON.parse(out));
