import * as THREE from 'three';
import { loadGltfJson } from './gltf.js';
import { Damage, attachToPart } from './damage.js';
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
// six stations, measured from the mesh; fired from the end of the list (wingtips first, then outer, then inner pylons)
const RAILS = [
  toBody(2.265, 1.07, -0.8), toBody(-2.425, 1.07, -0.8),     // inner pylons (bottom at y 1.144, z -1.57..-0.03)
  toBody(3.255, 1.07, -1.15), toBody(-3.415, 1.07, -1.15),   // outer pylons (z -1.92..-0.37)
  toBody(4.12, 1.31, -1.1), toBody(-4.12, 1.31, -1.1),       // wingtip rails
];
const G = 9.81;
const IGNITE = 0.12;   // s after release before the motor lights
const _q2 = new THREE.Vector3();
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
          float streak = atail.w;
          if (atail.w > 0.5) {
            vec4 t = viewMatrix * vec4(atail.xyz, 1.0);
            // on screen, how long is the streak compared with its width? end-on (looking along the round's path)
            // it is a dot, so draw a round glow instead of a collapsed sliver
            vec2 ps = (projectionMatrix * h).xy / max((projectionMatrix * h).w, 1e-4) - (projectionMatrix * t).xy / max((projectionMatrix * t).w, 1e-4);
            float wClip = asize.x / max(-h.z, 1e-3) * projectionMatrix[1][1];
            if (length(ps) < wClip * 3.0) { streak = 0.0; p = h; p.xy += position.xy * asize.x * 1.6; }
            else {
              vec2 d = h.xy - t.xy; float l = length(d);
              vec2 dir = l > 1e-4 ? d / l : vec2(1.0, 0.0), side = vec2(-dir.y, dir.x);
              float along = position.x * 0.5 + 0.5;
              p = mix(t, h, along);
              p.xy += side * position.y * asize.x;
            }
          } else {
            p = h; p.xy += position.xy * asize.x;
          }
          vUv = position.xy; vCol = acol; vStreak = streak; vWorld = ahead; vSeed = asize.y;
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
            float core = exp(-across * across * 14.0), glow = exp(-across * across * 2.2);
            float along = vUv.x * 0.5 + 0.5;               // 0 tail .. 1 head
            a = (core * 2.0 + glow * 0.7) * mix(0.1, 1.0, along * along) * smoothstep(1.0, 0.8, along);   // soft tip, no square front
          } else {
            float r = length(vUv);
            if (r > 1.0) discard;
            float n = noise(vUv * 3.0 + vSeed * 31.0);
            float n2 = noise(vUv * 6.0 - vSeed * 17.0);
            a = smoothstep(1.0, 0.15, r + (n - 0.5) * 0.55 * (1.0 - uAdd) + (n2 - 0.5) * 0.25 * (1.0 - uAdd));
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
// One continuous ribbon per missile. It starts as a tight, dense line right behind the motor, then billows:
// it widens, drifts on the wind and breaks up with noise along its length, lit brighter on the sun side.
class Trails {
  constructor(maxVerts = 8000) {
    this.max = maxVerts;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(maxVerts * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.info = new THREE.BufferAttribute(new Float32Array(maxVerts * 4), 4).setUsage(THREE.DynamicDrawUsage);   // fade, across, distance, age
    this.index = new THREE.BufferAttribute(new Uint32Array(maxVerts * 3), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos); g.setAttribute('aInfo', this.info); g.setIndex(this.index);
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: { ...fogUniforms },
      vertexShader: `attribute vec4 aInfo; varying vec4 vInfo; varying vec3 vWorld;
        void main(){ vInfo = aInfo; vWorld = position; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec4 vInfo; varying vec3 vWorld; ${FOG_GLSL}
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
        void main(){
          float across = vInfo.y, dist = vInfo.z, age = vInfo.w;
          vec2 q = vec2(dist * 0.06, across * 1.5 + age * 0.15);
          float n = noise(q) * 0.55 + noise(q * 2.3 + 7.0) * 0.3 + noise(q * 5.1 - 3.0) * 0.15;
          // three stages along the trail: hot exhaust right behind the motor, a solid dark-grey smoke rope,
          // then (with age) a lighter, puffier white that breaks up
          float hot = 1.0 - smoothstep(0.05, 0.3, age);
          float puff = smoothstep(1.2, 4.0, age);
          float edgeSoft = mix(0.75, 0.35 + 0.35 * n, puff);
          float body = 1.0 - smoothstep(edgeSoft, 1.0, abs(across));
          float breakup = mix(1.0, smoothstep(0.3, 0.75, n), smoothstep(2.0, 5.0, age));
          float a = vInfo.x * body * breakup * smoothstep(6.0, 45.0, length(vWorld - cameraPosition));
          if (a < 0.003) discard;
          float lit = 0.5 + 0.5 * clamp(uSunDir.y * 0.8 + across * 0.35 + (n - 0.5) * 0.6 * puff, 0.0, 1.0);
          vec3 smoke = mix(vec3(0.2, 0.2, 0.2), vec3(0.42, 0.41, 0.4), lit);
          vec3 white = mix(vec3(0.55, 0.55, 0.56), vec3(0.9, 0.89, 0.86), lit);
          vec3 col = applyFog(mix(smoke, white, puff), cameraPosition, vWorld);
          col = mix(col, vec3(1.0, 0.78, 0.5) * 1.6, hot);             // glowing exhaust next to the motor
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
    this.wind = new THREE.Vector3(3, 0.6, 1.5);   // m/s drift
  }
  start() { const t = { pts: [], live: true, dist: 0, seed: Math.random() * 100 }; this.list.push(t); return t; }
  add(t, p, now) {
    const last = t.pts[t.pts.length - 1];
    if (last) t.dist += last.p.distanceTo(p);
    t.pts.push({ p: p.clone(), t: now, d: t.dist, drift: new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.4, Math.random() - 0.5).multiplyScalar(1.2) });
  }
  update(now, cam) {
    const LIFE = 10;
    let v = 0, i = 0;
    const P = this.pos.array, A = this.info.array, I = this.index.array;
    this.list = this.list.filter(t => t.live || (t.pts.length && now - t.pts[t.pts.length - 1].t < LIFE));
    const tmp = new THREE.Vector3(), q0 = new THREE.Vector3(), q1 = new THREE.Vector3();
    for (const t of this.list) {
      while (t.pts.length && now - t.pts[0].t > LIFE) t.pts.shift();
      const n = t.pts.length;
      if (n < 2 || v + n * 2 > this.max) continue;
      const base = v;
      // with age the trail wanders: slow, smooth meanders along its length that grow as the smoke spreads
      const at = (k, out) => {
        const p = t.pts[k], age = now - p.t, m = Math.pow(Math.max(0, age - 0.6), 1.25);
        return out.copy(p.p).addScaledVector(this.wind, age).addScaledVector(p.drift, age)
          .add(_q2.set(Math.sin(p.d * 0.045 + t.seed) + 0.5 * Math.sin(p.d * 0.13 + t.seed * 2), 0.6 * Math.sin(p.d * 0.06 + t.seed * 3), Math.cos(p.d * 0.05 + t.seed * 4) + 0.5 * Math.cos(p.d * 0.11 + t.seed)).multiplyScalar(0.9 * m));
      };
      for (let k = 0; k < n; k++) {
        const p = t.pts[k], age = now - p.t;
        const c = at(k, tmp);
        at(Math.min(k + 1, n - 1), q1); at(Math.max(k - 1, 0), q0);
        _v.subVectors(q1, q0).normalize();
        _w.subVectors(cam, c).normalize();
        const side = _w.cross(_v).normalize();
        const width = 0.22 + 0.9 * (1 - Math.exp(-age / 0.8)) + 3.6 * Math.max(0, age - 1.2) / (1 + Math.max(0, age - 1.2) * 0.3) + 0.8 * Math.sin(p.d * 0.21 + t.seed) * Math.min(1, Math.max(0, age - 1.5) / 3);   // tight near the missile, billowing and lumpy later
        const fromHead = (n - 1 - k);
        const fade = Math.pow(Math.max(0, 1 - age / LIFE), 1.5) * (age < 1.5 ? 0.85 : 0.85 - 0.45 * Math.min(1, (age - 1.5) / 2.5)) * Math.min(1, fromHead / 2 + 0.4);   // solid near the missile
        P.set([c.x + side.x * width, c.y + side.y * width, c.z + side.z * width], v * 3); A.set([fade, -1, p.d, age], v * 4); v++;
        P.set([c.x - side.x * width, c.y - side.y * width, c.z - side.z * width], v * 3); A.set([fade, 1, p.d, age], v * 4); v++;
        if (k < n - 1) { const a0 = base + k * 2; I.set([a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2], i); i += 6; }
      }
    }
    this.mesh.geometry.setDrawRange(0, i);
    this.pos.needsUpdate = this.info.needsUpdate = this.index.needsUpdate = true;
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

  const glow = new Sprites(2000, true), smoke = new Sprites(2500, false), trails = new Trails();
  scene.add(glow.mesh, smoke.mesh, trails.mesh);

  // missiles on the rails (in the jet's model, which is offset by -CG inside jet.object)
  const railMeshes = RAILS.map(r => { const m = proto.clone(true); m.position.copy(r).add(CG); jet.model.add(m); attachToPart(jet.model, m); return m; });

  const S = {
    selected: 1, firing: false,
    rounds: [], missiles: [], fx: [],
    stock: cfg.missiles, reload: 0, gunAcc: 0, gunSide: 0, flash: [0, 0],
    lock: 0, locked: false, seeker: null,
  };

  // ---------------- damage: player and drone share the same model and effects
  // smoke and flame are laid down by distance travelled (plus a slow tick when standing still),
  // so fast debris leaves a continuous trail instead of a row of dots
  const lastAt = new WeakMap();
  const puffSmoke = (p, light) => S.fx.push({ kind: 'smoke', p: p.clone(), v: new THREE.Vector3((Math.random() - 0.5) * 2, 2 + Math.random() * 2, (Math.random() - 0.5) * 2), t: 0, life: 4 + Math.random() * 2, s: 1.8 + Math.random() * 1.4, seed: Math.random(), dark: light ? 0 : 1 });
  const puffFlame = (p, v) => S.fx.push({ kind: 'flame', p: p.clone(), v: v ? v.clone().multiplyScalar(0.15) : new THREE.Vector3(), t: 0, life: 0.35, s: 0.7 + Math.random() * 0.6 });
  const emit = (kind, p, v, key) => {
    if (kind === 'impact') return explode(p, new THREE.Vector3(), 0.6);
    if (kind === 'groundfire') return fires.push({ p: p.clone(), t: 0, life: v ? 25 : 10, big: !!v, tS: 0, tF: 0 });
    const make = kind === 'smoke' ? (q) => puffSmoke(q) : (q) => puffFlame(q, v);
    const spacing = kind === 'smoke' ? 1.4 : 0.9;
    if (!key) { make(p); return; }
    let st = lastAt.get(key);
    if (!st) { st = { [kind]: { p: p.clone(), t: 0 } }; lastAt.set(key, st); make(p); return; }
    let e = st[kind];
    if (!e) { st[kind] = { p: p.clone(), t: 0 }; make(p); return; }
    const d = e.p.distanceTo(p);
    if (d >= spacing) {
      const n = Math.min(Math.floor(d / spacing), 40);
      for (let k = 1; k <= n; k++) make(e.p.clone().lerp(p, k / n));
      e.p.copy(p); e.t = 0;
    } else if ((e.t += 1 / 60) > 0.1) { make(p); e.t = 0; e.p.copy(p); }
  };
  // things burning on the ground: crash sites and landed debris
  const fires = [];

  jet.damage = new Damage(jet.model, scene, terrain, emit);

  // ---------------- target drone: a second copy of the jet flying a wide circle ahead of the player
  const drone = { obj: jet.object.clone(true), alive: true, falling: false, respawn: 0, t: 0, spin: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), centre: new THREE.Vector3() };
  drone.obj.traverse(o => { if (o.isMesh && o.material.color && !o.material.transparent) { o.material = o.material.clone(); o.material.color.multiplyScalar(0.55).add(new THREE.Color(0.35, 0.05, 0.03)); } });
  scene.add(drone.obj);
  drone.model = drone.obj.children[0];
  drone.dmg = new Damage(drone.model, scene, terrain, emit);
  function placeDrone() {
    drone.dmg.repair();
    const f = _v.set(0, 0, 1).applyQuaternion(ac.quat).setY(0).normalize();
    drone.centre.copy(ac.pos).addScaledVector(f, 3200); drone.centre.y = Math.max(ac.pos.y, terrain.heightAt(drone.centre.x, drone.centre.z) + 900);
    drone.alive = true; drone.falling = false; drone.obj.visible = true; drone.t = Math.random() * 6;
  }
  placeDrone();
  function flyDrone(dt) {
    drone.dmg.update(dt);
    if (!drone.alive) { if ((drone.respawn -= dt) <= 0) placeDrone(); return; }
    if (drone.falling) {                      // killed: falls burning, tumbling, and blows up on the ground
      drone.vel.y -= 9.81 * dt; drone.vel.multiplyScalar(1 - 0.05 * dt);
      drone.pos.addScaledVector(drone.vel, dt);
      drone.obj.position.copy(drone.pos);
      drone.obj.rotateZ(drone.spin * dt); drone.obj.rotateX(0.4 * dt);
      if ((drone.smokeT = (drone.smokeT || 0) - dt) <= 0) { drone.smokeT = 0.04; const c = drone.obj.getWorldPosition(new THREE.Vector3()); emit('smoke', c, drone.vel); emit('flame', c, drone.vel); }
      if (drone.pos.y < terrain.heightAt(drone.pos.x, drone.pos.z) + 2) {
        explode(drone.pos, drone.vel, 2.0);
        // a charred wreck stays on the ground and burns, with a smoke column drifting downwind
        const wreck = drone.obj.clone(true);
        wreck.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); if (o.material.color) o.material.color.multiplyScalar(0.18); } });
        const g = terrain.heightAt(drone.pos.x, drone.pos.z);
        wreck.position.set(drone.pos.x, g + 0.6, drone.pos.z);
        wreck.rotation.set((Math.random() - 0.5) * 0.3, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.5);
        scene.add(wreck);
        setTimeout(() => wreck.removeFromParent(), 40000);
        emit('groundfire', wreck.position, new THREE.Vector3(1, 0, 0));
        drone.alive = false; drone.obj.visible = false; drone.respawn = 5;
      }
      return;
    }
    const R = 1700, w = 190 / R;
    drone.t += dt * w;
    const p = new THREE.Vector3(Math.cos(drone.t) * R, Math.sin(drone.t * 0.5) * 120, Math.sin(drone.t) * R).add(drone.centre);
    drone.vel.subVectors(p, drone.pos).divideScalar(Math.max(dt, 1e-3));
    drone.pos.copy(p);
    const fwd = new THREE.Vector3(-Math.sin(drone.t), 0, Math.cos(drone.t)).normalize();
    const fx = drone.dmg.effects();
    const wobble = fx.wobble * 0.25 * Math.sin(drone.t * 9) + fx.rollBias * 0.6;   // damaged: rocks and leans toward the missing tip
    _m.lookAt(new THREE.Vector3(), fwd.clone().negate(), new THREE.Vector3(0, 1, 0));
    drone.obj.quaternion.setFromRotationMatrix(_m).multiply(_q.setFromAxisAngle(_v.set(0, 0, 1), -0.5 + wobble));
    drone.obj.position.copy(drone.pos);
  }
  function killDrone() {
    if (drone.falling) return;
    drone.falling = true; drone.spin = (Math.random() < 0.5 ? -1 : 1) * (1.5 + Math.random() * 2);
    S.fx.push({ kind: 'fire', p: drone.pos.clone(), v: drone.vel.clone().multiplyScalar(0.3), t: 0, life: 0.3, s: 12 });
  }

  // ---------------- effects
  // War Thunder-style blast: a short flash, a cluster of irregular fire puffs that roll outward and up and
  // cool from white-yellow through orange and deep red to brown smoke, lingering smoke, and burning debris.
  function explode(p, vel, scale = 1) {
    const carry = vel.clone().multiplyScalar(0.25);
    S.fx.push({ kind: 'fire', p: p.clone(), v: carry.clone(), t: 0, life: 0.18, s: 18 * scale });
    const n = Math.round(9 + 7 * scale);
    for (let k = 0; k < n; k++) {
      const d = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 0.6, Math.random() * 2 - 1).normalize();
      const sp = (8 + Math.random() * 22) * scale;
      S.fx.push({ kind: 'ball', p: p.clone().addScaledVector(d, Math.random() * 3 * scale), v: d.multiplyScalar(sp).add(carry), t: -Math.random() * 0.1,
        life: (1.0 + Math.random() * 1.1) * (0.8 + 0.25 * scale), s: (3 + Math.random() * 3.5) * scale, seed: Math.random() });
    }
    for (let k = 0; k < 7; k++) {
      const d = new THREE.Vector3(Math.random() - 0.5, 0.3 + Math.random() * 0.5, Math.random() - 0.5).multiplyScalar(6 * scale);
      S.fx.push({ kind: 'smoke', p: p.clone().addScaledVector(d, 1), v: d.add(carry).add(new THREE.Vector3(0, 3, 0)), t: -0.35 - Math.random() * 0.6,
        life: 7 + Math.random() * 4, s: (6 + Math.random() * 5) * scale, seed: Math.random(), dark: 1, rise: 1 });
    }
    for (let k = 0; k < Math.round(10 * scale) + 4; k++) {
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 - 0.15, Math.random() - 0.5).normalize().multiplyScalar((35 + Math.random() * 60) * scale);
      S.fx.push({ kind: 'ember', p: p.clone(), v: d.add(carry), t: 0, life: 1.2 + Math.random() * 1.6, s: 0.45 + Math.random() * 0.4 });
    }
  }
  function spark(p) { S.fx.push({ kind: 'spark', p: p.clone(), v: new THREE.Vector3(), t: 0, life: 0.12, s: 2.5 }); }

  // ---------------- per physics step
  function step(dt, now) {
    flyDrone(dt);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(ac.quat);   // own vector: _v/_w are reused below
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
      if (drone.alive && !drone.falling && segDist(r.prev, r.p, drone.pos) < 7) {
        r.t = 1e9; const at = closestOnSeg(r.prev, r.p, drone.pos); spark(at);
        drone.dmg.hit(at, drone.vel);
        if (drone.dmg.dead) killDrone();
      }
      else if (r.p.y < terrain.heightAt(r.p.x, r.p.z)) { r.t = 1e9; }
    }
    S.rounds = S.rounds.filter(r => r.t < cfg.roundLife);

    // seeker and lock
    S.seeker = null;
    if (S.selected === 2 && drone.alive && !drone.falling && S.stock > 0) {
      const to = _w.subVectors(drone.pos, ac.pos), d = to.length();
      const ang = Math.acos(THREE.MathUtils.clamp(to.dot(fwd) / d, -1, 1)) * 180 / Math.PI;
      const half = cfg.seekerFov / 2;
      if (d < cfg.lockRange && ang < (S.locked ? half * 1.4 : half)) { S.seeker = drone; S.lock = Math.min(S.lock + dt, cfg.lockTime); }
      else S.lock = Math.max(0, S.lock - dt * 3);
    } else S.lock = 0;
    S.locked = S.lock >= cfg.lockTime;

    // reload
    railMeshes.forEach((m, k) => { m.visible = k < S.stock; });

    // missiles in flight
    for (const m of S.missiles) {
      m.t += dt;
      m.prev.copy(m.p);
      const speed = m.v.length();
      if (m.t > IGNITE && m.t < IGNITE + cfg.motorTime) m.v.addScaledVector(m.dir, cfg.missileThrust * dt);
      if (m.t > IGNITE) { m.v.y -= G * dt * 0.3; m.v.multiplyScalar(1 - 7.5e-5 * speed * dt); }
      if (m.target && m.target.alive && m.t > 0.3) {
        const lead = _w.copy(m.target.pos).addScaledVector(m.target.vel, m.p.distanceTo(m.target.pos) / Math.max(speed, 300));
        const want = lead.sub(m.p).normalize();
        const maxTurn = cfg.missileMaxG * G / Math.max(speed, 1) * dt;
        const ang = Math.acos(THREE.MathUtils.clamp(m.dir.dot(want), -1, 1));
        if (ang > 1e-4) m.dir.lerp(want, Math.min(1, maxTurn / ang)).normalize();
        const sp = m.v.length();                      // (read the speed before overwriting the vector)
        m.v.copy(m.dir).multiplyScalar(sp);
        // fuse only arms once well clear of the launching jet; missiles never damage the player
        const armed = m.t > 0.5 && m.p.distanceTo(ac.pos) > 150;
        if (armed && !m.target.falling && m.p.distanceTo(m.target.pos) < cfg.proximity) {
          m.t = 1e9; explode(m.p, m.target.vel, 0.8);
          // the blast tears off what was closest to it, then the jet goes down
          const near = Object.keys(m.target.dmg.parts).sort((a, b) => m.target.dmg.parts[a].obj.getWorldPosition(_v).distanceTo(m.p) - m.target.dmg.parts[b].obj.getWorldPosition(_w).distanceTo(m.p));
          near.slice(0, 2).forEach(n => m.target.dmg.breakPart(n, m.target.vel));
          killDrone();
        }
      } else if (speed > 1) m.dir.copy(m.v).normalize();
      m.p.addScaledVector(m.v, dt);
      if (m.p.y < terrain.heightAt(m.p.x, m.p.z)) { explode(m.p, new THREE.Vector3(), 0.6); m.t = 1e9; }
      if (m.t > IGNITE && m.t < IGNITE + cfg.motorTime && now - m.lastPt > 0.03) { trails.add(m.trail, m.p, now); m.lastPt = now; }
    }
    for (const m of S.missiles) if (m.t >= cfg.missileLife || m.t >= 1e9) { if (m.t < 1e9) explode(m.p, m.v, 0.5); m.trail.live = false; scene.remove(m.obj); }
    S.missiles = S.missiles.filter(m => m.t < cfg.missileLife && m.t < 1e9);
  }

  function fireMissile(now) {
    if (S.stock <= 0) return;
    const k = S.stock - 1;
    S.stock--;
    const p = RAILS[k].clone().applyQuaternion(ac.quat).add(ac.pos);
    const obj = proto.clone(true); scene.add(obj);
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(ac.quat);
    S.missiles.push({ obj, p, prev: p.clone(), v: ac.vel.clone().add(_v.set(0, -4, 0).applyQuaternion(ac.quat)), dir, t: 0, target: S.locked ? S.seeker : null, trail: trails.start(), lastPt: now });
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
      const w = Math.max(cfg.tracerWidth, head.distanceTo(cam) * cfg.tracerMinPixels);
      const fade = r.t > cfg.roundLife - 0.4 ? (cfg.roundLife - r.t) / 0.4 : 1;
      glow.push(head, tail, 1.0, 0.32, 0.14, 1.1 * fade, w);                                       // red-orange streak
      // a bright glowing head on every round, so tracers read from any angle, including straight from behind
      glow.push(head, null, 1.0, 0.5, 0.3, 1.25 * fade, Math.max(0.3, head.distanceTo(cam) * cfg.tracerMinPixels * 1.8), 0.5);
    }
    // muzzle flashes at the gun ports
    for (let k = 0; k < 2; k++) if (S.flash[k] > 0) {
      // small and quick: a short forward spit of flame and a little glow at the port, flickering shot to shot
      if (Math.random() < 0.25) continue;
      const m = tmpA.copy(MUZZLES[k]).add(_v.set(0, 0, 0.12)).applyQuaternion(drawQuat).add(drawPos);
      const f = tmpB.copy(m).addScaledVector(_v.set(0, 0, 1).applyQuaternion(drawQuat), 0.45 + Math.random() * 0.35);
      glow.push(f, m, 1.0, 0.72, 0.38, 1.0, 0.07 + Math.random() * 0.04);
      glow.push(m, null, 1.0, 0.7, 0.4, 0.7, 0.2 + Math.random() * 0.1, Math.random());
    }
    // missiles: body follows its path, motor flame while burning
    for (const m of S.missiles) {
      m.obj.position.copy(m.prev).lerp(m.p, alpha);
      m.obj.quaternion.setFromUnitVectors(_v.set(0, 0, 1), m.dir);
      if (m.t > IGNITE && m.t < IGNITE + cfg.motorTime) {
        const tailP = tmpA.copy(m.dir).multiplyScalar(-1.5).add(m.obj.position);
        const end = tmpB.copy(m.dir).multiplyScalar(-4 - Math.random() * 1.5).add(m.obj.position);
        glow.push(tailP, end, 1.0, 0.6, 0.28, 1.3, 0.28);
        glow.push(tailP, null, 1.0, 0.62, 0.3, 0.9, 0.6 + Math.random() * 0.3, Math.random());
      }
    }
    // ground fires: flames licking up and a smoke column drifting downwind
    for (const f of fires) {
      f.t += dt;
      const k = f.t / f.life, big = f.big ? 1 : 0.55, power = Math.min(1, (1 - k) * 2.5);
      if ((f.tF -= dt) <= 0) {
        f.tF = 0.06 / big;
        const off = new THREE.Vector3((Math.random() - 0.5) * 7 * big, 0, (Math.random() - 0.5) * 7 * big);
        S.fx.push({ kind: 'ball', p: f.p.clone().add(off), v: new THREE.Vector3(1.5, 5 + Math.random() * 5, 1), t: 0, life: 0.9 + Math.random() * 0.6, s: (1.6 + Math.random() * 1.8) * big * (0.4 + 0.6 * power), seed: Math.random(), ground: 1 });
      }
      if ((f.tS -= dt) <= 0) {
        f.tS = 0.14 / big;
        S.fx.push({ kind: 'smoke', p: f.p.clone().add(new THREE.Vector3(0, 4 * big, 0)), v: new THREE.Vector3(3 + Math.random() * 2, 7 + Math.random() * 4, 1.5 + Math.random()), t: 0, life: 9 + Math.random() * 4, s: (3 + Math.random() * 2.5) * big, seed: Math.random(), dark: 1, rise: 1 });
      }
    }
    for (let i = fires.length - 1; i >= 0; i--) if (fires[i].t > fires[i].life) fires.splice(i, 1);

    // explosions, smoke, fire
    for (const e of S.fx) {
      e.t += dt; if (e.t < 0) continue;
      e.p.addScaledVector(e.v, dt); e.v.multiplyScalar(1 - dt * (e.kind === 'ball' ? 2.2 : 0.8));
      const k = e.t / e.life;
      if (e.kind === 'ball') {
        e.v.y += dt * 9 * k;                                   // hot gas rises as it slows
        const c = fireRamp(k);
        const alpha = k < 0.6 ? 0.95 : 0.95 * (1 - (k - 0.6) / 0.4);
        smoke.push(e.p, null, c[0], c[1], c[2], alpha * Math.min(1, e.t * 20), e.s * (0.55 + 1.3 * Math.sqrt(k)), e.seed);
      } else if (e.kind === 'fire') {
        glow.push(e.p, null, 1.0, 0.75, 0.45, 3.5 * (1 - k), e.s * (0.6 + k * 0.6), 0.3);
      } else if (e.kind === 'smoke') {
        if (e.rise) e.v.y += dt * 0.6;
        const g = e.dark ? 0.1 + 0.07 * e.seed : 0.42 + 0.1 * e.seed;       // dark grey-brown, not pure black
        smoke.push(e.p, null, g * 1.08, g, g * 0.92, 0.7 * Math.min(1, e.t * 3) * Math.pow(1 - k, 1.4), e.s * (0.6 + k * 1.9), e.seed);
      } else if (e.kind === 'flame') {
        glow.push(e.p, null, 1.0, 0.3 + 0.25 * (1 - k), 0.03, 0.75 * (1 - k), e.s * (0.8 + k * 0.8), Math.random());
      } else if (e.kind === 'ember') {
        e.v.y -= G * dt;
        const tail = tmpB.copy(e.v).multiplyScalar(-0.06).add(e.p);
        glow.push(e.p, tail, 1.0, 0.45 + 0.3 * (1 - k), 0.08, 2.2 * (1 - k * 0.7), e.s * 0.6);
        emit('smoke', e.p, e.v, e);
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
    rearm() { S.stock = cfg.missiles; S.firing = false; },
    explode,   // (used by the dev tests)
    step, render,
  };
}

function segDist(a, b, p) {
  const ab = _v.subVectors(b, a), ap = _w.subVectors(p, a);
  const t = THREE.MathUtils.clamp(ap.dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
  return ap.sub(ab.multiplyScalar(t)).length();
}

function closestOnSeg(a, b, p) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const t = THREE.MathUtils.clamp(new THREE.Vector3().subVectors(p, a).dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
  return a.clone().addScaledVector(ab, t);
}

// fire colour over a puff's life: white-yellow, orange, deep red, then brown smoke (emissive values above 1 glow)
const RAMP = [[0, 2.4, 2.0, 1.1], [0.12, 2.2, 1.05, 0.28], [0.3, 1.4, 0.38, 0.07], [0.5, 0.42, 0.13, 0.05], [0.72, 0.15, 0.12, 0.1], [1, 0.13, 0.12, 0.11]];
function fireRamp(k) {
  for (let i = 1; i < RAMP.length; i++) if (k <= RAMP[i][0]) {
    const a = RAMP[i - 1], b = RAMP[i], t = (k - a[0]) / (b[0] - a[0]);
    return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
  }
  return RAMP[RAMP.length - 1].slice(1);
}
