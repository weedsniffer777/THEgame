// Bakes models/player.glb (auto-rigged body + UAL skeleton + locomotion clips). Run: node tools/player.mjs [previewDir]
// Inputs in tools/src/: body.glb ("Low-Poly Male Body" by Tidominer, CC BY 4.0) and ual_standard.glb (Quaternius UAL, CC0).
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const types = { ".json": "application/json", ".js": "text/javascript", ".html": "text/html", ".glb": "model/gltf-binary" };
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
}).listen(0);
const [previewDir] = process.argv.slice(2);
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", e => console.error("pageerror:", e.message));
await page.goto(`http://localhost:${server.address().port}/tools/player.html`);
await page.waitForFunction(() => window.__player, null, { timeout: 300000 });
const r = await page.evaluate(() => window.__player);
fs.writeFileSync(path.join(root, "models/player.glb"), Buffer.from(r.b64, "base64"));
if (previewDir) for (const [k, v] of Object.entries(r.previews)) fs.writeFileSync(path.join(previewDir, `pl_${k}.jpg`), Buffer.from(v.split(",")[1], "base64"));
console.log(JSON.stringify(r.info), `${(fs.statSync(path.join(root, "models/player.glb")).size / 1e6).toFixed(2)} MB`);
await browser.close(); server.close();
