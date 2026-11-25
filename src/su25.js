import * as THREE from 'three';
import { loadGltfJson } from './gltf.js';
import { splitAirframe, REGIONS, classify } from './damage.js';
import { tagTextures } from './paint.js';
import { viewerAnim, clipGeometry } from './jet.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// The Su-25 (second player jet; dev kit only for now): the airframe as modelled (gear down for now), split into damage
// parts, no afterburner (it has none). Same interface as loadJet (jet.js).
// The model's surfaces are separate pieces of its one mesh: they're picked out by where they sit and hung on hinges
// along their own front edges: ailerons, inner and outer flaps, elevators (the stabilisers are fixed), the lower rudder,
// and the airbrakes (the rear of each wingtip pod splits into an upper and a lower petal).
// The source is built at about twice real size with its nose toward -Z: scaled and turned round here.
// Model space: +Z nose, +Y up, +X left wing (wheels on y = 0).
const CG = new THREE.Vector3(0, 1.9, -0.7);
const body = (x, y, z) => new THREE.Vector3(x, y, z).sub(CG);
REGIONS.su25 = { jag: 0.18, jagWings: true, noseZ: 4.0, tail: { z: -4.7 }, stab: { x: 0.45, y: 1.7, z: -5.2, yMax: 3.0 }, fin: { y: 3.0, z: -4.6 },
  outer: { x: 3.6, y: 2.6, z0: -4.2, z1: 1.4 }, inner: { x: 1.65, y: 2.6, z0: -4.2, z1: 1.4 } };   // (wing regions reach the pods' tails and the pylons' fronts)

