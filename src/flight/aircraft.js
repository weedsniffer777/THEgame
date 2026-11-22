import * as THREE from 'three';
import { atmosphere, RHO0 } from './atmosphere.js';

// Body frame: +Z forward (nose), +Y up, +X left wing.
const G = 9.81;
const DEG = Math.PI / 180;
const _v = new THREE.Vector3(), _f = new THREE.Vector3(), _a = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _up = new THREE.Vector3(), _right = new THREE.Vector3();
const _lift = new THREE.Vector3(), _side = new THREE.Vector3();
const _qi = new THREE.Quaternion(), _dq = new THREE.Quaternion(), _w = new THREE.Vector3();
const air = {};

const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

export class Aircraft {
  constructor(cfg) {
    this.cfg = cfg;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.p = 0; this.q = 0; this.r = 0; this.wFp = 0; this.liftScale = 1;        // roll right, pitch up, yaw right rates (rad/s)
    this.input = { pitch: 0, roll: 0, yaw: 0 };
    this.throttle = 1;                          // 0..1 dry, above 1 = afterburner
    this.airbrake = 0; this.airbrakeCmd = 0;
    this.gear = 0; this.gearCmd = 0;            // landing gear: 0 up, 1 down (moves over gearTime s)
    this.engine = 1;                            // spooled power, same scale
    this.t = { speed: 0, ias: 0, mach: 0, aoa: 0, beta: 0, g: 1, stall: 0, alt: 0 };
  }

  reset(pos, heading, speed) {
    this.pos.copy(pos);
    const h = heading * DEG;
    const dir = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
    this.quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    this.vel.copy(dir).multiplyScalar(speed);
    this.p = this.q = this.r = 0;
    this.throttle = this.engine = 1;
    this.gear = this.gearCmd = 0; this.gearHold = 0;
  }

  liftCoef(alpha) {
    const c = this.cfg, a = Math.abs(alpha), s = c.stallAoA * DEG;
    const pre = c.clMax * Math.tanh(c.clAlpha * a / c.clMax);
    const post = c.postStallCl * Math.sin(2 * a);
    const k = smooth(s, s + c.stallWidth * DEG, a);
    return Math.sign(alpha) * (pre * (1 - k) + post * k);
  }

