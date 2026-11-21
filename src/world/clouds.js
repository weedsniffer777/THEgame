import * as THREE from 'three';
import { FOG_GLSL, fogUniforms } from './sky.js';

// Cumulus made of soft billboard puffs (one instanced draw call). The field wraps around the camera so there are
// always clouds nearby, puffs are sorted back to front every frame, and flying into one fades the screen to white.
const FIELD = 60000;          // m: size of the repeating cloud field
const PUFFS = 14;            // puffs per cloud

export function createClouds(count, base) {
  const n = count * PUFFS;
  const home = [];            // per puff: x, y, z, radius, shade (0 at the flat bottom, 1 at the top)
  for (let c = 0; c < count; c++) {
    const cx = (Math.random() - 0.5) * FIELD, cz = (Math.random() - 0.5) * FIELD;
    const cb = base + Math.random() * 500, spread = 700 + Math.random() * 900, tall = 300 + Math.random() * 500;
    for (let k = 0; k < PUFFS; k++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * spread;
      const h = Math.pow(Math.random(), 1.6) * tall * (1 - d / spread * 0.6);
      const r = (220 + Math.random() * 260) * (1 - d / spread * 0.4);
      home.push(cx + Math.cos(a) * d, cb + h + r * 0.35, cz + Math.sin(a) * d * 0.7, r, h / tall);
    }
  }

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const aPuff = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const aShade = new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aPuff', aPuff);
  geo.setAttribute('aShade', aShade);
  geo.instanceCount = n;

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...fogUniforms },
    vertexShader: /* glsl */`
      attribute vec4 aPuff; attribute float aShade;
      varying vec2 vUv; varying float vShade; varying vec3 vWorld; varying float vNear; varying float vSeed;
      void main() {
        vec4 c = viewMatrix * vec4(aPuff.xyz, 1.0);
        c.xy += position.xy * aPuff.w;
        vUv = position.xy; vShade = aShade; vWorld = aPuff.xyz; vSeed = fract(aPuff.x * 0.013 + aPuff.z * 0.007);
        vNear = smoothstep(aPuff.w * 0.4, aPuff.w * 1.6, -c.z);   // fade puffs that fill the screen
        gl_Position = projectionMatrix * c;
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vUv; varying float vShade; varying vec3 vWorld; varying float vNear; varying float vSeed;
      ${FOG_GLSL}
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
      void main() {
        float r = length(vUv);
        float n = noise(vUv * 2.5 + vSeed * 40.0) * 0.6 + noise(vUv * 5.0 - vSeed * 17.0) * 0.4;
        float a = smoothstep(1.0, 0.25, r + (n - 0.5) * 0.45) * vNear;
        if (a < 0.01) discard;
        // lit from above, grey underneath, bright rim when looking toward the sun
        vec3 rd = normalize(vWorld - cameraPosition);
        float top = clamp(vShade * 0.7 + 0.3 + vUv.y * 0.25, 0.0, 1.0);
        vec3 col = mix(vec3(0.55, 0.6, 0.7), vec3(1.05, 1.03, 1.0), top);
        col += uSunGlow * pow(max(dot(rd, uSunDir), 0.0), 6.0) * (1.0 - a) * 0.8;
        col = applyFog(col * 1.25, cameraPosition, vWorld);
        gl_FragColor = vec4(col * a * 0.9, a * 0.9);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, premultipliedAlpha: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.visible = n > 0;

  const order = Array.from({ length: n }, (_, i) => i), dist = new Float32Array(n), wx = new Float32Array(n), wz = new Float32Array(n);
  const wrap = (v, c) => c + ((((v - c + FIELD / 2) % FIELD) + FIELD) % FIELD) - FIELD / 2;

  return {
    mesh,
    // returns how deep the camera is inside a cloud (0..1), for the white-out overlay
    update(camera) {
      if (!n) return 0;
      const p = camera.position;
      let inside = 0;
      for (let i = 0; i < n; i++) {
        const x = wrap(home[i * 5], p.x), z = wrap(home[i * 5 + 2], p.z), y = home[i * 5 + 1], r = home[i * 5 + 3];
        wx[i] = x; wz[i] = z;
        const d = Math.hypot(x - p.x, y - p.y, z - p.z);
        dist[i] = d;
        inside = Math.max(inside, THREE.MathUtils.clamp((1 - d / r) / 0.5, 0, 1));
      }
      order.sort((a, b) => dist[b] - dist[a]);
      for (let k = 0; k < n; k++) {
        const i = order[k];
        aPuff.array[k * 4] = wx[i]; aPuff.array[k * 4 + 1] = home[i * 5 + 1]; aPuff.array[k * 4 + 2] = wz[i]; aPuff.array[k * 4 + 3] = home[i * 5 + 3];
        aShade.array[k] = home[i * 5 + 4];
      }
      aPuff.needsUpdate = true; aShade.needsUpdate = true;
      return inside * 0.95;
    },
  };
}
