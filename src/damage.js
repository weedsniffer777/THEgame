import * as THREE from 'three';

// Damage model shared by every aircraft: the airframe is cut into parts that take hits and break off.
// Losing parts degrades the jet (reduced roll, lost yaw authority, slow oscillation) but never makes it
// unflyable; losing a wing root is a kill. A lost nose is survivable (and doesn't burn while still flying).
//
// Regions are per aircraft type, in that model's own coordinates (+X is the left wing, +Z the nose).
// stab: tailplane cut from the hull (T-tails etc.); jets with separate moving stabilators leave it out. Each cut takes
// the whole surface (measured from the models: root to tip, leading to trailing edge), so what breaks off is the piece.
export const REGIONS = {
  lightFighter: { bulkheads: true, jag: 0.22, noseZ: 6.0, tail: { z: -3.6 }, fin: { y: 2.5, z: -2.4 }, outer: { x: 2.45, y: 1.8, z0: -3.4, z1: 1.4 }, inner: { x: 1.05, y: 1.62, z0: -3.0, z1: 1.8 } },
  // heavy four-engine bomber (model turned so its nose is +Z)
  bomber: { jag: 0.9, noseZ: 15, tail: { z: -12 }, stab: { x: 0.9, y: -2, z: -15.5, yMax: 0.3 }, fin: { y: 0.3, z: -11 }, outer: { x: 11.2, y: 0.5, z0: -10, z1: 12 }, inner: { x: 1.6, y: 0.5, z0: -10, z1: 14 } },
  earlyJet: { jag: 0.3, noseZ: 3.3, stab: { x: 0.28, y: 4.0, z: -7.9, yMax: 4.65 }, fin: { y: 3.3, z: -6.8 }, outer: { x: 4.2, y: 3.2, z0: -6.5, z1: 1.0 }, inner: { x: 1.0, y: 3.1, z0: -6.5, z1: 1.3 } },
};

const _jg = new THREE.Vector3();
function jagged(c, J) {
  if (!J) return c;
  const cell = J * 1.6, h = (k) => { const v = Math.sin(Math.floor(c.x / cell) * 127.1 + Math.floor(c.y / cell) * 311.7 + Math.floor(c.z / cell) * 74.7 + k * 19.19) * 43758.5453; return v - Math.floor(v) - 0.5; };
  return _jg.set(c.x + h(1) * J * 2, c.y + h(2) * J * 2, c.z + h(3) * J * 2);
}

export function classify(p, R = REGIONS.lightFighter, pj = p) {   // pj: a jittered point, used only for the nose / rear-fuselage cuts
  const ax = Math.abs(p.x), side = p.x > 0 ? 'L' : 'R';
  if (R.stab && ax > R.stab.x && p.y > R.stab.y && p.z < R.stab.z && (R.stab.yMax === undefined || p.y < R.stab.yMax)) return 'stab' + side;
  if (pj.z > R.noseZ) return 'nose';
  if (p.y > R.fin.y && p.z < R.fin.z) return 'fin';
  const o = R.outer, n = R.inner;
  const wx = R.jagWings ? Math.abs(pj.x) : ax;           // (jagWings: the wing breaks are ragged too)
  if (wx > o.x && p.y < o.y && p.z > o.z0 && p.z < o.z1) return 'wingOuter' + side;
  if (wx > n.x && p.y < n.y && p.z > n.z0 && p.z < n.z1) return 'wingInner' + side;
  if (R.tail && pj.z < R.tail.z) return 'tail';            // rear fuselage that can snap off (big aircraft)
  return 'body';
}

export const PART_HP = { nose: 8, fin: 7, wingOuterL: 6, wingOuterR: 6, wingInnerL: 12, wingInnerR: 12, stabL: 5, stabR: 5, tail: 14 };
export const FATAL = ['wingInnerL', 'wingInnerR', 'tail'];   // a lost nose is survivable
export const BODY_HP = 40;

// where each part tears off the airframe (model space): the boundary of its region, at the part's own height/depth
function tornEdge(name, c, R = REGIONS.lightFighter) {
  const s = Math.sign(c.x) || 1;
  if (name.startsWith('wingOuter')) return new THREE.Vector3(s * R.outer.x, c.y, c.z);
  if (name.startsWith('wingInner')) return new THREE.Vector3(s * R.inner.x, c.y, c.z);
  if (name.startsWith('stab')) return new THREE.Vector3(s * (R.stab ? R.stab.x : 0.6), c.y, c.z);
  if (name === 'fin') return new THREE.Vector3(0, R.fin.y, c.z);
  if (name === 'nose') return new THREE.Vector3(0, c.y, R.noseZ);
  if (name === 'tail') return new THREE.Vector3(0, c.y, R.tail.z);
  return c.clone();
}

