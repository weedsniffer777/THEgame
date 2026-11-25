"""MiG-21 grey skin without national markings: roundels, trident shields and the tactical numbers (the green fin
flashes stay: not a national marking)
are found by colour (numbers: dark text inside known boxes), filled with a smooth blend of the paint around them, and
then given back their panel lines and rivets: the model's two other skins (Polish camo, desert) share the same UV
layout and the same detail, with their markings elsewhere, so under each marking the detail is taken from whichever
of them is clean there (as a brightness ratio against its local average, so its colours don't come with it).

  python3 tools/mig21/unmark.py <model.glb> public/models/jets/mig21_0.png
"""
import io, json, struct, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

glb, out = sys.argv[1], sys.argv[2]
b = open(glb, 'rb').read()
jl = struct.unpack('<I', b[12:16])[0]
J = json.loads(b[20:20 + jl]); BIN = b[20 + jl + 8:]
def skin(mat_name):
    m = next(m for m in J['materials'] if m['name'] == mat_name)
    src = J['textures'][m['pbrMetallicRoughness']['baseColorTexture']['index']]['source']
    bv = J['bufferViews'][J['images'][src]['bufferView']]
    raw = BIN[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
    return np.asarray(Image.open(io.BytesIO(raw)).convert('RGB')).astype(np.float32)
im = skin('mig21_3')                                         # the grey one
donors = [skin('mig21_1'), skin('mig21_2')]                  # Polish camo, desert: same layout, markings elsewhere
H, W = im.shape[:2]
r, g, b = im[..., 0], im[..., 1], im[..., 2]
lum = im.mean(-1)
# outside the UV islands: the big pure-black areas (the numbers are pure black too, but small)
def background(L):
    dark = L < 14
    lab, n = ndi.label(dark)
    sizes = ndi.sum(dark, lab, range(1, n + 1))
    return np.isin(lab, 1 + np.nonzero(sizes > 1500)[0])
bg = background(lum)
blue = (b - r > 50) & (r < 70)                   # roundel discs, shields (and their dark navy edges); not the bluish camo
yellow = ((r + g) / 2 - b > 55) & (r > 70)       # roundel rings, tridents
mark = blue | yellow
# the tactical numbers: dark text in these boxes (x0, y0, x1, y1 at 1024 px)
s = W / 1024
for x0, y0, x1, y1 in [(50, 160, 80, 210), (165, 635, 195, 690), (575, 65, 615, 160), (690, 165, 725, 260)]:
    box = np.zeros_like(mark); box[int(y0 * s):int(y1 * s), int(x0 * s):int(x1 * s)] = True
    mark |= box & (lum < 80) & ~bg
mark = ndi.binary_dilation(mark, iterations=3) & ~bg

# 1. each marking is filled with a smooth blend of the paint around it: start from the median of a thin ring outside
# it, then relax (every filled pixel becomes the average of its neighbours, the surroundings held fixed), which
# carries the neighbouring camo tones smoothly across
out_im = im.copy()
lab, n = ndi.label(mark)
for k in range(1, n + 1):
    comp = lab == k
    ring = ndi.binary_dilation(comp, iterations=6) & ~ndi.binary_dilation(comp, iterations=1) & ~bg & ~mark
    if ring.sum() >= 5: out_im[comp] = np.median(im[ring], axis=0)
src = np.stack([ndi.median_filter(out_im[..., c], size=5) for c in range(3)], -1)   # (the surroundings without fine lines)
out_im[~mark] = src[~mark]
known = (~bg).astype(np.float32)
kern = np.array([[0, 1, 0], [1, 0, 1], [0, 1, 0]], np.float32)
wsum = ndi.convolve(known, kern, mode='constant')
for _ in range(600):
    avg = np.stack([ndi.convolve(out_im[..., c] * known, kern, mode='constant') for c in range(3)], -1) / np.maximum(wsum, 1)[..., None]
    out_im[mark] = avg[mark]
out_im[~mark] = im[~mark]                                                         # (the rest exactly as it was)

# 2. the panel lines and rivets back, from a donor skin that is clean at that spot
detail = np.ones((H, W), np.float32); have = np.zeros((H, W), bool)
for d in donors:
    L = d.mean(-1); dr, dg, db = d[..., 0], d[..., 1], d[..., 2]
    base = ndi.median_filter(L, size=9)
    # where this donor can't be used: its own markings (red / white checkers, red triangles, black numbers), its camo
    # edges (the ratio would draw them as lines), and outside the islands
    ink = L < 60
    lab_d, n_d = ndi.label(ink); sz = ndi.sum(ink, lab_d, range(1, n_d + 1))
    numbers = np.isin(lab_d, 1 + np.nonzero((sz > 4) & (sz < 3000))[0])
    bad = (dr - dg > 90) | (L > 200) | numbers | background(L)
    edges = ndi.gaussian_gradient_magnitude(base, 1.5) > 6
    bad = ndi.binary_dilation(bad | edges, iterations=3)
    ratio = np.clip(L / np.maximum(base, 1), 0.5, 1.06)   # (panel lines and rivets are darker than the paint: only take those)
    use = mark & ~bad & ~have
    detail[use] = ratio[use]; have |= use
out_im[mark] *= detail[mark][:, None]
# 3. a little grain where no donor could give detail, so those patches aren't glassy-flat
rng = np.random.default_rng(3)
flat = mark & ~have
out_im[flat] += rng.normal(0, 2.0, (flat.sum(), 1))
print(f'marked {mark.sum()} px, detail restored on {have.sum()} ({100 * have.sum() / max(1, mark.sum()):.0f}%)')
Image.fromarray(np.clip(out_im, 0, 255).astype(np.uint8)).save(out, optimize=True)
print('wrote', out)
