import * as THREE from 'three';
import { loadGltfJson } from './gltf.js';
import { splitAirframe, REGIONS } from './damage.js';
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
REGIONS.su25 = { jag: 0.03, noseZ: 4.0, tail: { z: -4.7 }, stab: { x: 0.45, y: 1.7, z: -5.2, yMax: 3.0 }, fin: { y: 3.0, z: -4.6 },
  outer: { x: 3.6, y: 2.6, z0: -3.6, z1: 0.8 }, inner: { x: 1.65, y: 2.6, z0: -3.6, z1: 1.2 } };

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
  // the surfaces: pieces of the mesh picked out by size and place (measured), each taken out of the skin onto its hinge
  const g = hull.geometry, comps = pieces(g), taken = new Set(), s = {}, extra = [];
  const pick = (test) => comps.filter(c => !taken.has(c) && test(c, Math.abs(c.center.x), c.box.max.x - c.box.min.x));
  const take = (name, c, along = 'x') => {
    taken.add(c);
    const mesh = new THREE.Mesh(subset(g, c.tris), hull.material); mesh.userData.noSplit = true; mesh.name = name;
    const h = hingeOf(g, c.tris, along);
    return pivotOn(model, h.at, h.axis, mesh);
  };
  const side = (c) => c.center.x > 0 ? 'L' : 'R';
  for (const c of pick((c, ax, w) => c.tris.length > 90 && ax > 4.3 && ax < 6.6 && c.center.z < -2.3 && c.center.z > -3.1 && w > 1.5)) s['aileron' + side(c)] = take('aileron', c);
  for (const c of pick((c, ax, w) => c.tris.length > 40 && ax > 2.8 && ax < 4.4 && c.center.z < -2.3 && c.center.z > -3.1 && w > 1.3)) extra.push(['flapOuter' + side(c), take('flapOuter', c)]);
  for (const c of pick((c, ax, w) => c.tris.length > 20 && ax > 1.3 && ax < 2.8 && c.center.z < -2.3 && c.center.z > -3.1 && w > 1.2)) s['flap' + side(c)] = take('flap', c);
  for (const c of pick((c, ax, w) => c.tris.length > 150 && ax > 0.25 && ax < 2.4 && c.center.z < -6.5 && w > 1.8)) s['stab' + side(c)] = take('elevator', c);
  for (const c of pick((c, ax) => c.tris.length > 140 && c.tris.length < 175 && ax < 0.06 && c.center.z < -6 && c.center.y > 2.5 && c.center.y < 3.3)) s.rudder = take('rudder', c, 'y');
  const brakes = [];
  for (const sd of ['L', 'R']) {
    const pair = pick((c, ax) => c.tris.length > 90 && c.tris.length < 115 && ax > 6.7 && c.center.z < -2.7 && c.center.z > -3.5 && side(c) === sd).sort((a, b) => b.center.y - a.center.y);
    pair.forEach((c, k) => { const t = take('airbrake', c); brakes.push({ t, up: k === 0 ? 1 : -1, side: sd }); });
  }
  hull.geometry = subset(g, comps.filter(c => !taken.has(c)).flatMap(c => c.tris));
  // the skin cut exactly along the damage regions' lines first: its wing skin is long thin triangles running nearly
  // root to tip, which (taken whole) would leave long slivers sticking out of a broken wing
  {
    const R = REGIONS.su25, P = (n, c) => new THREE.Plane(new THREE.Vector3(...n), c);
    let geo = hull.geometry.toNonIndexed();
    for (const pl of [P([1, 0, 0], -R.outer.x), P([-1, 0, 0], -R.outer.x), P([1, 0, 0], -R.inner.x), P([-1, 0, 0], -R.inner.x),
      P([0, 0, 1], -R.noseZ), P([0, 0, -1], R.tail.z), P([0, 1, 0], -R.fin.y)]) {
      const a = clipGeometry(geo, pl), b = clipGeometry(geo, pl.clone().negate());
      geo = mergeGeometries([a, b].filter(x => x.attributes.position.count));
    }
    hull.geometry = geo;
  }
  model.userData.toughness = 2.2;                   // (armoured: parts and fuselage take ~2.2x the hits; collisions and hard
                                                    // landings it can survive scale with it too: weapons.js, ground.js)
  splitAirframe(model, s, REGIONS.su25);
  // what splitAirframe doesn't hang by itself: the outer flaps and the airbrakes ride their wing parts
  model.updateMatrixWorld(true);
  for (const [n, t] of extra) model.getObjectByName('part:wingInner' + n.slice(-1))?.attach(t.parent);
  for (const b of brakes) model.getObjectByName('part:wingOuter' + b.side)?.attach(b.t.parent);
  model.position.copy(CG).negate();
  const object = new THREE.Group().add(model);
  const SFc = cfg.surfaces, DEG = Math.PI / 180;
  const stabFullUp = Math.sin(SFc.stabFullAoA * DEG) * cfg.pitchStability / cfg.pitchControl;
  const stabFullDown = Math.sin(SFc.stabFullNegAoA * DEG) * cfg.pitchStability / cfg.pitchControl;
  let flapDeg = 0;
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
      // airbrakes: the petals split, upper up and lower down
      for (const b of brakes) b.t.rotation.x = b.up * (ac.airbrake || 0) * 55 * DEG;
    },
  };
}
