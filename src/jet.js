import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// The F-5 model with moving control surfaces, gear hidden and afterburner flames.
// Model space: +Z nose, +Y up, +X left wing (same as the flight model's body frame).
const GEAR = ['Object023', 'Object052', 'Object024', 'Object032', 'Object033', 'Object049', 'Object050', 'Object051', 'Object030', 'Object048', 'Object035'];
const CG = new THREE.Vector3(0, 1.9, -0.6);
const NOZZLES = [new THREE.Vector3(0.33, 1.72, -6.62), new THREE.Vector3(-0.33, 1.72, -6.62)];
const DEG = Math.PI / 180;

function hinge(model, name, edge) {
  const node = model.getObjectByName(name);
  const box = new THREE.Box3().setFromObject(node);
  const p = box.getCenter(new THREE.Vector3());
  if (edge === 'front') p.z = box.max.z;
  if (edge === 'back') p.z = box.min.z;
  const pivot = new THREE.Object3D();
  pivot.position.copy(p);
  model.add(pivot);
  model.updateMatrixWorld(true);
  pivot.attach(node);
  return pivot;
}

function flame() {
  const geo = new THREE.ConeGeometry(0.3, 1, 16, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.5);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPower: { value: 0 } },
    vertexShader: `varying float vT; void main(){ vT = -position.z; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform float uPower; varying float vT;
      void main(){ vec3 c = mix(vec3(1.0,0.75,0.45), vec3(0.35,0.45,1.0), smoothstep(0.0,0.6,vT));
        gl_FragColor = vec4(c * uPower * (1.0 - vT) * 3.0, 1.0); }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geo, mat);
}

// The model ships as glTF JSON with its buffer inlined as base64 (the only form the artifact host serves).
// Repack it into a GLB in memory so loading never fetches a data: URL, which strict page policies block.
async function packGlb(url) {
  const json = await (await fetch(url)).json();
  const bin = Uint8Array.from(atob(json.buffers[0].uri.split(',')[1]), c => c.charCodeAt(0));
  delete json.buffers[0].uri;
  let text = new TextEncoder().encode(JSON.stringify(json));
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

export async function loadJet(url) {
  const gltf = await new GLTFLoader().parseAsync(await packGlb(url), url.slice(0, url.lastIndexOf('/') + 1));
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  for (const n of GEAR) { const o = model.getObjectByName(n); if (o) o.visible = false; }
  const s = {
    aileronL: hinge(model, 'Object027', 'front'), aileronR: hinge(model, 'Object056', 'front'),
    stabL: hinge(model, 'Object053', 'center'), stabR: hinge(model, 'Object054', 'center'),
    rudder: hinge(model, 'Object026', 'front'),
    leL: hinge(model, 'Object057', 'back'), leR: hinge(model, 'Object055', 'back'),
  };
  model.traverse(o => { if (o.isMesh) { o.castShadow = false; if (o.material.map) o.material.map.anisotropy = 4; } });

  const flames = NOZZLES.map(p => { const f = flame(); f.position.copy(p); model.add(f); return f; });
  model.position.copy(CG).negate();
  const object = new THREE.Group().add(model);

  return {
    object,
    animate(ac) {
      const i = ac.input;
      s.aileronL.rotation.x = -i.roll * 18 * DEG;
      s.aileronR.rotation.x = i.roll * 18 * DEG;
      s.stabL.rotation.x = s.stabR.rotation.x = i.pitch * 14 * DEG;
      s.rudder.rotation.y = i.yaw * 20 * DEG;
      s.leL.rotation.x = s.leR.rotation.x = THREE.MathUtils.clamp(ac.t.aoa / 15, 0, 1) * 20 * DEG;
      const ab = THREE.MathUtils.clamp((ac.engine - 1) / 0.1, 0, 1);
      for (const f of flames) {
        f.material.uniforms.uPower.value = 0.15 + ab * 0.85;
        f.scale.set(1, 1, 0.6 + ab * (3.2 + Math.random() * 0.4));
      }
    },
  };
}