// Called once on the loaded model: splits the main hull mesh by region and hangs the moving parts on them.
// drop(centre) can remove triangles outright (e.g. landing gear modelled down).
// allMeshes: cut every mesh of the model (for models built from many pieces), not just the main hull.
export function splitAirframe(model, surfaces = {}, R = REGIONS.lightFighter, drop = null, allMeshes = false) {
  model.userData.regions = R;
  model.updateMatrixWorld(true);
  const meshes = [];
  model.traverse(o => { if (o.isMesh && !o.userData.noSplit) meshes.push(o); });
  const targets = allMeshes ? meshes : [meshes.reduce((h, o) => (!h || o.geometry.attributes.position.count > h.geometry.attributes.position.count ? o : h), null)];
  const pieces = {}, centres = {}, counts = {};
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nrm = new THREE.Vector3(), e1 = new THREE.Vector3();
  for (const hull of targets) {
    const M = hull.matrixWorld.clone();           // model-space transform of this mesh (the model itself is at the origin here)
    const g = hull.geometry, pos = g.attributes.position;
    const idx = g.index ? g.index.array : Array.from({ length: pos.count }, (_, k) => k);
    const groups = {};
    for (let t = 0; t < idx.length; t += 3) {
      a.fromBufferAttribute(pos, idx[t]).applyMatrix4(M);
      b.fromBufferAttribute(pos, idx[t + 1]).applyMatrix4(M);
      c.fromBufferAttribute(pos, idx[t + 2]).applyMatrix4(M);
      if (drop) { nrm.subVectors(b, a).cross(e1.subVectors(c, a)).normalize(); }
      const centre = a.add(b).add(c).divideScalar(3);
      if (drop && drop(centre, nrm)) continue;
      // (each triangle is classified at a point nudged by a blocky random offset, so the cut lines wander in
      // chunks instead of running dead straight: torn, not sawn)
      const name = classify(centre, R, jagged(centre.clone(), R.jag || 0));
      (groups[name] ||= []).push(idx[t], idx[t + 1], idx[t + 2]);
      (centres[name] ||= new THREE.Vector3()).add(centre);
      counts[name] = (counts[name] || 0) + 1;
    }
    for (const [name, list] of Object.entries(groups)) {
      const geo = new THREE.BufferGeometry();
      for (const [k, v] of Object.entries(g.attributes)) geo.setAttribute(k, v);   // shares the vertex data
      geo.setIndex(list);
      if (name === 'body') { hull.userData.bodyGeo = geo; continue; }
      (pieces[name] ||= []).push({ geo, material: hull.material, M });
    }
    hull.geometry = hull.userData.bodyGeo || new THREE.BufferGeometry();   // what stays on the airframe
    delete hull.userData.bodyGeo;
  }
  const parts = {};
  for (const [name, list] of Object.entries(pieces)) {
    const pivot = new THREE.Group();
    pivot.name = 'part:' + name; pivot.userData.part = name;
    pivot.position.copy(centres[name]).divideScalar(counts[name]);
    for (const { geo, material, M } of list) {
      const mesh = new THREE.Mesh(geo, material);
      mesh.userData.hullPiece = true;                     // (a piece of the airframe skin, not something hung on it)
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(M).premultiply(new THREE.Matrix4().makeTranslation(-pivot.position.x, -pivot.position.y, -pivot.position.z));
      pivot.add(mesh);
    }
    model.add(pivot);
    parts[name] = pivot;
  }
  // moving surfaces ride on their part
  const ride = (obj, name) => { if (obj && parts[name]) { model.updateMatrixWorld(true); parts[name].attach(obj); } };
  ride(surfaces.aileronL, 'wingOuterL'); ride(surfaces.aileronR, 'wingOuterR');
  ride(surfaces.flapL || model.getObjectByName('Object028'), 'wingInnerL'); ride(surfaces.flapR || model.getObjectByName('Object058'), 'wingInnerR');
  ride(surfaces.rudder, 'fin');
  // the all-moving stabilators are parts on their own
  for (const [k, name] of [['stabL', 'stabL'], ['stabR', 'stabR']]) {
    if (!surfaces[k]) continue;
    if (parts[name]) { ride(surfaces[k], name); } else { surfaces[k].userData.part = name; surfaces[k].name = 'part:' + name; }
  }
  if (R.bulkheads) addBulkheads(model, parts, R);       // (the F-5's plates only: fitted to its cross-sections, never reused on other airframes)
  return parts;
}

