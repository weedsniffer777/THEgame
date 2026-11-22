import * as THREE from 'three';
import { loadGltfJson } from './gltf.js';
import { splitAirframe, REGIONS } from './damage.js';

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
    speed: [140, 220], radius: [500, 1400], hitRadius: 7, toughness: 1,
  },
  // slow four-engine strategic bomber: big, tough, flies wide steady circles
  bomber: {
    url: 'models/jets/bomber.gltf.json',
    scale: 1,                            // the source model is real size (46 m long, 50 m span)
    turn: Math.PI / 2,                   // its nose points along -X: turn it to +Z
    cg: new THREE.Vector3(0, -2.5, 2),   // model space after the turn
    regions: REGIONS.bomber,
    allMeshes: true,                     // built from many meshes: cut all of them
    dropMeshes: ['Object_11', 'Object_12', 'Object_13', 'Object_14', 'Object_15', 'Object_16'],   // gear legs and wheels (modelled down)
    speed: [120, 150], radius: [3000, 4500], hitRadius: 24, toughness: 4,
  },
};

// Returns a prototype to clone per enemy: Group > scaled model (already split into parts).
export async function loadEnemy(type) {
  const T = ENEMIES[type];
  const gltf = await loadGltfJson(T.url);
  for (const n of T.dropMeshes || []) gltf.scene.getObjectByName(n)?.removeFromParent();
  let model = gltf.scene;
  if (T.turn) { model.rotation.y = T.turn; model = new THREE.Group().add(model); }   // damage regions want the nose on +Z
  model.updateMatrixWorld(true);
  splitAirframe(model, {}, T.regions, T.dropGear, T.allMeshes);
  model.userData.toughness = T.toughness;
  model.traverse(o => { if (o.isMesh && o.material.map) o.material.map.anisotropy = 4; });
  model.scale.setScalar(T.scale);
  model.position.copy(T.cg).multiplyScalar(-T.scale);
  const object = new THREE.Group().add(model);
  object.userData.type = type; object.userData.def = T;
  return object;
}
