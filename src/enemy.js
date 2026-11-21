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
  },
};

// Returns a prototype to clone per enemy: Group > scaled model (already split into parts).
export async function loadEnemy(type) {
  const T = ENEMIES[type];
  const gltf = await loadGltfJson(T.url);
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  splitAirframe(model, {}, T.regions, T.dropGear);
  model.traverse(o => { if (o.isMesh && o.material.map) o.material.map.anisotropy = 4; });
  model.scale.setScalar(T.scale);
  model.position.copy(T.cg).multiplyScalar(-T.scale);
  const object = new THREE.Group().add(model);
  object.userData.type = type;
  return object;
}
