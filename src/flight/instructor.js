import * as THREE from 'three';

// Flight control computer: turns either the mouse aim point or the keyboard into stick, aileron and rudder,
// always keeping the jet inside its G and AoA limits (positive and negative).
const DEG = Math.PI / 180;
const _t = new THREE.Vector3(), _r = new THREE.Vector3(), _qi = new THREE.Quaternion();
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// stick deflection (0..1) that holds a given load factor, from the lift curve at the current dynamic pressure
function stickFor(ac, g, aoaMax) {
  const f = ac.cfg, dyn = Math.max(ac.t.dyn || 0, 1);
  const cl = g * f.mass * 9.81 / (dyn * f.wingArea);
  const aoa = Math.min(f.clMax * Math.atanh(Math.min(cl / f.clMax, 0.995)) / f.clAlpha, aoaMax * DEG);
  const lock = 1 - f.pitchLock * smooth(f.pitchLockStart, f.pitchLockEnd, ac.t.ias || 0);
  return aoa / (f.pitchControl * lock / f.pitchStability);
}

export function instruct(ac, aimPoint, cfg, keys, dt) {
  const capPos = Math.min(stickFor(ac, cfg.maxG, cfg.maxAoA), 1);
  const capNeg = Math.min(stickFor(ac, cfg.maxNegG, cfg.maxNegAoA), 1);
  let pitch, roll, yaw;

  if (keys.active) {
    // keyboard: full key = right at the limit, never past it
    pitch = keys.pitch > 0 ? keys.pitch * capPos : keys.pitch * capNeg;
    roll = keys.roll; yaw = keys.yaw;
  } else {
    _t.subVectors(aimPoint, ac.pos).normalize().applyQuaternion(_qi.copy(ac.quat).invert());
    const off = Math.acos(clamp(_t.z, -1, 1));
    const pitchErr = Math.atan2(_t.y, _t.z);
    const yawErr = Math.atan2(-_t.x, _t.z);

    // roll the target "overhead" and pull; small dips below are taken by pushing with wings level instead.
    // Every weight changes smoothly, so the rolls never flip back and forth around the boundaries.
    const toTarget = wrap(Math.atan2(_t.y, _t.x) - Math.PI / 2);
    _r.set(-1, 0, 0).applyQuaternion(ac.quat);
    const level = Math.asin(clamp(_r.y, -1, 1)) * cfg.levelGain;
    const below = smooth(0, 0.6, -_t.y / Math.max(Math.sin(off), 1e-4));
    const push = below * (1 - smooth(cfg.pushAngle * 0.6 * DEG, cfg.pushAngle * DEG, off));
    const bank = smooth(cfg.levelAngle * DEG, cfg.bankAngle * DEG, off) * (1 - push);
    const rollErr = level * (1 - bank) + toTarget * bank;

    pitch = cfg.pitchGain * pitchErr - cfg.pitchDamp * (ac.q - (ac.wFp || 0));
    yaw = clamp(cfg.yawGain * yawErr - cfg.yawDamp * ac.r, -1, 1) * (1 - 0.6 * bank);
    roll = clamp(cfg.rollGain * rollErr - cfg.rollDamp * ac.p, -1, 1);
    if (keys.yaw) yaw = keys.yaw;
  }

  // soft G limiter on top of the stick caps, in case gusts of AoA overshoot
  const g = ac.t.g || 1;
  if (g > cfg.maxG) pitch -= (g - cfg.maxG) * 0.15;
  if (g < -cfg.maxNegG) pitch += (-cfg.maxNegG - g) * 0.15;
  pitch = clamp(pitch, -capNeg, capPos);

  // stick, aileron and rudder move at a finite speed: no jitter from instant reversals
  const k = 1 - Math.exp(-dt / cfg.stickLag);
  ac.input.pitch += (pitch - ac.input.pitch) * k;
  ac.input.roll += (roll - ac.input.roll) * k;
  ac.input.yaw += (yaw - ac.input.yaw) * k;
}
