import * as THREE from 'three';
import { RHO0 } from './atmosphere.js';

// Mouse-aim autopilot: turns the camera's aim direction into stick, rudder and aileron inputs.
const DEG = Math.PI / 180;
const _t = new THREE.Vector3(), _r = new THREE.Vector3(), _qi = new THREE.Quaternion();
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function instruct(ac, aimDir, cfg, override) {
  const f = ac.cfg;
  _t.copy(aimDir).applyQuaternion(_qi.copy(ac.quat).invert());
  const off = Math.acos(clamp(_t.z, -1, 1));
  const pitchErr = Math.atan2(_t.y, _t.z);
  const yawErr = Math.atan2(-_t.x, _t.z);

  // roll: put the target straight "up" (or straight "down" for small dips), level the wings when on target
  const push = _t.y < 0 && off < cfg.pushAngle * DEG;
  const toTarget = wrap(Math.atan2(_t.y, _t.x) + (push ? Math.PI / 2 : -Math.PI / 2));
  _r.set(-1, 0, 0).applyQuaternion(ac.quat);
  const level = Math.asin(clamp(_r.y, -1, 1)) * cfg.levelGain;
  const w = smooth(cfg.levelAngle * DEG, cfg.bankAngle * DEG, off);
  const rollErr = level * (1 - w) + toTarget * w;

  // pitch, held inside the G and AoA limits
  const dyn = Math.max(ac.t.dyn || 0, 1);
  const clNeed = cfg.maxG * f.mass * 9.81 / (dyn * f.wingArea);
  const aoaG = f.clMax * Math.atanh(Math.min(clNeed / f.clMax, 0.995)) / f.clAlpha;
  const ias = ac.t.ias || 0;
  const lockP = 1 - f.pitchLock * smooth(f.pitchLockStart, f.pitchLockEnd, ias);
  const aoaFull = f.pitchControl * lockP / f.pitchStability;
  const cap = Math.min(aoaG, cfg.maxAoA * DEG) / aoaFull;

  let pitch = cfg.pitchGain * pitchErr - cfg.pitchDamp * ac.q;
  pitch = clamp(pitch, -cfg.pushLimit, Math.min(cap, 1));
  let yaw = clamp(cfg.yawGain * yawErr - cfg.yawDamp * ac.r, -1, 1) * (1 - 0.6 * w);
  let roll = clamp(cfg.rollGain * rollErr - cfg.rollDamp * ac.p, -1, 1);

  if (override.roll) roll = override.roll;
  if (override.yaw) yaw = override.yaw;
  if (override.pitch) pitch = override.pitch;
  ac.input.pitch = pitch; ac.input.roll = roll; ac.input.yaw = yaw;
  return off;
}

export { RHO0 };
