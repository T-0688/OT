import { readFileSync, writeFileSync } from "node:fs";
const asar = "D:\\Users\\Kepler\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";
const text = readFileSync(asar).toString("utf8");

function span(needle) {
  let i = -1, count = 0, min = Infinity, max = -1;
  while ((i = text.indexOf(needle, i + 1)) !== -1) {
    count++;
    if (i < min) min = i;
    if (i > max) max = i;
  }
  return { count, min, max };
}
for (const n of ["--dsw-static-", "--dsw-alias-", "--dsw-elevation-"]) {
  console.log(n, JSON.stringify(span(n)));
}

const alias = span("--dsw-alias-");
const start = Math.max(0, alias.min - 4000);
const end = Math.min(text.length, alias.max + 4000);
const chunk = text.slice(start, end);
writeFileSync("dsh-tokens.css.txt", chunk);
console.log("chunk bytes:", chunk.length);
console.log("head:", chunk.slice(0, 300).replace(/\n/g, " "));
console.log("tail:", chunk.slice(-300).replace(/\n/g, " "));
