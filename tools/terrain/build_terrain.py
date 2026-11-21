"""Turn the raw swisstopo tiles of an area into game terrain files.

    python3 tools/terrain/build_terrain.py engadin

Writes public/terrain/<area>/:
  height.bin   uint16 heights, row 0 = north edge, column 0 = west edge (little-endian)
  color.jpg    aerial photo of the same square
  terrain.json size, spacing and the height range the uint16 values map onto
Missing tiles (outside Switzerland) are filled from their nearest neighbours and blurred.
"""
import glob, json, os, sys
import numpy as np, tifffile
from PIL import Image
from scipy import ndimage

from fetch_swisstopo import AREAS

HEIGHT_SPACING = 20   # m per height sample
COLOR_SPACING = 10    # m per colour pixel
SRC = 2               # m per pixel in the 2 m source tiles

def mosaic(folder, ext, spacing, channels):
    e0, e1, n0, n1 = ext
    k = spacing // SRC          # source pixels per output pixel
    per_tile = 1000 // spacing
    w, h = (e1 - e0) * per_tile, (n1 - n0) * per_tile
    out = np.full((h, w, channels), np.nan, np.float32)
    for path in glob.glob(os.path.join(folder, '*.tif')):
        e, n = map(int, os.path.basename(path)[:-4].split('-'))
        a = tifffile.imread(path).astype(np.float32)
        if a.ndim == 2:
            a = a[..., None]
            a[a < -1000] = np.nan
        else:
            a[np.all(a[..., :3] == 0, axis=-1)] = np.nan   # black = no photo
        a = a[: (a.shape[0] // k) * k, : (a.shape[1] // k) * k]
        a = np.nanmean(a.reshape(a.shape[0] // k, k, a.shape[1] // k, k, channels), axis=(1, 3))
        r, c = (n1 - 1 - n) * per_tile, (e - e0) * per_tile
        out[r:r + per_tile, c:c + per_tile] = a
    return out

def fill(a, blur):
    """Fill NaNs with the nearest valid value, then soften the filled area."""
    hole = np.isnan(a[..., 0])
    if not hole.any():
        return a
    idx = ndimage.distance_transform_edt(hole, return_distances=False, return_indices=True)
    a = a[tuple(idx)]
    soft = np.stack([ndimage.gaussian_filter(a[..., c], blur) for c in range(a.shape[-1])], -1)
    mask = ndimage.gaussian_filter(hole.astype(np.float32), blur / 2)[..., None]
    return a * (1 - mask) + soft * mask

def main(area):
    ext = AREAS[area]
    raw = os.path.join('terrain-raw', area)
    out = os.path.join('public', 'terrain', area)
    os.makedirs(out, exist_ok=True)

    h = fill(mosaic(os.path.join(raw, 'swissalti3d'), ext, HEIGHT_SPACING, 1), 12)[..., 0]
    lo, hi = float(np.floor(h.min())), float(np.ceil(h.max()))
    q = np.round((h - lo) / (hi - lo) * 65535).astype('<u2')
    q.tofile(os.path.join(out, 'height.bin'))

    c = fill(mosaic(os.path.join(raw, 'swissimage-dop10'), ext, COLOR_SPACING, 3), 20)
    Image.fromarray(np.clip(c, 0, 255).astype(np.uint8)).save(os.path.join(out, 'color.jpg'), quality=88, optimize=True)

    meta = {
        'size': [q.shape[1], q.shape[0]], 'spacing': HEIGHT_SPACING,
        'colorSize': [c.shape[1], c.shape[0]],
        'heightMin': lo, 'heightMax': hi,
        'lv95': {'west': ext[0] * 1000, 'north': ext[3] * 1000},
        'credit': 'swissALTI3D, SWISSIMAGE (c) swisstopo',
    }
    json.dump(meta, open(os.path.join(out, 'terrain.json'), 'w'), indent=1)
    print(meta)

if __name__ == '__main__':
    sys.path.insert(0, os.path.dirname(__file__))
    main(sys.argv[1] if len(sys.argv) > 1 else 'engadin')
