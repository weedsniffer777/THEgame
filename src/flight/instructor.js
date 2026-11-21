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
  const cl = g * f.mass * 9.81 / (dyn * f.wingArea * (ac.liftScale || 1));
  const aoa = Math.min(f.clMax * Math.atanh(Math.min(cl / f.clMax, 0.995)) / f.clAlpha, aoaMax * DEG);
  const lock = 1 - f.pitchLock * smooth(f.pitchLockStart, f.pitchLockEnd, ac.t.ias || 0);
  // steady state: control moment = stability moment, i.e. pitchControl * lock * stick = pitchStability * sin(aoa)
  return Math.sin(aoa) * f.pitchStability / (f.pitchControl * lock);
}

export function instruct(ac, aimPoint, cfg, keys, dt) {
  const capPos = Math.min(stickFor(ac, cfg.maxG, cfg.maxAoA), 1);
  const capNeg = Math.min(stickFor(ac, cfg.maxNegG, cfg.maxNegAoA), 1);
  let pitch, roll, yaw;

  if (keys.active) {
    ac._aim = null;
    // keyboard: full key = right at the limit, never past it
    pitch = keys.pitch > 0 ? keys.pitch * capPos : keys.pitch * capNeg;
    roll = keys.roll; yaw = keys.yaw;
  } else {
    // the aim the autopilot chases is low-passed, so mouse jitter never reaches the controls
    const want = _r.subVectors(aimPoint, ac.pos).normalize();
    if (!ac._aimDir) ac._aimDir = want.clone();
    ac._aimDir.lerp(want, 1 - Math.exp(-dt / cfg.aimSmooth)).normalize();
    _t.copy(ac._aimDir).applyQuaternion(_qi.copy(ac.quat).invert());
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

    // PD on the aim error itself: the derivative term sees the nose closing on the target and eases off
    // before it gets there, so the nose settles instead of bobbing past it
    const m = ac._aim || (ac._aim = { pe: pitchErr, ye: yawErr, dp: 0, dy: 0 });
    const lp = 1 - Math.exp(-dt / 0.03);
    m.dp += ((pitchErr - m.pe) / dt - m.dp) * lp; m.dy += ((yawErr - m.ye) / dt - m.dy) * lp;
    m.pe = pitchErr; m.ye = yawErr;
    pitch = cfg.pitchGain * (pitchErr + cfg.pitchLead * m.dp);
    // no ballooning: while the lift vector still points away from the target, roll first and hold the pull back
    const aligned = Math.max(Math.cos(rollErr), 0);
    if (pitch > 0) pitch *= 1 - bank * (1 - aligned * aligned);
    yaw = clamp(cfg.yawGain * (yawErr + cfg.yawLead * m.dy), -1, 1) * (1 - 0.6 * bank);
    // near the target the direction to it swings fast as the nose passes, so roll gently there
    const rollLim = 0.25 + 0.75 * smooth(cfg.levelAngle * DEG, cfg.bankAngle * 2 * DEG, off);
    roll = clamp(cfg.rollGain * rollErr - cfg.rollDamp * ac.p, -rollLim, rollLim);
    if (keys.yaw) yaw = keys.yaw;
  }

  // soft G limiter on top of the stick caps, in case gusts of AoA overshoot
  const g = ac.t.g || 1;
  if (g > cfg.maxG) pitch -= (g - cfg.maxG) * 0.15;
  if (g < -cfg.maxNegG) pitch += (-cfg.maxNegG - g) * 0.15;
  // hard AoA limiter: never let the jet overshoot into the stall
  const aoa = (ac.t.aoa || 0) * DEG;
  if (aoa > cfg.maxAoA * DEG) pitch -= (aoa - cfg.maxAoA * DEG) * 6;
  if (aoa < -cfg.maxNegAoA * DEG) pitch += (-cfg.maxNegAoA * DEG - aoa) * 6;
  pitch = clamp(pitch, -capNeg, capPos);

  // stick, aileron and rudder move at a finite speed: smooth, no jitter from instant reversals
  ac.input.pitch += (pitch - ac.input.pitch) * (1 - Math.exp(-dt / cfg.pitchLag));
  ac.input.roll += (roll - ac.input.roll) * (1 - Math.exp(-dt / cfg.rollLag));
  ac.input.yaw += (yaw - ac.input.yaw) * (1 - Math.exp(-dt / cfg.yawLag));
}