// Bulkheads: a dark plate across each cut, shaped like the airframe's cross-section there (a convex outline of the
// remaining structure's vertices near the cut), shown once that part has come off so nobody sees into the airframe.
// It sits a few cm inside the cut, so the torn skin still sticks out past it.
const capMat = new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.7, metalness: 0.45, side: THREE.DoubleSide });   // bare, scorched-looking metal
function cutPlane(name, R) {
  const s = name.endsWith('L') ? 1 : -1;
  const fus = (p) => Math.abs(p.x) < R.inner.x * 1.1 && p.y < R.fin.y + 0.1;          // just the fuselage, not wings or fin
  if (name === 'nose') return { n: new THREE.Vector3(0, 0, 1), d: R.noseZ, keep: fus };
  if (name === 'tail' && R.tail) return { n: new THREE.Vector3(0, 0, -1), d: -R.tail.z, keep: fus };
  if (name === 'fin') return { n: new THREE.Vector3(0, 1, 0), d: R.fin.y, keep: (p) => p.z < R.fin.z + 0.5 && Math.abs(p.x) < R.inner.x * 0.14 };   // the fin's own stub
  if (name.startsWith('stab') && R.stab) return { n: new THREE.Vector3(s, 0, 0), d: R.stab.x, keep: (p) => p.z < R.stab.z + 0.5 && p.y > R.stab.y - 0.5 };
  return null;
}
function addBulkheads(model, parts, R) {
  model.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  // the plate goes a little behind the torn zone, where the airframe is still whole all the way round (the jagged cut
  // reaches up to 'jag' either side of the region line), so it never hangs off shards at the ragged edge
  const band = 0.15, v = new THREE.Vector3();
  for (const [name, pivot] of Object.entries(parts)) {
    const cp = cutPlane(name, R); if (!cp) continue;
    const depth = name === 'nose' || name === 'tail' ? (R.jag || 0) + 0.15 : 0.05;   // (only the fuselage cuts are jagged)
    // structure that stays: everything outside this part (and outside anything hung on it)
    const inPart = new Set(); for (const P of Object.values(parts)) P.traverse(o => inPart.add(o));   // (body only)
    let zr = null;
    if (name === 'fin') {                                         // the fin's footprint along the spine
      zr = [1e9, -1e9]; const M0 = new THREE.Matrix4();
      pivot.traverse(o => { if (!o.isMesh || !o.geometry.attributes.position) return; M0.multiplyMatrices(inv, o.matrixWorld); const ps = o.geometry.attributes.position;
        for (let k = 0; k < ps.count; k++) { v.fromBufferAttribute(ps, k).applyMatrix4(M0); if (v.y < R.fin.y + 0.5) { zr[0] = Math.min(zr[0], v.z); zr[1] = Math.max(zr[1], v.z); } } });
    }
    const pts = [];
    model.traverse(o => {
      if (!o.isMesh || inPart.has(o) || o.userData.noSplit || o.userData.noBulk || !o.visible) return;
      const pos = o.geometry.attributes.position; if (!pos) return;   // (a mesh emptied by the split)
      const M = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      // the exact cross-section: where each triangle's edges cross the plate's plane
      const idx = o.geometry.index ? o.geometry.index.array : null, n = idx ? idx.length : pos.count;
      const T = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], dd = [0, 0, 0];
      for (let k = 0; k + 2 < n; k += 3) {
        for (let j = 0; j < 3; j++) { T[j].fromBufferAttribute(pos, idx ? idx[k + j] : k + j).applyMatrix4(M); dd[j] = T[j].dot(cp.n) - cp.d + depth; }
        for (let j = 0; j < 3; j++) {
          const a = j, b = (j + 1) % 3;
          if ((dd[a] > 0) === (dd[b] > 0)) continue;
          v.copy(T[a]).lerp(T[b], dd[a] / (dd[a] - dd[b]));
          if (!cp.keep(v) || (zr && (v.z < zr[0] + 0.05 || v.z > zr[1] - 0.05))) continue;
          pts.push(v.clone());
        }
      }
    });
    if (pts.length < 3) continue;
    // 2D basis on the plane, convex hull of the projected points
    const u = Math.abs(cp.n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const a = new THREE.Vector3().crossVectors(cp.n, u).normalize(), b = new THREE.Vector3().crossVectors(cp.n, a);
    const P = pts.map(p => [p.dot(a), p.dot(b)]);
    P.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    const lo = [], hi = [];
    for (const p of P) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
    const hull = lo.slice(0, -1).concat(hi.slice(0, -1));
    if (hull.length < 3) continue;
    const off = cp.d - depth, base = cp.n.clone().multiplyScalar(off);
    const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length, cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
    for (const p of hull) { p[0] = cx + (p[0] - cx) * 0.95; p[1] = cy + (p[1] - cy) * 0.95; }   // just inside the skin
    const at = (x, y) => base.clone().addScaledVector(a, x).addScaledVector(b, y);
    // flat plate, or for the nose a dome bulging forward (fills the back of the radome)
    const rad = hull.reduce((m, p) => Math.max(m, Math.hypot(p[0] - cx, p[1] - cy)), 0);
    const dome = name === 'nose' ? rad * 0.55 : 0, rings = dome ? 4 : 1;
    const ringPt = (p, f) => { const w = at(cx + (p[0] - cx) * f, cy + (p[1] - cy) * f); return w.addScaledVector(cp.n, dome * Math.sqrt(Math.max(0, 1 - f * f))); };
    const verts = [];
    for (let i = 0; i < hull.length; i++) {
      const p = hull[i], q = hull[(i + 1) % hull.length];
      for (let r = 0; r < rings; r++) {
        const f0 = r / rings, f1 = (r + 1) / rings;
        const a0 = ringPt(p, f0), b0 = ringPt(q, f0), a1 = ringPt(p, f1), b1 = ringPt(q, f1);
        if (r === 0) for (const w of [a0, a1, b1]) verts.push(w.x, w.y, w.z);
        else for (const w of [a0, a1, b1, a0, b1, b0]) verts.push(w.x, w.y, w.z);
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3)); g.computeVertexNormals();
    const cap = new THREE.Mesh(g, capMat);
    cap.visible = false; cap.userData.noSplit = true; cap.userData.cap = true;
    const host = model;
    model.add(cap); model.updateMatrixWorld(true); host.attach(cap);
    pivot.userData.capMesh = cap;
  }
}

