import * as THREE from 'three';
import { DOORS } from './config.js';

// The F-5 model with moving control surfaces, gear hidden and afterburner flames.
// Model space: +Z nose, +Y up, +X left wing (same as the flight model's body frame).
const GEAR = ['Object023', 'Object052', 'Object024', 'Object032', 'Object033', 'Object049', 'Object050', 'Object051', 'Object030', 'Object048', 'Object035'];
const CG = new THREE.Vector3(0, 1.9, -0.6);
// exhaust exits, measured from the model: centre, at the nozzle lip (opening radius 0.215 m, 0.20 m deeper inside)
export const NOZZLES = [new THREE.Vector3(0.285, 1.628, -6.659), new THREE.Vector3(-0.285, 1.628, -6.659)];
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

  gl_FragColor = vec4(c, 1.0);
}`;
// the inside of the nozzle between the burner face and the lip: a smooth glow, brightest deep inside, that carries
// the disc's light out onto the nozzle walls
const LINER_FS = `
uniform float uMil; uniform float uAB; uniform float uTime; varying vec2 vUv;
void main() {
  float deep = vUv.y;                                                     // 1 at the burner face, 0 at the lip
  vec3 c = mix(vec3(0.75, 0.45, 0.9), vec3(1.0, 0.82, 1.0), deep) * (0.15 + 0.85 * deep * deep) * uAB * 0.9;
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
      u.uLen.value = (diamonds ? 1.3 : 3.2) * (0.3 + 0.7 * ab) * (1 + 0.05 * Math.sin(t * 61) * Math.sin(t * 37));   // (flicker from the clock: stops when the game is paused)
      plume.visible = ab > 0.01;
    },
  };
}

import { loadGltfJson } from './gltf.js';
import { splitAirframe, REGIONS } from './damage.js';
import { tagTextures, loadTex } from './paint.js';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';

// Paint schemes for the player's jet: repainted textures (texture file -> repainted file, made by
// tools/paint/f5_paints.py) and decals: numbers and lettering projected onto the skin at run time (the texture atlas is
// shared by both sides of the jet, so text painted into it would read backwards on one side).
// A decal: text (or lines of small stencil text), where (model space: x left, y up, z nose; 'side' = both sides),
// height in metres, colours.
const P = 'models/jets/paints/';
export const F5_PAINTS = {
  grey: {                                    // polished grey near bare metal, black radome and anti-glare, red rings aft, white fin tip
    textures: { 'f5_0.png': P + 'f5_0.grey.png', 'f5_1.png': P + 'f5_1.grey.png' },
    decals: [
      { text: '10527', at: [2.92, -5.05], side: true, h: 0.3, fill: '#15171b' },                        // low on the fin
      { lines: ['CAUTION', 'ENGINE INTAKE', 'DANGER AREA'], at: [1.9, 1.2], side: true, h: 0.16, fill: '#c8261d' },
      { lines: ['NO STEP'], at: [2.06, -3.35], side: true, h: 0.05, fill: '#2a2d32' },
    ],
  },
  aggressor: {                               // aggressor: glossy black, dark-red numbers thinly outlined in gold, dark-red stencils
    textures: { 'f5_0.png': P + 'f5_0.aggressor.png', 'f5_1.png': P + 'f5_1.aggressor.png' },
    decals: [
      { text: '41', at: [1.58, 5.7], side: true, h: 0.62, fill: '#a01c15', stroke: '#c99a2e', strokeW: 0.07 },   // on the nose
      { text: '41', at: [3.95, -4.95], side: true, h: 0.2, fill: '#8e1812' },                                  // near the fin tip
      { text: '58-0841', at: [2.2, -4.2], side: true, h: 0.07, fill: '#7a1510' },                              // small serial
      { lines: ['CAUTION', 'ENGINE INTAKE', 'DANGER AREA'], at: [1.9, 1.2], side: true, h: 0.16, fill: '#7a1510' },
    ],
  },
  camo: {},                                  // the source model's own two-tone camo
};
export const F5_DEFAULT_PAINT = 'grey';

