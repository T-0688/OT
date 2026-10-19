import { readFileSync, writeFileSync } from "node:fs";
const text = readFileSync("dsh-css-window.txt", "utf8");
const rules = new Map();
let i = -1;
while ((i = text.indexOf("--dsw-alias-", i + 1)) !== -1) {
  const open = text.lastIndexOf("{", i);
  if (open < 0) continue;
  const prevClose = text.lastIndexOf("}", open);
  const selStart = prevClose + 1;
  if (rules.has(selStart)) continue;
  let depth = 0, end = -1;
  for (let j = open; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) continue;
  const rule = text.slice(selStart, end);
  const defs = [...rule.matchAll(/--dsw-[a-z0-9-]+\s*:/g)].length;
  if (defs > 20) {
    rules.set(selStart, { sel: text.slice(selStart, open).trim(), rule, defs });
  }
}
const out = [...rules.values()];
console.log("candidate rules:", out.length);
for (const r of out) console.log(" -", JSON.stringify(r.sel.slice(0, 80)), "defs:", r.defs, "len:", r.rule.length);
writeFileSync("dsh-theme-rules.css", out.map((r) => r.rule).join("\n\n"));
