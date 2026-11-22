import * as THREE from 'three';
import { DOORS } from './config.js';

// The F-5 model with moving control surfaces, gear hidden and afterburner flames.
// Model space: +Z nose, +Y up, +X left wing (same as the flight model's body frame).
const GEAR = ['Object023', 'Object052', 'Object024', 'Object032', 'Object033', 'Object049', 'Object050', 'Object051', 'Object030', 'Object048', 'Object035'];
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
const NOISE = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }`;
// the burner face deep in the nozzle: a blue-white core with turbulent flame tongues licking out to the rim,
// where it meets the liner, so it reads as fire filling the pipe rather than a lit disc
const CORE_FS = `
uniform float uMil; uniform float uAB; uniform float uTime; varying vec2 vUv;
${NOISE}
void main() {
  float r = length(vUv - 0.5) * 2.0;
  vec3 c = mix(vec3(1.0, 0.85, 1.0) * 1.6, vec3(0.55, 0.42, 1.0) * 0.9, r * r) * uAB;   // the solid glowing disc
  // flame tongues licking out over its rim toward the liner (they only add light, the disc stays solid)
  // thin straight rays spraying out over the rim (sharp, not wobbly); dry power stays dark
  float a = atan(vUv.y - 0.5, vUv.x - 0.5) / 6.2832;
  float n = noise(vec2(a * 70.0, r * 1.2 - uTime * 30.0));
  c += vec3(1.0, 0.6, 0.38) * smoothstep(0.62, 0.8, n) * smoothstep(0.55, 1.0, r) * uAB * 0.45;
  gl_FragColor = vec4(c, 1.0);
}`;
// the inside of the nozzle between the burner face and the lip: hot liner with flame licks streaming out
const LINER_FS = `
uniform float uMil; uniform float uAB; uniform float uTime; varying vec2 vUv;
${NOISE}
void main() {
  float deep = vUv.y;                                                     // 1 at the burner face, 0 at the lip
  // thin straight streaks along the pipe, racing out toward the lip (sharp spray, not wobbly tongues)
  float n = noise(vec2(vUv.x * 90.0, deep * 1.5 + uTime * 34.0));
  float lick = smoothstep(0.6, 0.78, n + deep * 0.2);
  vec3 c = mix(vec3(0.9, 0.4, 0.3), vec3(1.0, 0.75, 0.9), lick) * lick * (0.3 + 0.7 * deep) * uAB * 0.7;
  gl_FragColor = vec4(c, 1.0);
}`;

function afterburner(kind) {
  const g = new THREE.Group();
  const core = new THREE.Mesh(new THREE.CircleGeometry(0.198, 32).rotateY(Math.PI), new THREE.ShaderMaterial({
    uniforms: { uMil: { value: 0 }, uAB: { value: 0 }, uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: CORE_FS,
  }));
  core.position.z = 0.3;    // recessed inside the nozzle, where it is 0.20 m wide
  g.add(core);
  // liner from the burner face (0.198 m) out to just inside the lip (0.212 m), drawn as added light
  const liner = new THREE.Mesh(new THREE.CylinderGeometry(0.194, 0.208, 0.3, 32, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.15), new THREE.ShaderMaterial({
    uniforms: { uMil: { value: 0 }, uAB: { value: 0 }, uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: LINER_FS, side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  g.add(liner);

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
      for (const m of [core, liner]) { const u = m.material.uniforms; u.uMil.value = mil; u.uAB.value = ab; u.uTime.value = t; }
      const u = plume.material.uniforms;
      u.uAB.value = ab; u.uTime.value = t;
      u.uLen.value = (diamonds ? 1.3 : 3.2) * (0.3 + 0.7 * ab) * (0.95 + 0.1 * Math.random());
      plume.visible = ab > 0.01;
    },
  };
}

import { loadGltfJson } from './gltf.js';
import { splitAirframe, REGIONS } from './damage.js';

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
  doors.noseLeg = swing(model, ['Object024'], 'x', 0, new THREE.Vector3(0, 1.33, 4.31));   // pivot: the top of the leg
  for (const n of ['Object052', 'Object023']) model.getObjectByName(n).traverse(o => {
    if (o.isMesh) { o.material = o.material.clone(); o.material.clippingPlanes = [legClip]; }
  });
}

// gear: 0 = up (doors at their closed angles, legs hidden), 1 = down as modelled. canopy: 0 shut, 1 open.
// Sequence: the doors open first, then the legs come down (and the reverse going up). The main legs ride on their
// outer doors' hinges; the nose leg swings down from its own pivot at the top of the leg, out of the well ahead of it.
function setDoors(D, airbrake, gear, canopy) {
  const doorK = THREE.MathUtils.smoothstep(gear, 0, 0.12), legK = THREE.MathUtils.smoothstep(gear, 0.15, 1);   // doors snap open (~0.5 s) before the legs move
  const g = (closed, k) => THREE.MathUtils.lerp(closed, 0, k) * DEG;
  doors.canopy.rotation.x = THREE.MathUtils.lerp(45, 0, canopy) * DEG;
  doors.nose.rotation.z = g(D.noseMain, doorK); doors.noseTwin.rotation.z = -g(D.noseMain, doorK);
  doors.small.rotation.x = g(D.smallNose, doorK);
  doors.outerL.rotation.z = g(D.outerMain, legK); doors.outerR.rotation.z = -g(D.outerMain, legK);
  doors.innerL.rotation.z = -g(D.innerMain, doorK); doors.innerR.rotation.z = g(D.innerMain, doorK);
  for (const l of doors.legs) l.visible = gear > 0.2;
  doors.noseLeg.rotation.x = -100 * DEG * (1 - legK);                     // stowed forward and tipped up in the nose
  const sb = THREE.MathUtils.lerp(D.speedBrakeClosed, D.speedBrakeOpen, airbrake);
  for (const b of brakes) b.rotation.x = sb * DEG;                         // (the model's ground pose has them open: not tied to the gear)
}

// The main legs' upper braces would swing up through the wing on the way: everything of them above the underside
// of the wing is clipped away (it is inside the wing when the gear is down anyway).
const WING_UNDER = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.41);     // keeps y < 1.41 (model space)
const legClip = new THREE.Plane();

// Compressor faces, seen down the intake ducts. The model's ducts end in a flat wall textured with a slice of the
// wheel texture; the texture atlas does hold a proper compressor face (a round disc near pixel 997,468), so that
// image is shown on a round disc in front of the wall, over a dark backing that fills the duct's tall oval, and is
// spun by turning its texture about the disc centre. Each rendered frame it turns a share of the blade gap set by
// engine power (windmilling with the engine off), which reads as forward spin at any frame rate.
const FANS = [new THREE.Vector3(0.77, 1.55, 0.34), new THREE.Vector3(-0.77, 1.55, 0.34)];
const FAN_PX = { cx: 997, cy: 468, r: 19, size: 1024 };
const FAN_STEP = 2 * Math.PI / 24;              // the face has ~24 blades
function fan(atlas) {
  const g = new THREE.Group();
  const back = new THREE.Mesh(new THREE.CircleGeometry(0.28, 32), new THREE.MeshBasicMaterial({ color: 0x07080a }));
  back.scale.set(0.46, 0.95, 1); back.position.z = -0.004;
  const tex = atlas.clone(); tex.needsUpdate = true;
  const { cx, cy, r, size } = FAN_PX;
  // (with a rotation centre set, the offset places the centre of the crop: uv' = repeat * (uv - 0.5) + 0.5 + offset)
  tex.repeat.set(2 * r / size, (tex.flipY ? 2 : -2) * r / size);
  tex.offset.set(cx / size - 0.5, (tex.flipY ? 1 - cy / size : cy / size) - 0.5);
  tex.center.set(0.5, 0.5);
  const face = new THREE.Mesh(new THREE.CircleGeometry(0.115, 40), new THREE.MeshBasicMaterial({ map: tex, color: 0x9a9a9a }));
  g.add(back, face);
  g.userData.tex = tex;
  return g;
}

// The leading-edge flaps are the model's own Object057 (left) and Object055 (right). Each droops about its rear
// edge (a swept hinge line read from the mesh itself) and is cut where the wing splits into inner and outer
// sections, so each half stays with its section when that breaks off.
// clip a (non-indexed) triangle list to the side of plane where distance >= 0
function clipGeometry(geo, plane) {
  const names = Object.keys(geo.attributes), src = names.map(n => geo.attributes[n]);
  const out = names.map(() => []), v = new THREE.Vector3();
  const count = geo.index ? geo.index.count : geo.attributes.position.count;
  const vid = (k) => geo.index ? geo.index.array[k] : k;
  const vert = (i) => src.map(a => Array.from({ length: a.itemSize }, (_, c) => a.array[i * a.itemSize + c]));
  const lerp = (A, B, t) => A.map((arr, j) => arr.map((x, c) => x + (B[j][c] - x) * t));
  const dist = (i) => plane.distanceToPoint(v.fromBufferAttribute(geo.attributes.position, i));
  const emit = (V) => V.forEach((arr, j) => out[j].push(...arr));
  for (let k = 0; k < count; k += 3) {
    const ids = [vid(k), vid(k + 1), vid(k + 2)], d = ids.map(dist), P = ids.map(vert);
    const poly = [];
    for (let e = 0; e < 3; e++) {
      const a = e, b = (e + 1) % 3;
      if (d[a] >= 0) poly.push(P[a]);
      if ((d[a] >= 0) !== (d[b] >= 0)) poly.push(lerp(P[a], P[b], d[a] / (d[a] - d[b])));
    }
    for (let t = 1; t + 1 < poly.length; t++) { emit(poly[0]); emit(poly[t]); emit(poly[t + 1]); }
  }
  const g = new THREE.BufferGeometry();
  names.forEach((n, j) => g.setAttribute(n, new THREE.Float32BufferAttribute(out[j], src[j].itemSize)));
  return g;
}

function seatLEF(model, name, side, R) {
  const node = model.getObjectByName(name); if (!node) return [];
  const sx = side === 'L' ? 1 : -1;
  model.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const meshes = []; node.traverse(o => { if (o.isMesh) meshes.push(o); });
  // hinge: the upper rear corner at each end of the flap
  const v = new THREE.Vector3(), pts = [];
  for (const m of meshes) { const M = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld), pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(M).clone()); }
  const ax = pts.map(p => Math.abs(p.x)), lo = Math.min(...ax), hi = Math.max(...ax);
  const end = (x0) => { const near = pts.filter(p => Math.abs(Math.abs(p.x) - x0) < 0.08); const zMin = Math.min(...near.map(p => p.z));
    const back = near.filter(p => p.z < zMin + 0.03); return back.reduce((a, p) => p.y > a.y ? p : a, back[0]).clone(); };
  const a = end(lo), b = end(hi);
  const axis = b.clone().sub(a).normalize(); if (sx < 0) axis.negate();        // both toward +x: + rotation = leading edge down
  const split = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(sx, 0, 0), new THREE.Vector3(sx * R.outer.x, 0, 0));
  const turns = [];
  for (const [part, plane] of [['wingInner' + side, split.clone().negate()], ['wingOuter' + side, split]]) {
    const P = model.getObjectByName('part:' + part); if (!P) continue;
    const pivot = new THREE.Object3D(); pivot.position.copy(a); pivot.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), axis);
    const turn = new THREE.Object3D(); pivot.add(turn); model.add(pivot); model.updateMatrixWorld(true);
    for (const m of meshes) {
      const toLocal = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld).invert();
      const g = clipGeometry(m.geometry, plane.clone().applyMatrix4(toLocal));
      if (!g.attributes.position.count) continue;
      const piece = new THREE.Mesh(g, m.material);
      piece.matrixAutoUpdate = false; piece.matrix.multiplyMatrices(inv, m.matrixWorld);   // model space
      model.add(piece); model.updateMatrixWorld(true); turn.attach(piece);
    }
    P.attach(pivot);
    turns.push(turn);
  }
  node.removeFromParent();                                                     // replaced by the two hinged halves
  return turns;
}

// the model viewer drives every animation from here instead of the flight model
export const viewerAnim = { active: false, pitch: 0, roll: 0, yaw: 0, airbrake: 0, engine: 1, aoa: 0, gear: 0, canopy: 0, cycle: false };

export async function loadJet(url, cfg) {
  const gltf = await loadGltfJson(url);
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  for (const n of GEAR) { const o = model.getObjectByName(n); if (o) o.visible = false; }
  closeUp(model);
  const s = {
    aileronL: hinge(model, 'Object027', 'front'), aileronR: hinge(model, 'Object056', 'front'),
    stabL: hinge(model, 'Object053', 'center'), stabR: hinge(model, 'Object054', 'center'),
    rudder: hinge(model, 'Object026', 'front'),
    flapL: hinge(model, 'Object028', 'front'), flapR: hinge(model, 'Object058', 'front'),   // trailing-edge flaps
  };
  splitAirframe(model, s);
  const lef = [...seatLEF(model, 'Object057', 'L', REGIONS.lightFighter), ...seatLEF(model, 'Object055', 'R', REGIONS.lightFighter)];
  const flaps = { le: 0, te: 0 };
  model.traverse(o => {
    if (!o.isMesh) return;
    if (o.material.map) o.material.map.anisotropy = 4;
    if (o.material.name === 'glass') {   // clear, glossy canopy instead of the source model's teal tint
      o.material = new THREE.MeshStandardMaterial({ color: 0x0a0c0e, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.28, envMapIntensity: 2.2, depthWrite: false });
    }
  });

  const flames = NOZZLES.map(p => { const f = afterburner(cfg.afterburner); f.group.position.copy(p); model.add(f.group); return f; });
  let atlas = null; model.traverse(o => { if (!atlas && o.isMesh && o.material.map && o.material.name === 'Northrop_F-5') atlas = o.material.map; });
  const fans = atlas ? FANS.map(p => { const f = fan(atlas); f.position.copy(p); model.add(f); return f; }) : [];
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
      const ac = V.active ? { input: V, engine: V.engine, airbrake: V.airbrake, t: { aoa: V.aoa, ias: 100 } } : acReal;
      const gear = V.active ? V.gear : (acReal.gear || 0), canopy = V.active ? V.canopy : 0;
      const i = ac.input;
      s.aileronL.rotation.x = -i.roll * 18 * DEG;
      s.aileronR.rotation.x = i.roll * 18 * DEG;
      s.stabL.rotation.x = s.stabR.rotation.x = i.pitch * 14 * DEG;
      s.rudder.rotation.y = i.yaw * 20 * DEG;
      object.updateMatrixWorld(true);
      legClip.copy(WING_UNDER).applyMatrix4(model.matrixWorld);
      setDoors(DOORS, ac.airbrake, gear, canopy);
      // Flaps, F-5 style (leading edge up to 24 deg, trailing edge up to 20 deg):
      //  - auto (maneuvering): out with angle of attack, most at high AoA and low speed, in at high speed;
      //  - gear down (landing): to their notches by airspeed: full below 200 kt, half below 260 kt, up above (blowback).
      const kt = (ac.t?.ias || 0) * 1.944, aoa = ac.t?.aoa || 0;
      let k = THREE.MathUtils.smoothstep(aoa, 4, 14) * (1 - THREE.MathUtils.smoothstep(kt, 320, 480));
      if (gear > 0.5) k = Math.max(k, kt < 200 ? 1 : kt < 260 ? 0.5 : 0);
      if (V.active) k = V.flaps ?? k;
      const rate = 25 * (1 / 60);                                               // deg per frame (~25 deg/s)
      flaps.le += THREE.MathUtils.clamp(24 * k - flaps.le, -rate, rate);
      flaps.te += THREE.MathUtils.clamp(20 * k - flaps.te, -rate, rate);
      for (const t of lef) t.rotation.x = flaps.le * DEG;
      s.flapL.rotation.x = s.flapR.rotation.x = -flaps.te * DEG;
      const ab = THREE.MathUtils.clamp((ac.engine - 1) / 0.1, 0, 1);
      const mil = THREE.MathUtils.clamp(ac.engine, 0, 1), t = performance.now() / 1000;
      for (const f of flames) f.update(mil, ab, t);
      const step = FAN_STEP * (0.1 + 0.3 * Math.min(ac.engine, 1));      // per frame: never past half the blade gap
      for (const f of fans) f.userData.tex.rotation = (f.userData.tex.rotation + step) % (2 * Math.PI);
    },
  };
}