// a stand-in for a mesh holding only its triangles that face direction n (world space), for projecting decals
const _fa = new THREE.Vector3(), _fb = new THREE.Vector3(), _fc = new THREE.Vector3(), _nm = new THREE.Matrix3();
function facingPart(mesh, n) {
  const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  if (!g.attributes.normal) g.computeVertexNormals();
  const P = g.attributes.position, N = g.attributes.normal, keep = [];
  _nm.getNormalMatrix(mesh.matrixWorld);
  for (let t = 0; t < P.count; t += 3) {
    _fa.set(0, 0, 0);
    for (let k = 0; k < 3; k++) _fa.add(_fb.fromBufferAttribute(N, t + k));
    _fa.applyMatrix3(_nm).normalize();
    if (_fa.dot(n) > 0.15) keep.push(t);
  }
  const pos = new Float32Array(keep.length * 9), nor = new Float32Array(keep.length * 9);
  keep.forEach((t, k) => { for (let v = 0; v < 3; v++) for (let c = 0; c < 3; c++) { pos[k * 9 + v * 3 + c] = P.getComponent(t + v, c); nor[k * 9 + v * 3 + c] = N.getComponent(t + v, c); } });
  g.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  const m = new THREE.Mesh(out); m.matrixWorld.copy(mesh.matrixWorld);
  return m;
}

