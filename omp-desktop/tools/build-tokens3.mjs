import { readFileSync, writeFileSync } from "node:fs";
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
  return { sel: text.slice(selStart, open).trim(), body: text.slice(open + 1, end - 1) };
}
const bodies = new Map();
let i = -1;
while ((i = text.indexOf("--dsw-", i + 1)) !== -1) {
  const r = ruleAt(i);
  if (r.sel === "body" || r.sel === "body[data-ds-dark-theme]") {
    bodies.set(`${r.sel}|${r.body.length}`, r);
  }
}
const list = [...bodies.values()];
const clean = (b) => b.trim().replace(/;?$/, ";");

// 调色板：所有 --dsw-static-* 定义（与主题无关）
const paletteRules = list.filter((r) => (r.body.match(/--dsw-static-/g) || []).length > 10);
const palette = paletteRules.map((r) => clean(r.body)).join("\n");
const light = list.filter((r) => r.sel === "body").map((r) => clean(r.body)).join("\n");
const dark = list.filter((r) => r.sel !== "body").map((r) => clean(r.body)).join("\n");

const css = `/* Design tokens extracted from DeepSeek Harness (MIT). */

:root {
${palette}
}

:root,
:root[data-theme="light"] {
${light}
}

:root[data-theme="dark"] {
${dark}
}
`;
writeFileSync("dsh-tokens.css", css);
console.log("palette rules:", paletteRules.length, "bytes:", css.length);
console.log("palette has bluish-00:", css.includes("--dsw-static-neutral-bluish-00:"));
