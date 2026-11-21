import * as THREE from 'three';
import { DOORS } from './config.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// The F-5 model with moving control surfaces, gear hidden and afterburner flames.
// Model space: +Z nose, +Y up, +X left wing (same as the flight model's body frame).
const GEAR = ['Object055', 'Object057', 'Object023', 'Object052', 'Object024', 'Object032', 'Object033', 'Object049', 'Object050', 'Object051', 'Object030', 'Object048', 'Object035'];
const CG = new THREE.Vector3(0, 1.9, -0.6);
// exhaust exits, measured from the model: centre, at the nozzle lip (opening radius 0.215 m, 0.20 m deeper inside)
const NOZZLES = [new THREE.Vector3(0.285, 1.628, -6.659), new THREE.Vector3(-0.285, 1.628, -6.659)];
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

// Afterburner, done the usual real-time way:
// - a glowing disc set just inside each nozzle, so looking up the exhaust shows hot metal, not a dark hole
// - the flame itself as a row of soft camera-facing billboards along the exhaust axis. Each one stretches along
//   the axis when seen from the side and turns into a round glow when seen from behind, so the plume never
//   vanishes or shows hard edges from any angle.
// - optional shock diamonds: smaller, brighter billboards at growing intervals after the first flame.
const BB_VS = `
attribute vec4 aInst;   // x: position along the plume (0..1), y: half width (m), z: half length (0..1 of plume), w: 0 flame / 1 diamond
attribute float aSeed;
uniform float uLen;
varying vec2 vUv; varying float vT; varying float vKind; varying float vSeed;
void main() {
  bool flame = aInst.w < 0.5;
  float along = flame ? aInst.x * uLen : aInst.x;
  vec4 c = modelViewMatrix * vec4(0.0, 0.0, -along, 1.0);
  vec3 ax = normalize(mat3(modelViewMatrix) * vec3(0.0, 0.0, -1.0));
  float l = length(ax.xy);
  vec2 dx = l > 1e-3 ? ax.xy / l : vec2(1.0, 0.0), dy = vec2(-dx.y, dx.x);
  float w = aInst.y * (flame ? 1.0 + aInst.x * 0.4 : 1.0);
  float hl = mix(w, max(w, aInst.z * (flame ? uLen : 1.0)), l);
  c.xy += dx * position.x * hl + dy * position.y * w;
  vUv = position.xy; vT = aInst.x; vKind = aInst.w; vSeed = aSeed;
  gl_Position = projectionMatrix * c;
}`;
const BB_FS = `
uniform float uAB; uniform float uTime; uniform vec3 uHot; uniform vec3 uCool; uniform vec3 uDia;
varying vec2 vUv; varying float vT; varying float vKind; varying float vSeed;
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float soft = (exp(-r2 * 3.0) - 0.05) / 0.95;
  float fl = 0.8 + 0.2 * sin(uTime * 53.0 + vSeed * 11.0) * sin(uTime * 37.0 + vSeed * 5.0);
  vec3 col; float i;
  if (vKind < 0.5) { col = mix(uHot, uCool, smoothstep(0.0, 0.8, vT)); i = uAB * pow(1.0 - vT, 1.3) * 0.55 * fl; }
  else { col = uDia; i = uAB * (1.0 - vT * 0.08) * 0.9 * fl; }
  gl_FragColor = vec4(col * i * soft, 1.0);
}`;
const CORE_FS = `
uniform float uMil; uniform float uAB; varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  vec3 c = mix(vec3(1.0, 0.85, 1.0) * 1.6, vec3(0.55, 0.42, 1.0) * 0.9, r * r) * uAB;
  gl_FragColor = vec4(c, 1.0);
}`;