// a canvas texture with the decal's text: one bold line, or a few lines of small stencil text
function decalTexture(d) {
  const lines = d.lines || [d.text], big = !d.lines;
  const px = big ? 128 : 40, font = `${big ? 800 : 700} ${px}px "Arial Narrow", "Roboto Condensed", system-ui, sans-serif`;
  const c = document.createElement('canvas'), g = c.getContext('2d');
  g.font = font;
  const w = Math.max(...lines.map(l => g.measureText(l).width)) + (d.arrow ? px * 1.6 : 0) + px * 0.5;
  c.width = Math.ceil(w); c.height = Math.ceil(px * 1.15 * lines.length + px * 0.3);
  g.font = font; g.textBaseline = 'top'; g.lineJoin = 'round';
  lines.forEach((l, k) => {
    const y = px * 0.15 + k * px * 1.15, x = px * 0.25;
    if (d.stroke) { g.strokeStyle = d.stroke; g.lineWidth = px * (d.strokeW || 0.16); g.strokeText(l, x, y); }
    g.fillStyle = d.fill; g.fillText(l, x, y);
    if (d.arrow && k === 0) {                         // a pointer after the word
      const ax = x + g.measureText(l).width + px * 0.3, ay = y + px * 0.45;
      g.fillRect(ax, ay - px * 0.06, px * 0.9, px * 0.12);
      g.beginPath(); g.moveTo(ax + px * 1.2, ay); g.lineTo(ax + px * 0.8, ay - px * 0.3); g.lineTo(ax + px * 0.8, ay + px * 0.3); g.fill();
    }
  });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return { tex: t, aspect: c.width / c.height, lines: lines.length };
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
  // gear and doors aren't airframe structure (the bulkheads are shaped without them)
  for (const d of Object.values(doors)) if (d?.isObject3D) d.traverse(o => { if (o.isMesh) o.userData.noBulk = true; });
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
  tagTextures(gltf);
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
  // the main gear doors hang on the wing roots: they go with the wing if it breaks off
  model.updateMatrixWorld(true);
  for (const d of [doors.outerL, doors.outerR, doors.innerL, doors.innerR]) {
    const w = d.getWorldPosition(new THREE.Vector3()); model.worldToLocal(w);
    model.getObjectByName('part:wingInner' + (w.x > 0 ? 'L' : 'R'))?.attach(d);
  }
  const lef = [...seatLEF(model, 'Object057', 'L', REGIONS.lightFighter), ...seatLEF(model, 'Object055', 'R', REGIONS.lightFighter)];
  const flaps = { le: 0, te: 0 };
  model.traverse(o => {
    if (!o.isMesh) return;
    if (o.material.map) o.material.map.anisotropy = 4;
    if (o.material.name === 'glass') {   // clear, glossy canopy instead of the source model's teal tint
      o.material = new THREE.MeshStandardMaterial({ color: 0x0a0c0e, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.28, envMapIntensity: 2.2, depthWrite: false });
    }
  });

  // the burner glow sits in the nozzles, which belong to the rear fuselage: it goes with that part if it breaks off
  const tailPart = model.getObjectByName('part:tail');
  const flames = NOZZLES.map(p => { const f = afterburner(cfg.afterburner); f.group.position.copy(p); model.add(f.group); model.updateMatrixWorld(true); tailPart?.attach(f.group); return f; });
  model.position.copy(CG).negate();
  const object = new THREE.Group().add(model);

  // paint: swap the airframe's textures for a scheme's and project its decals onto the skin
  const origTex = new Map(), decals = [], _ray = new THREE.Raycaster(), _o = new THREE.Vector3(), _dir = new THREE.Vector3();
  model.traverse(o => { if (o.isMesh && !o.userData.noSplit) for (const k of ['map', 'roughnessMap', 'metalnessMap']) { const t = o.material[k]; if (t?.userData.src) origTex.set(t.userData.src, t); } });
  async function setPaint(name) {
    const sc = F5_PAINTS[name] || {};
    const tex = {};
    for (const [src, t] of origTex) { tex[src] = sc.textures?.[src] ? await loadTex(sc.textures[src], t) : t; tex[src].userData.orig = src; }
    model.traverse(o => {
      if (!o.isMesh || o.userData.decal) return;
      const m = o.material; let changed = false;
      for (const k of ['map', 'roughnessMap', 'metalnessMap']) {
        const base = m[k] && (m[k].userData.orig || m[k].userData.src);
        if (base && tex[base] && m[k] !== tex[base]) { m[k] = tex[base]; changed = true; }
      }
      if (changed) m.needsUpdate = true;
    });
    for (const d of decals.splice(0)) { d.removeFromParent(); d.geometry.dispose(); d.material.dispose(); }
    model.updateMatrixWorld(true);
    const hull = []; model.traverse(o => { if (o.isMesh && !o.userData.noSplit && !o.userData.decal && o.material.name !== 'glass' && o.visible) hull.push(o); });
    for (const d of sc.decals || []) {
      const { tex: map, aspect } = decalTexture(d);
      for (const sgn of d.side ? [1, -1] : [1]) {
        // find the skin: a ray in from the side at the given height and station
        _o.set(sgn * 4, d.at[0], d.at[1]); model.localToWorld(_o);
        _dir.set(-sgn, 0, 0).transformDirection(model.matrixWorld);
        _ray.set(_o, _dir);
        const hit = _ray.intersectObjects(hull, false)[0];
        if (!hit) continue;
        // the projector's frame: z out of the skin (mirrored parts can report inward normals: forced outward, away from
        // the centreline), y the airframe's up, x across: text reads upright and the right way round from outside
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        const c = new THREE.Vector3(0, d.at[0], d.at[1]); model.localToWorld(c);
        if (n.dot(_o.copy(hit.point).sub(c)) < 0) n.negate();
        const up = new THREE.Vector3(0, 1, 0).transformDirection(model.matrixWorld);
        const yv = up.sub(n.clone().multiplyScalar(up.dot(n))).normalize(), xv = new THREE.Vector3().crossVectors(yv, n);
        // projected onto the skin so it wraps the curves, but only onto the triangles that face the projector (the decal
        // box is deeper than a fin is thick: otherwise it would print through onto the far side, mirrored)
        const h = d.h * (d.lines ? (d.lines.length * 1.15 + 0.3) / (d.lines.length * 1.15) : 1.15);
        const proj = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xv, yv, n));
        // every skin mesh under the decal gets its piece (a number can run across the fin and the rudder)
        for (const part of hull) {
          const facing = facingPart(part, n);
          if (!facing.geometry.attributes.position.count) { facing.geometry.dispose(); continue; }
          const geo = new DecalGeometry(facing, hit.point, proj, new THREE.Vector3(h * aspect, h, 0.6));
          facing.geometry.dispose();
          if (!geo.attributes.position.count) { geo.dispose(); continue; }
          geo.applyMatrix4(new THREE.Matrix4().copy(part.matrixWorld).invert());     // (into that part's own space)
          const mat = new THREE.MeshStandardMaterial({ map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 0.3, metalness: 0 });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.userData.decal = mesh.userData.noSplit = mesh.userData.noBulk = true;
          part.add(mesh); decals.push(mesh);
        }
      }
    }
  }
  await setPaint(F5_DEFAULT_PAINT);

  const SF = cfg.surfaces;
  // the stick that holds the stab's full-travel AoA (pitchControl * stick = pitchStability * sin(aoa), as the instructor uses)
  const stabFullUp = Math.sin(SF.stabFullAoA * DEG) * cfg.pitchStability / cfg.pitchControl;
  const stabFullDown = Math.sin(SF.stabFullNegAoA * DEG) * cfg.pitchStability / cfg.pitchControl;
  return {
    object, model, setPaint,
    animate(acReal, time = performance.now() / 1000) {   // time: the game clock (stands still while paused)
      const frozen = time === this._t; this._t = time;
      const V = viewerAnim;
      if (V.active && V.cycle) {
        const t = performance.now() / 1000;
        V.pitch = Math.sin(t * 1.3); V.roll = Math.sin(t * 0.9 + 1); V.yaw = Math.sin(t * 1.1 + 2);
        V.airbrake = 0.5 + 0.5 * Math.sin(t * 0.5); V.engine = 1.05 + 0.05 * Math.sin(t * 0.7);
        V.gear = THREE.MathUtils.clamp(0.5 + 0.8 * Math.sin(t * 0.35), 0, 1); V.canopy = THREE.MathUtils.clamp(Math.sin(t * 0.25) * 1.5, 0, 1);
      }
      const ac = V.active ? { input: V, engine: V.engine, airbrake: V.airbrake, t: { aoa: V.aoa, ias: 100 }, gear: V.gear } : acReal;
      const gear = V.active ? V.gear : (acReal.gear || 0), canopy = V.active ? V.canopy : 0;
      const i = ac.input;
      s.aileronL.rotation.x = -i.roll * SF.aileron * DEG;
      s.aileronR.rotation.x = i.roll * SF.aileron * DEG;
      // stabilators: the stick the flight model needs at the AoA limit shows as full travel (in the viewer: the raw input)
      const sp = V.active ? i.pitch : i.pitch > 0 ? i.pitch / stabFullUp : i.pitch / stabFullDown;
      s.stabL.rotation.x = s.stabR.rotation.x = THREE.MathUtils.clamp(sp, -1, 1) * (sp > 0 ? SF.stabUp : SF.stabDown) * DEG;
      s.rudder.rotation.y = i.yaw * SF.rudder * DEG;
      object.updateMatrixWorld(true);
      legClip.copy(WING_UNDER).applyMatrix4(model.matrixWorld);
      setDoors(DOORS, ac.airbrake, gear, canopy);
      // Flaps (travel and schedule from cfg.surfaces):
      //  - auto (maneuvering): out with angle of attack, most at high AoA and low speed, in at high speed;
      //  - gear down (landing): to their notches by airspeed: full below 200 kt, half below 260 kt, up above (blowback).
      const kt = (ac.t?.ias || 0) * 1.944, aoa = ac.t?.aoa || 0;
      let k = THREE.MathUtils.smoothstep(aoa, SF.flapAoA[0], SF.flapAoA[1]) * (1 - THREE.MathUtils.smoothstep(kt, SF.flapKt[0], SF.flapKt[1]));
      if (gear > 0.5) k = Math.max(k, kt < SF.landFlapKt[0] ? 1 : kt < SF.landFlapKt[1] ? 0.5 : 0);
      if (V.active) k = V.flaps ?? k;
      const rate = SF.flapRate * (1 / 60);                                      // deg per frame
      flaps.le += THREE.MathUtils.clamp(SF.leFlap * k - flaps.le, -rate, rate);
      flaps.te += THREE.MathUtils.clamp(SF.teFlap * k - flaps.te, -rate, rate);
      for (const t of lef) t.rotation.x = flaps.le * DEG;
      s.flapL.rotation.x = s.flapR.rotation.x = -flaps.te * DEG;
      const ab = THREE.MathUtils.clamp((ac.engine - 1) / 0.1, 0, 1);
      const mil = THREE.MathUtils.clamp(ac.engine, 0, 1), t = time;
      for (const f of flames) f.update(mil, ab, t);
    },
  };
}
