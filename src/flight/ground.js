import * as THREE from 'three';

// Ground contact for the player's jet: it can touch down, roll, bounce, scrape and lose parts, and only dies on a
// really hard impact or once the airframe is wrecked. The jet touches the ground at points on its airframe (body
// frame relative to the CG: +x left wing, +y up, +z nose) and, with the gear fully down, on its three wheels.
// Each touching point gets a normal impulse (almost no bounce) and friction, applied at the point, on the flight
// model's own velocity and body rates, so the flight model keeps running throughout (a jet can roll and take off).
//  - wheels: roll freely along the jet's heading (B brakes them at idle throttle), grip sideways (no gear damage:
//    a hard landing just bounces)
//  - airframe: tears off the part that hit if the hit is hard; scraping wears the airframe down
//  - more than ~22 m/s into the ground at any point, or the canopy hitting fast: a crash
const WHEELS = [[1.6, -1.9, -0.6], [-1.6, -1.9, -0.6], [0, -1.9, 5.05]].map(p => new THREE.Vector3(...p));
const AIRFRAME = [
  [[0, -0.2, 7.2], 'nose'], [[0, -1.0, 0.5]], [[0, -0.9, -3.4]], [[0, 0.3, -7], 'tail'], [[0, 1.2, 2.6], 'canopy'],
  [[0, 3.1, -6.4], 'fin'], [[4.0, -0.1, -1.6], 'wingOuterL'], [[-4.0, -0.1, -1.6], 'wingOuterR'],
  [[2.6, 0.2, -5.6], 'stabL'], [[-2.6, 0.2, -5.6], 'stabR'],
].map(([p, part]) => ({ p: new THREE.Vector3(...p), part }));
const INV_I = new THREE.Vector3(1 / 16, 1 / 18, 1 / 4);   // inverse inertia per unit mass (body x pitch, y yaw, z roll)

const _r = new THREE.Vector3(), _n = new THREE.Vector3(), _vc = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();
const _w = new THREE.Vector3(), _qi = new THREE.Quaternion(), _fwd = new THREE.Vector3(), _side = new THREE.Vector3();

export function groundContact(ac, terrain, damage, dt, brake) {
  const q = ac.quat;
  _qi.copy(q).invert();
  const invI = (v, out) => out.copy(v).applyQuaternion(_qi).multiply(INV_I).applyQuaternion(q);
  // body rates -> world angular velocity (the flight model rotates by (-q, -r, p) about body x, y, z)
  _w.set(-ac.q, -ac.r, ac.p).applyQuaternion(q);
  let touching = 0, wheelsDown = 0, lift = 0, crash = false;
  const wheels = ac.gear > 0.95;

  const contact = (local, kind, part) => {
    _r.copy(local).applyQuaternion(q);
    const x = ac.pos.x + _r.x, z = ac.pos.z + _r.z, ground = terrain.heightAt(x, z);
    const pen = ground - (ac.pos.y + _r.y);
    if (pen <= 0) return;
    touching++; lift = Math.max(lift, pen);
    if (kind === 'wheel') wheelsDown++;
    _n.set(terrain.heightAt(x - 2, z) - terrain.heightAt(x + 2, z), 4, terrain.heightAt(x, z - 2) - terrain.heightAt(x, z + 2)).normalize();
    _vc.crossVectors(_w, _r).add(ac.vel);
    const vn = _vc.dot(_n);
    if (vn >= 0) return;
    // what the hit does
    if (vn < -22 || (part === 'canopy' && _vc.length() > 15)) crash = true;
    if (kind === 'frame') {
      const p = part && part !== 'canopy' ? damage.parts[part] : null;
      if (vn < -7 && p && !p.broken) damage.breakPart(part, ac.vel);
      else damage.bodyHp -= Math.max(0, -vn - 3) * 0.6;
    }
    // normal impulse (no bounce to speak of)
    const k = 1 + _n.dot(_t1.crossVectors(invI(_t2.crossVectors(_r, _n), _t2), _r));
    const jn = -vn / k;
    ac.vel.addScaledVector(_n, jn);
    _w.add(invI(_t1.crossVectors(_r, _n).multiplyScalar(jn), _t2));
    // friction: wheels roll along the heading and grip sideways; the airframe just scrapes
    _vc.crossVectors(_w, _r).add(ac.vel);
    const vt = _t1.copy(_vc).addScaledVector(_n, -_vc.dot(_n));
    const fr = (dir, mu) => {
      const s = vt.dot(dir); if (Math.abs(s) < 1e-4) return;
      const kt = 1 + dir.dot(_t2.crossVectors(invI(_t2.crossVectors(_r, dir), _t2), _r));
      const j = Math.sign(s) * Math.min(Math.abs(s) / kt, mu * jn);
      ac.vel.addScaledVector(dir, -j);
      _w.add(invI(_t2.crossVectors(_r, dir).multiplyScalar(-j), _side.clone()));
    };
    if (kind === 'wheel') {
      _fwd.set(0, 0, 1).applyQuaternion(q); _fwd.addScaledVector(_n, -_fwd.dot(_n)).normalize();
      const side = new THREE.Vector3().crossVectors(_n, _fwd).normalize();
      fr(_fwd, brake ? 0.45 : 0.02);
      fr(side, 0.8);
    } else {
      const sp = vt.length();
      if (sp > 1e-4) { fr(vt.clone().divideScalar(sp), 0.5); damage.bodyHp -= sp * dt * 0.04; }   // grinding along
    }
  };

  if (wheels) for (const p of WHEELS) contact(p, 'wheel');
  for (const c of AIRFRAME) if (!c.part || c.part === 'canopy' || !damage.parts[c.part]?.broken) contact(c.p, 'frame', c.part);

  if (touching) {
    ac.pos.y += lift * 0.8;                                        // out of the ground
    if (wheelsDown) _w.multiplyScalar(Math.exp(-3 * dt));          // tyres and struts settle it
    // world angular velocity -> body rates
    _t1.copy(_w).applyQuaternion(_qi);
    ac.q = -_t1.x; ac.r = -_t1.y; ac.p = _t1.z;
  }
  ac.onGround = touching > 0;
  return { touching, wheelsDown, crash };
}
