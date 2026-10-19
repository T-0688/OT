import { readFileSync, writeFileSync } from "node:fs";
const text = readFileSync("dsh-css-window.txt", "utf8");

function blockFrom(start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { css: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return { css: text.slice(start), end: text.length };
}

const rootAt = text.indexOf(":root");
const selectorStart = text.lastIndexOf("}", rootAt) + 1;
const first = blockFrom(rootAt);
let out = text.slice(selectorStart, rootAt) + first.css;
let cursor = first.end;
console.log("first block selector/len:", text.slice(selectorStart, rootAt + 1), first.css.length);

// 继续收集后面含 --dsw- 的规则（暗色覆盖等）
for (let n = 0; n < 8; n++) {
  const nextOpen = text.indexOf("{", cursor);
  if (nextOpen < 0) break;
  const prevClose = text.lastIndexOf("}", nextOpen);
  const selStart = prevClose + 1;
  const sel = text.slice(selStart, nextOpen);
  if (sel.length > 200) { cursor = nextOpen + 1; continue; }
  const blk = blockFrom(nextOpen);
  const hasTokens = /--dsw-/.test(blk.css);
  console.log("next rule:", sel.trim().slice(0, 60), "len", blk.css.length, "tokens", hasTokens);
  if (hasTokens) {
    out += "\n\n" + text.slice(selStart, nextOpen) + blk.css;
    cursor = blk.end;
  } else {
    cursor = blk.end;
  }
}
writeFileSync("dsh-theme-extract.css", out);
const defs = [...out.matchAll(/--dsw-[a-z0-9-]+\s*:/g)].map(m => m[0]);
console.log("total defs:", defs.length, "alias:", defs.filter(d => d.startsWith("--dsw-alias-")).length);
