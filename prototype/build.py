"""Build dist/index.html as a single file with every model inlined.

Regenerate inputs when their sources change:
  node tools/bake.mjs     -> models/shanty.glb
  node tools/player.mjs   -> models/player.glb
  node tools/guns.mjs     -> models/guns/*.glb (simplified Shoot Them Off guns)
"""
import base64, pathlib
root = pathlib.Path(__file__).parent
out = root / "dist"; out.mkdir(exist_ok=True)
b64 = lambda p: base64.b64encode((root / p).read_bytes()).decode()
src = (root / "game.src.html").read_text()
src = (src.replace("__PLAYER_B64__", b64("models/player.glb"))
          .replace("__M1911_B64__", b64("models/m1911.glb"))
          .replace("__SHANTY_B64__", b64("models/shanty.glb"))
          .replace("__TWIG_B64__", b64("models/pine_twig.png"))
          .replace("__BARK_B64__", b64("models/pine_bark.jpg")))
import json   # sound effects: sounds/*.mp3 (Kenney, CC0)
src = src.replace("__SFX_JSON__", json.dumps({f.stem: b64(f"sounds/{f.name}") for f in sorted((root / "sounds").glob("*.mp3"))}))
for f in sorted((root / "models/guns").glob("*.glb")):
    src = src.replace(f"__GUN_{f.stem}_B64__", b64(f"models/guns/{f.name}"))
for f in sorted((root / "models/guns/icons").glob("*.png")):   # shop icons rendered from the full-quality models
    src = src.replace(f"__GUNICON_{f.stem}__", b64(f"models/guns/icons/{f.name}"))

# Fonts: embedded instead of loaded from Google Fonts.
fonts = (root / "fonts/fonts.css").read_text()
for f in sorted((root / "fonts").glob("*.woff2")):
    fonts = fonts.replace(f"__FONT_{f.name}__", "data:font/woff2;base64," + b64(f"fonts/{f.name}"))
link = src[src.index('<link rel="stylesheet" href="https://fonts.googleapis.com'):]
link = link[:link.index(">") + 1]
src = src.replace(link, f"<style>{fonts}</style>")

# three.js: bundled into the game module with esbuild (tools/node_modules; run `npm install` in tools/ once),
# so the build makes no external requests.
import re, subprocess
src = re.sub(r'<script type="importmap">.*?</script>\n', "", src, flags=re.S)
start = src.index('<script type="module">') + len('<script type="module">'); end = src.index("</script>", start)
tmp = root / "tools/src"; tmp.mkdir(exist_ok=True); (tmp / "game.js").write_text(src[start:end])
subprocess.run([str(root / "tools/node_modules/.bin/esbuild"), str(tmp / "game.js"), "--bundle", "--format=esm", "--minify-whitespace", "--minify-syntax",
                "--target=es2022", "--log-level=warning", f"--outfile={tmp / 'game.bundle.js'}"], check=True)
src = src[:start] + "\n" + (tmp / "game.bundle.js").read_text().replace("</script", "<\\/script") + src[end:]

def write(path, html):
    path.parent.mkdir(parents=True, exist_ok=True); path.write_text(html)
    print("wrote", path, f"{path.stat().st_size / 1e6:.1f} MB")
write(out / "index.html", src)   # dev build: dev kit and perf readout on
# Release builds, one per platform: a full document (the artifact host adds its own), dev tools off, the platform SDK loaded
# first in <head>, and a zip with index.html at its root for upload. No ads are called.
import zipfile
SDKS = {"crazygames": "https://sdk.crazygames.com/crazygames-sdk-v3.js", "poki": "https://game-cdn.poki.com/scripts/v2/poki-sdk.js"}
for plat, url in SDKS.items():
    write(out / plat / "index.html", f'<!doctype html>\n<html lang="en">\n<head>\n<script src="{url}"></script>\n'
          f'<script>window.__RELEASE = true; window.__PLATFORM = "{plat}";</script>\n' + src + "\n</html>\n")
    with zipfile.ZipFile(out / f"game-{plat}.zip", "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.write(out / plat / "index.html", "index.html")
    print("wrote", out / f"game-{plat}.zip", f"{(out / f'game-{plat}.zip').stat().st_size / 1e6:.1f} MB")
