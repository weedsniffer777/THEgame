import * as THREE from 'three';

// Paint schemes: a scheme swaps some of a model's texture images for repainted ones, by file name, e.g.
//   { 'mig15_0.png': 'models/jets/paints/mig15_0.unmarked.png' }
// 'standard' is always the model's own textures. Schemes live with each aircraft type (enemy.js, jet.js).

// remember which image file each texture of a freshly loaded glTF came from
export function tagTextures(gltf) {
  const json = gltf.parser.json;
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
      const t = m[k]; if (!t || t.userData.src) continue;
      const a = gltf.parser.associations.get(t);
      const def = a && json.textures[a.textures];
      if (def) t.userData.src = json.images[def.source].uri;
    }
  });
}

const texCache = new Map();
export function loadTex(url, like) {
  if (!texCache.has(url)) texCache.set(url, new THREE.TextureLoader().loadAsync(url).then(t => {
    t.flipY = like.flipY; t.colorSpace = like.colorSpace; t.wrapS = like.wrapS; t.wrapT = like.wrapT;
    t.anisotropy = like.anisotropy; t.channel = like.channel; t.userData.src = url; return t;
  }));
  return texCache.get(url);
}

// a copy of 'proto' wearing the scheme: materials whose textures are swapped are cloned, the rest are shared
export async function painted(proto, scheme) {
  const copy = proto.clone(true);
  copy.userData = proto.userData;                         // (clone() would turn the type definition into JSON)
  if (!scheme || !Object.keys(scheme).length) return copy;
  const swapped = new Map();
  const jobs = [];
  copy.traverse(o => {
    if (!o.isMesh) return;
    const m = o.material;
    if (swapped.has(m)) { o.material = swapped.get(m); return; }
    const keys = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'].filter(k => m[k] && scheme[m[k].userData.src]);
    if (!keys.length) return;
    const nm = m.clone(); swapped.set(m, nm); o.material = nm;
    for (const k of keys) jobs.push(loadTex(scheme[m[k].userData.src], m[k]).then(t => { nm[k] = t; nm.needsUpdate = true; }));
  });
  await Promise.all(jobs);
  return copy;
}
