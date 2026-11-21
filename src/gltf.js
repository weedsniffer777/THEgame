import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Models ship as glTF JSON with the binary buffer inlined as base64 and textures as separate images
// (the forms the artifact host serves). Repack into a GLB in memory so loading never fetches a data: URL,
// which strict page policies block.
async function packGlb(url) {
  const json = await (await fetch(url)).json();
  const bin = Uint8Array.from(atob(json.buffers[0].uri.split(',')[1]), c => c.charCodeAt(0));
  delete json.buffers[0].uri;
  const text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (n) => (n + 3) & ~3;
  const jl = pad(text.length), bl = pad(bin.length);
  const out = new Uint8Array(12 + 8 + jl + 8 + bl);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jl); out.set(text, 20);
  dv.setUint32(20 + jl, bl, true); dv.setUint32(24 + jl, 0x004e4942, true);
  out.set(bin, 28 + jl);
  return out.buffer;
}

export async function loadGltfJson(url) {
  return new GLTFLoader().parseAsync(await packGlb(url), url.slice(0, url.lastIndexOf('/') + 1));
}
