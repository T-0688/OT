import { readFileSync, writeFileSync } from "node:fs";
const text = readFileSync("dsh-css-window.txt", "utf8");
const center = 120_000;
const open = text.lastIndexOf("{", center);
const prevClose = text.lastIndexOf("}", open);
const selStart = prevClose + 1;
const sel = text.slice(selStart, open);
let depth = 0, end = open;
for (let i = open; i < text.length; i++) {
  if (text[i] === "{") depth++;
  else if (text[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
const rule = text.slice(selStart, end);
console.log("selector:", JSON.stringify(sel.slice(0, 120)));
console.log("rule length:", rule.length);
const defs = [...rule.matchAll(/--dsw-[a-z0-9-]+\s*:/g)].length;
console.log("defs in rule:", defs);
writeFileSync("dsh-theme-rule.css", rule);
console.log(rule.slice(0, 400));
