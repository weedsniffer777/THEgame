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
for f in sorted((root / "models/guns").glob("*.glb")):
    src = src.replace(f"__GUN_{f.stem}_B64__", b64(f"models/guns/{f.name}"))
for f in sorted((root / "models/guns/icons").glob("*.png")):   # shop icons rendered from the full-quality models
    src = src.replace(f"__GUNICON_{f.stem}__", b64(f"models/guns/icons/{f.name}"))
(out / "index.html").write_text(src)
print("wrote", out / "index.html", f"{(out / 'index.html').stat().st_size / 1e6:.1f} MB")
