"""F-5 paint schemes, painted onto the model's own texture atlas by where each texel sits on the airframe.

The camo skin is found by colour (the blue-grey camo; bays, wheels, cockpit, metal and markings are neutral or other
colours and are left alone). Each scheme repaints the skin; the panel lines and small detail of the original are
kept by lifting them out of the old camo (luminance against a median that keeps the camo edges but drops thin lines).
Gloss comes from the metallic/roughness texture (G = roughness, B = metalness).
Numbers and lettering are NOT painted here: most of the atlas is shared by both sides of the jet (mirrored), so text
would read backwards on one side. They are decals placed at run time (jet.js).

  python3 tools/paint/posmap.py public/models/jets/f5.gltf.json Northrop_F-5 1024 /tmp/f5map.npz
  python3 tools/paint/f5_paints.py /tmp/f5map.npz
"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

SRC = 'public/models/jets/'
OUT = 'public/models/jets/paints/'

def load(name): return np.asarray(Image.open(SRC + name).convert('RGB')).astype(np.float32)

def skin_mask(col, cov):
    med = np.stack([ndi.median_filter(col[..., k], size=7) for k in range(3)], -1)
    r, g, b = med[..., 0], med[..., 1], med[..., 2]
    lum = med.mean(-1)
    bluish = lambda c: (c[..., 2] - c[..., 0] >= 10) & (c.mean(-1) > 45) & (c.mean(-1) < 205) & (np.abs(c[..., 1] - c[..., 2]) < 60)
    camo = cov & (bluish(med) | bluish(col))
    camo = ndi.binary_closing(camo, iterations=3) & cov            # (panel lines inside the skin belong to it)
    camo = ndi.binary_opening(camo, iterations=1)
    # grow out to the panel edges and into the gutters between UV islands (so no old camo shows along seams), but not
    # into anything that isn't blue-grey skin
    loose = (col[..., 2] - col[..., 0] >= 3) | ~cov
    for _ in range(6): camo = camo | (ndi.binary_dilation(camo) & loose)
    return camo, med

def detail(col, med):
    lum = col.mean(-1) + 1; base = med.mean(-1) + 1
    return np.clip(lum / base, 0.45, 1.25)[..., None]               # panel lines, rivets, stains, as a multiplier

def smooth(x, e0, e1): t = np.clip((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)

def regions(pos, nrm):
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    ax = np.abs(x)
    r = {}
    r['radome'] = z > 7.55
    r['antiglare'] = (z > 4.25) & (z <= 7.55) & (nrm[..., 1] > 0.62) & (ax < 0.45)
    r['aft'] = (z < -5.35) & (ax < 0.8) & (y < 2.2) & ~((ax < 0.12) & (y > 1.9))   # tail cone round the nozzles only (not the fin, rudder or tailplanes): bare metal
    fuselage = (ax < 1.05) & (z > -5.35) & (z < 7.55) & (y > 0.9)
    fin = (ax < 0.3) & (y > 2.62) & (z < -2.6)
    r['fin'] = fin
    # stripe along the fuselage shoulder (where the side turns into the top), both sides, nose to tail
    # stripe: a band of even width along a smooth line just under the canopy rail, nose to fin root, then up the fin
    # parallel to its leading edge; soft-edged (a coverage fraction, not a hard mask)
    line = np.interp(-z, -np.array([7.5, 6.7, 4.4, 2.6, 0.5, -1.8, -2.7, -3.15]), [1.64, 1.8, 2.05, 2.24, 2.3, 2.22, 2.3, 2.47])
    W, soft = 0.032, 0.01
    band = smooth(W - np.abs(y - line), -soft, soft)
    side = (np.abs(nrm[..., 0]) > 0.3) & (ax < 0.8) & (z < 7.5) & (z > -3.2) & ~fin
    zle = -3.89 - (y - 3.3) * 0.98                                   # the fin's leading edge (z at height y)
    back = zle - z                                                   # metres behind the leading edge
    # across the fin: from the root just behind the leading edge, up and back toward the top of the trailing edge
    a0 = np.array([2.5, -3.2]); dv = np.array([1.45, -2.6]); dv = dv / np.linalg.norm(dv)
    across = np.abs((y - a0[0]) * dv[1] - (z - a0[1]) * dv[0])          # distance from that line in the fin's plane
    finroot = (ax < 0.35) & (y > 2.3) & (z < -2.9) & (z > -6.2)       # the fin, down into its root fillet
    finband = finroot * smooth(0.11 - across, -soft, soft)
    # the join: from the end of the fuselage line, up into the fin band
    r['stripe'] = np.maximum(band * side, finband)
    return r

def scheme_proto(col, mr, skin, det, R):
    """Prototype rollout: glossy light grey, navy stripe along the shoulder and up the fin, black radome and anti-glare,
    bare metal round the nozzles."""
    c = col.copy(); m = mr.copy()
    base = np.array([166, 169, 172], np.float32)                    # mid grey lacquer, a little metallic
    navy = np.array([28, 38, 78], np.float32)
    black = np.array([20, 21, 24], np.float32)
    metal = np.array([150, 154, 158], np.float32)
    paint = np.broadcast_to(base, c.shape).copy()
    k = R['stripe'][..., None]; paint = paint * (1 - k) + navy * k
    paint[R['antiglare']] = black
    paint[R['radome']] = black
    paint[R['aft']] = metal
    # a faint panel-to-panel tone variation (low-frequency), so the skin doesn't read as flat plastic
    rng = np.random.default_rng(7)
    var = ndi.gaussian_filter(rng.standard_normal(c.shape[:2]), 18); var = 1 + 0.045 * var / (np.abs(var).max() + 1e-6)
    c[skin] = (paint * det * var[..., None])[skin]
    # gloss: a polished, slightly metallic lacquer (the stripe and black areas plain gloss paint); bare metal aft
    m[..., 1][skin] = 62; m[..., 2][skin] = 110
    flat = skin & ((R['stripe'] > 0.5) | R['antiglare'] | R['radome']); m[..., 1][flat] = 55; m[..., 2][flat] = 0
    a = skin & R['aft']; m[..., 1][a] = 85; m[..., 2][a] = 210
    return c, m

def scheme_aggressor(col, mr, skin, det, R):
    """Aggressor: glossy black all over, bare metal round the nozzles (the red numbers are decals)."""
    c = col.copy(); m = mr.copy()
    black = np.array([22, 24, 29], np.float32)
    metal = np.array([140, 144, 148], np.float32)
    paint = np.broadcast_to(black, c.shape).copy()
    paint[R['aft']] = metal
    d = 1 + (det - 1) * 2.2                                          # (detail reads weaker on black: a bit more of it)
    c[skin] = np.clip(paint * d, 0, 255)[skin]
    m[..., 1][skin] = 52; m[..., 2][skin] = 0
    a = skin & R['aft']; m[..., 1][a] = 85; m[..., 2][a] = 210
    return c, m

if __name__ == '__main__':
    d = np.load(sys.argv[1]); pos, nrm, cnt = d['pos'], d['nrm'], d['cnt']
    cov = cnt > 0
    # texels in the gutters take the position of the nearest covered texel
    idx = ndi.distance_transform_edt(~cov, return_distances=False, return_indices=True)
    pos = pos[idx[0], idx[1]]; nrm = nrm[idx[0], idx[1]]
    col = load('f5_0.png'); mr = load('f5_1.png')
    skin, med = skin_mask(col, cov)
    # the rudder (the back of the fin) is plain grey in the source, not camo: it's skin too
    sat = med.max(-1) - med.min(-1); lum = med.mean(-1)
    rudder = cov & (np.abs(pos[..., 0]) < 0.09) & (pos[..., 1] > 2.05) & (pos[..., 2] < -5.2) & (pos[..., 2] > -6.1)
    skin = skin | ndi.binary_closing(rudder, iterations=2)
    det = detail(col, med)
    R = regions(pos, nrm)
    Image.fromarray((skin * 255).astype(np.uint8)).save('/tmp/f5_skin.png')
    for name, fn in (('proto', scheme_proto), ('aggressor', scheme_aggressor)):
        c, m = fn(col, mr, skin, det, R)
        Image.fromarray(np.clip(c, 0, 255).astype(np.uint8)).save(f'{OUT}f5_0.{name}.png', optimize=True)
        Image.fromarray(np.clip(m, 0, 255).astype(np.uint8)).save(f'{OUT}f5_1.{name}.png', optimize=True)
        print('wrote', name)
