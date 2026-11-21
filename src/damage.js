import * as THREE from 'three';

// Damage model shared by every aircraft: the airframe is cut into parts that take hits and break off.
// Losing parts degrades the jet (reduced roll, lost yaw authority, slow oscillation) but never makes it
// unflyable; losing a wing root is a kill. A lost nose is survivable (and doesn't burn while still flying).
//
// Regions are in the jet model's own coordinates (+X is the left wing, +Z the nose).
export function classify(p) {
  const ax = Math.abs(p.x), side = p.x > 0 ? 'L' : 'R';
  if (p.z > 6.0) return 'nose';
  if (p.y > 2.5 && p.z < -2.4) return 'fin';
  if (ax > 2.45 && p.y < 1.8 && p.z > -3.4 && p.z < 1.4) return 'wingOuter' + side;
  if (ax > 1.05 && p.y < 1.62 && p.z > -3.0 && p.z < 1.8) return 'wingInner' + side;
  if (p.z < -3.6 && ax > 0.6 && p.y < 2.0) return 'stab' + side;
  return 'body';
}

export const PART_HP = { nose: 8, fin: 7, wingOuterL: 6, wingOuterR: 6, wingInnerL: 12, wingInnerR: 12, stabL: 5, stabR: 5 };
export const FATAL = ['wingInnerL', 'wingInnerR'];   // a lost nose is survivable
const BODY_HP = 40;

// where each part tears off the airframe (model space): the boundary of its region, at the part's own height/depth
function tornEdge(name, c) {
  const s = Math.sign(c.x) || 1;
  if (name.startsWith('wingOuter')) return new THREE.Vector3(s * 2.45, c.y, c.z);
  if (name.startsWith('wingInner')) return new THREE.Vector3(s * 1.05, c.y, c.z);
  if (name.startsWith('stab')) return new THREE.Vector3(s * 0.6, c.y, c.z);
  if (name === 'fin') return new THREE.Vector3(0, 2.5, c.z);
  if (name === 'nose') return new THREE.Vector3(0, c.y, 6.0);
  return c.clone();
}

// Called once on the loaded model: splits the main hull mesh by region and hangs the moving parts on them.
export function splitAirframe(model, surfaces) {
  let hull = null;
  model.traverse(o => { if (o.isMesh && (!hull || o.geometry.attributes.position.count > hull.geometry.attributes.position.count)) hull = o; });
  model.updateMatrixWorld(true);
  const M = hull.matrixWorld.clone();             // model-space transform of the hull (the model itself is at the origin here)
  const g = hull.geometry, pos = g.attributes.position, idx = g.index.array;
  const groups = {}, centres = {};
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    a.fromBufferAttribute(pos, idx[t]).applyMatrix4(M);
    b.fromBufferAttribute(pos, idx[t + 1]).applyMatrix4(M);
    c.fromBufferAttribute(pos, idx[t + 2]).applyMatrix4(M);
    const centre = a.add(b).add(c).divideScalar(3);
    const name = classify(centre);
    (groups[name] ||= []).push(idx[t], idx[t + 1], idx[t + 2]);
    (centres[name] ||= new THREE.Vector3()).add(centre);
  }
  const parts = {};
  for (const [name, list] of Object.entries(groups)) {
    const geo = new THREE.BufferGeometry();
    for (const [k, v] of Object.entries(g.attributes)) geo.setAttribute(k, v);   // shares the vertex data
    geo.setIndex(list);
    if (name === 'body') { hull.geometry = geo; continue; }
    const pivot = new THREE.Group();
    pivot.name = 'part:' + name; pivot.userData.part = name;
    pivot.position.copy(centres[name]).divideScalar(list.length / 3);
    const mesh = new THREE.Mesh(geo, hull.material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(M).premultiply(new THREE.Matrix4().makeTranslation(-pivot.position.x, -pivot.position.y, -pivot.position.z));
    pivot.add(mesh);
    model.add(pivot);
    parts[name] = pivot;
  }
  // moving surfaces ride on their part
  const ride = (obj, name) => { if (obj && parts[name]) { model.updateMatrixWorld(true); parts[name].attach(obj); } };
  ride(surfaces.aileronL, 'wingOuterL'); ride(surfaces.aileronR, 'wingOuterR');
  ride(model.getObjectByName('Object028'), 'wingInnerL'); ride(model.getObjectByName('Object058'), 'wingInnerR');
  ride(surfaces.rudder, 'fin');
  // the all-moving stabilators are parts on their own
  for (const [k, name] of [['stabL', 'stabL'], ['stabR', 'stabR']]) {
    if (parts[name]) { ride(surfaces[k], name); } else { surfaces[k].userData.part = name; surfaces[k].name = 'part:' + name; }
  }
  return parts;
}

// Hang any extra object (missiles on pylons, ...) on the part it sits on.
export function attachToPart(model, obj) {
  model.updateMatrixWorld(true);
  const local = obj.position.clone();
  const name = classify(local);
  const part = model.getObjectByName('part:' + name);
  if (part) part.attach(obj);
}

// Per-aircraft damage state.
export class Damage {
  constructor(model, scene, terrain, emit) {
    this.model = model; this.scene = scene; this.terrain = terrain; this.emit = emit;
    this.parts = {};
    model.traverse(o => { if (o.userData.part) this.parts[o.userData.part] = { obj: o, hp: PART_HP[o.userData.part] || 5, broken: false, parent: o.parent, local: o.matrix.clone(), breakAt: tornEdge(o.userData.part, o.position) }; });
    this.bodyHp = BODY_HP;
    this.debris = [];
    this.fires = [];            // break points that keep burning (model space)
    this.smokeT = 0;
  }

