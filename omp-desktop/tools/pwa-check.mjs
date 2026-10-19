const [base, token] = process.argv.slice(2);
const man = await (await fetch(`${base}/manifest.webmanifest`)).text();
console.log("manifest:", man.slice(0, 120));
const icon = await fetch(`${base}/icon-192.png`);
console.log("icon:", icon.status, icon.headers.get("content-type"));
const html = await (await fetch(`${base}/?token=${token}`)).text();
console.log("html has manifest:", html.includes('rel="manifest"'), "listBtn:", html.includes('id="listBtn"'));
process.exit(0);
