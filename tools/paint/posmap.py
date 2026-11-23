"""Texel -> airframe map for a glTF model: rasterises every triangle of one material into its UV square and stores,
for each texel, the model-space position and normal of the surface it lands on (and how many different places share
it: mirrored parts often share UV islands). Used to paint schemes by where things are on the aircraft.

  python3 tools/paint/posmap.py public/models/jets/f5.gltf.json Northrop_F-5 1024 out.npz
"""
import base64, json, sys
import numpy as np

def load(path):
    j = json.load(open(path))
    bufs = []
    for b in j['buffers']:
        uri = b['uri']
        bufs.append(base64.b64decode(uri.split(',', 1)[1]) if uri.startswith('data:') else open(path.rsplit('/', 1)[0] + '/' + uri, 'rb').read())
    return j, bufs

def accessor(j, bufs, i):
    a = j['accessors'][i]; v = j['bufferViews'][a['bufferView']]
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
    dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8}[a['componentType']]
    off = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = v.get('byteStride', 0) or n * np.dtype(dt).itemsize
    raw = np.frombuffer(bufs[v['buffer']], dtype=np.uint8, count=stride * (a['count'] - 1) + n * np.dtype(dt).itemsize, offset=off)
    out = np.lib.stride_tricks.as_strided(raw.view(dt) if stride == n * np.dtype(dt).itemsize else np.frombuffer(raw.tobytes(), dtype=dt),
                                          shape=(a['count'], n), strides=(stride, np.dtype(dt).itemsize)) if stride != n * np.dtype(dt).itemsize else raw.view(dt).reshape(a['count'], n)
    return np.array(out)

def node_mats(j):
    mats = {}
    def trs(n):
        if 'matrix' in n: return np.array(n['matrix'], dtype=np.float64).reshape(4, 4).T
        t = np.array(n.get('translation', [0, 0, 0])); r = n.get('rotation', [0, 0, 0, 1]); s = np.array(n.get('scale', [1, 1, 1]))
        x, y, z, w = r
        R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        M = np.eye(4); M[:3, :3] = R * s; M[:3, 3] = t; return M
    def walk(i, parent):
        M = parent @ trs(j['nodes'][i]); mats[i] = M
        for c in j['nodes'][i].get('children', []): walk(c, M)
    for r in j['scenes'][j.get('scene', 0)]['nodes']: walk(r, np.eye(4))
    return mats

def build(path, matname, size):
    j, bufs = load(path)
    mi = [k for k, m in enumerate(j['materials']) if m.get('name') == matname][0]
    pos = np.zeros((size, size, 3), np.float32); nrm = np.zeros((size, size, 3), np.float32)
    cnt = np.zeros((size, size), np.int16); side = np.zeros((size, size), np.int8)   # side: sign of x of the last writer
    xsum = np.zeros((size, size), np.float32)
    mats = node_mats(j)
    for ni, n in enumerate(j['nodes']):
        if 'mesh' not in n: continue
        M = mats[ni]; Nm = np.linalg.inv(M[:3, :3]).T
        for p in j['meshes'][n['mesh']]['primitives']:
            if p['material'] != mi: continue
            P = accessor(j, bufs, p['attributes']['POSITION']).astype(np.float64)
            N = accessor(j, bufs, p['attributes']['NORMAL']).astype(np.float64)
            T = accessor(j, bufs, p['attributes']['TEXCOORD_0']).astype(np.float64)
            I = accessor(j, bufs, p['indices']).reshape(-1, 3) if 'indices' in p else np.arange(len(P)).reshape(-1, 3)
            P = P @ M[:3, :3].T + M[:3, 3]; N = N @ Nm.T; N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-9
            uv = T * size                                                   # glTF UV: (0,0) top-left of the image
            for tri in I:
                a, b, c = uv[tri]
                x0, x1 = int(max(0, np.floor(min(a[0], b[0], c[0])))), int(min(size - 1, np.ceil(max(a[0], b[0], c[0]))))
                y0, y1 = int(max(0, np.floor(min(a[1], b[1], c[1])))), int(min(size - 1, np.ceil(max(a[1], b[1], c[1]))))
                if x1 < x0 or y1 < y0: continue
                xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
                d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
                if abs(d) < 1e-12: continue
                w0 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / d
                w1 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / d
                w2 = 1 - w0 - w1
                inside = (w0 >= -0.02) & (w1 >= -0.02) & (w2 >= -0.02)      # (a hair of slack: no gaps on seams)
                if not inside.any(): continue
                W = np.stack([w0, w1, w2], -1)[inside]
                pp = W @ P[tri]; nn = W @ N[tri]
                yy, xx = (ys[inside] - 0.5).astype(int), (xs[inside] - 0.5).astype(int)
                pos[yy, xx] = pp; nrm[yy, xx] = nn
                cnt[yy, xx] += 1; xsum[yy, xx] += np.sign(pp[:, 0])
    return pos, nrm, cnt, xsum

if __name__ == '__main__':
    path, mat, size, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
    pos, nrm, cnt, xsum = build(path, mat, size)
    np.savez_compressed(out, pos=pos, nrm=nrm, cnt=cnt, xsum=xsum)
    cov = cnt > 0
    print('covered', cov.mean(), 'shared', (cnt > 1).mean(), 'bounds', pos[cov].min(0), pos[cov].max(0))
