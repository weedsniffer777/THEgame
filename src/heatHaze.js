import * as THREE from 'three';

// Heat haze behind the player's nozzles. After the scene is drawn, the finished image is copied into a texture and
// a soft patch behind each nozzle redraws it with small flowing offsets, so whatever is seen through the exhaust
// shimmers. Strongest at the nozzle, fading downstream; scales with engine power (much stronger in afterburner).
// One full-screen copy per frame while the engine is producing heat.
const VS = `
uniform float uLen;
varying vec2 vUv; varying float vL;
void main() {
  // a quad along the exhaust axis that turns toward the camera; seen from straight behind it becomes a round patch
  vec4 c = modelViewMatrix * vec4(0.0, 0.0, -uLen * 0.5, 1.0);
  vec3 ax = normalize(mat3(modelViewMatrix) * vec3(0.0, 0.0, -1.0));
  float l = length(ax.xy);
  vec2 dx = l > 1e-3 ? ax.xy / l : vec2(1.0, 0.0), dy = vec2(-dx.y, dx.x);
  float w = 0.9, hl = mix(w, uLen * 0.5, l);
  c.xy += dx * position.y * 2.0 * hl + dy * position.x * w;
  vUv = vec2(position.x, position.y * 2.0); vL = l;
  gl_Position = projectionMatrix * c;
}`;
const FS = `
uniform sampler2D uScene; uniform vec2 uRes; uniform float uTime; uniform float uK;
varying vec2 vUv; varying float vL;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
void main() {
  float t = vUv.y * 0.5 + 0.5;                                     // 0 at the nozzle, 1 downstream
  float across = 1.0 - vUv.x * vUv.x;
  float mask = mix(1.0 - smoothstep(0.2, 1.0, length(vUv)), across * smoothstep(0.0, 0.08, t) * pow(1.0 - t, 1.4), vL);
  if (mask < 0.003) discard;
  vec2 q = vUv * vec2(4.0, 7.0) - vec2(0.0, uTime * 9.0);         // ripples flowing away from the nozzle
  vec2 off = vec2(noise(q) - 0.5, noise(q + 17.3) - 0.5) * 2.0 * 0.010 * uK * mask;
  vec2 uv = gl_FragCoord.xy / uRes + off;
  gl_FragColor = vec4(texture2D(uScene, uv).rgb, clamp(mask * 4.0, 0.0, 1.0));   // (already a finished image: no re-encoding)
}`;

export function createHeatHaze(renderer, model, nozzles) {
  const scene = new THREE.Scene();
  const size = new THREE.Vector2();
  const uniforms = { uScene: { value: null }, uRes: { value: new THREE.Vector2() }, uTime: { value: 0 }, uK: { value: 0 }, uLen: { value: 7 } };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, side: THREE.DoubleSide });   // (the quad is laid out in the shader with a mirrored basis: either winding)
  const geo = new THREE.PlaneGeometry(2, 1, 1, 1);
  const meshes = nozzles.map(p => {
    const m = new THREE.Mesh(geo, mat);
    m.matrixAutoUpdate = false; m.matrixWorldAutoUpdate = false; m.frustumCulled = false;
    m.userData.at = new THREE.Matrix4().makeTranslation(p.x, p.y, p.z);
    scene.add(m);
    return m;
  });
  let fb = null;
  return {
    // k: engine heat 0..1 (dry power ~0.4, full afterburner 1)
    render(camera, k, time) {
      if (k < 0.02 || !model.visible) return;
      renderer.getDrawingBufferSize(size);
      if (!fb || fb.image.width !== size.x || fb.image.height !== size.y) { fb?.dispose(); fb = new THREE.FramebufferTexture(size.x, size.y); }
      renderer.copyFramebufferToTexture(fb);
      uniforms.uScene.value = fb; uniforms.uRes.value.copy(size); uniforms.uTime.value = time; uniforms.uK.value = k;
      uniforms.uLen.value = 5 + 4 * k;
      for (const m of meshes) m.matrixWorld.multiplyMatrices(model.matrixWorld, m.userData.at);
      const auto = renderer.autoClear; renderer.autoClear = false;
      renderer.render(scene, camera);
      renderer.autoClear = auto;
    },
  };
}
