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
  return { sel: text.slice(selStart, open).trim(), css: text.slice(selStart, end) };
}

const statics = [];
let i = -1;
while ((i = text.indexOf("--dsw-static-", i + 1)) !== -1) {
  const r = ruleAt(i);
  if (!statics.some((s) => s.css === r.css)) statics.push(r);
}
console.log("static rules:", statics.length, statics.map((s) => `${s.sel}(${(s.css.match(/--dsw-static-/g) || []).length})`).join(" | "));

const light = ruleAt(text.indexOf("--dsw-alias-"));
const darkPos = text.indexOf("body[data-ds-dark-theme]");
const dark = ruleAt(darkPos);

// 找出静态调色板规则（定义数最多的）
const palette = statics.sort((a, b) => b.css.length - a.css.length)[0];

const css = `/* 从 DeepSeek Harness 客户端提取的设计令牌（MIT）。
   来源：resources/app.asar 内 stylesheet；只取 :root 调色板与 light/dark 两套 alias 映射。 */

:root {
${palette.css.slice(palette.css.indexOf("{") + 1, palette.css.lastIndexOf("}"))}
}

:root[data-theme="light"] {
${light.css.slice(light.css.indexOf("{") + 1, light.css.lastIndexOf("}"))}
}

:root[data-theme="dark"] {
${dark.css.slice(dark.css.indexOf("{") + 1, dark.css.lastIndexOf("}"))}
}
`;
writeFileSync("dsh-tokens.css", css);
console.log("wrote dsh-tokens.css", css.length, "bytes");
console.log("palette defs:", (palette.css.match(/--dsw-static-/g) || []).length, "light:", (light.css.match(/--dsw-alias-/g) || []).length, "dark:", (dark.css.match(/--dsw-alias-/g) || []).length);
