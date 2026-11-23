import * as THREE from 'three';

// Flight of an enemy that can no longer be flown: a small rigid-body model whose behaviour comes from what is
// still attached, not from a script.
//  - each wing half makes lift (and a roll moment) in proportion to what's left of it: lose an outer panel and the
//    intact side rolls the aircraft toward the missing one, lose a whole wing and it rolls hard;
//  - the tailplane is what keeps the nose on the flight path: without it the aircraft is unstable in pitch and
//    diverges nose-up or nose-down; without the fin the same happens in yaw;
//  - roll, pitch and yaw inertia are per type (a heavy bomber lurches over slowly, a fighter snaps).
// Rates are in body axes: x = toward the left wing, y = up, z = nose.
// +wx pitches the nose down, +wy yaws it left, +wz rolls right (left wing up).
const G = 9.81, A0 = 3 * Math.PI / 180, STALL = 15 * Math.PI / 180;
const _qi = new THREE.Quaternion(), _vb = new THREE.Vector3(), _dir = new THREE.Vector3(), _right = new THREE.Vector3();
const _lift = new THREE.Vector3(), _side = new THREE.Vector3(), _fwd = new THREE.Vector3(), _dq = new THREE.Quaternion(), _ax = new THREE.Vector3();

// per type: moment per unit of asymmetry / instability (1/s²) and the damping against it (1/s), cruise lift/drag
export const CRIPPLED = {
  // span: how a wing half's lift is spread: the share on the outer panel, and where (as a fraction of the half-span)
  // the inner and outer lift acts. A long, high-aspect wing carries much of its lift far out, so losing an outer
  // panel takes most of that side's rolling moment with it.
  fighter: { roll: 7, rollDamp: 3, pitch: 10, pitchDamp: 3, yaw: 6, yawDamp: 2, ld: 10, gLimit: 9, span: { outer: 0.4, inArm: 0.35, outArm: 0.75 } },
  bomber: { roll: 0.24, rollDamp: 0.6, pitch: 1.6, pitchDamp: 0.8, yaw: 1.0, yawDamp: 0.6, ld: 14, gLimit: 3, span: { outer: 0.5, inArm: 0.3, outArm: 0.82 } },
};

// normalised lift curve: equals the AoA (rad) up to the stall, then falls away to a flat plate
function cl(a) {
  const x = Math.abs(a), k = Math.min(Math.max((x - STALL) / 0.1, 0), 1);
  const post = 0.6 * STALL * Math.sin(2 * x) / Math.sin(2 * STALL);
  return Math.sign(a) * (x * (1 - k) + post * k);
}

export function startCrippled(d, type) {
  d.cr = { k: CRIPPLED[type] || CRIPPLED.fighter, w: new THREE.Vector3(), t: 0, V0: Math.max(d.speed || 150, 60),
    // which way a tail-less airframe departs
    kick: (Math.random() < 0.5 ? 1 : -1) * (0.05 + Math.random() * 0.06), thrust: 1 };   // (a tail-less airframe rears up or tucks under: even odds)
  // start in balanced flight at the trim angle of attack
  d.obj.quaternion.multiply(_dq.setFromAxisAngle(_ax.set(1, 0, 0), -A0));
}

// what is left of each lifting / stabilising surface (1 = intact)
function surfaces(parts, sp) {
  const gone = (n) => !!parts[n]?.broken;
  const full = (1 - sp.outer) * sp.inArm + sp.outer * sp.outArm;                // rolling moment of an intact half
  const side = (s) => gone('wingInner' + s) ? [0, 0] : gone('wingOuter' + s) ? [1 - sp.outer, (1 - sp.outer) * sp.inArm / full] : [1, 1];   // [lift, roll moment]
  const [lL, mL] = side('L'), [lR, mR] = side('R');
  const tail = gone('tail');
  return { lift: (lL + lR) / 2, roll: mL - mR,
    stab: tail ? 0 : 1 - 0.5 * ((parts.stabL && gone('stabL') ? 1 : 0) + (parts.stabR && gone('stabR') ? 1 : 0)),
    fin: tail || gone('fin') ? 0 : 1 };
}

export function stepCrippled(d, dt) {
  const c = d.cr, k = c.k, s = surfaces(d.dmg.parts, k.span);
  c.t += dt;
  const q = d.obj.quaternion;
  const V = Math.max(d.vel.length(), 1), vr = V / c.V0, qn = vr * vr;
  _vb.copy(d.vel).applyQuaternion(_qi.copy(q).invert());
  const alpha = Math.atan2(-_vb.y, _vb.z), beta = Math.atan2(_vb.x, Math.hypot(_vb.y, _vb.z));
  const cln = Math.max(-5, Math.min(5, cl(alpha) / A0));                       // lift relative to 1 G cruise lift

  // forces (as accelerations)
  _dir.copy(d.vel).divideScalar(V);
  _right.set(-1, 0, 0).applyQuaternion(q);
  const n = G * s.lift * qn * cln;
  _lift.crossVectors(_right, _dir).normalize().multiplyScalar(Math.max(-4 * G, Math.min(n, 7 * G)));
  // pulled past what the structure takes (diving fast, or tumbling into the airflow): a wing panel lets go
  if (Math.abs(n) > k.gLimit * G * 1.3 && c.t > 0.5) {
    const intact = ['wingOuterL', 'wingOuterR'].filter(p => d.dmg.parts[p] && !d.dmg.parts[p].broken);
    if (intact.length && Math.random() < dt * 3) d.dmg.breakPart(intact[Math.floor(Math.random() * intact.length)], d.vel);
  }
  _side.set(1, 0, 0).applyQuaternion(q).multiplyScalar(-0.6 * G * qn * Math.sin(beta));
  const comp = 1 + 3 * Math.max(0, vr - 1.4) ** 2;                            // steep drag rise well past cruise speed
  const drag = G / k.ld * qn * comp * (0.6 + 0.4 * cln * cln + 3 * Math.abs(Math.sin(beta)) + 0.3 * (1 - s.lift));
  _fwd.set(0, 0, 1).applyQuaternion(q);
  d.vel.add(_lift.multiplyScalar(dt)).add(_side.multiplyScalar(dt))
    .addScaledVector(_dir, -drag * dt).addScaledVector(_fwd, G / k.ld * c.thrust * dt);
  d.vel.y -= G * dt;
  d.pos.addScaledVector(d.vel, dt);

  // moments: the remaining lift rolls it, the tail (if any) holds the nose to the flight path, the fin the heading
  const w = c.w, trim = A0 * Math.max(0.5, 1 - 0.04 * c.t);                    // nobody flying it: the nose slowly drops (the wing still lifts)
  const pitchStab = s.stab - 0.45 * (1 - s.stab);                               // negative = unstable
  w.x += (k.pitch * qn * (s.stab * (alpha - trim) + (pitchStab - s.stab) * (alpha - c.kick)) - k.pitchDamp * vr * (0.35 + 0.65 * s.stab) * w.x) * dt;
  w.y += (k.yaw * qn * ((s.fin - 0.3 * (1 - s.fin)) * Math.sin(beta) + 0.06 * s.roll) - k.yawDamp * vr * (0.4 + 0.6 * s.fin) * w.y) * dt;
  w.z += (k.roll * qn * Math.max(-3, Math.min(3, cln)) * s.roll - k.rollDamp * vr * w.z) * dt;
  const ang = w.length() * dt;
  if (ang > 0) q.multiply(_dq.setFromAxisAngle(_ax.copy(w).normalize(), ang)).normalize();
  d.obj.position.copy(d.pos);
}
