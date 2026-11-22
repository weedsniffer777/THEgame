import * as THREE from 'three';

// Flight control computer: turns either the mouse aim point or the keyboard into stick, aileron and rudder,
// always keeping the jet inside its G and AoA limits (positive and negative).
//
// Mouse aim works as a turn-rate command, not a chase:
//  1. the angle between the nose and the aim point sets a desired turn rate that shrinks smoothly to zero as the
//     nose arrives, so it glides in without overshoot;
//  2. that turn rate is converted to the load factor needed (gravity included) and the stick comes straight from the
//     lift curve, a feed-forward with no noisy derivatives;
//  3. roll is a rate command that turns the lift vector toward the aim point for real turns; small offsets are
//     trimmed with gentle rudder and wings-level instead of rocking the wings;
//  4. targets a little below are reached by pushing, with hysteresis so it never flips between push and roll-over.
const DEG = Math.PI / 180, G = 9.81;
const _t = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3(), _qi = new THREE.Quaternion();
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// stick deflection that holds a given load factor (negative for pushing), from the lift curve at the current dynamic pressure
function stickFor(ac, g, aoaMax) {
  const f = ac.cfg, dyn = Math.max(ac.t.dyn || 0, 1), sgn = Math.sign(g) || 1;
  const cl = Math.abs(g) * f.mass * G / (dyn * f.wingArea * (ac.liftScale || 1));
  const aoa = Math.min(f.clMax * Math.atanh(Math.min(cl / f.clMax, 0.995)) / f.clAlpha, aoaMax * DEG);
  const lock = 1 - f.pitchLock * smooth(f.pitchLockStart, f.pitchLockEnd, ac.t.ias || 0);
  // steady state: control moment = stability moment, i.e. pitchControl * lock * stick = pitchStability * sin(aoa)
  return sgn * Math.sin(aoa) * f.pitchStability / (f.pitchControl * lock);
}

export function instruct(ac, aimPoint, cfg, keys, dt) {
  const f = ac.cfg;
  const capPos = Math.min(stickFor(ac, cfg.maxG, cfg.maxAoA), 1);
  const capNeg = Math.min(-stickFor(ac, -cfg.maxNegG, cfg.maxNegAoA), 1);
  let pitch, roll, yaw;

  if (keys.active) {
    ac._mode = 'pull';
    pitch = keys.pitch > 0 ? keys.pitch * capPos : keys.pitch * capNeg;
    roll = keys.roll; yaw = keys.yaw;
  } else {
    // aim direction, lightly smoothed so mouse jitter never reaches the controls
    const want = _u.subVectors(aimPoint, ac.pos).normalize();
    if (!ac._aimDir) ac._aimDir = want.clone();
    ac._aimDir.lerp(want, 1 - Math.exp(-dt / cfg.aimSmooth)).normalize();
    _t.copy(ac._aimDir).applyQuaternion(_qi.copy(ac.quat).invert());   // body frame: +z nose, +y up, +x left wing
    const off = Math.acos(clamp(_t.z, -1, 1));
    const V = Math.max(ac.t.speed || 0, 30);
    const ias = ac.t.ias || 0;

    // push or pull? targets a little below are pushed to; hysteresis keeps the choice steady
    const below = _t.y < 0, lateral = Math.abs(_t.x) / Math.max(Math.hypot(_t.x, _t.y), 1e-6);
    if (ac._mode === 'push') { if (!below || off > (cfg.pushAngle + 6) * DEG || lateral > 0.8) ac._mode = 'pull'; }
    else if (below && off < cfg.pushAngle * DEG && lateral < 0.6) ac._mode = 'push';
    const push = ac._mode === 'push';

    // roll: angle that would put the aim point straight "up" (or straight "down" when pushing) in the lift plane
    const toTarget = push ? Math.atan2(_t.x, -_t.y) : Math.atan2(-_t.x, _t.y);   // + = roll right
    _r.set(-1, 0, 0).applyQuaternion(ac.quat);                                     // right wing in world space
    const levelErr = Math.asin(clamp(_r.y, -1, 1));                                // roll that levels the wings (+ = roll right)
    const turnW = smooth(cfg.levelAngle * DEG, cfg.bankAngle * DEG, off);          // 0 near the aim point, 1 for real turns
    // near the aim point: a small coordinated bank proportional to the sideways error (so it actually closes it),
    // blending continuously into rolling the lift onto the target for real turns
    const yawErr = Math.atan2(-_t.x, _t.z);                                         // + = aim point to the right
    const smallBank = clamp(cfg.bankPerErr * yawErr, -cfg.maxSmallBank * DEG, cfg.maxSmallBank * DEG);
    const rollErr = wrap(toTarget * turnW + (smallBank + levelErr) * (1 - turnW));
    const rollAvail = f.rollRate * DEG * smooth(0, f.rollFullIAS, ias);
    const pDes = clamp(cfg.rollGain * rollErr, -rollAvail, rollAvail);
    roll = rollAvail > 0.01 ? clamp(pDes / rollAvail, -1, 1) : 0;

    // pitch: desired turn rate toward the aim point, only for the part of the error the lift can act on
    const pitchErr = Math.atan2(_t.y, _t.z);                                       // nose-up angle to the aim point
    const aligned = Math.max(0, Math.cos(rollErr));                                // lift pointing at the target?
    let qDes = cfg.aimRate * pitchErr * (push ? 1 : 0.35 + 0.65 * aligned * aligned);
    qDes = clamp(qDes, -cfg.maxRate * DEG, cfg.maxRate * DEG);
    // load factor that gives that turn rate, plus what holds the flight path up against gravity
    const upY = Math.max(-1, Math.min(1, _u.set(0, 1, 0).applyQuaternion(ac.quat).y));
    const boost = f.turnBoost || 1;
    const gNeed = (qDes * V / G + upY) / boost;
    pitch = stickFor(ac, clamp(gNeed, -cfg.maxNegG, cfg.maxG), gNeed >= 0 ? cfg.maxAoA : cfg.maxNegAoA);
    pitch += cfg.rateGain * (qDes - (ac.q || 0));                                  // small trim on the actual pitch rate

    // rudder: fine sideways trim near the aim point, fading out in real turns
    yaw = clamp(cfg.yawGain * yawErr - cfg.yawDamp * (ac.r || 0), -1, 1) * (1 - turnW * 0.8);
    if (keys.yaw) yaw = keys.yaw;
  }

  // hard limits: never past the G or AoA limit either way
  const aoa = (ac.t.aoa || 0) * DEG;
  if (aoa > cfg.maxAoA * DEG) pitch -= (aoa - cfg.maxAoA * DEG) * 6;
  if (aoa < -cfg.maxNegAoA * DEG) pitch += (-cfg.maxNegAoA * DEG - aoa) * 6;
  const g = ac.t.g || 1;
  if (g > cfg.maxG) pitch -= (g - cfg.maxG) * 0.15;
  if (g < -cfg.maxNegG) pitch += (-cfg.maxNegG - g) * 0.15;
  pitch = clamp(pitch, -capNeg, capPos);

  // controls move at a finite speed: smooth, no jitter from instant reversals
  ac.input.pitch += (pitch - ac.input.pitch) * (1 - Math.exp(-dt / cfg.pitchLag));
  ac.input.roll += (roll - ac.input.roll) * (1 - Math.exp(-dt / cfg.rollLag));
  ac.input.yaw += (yaw - ac.input.yaw) * (1 - Math.exp(-dt / cfg.yawLag));
}
