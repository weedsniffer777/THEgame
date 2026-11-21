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
          float breakup = mix(1.0, smoothstep(0.25, 0.7, n), smoothstep(2.5, 6.0, age));
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
  start() { const t = { pts: [], live: true, dist: 0 }; this.list.push(t); return t; }
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
      const at = (k, out) => { const p = t.pts[k], age = now - p.t; return out.copy(p.p).addScaledVector(this.wind, age).addScaledVector(p.drift, age); };
      for (let k = 0; k < n; k++) {
        const p = t.pts[k], age = now - p.t;
        const c = at(k, tmp);
        at(Math.min(k + 1, n - 1), q1); at(Math.max(k - 1, 0), q0);
        _v.subVectors(q1, q0).normalize();
        _w.subVectors(cam, c).normalize();
        const side = _w.cross(_v).normalize();
        const width = 0.22 + 0.9 * (1 - Math.exp(-age / 0.8)) + 2.6 * Math.max(0, age - 1.2) / (1 + Math.max(0, age - 1.2) * 0.4);   // a tight rope near the missile, billowing later
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

// ---------------------------------------------------------------- volumetric explosions
// Each explosion is a sphere whose inside is ray-marched through 3D noise: a hot, glowing, billowing core that
// cools into a lumpy grey smoke ball which rises, swells and thins out. Lit by the sun on the smoke.
const VOL_VS = `varying vec3 vLocal; void main(){ vLocal = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const VOL_FS = `
uniform vec3 uCam; uniform float uAge; uniform float uSeed; uniform vec3 uCentre; uniform float uFade;
varying vec3 vLocal;
${FOG_GLSL}
float h3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float n3(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { return n3(p) * 0.55 + n3(p * 2.1 + 3.1) * 0.3 + n3(p * 4.3 - 1.7) * 0.15; }
void main() {
  vec3 ro = uCam, rd = normalize(vLocal - uCam);
  float b = dot(ro, rd), c = dot(ro, ro) - 1.0, disc = b * b - c;
  if (disc < 0.0) discard;
  float sq = sqrt(disc), t0 = max(-b - sq, 0.0), t1 = -b + sq;
  const int STEPS = 22;
  float dt = (t1 - t0) / float(STEPS);
  vec3 col = vec3(0.0); float T = 1.0;
  float heatAge = clamp(1.0 - uAge * 1.5, 0.0, 1.0);
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * (t0 + (float(i) + 0.5) * dt);
    float r = length(p);
    float n = fbm(p * 2.4 + vec3(uSeed, uSeed * 0.7 - uAge * 1.2, uSeed * 1.3));
    float d = clamp((0.9 - r) * 2.6 + (n - 0.5) * 2.2, 0.0, 1.0);
    if (d <= 0.0) continue;
    float heat = heatAge * smoothstep(0.85, 0.1, r + (n - 0.5) * 0.6);
    vec3 fire = mix(vec3(1.0, 0.18, 0.0), vec3(1.0, 0.72, 0.12), heat * heat) * heat * 11.0;
    float lit = clamp(dot(normalize(p + 1e-4), uSunDir) * 0.5 + 0.5, 0.0, 1.0);
    vec3 smoke = mix(vec3(0.012, 0.011, 0.01), vec3(0.13, 0.12, 0.11), lit * lit) * mix(0.5, 1.0, n);
    float dens = d * 12.0 * dt;
    col += T * (fire + smoke * (1.0 - heat)) * dens;
    T *= exp(-dens * 1.4);
    if (T < 0.02) break;
  }
  float a = (1.0 - T) * uFade;
  col = applyFog(col / max(1.0 - T, 1e-3), cameraPosition, uCentre) * a;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

class Explosions {
  constructor(scene) {
    this.scene = scene; this.list = [];
    this.geo = new THREE.SphereGeometry(1, 24, 16);
  }
  spawn(p, vel, scale) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...fogUniforms, uCam: { value: new THREE.Vector3() }, uAge: { value: 0 }, uSeed: { value: Math.random() * 50 }, uCentre: { value: new THREE.Vector3() }, uFade: { value: 1 } },
      vertexShader: VOL_VS, fragmentShader: VOL_FS,
      transparent: true, depthWrite: false, side: THREE.BackSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.renderOrder = 2;
    this.scene.add(mesh);
    this.list.push({ mesh, p: p.clone(), v: vel.clone().multiplyScalar(0.25), t: 0, life: 7, s: scale });
  }
  update(dt, cam) {
    for (const e of this.list) {
      e.t += dt;
      e.v.multiplyScalar(1 - dt * 1.2); e.v.y += dt * 1.5;          // slows down, smoke rises
      e.p.addScaledVector(e.v, dt);
      const k = e.t / e.life;
      const R = e.s * (5 + 11 * (1 - Math.exp(-e.t * 3.5)) + e.t * 1.6);
      const m = e.mesh;
      m.position.copy(e.p); m.scale.setScalar(R); m.updateMatrixWorld();
      const u = m.material.uniforms;
      u.uAge.value = k; u.uCentre.value.copy(e.p);
      u.uFade.value = Math.pow(1 - k, 1.3);
      u.uCam.value.copy(cam).sub(e.p).divideScalar(R);
    }
    for (const e of this.list) if (e.t >= e.life) { this.scene.remove(e.mesh); e.mesh.material.dispose(); }
    this.list = this.list.filter(e => e.t < e.life);
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

  const glow = new Sprites(1500, true), smoke = new Sprites(300, false), trails = new Trails(), booms = new Explosions(scene);
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
  const emit = (kind, p, v) => {
    if (kind === 'smoke') S.fx.push({ kind: 'smoke', p: p.clone(), v: new THREE.Vector3(0, 2, 0), t: 0, life: 3.5, s: 2.2 + Math.random() * 1.5, seed: Math.random(), dark: 1 });
    else if (kind === 'flame') S.fx.push({ kind: 'flame', p: p.clone(), v: v ? v.clone().multiplyScalar(0.2) : new THREE.Vector3(), t: 0, life: 0.3, s: 0.6 + Math.random() * 0.6 });
    else if (kind === 'impact') explode(p, new THREE.Vector3(), 0.5);
  };
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
        explode(drone.pos, new THREE.Vector3(), 1.8);
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
  function explode(p, vel, scale = 1) {
    booms.spawn(p, vel, scale);
    S.fx.push({ kind: 'fire', p: p.clone(), v: vel.clone().multiplyScalar(0.3), t: 0, life: 0.3, s: 16 * scale });   // the initial flash
    for (let k = 0; k < 16; k++) {                       // burning debris: bright streaks arcing out and falling
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 - 0.2, Math.random() - 0.5).normalize().multiplyScalar((40 + Math.random() * 70) * scale);
      S.fx.push({ kind: 'ember', p: p.clone(), v: d.add(vel.clone().multiplyScalar(0.4)), t: 0, life: 1.2 + Math.random() * 1.5, s: 0.5 + Math.random() * 0.5, smokeAt: 0 });
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
    // explosions, smoke, sparks
    for (const e of S.fx) {
      e.t += dt; if (e.t < 0) continue;
      e.p.addScaledVector(e.v, dt); e.v.multiplyScalar(1 - dt * 0.8);
      const k = e.t / e.life;
      if (e.kind === 'fire') {
        glow.push(e.p, null, 1.0, 0.55 + 0.3 * (1 - k), 0.2, 3.0 * (1 - k) * (1 - k), e.s * (0.4 + k * 0.9), 0.3);
        glow.push(e.p, null, 1.0, 0.9, 0.7, 4.0 * Math.max(0, 1 - k * 3), e.s * 0.5, 0.7);
      } else if (e.kind === 'smoke') {
        const g = e.dark ? 0.02 + 0.03 * e.seed : 0.16 + 0.1 * e.seed;
        smoke.push(e.p, null, g, g, g * 1.05, 0.85 * Math.min(1, e.t * 4) * (1 - k), e.s * (0.6 + k * 1.6), e.seed);
      } else if (e.kind === 'flame') {
        glow.push(e.p, null, 1.0, 0.3 + 0.25 * (1 - k), 0.03, 0.75 * (1 - k), e.s * (0.8 + k * 0.8), Math.random());
      } else if (e.kind === 'ember') {
        e.v.y -= G * dt;
        const tail = tmpB.copy(e.v).multiplyScalar(-0.06).add(e.p);
        glow.push(e.p, tail, 1.0, 0.45 + 0.3 * (1 - k), 0.08, 2.2 * (1 - k * 0.7), e.s * 0.6);
        if ((e.smokeAt -= dt) <= 0) { e.smokeAt = 0.07; S.fx.push({ kind: 'smoke', p: e.p.clone(), v: new THREE.Vector3(0, 1, 0), t: 0, life: 2.5, s: 2.5 + k * 3, seed: Math.random(), dark: 1 }); }
      } else glow.push(e.p, null, 1.0, 0.85, 0.55, 3.0 * (1 - k), e.s, 0.5);
    }
    S.fx = S.fx.filter(e => e.t < e.life);
    // drone afterburner glow so it reads at a distance
    glow.end(); smoke.end();
    trails.update(now, cam);
    booms.update(dt, cam);
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