// Hang any extra object (missiles on pylons, ...) on the part it sits on.
export function attachToPart(model, obj) {
  model.updateMatrixWorld(true);
  const local = obj.position.clone();
  const name = classify(local, model.userData.regions);
  const part = model.getObjectByName('part:' + name);
  if (part) part.attach(obj);
}

// Per-aircraft damage state.
// which part a break point sits on (what is left holding it): the outer wing is held by the inner wing, the tail
// surfaces by the rear fuselage; everything else by the fuselage itself (null)
const HOST = { wingOuterL: 'wingInnerL', wingOuterR: 'wingInnerR', stabL: 'tail', stabR: 'tail', fin: 'tail' };

export class Damage {
  constructor(model, scene, terrain, emit) {
    this.model = model; this.scene = scene; this.terrain = terrain; this.emit = emit;
    this.parts = {};
    model.traverse(o => { if (o.userData.part) this.parts[o.userData.part] = { obj: o, hp: (PART_HP[o.userData.part] || 5) * (model.userData.toughness || 1), broken: false, parent: o.parent, local: o.matrix.clone(), breakAt: tornEdge(o.userData.part, o.position, model.userData.regions) }; });
    this.bodyHp = BODY_HP * (model.userData.toughness || 1);
    this.mats = new Map(); model.traverse(o => { if (o.isMesh) this.mats.set(o, o.material); });   // to undo charring on repair
    this.debris = [];
    this.fires = [];            // break points that keep burning (model space)
    this.smokeT = 0;
  }

  // critical: the fuselage destroyed, a whole wing (or the rear fuselage) gone, or the whole tail (fin and both
  // stabilisers) shot off, or both horizontal stabilisers gone (any aircraft, the player's too)
  get dead() {
    const P = this.parts, gone = (n) => !!P[n]?.broken;
    return this.bodyHp <= 0 || FATAL.some(gone) || (!!P.stabL && !!P.stabR && gone('stabL') && gone('stabR'));
  }
  // going down, by a fatal hit or otherwise (set by whoever flies it): everything burns at full strength
  get burning() { return this.dead || !!this.doomed; }
  // set it well alight (the mission's last kill): fires at both wing roots that burn for as long as it falls
  ablaze() {
    this.quenched = false;
    for (const n of ['wingInnerL', 'wingInnerR']) { const p = this.parts[n]; if (p) this.fires.push({ at: p.breakAt.clone(), wing: true, host: null, t: 0, life: 1e9 }); }
  }

