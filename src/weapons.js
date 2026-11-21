import * as THREE from 'three';
import { loadGltfJson } from './gltf.js';
import { FOG_GLSL, fogUniforms } from './world/sky.js';

// Guns, missiles, their effects, and a target drone to shoot at.
//
// Effects follow the usual sim/arcade approach rather than particle confetti:
// - every round is a tracer: a long glowing streak drawn as a camera-facing ribbon from its tail to its head
// - muzzle flashes, motor flames and fireballs are soft additive glows
// - missile smoke is one continuous ribbon trail that widens and fades, not a stream of dots

const CG = new THREE.Vector3(0, 1.9, -0.6);                     // model origin offset used by jet.js
const toBody = (x, y, z) => new THREE.Vector3(x, y, z).sub(CG);
const MUZZLES = [toBody(0.229, 1.936, 5.871), toBody(-0.229, 1.936, 5.871)];   // measured gun ports on the upper nose
const RAILS = [toBody(4.12, 1.31, -1.1), toBody(-4.12, 1.31, -1.1)];            // wingtip launch rails
const G = 9.81;
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();

// ---------------------------------------------------------------- glow / streak sprites (one draw call per blend mode)
class Sprites {
  constructor(max, additive) {
    this.max = max; this.n = 0;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.a = {
      head: new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3),
      tail: new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4),   // xyz tail point, w = 1 streak / 0 round sprite
      col: new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4),    // rgb, intensity or alpha
      size: new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2),   // half width, softness/seed
    };
    for (const [k, v] of Object.entries(this.a)) { v.setUsage(THREE.DynamicDrawUsage); g.setAttribute('a' + k, v); }
    g.instanceCount = 0;
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: { ...fogUniforms, uAdd: { value: additive ? 1 : 0 } },
      vertexShader: /* glsl */`
        attribute vec3 ahead; attribute vec4 atail; attribute vec4 acol; attribute vec2 asize;
        varying vec2 vUv; varying vec4 vCol; varying float vStreak; varying vec3 vWorld; varying float vSeed;
        void main() {
          vec4 h = viewMatrix * vec4(ahead, 1.0);
          vec4 p;
          if (atail.w > 0.5) {
            vec4 t = viewMatrix * vec4(atail.xyz, 1.0);
            vec2 d = h.xy - t.xy; float l = length(d);
            vec2 dir = l > 1e-4 ? d / l : vec2(1.0, 0.0), side = vec2(-dir.y, dir.x);
            float along = position.x * 0.5 + 0.5;
            p = mix(t, h, along);
            p.xy += side * position.y * asize.x + dir * position.x * asize.x;   // round caps
          } else {
            p = h; p.xy += position.xy * asize.x;
          }
          vUv = position.xy; vCol = acol; vStreak = atail.w; vWorld = ahead; vSeed = asize.y;
          gl_Position = projectionMatrix * p;
        }`,
      fragmentShader: /* glsl */`
        uniform float uAdd;
        varying vec2 vUv; varying vec4 vCol; varying float vStreak; varying vec3 vWorld; varying float vSeed;
        ${FOG_GLSL}
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
        void main() {
          float a;
          if (vStreak > 0.5) {
            float across = abs(vUv.y);
            float core = exp(-across * across * 18.0), glow = exp(-across * across * 3.0);
            float along = vUv.x * 0.5 + 0.5;               // 0 tail .. 1 head
            a = (core * 1.6 + glow * 0.5) * mix(0.15, 1.0, along * along);
          } else {
            float r = length(vUv);
            if (r > 1.0) discard;
            float n = noise(vUv * 3.0 + vSeed * 31.0);
            a = smoothstep(1.0, 0.0, r + (n - 0.5) * 0.35 * (1.0 - uAdd));
            a = uAdd > 0.5 ? a * a : a;
          }
          vec3 col = vCol.rgb;
          if (uAdd < 0.5) {                                // smoke: lit and hazed like the rest of the world
            col = applyFog(col, cameraPosition, vWorld);
            gl_FragColor = vec4(col * a * vCol.a, a * vCol.a);
          } else {
            gl_FragColor = vec4(col * a * vCol.a, 0.0);
          }
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 3 : 2;
  }
  begin() { this.n = 0; }
  push(head, tail, r, g, b, i, halfWidth, seed = 0) {
    if (this.n >= this.max) return;
    const k = this.n++;
    this.a.head.array.set([head.x, head.y, head.z], k * 3);
    if (tail) this.a.tail.array.set([tail.x, tail.y, tail.z, 1], k * 4); else this.a.tail.array.set([0, 0, 0, 0], k * 4);
    this.a.col.array.set([r, g, b, i], k * 4);
    this.a.size.array.set([halfWidth, seed], k * 2);
  }
  end() {
    this.mesh.geometry.instanceCount = this.n;
    for (const v of Object.values(this.a)) v.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- missile smoke ribbons
class Trails {
  constructor(maxVerts = 6000) {
    this.max = maxVerts;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(maxVerts * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.alpha = new THREE.BufferAttribute(new Float32Array(maxVerts * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.index = new THREE.BufferAttribute(new Uint32Array(maxVerts * 3), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos); g.setAttribute('aInfo', this.alpha); g.setIndex(this.index);
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: { ...fogUniforms },
      vertexShader: `attribute vec2 aInfo; varying vec2 vInfo; varying vec3 vWorld;
        void main(){ vInfo = aInfo; vWorld = position; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec2 vInfo; varying vec3 vWorld; ${FOG_GLSL}
        void main(){
          float edge = 1.0 - abs(vInfo.y); edge = smoothstep(0.0, 0.7, edge);
          float a = vInfo.x * edge;
          vec3 col = applyFog(vec3(1.0, 1.0, 0.98), cameraPosition, vWorld);
          gl_FragColor = vec4(col * a, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.list = [];
  }
  start() { const t = { pts: [], live: true }; this.list.push(t); return t; }
  update(now, cam) {
    let v = 0, i = 0;
    const P = this.pos.array, A = this.alpha.array, I = this.index.array;
    this.list = this.list.filter(t => t.live || (t.pts.length && now - t.pts[t.pts.length - 1].t < 9));
    for (const t of this.list) {
      while (t.pts.length && now - t.pts[0].t > 9) t.pts.shift();
      const n = t.pts.length;
      if (n < 2 || v + n * 2 > this.max) continue;
      const base = v;
      for (let k = 0; k < n; k++) {
        const p = t.pts[k], q = t.pts[Math.min(k + 1, n - 1)], o = t.pts[Math.max(k - 1, 0)];
        _v.subVectors(q.p, o.p).normalize();                 // trail direction
        _w.subVectors(cam, p.p).normalize();                 // to camera
        const side = _w.cross(_v).normalize();
        const age = now - p.t;
        const width = 0.5 + age * 2.2;
        const fade = Math.max(0, 1 - age / 9) * 0.55 * Math.min(1, (n - 1 - k) / 3 + 0.3);
        P.set([p.p.x + side.x * width, p.p.y + side.y * width, p.p.z + side.z * width], v * 3); A.set([fade, -1], v * 2); v++;
        P.set([p.p.x - side.x * width, p.p.y - side.y * width, p.p.z - side.z * width], v * 3); A.set([fade, 1], v * 2); v++;
        if (k < n - 1) { const a0 = base + k * 2; I.set([a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2], i); i += 6; }
      }
    }
    this.mesh.geometry.setDrawRange(0, i);
    this.pos.needsUpdate = this.alpha.needsUpdate = this.index.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- the weapons
export async function createWeapons(scene, jet, ac, cfg, terrain) {
  const gltf = await loadGltfJson('models/weapons/missiles.gltf.json');
  let src = null;
  gltf.scene.traverse(o => { if (!src && /Sidewinder/i.test(o.name)) src = o; });   // (the loader rewrites spaces in names)
  src.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(src), c = box.getCenter(new THREE.Vector3());
  const proto = new THREE.Group();
  const holder = new THREE.Group(); holder.add(src.clone(true));
  holder.children[0].position.sub(c);                        // centre the missile on its origin
  holder.rotation.y = Math.PI / 2;                           // source nose points -X; ours points +Z
  proto.add(holder);
  proto.traverse(o => { if (o.isMesh) o.material = o.material.clone(); });

  const glow = new Sprites(1500, true), smoke = new Sprites(300, false), trails = new Trails();
  scene.add(glow.mesh, smoke.mesh, trails.mesh);

  // missiles on the rails (in the jet's model, which is offset by -CG inside jet.object)
  const railMeshes = RAILS.map(r => { const m = proto.clone(true); m.position.copy(r).add(CG); jet.model.add(m); return m; });

  const S = {
    selected: 1, firing: false,
    rounds: [], missiles: [], fx: [],
    stock: cfg.missiles, reload: 0, gunAcc: 0, gunSide: 0, flash: [0, 0],
    lock: 0, locked: false, seeker: null,
  };

  // ---------------- target drone: a second copy of the jet flying a wide circle ahead of the player
  const drone = { obj: jet.object.clone(true), hp: 30, alive: true, respawn: 0, t: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), centre: new THREE.Vector3() };
  drone.obj.traverse(o => { if (o.isMesh && o.material.color && !o.material.transparent) { o.material = o.material.clone(); o.material.color.multiplyScalar(0.55).add(new THREE.Color(0.35, 0.05, 0.03)); } });
  scene.add(drone.obj);
  function placeDrone() {
    const f = _v.set(0, 0, 1).applyQuaternion(ac.quat).setY(0).normalize();
    drone.centre.copy(ac.pos).addScaledVector(f, 3200); drone.centre.y = Math.max(ac.pos.y, terrain.heightAt(drone.centre.x, drone.centre.z) + 900);
    drone.hp = 30; drone.alive = true; drone.obj.visible = true; drone.t = Math.random() * 6;
  }
  placeDrone();
  function flyDrone(dt) {
    if (!drone.alive) { if ((drone.respawn -= dt) <= 0) placeDrone(); return; }
    const R = 1700, w = 190 / R;
    drone.t += dt * w;
    const p = new THREE.Vector3(Math.cos(drone.t) * R, Math.sin(drone.t * 0.5) * 120, Math.sin(drone.t) * R).add(drone.centre);
    drone.vel.subVectors(p, drone.pos).divideScalar(Math.max(dt, 1e-3));
    drone.pos.copy(p);
    const fwd = new THREE.Vector3(-Math.sin(drone.t), 0, Math.cos(drone.t)).normalize();
    _m.lookAt(new THREE.Vector3(), fwd.clone().negate(), new THREE.Vector3(0, 1, 0));
    drone.obj.quaternion.setFromRotationMatrix(_m).multiply(_q.setFromAxisAngle(_v.set(0, 0, 1), -0.5));
    drone.obj.position.copy(drone.pos);
  }
  function killDrone() {
    drone.alive = false; drone.obj.visible = false; drone.respawn = 5;
    explode(drone.pos, drone.vel, 1.6);
  }

  // ---------------- effects
  function explode(p, vel, scale = 1) {
    S.fx.push({ kind: 'fire', p: p.clone(), v: vel.clone().multiplyScalar(0.3), t: 0, life: 0.9, s: 9 * scale });
    for (let k = 0; k < 6; k++) {
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).multiplyScalar(18 * scale);
      S.fx.push({ kind: 'smoke', p: p.clone().add(d), v: vel.clone().multiplyScalar(0.15).add(d.multiplyScalar(0.4)), t: -k * 0.04, life: 6 + Math.random() * 3, s: (10 + Math.random() * 8) * scale, seed: Math.random() });
    }
  }
  function spark(p) { S.fx.push({ kind: 'spark', p: p.clone(), v: new THREE.Vector3(), t: 0, life: 0.12, s: 2.5 }); }

  // ---------------- per physics step
  function step(dt, now) {
    flyDrone(dt);
    const fwd = _v.set(0, 0, 1).applyQuaternion(ac.quat);
    // guns
    S.flash[0] = Math.max(0, S.flash[0] - dt); S.flash[1] = Math.max(0, S.flash[1] - dt);
    if (S.firing && S.selected === 1) {
      S.gunAcc += dt * cfg.gunRate;
      while (S.gunAcc >= 1) {
        S.gunAcc -= 1;
        const side = S.gunSide ^= 1;
        const muzzle = MUZZLES[side].clone().applyQuaternion(ac.quat).add(ac.pos);
        const dir = fwd.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, 0).multiplyScalar(cfg.gunSpread).applyQuaternion(ac.quat)).normalize();
        const v = dir.multiplyScalar(cfg.muzzleVelocity).add(ac.vel);
        S.rounds.push({ p: muzzle, prev: muzzle.clone(), start: muzzle.clone(), v, t: 0 });
        S.flash[side] = 0.05;
      }
    } else S.gunAcc = 0;
    for (const r of S.rounds) {
      r.prev.copy(r.p);
      r.v.y -= G * dt;
      r.p.addScaledVector(r.v, dt);
      r.t += dt;
      if (drone.alive && segDist(r.prev, r.p, drone.pos) < 7) { r.t = 1e9; spark(r.p); if (--drone.hp <= 0) killDrone(); }
      else if (r.p.y < terrain.heightAt(r.p.x, r.p.z)) { r.t = 1e9; }
    }
    S.rounds = S.rounds.filter(r => r.t < cfg.roundLife);

    // seeker and lock
    S.seeker = null;
    if (S.selected === 2 && drone.alive && S.stock > 0) {
      const to = _w.subVectors(drone.pos, ac.pos), d = to.length();
      const ang = Math.acos(THREE.MathUtils.clamp(to.dot(fwd) / d, -1, 1)) * 180 / Math.PI;
      const half = cfg.seekerFov / 2;
      if (d < cfg.lockRange && ang < (S.locked ? half * 1.4 : half)) { S.seeker = drone; S.lock = Math.min(S.lock + dt, cfg.lockTime); }
      else S.lock = Math.max(0, S.lock - dt * 3);
    } else S.lock = 0;
    S.locked = S.lock >= cfg.lockTime;

    // reload
    if (S.stock < cfg.missiles) { S.reload += dt; if (S.reload >= cfg.missileReload) { S.reload = 0; S.stock++; } }
    railMeshes.forEach((m, k) => { m.visible = k < S.stock; });

    // missiles in flight
    for (const m of S.missiles) {
      m.t += dt;
      const speed = m.v.length();
      if (m.t > 0.25 && m.t < 0.25 + cfg.motorTime) m.v.addScaledVector(m.dir, cfg.missileThrust * dt);
      m.v.y -= G * dt * 0.3;
      m.v.multiplyScalar(1 - 7.5e-5 * speed * dt);
      if (m.target && m.target.alive && m.t > 0.3) {
        const lead = _w.copy(m.target.pos).addScaledVector(m.target.vel, m.p.distanceTo(m.target.pos) / Math.max(speed, 300));
        const want = lead.sub(m.p).normalize();
        const maxTurn = cfg.missileMaxG * G / Math.max(speed, 1) * dt;
        const ang = Math.acos(THREE.MathUtils.clamp(m.dir.dot(want), -1, 1));
        if (ang > 1e-4) m.dir.lerp(want, Math.min(1, maxTurn / ang)).normalize();
        m.v.copy(m.dir).multiplyScalar(m.v.length());
        if (m.p.distanceTo(m.target.pos) < cfg.proximity) { m.t = 1e9; killDrone(); }
      } else if (speed > 1) m.dir.copy(m.v).normalize();
      m.p.addScaledVector(m.v, dt);
      if (m.p.y < terrain.heightAt(m.p.x, m.p.z)) { explode(m.p, new THREE.Vector3(), 0.6); m.t = 1e9; }
      if (m.t > 0.25 && m.t < 0.25 + cfg.motorTime && now - m.lastPt > 0.04) { m.trail.pts.push({ p: m.p.clone(), t: now }); m.lastPt = now; }
    }
    for (const m of S.missiles) if (m.t >= cfg.missileLife || m.t >= 1e9) { if (m.t < 1e9) explode(m.p, m.v, 0.5); m.trail.live = false; scene.remove(m.obj); }
    S.missiles = S.missiles.filter(m => m.t < cfg.missileLife && m.t < 1e9);
  }

  function fireMissile(now) {
    if (S.stock <= 0) return;
    const k = S.stock - 1;
    S.stock--; S.reload = 0;
    const p = RAILS[k].clone().applyQuaternion(ac.quat).add(ac.pos);
    const obj = proto.clone(true); scene.add(obj);
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(ac.quat);
    S.missiles.push({ obj, p, v: ac.vel.clone().add(_v.set(0, -4, 0).applyQuaternion(ac.quat)), dir, t: 0, target: S.locked ? S.seeker : null, trail: trails.start(), lastPt: now });
    S.lock = 0;
  }

  // ---------------- per frame: draw effects
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  function render(camera, dt, now, alpha, drawPos, drawQuat) {
    glow.begin(); smoke.begin();
    const cam = camera.position;
    // tracers: a long streak behind each round, a little wider with distance so far tracers stay visible
    for (const r of S.rounds) {
      const head = tmpA.copy(r.prev).lerp(r.p, alpha);
      const back = Math.min(cfg.tracerLength, head.distanceTo(r.start));
      const tail = tmpB.copy(r.v).normalize().multiplyScalar(-back).add(head);
      const w = Math.max(cfg.tracerWidth, head.distanceTo(cam) * 0.0011);
      const fade = r.t > cfg.roundLife - 0.4 ? (cfg.roundLife - r.t) / 0.4 : 1;
      glow.push(head, tail, 1.0, 0.62, 0.28, 1.1 * fade, w);
    }
    // muzzle flashes at the gun ports
    for (let k = 0; k < 2; k++) if (S.flash[k] > 0) {
      const m = tmpA.copy(MUZZLES[k]).add(_v.set(0, 0, 0.35)).applyQuaternion(drawQuat).add(drawPos);
      const f = tmpB.copy(m).addScaledVector(_v.set(0, 0, 1).applyQuaternion(drawQuat), 1.2 + Math.random());
      glow.push(f, m, 1.0, 0.75, 0.4, 2.2, 0.35 + Math.random() * 0.15);
      glow.push(m, null, 1.0, 0.7, 0.35, 1.2, 0.9 + Math.random() * 0.3, Math.random());
    }
    // missiles: body follows its path, motor flame while burning
    for (const m of S.missiles) {
      m.obj.position.copy(m.p);
      m.obj.quaternion.setFromUnitVectors(_v.set(0, 0, 1), m.dir);
      if (m.t > 0.25 && m.t < 0.25 + cfg.motorTime) {
        const tailP = tmpA.copy(m.dir).multiplyScalar(-1.5).add(m.p);
        const end = tmpB.copy(m.dir).multiplyScalar(-4 - Math.random() * 1.5).add(m.p);
        glow.push(tailP, end, 1.0, 0.8, 0.55, 2.4, 0.35);
        glow.push(tailP, null, 1.0, 0.85, 0.6, 2.0, 0.9 + Math.random() * 0.4, Math.random());
      }
    }
    // explosions, smoke, sparks
    for (const e of S.fx) {
      e.t += dt; if (e.t < 0) continue;
      e.p.addScaledVector(e.v, dt); e.v.multiplyScalar(1 - dt * 0.8);
      const k = e.t / e.life;
      if (e.kind === 'fire') {
        glow.push(e.p, null, 1.0, 0.55 + 0.3 * (1 - k), 0.2, 3.0 * (1 - k) * (1 - k), e.s * (0.4 + k * 0.9), 0.3);
        glow.push(e.p, null, 1.0, 0.9, 0.7, 4.0 * Math.max(0, 1 - k * 3), e.s * 0.5, 0.7);
      } else if (e.kind === 'smoke') {
        const g = 0.16 + 0.1 * e.seed;
        smoke.push(e.p, null, g, g, g * 1.05, 0.85 * Math.min(1, e.t * 4) * (1 - k), e.s * (0.6 + k * 1.6), e.seed);
      } else glow.push(e.p, null, 1.0, 0.85, 0.55, 3.0 * (1 - k), e.s, 0.5);
    }
    S.fx = S.fx.filter(e => e.t < e.life);
    // drone afterburner glow so it reads at a distance
    glow.end(); smoke.end();
    trails.update(now, cam);
  }

  return {
    S, drone,
    setFiring(on, now) {
      if (on && !S.firing && S.selected === 2) fireMissile(now);
      S.firing = on;
    },
    select(k) { S.selected = k; S.lock = 0; },
    step, render,
  };
}

function segDist(a, b, p) {
  const ab = _v.subVectors(b, a), ap = _w.subVectors(p, a);
  const t = THREE.MathUtils.clamp(ap.dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
  return ap.sub(ab.multiplyScalar(t)).length();
}
