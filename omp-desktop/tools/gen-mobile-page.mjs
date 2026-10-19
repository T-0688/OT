import { readFileSync, writeFileSync } from "node:fs";
const html = readFileSync(new URL("../../mobile/index.html", import.meta.url), "utf8");
const out = `// 自动生成，别手改；源文件：mobile/index.html\nconst PAGE = ${JSON.stringify(html)};\nexport default PAGE;\n`;
writeFileSync(new URL("../src/main/mobile-page.ts", import.meta.url), out, "utf8");
console.log("mobile-page.ts", html.length, "bytes");
