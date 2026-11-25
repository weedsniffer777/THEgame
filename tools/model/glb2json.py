"""A GLB into the game's model form: glTF JSON with the binary inlined (base64) and the images as files beside it.

  python3 tools/model/glb2json.py <model.glb> <out dir> <name>     -> <name>.gltf.json, <name>_0.png ...
"""
import base64, json, struct, sys
glb, outdir, name = sys.argv[1], sys.argv[2].rstrip('/') + '/', sys.argv[3]
b = open(glb, 'rb').read()
jl = struct.unpack('<I', b[12:16])[0]
J = json.loads(b[20:20 + jl]); BIN = b[20 + jl + 8:]
for i, im in enumerate(J.get('images', [])):
    bv = J['bufferViews'][im.pop('bufferView')]
    ext = 'jpg' if im.get('mimeType') == 'image/jpeg' else 'png'
    fname = f'{name}_{i}.{ext}'
    open(outdir + fname, 'wb').write(BIN[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']])
    im['uri'] = fname
J['buffers'] = [{'byteLength': len(BIN), 'uri': 'data:application/octet-stream;base64,' + base64.b64encode(BIN).decode()}]
json.dump(J, open(outdir + name + '.gltf.json', 'w'), separators=(',', ':'))
print('wrote', name, len(J.get('images', [])), 'images')
