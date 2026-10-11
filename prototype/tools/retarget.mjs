// Bakes models/fps_viewmodel.glb from tools/src/ual_standard.glb (Quaternius UAL, CC0, from
// https://quaternius.itch.io/universal-animation-library) + models/fps_arms.glb + models/m1911.glb.
// Run: node tools/retarget.mjs [previewDir] ['{"grip":[0,0.05,0],"palmT":0.55,"eye":[0,0,0]}']
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const types = { ".js": "text/javascript", ".html": "text/html", ".glb": "model/gltf-binary", ".jpg": "image/jpeg", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
}).listen(0);
const [previewDir, tune = "{}"] = process.argv.slice(2);
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
page.on("pageerror", e => console.error("pageerror:", e.message));
page.on("console", m => { if (m.type() === "warning" && !m.text().includes("GL Driver") && !m.text().includes("software WebGL")) console.log("warn:", m.text()); });
await page.goto(`http://localhost:${server.address().port}/tools/retarget.html?tune=${encodeURIComponent(tune)}${previewDir ? "&side=1" : ""}`);
await page.waitForFunction(() => window.__retarget, null, { timeout: 300000 });
const r = await page.evaluate(() => window.__retarget);
fs.writeFileSync(path.join(root, "models/fps_viewmodel.glb"), Buffer.from(r.b64, "base64"));
if (previewDir) for (const [k, v] of Object.entries(r.previews)) fs.writeFileSync(path.join(previewDir, `vm_${k}.jpg`), Buffer.from(v.split(",")[1], "base64"));
console.log(JSON.stringify(r.info), `${(fs.statSync(path.join(root, "models/fps_viewmodel.glb")).size / 1e6).toFixed(2)} MB`);
await browser.close(); server.close();
