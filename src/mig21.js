import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loadGltfJson } from './gltf.js';
import { splitAirframe, REGIONS, classify } from './damage.js';
import { tagTextures } from './paint.js';
import { afterburner, clipGeometry, viewerAnim } from './jet.js';

// The MiG-21 (second player jet; dev kit only for now). Same interface as loadJet (jet.js): { object, model, setPaint,
// animate, cg, nozzles, rails, muzzles, missileProto, contacts }.
// The source model is one low-poly airframe skin (no separate surfaces), so the moving parts are cut out of it here
// along their hinge lines: flaps and ailerons (trailing edge, split where the wing's own vertex row is at 2.06 m),
// the all-moving stabilators, the rudder (parallel to the fin's trailing edge). Its gear (legs, wheels, covers) is
// separate and retracts (main legs inward, nose leg forward); the intake cone slides forward with Mach; one nozzle with
// our own afterburner (shock diamonds). Flaps only come down with the gear (no manoeuvring flaps).
// Model space (as everywhere): +Z nose, +Y up, +X left wing; the model is centred on its CG inside `object`.
const DEG = Math.PI / 180;
const CG = new THREE.Vector3(0, -0.3, 0.1);                 // ~a quarter of the way along the delta's mean chord
const NOZZLE = new THREE.Vector3(0, -0.31, -6.36), NOZZLE_R = 0.4;
const body = (x, y, z) => new THREE.Vector3(x, y, z).sub(CG);

// damage regions (model space, measured): nose ahead of the cockpit, rear fuselage behind the wing, the fin, the wing
// cut at the pylons (inner) and outboard of the inner pylon (outer); the stabilators are cut out as moving parts
REGIONS.mig21 = { jag: 0.16, noseZ: 4.5, tail: { z: -4.3 }, fin: { y: 0.45, z: -2.2 }, outer: { x: 2.3, y: 0.0, z0: -3.2, z1: 1.2 }, inner: { x: 0.66, y: -0.15, z0: -3.2, z1: 2.4 } };

const plane = (n, p) => new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...n).normalize(), new THREE.Vector3(...p));
const mirror = (pl) => new THREE.Plane(new THREE.Vector3(-pl.normal.x, pl.normal.y, pl.normal.z), pl.constant);
// cut the part of `mesh` inside every plane (distance >= 0) out into a new mesh; `mesh` keeps the rest
function cut(mesh, planes) {
  let inside = mesh.geometry; const rest = [];
  for (const p of planes) { rest.push(clipGeometry(inside, p.clone().negate())); inside = clipGeometry(inside, p); }
  const left = rest.filter(g => g.attributes.position.count);
  mesh.geometry = left.length ? mergeGeometries(left) : new THREE.BufferGeometry();
  const m = new THREE.Mesh(inside, mesh.material); m.name = mesh.name + ':cut';
  return m;
}
// the triangles of an indexed geometry, grouped into connected pieces (welded by position)
function pieces(g) {
  const pos = g.attributes.position, idx = g.index ? g.index.array : Array.from({ length: pos.count }, (_, k) => k);
  const key = new Map(), par = [];
  const vid = (i) => { const k = pos.getX(i).toFixed(4) + ',' + pos.getY(i).toFixed(4) + ',' + pos.getZ(i).toFixed(4); let v = key.get(k); if (v === undefined) { v = par.length; key.set(k, v); par.push(v); } return v; };
  const find = (a) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
  const first = [];
  for (let t = 0; t < idx.length; t += 3) { const a = vid(idx[t]), b = vid(idx[t + 1]), c = vid(idx[t + 2]); first.push(a); par[find(a)] = find(b); par[find(b)] = find(c); }
  const groups = new Map();
  first.forEach((a, t) => { const r = find(a); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); });
  const v = new THREE.Vector3();
  return [...groups.values()].map(tris => {
    const list = [], box = new THREE.Box3();
    for (const t of tris) for (let k = 0; k < 3; k++) { list.push(idx[3 * t + k]); box.expandByPoint(v.fromBufferAttribute(pos, idx[3 * t + k])); }
    const geo = new THREE.BufferGeometry(); for (const [n, a] of Object.entries(g.attributes)) geo.setAttribute(n, a); geo.setIndex(list);
    return { geo, box, center: box.getCenter(new THREE.Vector3()) };
  });
}
// a pivot at p (model space) that `objs` hang from, turning about `axis` (its local +X), added to `parent`
function pivotAt(parent, p, axis, objs) {
  const pv = new THREE.Object3D(); pv.position.copy(p);
  if (axis) pv.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), axis.clone().normalize());
  const turn = new THREE.Object3D(); pv.add(turn); parent.add(pv); parent.updateMatrixWorld(true);
  for (const o of objs) { parent.add(o); parent.updateMatrixWorld(true); turn.attach(o); }
  return turn;
}

