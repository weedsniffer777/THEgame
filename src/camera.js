import * as THREE from 'three';

// Third-person aim camera: the mouse turns the camera, the instructor turns the jet to follow it.
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _a = new THREE.Vector3(), _m = new THREE.Matrix4(), _o = new THREE.Vector3();
const FLIP = new THREE.Quaternion().setFromAxisAngle(Y, Math.PI);

export class CameraRig {
  constructor(camera, cfg) {
    this.camera = camera; this.cfg = cfg;
    this.aim = new THREE.Quaternion();
    this.fwd = new THREE.Vector3(); this.up = new THREE.Vector3(); this.right = new THREE.Vector3();
    this.zoom = 0;
  }

  reset(planeQuat) { this.aim.copy(planeQuat).multiply(FLIP); this.axes(); }

  axes() {
    this.fwd.set(0, 0, -1).applyQuaternion(this.aim);
    this.up.set(0, 1, 0).applyQuaternion(this.aim);
    this.right.set(1, 0, 0).applyQuaternion(this.aim);
  }

  look(dx, dy) {
    const s = this.cfg.sensitivity * (this.camera.fov / this.cfg.fov);
    this.axes();
    if (Math.abs(this.up.y) > 0.2) _a.set(0, Math.sign(this.up.y), 0); else _a.copy(this.up);
    this.aim.premultiply(_q.setFromAxisAngle(_a, -dx * s));
    this.aim.multiply(_q.setFromAxisAngle(X, -dy * s)).normalize();
  }

  // ease the aim direction onto dir (used after keyboard flying, so mouse aim resumes from the nose)
  recenter(dir, k) {
    this.axes();
    _m.lookAt(_o, dir, Math.abs(this.up.dot(dir)) > 0.99 ? _a.copy(this.right).cross(dir) : this.up);
    _q.setFromRotationMatrix(_m);
    this.aim.slerp(_q, k);
  }

  update(dt, target, speedFrac, ias = 999) {
    const c = this.cfg;
    // dynamic distance: current framing when fast, the camera eases in closer as the jet slows down
    const near = 1 - THREE.MathUtils.smoothstep(ias, c.closeIAS, c.farIAS);
    const want = THREE.MathUtils.lerp(1, c.closeFactor, near);
    this.distK = this.distK === undefined ? want : this.distK + (want - this.distK) * (1 - Math.exp(-dt / c.distSmooth));
    this.axes();
    const bank = Math.atan2(this.right.y, this.up.y);
    const w = 1 - THREE.MathUtils.smoothstep(Math.abs(this.fwd.y), 0.85, 0.98);
    this.aim.premultiply(_q.setFromAxisAngle(this.fwd, bank * Math.min(1, c.levelRate * dt) * w)).normalize();
    this.axes();
    this.camera.position.copy(target).addScaledVector(this.up, c.height * (0.4 + 0.6 * this.distK)).addScaledVector(this.fwd, -c.distance * this.distK);
    this.camera.quaternion.copy(this.aim);
    const fov = THREE.MathUtils.lerp(c.fov + c.speedFov * speedFrac, c.zoomFov, this.zoom);
    if (Math.abs(fov - this.camera.fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
  }
}
