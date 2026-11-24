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
      || (Math.abs(c.x) < 0.2 && c.z > 3.4 && c.z < 4.3 && c.y < 1.2 && Math.abs(n.y) < 0.35)
      || (Math.abs(c.x) > 3.25 && Math.abs(c.x) < 3.45 && c.z > -0.95 && c.z < -0.5 && c.y < 1.42),   // (a leftover scrap of the main-gear door)
    speed: [140, 220], radius: [500, 1400], hitRadius: 7, toughness: 0.8, crippled: 'fighter', label: 'Fighter',
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
    speed: [120, 150], radius: [3000, 4500], hitRadius: 24, toughness: 2.5, crippled: 'bomber', label: 'Bomber',
    paints: { standard: {}, unmarked: { 'bomber_0.png': 'models/jets/paints/bomber_0.unmarked.png' } },
    // on going down it may blow up (fuel and bombload): chance, blast radius (m), fireball size; any type can have this
    detonate: { chance: 0.35, radius: 90, size: 2.4 },   // (fireball ~3/4 of the airframe)
    // the bomb bay: doors made to fit the belly (model space after the turn: half-width, from z0 to z1)
    bombBay: { w: 0.85, z0: -5.5, z1: 2.5, open: 78 },
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

// A bomb bay cut into the belly: the source model has none, so the doors are built here, shaped to the belly by
// casting rays up at it (two curved panels, each hinged along its outer edge, swinging down and out), with the dark
// bay just inside them. The doors are named 'bayL' / 'bayR' (pivots): setBombBay(object, k) opens them (0 shut, 1 open).
const BAY_DOOR = new THREE.MeshStandardMaterial({ color: 0xaeb3b8, metalness: 0.35, roughness: 0.5 });
const BAY_DARK = new THREE.MeshStandardMaterial({ color: 0x0b0c0e, metalness: 0, roughness: 1, side: THREE.DoubleSide });
function buildBombBay(model, B) {
  model.updateMatrixWorld(true);
  const hull = []; model.traverse(o => { if (o.isMesh && !o.userData.noSplit) hull.push(o); });
  const ray = new THREE.Raycaster(), up = new THREE.Vector3(0, 1, 0), inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  let skinMat = null, lastUv = null;
  const skinY = (x, z) => { ray.set(new THREE.Vector3(x, -20, z).applyMatrix4(model.matrixWorld), up); const h = ray.intersectObjects(hull, false)[0]; if (h) { lastUv = h.uv || null; skinMat ||= [].concat(h.object.material)[0]; } return h ? h.point.applyMatrix4(inv).y : null; };
  const NX = 6, NZ = 12;
  // a curved strip under the belly from x0 to x1, z0 to z1, offset (m) below the skin
  const strip = (x0, x1, off) => {
    const pos = [], idx = [], uv = [];
    for (let j = 0; j <= NZ; j++) for (let i = 0; i <= NX; i++) {
      const x = x0 + (x1 - x0) * i / NX, z = B.z0 + (B.z1 - B.z0) * j / NZ, y = skinY(x, z) ?? skinY(0, z) ?? -3.8;
      pos.push(x, y - off, z); uv.push(lastUv ? lastUv.x : 0, lastUv ? lastUv.y : 0);   // (the skin's own texture there)
    }
    for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
      const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    return g;
  };
  const mark = (m) => { m.userData.noSplit = m.userData.noBulk = true; return m; };
  model.add(mark(new THREE.Mesh(strip(-B.w, B.w, 0.03), BAY_DARK)));                   // the bay (behind the doors)
  for (const [side, sgn] of [['L', 1], ['R', -1]]) {
    const hingeX = sgn * B.w, hy = skinY(hingeX, (B.z0 + B.z1) / 2) ?? -3.8;
    const pivot = new THREE.Object3D(); pivot.name = 'bay' + side; pivot.position.set(hingeX, hy - 0.06, 0);
    pivot.userData.bay = sgn * (B.open * Math.PI / 180);
    const door = mark(new THREE.Mesh(strip(sgn > 0 ? 0 : -B.w, sgn > 0 ? B.w : 0, 0.06), BAY_DOOR));
    door.material = (skinMat || BAY_DOOR).clone(); door.material.side = THREE.DoubleSide;   // (wearing the belly's skin)
    door.position.set(-hingeX, -(hy - 0.06), 0);
    pivot.add(door); model.add(pivot);
  }
}
export function setBombBay(object, k) {
  for (const n of ['bayL', 'bayR']) { const p = object.getObjectByName(n); if (p) p.rotation.z = p.userData.bay * k; }
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
  // propellers ride on the wing section their engine is on (the outer ones go with the outer wing)
  const props = []; model.traverse(o => { if (o.userData.prop) props.push(o); });
  model.updateMatrixWorld(true);
  for (const p of props) {
    const w = p.getWorldPosition(new THREE.Vector3()), side = w.x > 0 ? 'L' : 'R';
    const outer = T.regions?.outer && Math.abs(w.x) > T.regions.outer.x;
    (model.getObjectByName('part:wing' + (outer ? 'Outer' : 'Inner') + side) || model.getObjectByName('part:wingInner' + side))?.attach(p);
  }
  if (T.bombBay) buildBombBay(model, T.bombBay);
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