// the triangles of an indexed geometry grouped into connected pieces (welded by position): { tris, box, center }
function pieces(g) {
  const pos = g.attributes.position, idx = g.index.array, key = new Map(), par = [];
  const vid = (i) => { const k = pos.getX(i).toFixed(4) + ',' + pos.getY(i).toFixed(4) + ',' + pos.getZ(i).toFixed(4); let v = key.get(k); if (v === undefined) { v = par.length; key.set(k, v); par.push(v); } return v; };
  const find = (a) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
  const first = [];
  for (let t = 0; t < idx.length; t += 3) { const a = vid(idx[t]), b = vid(idx[t + 1]), c = vid(idx[t + 2]); first.push(a); par[find(a)] = find(b); par[find(b)] = find(c); }
  const groups = new Map();
  first.forEach((a, t) => { const r = find(a); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); });
  const v = new THREE.Vector3();
  return [...groups.values()].map(tris => { const box = new THREE.Box3(); for (const t of tris) for (let k = 0; k < 3; k++) box.expandByPoint(v.fromBufferAttribute(pos, idx[3 * t + k])); return { tris, box, center: box.getCenter(new THREE.Vector3()) }; });
}
const subset = (g, tris) => { const ng = new THREE.BufferGeometry(); for (const [n, a] of Object.entries(g.attributes)) ng.setAttribute(n, a); const idx = g.index.array, l = []; for (const t of tris) l.push(idx[3 * t], idx[3 * t + 1], idx[3 * t + 2]); ng.setIndex(l); return ng; };
// a hinge along a piece's front edge: at each end of its span (along x, or y for the rudder), the most forward vertex
function hingeOf(g, tris, along) {
  const pos = g.attributes.position, idx = g.index.array, v = new THREE.Vector3(), pts = [];
  for (const t of tris) for (let k = 0; k < 3; k++) pts.push(v.fromBufferAttribute(pos, idx[3 * t + k]).clone());
  const a = along === 'y' ? 'y' : 'x', vals = pts.map(p => Math.abs(p[a])), lo = Math.min(...vals), hi = Math.max(...vals), band = (hi - lo) * 0.15;
  const end = (near) => { const sel = pts.filter(p => Math.abs(Math.abs(p[a]) - near) <= band); const zMax = Math.max(...sel.map(p => p.z)); const f = sel.filter(p => p.z > zMax - 0.03); return f.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(f.length); };
  const A = end(lo), B = end(hi), axis = B.clone().sub(A).normalize();
  if (along === 'y' ? axis.y < 0 : axis.x < 0) axis.negate();
  return { at: A, axis };
}
function pivotOn(model, at, axis, mesh) {
  const pv = new THREE.Object3D(); pv.position.copy(at); pv.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), axis);
  const turn = new THREE.Object3D(); pv.add(turn); model.add(pv); model.add(mesh); model.updateMatrixWorld(true); turn.attach(mesh);
  return turn;
}

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
  // into model space: the airframe mesh baked flat under the model
  let hull = null; model.traverse(o => { if (o.isMesh && o.material.name !== 'Glass' && (!hull || o.geometry.index.count > hull.geometry.index.count)) hull = o; });
  { const g = hull.geometry.clone(); g.applyMatrix4(hull.matrixWorld); hull.geometry = g; hull.removeFromParent(); hull.position.set(0, 0, 0); hull.rotation.set(0, 0, 0); hull.scale.set(1, 1, 1); model.add(hull); }
  let glassMesh = null; model.traverse(o => { if (o.isMesh && o !== hull && o.userData.noSplit) glassMesh = o; });
  if (glassMesh) { const gg = glassMesh.geometry.clone(); gg.applyMatrix4(glassMesh.matrixWorld); glassMesh.geometry = gg; glassMesh.removeFromParent(); glassMesh.position.set(0, 0, 0); glassMesh.rotation.set(0, 0, 0); glassMesh.scale.set(1, 1, 1); model.add(glassMesh); }
  // the surfaces: pieces of the mesh picked out by size and place (measured), each taken out of the skin onto its hinge
  const g = hull.geometry, comps = pieces(g), taken = new Set(), s = {}, extra = [];
  const pick = (test) => comps.filter(c => !taken.has(c) && test(c, Math.abs(c.center.x), c.box.max.x - c.box.min.x));
  const take = (name, c, along = 'x') => {
    taken.add(c);
    const mesh = new THREE.Mesh(subset(g, c.tris), hull.material); mesh.userData.noSplit = true; mesh.name = name;
    const h = hingeOf(g, c.tris, along);
    return pivotOn(model, h.at, h.axis, mesh);
  };
  const side = (c) => c.center.x > 0 ? 'L' : 'R', elevComps = {}, brakeComps = [];
  for (const c of pick((c, ax, w) => c.tris.length > 90 && ax > 4.3 && ax < 6.6 && c.center.z < -2.3 && c.center.z > -3.1 && w > 1.5)) s['aileron' + side(c)] = take('aileron', c);
  for (const c of pick((c, ax, w) => c.tris.length > 40 && ax > 2.8 && ax < 4.4 && c.center.z < -2.3 && c.center.z > -3.1 && w > 1.3)) extra.push(['flapOuter' + side(c), take('flapOuter', c)]);
  for (const c of pick((c, ax, w) => c.tris.length > 20 && ax > 1.3 && ax < 2.8 && c.center.z < -2.3 && c.center.z > -3.1 && w > 1.2)) s['flap' + side(c)] = take('flap', c);
  for (const c of pick((c, ax, w) => c.tris.length > 150 && ax > 0.25 && ax < 2.4 && c.center.z < -6.5 && w > 1.8)) { elevComps[side(c)] = c; s['stab' + side(c)] = take('elevator', c); }
  for (const c of pick((c, ax) => c.tris.length > 140 && c.tris.length < 175 && ax < 0.06 && c.center.z < -6 && c.center.y > 2.5 && c.center.y < 3.3)) s.rudder = take('rudder', c, 'y');
  const brakes = [];
  for (const sd of ['L', 'R']) {
    const pair = pick((c, ax) => c.tris.length > 90 && c.tris.length < 115 && ax > 6.7 && c.center.z < -2.7 && c.center.z > -3.5 && side(c) === sd).sort((a, b) => b.center.y - a.center.y);
    pair.forEach((c, k) => { const t = take('airbrake', c); brakes.push({ t, up: k === 0 ? 1 : -1, side: sd }); brakeComps.push([c, t]); });
  }
  // what's left: the skin (by far the biggest piece) is cut up for the damage parts; everything else (pylons, fairings,
  // the fixed stabilisers, pod and gear bits) stays whole and rides whichever part it sits on
  const rest = comps.filter(c => !taken.has(c)).sort((a, b) => b.tris.length - a.tris.length);
  const skin = rest[0], bits = rest.slice(1);
  // small pieces that belong to a moving surface ride its hinge: each elevator's trim tab and tip fairing (on its
  // trailing edge / outer end), and the rods at the back of each airbrake petal (with the petal at the same height)
  {
    const ride = (c, turn) => { const m = new THREE.Mesh(subset(g, c.tris), hull.material); m.userData.noSplit = m.userData.noBulk = true; model.add(m); model.updateMatrixWorld(true); turn.attach(m); bits.splice(bits.indexOf(c), 1); };
    for (const sd of ['L', 'R']) {
      const e = elevComps[sd]; if (!e) continue;
      const near = e.box.clone().expandByScalar(0.06);
      for (const c of bits.slice()) if (c.tris.length < 60 && side(c) === sd && near.intersectsBox(c.box) && c.center.z < e.box.max.z - 0.1) ride(c, s['stab' + sd]);
    }
    for (const c of bits.slice()) {
      if (c.tris.length >= 30 || Math.abs(c.center.x) < 6.7 || c.box.max.z > -3.35 || c.box.min.z < -3.9) continue;
      const mine = brakeComps.filter(([b]) => side(b) === side(c)).sort((a, b) => Math.abs(a[0].center.y - c.center.y) - Math.abs(b[0].center.y - c.center.y))[0];
      if (mine) ride(c, mine[1]);
    }
  }
  // the pylons (thin vertical blades under the wing): the two outermost a side carry missiles, the next two rocket pods
  const pylons = bits.filter(c => c.tris.length >= 50 && c.tris.length <= 70 && c.box.max.x - c.box.min.x < 0.12 && Math.abs(c.center.x) > 1.9 && c.box.max.y - c.box.min.y < 0.45)
    .sort((a, b) => Math.abs(b.center.x) - Math.abs(a.center.x));
  const station = (c) => new THREE.Vector3(c.center.x, c.box.min.y - 0.075, c.center.z);     // hung just under the pylon
  const bySide = (sx) => pylons.filter(c => Math.sign(c.center.x) === sx);
  const railPts = [0, 1].flatMap(k => [bySide(1)[k], bySide(-1)[k]]).filter(Boolean).map(station);
  const podPts = [2, 3].flatMap(k => [bySide(1)[k], bySide(-1)[k]]).filter(Boolean).map(station);
  // ---- canopy: its frame pieces and the glass aft of the windscreen, hinged along the right-hand sill (the pilot's
  // right, -X): it tilts over to the right, the way in being from the left
  const canopyFrame = bits.filter(c => c.center.y > 2.4 && c.center.z > 2.2 && c.center.z < 3.15 && Math.abs(c.center.x) < 0.5 && c.tris.length >= 40 && c.tris.length <= 90);
  const canopyMeshes = canopyFrame.map(c => new THREE.Mesh(subset(g, c.tris), hull.material));
  if (glassMesh) {
    const cut = clipGeometry(glassMesh.geometry, new THREE.Plane(new THREE.Vector3(0, 0, -1), 3.12));   // (z <= 3.12)
    glassMesh.geometry = clipGeometry(glassMesh.geometry, new THREE.Plane(new THREE.Vector3(0, 0, 1), -3.12));
    canopyMeshes.push(new THREE.Mesh(cut, glassMesh.material));
  }
  const cbox = new THREE.Box3(); for (const c of canopyFrame) cbox.union(c.box);
  const canopy = pivotOn(model, new THREE.Vector3(cbox.min.x, cbox.min.y, (cbox.min.z + cbox.max.z) / 2), new THREE.Vector3(0, 0, 1), canopyMeshes[0] || new THREE.Object3D());
  for (const m of canopyMeshes.slice(1)) { model.add(m); model.updateMatrixWorld(true); canopy.attach(m); }
  for (const m of canopyMeshes) m.userData.noSplit = m.userData.noBulk = true;

  // ---- gear (modelled down): the main legs fold forward into the nacelles, the nose leg forward into the nose; the
  // doors hanging beside them close flush once the legs are up; the big forward nose door (closed in the skin when the
  // gear is down) is cut out of the skin and swings open only while the gear is moving
  const inGear = (c) => (c.box.max.y < 1.5 && Math.abs(c.center.x) > 0.25 && Math.abs(c.center.x) < 1.5 && c.center.z > -1.7 && c.center.z < 0.35) || (c.box.max.y < 1.8 && c.box.min.y < 1.2 && Math.abs(c.center.x) < 0.3 && c.center.z > 1.6 && c.center.z < 3.2);   // (the nose leg's upper strut reaches up into the nose)
  const gearComps = bits.filter(c => inGear(c) && !pylons.includes(c));
  const isDoor = (c) => { const sz = c.box.getSize(new THREE.Vector3()); return c.tris.length < 130 && Math.min(sz.x, sz.y, sz.z) < 0.06 && Math.max(sz.x, sz.y, sz.z) > 0.45; };
  const vertsOf = (c) => { const pos = g.attributes.position, idx = g.index.array, out = []; for (const t of c.tris) for (let k = 0; k < 3; k++) out.push(new THREE.Vector3().fromBufferAttribute(pos, idx[3 * t + k])); return out; };
  const gearRig = { legs: [], doors: [], noseDoor: null };
  // the main bays' doors (hanging open as modelled, curved so no simple thinness test finds them): per bay a long
  // outboard one and two inboard ones (front and rear), picked by size
  const isPlate = (c) => [92, 88, 72].includes(c.tris.length) && c.box.max.z - c.box.min.z > 0.7;
  const groups = [['L', (c) => c.center.x > 0.25 && c.center.z < 0.35, 0.78, isPlate], ['R', (c) => c.center.x < -0.25 && c.center.z < 0.35, -0.78, isPlate], ['N', (c) => Math.abs(c.center.x) < 0.3 && c.center.z > 1.8, 0, isDoor]];
  for (const [nm, test, cx, doorTest] of groups) {
    const mine = gearComps.filter(test); if (!mine.length) continue;
    const legs = mine.filter(c => !doorTest(c)), doors = mine.filter(doorTest);
    // folding: the leg swings forward 90 degrees about a hinge chosen (searched) so the wheel comes to rest at a
    // measured spot inside: the main wheels lying flat in their bays (the leg also turns 90 degrees about its own
    // axis), the nose wheel under the cockpit floor
    const strut = legs.slice().sort((a, b) => (b.box.max.y - b.box.min.y) - (a.box.max.y - a.box.min.y))[0];
    const topVs = vertsOf(strut).filter(v => v.y > strut.box.max.y - 0.04), top = topVs.reduce((s, v) => s.add(v), new THREE.Vector3()).divideScalar(topVs.length);
    const legMesh = new THREE.Mesh(subset(g, legs.flatMap(c => c.tris)), hull.material); legMesh.userData.noSplit = legMesh.userData.noBulk = true;
    const wheel = legs.slice().sort((a, b) => b.tris.length - a.tris.length)[0].center;
    const main = nm !== 'N', sx = Math.sign(cx) || 1, R90 = Math.PI / 2;
    const target = main ? new THREE.Vector3(sx * 0.6, 1.45, -0.5) : new THREE.Vector3(0, 1.62, 3.05);
    const foot = wheel.clone().setX(top.x);
    let best = null;
    for (let hy = 0.9; hy <= 1.9; hy += 0.05) for (let hz = wheel.z - 1.2; hz <= wheel.z + 0.6; hz += 0.05) for (let yaw = main ? -30 : 0; yaw <= (main ? 30 : 0); yaw += 5) for (const sg of main ? [1, -1] : [0]) {
      const H = new THREE.Vector3(top.x, hy, hz), legAxis = foot.clone().sub(H).normalize(), fold = new THREE.Vector3(Math.cos(yaw * Math.PI / 180), 0, Math.sin(yaw * Math.PI / 180));
      const F = wheel.clone().sub(H).applyAxisAngle(legAxis, sg * R90).applyAxisAngle(fold, -R90).add(H), d = F.distanceTo(target);
      if (!best || d < best.d) best = { d, H, legAxis, fold, sg };
    }
    const { H: hinge, legAxis, fold, sg } = best, X = new THREE.Vector3(1, 0, 0);
    if (!main) gearRig.legs.push({ turn: pivotOn(model, hinge, fold, legMesh), max: 90 });
    else {
      // (only the lower leg, the wheel and its fork, turns; the upper strut and the braces just fold)
      const low = legs.filter(c => c.center.y < 0.7), up = legs.filter(c => c.center.y >= 0.7);
      legMesh.geometry = subset(g, low.flatMap(c => c.tris));
      const tw = new THREE.Object3D(); tw.position.copy(hinge); tw.quaternion.setFromUnitVectors(X, legAxis);
      const twist = new THREE.Object3D(); tw.add(twist); model.add(tw); model.add(legMesh); model.updateMatrixWorld(true); twist.attach(legMesh);
      const turn = pivotOn(model, hinge, fold, tw);
      let um = null;
      if (up.length) { um = new THREE.Mesh(subset(g, up.flatMap(c => c.tris)), hull.material); um.userData.noSplit = um.userData.noBulk = true; model.add(um); model.updateMatrixWorld(true); turn.attach(um); }
      gearRig.legs.push({ turn, max: 90, twist, twistMax: sg * 90, upper: um });
    }
    // each door: hinged along its top edge, closing to lie flat toward the middle of its bay
    for (const c of doors) {
      const vs = vertsOf(c), topY = c.box.max.y, edge = vs.filter(v => v.y > topY - 0.03);
      const at = edge.reduce((s, v) => s.add(v), new THREE.Vector3()).divideScalar(edge.length);
      const ex = Math.max(...edge.map(v => v.x)) - Math.min(...edge.map(v => v.x)), ez = Math.max(...edge.map(v => v.z)) - Math.min(...edge.map(v => v.z));
      const axis = ez >= ex ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
      const cen = c.center.clone().sub(at), q = new THREE.Quaternion(), r = new THREE.Vector3();
      let best = 0, bestScore = -1e9;
      for (let a = -150; a <= 150; a += 2) {
        r.copy(cen).applyQuaternion(q.setFromAxisAngle(axis, a * Math.PI / 180));
        if (r.y > 0.02) continue;                                    // (never up into the airframe)
        const score = r.y * 4 - Math.abs(at.x + r.x - cx) * 0.5 - Math.abs(a) * 0.002;   // flat, toward the bay's middle, the short way
        if (score > bestScore) { bestScore = score; best = a; }
      }
      const dm = new THREE.Mesh(subset(g, c.tris), hull.material); dm.userData.noSplit = dm.userData.noBulk = true;
      const turn = pivotOn(model, at, axis, dm);
      gearRig.doors.push({ turn, close: best * Math.PI / 180 / (axis.x ? 1 : 1) });
    }
  }
  // the big forward nose door: a panel of the skin ahead of the nose leg, where the wheel goes when it folds forward
  const skinGeo = subset(g, skin.tris).toNonIndexed();
  {
    const box = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 0.22), new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0.22), new THREE.Plane(new THREE.Vector3(0, 0, 1), -2.88),
      new THREE.Plane(new THREE.Vector3(0, 0, -1), 3.72), new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.25)];   // |x| < 0.22, 2.88 < z < 3.72, y < 1.25
    let door = skinGeo; const rest = [];
    for (const pl of box) { rest.push(clipGeometry(door, pl.clone().negate())); door = clipGeometry(door, pl); }
    if (door.attributes.position.count) {
      hull.userData.skinRest = mergeGeometries(rest.filter(x => x.attributes.position.count));
      const dm = new THREE.Mesh(door, hull.material); dm.userData.noSplit = dm.userData.noBulk = true;
      door.computeBoundingBox(); const b = door.boundingBox;
      gearRig.noseDoor = pivotOn(model, new THREE.Vector3(b.max.x, b.max.y, (b.min.z + b.max.z) / 2), new THREE.Vector3(0, 0, 1), dm);   // hinged on its left edge
    }
  }
  const usedGear = new Set([...gearComps, ...canopyFrame]);
  for (let k = bits.length - 1; k >= 0; k--) if (usedGear.has(bits[k])) bits.splice(k, 1);
  hull.geometry = hull.userData.skinRest || skinGeo; delete hull.userData.skinRest;
  // ragged breaks: along each damage line, a narrow band of the skin is cut into small cells which the split assigns to
  // one side or the other with a blocky jitter (REGIONS.su25.jag / jagWings), so a break tears instead of slicing
  // (the skin's long thin wing triangles would otherwise leave slivers, or a ruler-straight edge)
  {
    const R = REGIONS.su25;
    const P = (axis, v, sign = 1) => { const n = new THREE.Vector3(); n[axis] = sign; return new THREE.Plane(n, -sign * v); };   // keeps sign * (p - v) >= 0
    const merge = (list) => { const l = list.filter(x => x.attributes.position.count); return l.length > 1 ? mergeGeometries(l) : l[0] || list[0]; };
    // (only the triangles that reach into the band are cut: the rest go straight across)
    const AX = { x: 0, y: 1, z: 2 };
    const pick = (geo, keep) => { const sub = new THREE.BufferGeometry(); for (const [n, at] of Object.entries(geo.attributes)) sub.setAttribute(n, at); sub.setIndex(keep); return sub.toNonIndexed(); };
    const ragged = (geo, axis, at, cells) => {
      const lo = P(axis, at - 0.35), hi = P(axis, at + 0.35, -1), pa = geo.attributes.position.array, o = AX[axis], far = [], near = [];
      for (let k = 0; k < pa.length / 9; k++) {
        const a = pa[k * 9 + o], b = pa[k * 9 + 3 + o], c = pa[k * 9 + 6 + o], mn = Math.min(a, b, c), mx = Math.max(a, b, c);
        (mx < at - 0.35 || mn > at + 0.35 ? far : near).push(3 * k, 3 * k + 1, 3 * k + 2);
      }
      const touching = pick(geo, near), inLo = clipGeometry(touching, lo);
      const outside = [pick(geo, far), clipGeometry(touching, lo.clone().negate()), clipGeometry(inLo, hi.clone().negate())];
      let band = clipGeometry(inLo, hi);
      for (const [ax, from, to, step] of [[axis, at - 0.24, at + 0.24, 0.12], ...cells]) for (let v = from; v <= to + 1e-6; v += step) {
        const pl = P(ax, v); band = merge([clipGeometry(band, pl), clipGeometry(band, pl.clone().negate())]);
      }
      return merge([...outside, band]);
    };
    let geo = hull.geometry.index ? hull.geometry.toNonIndexed() : hull.geometry;
    for (const sx of [1, -1]) for (const X of [R.outer.x, R.inner.x]) geo = ragged(geo, 'x', sx * X, [['z', -4.2, 1.4, 0.28]]);
    for (const Z of [R.noseZ, R.tail.z]) geo = ragged(geo, 'z', Z, [['x', -1.0, 1.0, 0.25], ['y', 0.8, 3.4, 0.25]]);
    geo = ragged(geo, 'y', R.fin.y, [['z', -7.6, -4.0, 0.28]]);
    hull.geometry = geo;
  }
  model.userData.toughness = 2.2;                   // (armoured: parts and fuselage take ~2.2x the hits; collisions and hard
                                                    // landings it can survive scale with it too: weapons.js, ground.js)
  splitAirframe(model, s, REGIONS.su25);
  model.updateMatrixWorld(true);
  // the stabilisers are fixed (separate pieces) and the elevators hinge on them: a stabiliser part holds both
  for (const sd of ['L', 'R']) {
    const e = s['stab' + sd]; if (!e || !e.userData.part) continue;
    delete e.userData.part; e.name = 'elevator' + sd;
    const P = new THREE.Group(); P.name = 'part:stab' + sd; P.userData.part = 'stab' + sd;
    P.position.copy(e.parent.getWorldPosition(new THREE.Vector3())); model.add(P); model.updateMatrixWorld(true); P.attach(e.parent);
  }
  // the whole pieces onto the parts they sit on (one mesh per part)
  {
    const R = REGIONS.su25, byPart = new Map();
    for (const c of bits) { const n = classify(c.center, R); const k = model.getObjectByName('part:' + n) ? n : ''; if (!byPart.has(k)) byPart.set(k, []); byPart.get(k).push(subset(g, c.tris).toNonIndexed()); }
    for (const [k, geos] of byPart) {
      const m = new THREE.Mesh(geos.length > 1 ? mergeGeometries(geos) : geos[0], hull.material); m.userData.noSplit = true; m.name = 'bits' + (k ? ':' + k : '');
      model.add(m); model.updateMatrixWorld(true);
      if (k) model.getObjectByName('part:' + k).attach(m);
    }
  }
  // what splitAirframe doesn't hang by itself: the outer flaps and the airbrakes ride their wing parts
  // the outer flaps straddle the outer wing's break line: cut there, the outer end rides the outer wing (on the same
  // hinge), so a lost outer wing doesn't leave a stub of flap hanging past the break
  for (const [n, t] of extra.slice()) {
    const sd = n.slice(-1), sx = sd === 'L' ? 1 : -1, X = REGIONS.su25.outer.x, mesh = t.children[0], geo = mesh.geometry.toNonIndexed();
    const outerGeo = clipGeometry(geo, new THREE.Plane(new THREE.Vector3(sx, 0, 0), -X)), innerGeo = clipGeometry(geo, new THREE.Plane(new THREE.Vector3(-sx, 0, 0), X));
    mesh.geometry = innerGeo;
    if (outerGeo.attributes.position.count) {
      const pv = t.parent.clone(true), ot = pv.children[0]; ot.children[0].geometry = outerGeo;
      model.add(pv); model.updateMatrixWorld(true);
      model.getObjectByName('part:wingOuter' + sd)?.attach(pv); extra.push([n + 'tip', ot]);
    }
    model.getObjectByName('part:wingInner' + sd)?.attach(t.parent);
  }
  for (const b of brakes) model.getObjectByName('part:wingOuter' + b.side)?.attach(b.t.parent);
  model.position.copy(CG).negate();
  const object = new THREE.Group().add(model);
  const SFc = cfg.surfaces, DEG = Math.PI / 180;
  const stabFullUp = Math.sin(SFc.stabFullAoA * DEG) * cfg.pitchStability / cfg.pitchControl;
  const stabFullDown = Math.sin(SFc.stabFullNegAoA * DEG) * cfg.pitchStability / cfg.pitchControl;
  let flapDeg = 0;
  const nozzles = [new THREE.Vector3(0.8, 1.3, -4.5), new THREE.Vector3(-0.8, 1.3, -4.5)];
  return { gearRig,
    object, model, setPaint: async () => {},
    cg: CG.clone(), nozzles,
    rails: railPts.map(p => p.clone().sub(CG)),                                  // the two outermost pylons a side (measured from the pylons)
    podStations: podPts.map(p => p.clone().sub(CG)),                             // the next two in: rocket pods
    muzzles: [body(0.35, 1.45, 4.3), body(0.25, 1.45, 4.3)],                     // the twin 30 mm, low on the left of the nose
    contacts: {
      wheels: [body(1.26, 0.05, -1.14), body(-1.26, 0.05, -1.14), body(0, 0.05, 2.3)],
      airframe: [[body(0, 1.8, 6.0), 'nose'], [body(0, 1.0, 0.5)], [body(0, 1.3, -4.0)], [body(0, 2.0, -8.0), 'tail'], [body(0, 2.9, 3.0), 'canopy'],
        [body(0, 4.6, -7.1), 'fin'], [body(7.0, 1.9, -2.0), 'wingOuterL'], [body(-7.0, 1.9, -2.0), 'wingOuterR'], [body(2.3, 2.3, -6.3), 'stabL'], [body(-2.3, 2.3, -6.3), 'stabR']],
      wreck: [[body(0, 1.8, 6.0), 'nose'], [body(0, 1.2, 3.5)], [body(0, 2.0, -8.0), 'tail'], [body(0, 1.3, -5.5), 'tail'], [body(0, 1.0, 0.5)], [body(0, 1.1, -2.5)], [body(0, 2.9, -2.0)],
        [body(0, 2.9, 3.0)], [body(0, 4.6, -7.1), 'fin'], [body(7.0, 1.9, -2.0), 'wingOuterL'], [body(-7.0, 1.9, -2.0), 'wingOuterR'],
        [body(2.6, 1.9, -1.5), 'wingInnerL'], [body(-2.6, 1.9, -1.5), 'wingInnerR'], [body(2.3, 2.3, -6.3), 'stabL'], [body(-2.3, 2.3, -6.3), 'stabR']],
    },
    // where the effects come from (model space): wing vapour over the wing, vortices off the wingtip pods, the collar, the contrail
    fx: { wing: { x0: 1.7, x1: 6.5, y: 2.0, le: (x) => 0.25 - 0.3 * (x - 1.6), chord: 1.5, outerX: 3.6 }, tips: [[7.0, 1.87, -3.1], [-7.0, 1.87, -3.1]],
      collar: { y: 2.0, z0: 3.0 }, contrail: [0, 1.3, -4.8] },
    animate(acReal, time = performance.now() / 1000) {
      const V = viewerAnim;
      if (V.active && V.cycle) {
        const t = performance.now() / 1000;
        V.pitch = Math.sin(t * 1.3); V.roll = Math.sin(t * 0.9 + 1); V.yaw = Math.sin(t * 1.1 + 2); V.airbrake = 0.5 + 0.5 * Math.sin(t * 0.5);
      }
      const ac = V.active ? { input: V, airbrake: V.airbrake, t: { aoa: V.aoa, ias: 100 }, gear: V.gear } : acReal;
      const i = ac.input, SF = cfg.surfaces;
      s.aileronL && (s.aileronL.rotation.x = -i.roll * SF.aileron * DEG);
      s.aileronR && (s.aileronR.rotation.x = i.roll * SF.aileron * DEG);
      const sp = V.active ? i.pitch : i.pitch > 0 ? i.pitch / stabFullUp : i.pitch / stabFullDown;
      for (const e of [s.stabL, s.stabR]) if (e) e.rotation.x = THREE.MathUtils.clamp(sp, -1, 1) * (sp > 0 ? SF.stabUp : SF.stabDown) * DEG;
      if (s.rudder) s.rudder.rotation.x = i.yaw * SF.rudder * DEG;
      // flaps: out with angle of attack at lower speeds, and to their landing notches with the gear down (as the F-5's)
      const kt = (ac.t?.ias || 0) * 1.944, aoa = ac.t?.aoa || 0, gear = ac.gear || 0;
      let k = THREE.MathUtils.smoothstep(aoa, SF.flapAoA[0], SF.flapAoA[1]) * (1 - THREE.MathUtils.smoothstep(kt, SF.flapKt[0], SF.flapKt[1]));
      if (gear > 0.5) k = Math.max(k, kt < SF.landFlapKt[0] ? 1 : kt < SF.landFlapKt[1] ? 0.5 : 0);
      flapDeg += THREE.MathUtils.clamp(SF.teFlap * k - flapDeg, -SF.flapRate / 60, SF.flapRate / 60);
      for (const f of [s.flapL, s.flapR, ...extra.map(e => e[1])]) if (f) f.rotation.x = -flapDeg * DEG;
      // gear: the doors open first, then the legs come down (the reverse going up); the forward nose door only while
      // the gear is moving
      const gk = V.active ? (V.gear ?? 1) : (acReal.gear || 0);
      const doorK = THREE.MathUtils.smoothstep(gk, 0, 0.15), legK = THREE.MathUtils.smoothstep(gk, 0.15, 1);
      for (const l of gearRig.legs) {
        l.turn.rotation.x = -(1 - legK) * l.max * DEG; l.turn.visible = gk > 0.02;
        if (l.upper) l.upper.visible = legK > 0.35;   // (folded that far, the upper strut is buried in the nacelle but for its tip)
        if (l.twist) l.twist.rotation.x = (1 - THREE.MathUtils.smoothstep(legK, 0.25, 0.9)) * l.twistMax * DEG;   // (turned flat early in the fold)
      }
      for (const d of gearRig.doors) d.turn.rotation.x = d.close * (1 - doorK);
      if (gearRig.noseDoor) gearRig.noseDoor.rotation.x = -85 * DEG * THREE.MathUtils.smoothstep(gk, 0.02, 0.15) * (1 - THREE.MathUtils.smoothstep(gk, 0.85, 0.98));
      canopy.rotation.x = (V.active ? V.canopy || 0 : acReal.canopy || 0) * 70 * DEG;
      // airbrakes: the petals split, upper up and lower down
      for (const b of brakes) b.t.rotation.x = b.up * (ac.airbrake || 0) * 55 * DEG;
    },
  };
}
