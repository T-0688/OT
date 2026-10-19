import { readFileSync, writeFileSync } from "node:fs";
const asar = "D:\\Users\\Kepler\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";
const buf = readFileSync(asar);
const text = buf.toString("utf8");
console.log("size MB:", (buf.length / 1024 / 1024).toFixed(1));
for (const needle of ["--dsw-alias-bg-layer-1:", "--dsw-alias-bg-layer-1 :", "dsw-alias-text-primary"]) {
  const i = text.indexOf(needle);
  console.log(needle, "->", i);
}
const i = text.indexOf("--dsw-alias-bg-layer-1:");
if (i > 0) {
  const start = Math.max(0, i - 1500);
  const chunk = text.slice(start, i + 2500);
  writeFileSync("dsh-tokens-raw.txt", chunk);
  console.log("---- context ----");
  console.log(chunk.slice(0, 1200));
}
