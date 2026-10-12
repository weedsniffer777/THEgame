// Bakes simplified gun models into models/guns/*.glb. Run: node tools/guns.mjs (needs tools/src/guns/*.glb)
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
const dir = path.dirname(fileURLToPath(import.meta.url));
const server = http.createServer((req, res) => {
  const f = path.join(dir, decodeURIComponent(req.url.split("?")[0]));
  if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : f.endsWith(".glb") ? "model/gltf-binary" : "text/html" }); fs.createReadStream(f).pipe(res);
}).listen(0);
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", e => console.error("pageerror:", e.message)); page.on("console", m => { if (m.type() !== "log") console.log(m.text()); });
await page.goto(`http://localhost:${server.address().port}/guns.html`);
await page.waitForFunction(() => window.__guns, null, { timeout: 600000 });
const r = await page.evaluate(() => window.__guns);
fs.mkdirSync(path.join(dir, "../models/guns"), { recursive: true });
fs.mkdirSync(path.join(dir, "../models/guns/icons"), { recursive: true });
for (const [n, v] of Object.entries(r)) {
  fs.writeFileSync(path.join(dir, `../models/guns/icons/${n}.png`), Buffer.from(v.png, "base64"));
  if (!v.b64) { console.log(`${n}: icon only`); continue; }
  const f = path.join(dir, `../models/guns/${n}.glb`); fs.writeFileSync(f, Buffer.from(v.b64, "base64")); console.log(`${n}: ${v.before} -> ${v.after} verts, ${(fs.statSync(f).size / 1e3).toFixed(0)} KB`);
}
await browser.close(); server.close();
