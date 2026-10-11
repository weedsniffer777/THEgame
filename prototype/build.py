"""Build dist/index.html as a single file with every model inlined.

Rebake the shanty first if tools/shanty.js changed:  node tools/bake.mjs
"""
import base64, json, pathlib
root = pathlib.Path(__file__).parent
out = root / "dist"; out.mkdir(exist_ok=True)
b64 = lambda p: base64.b64encode((root / p).read_bytes()).decode()
src = (root / "game.src.html").read_text()
weapons = json.loads((root / "tools/weapons.json").read_text())
vm_map = {wid: b64(f"models/vm_{wid}.glb") for wid in weapons["weapons"] if (root / f"models/vm_{wid}.glb").exists()}
src = (src.replace("__WEAPONS_JSON__", json.dumps(weapons))
          .replace("__VM_MAP__", json.dumps(vm_map))
          .replace("__SHANTY_B64__", b64("models/shanty.glb")))
(out / "index.html").write_text(src)
print("wrote", out / "index.html", f"{(out / 'index.html').stat().st_size / 1e6:.1f} MB")
