// Bakes tools/shanty.js into models/shanty.glb. Run: node tools/bake.mjs
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
const dir = path.dirname(fileURLToPath(import.meta.url));
const server = http.createServer((req, res) => {
  const f = path.join(dir, decodeURIComponent(req.url.split("?")[0]));
  if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : "text/html" }); fs.createReadStream(f).pipe(res);
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", e => console.error("pageerror:", e.message));
await page.goto(`http://localhost:${port}/bake.html`);
await page.waitForFunction(() => window.__bake, null, { timeout: 600000 });
const r = await page.evaluate(() => window.__bake);
const outFile = path.join(dir, "../models/shanty.glb");
fs.writeFileSync(outFile, Buffer.from(r.b64, "base64"));
console.log(`shanty.glb: ${(fs.statSync(outFile).size / 1e6).toFixed(2)} MB, ${Math.round(r.tris)} tris, ${r.calls} draw calls, ${r.materials} materials`);
await browser.close(); server.close();
