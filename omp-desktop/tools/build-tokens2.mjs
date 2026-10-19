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
const rules = new Map();
let i = -1;
while ((i = text.indexOf("--dsw-", i + 1)) !== -1) {
  const r = ruleAt(i);
  if (r.sel === "body" || r.sel === "body[data-ds-dark-theme]") rules.set(r.sel + "|" + r.body.length, r);
}
const list = [...rules.values()];
const light = list.filter((r) => r.sel === "body").map((r) => r.body.trim().replace(/;?$/, ";")).join("\n");
const dark = list.filter((r) => r.sel !== "body").map((r) => r.body.trim().replace(/;?$/, ";")).join("\n");
console.log("light rules:", list.filter((r) => r.sel === "body").length, "dark rules:", list.filter((r) => r.sel !== "body").length);
console.log("light aliases:", (light.match(/--dsw-alias-bg-base:/g) || []).length, "dark aliases:", (dark.match(/--dsw-alias-bg-base:/g) || []).length);

const css = `/* Design tokens extracted from DeepSeek Harness (MIT).
   Source: packaged client stylesheet (design-platform + ui-theme). */

:root,
:root[data-theme="light"] {
${light}
}

:root[data-theme="dark"] {
${dark}
}
`;
writeFileSync("dsh-tokens.css", css);
console.log("wrote", css.length, "bytes");