function afterburner(kind) {
  const g = new THREE.Group();
  const core = new THREE.Mesh(new THREE.CircleGeometry(0.198, 32).rotateY(Math.PI), new THREE.ShaderMaterial({
    uniforms: { uMil: { value: 0 }, uAB: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: CORE_FS,
  }));
  core.position.z = 0.3;    // recessed inside the nozzle, where it is 0.20 m wide
  g.add(core);

  const diamonds = kind === 'diamonds';
  const inst = [], seeds = [];
  const N = diamonds ? 6 : 10;
  for (let k = 0; k < N; k++) { const t = k / (N - 1); inst.push(t, 0.3, 0.75 / (N - 1), 0); seeds.push(Math.random() * 10); }
  if (diamonds) for (let k = 0; k < 5; k++) { inst.push(1.1 + k * 0.7 + k * k * 0.05, 0.13 * (1 - k * 0.1), 0.24, 1); seeds.push(Math.random() * 10); }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute('aInst', new THREE.InstancedBufferAttribute(new Float32Array(inst), 4));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(seeds), 1));
  geo.instanceCount = seeds.length;
  const plume = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms: {
      uLen: { value: 1 }, uAB: { value: 0 }, uTime: { value: 0 },
      uHot: { value: new THREE.Color(1.0, 0.62, 0.36) }, uCool: { value: new THREE.Color(0.45, 0.42, 1.0) },
      uDia: { value: new THREE.Color(1.0, 0.86, 0.72) },
    },
    vertexShader: BB_VS, fragmentShader: BB_FS,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  plume.frustumCulled = false;
  g.add(plume);
  return {
    group: g,
    update(mil, ab, t) {
      core.material.uniforms.uMil.value = mil;
      core.material.uniforms.uAB.value = ab;
      const u = plume.material.uniforms;
      u.uAB.value = ab; u.uTime.value = t;
      u.uLen.value = (diamonds ? 1.3 : 3.2) * (0.3 + 0.7 * ab) * (0.95 + 0.1 * Math.random());
      plume.visible = ab > 0.01;
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

// The source model is posed for the ground: canopy open, gear doors open. Close it up for flight.
function swing(model, names, axis, deg, at) {
  const first = model.getObjectByName(names[0]);
  const pivot = new THREE.Object3D();
  if (at) pivot.position.copy(at); else { first.getWorldPosition(pivot.position); model.worldToLocal(pivot.position); }
  model.add(pivot);
  model.updateMatrixWorld(true);
  for (const n of names) { const o = model.getObjectByName(n); o.visible = true; pivot.attach(o); }
  pivot.rotation[axis] = deg * DEG;
  return pivot;
}

let brakes = [];
const doors = {};
function closeUp(model) {
  doors.canopy = swing(model, ['Object001', 'Object025'], 'x', 0, new THREE.Vector3(0, 2.7477, 1.6497));
  doors.nose = swing(model, ['Object032'], 'z', 0);                                             // long nose gear door
  doors.noseTwin = doors.nose.clone();                                                          // the model only has one: mirror it
  doors.noseTwin.position.x = -doors.nose.position.x; doors.noseTwin.scale.x = -1;
  model.add(doors.noseTwin);
  doors.small = swing(model, ['Object033'], 'x', 0, new THREE.Vector3(0, 1.184, 4.013));      // small aft nose door, top-edge hinge
  // main gear legs ride on the same hinge as their leg doors, so the gear slider retracts them together
  doors.outerL = swing(model, ['Object051', 'Object052'], 'z', 0, new THREE.Vector3(-1.97, 1.35, -1.25));
  doors.outerR = swing(model, ['Object048', 'Object023'], 'z', 0, new THREE.Vector3(1.97, 1.35, -1.25));
  doors.innerL = swing(model, ['Object050'], 'z', 0); doors.innerR = swing(model, ['Object035'], 'z', 0);   // inner main doors
  brakes = [swing(model, ['Object049'], 'x', 0), swing(model, ['Object030'], 'x', 0)];        // speed brakes
  doors.legs = ['Object052', 'Object023', 'Object024'].map(n => model.getObjectByName(n));
}

// gear: 0 = up (doors at their closed angles, legs hidden), 1 = down as modelled. canopy: 0 shut, 1 open.
function setDoors(D, airbrake, gear, canopy) {
  const g = (closed) => THREE.MathUtils.lerp(closed, 0, gear) * DEG;
  doors.canopy.rotation.x = THREE.MathUtils.lerp(45, 0, canopy) * DEG;
  doors.nose.rotation.z = g(D.noseMain); doors.noseTwin.rotation.z = -g(D.noseMain);
  doors.small.rotation.x = g(D.smallNose);
  doors.outerL.rotation.z = g(D.outerMain); doors.outerR.rotation.z = -g(D.outerMain);
  doors.innerL.rotation.z = -g(D.innerMain); doors.innerR.rotation.z = g(D.innerMain);
  for (const l of doors.legs) l.visible = gear > 0.05;
  doors.legs[2].visible = gear > 0.6;   // nose leg: no hinge data, shown once the gear is mostly down
  const sb = THREE.MathUtils.lerp(D.speedBrakeClosed, D.speedBrakeOpen, airbrake);
  for (const b of brakes) b.rotation.x = THREE.MathUtils.lerp(sb, 0, gear) * DEG;
}

// the model viewer drives every animation from here instead of the flight model
export const viewerAnim = { active: false, pitch: 0, roll: 0, yaw: 0, airbrake: 0, engine: 1, aoa: 0, gear: 0, canopy: 0, cycle: false };

export async function loadJet(url, cfg) {
  const gltf = await new GLTFLoader().parseAsync(await packGlb(url), url.slice(0, url.lastIndexOf('/') + 1));
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  for (const n of GEAR) { const o = model.getObjectByName(n); if (o) o.visible = false; }
  closeUp(model);
  const s = {
    aileronL: hinge(model, 'Object027', 'front'), aileronR: hinge(model, 'Object056', 'front'),
    stabL: hinge(model, 'Object053', 'center'), stabR: hinge(model, 'Object054', 'center'),
    rudder: hinge(model, 'Object026', 'front'),
  };
  model.traverse(o => { if (o.isMesh) { o.castShadow = false; if (o.material.map) o.material.map.anisotropy = 4; } });

  const flames = NOZZLES.map(p => { const f = afterburner(cfg.afterburner); f.group.position.copy(p); model.add(f.group); return f; });
  model.position.copy(CG).negate();
  const object = new THREE.Group().add(model);

  return {
    object, model,
    animate(acReal) {
      const V = viewerAnim;
      if (V.active && V.cycle) {
        const t = performance.now() / 1000;
        V.pitch = Math.sin(t * 1.3); V.roll = Math.sin(t * 0.9 + 1); V.yaw = Math.sin(t * 1.1 + 2);
        V.airbrake = 0.5 + 0.5 * Math.sin(t * 0.5); V.engine = 1.05 + 0.05 * Math.sin(t * 0.7);
        V.gear = THREE.MathUtils.clamp(0.5 + 0.8 * Math.sin(t * 0.35), 0, 1); V.canopy = THREE.MathUtils.clamp(Math.sin(t * 0.25) * 1.5, 0, 1);
      }
      const ac = V.active ? { input: V, engine: V.engine, airbrake: V.airbrake, t: { aoa: V.aoa } } : acReal;
      const gear = V.active ? V.gear : 0, canopy = V.active ? V.canopy : 0;
      const i = ac.input;
      s.aileronL.rotation.x = -i.roll * 18 * DEG;
      s.aileronR.rotation.x = i.roll * 18 * DEG;
      s.stabL.rotation.x = s.stabR.rotation.x = i.pitch * 14 * DEG;
      s.rudder.rotation.y = i.yaw * 20 * DEG;
      setDoors(DOORS, ac.airbrake, gear, canopy);
      const ab = THREE.MathUtils.clamp((ac.engine - 1) / 0.1, 0, 1);
      const mil = THREE.MathUtils.clamp(ac.engine, 0, 1), t = performance.now() / 1000;
      for (const f of flames) f.update(mil, ab, t);
    },
  };
}
