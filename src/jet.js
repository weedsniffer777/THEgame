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

// Afterburner, built the way most real-time games do it: a few nested additive cone "shells" whose
// edges fade by view angle (so they read as a soft volume, not a cone), plus a row of shock diamonds.
const FLAME_VS = `varying float vT; varying vec3 vN; varying vec3 vV;
  void main(){ vT = clamp(-position.z, 0.0, 1.0); vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`;
const FLAME_FS = `uniform float uPower; uniform float uTime; uniform vec3 uCore; uniform vec3 uTip; uniform float uFade;
  varying float vT; varying vec3 vN; varying vec3 vV;
  void main(){
    float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
    float flick = 0.82 + 0.18 * sin(uTime * 63.0 + vT * 31.0) * sin(uTime * 41.0 - vT * 17.0);
    float i = uPower * pow(1.0 - vT, uFade) * edge * flick;
    gl_FragColor = vec4(mix(uCore, uTip, smoothstep(0.0, 0.8, vT)) * i, 1.0); }`;

function flameMat(core, tip, fade) {
  return new THREE.ShaderMaterial({
    uniforms: { uPower: { value: 0 }, uTime: { value: 0 }, uCore: { value: new THREE.Color(...core) }, uTip: { value: new THREE.Color(...tip) }, uFade: { value: fade } },
    vertexShader: FLAME_VS, fragmentShader: FLAME_FS,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
}

function afterburner() {
  const g = new THREE.Group();
  const shells = [[0.3, [1.0, 0.55, 0.25], [0.25, 0.3, 1.0], 1.2], [0.21, [1.0, 0.75, 0.45], [0.5, 0.4, 1.0], 1.6], [0.12, [1.0, 0.95, 0.85], [1.0, 0.6, 0.4], 2.4]]
    .map(([r, core, tip, fade]) => {
      const m = new THREE.Mesh(new THREE.ConeGeometry(r, 1, 20, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.5), flameMat(core, tip, fade));
      g.add(m); return m;
    });
  const diamonds = [];
  const ball = new THREE.SphereGeometry(1, 14, 10);
  for (let k = 0; k < 5; k++) {
    const m = new THREE.Mesh(ball, flameMat([1.0, 0.9, 0.75], [1.0, 0.6, 0.5], 0.0));
    const r = 0.15 * (1 - k * 0.12);
    m.scale.set(r, r, r * 2.4);
    m.position.z = -(0.55 + k * 0.62);
    m.userData.fall = 1 - k * 0.17;
    g.add(m); diamonds.push(m);
  }
  return {
    group: g,
    update(mil, ab, t) {
      shells.forEach((m, k) => {
        m.material.uniforms.uTime.value = t;
        m.material.uniforms.uPower.value = (k === 2 ? 0.35 : 0.2) * mil + ab * (k === 2 ? 2.2 : 1.4);
        m.scale.z = 0.5 + mil * 0.3 + ab * (k === 0 ? 3.6 : k === 1 ? 2.8 : 1.6) * (0.96 + 0.08 * Math.random());
      });
      for (const d of diamonds) {
        d.material.uniforms.uTime.value = t;
        d.material.uniforms.uPower.value = ab * 1.8 * d.userData.fall;
        d.visible = ab > 0.02;
      }
    },
  };
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

  const flames = NOZZLES.map(p => { const f = afterburner(); f.group.position.copy(p); model.add(f.group); return f; });
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
      const mil = THREE.MathUtils.clamp(ac.engine, 0, 1), t = performance.now() / 1000;
      for (const f of flames) f.update(mil, ab, t);
    },
  };
}
