"""Build dist/: inline the small models into the page, copy the baked shanty next to it.

Rebake the shanty first if tools/shanty.js changed:  node tools/bake.mjs
"""
import base64, pathlib, shutil
root = pathlib.Path(__file__).parent
out = root / "dist"; (out / "models").mkdir(parents=True, exist_ok=True)
b64 = lambda p: base64.b64encode((root / p).read_bytes()).decode()
src = (root / "game.src.html").read_text()
src = src.replace("__STICKMAN_B64__", b64("models/stickman.glb")).replace("__M1911_B64__", b64("models/m1911_lod.glb"))
(out / "index.html").write_text(src)
shutil.copy(root / "models/shanty.glb", out / "models/shanty.glb")
print("wrote", out / "index.html", "and", out / "models/shanty.glb")
