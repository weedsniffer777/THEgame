import * as THREE from 'three';
import { WORLD } from '../config.js';

// Shared haze: the sky and the terrain use the same fog so distant mountains melt into the horizon.
export const fogUniforms = {
  uSunDir: { value: new THREE.Vector3() },
  uFogColor: { value: new THREE.Color(0.42, 0.58, 0.82) },
  uSunGlow: { value: new THREE.Color(1.0, 0.84, 0.6) },
  uFogDensity: { value: WORLD.fogDensity },
  uFogFalloff: { value: WORLD.fogFalloff },
};

export const FOG_GLSL = /* glsl */`
uniform vec3 uSunDir; uniform vec3 uFogColor; uniform vec3 uSunGlow;
uniform float uFogDensity; uniform float uFogFalloff;
vec3 fogTint(vec3 rd) { return mix(uFogColor, uSunGlow, pow(max(dot(rd, uSunDir), 0.0), 8.0)); }
float fogAmount(vec3 ro, vec3 rd, float dist) {
  float b = uFogFalloff, a = uFogDensity * exp(-ro.y * b);
  float f = abs(rd.y) < 1e-4 ? a * dist : a * (1.0 - exp(-dist * rd.y * b)) / (rd.y * b);
  return 1.0 - exp(-f);
}
vec3 applyFog(vec3 col, vec3 ro, vec3 p) {
  vec3 d = p - ro; float dist = length(d); vec3 rd = d / dist;
  return mix(col, fogTint(rd), fogAmount(ro, rd, dist));
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
    uniforms: {
      ...fogUniforms,
      uZenith: { value: new THREE.Color(0.03, 0.14, 0.52) },
      uHorizon: { value: new THREE.Color(0.3, 0.5, 0.85) },
    },
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
        vec3 col = mix(uHorizon, uZenith, pow(up, 0.6));
        col = mix(col, fogTint(rd), fogAmount(cameraPosition, rd, 2.0e5));
        float s = dot(rd, uSunDir);
        col += uSunGlow * (pow(max(s, 0.0), 300.0) * 1.5 + pow(max(s, 0.0), 12.0) * 0.12);
        col += vec3(1.0, 0.95, 0.85) * smoothstep(0.99996, 0.99999, s) * 40.0;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}
