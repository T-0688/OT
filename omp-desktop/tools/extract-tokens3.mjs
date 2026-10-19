import { readFileSync, writeFileSync } from "node:fs";
const asar = "D:\\Users\\Kepler\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";
const buf = readFileSync(asar);
const start = 46_600_000;
const len = 800_000;
const chunk = buf.subarray(start, start + len).toString("utf8");
writeFileSync("dsh-css-window.txt", chunk);

const defs = [...chunk.matchAll(/--dsw-[a-z0-9-]+\s*:/g)].map(m => m[0]);
const aliases = defs.filter(d => d.startsWith("--dsw-alias-"));
console.log("definitions in window:", defs.length, "alias defs:", aliases.length);
console.log("first 10:", aliases.slice(0, 10).join(" "));
// 找 :root 或选择器开头
const idx = chunk.indexOf(":root");
console.log(":root index in window:", idx);
console.log("window head:", chunk.slice(0, 200).replace(/\n/g, " "));