export async function loadMig21(url, cfg) {
  const gltf = await loadGltfJson(url);
  tagTextures(gltf);
  // into model space: nose +Z (the source's nose points -X), every mesh baked flat under the model
  const model = new THREE.Group();
  gltf.scene.rotation.y = Math.PI / 2; model.add(gltf.scene); model.updateMatrixWorld(true);
  const src = []; gltf.scene.traverse(o => { if (o.isMesh) src.push(o); });
  const M = {};                                              // baked meshes by 'node/mesh' name
  for (const o of src) {
    const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld);
    if (o.matrixWorld.determinant() < 0 && g.index) { const a = g.index.array; for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; } }
    const m = new THREE.Mesh(g, o.material); m.name = `${o.parent?.name}/${o.name}`;
    M[m.name] = m;
  }
  model.remove(gltf.scene);
  const get = (re) => Object.values(M).find(m => re.test(m.name));
  const all = (re) => Object.values(M).filter(m => re.test(m.name));
  for (const m of Object.values(M)) model.add(m);
  model.updateMatrixWorld(true);

  // ---- control surfaces, cut out of the airframe skin
  const hull = get(/^MIG-21\/Object_10$/);
  const below = plane([0, -1, 0], [0, -0.15, 0]), hingeZ = plane([0, 0, -1], [0, 0, -2.55]);
  const wingTE = plane([0, 0, 1], [0, 0, -3.15]);                // (no further back than the wing: the stabilators sit behind it at the same span)
  const s = {};
  for (const [side, sx] of [['L', 1], ['R', -1]]) {
    const P = (pl) => sx > 0 ? pl : mirror(pl);
    const flap = cut(hull, [P(plane([1, 0, 0], [0.64, 0, 0])), P(plane([-1, 0, 0], [2.06, 0, 0])), hingeZ, wingTE, below]);
    const ail = cut(hull, [P(plane([1, 0, 0], [2.06, 0, 0])), P(plane([-1, 0, 0], [3.45, 0, 0])), hingeZ, wingTE, below]);
    const stab = cut(hull, [P(plane([1, 0, 0], [0.6, 0, 0])), plane([0, 0, -1], [0, 0, -3.7]), below, plane([0, 1, 0], [0, -0.85, 0])]);
    // the hinge lines follow the wing's droop: from its root to its tip at that station
    const wingY = (x) => -0.5 - (Math.abs(x) - 0.6) * 0.075;
    s['flap' + side] = pivotAt(model, new THREE.Vector3(sx * 1.35, wingY(1.35), -2.55), new THREE.Vector3(sx, -0.075, 0).multiplyScalar(sx), [flap]);
    s['aileron' + side] = pivotAt(model, new THREE.Vector3(sx * 2.75, wingY(2.75), -2.55), new THREE.Vector3(sx, -0.075, 0).multiplyScalar(sx), [ail]);
    s['stab' + side] = pivotAt(model, new THREE.Vector3(sx * 1.2, -0.5, -5.2), new THREE.Vector3(1, 0, 0), [stab]);
  }
  // the anti-flutter rods on the stabilator tips go with them
  const steel = get(/^MIG-21\/Object_13$/);
  for (const [side, sx] of [['L', 1], ['R', -1]]) {
    const rod = cut(steel, [sx > 0 ? plane([1, 0, 0], [1.5, 0, 0]) : mirror(plane([1, 0, 0], [1.5, 0, 0]))]);
    s['stab' + side].attach(rod);
  }
  // rudder: behind a hinge line 0.45 m ahead of the fin's trailing edge (top 1.886/-7.08, root 0.249/-5.786), above
  // the fuselage and below the tip
  {
    const top = new THREE.Vector3(0, 1.886, -7.08), root = new THREE.Vector3(0, 0.249, -5.786);
    const d = top.clone().sub(root).normalize(), n = new THREE.Vector3(0, d.z, -d.y);   // n: across the fin, aft
    const h0 = root.clone().addScaledVector(n, -0.45);
    const rud = cut(hull, [new THREE.Plane().setFromNormalAndCoplanarPoint(n, h0), plane([0, 1, 0], [0, 0.4, 0]), plane([0, -1, 0], [0, 1.72, 0]), plane([1, 0, 0], [-0.15, 0, 0]), plane([-1, 0, 0], [0.15, 0, 0])]);
    // a pivot whose local +Y runs up the hinge line (the rudder turns about its own Y, as the F-5's does)
    const pv = new THREE.Object3D(); pv.position.copy(h0); pv.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    const turn = new THREE.Object3D(); pv.add(turn); model.add(pv); model.updateMatrixWorld(true); turn.attach(rud);
    s.rudder = turn;
  }
  // canopy: hinged along its right-hand sill (the pilot's right, -X), it swings up and over to the right; the
  // windscreen stays
  const canopyBits = [];
  for (const m of all(/^fishbed_cockpit\//)) canopyBits.push(cut(m, [plane([0, 0, -1], [0, 0, 3.47])]));
  const canopy = pivotAt(model, new THREE.Vector3(-0.3, 0.24, 3.05), new THREE.Vector3(0, 0, 1), canopyBits);   // + rotation: opens to the right

  // ---- the damage model's parts (what's left of the skin); the surfaces ride on theirs
  splitAirframe(model, s, REGIONS.mig21);
  const R = REGIONS.mig21;
  const partAt = (p) => { const n = classify(p, R); return model.getObjectByName('part:' + n) || null; };
  // everything else hangs where it sits: split into its pieces, each onto the part under it (pylons, fairings, the
  // pitot boom, the nozzle...)
  model.updateMatrixWorld(true);
  for (const m of all(/^(fishbed_adds_1|fishbed_adds_2|fishbed_pylons)\/|^MIG-21\/Object_1[1-4]$/)) {
    if (/Object_11$/.test(m.name)) continue;                 // (the intake cone: see below)
    const byPart = new Map();
    for (const pc of pieces(m.geometry)) { const P = partAt(pc.center); const k = P ? P.name : ''; if (!byPart.has(k)) byPart.set(k, []); byPart.get(k).push(pc.geo); }
    m.removeFromParent();
    for (const [k, geos] of byPart) {
      const piece = new THREE.Mesh(geos.length > 1 ? mergeGeometries(geos.map(g => g.toNonIndexed())) : geos[0], m.material);
      piece.userData.noSplit = true;
      model.add(piece); model.updateMatrixWorld(true);
      if (k) model.getObjectByName(k).attach(piece);
    }
  }
  // the intake cone slides forward with Mach; it belongs to the nose
  const coneMesh = get(/^MIG-21\/Object_11$/); coneMesh.userData.noSplit = true;
  const cone = new THREE.Object3D(); model.add(cone); cone.attach(coneMesh);
  (model.getObjectByName('part:nose') || model).attach(cone);
  const coneBase = cone.position.clone();

  // ---- gear: main legs swing inward about a fore-and-aft hinge at their tops; the nose leg swings forward up into
  // the nose; the covers close under the belly
  const gear = { main: [], nose: null, doors: [] };
  const legParts = all(/^fishbed_back_wheels\//);
  for (const [side, sx] of [['L', 1], ['R', -1]]) {
    const bits = legParts.map(m => cut(m, [sx > 0 ? plane([1, 0, 0], [0, 0, 0]) : plane([-1, 0, 0], [0, 0, 0])]));
    const box = new THREE.Box3(); for (const b of bits) { b.geometry.computeBoundingBox(); box.union(b.geometry.boundingBox); }
    const top = new THREE.Vector3(sx * (Math.abs(sx > 0 ? box.min.x : box.max.x) + 0.04), box.max.y - 0.02, (box.min.z + box.max.z) / 2);
    const turn = pivotAt(model, top, new THREE.Vector3(0, 0, -sx), bits);  // + rotation: inward (toward the centreline)
    gear.main.push(turn);
    for (const b of bits) b.userData.noSplit = b.userData.noBulk = true;
    model.getObjectByName('part:wingInner' + side)?.attach(turn.parent);
  }
  for (const m of legParts) m.removeFromParent();
  {
    const bits = all(/^fishbed_front_wheel\//);
    const box = new THREE.Box3(); for (const b of bits) { b.geometry.computeBoundingBox(); box.union(b.geometry.boundingBox); }
    gear.nose = pivotAt(model, new THREE.Vector3(0, box.max.y - 0.02, (box.min.z + box.max.z) / 2), new THREE.Vector3(-1, 0, 0), bits);   // + rotation: swings forward
    for (const b of bits) b.userData.noSplit = b.userData.noBulk = true;
  }
  // covers: each hangs from its top edge (fore-and-aft hinge), closing inward under the belly
  for (const m of all(/^fishbed_covers\//)) {
    const mat = m.material.clone(); mat.side = THREE.DoubleSide;                     // (thin plates: seen from both sides)
    for (const pc of pieces(m.geometry)) {
      const sx = Math.sign(pc.center.x) || 1;
      const door = new THREE.Mesh(pc.geo, mat); door.userData.noSplit = door.userData.noBulk = true;
      // the hinge: along its top edge (the average of the vertices up there)
      const pos = pc.geo.attributes.position, idx = pc.geo.index.array, top = new THREE.Vector3(), v = new THREE.Vector3(); let n = 0;
      for (const k of idx) { v.fromBufferAttribute(pos, k); if (v.y > pc.box.max.y - 0.03) { top.add(v); n++; } }
      top.divideScalar(Math.max(n, 1)); top.z = pc.center.z;
      const turn = pivotAt(model, top, new THREE.Vector3(0, 0, -sx), [door]);        // + rotation: folds inward, up under the belly
      gear.doors.push({ turn, sx, len: pc.box.max.y - pc.box.min.y });
    }
    m.removeFromParent();
  }

  // ---- the jet's own short-range missiles: one is taken as the missile model (nose +Z, centred), the rest removed;
  // weapons.js hangs a copy on each station (inner and outer pylons)
  const msl = all(/^AIM-9_Sidewinder002\//);
  const missileProto = new THREE.Group();
  {
    const bits = msl.map(m => cut(m, [plane([1, 0, 0], [0, 0, 0])]));      // the left one
    const box = new THREE.Box3(); for (const b of bits) { b.geometry.computeBoundingBox(); box.union(b.geometry.boundingBox); }
    const c = box.getCenter(new THREE.Vector3());
    for (const b of bits) { b.geometry.translate(-c.x, -c.y, -c.z); b.material = b.material.clone(); missileProto.add(b); }
  }
  for (const m of msl) m.removeFromParent();
  // stations: the inner pylons carry the model's missiles; the outer ones a little further back and out
  const rails = [body(2.085, -0.925, -0.77), body(-2.085, -0.925, -0.77), body(2.68, -0.97, -1.55), body(-2.68, -0.97, -1.55)];

  // ---- the rest: the glow sheets and trails of the source are replaced by our own afterburner; clear canopy glass
  for (const m of all(/^glow002\//)) m.removeFromParent();
  model.traverse(o => {
    if (!o.isMesh) return;
    if (o.material.map) o.material.map.anisotropy = 4;
    if (/glass/.test(o.material.name)) o.material = new THREE.MeshStandardMaterial({ color: 0x0a0c0e, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.28, envMapIntensity: 2.2, depthWrite: false });
    if (!o.userData.hullPiece && !o.parent?.userData?.part) o.userData.noSplit = true;
  });
  const flame = afterburner(cfg.afterburner || 'diamonds');
  flame.group.position.copy(NOZZLE); flame.group.scale.set(NOZZLE_R / 0.2, NOZZLE_R / 0.2, 1.35);   // (twice the F-5 nozzle's width; the diamonds' spacing stretched less)
  model.add(flame.group); model.updateMatrixWorld(true);
  model.getObjectByName('part:tail')?.attach(flame.group);

  model.position.copy(CG).negate();
  const object = new THREE.Group().add(model);
  const SF = cfg.surfaces;
  const stabFullUp = Math.sin(SF.stabFullAoA * DEG) * cfg.pitchStability / cfg.pitchControl;
  const stabFullDown = Math.sin(SF.stabFullNegAoA * DEG) * cfg.pitchStability / cfg.pitchControl;
  let flapDeg = 0, coneZ = 0;
  return {
    object, model, setPaint: async () => {},
    cg: CG.clone(), nozzles: [NOZZLE], rails, missileProto,
    muzzles: [body(0.06, -0.98, 1.0), body(-0.06, -0.98, 1.0)],      // the twin-barrel cannon under the belly
    // ground contact (body frame, relative to the CG): wheels, airframe points (with the part each belongs to), wreck
    contacts: {
      wheels: [body(1.27, -2.04, -0.83), body(-1.27, -2.04, -0.83), body(0, -2.03, 3.87)],
      airframe: [[body(0, -0.4, 7.2), 'nose'], [body(0, -1.0, 1.0)], [body(0, -1.45, -3.9)], [body(0, -0.3, -6.4), 'tail'], [body(0, 0.62, 3.2), 'canopy'],
        [body(0, 1.9, -6.5), 'fin'], [body(3.5, -0.73, -2.7), 'wingOuterL'], [body(-3.5, -0.73, -2.7), 'wingOuterR'], [body(1.85, -0.5, -6.5), 'stabL'], [body(-1.85, -0.5, -6.5), 'stabR']],
      wreck: [[body(0, -0.4, 7.2), 'nose'], [body(0, -0.9, 4.6)], [body(0, -0.3, -6.4), 'tail'], [body(0, -1.45, -4.5), 'tail'], [body(0, -1.0, 1.0)], [body(0, -1.0, -2.5)], [body(0, 0.4, -3.0)],
        [body(0, 0.62, 3.2)], [body(0, 1.9, -6.5), 'fin'], [body(3.5, -0.73, -2.7), 'wingOuterL'], [body(-3.5, -0.73, -2.7), 'wingOuterR'],
        [body(1.5, -0.55, -1.5), 'wingInnerL'], [body(-1.5, -0.55, -1.5), 'wingInnerR'], [body(1.85, -0.5, -6.5), 'stabL'], [body(-1.85, -0.5, -6.5), 'stabR']],
    },
    animate(acReal, time = performance.now() / 1000) {
      const V = viewerAnim;
      if (V.active && V.cycle) {
        const t = performance.now() / 1000;
        V.pitch = Math.sin(t * 1.3); V.roll = Math.sin(t * 0.9 + 1); V.yaw = Math.sin(t * 1.1 + 2);
        V.engine = 1.05 + 0.05 * Math.sin(t * 0.7); V.mach = 1.1 + 0.9 * Math.sin(t * 0.4);
        V.gear = THREE.MathUtils.clamp(0.5 + 0.8 * Math.sin(t * 0.35), 0, 1); V.canopy = THREE.MathUtils.clamp(Math.sin(t * 0.25) * 1.5, 0, 1);
      }
      const ac = V.active ? { input: V, engine: V.engine, t: { ias: 100, mach: V.mach || 0 }, gear: V.gear } : acReal;
      const gearK = V.active ? V.gear : (acReal.gear || 0), canopyK = V.active ? V.canopy : 0;
      const i = ac.input;
      s.aileronL.rotation.x = -i.roll * SF.aileron * DEG;
      s.aileronR.rotation.x = i.roll * SF.aileron * DEG;
      const sp = V.active ? i.pitch : i.pitch > 0 ? i.pitch / stabFullUp : i.pitch / stabFullDown;
      s.stabL.rotation.x = s.stabR.rotation.x = THREE.MathUtils.clamp(sp, -1, 1) * (sp > 0 ? SF.stabUp : SF.stabDown) * DEG;
      s.rudder.rotation.y = i.yaw * SF.rudder * DEG;
      // flaps: only with the gear down (landing notches by airspeed: full below the first speed, half below the second)
      const kt = (ac.t?.ias || 0) * 1.944;
      const want = gearK > 0.5 ? (kt < SF.landFlapKt[0] ? 1 : kt < SF.landFlapKt[1] ? 0.5 : 0) * SF.teFlap : 0;
      flapDeg += THREE.MathUtils.clamp(want - flapDeg, -SF.flapRate / 60, SF.flapRate / 60);
      s.flapL.rotation.x = s.flapR.rotation.x = -flapDeg * DEG;
      // gear: covers open first, then the legs come down (the reverse going up); legs hidden once stowed
      const doorK = THREE.MathUtils.smoothstep(gearK, 0, 0.15), legK = THREE.MathUtils.smoothstep(gearK, 0.15, 1);
      for (const g of gear.main) { g.rotation.x = (1 - legK) * 88 * DEG; g.visible = gearK > 0.03; }
      gear.nose.rotation.x = (1 - legK) * 95 * DEG; gear.nose.visible = gearK > 0.03;
      for (const d of gear.doors) d.turn.rotation.x = (1 - doorK) * 88 * DEG;
      canopy.rotation.x = canopyK * 95 * DEG;
      // the intake cone: back below Mach 1.3, all the way forward (0.25 m) by Mach 1.9
      const want2 = 0.25 * THREE.MathUtils.smoothstep(ac.t?.mach || 0, 1.3, 1.9);
      coneZ += (want2 - coneZ) * 0.05; cone.position.z = coneBase.z + coneZ;
      const ab = THREE.MathUtils.clamp((ac.engine - 1) / 0.1, 0, 1), mil = THREE.MathUtils.clamp(ac.engine, 0, 1);
      flame.update(mil, ab, time);
    },
  };
}
