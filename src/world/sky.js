import * as THREE from 'three';
import { WORLD } from '../config.js';

// Shared haze: the sky and the terrain use the same fog so distant mountains melt into the horizon.
// Colours picked from the reference screenshots (converted from sRGB to linear).
const srgb = (r, g, b) => new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
export const SKY = {
  zenith: srgb(78, 150, 228),
  horizon: srgb(184, 216, 240),
  haze: srgb(168, 200, 232),       // light scattered into the view by the air (distant ridges go toward this)
  sun: srgb(255, 214, 160),
};

// Shared atmosphere: the sky and the terrain use the same haze so distant mountains melt into the horizon.
export const fogUniforms = {
  uSunDir: { value: new THREE.Vector3() },
  uFogColor: { value: SKY.haze },
  uSunGlow: { value: SKY.sun },
  uFogDensity: { value: WORLD.fogDensity },
  uFogFalloff: { value: WORLD.fogFalloff },
};

// Aerial perspective: air scatters blue far more than red (Rayleigh), so the haze thickens per colour channel.
// Near ridges darken toward blue, far ones fade into the pale horizon.
export const FOG_GLSL = /* glsl */`
uniform vec3 uSunDir; uniform vec3 uFogColor; uniform vec3 uSunGlow;
uniform float uFogDensity; uniform float uFogFalloff;
const vec3 RAYLEIGH = vec3(0.38, 0.62, 1.0);
vec3 fogTint(vec3 rd) { return mix(uFogColor, uSunGlow, pow(max(dot(rd, uSunDir), 0.0), 6.0) * 0.5); }
float fogDepth(vec3 ro, vec3 rd, float dist) {
  float b = uFogFalloff, a = uFogDensity * exp(-ro.y * b);
  return abs(rd.y) < 1e-4 ? a * dist : a * (1.0 - exp(-dist * rd.y * b)) / (rd.y * b);
}
vec3 applyFog(vec3 col, vec3 ro, vec3 p) {
  vec3 d = p - ro; float dist = length(d); vec3 rd = d / dist;
  vec3 t = exp(-fogDepth(ro, rd, dist) * RAYLEIGH);
  return col * t + fogTint(rd) * (1.0 - t);
}`;

export function setSun() {
  const az = WORLD.sunAzimuth * Math.PI / 180, el = WORLD.sunElevation * Math.PI / 180;
  fogUniforms.uSunDir.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  fogUniforms.uFogDensity.value = WORLD.fogDensity;
  fogUniforms.uFogFalloff.value = WORLD.fogFalloff;
  return fogUniforms.uSunDir.value;
}

export function createSky() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...fogUniforms, uZenith: { value: SKY.zenith }, uHorizon: { value: SKY.horizon } },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uZenith; uniform vec3 uHorizon;
      varying vec3 vDir;
      ${FOG_GLSL}
      void main() {
        vec3 rd = normalize(vDir);
        float up = max(rd.y, 0.0);
        vec3 col = mix(uHorizon, uZenith, pow(up, 0.5));
        col = mix(col, uFogColor, exp(-max(rd.y, 0.0) * 30.0) * 0.6);     // haze band right at the horizon
        if (rd.y < 0.0) col = uFogColor;
        // the sun: drawn about 3x its real 0.53 deg (a real-size disc reads as a dot on screen, games do the same),
        // with a bright glare that stands in for camera bloom and a soft forward-scattering glow around it
        float c = dot(rd, uSunDir);
        float ang = acos(clamp(c, -1.0, 1.0));
        float disc = 1.0 - smoothstep(1.3, 1.42, degrees(ang));
        // the whole sun side of the sky brightens and warms, as in photos
        col = mix(col, vec3(1.0, 0.92, 0.8), pow(max(c, 0.0), 4.0) * 0.3);
        // warm glare and glow around the disc, smooth so it reads as light, not a ring
        col += uSunGlow * (exp(-ang * 18.0) * 1.6 + exp(-ang * 5.0) * 0.35);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        // the disc itself: pure white, written after tone mapping so nothing can grey it
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), disc);
      }`,
    side: THREE.BackSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 64, 32), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}