  get dead() { return this.bodyHp <= 0 || FATAL.some(n => this.parts[n]?.broken); }

  // effects on the flight model of whatever is missing
  effects() {
    const b = (n) => this.parts[n]?.broken ? 1 : 0;
    const outerL = b('wingOuterL'), outerR = b('wingOuterR');
    return {
      rollBias: (outerR - outerL) * 0.5,                       // rolls toward the missing wing tip
      rollMul: 1 - 0.35 * (outerL + outerR),
      pitchMul: 1 - 0.3 * (b('stabL') + b('stabR')),
      yawMul: 1 - 0.7 * b('fin'),
      wobble: 0.25 * (b('stabL') + b('stabR')) + 0.4 * b('fin'),
    };
  }

  // a round hit at a world point: returns what happened
  hit(worldPoint, vel) {
    const local = this.model.worldToLocal(worldPoint.clone());
    const name = classify(local);
    const part = this.parts[name];
    if (part && !part.broken) {
      if (--part.hp <= 0) { this.breakPart(name, vel); return { part: name, broke: true }; }
      return { part: name };
    }
    this.bodyHp--;
    return { part: 'body' };
  }

  breakPart(name, vel = new THREE.Vector3()) {
    const part = this.parts[name];
    if (!part || part.broken) return;
    part.broken = true;
    const o = part.obj;
    // a wing root that goes takes the rest of that wing with it: the outer panel rides along on the same piece
    if (name.startsWith('wingInner')) {
      const outer = this.parts['wingOuter' + name.slice(-1)];
      if (outer && !outer.broken) { outer.broken = true; this.model.updateMatrixWorld(true); o.attach(outer.obj); }
    }
    // while the jet can still fly only torn wing sections (fuel) burn, and modestly; fin, stabilators and nose
    // don't burn at all. Once it's going down, every break burns fully (see update).
    const burns = name.startsWith('wing') || this.dead;
    this.fires.push({ at: part.breakAt.clone(), wing: name.startsWith('wing') });
    const edge = part.breakAt.clone().sub(part.local.elements.length ? new THREE.Vector3().setFromMatrixPosition(part.local) : o.position);   // torn edge, relative to the piece
    o.updateWorldMatrix(true, true);
    this.scene.attach(o);
    const out = o.getWorldPosition(new THREE.Vector3()).sub(this.model.getWorldPosition(new THREE.Vector3())).normalize();
    this.debris.push({
      obj: o, name,
      v: vel.clone().multiplyScalar(0.9).addScaledVector(out, 8 + Math.random() * 10).add(new THREE.Vector3(0, 4 + Math.random() * 6, 0)),
      axis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
      spin: 2 + Math.random() * 5, t: 0, smokeT: 0, landed: false, edge, burns,
    });
  }

  breakAll(vel) { for (const n of Object.keys(this.parts)) this.breakPart(n, vel); }

  repair() {
    for (const [, p] of Object.entries(this.parts)) {
      if (!p.broken) { p.hp = PART_HP[p.obj.userData.part] || 5; continue; }
      p.broken = false; p.hp = PART_HP[p.obj.userData.part] || 5;
      p.obj.removeFromParent();
      p.parent.add(p.obj);
      p.local.decompose(p.obj.position, p.obj.quaternion, p.obj.scale);
    }
    this.debris = []; this.fires = []; this.bodyHp = BODY_HP;
  }

  update(dt) {
    for (const d of this.debris) {
      d.t += dt;
      if (!d.landed) {
        d.v.y -= 9.81 * dt; d.v.multiplyScalar(1 - 0.25 * dt);
        d.obj.position.addScaledVector(d.v, dt);
        d.obj.rotateOnWorldAxis(d.axis, d.spin * dt);
        const ground = this.terrain.heightAt(d.obj.position.x, d.obj.position.z);
        if (d.obj.position.y < ground) {
          d.landed = true; d.obj.position.y = ground + 0.2;             // the piece stays where it fell, burning
          d.obj.traverse(o => { if (o.isMesh && o.material.color) { o.material = o.material.clone(); o.material.color.multiplyScalar(0.25); } });
          if (/wing/.test(d.name)) this.emit('impact', d.obj.position, d.v);
          if (d.burns) this.emit('groundfire', d.obj.position, null);
        }
      }
      if (d.burns && d.t < 10 && !d.landed) {
        const at = d.obj.localToWorld(d.edge.clone());   // the torn edge burns, not the middle of the piece
        this.emit('smoke', at, d.v, d); if (d.t < 5) this.emit('flame', at, d.v, d.obj);
      }
    }
    this.debris = this.debris.filter(d => { if (d.t > 40) { d.obj.removeFromParent(); return false; } return true; });
    // break points on the airframe keep burning
    const dead = this.dead;
    for (const f of this.fires) {
      if (!dead && !f.wing) continue;                        // flyable: only wing breaks burn
      const w = this.model.localToWorld(f.at.clone());
      this.emit('smoke', w, null, f);
      if (dead || Math.random() < 0.35) this.emit('flame', w, null, f);   // flyable: a modest fire, not a blaze
    }
  }
}