  step(dt) {
    const c = this.cfg, t = this.t;
    atmosphere(this.pos.y, air);
    const V = this.vel.length();
    const dyn = 0.5 * air.rho * V * V;
    const mach = V / air.soundSpeed;
    const ias = V * Math.sqrt(air.rho / RHO0);

    _fwd.set(0, 0, 1).applyQuaternion(this.quat);
    _up.set(0, 1, 0).applyQuaternion(this.quat);
    _right.set(-1, 0, 0).applyQuaternion(this.quat);

    _v.copy(this.vel).applyQuaternion(_qi.copy(this.quat).invert());
    const alpha = V > 1 ? Math.atan2(-_v.y, _v.z) : 0;
    const beta = V > 1 ? Math.atan2(_v.x, Math.hypot(_v.y, _v.z)) : 0;
    const stall = smooth(c.stallAoA * DEG * 0.9, c.stallAoA * DEG * 1.4, Math.abs(alpha));

    // forces
    _f.set(0, 0, 0);
    _a.set(0, 0, 0);
    if (V > 1) {
      const vdir = _v.copy(this.vel).divideScalar(V);
      const cl = this.liftCoef(alpha);
      const wave = c.waveDrag * (smooth(c.machCrit, c.machPeak, mach) - 0.35 * smooth(c.machPeak, c.machPeak + 0.6, mach));
      this.airbrake += Math.sign(this.airbrakeCmd - this.airbrake) * Math.min(Math.abs(this.airbrakeCmd - this.airbrake), c.airbrakeRate * dt);
      // past the gear's limit speed it comes up by itself (lowered that fast, it gets partway out before the airflow wins)
      // (lowered too fast: it stops with the legs about a quarter out, a beat of 'oh no', then goes back up)
      // (already down when the speed goes over: it hangs on ~0.75 s before coming up)
      if (this.gearCmd && ias * 1.944 > (c.gearMaxKt || 260) && this.gear >= 0.43) {
        if (!this.gearHold) this.gearWasDown = this.gear > 0.999;
        this.gearHold = (this.gearHold || 0) + dt;
        if (this.gearHold > (this.gearWasDown ? 0.75 : 0.5)) { this.gearCmd = 0; this.gearHold = 0; }
      } else this.gearHold = 0;
      if (!this.gearHold) this.gear += Math.sign(this.gearCmd - this.gear) * Math.min(Math.abs(this.gearCmd - this.gear), dt / (c.gearTime || 4));
      // arcade lift: below corner speed the wing is allowed a guaranteed share of the G limit at full AoA
      // (about 4.7 G at 100 kt, 6.5 G at 145 kt, all of it from ~230 kt). The extra lift costs extra drag,
      // so slow, tight turns trade airspeed.
      const floorT = Math.min(Math.max((ias - c.gFloorStartIAS) / (c.gFloorFullIAS - c.gFloorStartIAS), 0), 1);
      const gFloor = c.gFloorMax * Math.pow(floorT, c.gFloorCurve);
      const clFull = this.liftCoef(c.gFloorAoA * DEG);
      const boost = Math.max(1, gFloor * c.mass * G / Math.max(dyn * c.wingArea * clFull, 1));
      const lm = this.damageFx?.liftMul ?? 1;                // missing lifting / stabilising surfaces: less G for a given AoA
      this.liftScale = boost * lm;
      const clEff = cl * boost * lm;
      const cd = c.cd0 + wave + c.inducedDrag * cl * cl + c.stallDrag * stall + c.airbrakeDrag * this.airbrake + (c.gearDrag || 0) * (this.gear || 0)
        + c.boostDrag * Math.max(0, clEff - cl) * (1 + (c.lowSpeedBleed || 0) * (1 - smooth(c.gFloorStartIAS, c.lowSpeedBleedIAS || 80, ias)) ** 2);
      _lift.crossVectors(_right, vdir).normalize().multiplyScalar(dyn * c.wingArea * clEff);
      _side.set(1, 0, 0).applyQuaternion(this.quat);
      _side.addScaledVector(vdir, -_side.dot(vdir)).normalize().multiplyScalar(-dyn * c.wingArea * c.sideForce * beta);
      _a.add(_lift).add(_side).addScaledVector(vdir, -dyn * c.wingArea * cd);
    }
    // engine
    const spool = this.throttle > this.engine ? c.spoolUp : c.spoolDown;
    this.engine += Math.sign(this.throttle - this.engine) * Math.min(Math.abs(this.throttle - this.engine), spool * dt * (this.throttle > 1 ? 3 : 1));
    const e = this.engine;
    let thrust = e <= 1 ? c.thrustIdle + (c.thrustMil - c.thrustIdle) * e : c.thrustMil + (c.thrustAB - c.thrustMil) * Math.min((e - 1) / 0.1, 1);
    thrust *= Math.pow(air.rho / RHO0, c.thrustLapse) * (1 + c.ramThrust * mach);
    _a.addScaledVector(_fwd, thrust);
    // how fast the flight path itself is turning in the pitch plane: damping only resists rotation beyond this,
    // so a steady hard turn isn't fought by the damper (real pitch damping is tiny at these speeds)
    // arcade turn rate: lift bends the flight path turnBoost times harder than the G it reports
    this.wFp = V > 1 ? (_a.dot(_up) + (c.turnBoost - 1) * _lift.dot(_up)) / (c.mass * V) : 0;
    _f.copy(_a);
    if (V > 1) _f.addScaledVector(_lift, c.turnBoost - 1);
    _f.y -= c.mass * G;
    this.vel.addScaledVector(_f, dt / c.mass);
    this.pos.addScaledVector(this.vel, dt);

    // rotation
    // the tail keeps real authority at low speed (full deflection for flick moves), so rotation never goes mushy
    const qr = Math.max(dyn / (0.5 * RHO0 * c.refSpeed * c.refSpeed), c.lowSpeedAuthority);
    const sq = Math.sqrt(qr);
    const lockP = 1 - c.pitchLock * smooth(c.pitchLockStart, c.pitchLockEnd, ias);
    const lockR = 1 - c.rollLock * smooth(c.rollLockStart, c.rollLockEnd, ias);
    const inp = this.input;
    const pm = this.damageFx ? this.damageFx.pitchMul : 1, ym = this.damageFx ? this.damageFx.yawMul : 1, wob = this.damageFx ? this.damageFx.wobble : 0;
    this.time = (this.time || 0) + dt;
    const qdot = qr * (c.pitchControl * lockP * pm * inp.pitch - c.pitchStability * Math.sin(alpha) + wob * 0.3 * Math.sin(this.time * 0.9)) - c.pitchDamping * sq * (this.q - this.wFp);
    const rdot = qr * (c.yawControl * ym * inp.yaw - c.yawStability * ym * Math.sin(beta) + wob * 0.5 * Math.sin(this.time * 0.7)) - c.yawDamping * sq * this.r;
    const D = this.damageFx;
    let pTarget = c.rollRate * DEG * inp.roll * smooth(0, c.rollFullIAS, ias) * lockR * (1 - c.stallRoll * stall);
    if (D) pTarget = pTarget * D.rollMul + D.rollBias * smooth(0, c.rollFullIAS, ias);
    const pdot = (pTarget - this.p) / (c.rollResponse / Math.min(Math.max(sq, 0.35), 2));
    this.q += qdot * dt; this.r += rdot * dt; this.p += (pdot + qr * c.dihedral * Math.sin(beta)) * dt;
    _w.set(-this.q, -this.r, this.p);
    const ang = _w.length() * dt;
    if (ang > 0) { _dq.setFromAxisAngle(_w.normalize(), ang); this.quat.multiply(_dq).normalize(); }

    t.speed = V; t.ias = ias; t.mach = mach; t.aoa = alpha / DEG; t.beta = beta / DEG; t.stall = stall;
    t.g = _a.dot(_up) / (c.mass * G); t.alt = this.pos.y; t.thrust = thrust; t.dyn = dyn;
  }
}
