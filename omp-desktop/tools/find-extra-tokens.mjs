import { readFileSync } from "node:fs";
const text = readFileSync("dsh-css-window.txt", "utf8");
for (const key of ["--dsh-font-family-text-default:", "--dsw-radius-lg:", "--dsw-radius-md:", "--dsw-radius-sm:", "--dsw-radius-xl:"]) {
  const i = text.indexOf(key);
  console.log(key, i > 0 ? text.slice(i, i + 180).split("}")[0] : "NOT FOUND");
}
