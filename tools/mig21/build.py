"""MiG-21 for the game, from the Sketchfab model (NETRUNNER_pl, CC-BY 4.0), which holds three copies of the jet.

Kept: the first copy (gear down, wheels, gear covers, pylons, cockpit, seat) with the pilot, the wing missiles and the
afterburner glow taken from the third (they hang off an identical airframe node, so they keep their places). Its skin
is the grey one, with the national markings and numbers painted out (unmark.py). Everything else is dropped.
Writes the glTF JSON (binary inlined, as the game loads it) and the textures next to it.

  python3 tools/mig21/unmark.py <grey skin png> public/models/jets/mig21_0.png
  python3 tools/mig21/build.py <model.glb> public/models/jets/
"""
import base64, json, struct, sys

glb, outdir = sys.argv[1], sys.argv[2].rstrip('/') + '/'
b = open(glb, 'rb').read()
jl = struct.unpack('<I', b[12:16])[0]
J = json.loads(b[20:20 + jl])
BIN = b[20 + jl + 8:]
N = J['nodes']
name = lambda i: N[i].get('name', '')
find = lambda prefix: next(i for i, n in enumerate(N) if n.get('name', '').startswith(prefix))

ROOT, AIRFRAME = find('MIG-21 master 1_'), find('MIG-21_9')
BORROW = [find('AIM-9 Sidewinder.002'), find('glow.002'), find('pilot.002')]   # from the third copy

keep = []
def collect(i):
    keep.append(i)
    for c in N[i].get('children', []): collect(c)
chain = [find('Sketchfab_model'), find('root'), find('GLTF_SceneRootNode')]
collect(ROOT)
for i in BORROW: collect(i)

# new node list: the chain, then the kept subtrees; the borrowed parts hang off the kept airframe
order = chain + keep
idx = {old: new for new, old in enumerate(order)}
nodes = []
for old in order:
    n = dict(N[old])
    kids = [c for c in n.get('children', []) if c in idx]
    if old == chain[-1]: kids = [ROOT]
    if old == AIRFRAME: kids = kids + BORROW
    if kids: n['children'] = [idx[c] for c in kids]
    else: n.pop('children', None)
    if old == ROOT: n['matrix'] = n['matrix'][:12] + [0, 0, 0, 1]   # (copy 1 stood off to one side of the scene)
    n['name'] = name(old).rsplit('_', 1)[0] if name(old).startswith(('MIG', 'fishbed', 'seat', 'AIM', 'glow', 'pilot')) else name(old)
    nodes.append(n)

# meshes -> accessors -> buffer views, materials -> textures -> images: only what's used, renumbered
meshes, acc, views, mats, texs, imgs = [], [], [], [], [], []
mm, am, vm, matm, tm, im = {}, {}, {}, {}, {}, {}
blob = bytearray()
def view(v):
    if v not in vm:
        bv = dict(J['bufferViews'][v]); data = BIN[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
        while len(blob) % 4: blob.append(0)
        bv['byteOffset'] = len(blob); bv['buffer'] = 0; blob.extend(data)
        vm[v] = len(views); views.append(bv)
    return vm[v]
def accessor(a):
    if a not in am:
        d = dict(J['accessors'][a]); d['bufferView'] = view(d['bufferView']); am[a] = len(acc); acc.append(d)
    return am[a]
IMG_OUT = {}   # source image index -> file name
def image(i):
    if i not in im:
        im[i] = len(imgs)
        fname = f'mig21_{len(imgs)}.png'
        imgs.append({'uri': fname, 'mimeType': 'image/png'}); IMG_OUT[i] = fname
    return im[i]
def texture(t):
    if t not in tm:
        d = dict(J['textures'][t]); d['source'] = image(d['source']); d.pop('sampler', None); tm[t] = len(texs); texs.append(d)
    return tm[t]
SKIN_SRC = J['textures'][J['materials'][next(i for i, m in enumerate(J['materials']) if m['name'] == 'mig21_3')]['pbrMetallicRoughness']['baseColorTexture']['index']]['source']
def material(m):
    if m not in matm:
        d = json.loads(json.dumps(J['materials'][m]))
        pbr = d.get('pbrMetallicRoughness', {})
        if d['name'] == 'mig21_1':                                     # copy 1's airframe: wear the grey skin instead
            pbr['baseColorTexture'] = {'index': next(i for i, t in enumerate(J['textures']) if t['source'] == SKIN_SRC)}
        for k in ('baseColorTexture', 'metallicRoughnessTexture'):
            if k in pbr: pbr[k]['index'] = texture(pbr[k]['index'])
        for k in ('normalTexture', 'emissiveTexture', 'occlusionTexture'):
            if k in d: d[k]['index'] = texture(d[k]['index'])
        matm[m] = len(mats); mats.append(d)
    return matm[m]
for n in nodes:
    if 'mesh' not in n: continue
    m = n['mesh']
    if m not in mm:
        d = json.loads(json.dumps(J['meshes'][m]))
        for p in d['primitives']:
            p['attributes'] = {k: accessor(v) for k, v in p['attributes'].items()}
            if 'indices' in p: p['indices'] = accessor(p['indices'])
            if 'material' in p: p['material'] = material(p['material'])
        mm[m] = len(meshes); meshes.append(d)
    n['mesh'] = mm[m]

out = {'asset': J['asset'], 'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': nodes, 'meshes': meshes, 'accessors': acc,
       'bufferViews': views, 'materials': mats, 'textures': texs, 'images': imgs,
       'samplers': [], 'buffers': [{'byteLength': len(blob), 'uri': 'data:application/octet-stream;base64,' + base64.b64encode(bytes(blob)).decode()}]}
if not out['samplers']: del out['samplers']
json.dump(out, open(outdir + 'mig21.gltf.json', 'w'), separators=(',', ':'))
# the images (the skin's own file is written by unmark.py: skip it here)
binoff = 0
for src, fname in IMG_OUT.items():
    if src == SKIN_SRC: print('skin ->', fname, '(from unmark.py)'); continue
    bv = J['bufferViews'][J['images'][src]['bufferView']]
    open(outdir + fname, 'wb').write(BIN[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']])
    print('wrote', fname)
print('nodes', len(nodes), 'meshes', len(meshes), 'materials', len(mats), 'bin', len(blob))
