"""Inline models into game.src.html -> dist/index.html (single-file artifact)."""
import base64, pathlib
root = pathlib.Path(__file__).parent
src = (root / "game.src.html").read_text()
b64 = base64.b64encode((root / "models/stickman.glb").read_bytes()).decode()
out = root / "dist"; out.mkdir(exist_ok=True)
(out / "index.html").write_text(src.replace("__STICKMAN_B64__", b64))
print("wrote", out / "index.html")