  // effects on the flight model of whatever is missing
  effects() {
    const b = (n) => this.parts[n]?.broken ? 1 : 0;
    const outerL = b('wingOuterL'), outerR = b('wingOuterR');
    return {
      rollBias: (outerR - outerL) * 0.5,                       // rolls toward the missing wing tip
      rollMul: 1 - 0.35 * (outerL + outerR),
      pitchMul: 1 - 0.3 * (b('stabL') + b('stabR')),
      dragMul: 1 + 0.2 * b('nose'),                            // a blunt, open front: +20% drag
      liftMul: 1 - 0.15 * (outerL + outerR + b('stabL') + b('stabR')),   // each lost outer wing or stabiliser costs ~15% of the turn
      yawMul: 1 - 0.7 * b('fin'),
      wobble: 0.25 * (b('stabL') + b('stabR')) + 0.4 * b('fin'),
      pitchWobble: b('stabL') + b('stabR') === 1 ? 1 : 0,    // (enemies: one stabiliser left, it porpoises)
    };
  }

  // a round hit at a world point: returns what happened
  hit(worldPoint, vel, dmg = 1) {
    const local = this.model.worldToLocal(worldPoint.clone());
    const name = classify(local, this.model.userData.regions);
    const part = this.parts[name];
    if (part && !part.broken) {
      if ((part.hp -= dmg) <= 0) { this.breakPart(name, vel); return { part: name, broke: true }; }
      return { part: name };
    }
    this.bodyHp -= dmg;
    return { part: 'body' };
  }

  breakPart(name, vel = new THREE.Vector3(), fling = 0) {   // fling: extra outward speed (m/s), e.g. blown apart
    const part = this.parts[name];
    if (!part || part.broken) return;
    part.broken = true;
    if (part.obj.userData.capMesh) part.obj.userData.capMesh.visible = true;
    // tail surfaces and the nose come off in a spray of white paint flakes and dust
    if (/^(fin|stab|nose)/.test(name)) this.emit('flakes', this.model.localToWorld(part.breakAt.clone()), vel);
    const o = part.obj;
    // a wing root that goes takes the rest of that wing with it: the outer panel rides along on the same piece
    if (name.startsWith('wingInner')) {
      const outer = this.parts['wingOuter' + name.slice(-1)];
      if (outer && !outer.broken) { outer.broken = true; this.model.updateMatrixWorld(true); o.attach(outer.obj); }
    }
    // a snapped rear fuselage takes the fin and tailplane with it
    if (name === 'tail') {
      this.model.updateMatrixWorld(true);
      for (const n of ['fin', 'stabL', 'stabR']) { const p = this.parts[n]; if (p && !p.broken) { p.broken = true; o.attach(p.obj); } }
    }
    // while the jet can still fly only torn wing sections (fuel) burn, and modestly; fin, stabilators and nose
    // don't burn at all. Once it's going down, every break burns fully (see update).
    const burns = !this.quenched && (name.startsWith('wing') || this.burning);
    // a fire burning on the piece that just came off (e.g. at the outer-wing joint, on the inner wing) moves to where
    // this piece was attached (the wing root): it would otherwise float in the air where the wing used to be
    for (const f of this.fires) if (f.host === name) { f.at.copy(part.breakAt); f.host = HOST[name] || null; }
    this.fires.push({ at: part.breakAt.clone(), wing: name.startsWith('wing'), host: HOST[name] || null, t: 0, life: 5 + Math.random() * 10 });   // (a wing fire on a flyable aircraft burns out after life s)
    const edge = part.breakAt.clone().sub(part.local.elements.length ? new THREE.Vector3().setFromMatrixPosition(part.local) : o.position);   // torn edge, relative to the piece
    o.updateWorldMatrix(true, true);
    this.scene.attach(o);
    const out = o.getWorldPosition(new THREE.Vector3()).sub(this.model.getWorldPosition(new THREE.Vector3())).normalize();
    this.debris.push({
      obj: o, name,
      v: vel.clone().multiplyScalar(0.9).addScaledVector(out, 8 + Math.random() * 10 + fling * (0.6 + 0.8 * Math.random())).add(new THREE.Vector3(0, 4 + Math.random() * 6, 0)),
      axis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
      spin: fling ? 4 + Math.random() * 8 : 2 + Math.random() * 5, t: 0, smokeT: 0, landed: false, edge, burns,
    });
  }

