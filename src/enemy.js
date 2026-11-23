import * as THREE from 'three';
import { loadGltfJson } from './gltf.js';
import { splitAirframe, REGIONS } from './damage.js';
import { tagTextures, painted } from './paint.js';

// Enemy aircraft types. Each model is cut into breakable parts by its own region table (damage.js).
export const ENEMIES = {
  // early swept-wing jet fighter: the first, easy enemy
  earlyJet: {
    url: 'models/jets/mig15.gltf.json',
    scale: 0.646,                       // the source model is ~1.55x real size (15.6 m long vs 10.1 m)
    cg: new THREE.Vector3(0, 1.9, -2.2),  // model space, before scaling
    regions: REGIONS.earlyJet,
    // the model has its gear down: leave out the main legs, wheels and doors under the wings, and the nose leg
    // (doors are told apart from the skin by being upright panels)
    dropGear: (c, n) => c.y < 0.72
      || (Math.abs(c.x) > 2.4 && Math.abs(c.x) < 3.6 && c.z > -2.1 && c.z < -0.6 && c.y < 1.0)
      || (Math.abs(c.x) > 2.6 && Math.abs(c.x) < 3.4 && c.z > -1.95 && c.z < -0.45 && c.y < 1.3 && Math.abs(n.y) < 0.35)
      || (Math.abs(c.x) < 0.5 && c.z > 2.0 && c.z < 4.0 && c.y < 0.84)
      || (Math.abs(c.x) < 0.2 && c.z > 3.4 && c.z < 4.3 && c.y < 1.2 && Math.abs(n.y) < 0.35),
    speed: [140, 220], radius: [500, 1400], hitRadius: 7, toughness: 1, crippled: 'fighter', label: 'Fighter',
    paints: { standard: {}, unmarked: { 'mig15_0.png': 'models/jets/paints/mig15_0.unmarked.png' } },
  },
  // slow four-engine strategic bomber: big, tough, flies wide steady circles
  bomber: {
    url: 'models/jets/bomber.gltf.json',
    scale: 1,                            // the source model is real size (46 m long, 50 m span)
    turn: Math.PI / 2,                   // its nose points along -X: turn it to +Z
    cg: new THREE.Vector3(0, -2.5, 2),   // model space after the turn
    regions: REGIONS.bomber,
    allMeshes: true,                     // built from many meshes: cut all of them
    dropMeshes: ['Object_11', 'Object_12', 'Object_13', 'Object_14', 'Object_15', 'Object_16'],   // main gear wheels and legs (modelled down)
    meta: 'models/jets/bomber.meta.json',   // leftover gear triangles to drop, and the propeller discs (made by an offline pass over the model)
    speed: [120, 150], radius: [3000, 4500], hitRadius: 24, toughness: 4, crippled: 'bomber', label: 'Bomber',
    paints: { standard: {}, unmarked: { 'bomber_0.png': 'models/jets/paints/bomber_0.unmarked.png' } },
    // on going down it may blow up (fuel and bombload): chance, blast radius (m), fireball size; any type can have this
    detonate: { chance: 0.35, radius: 90, size: 2.4 },   // (fireball ~3/4 of the airframe)
  },
};

// Leftover gear triangles are removed; each propeller disc's blades become their own mesh on a spinning pivot
// (pivot.userData.prop = spin direction: front and rear discs turn opposite ways).
function applyMeta(root, meta) {
  root.updateMatrixWorld(true);
  const byName = (n) => { let m = null; root.traverse(o => { if (!m && o.name === n && o.isMesh) m = o; else if (!m && o.name === n) o.traverse(c => { if (!m && c.isMesh) m = c; }); }); return m; };
  const take = new Map();   // mesh -> set of triangle numbers removed from it
  const remove = (mesh, tris) => { const s = take.get(mesh) || new Set(); tris.forEach(t => s.add(t)); take.set(mesh, s); };
  for (const [name, tris] of Object.entries(meta.drop)) { const m = byName(name); if (m) remove(m, tris); }
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  meta.discs.forEach((disc, k) => {
    const pivot = new THREE.Object3D();
    pivot.position.set(...disc.centre).applyMatrix4(inv);
    pivot.userData.prop = disc.centre[0] < -11.5 || (disc.centre[0] > -9 && disc.centre[0] < -8.2) ? 1 : -1;
    pivot.name = 'prop' + k;
    root.add(pivot); pivot.updateMatrixWorld(true);
    for (const [name, tris] of Object.entries(disc.tris)) {
      const src = byName(name); if (!src) continue;
      const idx = src.geometry.index.array, list = [];
      for (const t of tris) list.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
      const geo = new THREE.BufferGeometry();
      for (const [a, v] of Object.entries(src.geometry.attributes)) geo.setAttribute(a, v);
      geo.setIndex(list);
      const blades = new THREE.Mesh(geo, src.material);
      blades.userData.noSplit = true;
      blades.matrixAutoUpdate = false;
      blades.matrix.copy(pivot.matrixWorld).invert().multiply(src.matrixWorld);
      pivot.add(blades);
      remove(src, tris);
    }
  });
  for (const [mesh, s] of take) {
    const idx = mesh.geometry.index.array, keep = [];
    for (let t = 0; t < idx.length / 3; t++) if (!s.has(t)) keep.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
    mesh.geometry = mesh.geometry.clone(); mesh.geometry.setIndex(keep);
  }
}

// Returns a prototype to clone per enemy: Group > scaled model (already split into parts).
export async function loadEnemy(type) {
  const T = ENEMIES[type];
  const gltf = await loadGltfJson(T.url);
  tagTextures(gltf);
  for (const n of T.dropMeshes || []) gltf.scene.getObjectByName(n)?.removeFromParent();
  if (T.meta) applyMeta(gltf.scene, await (await fetch(T.meta)).json());
  let model = gltf.scene;
  if (T.turn) { model.rotation.y = T.turn; model = new THREE.Group().add(model); }   // damage regions want the nose on +Z
  model.updateMatrixWorld(true);
  splitAirframe(model, {}, T.regions, T.dropGear, T.allMeshes);
  // propellers ride on the inner wing sections (they come off with them)
  const props = []; model.traverse(o => { if (o.userData.prop) props.push(o); });
  model.updateMatrixWorld(true);
  for (const p of props) {
    const w = p.getWorldPosition(new THREE.Vector3());
    model.getObjectByName('part:wingInner' + (w.x > 0 ? 'L' : 'R'))?.attach(p);
  }
  model.userData.toughness = T.toughness;
  model.traverse(o => { if (o.isMesh && o.material.map) o.material.map.anisotropy = 4; });
  model.scale.setScalar(T.scale);
  model.position.copy(T.cg).multiplyScalar(-T.scale);
  const object = new THREE.Group().add(model);
  object.userData.type = type; object.userData.def = T;
  return object;
}

// the same type in another paint scheme (see paint.js); unknown schemes fall back to the standard paint
export function paintEnemy(proto, scheme = 'standard') {
  const T = proto.userData.def;
  return painted(proto, T.paints?.[scheme]);
}
