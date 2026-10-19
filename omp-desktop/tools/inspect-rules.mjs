import { readFileSync } from "node:fs";
const text = readFileSync("dsh-css-window.txt", "utf8");
function ruleAt(pos) {
  const open = text.lastIndexOf("{", pos);
  const prevClose = text.lastIndexOf("}", open);
  const selStart = prevClose + 1;
  let depth = 0, end = -1;
  for (let j = open; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return { sel: text.slice(selStart, open).trim(), css: text.slice(selStart, end) };
}
const seen = new Map();
for (const key of ["--dsw-static-neutral-bluish-00:", "--dsw-alias-bg-base:"]) {
  let i = -1;
  while ((i = text.indexOf(key, i + 1)) !== -1) {
    const r = ruleAt(i);
    if (!seen.has(r.css)) seen.set(r.css, r);
  }
}
for (const r of seen.values()) {
  const stats = (r.css.match(/--dsw-static-/g) || []).length;
  const alias = (r.css.match(/--dsw-alias-/g) || []).length;
  const sel = r.sel.replace(/\s+/g, " ").slice(0, 70);
  if (stats + alias > 30) console.log(`sel=${JSON.stringify(sel)} statics=${stats} aliases=${alias} len=${r.css.length}`);
}