  // doused (the aircraft went into water): nothing on it or flying off it burns or smokes any more
  quench() { this.quenched = true; for (const d of this.debris) d.burns = false; }

  breakAll(vel) { for (const n of Object.keys(this.parts)) this.breakPart(n, vel); }

  repair() {
    for (const [, p] of Object.entries(this.parts)) {
      const hp = (PART_HP[p.obj.userData.part] || 5) * (this.model.userData.toughness || 1);
      if (!p.broken) { p.hp = hp; continue; }
      p.broken = false; p.hp = hp;
      p.obj.removeFromParent();
      p.parent.add(p.obj);
      p.local.decompose(p.obj.position, p.obj.quaternion, p.obj.scale);
      p.obj.visible = true;                                    // (pieces that sank in a lake were hidden)
      if (p.obj.userData.capMesh) p.obj.userData.capMesh.visible = false;
    }
    for (const [o, m] of this.mats) o.material = m;
    this.debris = []; this.fires = []; this.doomed = false; this.quenched = false; this.bodyHp = BODY_HP * (this.model.userData.toughness || 1);
  }

  update(dt) {
    if (dt <= 0) return;                                       // paused: nothing moves, nothing is laid down (puffs would pile up)
    for (const d of this.debris) {
      d.t += dt;
      if (!d.landed) {
        d.v.y -= 9.81 * dt; d.v.multiplyScalar(1 - 0.25 * dt);
        d.obj.position.addScaledVector(d.v, dt);
        d.obj.rotateOnWorldAxis(d.axis, d.spin * dt);
        const ground = this.terrain.heightAt(d.obj.position.x, d.obj.position.z);
        if (d.obj.position.y < ground && this.terrain.isWater?.(d.obj.position.x, d.obj.position.z)) {   // into a lake: splash, gone
          d.landed = true; this.emit('splash', d.obj.position, d.v); d.obj.visible = false; d.t = 1e9; continue;
        }
        if (d.obj.position.y < ground) {
          d.landed = true; d.obj.position.y = ground + 0.2;             // the piece stays where it fell, burning
          d.obj.traverse(o => { if (o.isMesh && o.material.color) { o.material = o.material.clone(); o.material.color.multiplyScalar(0.25); } });
          if (/wing/.test(d.name)) this.emit('impact', d.obj.position, d.v);
          if (d.burns) this.emit('groundfire', d.obj.position, null);
        }
      }
      // every piece trails smoke from its torn edge while it falls; burning ones (wing sections, anything off an
      // aircraft that is going down) also trail flame and smoke for longer
      if (!d.landed && !this.quenched && d.t < (d.burns ? 10 : 6)) {
        const at = d.obj.localToWorld(d.edge.clone());   // the torn edge, not the middle of the piece
        this.emit('smoke', at, d.v, d); if (d.burns && d.t < 5) this.emit('flame', at, d.v, d.obj);
      }
    }
    this.debris = this.debris.filter(d => { if (d.t > 40) { d.obj.removeFromParent(); return false; } return true; });
    // the fin's stump trips the airflow: irregular little wisps tearing off it
    const fin = this.parts.fin;
    if (fin?.broken && !this.quenched && Math.random() < dt * 9) this.emit('wisp', this.model.localToWorld(fin.breakAt.clone()), null);
    // break points on the airframe keep burning
    const dead = this.burning;
    for (const f of this.quenched ? [] : this.fires) {
      if (!dead && !f.wing) continue;                        // flyable: only wing breaks burn
      // flyable: the fire dies down over its last couple of seconds and goes out; going down, it all burns again
      f.t += dt;
      f.fade = dead ? 1 : 1 - Math.min(Math.max((f.t - (f.life - 2.5)) / 2.5, 0), 1);
      if (f.fade <= 0) continue;
      const w = this.model.localToWorld(f.at.clone());
      if (dead || Math.random() < 0.3 + 0.7 * f.fade) this.emit('smoke', w, null, f);
      if (dead || Math.random() < 0.35 * f.fade) this.emit('flame', w, null, f);   // flyable: a modest fire, not a blaze
    }
  }
}
