const url = "https://manufacture-speed-uncertainty-interim.trycloudflare.com";
const token = "45bfafc19443ac7d3c126198";
const res = await fetch(`${url}/?token=${token}`, { redirect: "follow" });
const html = await res.text();
console.log("public status:", res.status, "bytes:", html.length, "title ok:", html.includes("OMP Desktop"));
const bad = await fetch(`${url}/?token=nope`);
console.log("bad token:", bad.status);
process.exit(0);
