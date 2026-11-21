import * as THREE from 'three';

// Third-person aim camera: the mouse turns the camera, the instructor turns the jet to follow it.
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _a = new THREE.Vector3();
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

  update(dt, target, speedFrac) {
    const c = this.cfg;
    this.axes();
    const bank = Math.atan2(this.right.y, this.up.y);
    const w = 1 - THREE.MathUtils.smoothstep(Math.abs(this.fwd.y), 0.85, 0.98);
    this.aim.premultiply(_q.setFromAxisAngle(this.fwd, bank * Math.min(1, c.levelRate * dt) * w)).normalize();
    this.axes();
    this.camera.position.copy(target).addScaledVector(this.up, c.height).addScaledVector(this.fwd, -c.distance);
    this.camera.quaternion.copy(this.aim);
    const fov = THREE.MathUtils.lerp(c.fov + c.speedFov * speedFrac, c.zoomFov, this.zoom);
    if (Math.abs(fov - this.camera.fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
  }
}
