"""Build dist/index.html as a single file with every model inlined.

Regenerate inputs when their sources change:
  node tools/bake.mjs     -> models/shanty.glb
  node tools/player.mjs   -> models/player.glb
"""
import base64, pathlib
root = pathlib.Path(__file__).parent
out = root / "dist"; out.mkdir(exist_ok=True)
b64 = lambda p: base64.b64encode((root / p).read_bytes()).decode()
src = (root / "game.src.html").read_text()
src = (src.replace("__PLAYER_B64__", b64("models/player.glb"))
          .replace("__M1911_B64__", b64("models/m1911.glb"))
          .replace("__SHANTY_B64__", b64("models/shanty.glb")))
(out / "index.html").write_text(src)
print("wrote", out / "index.html", f"{(out / 'index.html').stat().st_size / 1e6:.1f} MB")
