import * as THREE from 'three';
import { startCrippled, stepCrippled } from './flight/crippled.js';
import { loadGltfJson } from './gltf.js';
import { Damage, attachToPart } from './damage.js';
import { FOG_GLSL, fogUniforms } from './world/sky.js';

// the renderer's tone mapping and output colour space, as a function (so opacity can be applied after it)
const ENCODE_GLSL = `
vec3 encode(vec3 c) {
#ifdef TONE_MAPPING
  c = toneMapping(c);
#endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}`;

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
    this.max = max; this.n = 0; this.additive = additive;
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
        uniform float uAdd;
        varying vec2 vUv; varying vec4 vCol; varying float vStreak; varying vec3 vWorld; varying float vSeed; varying float vBig;
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
            p = h; p.xy += position.xy * asize.x * (uAdd > 0.5 ? 1.0 : 1.45);
          }
          vUv = position.xy; vCol = acol; vStreak = streak; vWorld = ahead; vSeed = asize.y; vBig = 0.0;
          gl_Position = projectionMatrix * p;
          // smoke right at the camera (flying through a trail) fades out and is not drawn at all: those huge
          // overlapping close-up puffs were what made flying through smoke slow
          if (streak < 0.5) {
            // how big it is on screen (1 = half the screen height): puffs that would cover a large part of the
            // screen fade out, so flying through smoke or a fireball never stacks full-screen layers (overdraw)
            float scr = asize.x * 1.45 * projectionMatrix[1][1] / max(-h.z, 1e-3);
            float k = (1.0 - smoothstep(0.12, 0.34, scr)) * smoothstep(asize.x * 0.9, asize.x * 2.2, -h.z);
            vBig = step(0.08, scr);                                  // big on screen: the cheap shading (one noise layer)
            if (uAdd < 0.5) vCol.a *= k; else vCol.a *= k;
            if (k < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          }
        }`,
      fragmentShader: /* glsl */`
        uniform float uAdd;
        varying vec2 vUv; varying vec4 vCol; varying float vStreak; varying vec3 vWorld; varying float vSeed; varying float vBig;
        ${FOG_GLSL}${ENCODE_GLSL}
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
        void main() {
          float a; float shade = 1.0;
          if (vStreak > 0.5) {
            float across = abs(vUv.y);
            float core = exp(-across * across * 14.0), glow = exp(-across * across * 2.2);
            float along = vUv.x * 0.5 + 0.5;               // 0 tail .. 1 head
            a = (core * 2.0 + glow * 0.7) * mix(0.1, 1.0, along * along) * smoothstep(1.0, 0.8, along);   // soft tip, no square front
          } else if (uAdd > 0.5) {
            float r = length(vUv);
            if (r > 1.0) discard;
            a = smoothstep(1.0, 0.0, r); a *= a;
          } else {
            // smoke and fire puffs: an irregular, lumpy billow rather than a disc. Each puff is turned and stretched
            // by its own seed; lumps come from layered noise, and the lumps are shaded so the puff reads as volume.
            float ang = vSeed * 6.2832, cs = cos(ang), sn = sin(ang);
            vec2 q = mat2(cs, -sn, sn, cs) * vUv * vec2(1.0, 0.8 + 0.4 * fract(vSeed * 7.3)) * 1.45;   // shape kept well inside the quad
            float f1 = noise(q * 1.7 + vSeed * 31.0), f2, f3;
            if (vBig > 0.5) { f2 = 0.5 + 0.5 * sin(q.x * 3.1 + vSeed * 9.0) * sin(q.y * 2.7 - vSeed * 5.0); f3 = 0.5; }   // (big on screen: fine detail invisible anyway)
            else { f2 = noise(q * 3.6 - vSeed * 13.0); f3 = noise(q * 7.5 + vSeed * 5.0); }
            float lumps = f1 * 0.55 + f2 * 0.3 + f3 * 0.15;
            float r = length(q) + (lumps - 0.5) * 0.95;
            if (r > 1.0) discard;
            a = smoothstep(1.0, 0.3, r) * smoothstep(1.0, 0.8, length(vUv));   // never a hard edge at the quad border
            shade = 0.62 + 0.55 * (f2 * 0.6 + f3 * 0.4) + 0.22 * vUv.y;      // lumpy self-shading, lighter on top
          }
          vec3 col = vCol.rgb * shade;
          float A = a * vCol.a;
          if (uAdd > 0.5) { gl_FragColor = vec4(encode(col * A), 0.0); return; }   // glow: added light, its strength scales the colour
          col = mix(col, applyFog(col, cameraPosition, vWorld), 0.5);   // smoke: lit and hazed like the rest of the world (half strength, or dark smoke turns blue)
          // Smoke is encoded as a colour first and only then weighted by its opacity: encoding an already-faded
          // colour brightens it, so stacked faint layers would add up to a glowing white. Fire (warm: much more red
          // than blue; smoke is neutral grey) is meant to glow, so it keeps the bright order.
          float fire = smoothstep(0.12, 0.45, vCol.r - vCol.b);
          gl_FragColor = vec4(mix(encode(col) * A, encode(col * A), fire), A);
        }`,
      transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 3 : 2;
  }
  begin() { this.n = 0; this.items = this.items || []; this.items.length = 0; }
  // pri: 1 for effects that must always show (explosions, crash fires); trail puffs are 0 and are the ones dropped
  push(head, tail, r, g, b, i, halfWidth, seed = 0, pri = 0) {
    this.n++;
    this.items.push([head.x, head.y, head.z, tail ? tail.x : 0, tail ? tail.y : 0, tail ? tail.z : 0, tail ? 1 : 0, r, g, b, i, halfWidth, seed, 0, pri]);
  }
  // alpha-blended sprites must be drawn far to near, or overlapping puffs pop in front of each other as they fade
  end(cam) {
    let it = this.items;
    if (it.length > this.max) {             // over budget: keep the important ones, then the newest
      for (let k = 0; k < it.length; k++) it[k][15] = k;
      it.sort((a, b) => (b[14] - a[14]) || (b[15] - a[15]));
      it.length = this.max; this.items = it;
    }
    if (!this.additive && cam) {
      for (const q of it) q[13] = (q[0] - cam.x) ** 2 + (q[1] - cam.y) ** 2 + (q[2] - cam.z) ** 2;
      it.sort((x, y) => y[13] - x[13]);
    }
    const H = this.a.head.array, T = this.a.tail.array, C = this.a.col.array, Z = this.a.size.array;
    for (let k = 0; k < it.length; k++) {
      const q = it[k];
      H[k * 3] = q[0]; H[k * 3 + 1] = q[1]; H[k * 3 + 2] = q[2];
      T[k * 4] = q[3]; T[k * 4 + 1] = q[4]; T[k * 4 + 2] = q[5]; T[k * 4 + 3] = q[6];
      C[k * 4] = q[7]; C[k * 4 + 1] = q[8]; C[k * 4 + 2] = q[9]; C[k * 4 + 3] = q[10];
      Z[k * 2] = q[11]; Z[k * 2 + 1] = q[12];
    }
    this.mesh.geometry.instanceCount = it.length;
    for (const v of Object.values(this.a)) v.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- tracers
// Drawn in screen space: each round is a capsule a fixed number of pixels wide, from its tail to its head.
// That keeps every tracer the same crisp shape from any angle; seen end-on it is simply a short round dot.
// Hot core, soft red halo, a slightly brighter head; thinner and dimmer with distance.
class Tracers {
  constructor(max = 600) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.head = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.tail = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.amp = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2).setUsage(THREE.DynamicDrawUsage);   // brightness, width px
    g.setAttribute('aHead', this.head); g.setAttribute('aTail', this.tail); g.setAttribute('aAmp', this.amp);
    this.max = max; this.n = 0;
    this.uniforms = { uRes: { value: new THREE.Vector2(1, 1) } };
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute vec3 aHead; attribute vec3 aTail; attribute vec2 aAmp;
        uniform vec2 uRes;
        varying vec2 vPix; varying vec2 vA; varying vec2 vB; varying float vW; varying float vI;
        void main() {
          vec4 h = projectionMatrix * viewMatrix * vec4(aHead, 1.0);
          vec4 t = projectionMatrix * viewMatrix * vec4(aTail, 1.0);
          if (t.w < 0.5) t = mix(h, t, clamp((h.w - 0.5) / max(h.w - t.w, 1e-4), 0.0, 1.0));   // keep the tail in front of the camera
          vec2 hs = h.xy / h.w * uRes * 0.5, ts = t.xy / t.w * uRes * 0.5;
          vec2 d = hs - ts; float l = length(d);
          vec2 dir = l > 1e-3 ? d / l : vec2(1.0, 0.0), side = vec2(-dir.y, dir.x);
          float w = aAmp.y;
          float f = position.x * 0.5 + 0.5;
          vec2 p = mix(ts - dir * w, hs + dir * w, f) + side * position.y * w;
          vec4 c = mix(t, h, clamp(f, 0.0, 1.0));
          gl_Position = vec4(p / (uRes * 0.5) * c.w, c.z, c.w);
          vPix = p; vA = ts; vB = hs; vW = w; vI = aAmp.x;
          if (h.w < 0.5) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);       // head behind the camera: skip
        }`,
      fragmentShader: /* glsl */`
        varying vec2 vPix; varying vec2 vA; varying vec2 vB; varying float vW; varying float vI;
        void main() {
          vec2 ab = vB - vA; float l2 = max(dot(ab, ab), 1e-4);
          float s = clamp(dot(vPix - vA, ab) / l2, 0.0, 1.0);
          float d = length(vPix - (vA + ab * s)) / vW;                    // 0 on the centre line, 1 at the edge
          if (d > 1.0) discard;
          float core = smoothstep(0.38, 0.0, d), halo = (1.0 - d) * (1.0 - d);
          float along = 0.35 + 0.65 * s;                                  // brighter toward the head
          vec3 col = vec3(1.0, 0.86, 0.62) * core * 1.3 + vec3(1.0, 0.22, 0.08) * halo * 0.55;
          gl_FragColor = vec4(col * vI * along, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }
  begin(renderer) { this.n = 0; renderer.getDrawingBufferSize(this.uniforms.uRes.value); }
  push(head, tail, intensity, widthPx) {
    if (this.n >= this.max) return;
    const k = this.n++;
    this.head.array.set([head.x, head.y, head.z], k * 3); this.tail.array.set([tail.x, tail.y, tail.z], k * 3);
    this.amp.array.set([intensity, widthPx], k * 2);
  }
  end() { this.mesh.geometry.instanceCount = this.n; this.head.needsUpdate = this.tail.needsUpdate = this.amp.needsUpdate = true; }
}

// ---------------------------------------------------------------- missile smoke ribbons
// One continuous ribbon per missile. It starts as a tight, dense line right behind the motor, then billows:
// it widens, drifts on the wind and breaks up with noise along its length, lit brighter on the sun side.
// Wingtip vortices: one thin camera-facing ribbon per wingtip, its points left where the tip was (so it never lags
// or bunches up at speed), fading with age.
class Vortices {
  constructor(n = 2, max = 90) {
    this.lines = Array.from({ length: n }, () => []); this.max = max;
    const verts = n * max * 2;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.alpha = new THREE.BufferAttribute(new Float32Array(verts), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos); g.setAttribute('aA', this.alpha);
    const idx = [];
    for (let l = 0; l < n; l++) for (let i = 0; i < max - 1; i++) { const a = (l * max + i) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      vertexShader: 'attribute float aA; varying float vA; void main(){ vA = aA; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }',
      fragmentShader: `varying float vA; ${ENCODE_GLSL}
        void main(){ if (vA < 0.004) discard; gl_FragColor = vec4(encode(vec3(0.82, 0.85, 0.88)) * vA, vA); }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    }));
    this.mesh.frustumCulled = false;
  }
  add(l, p, t, k) { const L = this.lines[l]; L.push({ p: p.clone(), t, k }); if (L.length > this.max) L.shift(); }
  cut(l) { const L = this.lines[l]; if (L.length && L[L.length - 1].k > 0) L.push({ p: L[L.length - 1].p.clone(), t: L[L.length - 1].t, k: 0 }); }
  update(now, cam, life = 0.7, width = 0.07, grow = 1.5) {
    const P = this.pos.array, A = this.alpha.array, side = new THREE.Vector3(), d = new THREE.Vector3(), v = new THREE.Vector3();
    this.lines.forEach((L, l) => {
      while (L.length && now - L[0].t > life) L.shift();
      for (let i = 0; i < this.max; i++) {
        const o = (l * this.max + i) * 2;
        if (i >= L.length) {                                          // unused: collapsed onto the line's last point
          const q = L.length ? L[L.length - 1].p : cam;
          A[o] = A[o + 1] = 0; P[o * 3] = P[o * 3 + 3] = q.x; P[o * 3 + 1] = P[o * 3 + 4] = q.y; P[o * 3 + 2] = P[o * 3 + 5] = q.z; continue;
        }
        const a = L[i], b = L[Math.min(i + 1, L.length - 1)], c = L[Math.max(i - 1, 0)];
        d.subVectors(b.p, c.p); v.subVectors(cam, a.p);
        side.crossVectors(d, v).normalize().multiplyScalar(width * (1 + (now - a.t) * grow));   // spreads as it ages
        P[o * 3] = a.p.x + side.x; P[o * 3 + 1] = a.p.y + side.y; P[o * 3 + 2] = a.p.z + side.z;
        P[o * 3 + 3] = a.p.x - side.x; P[o * 3 + 4] = a.p.y - side.y; P[o * 3 + 5] = a.p.z - side.z;
        A[o] = A[o + 1] = a.k * Math.pow(Math.max(0, 1 - (now - a.t) / life), 1.5) * Math.min(1, i / 3) * Math.min(1, (L.length - 1 - i) / 2 + 0.35);
        if (!a.puffed && now - a.t > life * 0.35 && a.k > 0) { a.puffed = true; this.onAge?.(a); }   // older stretch: becomes cloud
      }
    });
    this.pos.needsUpdate = this.alpha.needsUpdate = true;
  }
}

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
      fragmentShader: `varying vec4 vInfo; varying vec3 vWorld; ${FOG_GLSL}${ENCODE_GLSL}
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
          float puff = smoothstep(0.15, 0.6, age);         // fully cloud-coloured before the ribbon fades out (~0.35-1 s)
          float edgeSoft = mix(0.75, 0.35 + 0.35 * n, puff);
          float body = 1.0 - smoothstep(edgeSoft, 1.0, abs(across));
          float breakup = mix(1.0, smoothstep(0.3, 0.75, n), smoothstep(2.0, 5.0, age));
          float a = vInfo.x * body * breakup * smoothstep(6.0, 45.0, length(vWorld - cameraPosition));
          if (a < 0.003) discard;
          float lit = 0.5 + 0.5 * clamp(uSunDir.y * 0.8 + across * 0.35 + (n - 0.5) * 0.6 * puff, 0.0, 1.0);
          vec3 smoke = mix(vec3(0.32, 0.32, 0.33), vec3(0.55, 0.55, 0.56), lit);   // the rope: mid grey, not far off the clouds
          vec3 white = vec3(0.97, 1.0, 1.04) * mix(0.45, 0.95, lit);        // the colour of the cloud puffs that take over
          vec3 col = mix(smoke, white, puff);
          col = mix(applyFog(col, cameraPosition, vWorld), mix(col, applyFog(col, cameraPosition, vWorld), 0.5), puff);   // hazed like the puffs at the end
          col = mix(col, vec3(1.0, 0.78, 0.5) * 1.6, hot);             // glowing exhaust next to the motor
          gl_FragColor = vec4(mix(encode(col) * a, encode(col * a), hot), a);   // opacity after encoding (see the sprites); the hot exhaust glows
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
  // where trail point k is now: it drifts on the wind and, with age, wanders in slow smooth meanders
  pointAt(t, k, now, out) {
    const p = t.pts[k], age = now - p.t, m = Math.pow(Math.max(0, age - 0.6), 1.25);
    return out.copy(p.p).addScaledVector(this.wind, age).addScaledVector(p.drift, age)
      .add(_q2.set(Math.sin(p.d * 0.045 + t.seed) + 0.5 * Math.sin(p.d * 0.13 + t.seed * 2), 0.6 * Math.sin(p.d * 0.06 + t.seed * 3), Math.cos(p.d * 0.05 + t.seed * 4) + 0.5 * Math.cos(p.d * 0.11 + t.seed)).multiplyScalar(0.9 * m));
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
      const at = (k, out) => this.pointAt(t, k, now, out);
      for (let k = 0; k < n; k++) {
        const p = t.pts[k], age = now - p.t;
        const c = at(k, tmp);
        at(Math.min(k + 1, n - 1), q1); at(Math.max(k - 1, 0), q0);
        _v.subVectors(q1, q0).normalize();
        _w.subVectors(cam, c).normalize();
        const side = _w.cross(_v).normalize();
        const width = 0.22 + 0.9 * (1 - Math.exp(-age / 0.8)) + 3.6 * Math.max(0, age - 1.2) / (1 + Math.max(0, age - 1.2) * 0.3) + 0.8 * Math.sin(p.d * 0.21 + t.seed) * Math.min(1, Math.max(0, age - 1.5) / 3);   // tight near the missile, billowing and lumpy later
        const fromHead = (n - 1 - k);
        const fade = Math.pow(Math.max(0, 1 - age / LIFE), 1.5) * (age < 1.5 ? 0.85 : 0.85 - 0.45 * Math.min(1, (age - 1.5) / 2.5)) * Math.min(1, fromHead / 2 + 0.4)
          * (1 - THREE.MathUtils.smoothstep(age, 0.35, 1.0));   // solid near the missile; by ~1 s the cloud puffs have taken over
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
export async function createWeapons(scene, jet, ac, cfg, terrain, enemyProto = null) {
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

  const glow = new Sprites(2500, true), smoke = new Sprites(4000, false), trails = new Trails(), tracers = new Tracers(), vortices = new Vortices();
  scene.add(glow.mesh, smoke.mesh, trails.mesh, tracers.mesh, vortices.mesh);
  vortices.onAge = (a) => S.fx.push({ kind: 'vapor', p: a.p.clone(), v: new THREE.Vector3(0, 0.3, 0), t: 0, life: 1.0 + Math.random() * 0.6,
    s: 0.25 + Math.random() * 0.12, seed: Math.random(), op: 0.4 * a.k, grow: 3, soft: 1 });

  // missiles on the rails (in the jet's model, which is offset by -CG inside jet.object)
  const onJet = (o) => { for (let p = o.parent; p; p = p.parent) if (p === jet.model) return true; return false; };
  const railMeshes = RAILS.map(r => { const m = proto.clone(true); m.userData.missile = true; m.position.copy(r).add(CG); jet.model.add(m); attachToPart(jet.model, m); return m; });

  const S = {
    selected: 1, firing: false,
    rounds: [], missiles: [], fx: [], kills: [], shots: 0, hits: 0, allow: { gun: true, missile: true },
    stock: cfg.missiles, reload: 0, gunAcc: 0, gunSide: 0, flash: [0, 0],
    lock: 0, locked: false, seeker: null, target: null, lead: null, leadTime: 0, hitScale: 1,
    loaded: Array(RAILS.length).fill(true), lost: Array(RAILS.length).fill(false),
  };

  // ---------------- damage: player and drone share the same model and effects
  // smoke and flame are laid down by distance travelled (plus a slow tick when standing still),
  // so fast debris leaves a continuous trail instead of a row of dots
  const lastAt = new WeakMap();
  const puffSmoke = (p, light) => S.fx.push({ kind: 'smoke', p: p.clone(), v: new THREE.Vector3((Math.random() - 0.5) * 2, 2 + Math.random() * 2, (Math.random() - 0.5) * 2), t: 0, life: 4 + Math.random() * 2.5, s: 0.55 + Math.random() * 0.6, seed: Math.random(), dark: light ? 0 : 1, spread: 1 });
  const puffFlame = (p, v) => S.fx.push({ kind: 'ball', burn: 1, p: p.clone(), v: (v ? v.clone().multiplyScalar(0.92) : new THREE.Vector3()).add(new THREE.Vector3((Math.random() - 0.5) * 2, 2 + Math.random() * 2, (Math.random() - 0.5) * 2)), t: 0, life: 0.9 + Math.random() * 0.6, s: 0.6 + Math.random() * 0.6, seed: Math.random(), bloom: 1 });
  const emit = (kind, p, v, key) => {
    if (kind === 'impact') return explode(p, new THREE.Vector3(), 0.6);
    if (kind === 'splash') return splash(p, v || new THREE.Vector3(), 0.5);
    if (kind === 'flakes') {                                  // paint flakes and dust off a torn surface
      const carry = v ? v.clone().multiplyScalar(0.85) : new THREE.Vector3();
      for (let i = 0; i < 26; i++) S.fx.push({ kind: 'chip', light: 1, p: p.clone(), v: carry.clone().add(new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.3) * 12, (Math.random() - 0.5) * 14)),
        t: 0, life: 1.0 + Math.random() * 1.2, s: 0.06 + Math.random() * 0.1, seed: Math.random() });
      for (let i = 0; i < 6; i++) S.fx.push({ kind: 'vapor', soft: 1, p: p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.5)),
        v: carry.clone().multiplyScalar(0.6).add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3)), t: 0, life: 0.8 + Math.random() * 0.6, s: 0.6 + Math.random() * 0.5, seed: Math.random(), op: 0.45, grow: 3 });
      return;
    }
    if (kind === 'wisp') {                                     // a scrap of turbulent air off a broken stump, left behind in the air
      S.fx.push({ kind: 'vapor', soft: 1, p: p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6)),
        v: new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3), t: 0, life: 0.5 + Math.random() * 0.6, s: 0.25 + Math.random() * 0.3, seed: Math.random(), op: 0.3, grow: 3.5 });
      return;
    }
    if (kind === 'groundfire') return fires.push({ p: p.clone(), t: 0, life: v ? 25 : 10, big: !!v, tS: 0, tF: 0 });
    let spacingNow = 1;
    // key.fade (0..1) shrinks the puffs: a fire dying down
    const fade = key && key.fade !== undefined ? key.fade : 1;
    const make = kind === 'smoke' ? (q) => { puffSmoke(q); const e = S.fx[S.fx.length - 1]; e.scale = Math.sqrt(spacingNow); e.s *= 0.4 + 0.6 * fade; }
      : (q) => { puffFlame(q, v); S.fx[S.fx.length - 1].s *= fade; };
    // spacing grows with the object's speed (bigger, sparser puffs that still merge) and with how busy the pool is
    // (a crash flings a dozen burning pieces at once; the smoke from all of them is what costs, so trails space out
    // quickly as the pool fills, and stop altogether past ~1300 effects)
    const busy = S.fx.length / 1100, speed = v ? v.length() : 0;
    if (busy > 1.2) return;
    const spacing = (kind === 'smoke' ? 1.6 : 1.4) * Math.max(1, speed / 45) * (1 + 3 * Math.max(0, busy - 0.35));
    spacingNow = spacing;
    if (!key) { make(p); return; }
    let st = lastAt.get(key);
    if (!st) { st = { [kind]: { p: p.clone(), t: 0 } }; lastAt.set(key, st); make(p); return; }
    let e = st[kind];
    if (!e) { st[kind] = { p: p.clone(), t: 0 }; make(p); return; }
    const d = e.p.distanceTo(p);
    if (d > 300) { e.p.copy(p); e.t = 0; make(p); return; }   // a jump (respawned, teleported): start a new trail, don't fill the gap
    if (d >= spacing) {
      const n = Math.min(Math.floor(d / spacing), 40);
      for (let k = 1; k <= n; k++) make(e.p.clone().lerp(p, k / n));
      e.p.copy(p); e.t = 0;
    } else if ((e.t += 1 / 60) > 0.1) { make(p); e.t = 0; e.p.copy(p); }
  };
  // things burning on the ground: crash sites and landed debris
  const fires = [];

  jet.damage = new Damage(jet.model, scene, terrain, emit);

  // ---------------- target drones: copies of the jet circling close to the player, for testing
  let droneProto = enemyProto;
  if (!droneProto) {   // fallback: a red-tinted copy of the player's jet
    droneProto = jet.object.clone(true);
    droneProto.traverse(o => { if (o.isMesh && o.material.color && !o.material.transparent) { o.material = o.material.clone(); o.material.color.multiplyScalar(0.55).add(new THREE.Color(0.35, 0.05, 0.03)); } });
  }
  // enemyProto may be one prototype or a list of { proto, count }
  const roster = Array.isArray(enemyProto) ? enemyProto.flatMap(e => Array(e.count).fill(e.proto)) : Array(cfg.drones).fill(droneProto);
  const drones = [];
  for (let k = 0; k < roster.length; k++) {
    const d = { obj: roster[k].clone(true), def: roster[k].userData.def || {}, alive: true, falling: false, respawn: 0, t: 0, spin: 0, dir: 1, R: 1000, speed: 180,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(), centre: new THREE.Vector3() };
    scene.add(d.obj);
    d.model = d.obj.children[0];
    d.props = []; d.obj.traverse(o => { if (o.userData.prop) d.props.push(o); });
    d.dmg = new Damage(d.model, scene, terrain, emit);
    drones.push(d);
    placeDrone(d, k);
  }
  function placeDrone(d, k = Math.random() * 8) {
    d.dmg.repair(); d.cr = null;
    lastAt.delete(d); lastAt.delete(d.obj);   // its old smoke and flame trails ended where it went down
    d.killedBy = null; d.lastHit = null; d.detonated = false; d.detonateAt = null; d.fallT = 0; d.extra = 0;
    if (d.track) {                                             // a mission: on its track, from the track's start
      d.alive = true; d.falling = false; d.obj.visible = true; d.age = 0;
      trackPos(d, S.simT || 0, d.pos); d.vel.copy(d.track.dir).multiplyScalar(d.track.speed);
      return;
    }
    // a circle somewhere around the player, 3 to 8 km away, at a similar height
    const a = (k / Math.max(drones.length || cfg.drones, 1)) * Math.PI * 2 + Math.random() * 0.6;
    const r = cfg.droneMinDist + Math.random() * (cfg.droneMaxDist - cfg.droneMinDist);
    const D = d.def, rr = D.radius || [500, 1400], sp = D.speed || [140, 220];
    d.R = rr[0] + Math.random() * (rr[1] - rr[0]); d.speed = sp[0] + Math.random() * (sp[1] - sp[0]); d.dir = Math.random() < 0.5 ? -1 : 1;
    d.centre.set(ac.pos.x + Math.cos(a) * r, 0, ac.pos.z + Math.sin(a) * r);
    d.centre.y = Math.max(ac.pos.y + (Math.random() - 0.5) * 600, terrain.heightAt(d.centre.x, d.centre.z) + 700);
    d.alive = true; d.falling = false; d.obj.visible = true; d.t = Math.random() * Math.PI * 2;
    d.pos.set(Math.cos(d.t) * d.R, 0, Math.sin(d.t) * d.R).add(d.centre);
  }
  function flyDrone(d, dt) {
    d.dmg.update(dt);
    if (!d.alive) { if ((d.respawn -= dt) <= 0) placeDrone(d); return; }
    d.age = (d.age || 0) + dt;
    // enemies can't fly on with asymmetric lift or without a tailplane: a lost wing section, the rear fuselage or
    // both stabilisers means it is going down (the player's jet is the only one that survives an outer wing)
    if (!d.falling) {
      const P = d.dmg.parts, gone = (n) => !!P[n]?.broken;
      if (gone('wingOuterL') || gone('wingOuterR') || gone('wingInnerL') || gone('wingInnerR') || gone('tail') || (P.stabL && gone('stabL') && gone('stabR'))) killDrone(d);
    }
    if (d.falling) {                          // going down: flown by what's left of the airframe, burning, until it hits
      if (d.detonateAt != null && (d.age >= d.detonateAt || d.pos.y < terrain.heightAt(d.pos.x, d.pos.z) + 30)) { if (S.detonateOK(d)) detonate(d); else d.detonateAt = null; }
      // coming apart on the way down: one or two more pieces over the next ~15 s (so nothing glides on intact)
      d.fallT = (d.fallT || 0) + dt;
      if ((d.extra || 0) < 2 && d.fallT > (d.extra ? 11 : 4) + (d.extraJit ??= Math.random() * 4)) {
        const left = Object.keys(d.dmg.parts).filter(n => !d.dmg.parts[n].broken);
        if (left.length) d.dmg.breakPart(left[Math.floor(Math.random() * left.length)], d.vel);
        d.extra = (d.extra || 0) + 1; d.extraJit = Math.random() * 4;
      }
      stepCrippled(d, dt);
      emit('smoke', d.pos, d.vel, d); if (d.dmg.dead || d.cr.t > 1.5) emit('flame', d.pos, d.vel, d.obj);
      if (d.pos.y < terrain.heightAt(d.pos.x, d.pos.z) + 2 && terrain.isWater(d.pos.x, d.pos.z)) {   // into a lake: a big splash and it's gone
        splash(d.pos, d.vel, d.def.hitRadius > 15 ? 2.2 : 1.3);
        d.alive = false; d.obj.visible = false; d.respawn = d.track ? 1e9 : 4;
        return;
      }
      if (d.pos.y < terrain.heightAt(d.pos.x, d.pos.z) + 2) {
        explode(d.pos, d.vel, d.def.hitRadius > 15 ? 3.2 : 2.0);
        // a charred wreck stays on the ground and burns, with a smoke column drifting downwind
        const wreck = d.obj.clone(true);
        wreck.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); if (o.material.color) o.material.color.multiplyScalar(0.18); } });
        const g = terrain.heightAt(d.pos.x, d.pos.z);
        wreck.position.set(d.pos.x, g + 0.6, d.pos.z);
        wreck.rotation.set((Math.random() - 0.5) * 0.3, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.5);
        scene.add(wreck);
        setTimeout(() => wreck.removeFromParent(), 40000);
        emit('groundfire', wreck.position, new THREE.Vector3(1, 0, 0));
        d.alive = false; d.obj.visible = false; d.respawn = d.track ? 1e9 : 4;
      }
      return;
    }
    if (d.track) {                                             // a mission: flying its straight track in formation
      // (out of formation, d.track.free: flown step by step so the turn, bank and sink ease in and out)
      const p = d.track.free ? freeStep(d, dt, _v) : trackPos(d, S.simT || 0, _v);
      d.vel.subVectors(p, d.pos).divideScalar(Math.max(dt, 1e-3));
      d.pos.copy(p);
      if (d.pos.y < terrain.heightAt(d.pos.x, d.pos.z) + 3) { killDrone(d); d.pos.y = terrain.heightAt(d.pos.x, d.pos.z) + 1; return; }
      const fx = d.dmg.effects(), T = d.track, tt = (S.simT || 0) - (T.w0 ?? T.t0);
      const Wv = T.weave;
      // (+ banks right; the weave's sideways acceleration is -a w^2 sin, so it banks the opposite way to its offset)
      const bankW = (T._bank || 0) + (!Wv ? 0 : Wv.phys ? -Math.atan(Wv.a * Wv.w * Wv.w * Math.sin(tt * Wv.w + Wv.ph) / 9.81)   // banked for its sideways acceleration
        : -Math.cos(tt * Wv.w + Wv.ph) * Wv.a * Wv.w * Wv.w * 0.012);                                   // banks into its weave
      _m.lookAt(new THREE.Vector3(), d.vel.lengthSq() > 1 ? _w.copy(d.vel).normalize().negate() : T.dir.clone().negate(), new THREE.Vector3(0, 1, 0));
      d.obj.quaternion.setFromRotationMatrix(_m).multiply(_q.setFromAxisAngle(_v.set(0, 0, 1), bankW + fx.wobble * 0.25 * Math.sin(d.age * 1.8)));
      if (fx.pitchWobble) d.obj.quaternion.multiply(_q.setFromAxisAngle(_v.set(1, 0, 0), fx.pitchWobble * (0.13 * Math.sin(d.age * 1.3) + 0.05 * Math.sin(d.age * 3.1))));
      d.obj.position.copy(d.pos);
      return;
    }
    d.t += dt * d.speed / d.R * d.dir;
    const p = new THREE.Vector3(Math.cos(d.t) * d.R, Math.sin(d.t * 0.5) * 120, Math.sin(d.t) * d.R).add(d.centre);
    d.vel.subVectors(p, d.pos).divideScalar(Math.max(dt, 1e-3));
    d.pos.copy(p);
    // flew into the terrain: it's a crash like any other
    if (d.pos.y < terrain.heightAt(d.pos.x, d.pos.z) + 3) { killDrone(d); d.pos.y = terrain.heightAt(d.pos.x, d.pos.z) + 1; return; }
    const fwd = new THREE.Vector3(-Math.sin(d.t) * d.dir, 0, Math.cos(d.t) * d.dir).normalize();
    const fx = d.dmg.effects();
    const wobble = fx.wobble * 0.25 * Math.sin(d.age * 1.8);   // damaged: rocks
    _m.lookAt(new THREE.Vector3(), fwd.clone().negate(), new THREE.Vector3(0, 1, 0));
    d.obj.quaternion.setFromRotationMatrix(_m).multiply(_q.setFromAxisAngle(_v.set(0, 0, 1), -0.5 * d.dir + wobble));
    // one stabiliser gone: it porpoises, the pilot fighting the nose up and down
    if (fx.pitchWobble) d.obj.quaternion.multiply(_q.setFromAxisAngle(_v.set(1, 0, 0), fx.pitchWobble * (0.13 * Math.sin(d.age * 1.3) + 0.05 * Math.sin(d.age * 3.1))));
    d.obj.position.copy(d.pos);
  }
  // where a drone on a track is at time t: the formation's lead point moving straight on, plus its slot (x right, y up,
  // z behind), plus a gentle weave for escorts
  const _tr = new THREE.Vector3(), _tu = new THREE.Vector3(0, 1, 0);
  // A track can also break off into a steady level turn (T.turn = { t0, rate rad/s (+ right), ang rad }): a constant-
  // radius arc, then straight on along the new heading. The weave (if any) is applied across the current heading.
  const _th = new THREE.Vector3(), _trr = new THREE.Vector3();
  // A closed path (a rounded square): positions by distance along it. Each slot sits at its own distance back along
  // the path (off.z), out to its right (off.x) and up (off.y), so the whole formation bends round the corners together;
  // banked for the turn there.
  function loopPos(d, t, out) {
    const T = d.track, L = T.loop, n = L.x.length;
    let s = (L.s0 + T.speed * (t - T.t0) - T.off.z) % L.len; if (s < 0) s += L.len;
    let lo = 0, hi = n - 1;                                       // (binary search on the running length)
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L.cum[m] <= s) lo = m; else hi = m; }
    const f = (s - L.cum[lo]) / Math.max(L.cum[hi] - L.cum[lo], 1e-6);
    const x = L.x[lo] + (L.x[hi] - L.x[lo]) * f, z = L.z[lo] + (L.z[hi] - L.z[lo]) * f;
    const hd = L.h[lo] + Math.atan2(Math.sin(L.h[hi] - L.h[lo]), Math.cos(L.h[hi] - L.h[lo])) * f;
    T.dir = (T._dirv ||= new THREE.Vector3()).set(Math.sin(hd), 0, -Math.cos(hd));
    _trr.crossVectors(T.dir, _tu).normalize();
    out.set(x, T.origin.y, z).addScaledVector(_trr, T.off.x).addScaledVector(_tu, T.off.y);
    const k = L.k[lo] + (L.k[hi] - L.k[lo]) * f;                 // (curvature, + = turning right)
    T._bank = Math.atan(T.speed * T.speed * k / 9.81);
    return out;
  }
  // build a rounded square through point S heading along dir: a superellipse (|u|^n + |v|^n = 1, n ~4.5: long nearly
  // straight sides, corners whose curvature builds and fades smoothly) of half-size a, on whichever side of S is
  // toward the middle of the map, shrunk until it fits inside the map (margin m)
  function makeLoop(S, dir, a = 8000, n = 4.5, m = 1500, fitsAt = null) {
    const fwd = new THREE.Vector3(dir.x, 0, dir.z).normalize(), right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const half = (terrain.w * terrain.s) / 2 - m, cx0 = terrain.ox + terrain.w * terrain.s / 2, cz0 = terrain.oz + terrain.h * terrain.s / 2;
    const sideOf = (sg) => new THREE.Vector3(S.x - right.x * a * sg, 0, S.z - right.z * a * sg);   // centre if S is on its +sg side
    let sg = sideOf(1).distanceToSquared(new THREE.Vector3(cx0, 0, cz0)) < sideOf(-1).distanceToSquared(new THREE.Vector3(cx0, 0, cz0)) ? 1 : -1;
    const N = 2048, f = (c) => Math.sign(c) * Math.abs(c) ** (2 / n);
    for (let tries = 0; tries < 16; tries++, a *= 0.88) {
      const c = sideOf(sg), x = new Float32Array(N + 1), z = new Float32Array(N + 1);
      let fits = true;
      for (let i = 0; i <= N; i++) {
        // (S is at parameter 0: +right side of the centre; it runs forward along dir from there: for sg = -1 the
        // other way round the loop)
        const th = (i / N) * Math.PI * 2, u = a * f(Math.cos(th)) * sg, v = a * f(Math.sin(th));
        x[i] = c.x + right.x * u + fwd.x * v; z[i] = c.z + right.z * u + fwd.z * v;
        if (Math.abs(x[i] - cx0) > half || Math.abs(z[i] - cz0) > half || (fitsAt && !fitsAt(x[i], z[i]))) fits = false;
      }
      if (!fits && tries < 15) continue;
      const cum = new Float32Array(N + 1), h = new Float32Array(N + 1), k = new Float32Array(N + 1);
      for (let i = 1; i <= N; i++) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
      for (let i = 0; i <= N; i++) { const j = Math.min(i + 1, N), i0 = Math.max(i - 1, 0); h[i] = Math.atan2(x[j] - x[i0], -(z[j] - z[i0])); }
      for (let i = 0; i <= N; i++) { const j = Math.min(i + 1, N), i0 = Math.max(i - 1, 0); let dh = h[j] - h[i0]; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); k[i] = dh / Math.max(cum[j] - cum[i0], 1e-3); }
      return { x, z, cum, h, k, len: cum[N], s0: 0 };
    }
  }
  // put every bomber flying a straight track onto a rounded square through where its lead point is now
  function toLoop(list, simT, fitsAt) {
    const ref = list.find(d => d.track && !d.track.loop); if (!ref) return;
    const T0 = ref.track, S = T0.origin.clone().addScaledVector(T0.dir, T0.speed * (simT - T0.t0));
    const L = makeLoop(S, T0.dir, 8000, 4.5, 1500, fitsAt);
    for (const d of list) if (d.track && !d.track.loop) {
      const T = d.track;
      if (T.origin !== T0.origin) continue;                       // (only the ones in that formation)
      Object.assign(T, { loop: L, t0: simT, w0: T.w0 ?? simT, turn: null, origin: T.origin.clone() });
    }
  }

  // A bomber that has left the formation (peeling off, breaking from a missile): heading turned at a rate that eases
  // toward its target and back to nothing once it has turned far enough; the sink rate eases in the same way; the bank
  // follows the turn. F: { dir (horizontal), rate, rateT (rad/s, + right), ang (rad to turn), turned, sink, sinkT (m/s) }
  // F.rejoin: steering back to its place in the formation (turn toward a point a little ahead of it, match its height,
  // a bit faster to catch up), re-attached once there. Out of formation it also keeps clear of the ground: anything
  // within ~600 m under its path ahead and it climbs away, whatever it was doing.
  const _fy = new THREE.Vector3(0, 1, 0), _ft = new THREE.Vector3(), _fa = new THREE.Vector3();
  function freeStep(d, dt, out) {
    const T = d.track, F = T.free, deg = Math.PI / 180;
    let V = T.speed, sinkT = F.sinkT;
    if (F.rejoin) {
      T.free = null; trackPos(d, S.simT || 0, _ft); T.free = F;            // (where its slot is now)
      const gap = _ft.distanceTo(d.pos);
      if (gap < 40) { T.free = null; T.weave = F.weave; T.evading = false; return trackPos(d, S.simT || 0, out); }
      _fa.copy(_ft).addScaledVector(T.dir, 300).sub(d.pos); _fa.y = 0;
      const want = Math.atan2(_fa.x, -_fa.z), have = Math.atan2(F.dir.x, -F.dir.z);
      let err = want - have; err = Math.atan2(Math.sin(err), Math.cos(err));    // (+ = it lies to the right)
      F.rateT = THREE.MathUtils.clamp(err * 0.6, -3 * deg, 3 * deg); F.turned = 0; F.ang = 1e9;
      sinkT = THREE.MathUtils.clamp((d.pos.y - _ft.y) * 0.08, -6, 6);
      V *= 1 + THREE.MathUtils.clamp(gap / 3000, 0, 0.18);
    }
    // the ground ahead (now, in ~6 s and ~12 s)
    const lo = Math.max(terrain.heightAt(d.pos.x, d.pos.z), terrain.heightAt(d.pos.x + F.dir.x * V * 6, d.pos.z + F.dir.z * V * 6), terrain.heightAt(d.pos.x + F.dir.x * V * 12, d.pos.z + F.dir.z * V * 12));
    const clear = d.pos.y - lo;
    if (clear < 600) sinkT = Math.min(sinkT, -THREE.MathUtils.clamp((600 - clear) / 30, 2, 15));
    F.rate += (F.rateT - F.rate) * Math.min(1, dt * 0.9);
    F.sink += (sinkT - F.sink) * Math.min(1, dt * 0.6);
    const dh = F.rate * dt;
    F.turned += Math.abs(dh); if (F.turned >= F.ang) F.rateT = 0;
    F.dir.applyAxisAngle(_fy, -dh).normalize();
    out.copy(d.pos).addScaledVector(F.dir, V * dt); out.y -= F.sink * dt;
    T._bank = Math.atan(V * F.rate / 9.81);
    return out;
  }
  // leave the formation (or change what it's doing out of it): turn by ang at up to rate (+ right), sinking at sink
  function breakOff(d, rate, ang, sink) {
    const T = d.track; if (!T) return;
    if (!T.free) {
      const h = new THREE.Vector3(d.vel.x, 0, d.vel.z); if (h.lengthSq() < 1) h.copy(T.dir);
      T.free = { dir: h.normalize(), rate: 0, sink: Math.max(0, -d.vel.y), weave: T.weave };
      T.weave = undefined; T.turn = null;
    }
    Object.assign(T.free, { rateT: rate, ang, turned: 0, sinkT: sink, rejoin: false });
  }
  function trackPos(d, t, out) {
    const T = d.track, tt = t - T.t0;
    if (T.loop) return loopPos(d, t, out);
    _tr.crossVectors(T.dir, _tu).normalize();
    T._bank = 0;
    const tn = T.turn ? Math.max(0, t - T.turn.t0) : 0;
    if (!tn) {
      out.copy(T.origin).addScaledVector(T.dir, T.speed * tt).addScaledVector(_tr, T.off.x).addScaledVector(_tu, T.off.y).addScaledVector(T.dir, -T.off.z);
      _th.copy(T.dir); _trr.copy(_tr);
    } else {
      const U = T.turn, w = Math.abs(U.rate), sg = Math.sign(U.rate), ta = Math.abs(U.ang) / w, R = T.speed / w;
      out.copy(T.origin).addScaledVector(T.dir, T.speed * (U.t0 - T.t0)).addScaledVector(_tr, T.off.x).addScaledVector(_tu, T.off.y).addScaledVector(T.dir, -T.off.z);
      const sa = Math.min(tn, ta), ph = w * sa;
      out.addScaledVector(T.dir, R * Math.sin(ph)).addScaledVector(_tr, sg * R * (1 - Math.cos(ph)));           // the arc
      _th.copy(T.dir).multiplyScalar(Math.cos(ph)).addScaledVector(_tr, sg * Math.sin(ph));                       // current heading
      if (tn > ta) out.addScaledVector(_th, T.speed * (tn - ta));                                                 // then straight on
      else T._bank = sg * Math.atan(T.speed * w / 9.81);                                                          // banked through the turn
      _trr.crossVectors(_th, _tu).normalize();
    }
    if (T.turn?.climb && tn) out.y += T.turn.climb * tn;                                                       // (a peel-off may sink away)
    const tw = t - (T.w0 ?? T.t0);                                                                             // (the weave's own clock: shifting the track doesn't jolt it)
    if (T.weave) { out.addScaledVector(_trr, Math.sin(tw * T.weave.w + T.weave.ph) * T.weave.a); out.y += Math.sin(tw * T.weave.w * 0.7 + T.weave.ph) * T.weave.a * 0.25; }
    return out;
  }
  // A bomber that goes down can blow up: its fuel and bombload go at once. Every part is flung off, a much bigger
  // fireball, and the blast tears into anything close (enemies and the player alike).
  // per type (def.detonate: chance, radius, size); the tutorial overrides the decision
  S.detonateChance = (d) => !!d.def.detonate && Math.random() < d.def.detonate.chance;
  S.detonateOK = () => true;   // (the tutorial vetoes a blast that would catch the player)
  function detonate(d) {
    const c = d.pos.clone();
    const DT = d.def.detonate || {}, size = DT.size || 4;
    explode(c, d.vel, size, true);
    explode(c.clone().add(new THREE.Vector3((Math.random() - 0.5) * 20, 4, (Math.random() - 0.5) * 20)), d.vel, size * 0.64);
    d.detonated = true; d.detonateAt = null;
    for (const n of Object.keys(d.dmg.parts)) d.dmg.breakPart(n, d.vel, 45);
    d.dmg.bodyHp = 0;
    const R = DT.radius || 100;
    for (const o of drones) {
      if (o === d || !o.alive) continue;
      const dist = o.pos.distanceTo(c); if (dist > R) continue;
      const k = 1 - dist / R, near = Object.keys(o.dmg.parts).filter(n => !o.dmg.parts[n].broken)
        .sort((a, b) => o.dmg.parts[a].obj.getWorldPosition(_v).distanceTo(c) - o.dmg.parts[b].obj.getWorldPosition(_w).distanceTo(c));
      near.slice(0, Math.ceil(k * 4)).forEach(n => o.dmg.breakPart(n, o.vel, 10 * k));
      o.dmg.bodyHp -= k * 30;
      if (o.dmg.dead) { o.lastHit = d.lastHit || 'other'; killDrone(o); }
    }
    if (jet.damage && !jet.damage.burning) {
      const dist = ac.pos.distanceTo(c);
      if (dist < R) {
        const k = 1 - dist / R, P = jet.damage.parts;
        const near = Object.keys(P).filter(n => !P[n].broken).sort((a, b) => P[a].obj.getWorldPosition(_v).distanceTo(c) - P[b].obj.getWorldPosition(_w).distanceTo(c));
        near.slice(0, Math.floor(k * 3.5)).forEach(n => jet.damage.breakPart(n, ac.vel, 6 * k));
        jet.damage.bodyHp -= k * 26;
        for (let i = 0; i < 6 * k; i++) hitFx(ac.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 6)), ac.vel);
      }
    }
  }
  function killDrone(d) {
    if (d.falling) return;
    d.killedBy = d.lastHit || 'other'; S.kills.push({ d, by: d.killedBy });
    // will it blow up? Lost a wing: it tumbles for a while first (the tanks go as it comes apart); anything else
    // (fuselage, tail, fire): it goes at once
    // the last one standing: it never just blows apart, and it always goes down burning (the ending watches it)
    const last = drones.every(o => o === d || !o.alive || o.falling);
    if (last) d.dmg.ablaze();
    if (!last && S.detonateChance(d) && S.detonateOK(d)) {
      const P = d.dmg.parts, wing = ['wingInnerL', 'wingInnerR', 'wingOuterL', 'wingOuterR'].some(n => P[n]?.broken);
      if (wing) d.detonateAt = (d.age || 0) + 1.5 + Math.random() * 2.5; else detonate(d);
    }
    d.falling = true; d.dmg.doomed = true;   // (every fire on it burns fully again)
    startCrippled(d, d.def.crippled);
  }

  // the player's jet touching an enemy (flying or going down): both lose what touched, the enemy goes down, and
  // a hard enough closing speed kills the player too
  const _cp = new THREE.Vector3();
  function collisions() {
    if (!jet.damage || jet.damage.burning) return;
    for (const d of drones) {
      if (!d.alive) continue;
      const R = (d.def.hitRadius || cfg.hitRadius) * 0.6 + 4;
      if (d.pos.distanceToSquared(ac.pos) > R * R) continue;
      const closing = _cp.subVectors(ac.vel, d.vel).length();
      const nearest = (dmg, to, n) => Object.keys(dmg.parts).filter(k => !dmg.parts[k].broken)
        .sort((a, b) => dmg.parts[a].obj.getWorldPosition(_v).distanceTo(to) - dmg.parts[b].obj.getWorldPosition(_w).distanceTo(to)).slice(0, n);
      nearest(d.dmg, ac.pos, 2).forEach(k => d.dmg.breakPart(k, d.vel));
      nearest(jet.damage, d.pos, closing > 60 ? 3 : 1).forEach(k => jet.damage.breakPart(k, ac.vel));
      if (closing > 60) jet.damage.bodyHp = 0;
      _cp.lerpVectors(ac.pos, d.pos, 0.5);
      for (let i = 0; i < 4; i++) hitFx(_cp, d.vel);
      killDrone(d);
      return;
    }
  }

  // ---------------- effects
  // War Thunder-style blast: a short flash, a cluster of irregular fire puffs that roll outward and up and
  // cool from white-yellow through orange and deep red to brown smoke, lingering smoke, and burning debris.
  function explode(p, vel, scale = 1, embers = false) {
    S.onBoom?.(p, scale);                                         // (the camera may shake: main.js)
    const carry = vel.clone().multiplyScalar(0.25);
    S.fx.push({ pri: 1, kind: 'fire', p: p.clone(), v: carry.clone(), t: 0, life: 0.18, s: 18 * scale });
    const n = Math.round(14 + 10 * scale);
    for (let k = 0; k < n; k++) {
      const d = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 0.6, Math.random() * 2 - 1).normalize();
      const sp = (8 + Math.random() * 22) * scale;
      S.fx.push({ pri: 1, kind: 'ball', p: p.clone().addScaledVector(d, Math.random() * 3 * scale), v: d.multiplyScalar(sp).add(carry), t: -Math.random() * 0.1,
        life: (1.1 + Math.random() * 1.3) * (0.8 + 0.25 * scale), s: (3.5 + Math.random() * 4.5) * scale, seed: Math.random() });
    }
    for (let k = 0; k < Math.round(5 + 4 * scale); k++) {   // soot: black puffs boiling through and around the fire
      const d = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 0.4, Math.random() * 2 - 1).normalize();
      S.fx.push({ pri: 1, kind: 'ball', soot: 1, p: p.clone().addScaledVector(d, (2 + Math.random() * 4) * scale), v: d.multiplyScalar((6 + Math.random() * 16) * scale).add(carry), t: -0.05 - Math.random() * 0.25,
        life: (2.2 + Math.random() * 1.6) * (0.8 + 0.25 * scale), s: (3.5 + Math.random() * 3.5) * scale, seed: Math.random() });
    }
    for (let k = 0; k < 7; k++) {
      const d = new THREE.Vector3(Math.random() - 0.5, 0.3 + Math.random() * 0.5, Math.random() - 0.5).multiplyScalar(6 * scale);
      S.fx.push({ pri: 1, kind: 'smoke', p: p.clone().addScaledVector(d, 1), v: d.add(carry).add(new THREE.Vector3(0, 3, 0)), t: -0.35 - Math.random() * 0.6,
        life: 7 + Math.random() * 4, s: (6 + Math.random() * 5) * scale, seed: Math.random(), dark: 1, rise: 1 });
    }
    for (let k = 0; embers && k < Math.round(6 * scale) + 2; k++) {
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 - 0.15, Math.random() - 0.5).normalize().multiplyScalar((35 + Math.random() * 60) * scale);
      S.fx.push({ pri: 1, kind: 'ember', p: p.clone(), v: d.add(carry), t: 0, life: 1.2 + Math.random() * 1.6, s: 0.45 + Math.random() * 0.4 });
    }
  }
  // something hitting a lake: a white column of spray thrown up and falling back, then drifting mist
  function splash(p, vel, scale = 1) {
    const at = new THREE.Vector3(p.x, terrain.heightAt(p.x, p.z) + 0.3, p.z);
    const fwd = new THREE.Vector3(vel.x, 0, vel.z).multiplyScalar(0.12);
    for (let i = 0; i < 9 * Math.min(scale, 3); i++) {
      const a = Math.random() * Math.PI * 2, out = (2 + Math.random() * 6) * scale;
      S.fx.push({ pri: 1, kind: 'smoke', spray: 1, p: at.clone(), v: new THREE.Vector3(Math.cos(a) * out, (9 + Math.random() * 14) * Math.sqrt(scale), Math.sin(a) * out).add(fwd),
        t: -Math.random() * 0.25, life: 1.6 + Math.random() * 1.0, s: (1.6 + Math.random() * 1.6) * scale, seed: Math.random() });
    }
    // a big one also throws up a tall column of white water
    if (scale > 1.2) for (let i = 0; i < (scale > 2.2 ? 18 : 10); i++) {
      const a = Math.random() * Math.PI * 2, out = Math.random() * 2.5;
      S.fx.push({ pri: 1, kind: 'smoke', spray: 1, col: 1, p: at.clone().add(new THREE.Vector3(Math.cos(a) * out, 0, Math.sin(a) * out)),
        v: new THREE.Vector3(Math.cos(a) * out * 0.6, (14 + i * 2.6 + Math.random() * 4) * Math.sqrt(scale / 1.9), Math.sin(a) * out * 0.6).add(fwd.clone().multiplyScalar(0.5)),
        t: -i * 0.03, life: 2.6 + Math.random() * 0.8, s: (2.2 + Math.random() * 1.2) * scale / 1.6, seed: Math.random() });
    }
    for (let i = 0; i < 2 * Math.min(scale, 3); i++)
      S.fx.push({ pri: 1, kind: 'smoke', mist: 1, p: at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 8 * scale, 1, (Math.random() - 0.5) * 8 * scale)), v: new THREE.Vector3((Math.random() - 0.5) * 2, 1 + Math.random(), (Math.random() - 0.5) * 2).add(fwd),
        t: -0.3 - Math.random() * 0.5, life: 3 + Math.random() * 1.5, s: (2.5 + Math.random() * 1.5) * scale, seed: Math.random() });
  }
  // skimming the water: a little spray kicked up behind the contact point (a few puffs a second)
  function spray(p, vel) {
    const at = new THREE.Vector3(p.x, terrain.heightAt(p.x, p.z) + 0.2, p.z);
    S.fx.push({ kind: 'smoke', spray: 1, p: at, v: vel.clone().multiplyScalar(0.3).add(new THREE.Vector3((Math.random() - 0.5) * 4, 5 + Math.random() * 5, (Math.random() - 0.5) * 4)),
      t: 0, life: 0.9 + Math.random() * 0.5, s: 1.2 + Math.random() * 0.8, seed: Math.random() });
  }
  function spark(p) { S.fx.push({ kind: 'spark', p: p.clone(), v: new THREE.Vector3(), t: 0, life: 0.12, s: 2.5 }); }
  // a round hitting an aircraft: bits of skin flying off, a small grey puff, a few short sparks, sometimes a quick lick of flame.
  // Everything moves on with the aircraft, so it reads as hits on it rather than flashes in the air.
  function hitFx(p, vel) {
    const carry = vel.clone().multiplyScalar(0.85);
    const rnd = (k) => new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize().multiplyScalar(k);
    for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++)
      S.fx.push({ kind: 'chip', p: p.clone(), v: carry.clone().add(rnd(12 + Math.random() * 18)), t: 0, life: 1.2 + Math.random(), s: 0.12 + Math.random() * 0.12, seed: Math.random() });
    S.fx.push({ kind: 'smoke', p: p.clone(), v: carry.clone().add(rnd(2)), t: 0, life: 1.4 + Math.random() * 0.6, s: 0.5 + Math.random() * 0.3, seed: Math.random(), spread: 1, hit: 1 });
    for (let i = 0; i < 3; i++)
      S.fx.push({ kind: 'sparkle', p: p.clone(), v: carry.clone().add(rnd(25 + Math.random() * 25)), t: 0, life: 0.12 + Math.random() * 0.12, s: 0.06 });
    if (Math.random() < 0.25) S.fx.push({ kind: 'ball', burn: 1, p: p.clone(), v: carry.clone(), t: 0, life: 0.35, s: 0.6, seed: Math.random() });
  }

  // ---------------- per physics step
  function step(dt, now) {
    collisions();
    S.simT = (S.simT || 0) + dt;   // game time: trails age with the simulation, independent of frame rate
    for (const d of drones) flyDrone(d, dt);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(ac.quat);   // own vector: _v/_w are reused below
    // guns
    S.flash[0] = Math.max(0, S.flash[0] - dt); S.flash[1] = Math.max(0, S.flash[1] - dt);
    if (S.firing && S.selected === 1 && S.allow.gun) {
      S.gunAcc += dt * cfg.gunRate;
      while (S.gunAcc >= 1) {
        S.gunAcc -= 1;
        const side = S.gunSide ^= 1;
        const muzzle = MUZZLES[side].clone().applyQuaternion(ac.quat).add(ac.pos);
        let aimDir = fwd;
        // aim assist: rounds fired with the nose near the gun solution are bent onto the predicted intercept,
        // fully inside the inner cone and fading out by the outer one; a target that breaks hard still makes them miss
        if (S.lead && S.target && S.target.pos.distanceTo(ac.pos) <= cfg.gunRange) {
          const toLead = _q2.subVectors(S.lead, muzzle).normalize();
          const ang = Math.acos(THREE.MathUtils.clamp(toLead.dot(fwd), -1, 1)) * 180 / Math.PI;
          const k = 1 - THREE.MathUtils.smoothstep(ang, cfg.assistFull * S.hitScale, cfg.assistAngle * S.hitScale);
          if (k > 0) aimDir = fwd.clone().lerp(toLead, k).normalize();
        }
        const dir = aimDir.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, 0).multiplyScalar(cfg.gunSpread).applyQuaternion(ac.quat)).normalize();
        const v = dir.multiplyScalar(cfg.muzzleVelocity).add(ac.vel);
        S.rounds.push({ p: muzzle, prev: muzzle.clone(), start: muzzle.clone(), v, t: 0 }); S.shots++;
        S.flash[side] = 0.05;
      }
    } else S.gunAcc = 0;
    for (const r of S.rounds) {
      r.prev.copy(r.p);
      r.v.y -= G * dt;
      r.p.addScaledVector(r.v, dt);
      r.t += dt;
      for (const d of drones) if (d.alive && segDist(r.prev, r.p, d.pos) < (d.def.hitRadius || cfg.hitRadius) * S.hitScale) {   // (going-down wrecks still take hits)
        r.t = 1e9; const at = closestOnSeg(r.prev, r.p, d.pos); hitFx(at, d.vel);
        d.dmg.hit(at, d.vel, cfg.gunDamage || 1); d.lastHit = 'gun'; S.hits++;
        if (d.dmg.dead) killDrone(d); else S.onHit?.(d);   // (hit but flying: the mission's AI may react)
        break;
      }
      else if (r.p.y < terrain.heightAt(r.p.x, r.p.z)) {
        r.t = 1e9;
        // rounds hitting the ground: a small faint dust puff on land, a bigger bright splash puff on water
        const wet = terrain.isWater(r.p.x, r.p.z);
        if (Math.random() < 0.5) S.fx.push({ kind: 'smoke', dust: wet ? 0 : 1, wet: wet ? 1 : 0, p: r.p.clone().setY(terrain.heightAt(r.p.x, r.p.z) + 0.5), v: new THREE.Vector3((Math.random() - 0.5) * 3, 3 + Math.random() * 3, (Math.random() - 0.5) * 3), t: 0, life: 1.6 + Math.random(),
          s: wet ? 1.0 + Math.random() * 0.8 : 0.55 + Math.random() * 0.45, seed: Math.random(), spread: 1, fade: wet ? 1 : 0.6 });
      }
    }
    S.rounds = S.rounds.filter(r => r.t < cfg.roundLife);

    // selected target: keep it while it's alive, otherwise take the one nearest the nose
    if (!S.target || !S.target.alive || S.target.falling) S.target = nearestToNose(fwd, null);
    // gun lead: where to point so rounds (muzzle speed + our own velocity, dropping with gravity) meet the target
    S.lead = null;
    if (S.target) {
      const T = S.target, rel = _w.subVectors(T.vel, ac.vel);
      let tf = T.pos.distanceTo(ac.pos) / cfg.muzzleVelocity;
      const L = new THREE.Vector3();
      for (let i = 0; i < 3; i++) {
        L.copy(T.pos).addScaledVector(rel, tf); L.y += 0.5 * G * tf * tf;
        tf = L.distanceTo(ac.pos) / cfg.muzzleVelocity;
      }
      S.lead = L; S.leadTime = tf;
    }
    // seeker and lock
    if (S.selected !== 2) S.seeker = null;
    if (S.selected === 2 && S.stock > 0) {
      const half = cfg.seekerFov / 2;
      // pick: anything right by the reticle first (nearest it); then aircraft no missile of ours is after yet; only then
      // ones already being chased (so after a launch the seeker moves on to the next aircraft)
      const chased = (d) => S.missiles.some(m => m.owner === 'player' && m.target === d);
      let best = null, bestAng = 1e9;
      for (const d of drones) {
        if (!d.alive || d.falling || d.hidden || d.noLock || !clearLine(ac.pos, d.pos)) continue;   // no locks through terrain, on aircraft going down (missiles in flight keep after them) or on ones the mission hides
        const to = _w.subVectors(d.pos, ac.pos), dist = to.length();
        const ang = Math.acos(THREE.MathUtils.clamp(to.dot(fwd) / dist, -1, 1)) * 180 / Math.PI;
        const lim = S.locked && d === S.seeker ? half * 1.4 : half;
        if (dist >= cfg.lockRange || ang >= lim) continue;
        const score = ang + (ang < cfg.lockCentre ? 0 : chased(d) ? 2000 : 1000);
        if (score < bestAng) { best = d; bestAng = score; }
      }
      if (best && best !== S.seeker) S.lock = 0;
      if (best) { S.seeker = best; S.lock = Math.min(S.lock + dt, cfg.lockTime); }
      else { S.lock = Math.max(0, S.lock - dt * 3); if (S.lock <= 0) S.seeker = null; }
    } else S.lock = 0;
    S.locked = S.lock >= cfg.lockTime;

    // reload
    // a station whose wing section broke off is gone (its missile went down with the piece)
    railMeshes.forEach((m, k) => { S.lost[k] = !onJet(m); m.visible = S.loaded[k]; });
    S.stock = S.loaded.filter((l, k) => l && !S.lost[k]).length;

    // missiles in flight
    for (const m of S.missiles) {
      m.t += dt;
      m.prev.copy(m.p);
      const speed = m.v.length();
      if (m.t > IGNITE && m.t < IGNITE + cfg.motorTime) m.v.addScaledVector(m.dir, cfg.missileThrust * dt);
      if (m.t > IGNITE) { m.v.y -= G * dt * 0.3; m.v.multiplyScalar(1 - cfg.missileDrag * speed * dt); }
      // out of energy after burnout: it can't catch anything any more, so it self-destructs
      if (m.t > IGNITE + cfg.motorTime && speed < cfg.missileMinSpeed) m.t = Math.max(m.t, cfg.missileLife);
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
        if (armed && m.p.distanceTo(m.target.pos) < Math.max(cfg.proximity, (m.target.def.hitRadius || 0) * 0.6)) {   // (a target already going down still gets hit)
          m.t = 1e9; explode(m.p, m.target.vel, 0.8);
          S.fx.push({ pri: 1, kind: 'fire', p: m.p.clone(), v: m.target.vel.clone().multiplyScalar(0.3), t: 0, life: 0.3, s: 12 });   // warhead flash
          // the blast tears off what was closest to it, then the jet goes down
          const near = Object.keys(m.target.dmg.parts).sort((a, b) => m.target.dmg.parts[a].obj.getWorldPosition(_v).distanceTo(m.p) - m.target.dmg.parts[b].obj.getWorldPosition(_w).distanceTo(m.p));
          near.slice(0, 3 + Math.floor(Math.random() * 3)).forEach(n => m.target.dmg.breakPart(n, m.target.vel));
          m.target.lastHit = 'missile'; killDrone(m.target);
        }
      } else if (speed > 1) m.dir.copy(m.v).normalize();
      m.p.addScaledVector(m.v, dt);
      if (m.p.y < terrain.heightAt(m.p.x, m.p.z)) { explode(m.p, new THREE.Vector3(), 0.6); m.t = 1e9; }
      if (m.t > IGNITE && m.t < IGNITE + cfg.motorTime) {                  // a trail point every 6 m of flight
        const last = m.trail.pts[m.trail.pts.length - 1];
        if (!last || last.p.distanceTo(m.p) > 6) trails.add(m.trail, m.p, S.simT);
      }
    }
    for (const m of S.missiles) if (m.t >= cfg.missileLife || m.t >= 1e9) { if (m.t < 1e9) explode(m.p, m.v, 0.5); m.trail.live = false; scene.remove(m.obj); }
    S.missiles = S.missiles.filter(m => m.t < cfg.missileLife && m.t < 1e9);
  }

  // true if nothing of the terrain lies between a and b (sampled every ~60 m, a little margin above the ground)
  function clearLine(a, b) {
    const d = a.distanceTo(b), n = Math.max(2, Math.ceil(d / 60));
    for (let i = 1; i < n; i++) {
      const t = i / n, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t;
      if (y < terrain.heightAt(x, z) + 5) return false;
    }
    return true;
  }

  // the live drone closest to the nose direction, skipping 'skip' (so repeated presses cycle through them)
  function nearestToNose(fwd, skip) {
    let best = null, bestA = 1e9;
    for (const d of drones) {
      if (!d.alive || d.falling || d.hidden || d === skip) continue;
      const to = _v.subVectors(d.pos, ac.pos), dist = to.length();
      const a = Math.acos(THREE.MathUtils.clamp(to.dot(fwd) / dist, -1, 1)) + dist / 40000;
      if (a < bestA) { bestA = a; best = d; }
    }
    return best;
  }

  function fireMissile(now) {
    if (!S.locked || !S.seeker || S.seeker.falling) return;   // no lock, no launch (and never at a wreck)
    let k = -1;
    for (let i = RAILS.length - 1; i >= 0; i--) if (S.loaded[i] && !S.lost[i]) { k = i; break; }
    if (k < 0) return;
    S.loaded[k] = false;
    const p = RAILS[k].clone().applyQuaternion(ac.quat).add(ac.pos);
    const obj = proto.clone(true); scene.add(obj);
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(ac.quat);
    S.missiles.push({ obj, p, prev: p.clone(), v: ac.vel.clone().add(_v.set(0, -4, 0).applyQuaternion(ac.quat)), dir, t: 0, target: S.locked ? S.seeker : null, trail: trails.start(), owner: 'player' });
    S.lock = 0;
  }

  // ---------------- condensation: wing vapour under G, a vapour collar around the fuselage near Mach 1
  // Soft short-lived puffs in the missile-cloud colour that ride along with the jet and peel off as they fade.
  // Body frame relative to the CG: +x left wing, +y up, +z nose (the model is offset by its CG, 0 1.9 -0.6).
  const _vp = new THREE.Vector3(), _vv = new THREE.Vector3();
  // the vapour cone as one smooth surface: an open cone around the fuselage, opening backward from just ahead of the
  // canopy. Seen through, it is nearly clear; toward its silhouette (grazing view) it thickens, like a thin sheet of
  // mist. Soft noise keeps it from looking like solid geometry; both rims fade out.
  const machShell = new THREE.Mesh(
    new THREE.CylinderGeometry(0.95, 4.5, 6.0, 64, 8, true).rotateX(Math.PI / 2).translate(0, 1.72, -1.5),   // (narrow end forward)
    new THREE.ShaderMaterial({
      uniforms: { uK: { value: 0 }, uTime: { value: 0 } },
      vertexShader: `varying vec3 vN; varying vec3 vV; varying vec2 vUv;
        void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform float uK; uniform float uTime; varying vec3 vN; varying vec3 vV; varying vec2 vUv; ${ENCODE_GLSL}
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
        void main(){
          float graze = 1.0 - abs(dot(normalize(vN), normalize(vV)));
          float sheet = pow(graze, 2.2);
          float along = vUv.y;                                    // 1 at the front rim, 0 at the back
          float rims = smoothstep(1.0, 0.8, along) * smoothstep(0.0, 0.45, along);
          float n = n2(vec2(vUv.x * 18.0, vUv.y * 6.0 - uTime * 3.0)) * 0.6 + n2(vec2(vUv.x * 41.0, vUv.y * 13.0 + uTime * 5.0)) * 0.4;
          float a = uK * rims * (0.62 + 0.75 * sheet) * (0.75 + 0.4 * n);   // visible from any side (face-on through it too), thicker toward its silhouette
          a = min(0.95, a + 0.35 * a * a);                         // the thick parts come out nearly solid
          if (a < 0.003) discard;
          gl_FragColor = vec4(vec3(0.9, 0.92, 0.95) * a, a);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    }));
  machShell.visible = false; machShell.renderOrder = 2;
  jet.model.add(machShell);
  // (spawned once per rendered frame at the drawn jet; the render step then moves every puff on by v*dt, so each is
  // placed that much back to land exactly on the airframe)
  let _bp = ac.pos, _bq = ac.quat, _bdt = 0;
  const toWorld = (x, y, z) => _vp.set(x, y - 1.9, z + 0.6).applyQuaternion(_bq).add(_bp);
  const sm = (a, b, x) => THREE.MathUtils.smoothstep(x, a, b);
  function vapour(dt, pos, quat) {
    _bp = pos; _bq = quat; _bdt = dt;
    if (!jet.damage || jet.damage.burning || dt <= 0) { machShell.visible = false; return; }
    // riding puffs: kept at a spot on the airframe (body frame), drifting slowly aft, so they never lag or smear
    const ride = (x, y, z, o) => S.fx.push({ kind: 'vapor', ride: 1, lx: x, ly: y, lz: z, p: toWorld(x, y, z).clone(), v: new THREE.Vector3(), t: 0, ...o });
    const back = (e) => { e.p.addScaledVector(e.v, -dt); S.fx.push(e); };
    const alt = ac.pos.y, humid = 1 - 0.6 * sm(3000, 9000, alt);            // more moisture low down
    const fast = sm(90, 150, ac.t.ias || 0);
    const P = jet.damage.parts, gone = (n) => !!P[n]?.broken;
    // wing vapour: from ~5 G, thick by 8 G
    const kw = Math.pow(sm(3.2, 8, ac.t.g || 0), 1.4) * fast * humid;   // creeps in from ~3.5 G, thick by 8 G
    if (kw > 0.02) {
      const rate = (90 + 80 * kw) * kw * dt, n = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);   // up to ~170 small puffs/s at full
      for (let i = 0; i < n; i++) {
        const sx = Math.random() < 0.5 ? 1 : -1, side = sx > 0 ? 'L' : 'R';
        const x = 1.3 + Math.random() * 2.6;
        if (gone('wingInner' + side) || (x > 2.45 && gone('wingOuter' + side))) continue;
        const le = -0.22 - 0.46 * (x - 1.6), z = le - Math.pow(Math.random(), 1.6) * 1.1;   // most of it near the leading edge
        if (Math.random() < 0.18) {                                     // some of it peels off behind the wing
          toWorld(sx * x, 1.6 + Math.random() * 0.16, le - 1.0 - Math.random() * 0.3);
          back({ kind: 'vapor', p: _vp.clone(), v: ac.vel.clone().multiplyScalar(0.93), t: 0, life: 0.3 + Math.random() * 0.25,
            s: 0.5 + Math.random() * 0.35, seed: Math.random(), op: 0.3 * kw, grow: 1.6 });
          continue;
        }
        ride(sx * x, 1.6 + Math.random() * 0.16, z, { life: 0.28 + Math.random() * 0.14, drift: 2.5,     // just over the skin: it wraps the wing
          s: 0.42 + Math.random() * 0.2, seed: Math.random(), op: Math.min(0.42, 0.36 * kw + 0.06), grow: 1.1 });
      }
    }
    // wingtip vortices: thin ribbons from each intact wingtip at high G (none from a tip that has broken off)
    const kv = sm(5.5, 8.5, ac.t.g || 0) * fast * humid;
    [1, -1].forEach((sx, l) => {
      if (kv < 0.05 || gone('wingOuter' + (sx > 0 ? 'L' : 'R'))) { vortices.cut(l); return; }
      toWorld(sx * 4.15, 1.3, -1.75);
      vortices.add(l, _vp, S.simT || 0, 0.5 * kv);
    });
    // vapour collar ("Mach cone"): transonic, strongest just under Mach 1. A few faint flickering puffs as it starts,
    // then a smooth translucent shell (machShell) that takes over as it builds
    // builds from M 0.9 as flickering puffs, peaks from M 0.99 to 1.01 as a smooth shell, gone soon after
    const M = ac.t.mach || 0, km = sm(0.95, 0.985, M) * (1 - sm(1.012, 1.025, M)) * (0.4 + 0.6 * humid);
    const peak = sm(0.982, 0.989, M) * (1 - sm(1.011, 1.018, M));   // snaps in and out
    machShell.material.uniforms.uK.value = km * peak;
    machShell.material.uniforms.uTime.value = S.simT || 0;
    machShell.visible = machShell.material.uniforms.uK.value > 0.01;
    if (km > 0.02) {
      // weak: a jittery scatter around the fuselage; at the peak the puffs settle onto a cone shell that opens
      // backward from just ahead of the canopy, bigger and denser
      const shell = peak;                                    // (the puffs give way to the shell at the peak)
      const rate = 160 * km * (1 - shell) * dt, n = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, aft = Math.sqrt(Math.random());
        const coneR = 0.7 + aft * (1.4 + 2.6 * shell), r = coneR * (1 + (Math.random() - 0.5) * (0.9 - 0.82 * shell));
        ride(Math.cos(a) * r, 1.75 + Math.sin(a) * r * 0.95, 1.4 - aft * (2.4 + 2.2 * shell), { life: 0.3 + Math.random() * 0.2, drift: 1.2,
          s: 0.5 + Math.random() * 0.3, seed: Math.random(), op: 0.22 * km * (1 - shell), grow: 1.1 });
      }
    }
  }

  // ---------------- contrails: above ~25,000 ft every engine leaves a white trail (twin engines close together, like
  // ours, make one); long-lived ribbons that spread as they age. Lines: 0 = us, then each enemy's engines.
  const CONTRAIL_ALT = 7620, CONTRAIL_FULL = 8300;
  const trailOwners = [{ key: 'player', n: 1 }];
  for (const d of drones) {
    const eng = d.props.filter(p => p.userData.prop === 1);          // one disc per engine (front of each pair)
    trailOwners.push({ key: d, n: eng.length || 1, eng });
  }
  const lineOf = new Map(); let nLines = 0;
  for (const o of trailOwners) { lineOf.set(o.key, nLines); nLines += o.n; }
  const contrails = new Vortices(nLines, 110);
  contrails.mesh.renderOrder = 1;
  scene.add(contrails.mesh);
  const _ct = new THREE.Vector3(), _cf = new THREE.Vector3();
  const lastC = [];
  function contrailPoint(l, p, k) {
    const L = contrails.lines[l], last = lastC[l];
    if (k <= 0.01) { contrails.cut(l); lastC[l] = null; return; }
    if (last && last.distanceToSquared(p) < 28 * 28) return;      // a point every ~28 m
    if (last && last.distanceToSquared(p) > 800 * 800) contrails.cut(l);   // jumped (respawn): new line
    contrails.add(l, p, S.simT || 0, 0.75 * k);
    lastC[l] = p.clone();
  }
  function contrailsStep(pos, quat, playerAlive) {
    const sm2 = (y) => THREE.MathUtils.smoothstep(y, CONTRAIL_ALT, CONTRAIL_FULL);
    // ours: from between the two nozzles
    _ct.set(0, 1.628 - 1.9, -6.9 + 0.6).applyQuaternion(quat).add(pos);
    contrailPoint(0, _ct, playerAlive ? sm2(pos.y) : 0);
    for (const d of drones) {
      const l0 = lineOf.get(d), owner = trailOwners.find(o => o.key === d);
      const k = d.alive && !d.falling ? sm2(d.pos.y) : 0;
      if (owner.eng.length) owner.eng.forEach((e, i) => { e.getWorldPosition(_ct); _cf.set(0, 0, -1).applyQuaternion(d.obj.quaternion); _ct.addScaledVector(_cf, 6); contrailPoint(l0 + i, _ct, k); });
      else { _cf.set(0, 0, -1).applyQuaternion(d.obj.quaternion); _ct.copy(d.pos).addScaledVector(_cf, 5); contrailPoint(l0, _ct, k); }
    }
  }

  // ---------------- per frame: draw effects
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  function render(camera, dt, now, alpha, drawPos, drawQuat, renderer) {
    glow.begin(); smoke.begin();
    vortices.update(S.simT || 0, camera.position);
    contrails.update(S.simT || 0, camera.position, 14, 0.7, 0.35);
    // propellers (contra-rotating, 4 blades): each rendered frame they step a fixed share of the gap between blades,
    // 1/8: small enough that the eye sees continuous motion (bigger steps read as stutter or a backwards crawl).
    // Going down, the engines wind down and they turn slower.
    if (dt > 0) for (const d of drones) if (d.props.length && d.obj.visible) for (const p of d.props) p.rotateX(p.userData.prop * (Math.PI / 2) * (d.falling ? 0.05 : 0.125));   // (about the pivot's own axis: it carries a turn from being re-parented)
    const cam = camera.position;
    // tracers
    tracers.begin(renderer);
    const px = renderer.getPixelRatio();
    for (const r of S.rounds) {
      const head = tmpA.copy(r.prev).lerp(r.p, alpha);
      const back = Math.min(cfg.tracerLength, head.distanceTo(r.start));
      const tail = tmpB.copy(r.v).normalize().multiplyScalar(-back).add(head);
      const dist = head.distanceTo(cam);
      const fade = r.t > cfg.roundLife - 0.4 ? (cfg.roundLife - r.t) / 0.4 : 1;
      const width = THREE.MathUtils.clamp(cfg.tracerWidthPx * 120 / Math.max(dist, 1), cfg.tracerMinPx, cfg.tracerWidthPx) * px;
      tracers.push(head, tail, fade * (0.45 + 0.55 / (1 + dist / 900)), width);
    }
    tracers.end();
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
        f.tF = 0.07 / big;
        const off = new THREE.Vector3((Math.random() - 0.5) * 8 * big, 0, (Math.random() - 0.5) * 8 * big);
        S.fx.push({ pri: 1, kind: 'ball', burn: 1, p: f.p.clone().add(off), v: new THREE.Vector3(1.5 + Math.random(), 6 + Math.random() * 6, 1), t: 0, life: 1.4 + Math.random() * 0.9, s: (2.6 + Math.random() * 2.8) * big * (0.4 + 0.6 * power), seed: Math.random() });
      }
      if ((f.tS -= dt) <= 0) {
        f.tS = 0.4 / big;
        S.fx.push({ pri: 1, kind: 'smoke', p: f.p.clone().add(new THREE.Vector3(0, 10 * big, 0)), v: new THREE.Vector3(3 + Math.random() * 2, 7 + Math.random() * 4, 1.5 + Math.random()), t: 0, life: 9 + Math.random() * 4, s: (3.5 + Math.random() * 2.5) * big, seed: Math.random(), dark: 1, rise: 1 });
      }
    }
    for (let i = fires.length - 1; i >= 0; i--) if (fires[i].t > fires[i].life) fires.splice(i, 1);

    // explosions, smoke, fire
    for (const e of S.fx) {
      e.t += dt; if (e.t < 0 || e.t >= e.life) continue;   // (a puff past its life would fade to NaN and flash white)
      e.p.addScaledVector(e.v, dt); e.v.multiplyScalar(1 - dt * (e.kind === 'ball' ? (e.burn ? 1.4 : 2.2) : e.kind === 'vapor' ? 0.6 : 0.8));
      const k = e.t / e.life;
      if (e.kind === 'ball') {
        e.v.y += dt * 9 * k;                                   // hot gas rises as it slows
        const c = e.soot ? SOOT : fireRamp(e.burn ? 0.1 + k * 0.9 : k);
        const alpha = k < 0.6 ? 0.95 : 0.95 * (1 - (k - 0.6) / 0.4);
        smoke.push(e.p, null, c[0], c[1], c[2], alpha * Math.min(1, e.t * 20), e.s * (e.bloom ? 0.8 + 3.5 * k : 0.55 + 1.3 * Math.sqrt(k)), e.seed, e.pri || 0);
      } else if (e.kind === 'fire') {
        glow.push(e.p, null, 1.0, 0.75, 0.45, 3.5 * (1 - k), e.s * (0.6 + k * 0.6), 0.3, 1);
      } else if (e.kind === 'smoke') {
        if (e.rise) e.v.y += dt * 0.6;
        if (e.spray) e.v.y -= G * dt * (e.col ? 0.55 : 0.8);    // spray falls back (the column hangs a little longer)
        const g = e.wet ? 0.8 + 0.08 * e.seed : e.spray || e.mist ? 0.88 + 0.08 * e.seed : e.dust ? 0.56 + 0.08 * e.seed : e.hit ? 0.36 + 0.08 * e.seed : e.dark ? 0.055 + 0.06 * e.seed : 0.74 + 0.1 * e.seed;     // dark sooty grey, with some near-black
        const grow = e.spread ? 0.8 + 7 * (1 - Math.exp(-e.t * 0.9)) : 0.6 + k * 1.9;   // trail puffs swell quickly so they merge
        smoke.push(e.p, null, g * 0.97, g, g * 1.04, 0.7 * (e.fade || 1) * Math.min(1, e.t * 3) * Math.pow(1 - k, 1.4), e.s * grow * (e.scale || 1), e.seed, e.pri || 0);
      } else if (e.kind === 'vapor') {                        // condensation: fades in and out fast, swells a little
        if (e.ride) e.p.copy(toWorld(e.lx, e.ly, e.lz - e.drift * e.t));
        const g = 0.76 + 0.1 * e.seed;
        const env = e.soft ? Math.sin(Math.PI * Math.min(k * 1.2, 1)) : THREE.MathUtils.smoothstep(k, 0, 0.35) * (1 - THREE.MathUtils.smoothstep(k, 0.5, 1));   // fade in, hold, fade out (no popping)
        smoke.push(e.p, null, g * 0.97, g, g * 1.04, e.op * env, e.s * (1 + (e.grow - 1) * k), e.seed);
      } else if (e.kind === 'flame') {
        glow.push(e.p, null, 1.0, 0.3 + 0.25 * (1 - k), 0.03, 0.75 * (1 - k), e.s * (0.8 + k * 0.8), Math.random());
      } else if (e.kind === 'ember') {
        e.v.y -= G * dt;
        const tail = tmpB.copy(e.v).multiplyScalar(-0.06).add(e.p);
        glow.push(e.p, tail, 1.0, 0.45 + 0.3 * (1 - k), 0.08, 2.2 * (1 - k * 0.7), e.s * 0.6);
        emit('smoke', e.p, e.v, e);
      } else if (e.kind === 'chip') {                       // a bit of skin: small dark fleck tumbling away under gravity
        e.v.y -= G * dt;
        const cg = e.light ? 0.85 : 0.16;                    // (light: paint flakes)
        smoke.push(e.p, null, cg, cg, cg * 1.02, 0.95 * (1 - k * k), e.s, e.seed);
      } else if (e.kind === 'sparkle') {                    // a short spark streak
        const tail = tmpB.copy(e.v).multiplyScalar(-0.03).add(e.p);
        glow.push(e.p, tail, 1.0, 0.7, 0.35, 0.9 * (1 - k), e.s);
      } else glow.push(e.p, null, 1.0, 0.85, 0.55, 3.0 * (1 - k), e.s, 0.5);
    }
    S.fx = S.fx.filter(e => e.t < e.life);
    const simNow = S.simT || 0;
    trails.update(simNow, cam);
    // the old end of each missile trail turns into billowing cloud: lumpy, self-shaded puffs along the path
    for (const t of trails.list) {
      let lastD = -1e9;
      for (let k = 0; k < t.pts.length; k++) {
        const p = t.pts[k], age = simNow - p.t;
        if (age < 0.25 || p.d - lastD < 4) continue;
        lastD = p.d;
        // each puff sits a little off the line (seeded by its place along the trail), rises slowly and swells
        const h1 = Math.sin(p.d * 12.9898 + t.seed) * 43758.5453, r1 = h1 - Math.floor(h1);
        const h2 = Math.sin(p.d * 78.233 + t.seed * 3) * 12543.212, r2 = h2 - Math.floor(h2);
        const spread = Math.min(1, (age - 0.25) / 3) * 4;
        const at = trails.pointAt(t, k, simNow, tmpA);
        at.x += (r1 - 0.5) * spread; at.z += (r2 - 0.5) * spread; at.y += (r1 * r2 - 0.25) * spread + age * 0.6;
        const grow = 2.2 + 11 * (1 - Math.exp(-(age - 0.25) / 2.6)) * (0.75 + 0.5 * r2);   // ~4 m across, billowing to ~25 m
        const op = THREE.MathUtils.smoothstep(age, 0.25, 0.7) * Math.pow(Math.max(0, 1 - age / 10), 1.1) * 0.8;
        const tone = 0.72 + 0.12 * r1;                                    // off-white, a little greyer than a cloud
        smoke.push(at, null, tone * 0.97, tone, tone * 1.04, op, grow, (r1 + r2) % 1);
      }
    }
    glow.end(); smoke.end(cam);
  }

  return {
    S, drones,
    setFiring(on, now) {
      if (on && !S.firing && S.selected === 2 && S.allow.missile) fireMissile(now);
      S.firing = on;
    },
    select(k) { S.selected = k; S.lock = 0; },
    breakOff, toLoop,
    clearLine: (a, b) => clearLine(a, b),
    placeDrones() { drones.forEach((d, k) => placeDrone(d, k)); },   // around wherever the player is now (or on their tracks)
    resetStats() { S.kills.length = 0; S.shots = 0; S.hits = 0; },
    rearm() { S.loaded.fill(true); S.firing = false; },
    explode, hitFx, killDrone,   // (used by the dev tests)
    vapour, contrailsStep,
    step, render,
    missileProto: proto,
    trails, smoke, cfg,   // (dev tests)
    // the player's jet hit the ground: blast and a fire where it hit (the airframe itself is simulated by main.js)
    crash(p, v, water = false, ditched = false) {
      if (water) {   // a crash into the water: a big splash and a second one where it skips on (no fire); settling after a ditching: a small one
        if (ditched) { splash(p, v, 0.8); return; }
        splash(p, v, 2.6);
        splash(new THREE.Vector3().copy(p).addScaledVector(new THREE.Vector3(v.x, 0, v.z), 0.3), v, 1.9);
        return;
      }
      explode(p, v, 2.0);
      emit('groundfire', new THREE.Vector3(p.x, terrain.heightAt(p.x, p.z), p.z), new THREE.Vector3(1, 0, 0));
    },
    splash, spray,
    // a burning wreck moving along: smoke and flame laid down by distance like any other burning thing
    burn(p, v, key) { emit('smoke', p, v, key); emit('flame', p, v, key.flameKey || (key.flameKey = {})); },
    cycleTarget() {
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(ac.quat);
      S.target = nearestToNose(fwd, S.target) || S.target;
    },
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

// fire colour over a puff's life: white-yellow, orange, a brief deep red, then neutral grey smoke (emissive values above 1 glow)
const RAMP = [[0, 2.4, 2.0, 1.1], [0.12, 2.2, 1.05, 0.28], [0.3, 1.4, 0.38, 0.07], [0.41, 0.3, 0.11, 0.05], [0.53, 0.075, 0.073, 0.073], [1, 0.088, 0.088, 0.09]];
const SOOT = [0.034, 0.034, 0.036];
function fireRamp(k) {
  for (let i = 1; i < RAMP.length; i++) if (k <= RAMP[i][0]) {
    const a = RAMP[i - 1], b = RAMP[i], t = (k - a[0]) / (b[0] - a[0]);
    return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
  }
  return RAMP[RAMP.length - 1].slice(1);
}
