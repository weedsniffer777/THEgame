import * as THREE from 'three';
import { loadGltfJson } from './gltf.js';
import { splitAirframe, REGIONS } from './damage.js';
import { tagTextures } from './paint.js';

// The Su-25 (second player jet; dev kit only for now). First, flyable version: the airframe as modelled (gear down,
// nothing moves yet), split into damage parts, no afterburner (it has none). Same interface as loadJet (jet.js).
// The source is built at about twice real size with its nose toward -Z: scaled and turned round here.
// Model space: +Z nose, +Y up, +X left wing (wheels on y = 0).
const CG = new THREE.Vector3(0, 1.9, -0.7);
const body = (x, y, z) => new THREE.Vector3(x, y, z).sub(CG);
REGIONS.su25 = { jag: 0.25, noseZ: 4.0, tail: { z: -4.7 }, stab: { x: 0.45, y: 1.7, z: -5.2, yMax: 3.0 }, fin: { y: 3.0, z: -4.6 },
  outer: { x: 3.6, y: 2.6, z0: -3.6, z1: 0.8 }, inner: { x: 1.65, y: 2.6, z0: -3.6, z1: 1.2 } };

export async function loadSu25(url, cfg) {
  const gltf = await loadGltfJson(url);
  tagTextures(gltf);
  const model = new THREE.Group();
  gltf.scene.rotation.y = Math.PI; gltf.scene.scale.setScalar(0.484);
  model.add(gltf.scene); model.updateMatrixWorld(true);
  model.traverse(o => {
    if (!o.isMesh) return;
    if (o.material.map) o.material.map.anisotropy = 4;
    if (o.material.name === 'Glass') { o.material = new THREE.MeshStandardMaterial({ color: 0x0a0c0e, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.28, envMapIntensity: 2.2, depthWrite: false }); o.userData.noSplit = true; }
  });
  splitAirframe(model, {}, REGIONS.su25);
  model.position.copy(CG).negate();
  const object = new THREE.Group().add(model);
  const nozzles = [new THREE.Vector3(0.8, 1.3, -4.5), new THREE.Vector3(-0.8, 1.3, -4.5)];
  return {
    object, model, setPaint: async () => {},
    cg: CG.clone(), nozzles,
    rails: [body(5.1, 1.45, -0.6), body(-5.1, 1.45, -0.6), body(4.37, 1.45, -0.6), body(-4.37, 1.45, -0.6)],   // the two outermost pylons a side
    muzzles: [body(0.35, 1.45, 4.3), body(0.25, 1.45, 4.3)],                     // the twin 30 mm, low on the left of the nose
    contacts: {
      wheels: [body(1.26, 0.05, -1.14), body(-1.26, 0.05, -1.14), body(0, 0.05, 2.3)],
      airframe: [[body(0, 1.8, 6.0), 'nose'], [body(0, 1.0, 0.5)], [body(0, 1.3, -4.0)], [body(0, 2.0, -8.0), 'tail'], [body(0, 2.9, 3.0), 'canopy'],
        [body(0, 4.6, -7.1), 'fin'], [body(7.0, 1.9, -2.0), 'wingOuterL'], [body(-7.0, 1.9, -2.0), 'wingOuterR'], [body(2.3, 2.3, -6.3), 'stabL'], [body(-2.3, 2.3, -6.3), 'stabR']],
      wreck: [[body(0, 1.8, 6.0), 'nose'], [body(0, 1.2, 3.5)], [body(0, 2.0, -8.0), 'tail'], [body(0, 1.3, -5.5), 'tail'], [body(0, 1.0, 0.5)], [body(0, 1.1, -2.5)], [body(0, 2.9, -2.0)],
        [body(0, 2.9, 3.0)], [body(0, 4.6, -7.1), 'fin'], [body(7.0, 1.9, -2.0), 'wingOuterL'], [body(-7.0, 1.9, -2.0), 'wingOuterR'],
        [body(2.6, 1.9, -1.5), 'wingInnerL'], [body(-2.6, 1.9, -1.5), 'wingInnerR'], [body(2.3, 2.3, -6.3), 'stabL'], [body(-2.3, 2.3, -6.3), 'stabR']],
    },
    animate() {},                                   // (moving parts: next)
  };
}
