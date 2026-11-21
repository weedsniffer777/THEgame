import * as THREE from 'three';
import { FOG_GLSL, fogUniforms } from './sky.js';
import { WORLD } from '../config.js';

// Real terrain from a heightmap, drawn as a quadtree of instanced grid patches (CDLOD):
// full detail near the camera, coarser with distance, vertices morph between levels so there are no cracks or pops.
// Outside the mapped square the terrain mirrors itself, so the mountains never end.
const PATCH = 16;           // cells per patch side
const LODS = 9;
const MAX = 4096;

function mirror(i, n) { const p = 2 * n; let m = i % p; if (m < 0) m += p; return m < n ? m : p - 1 - m; }

function patchGeometry(cells, max) {
  const g = new THREE.InstancedBufferGeometry();
  const pos = [], idx = [];
  for (let j = 0; j <= cells; j++) for (let i = 0; i <= cells; i++) pos.push(i, 0, j);
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    const a = j * (cells + 1) + i, b = a + 1, c = a + cells + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const inst = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
  inst.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aNode', inst);
  g.instanceCount = 0;
  return g;
}

export async function loadTerrain(base) {
  const [meta, heights, color] = await Promise.all([
    fetch(base + 'terrain.json').then(r => r.json()),
    loadHeights(base + 'height.png'),
    new THREE.TextureLoader().loadAsync(base + 'color.jpg'),
  ]);
  return new Terrain(meta, heights, color);
}

// 16-bit heights packed losslessly into a PNG: red = high byte, green = low byte.
async function loadHeights(url) {
  const blob = await (await fetch(url)).blob();
  const img = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(img.width, img.height).getContext('2d', { willReadFrequently: true });
  c.drawImage(img, 0, 0);
  const px = c.getImageData(0, 0, img.width, img.height).data;
  const out = new Uint16Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) out[i] = (px[i * 4] << 8) | px[i * 4 + 1];
  return out;
}

export class Terrain {
  constructor(meta, heights, color) {
    this.w = meta.size[0]; this.h = meta.size[1]; this.s = meta.spacing;
    this.hMin = meta.heightMin; this.hMax = meta.heightMax;
    this.hScale = (meta.heightMax - meta.heightMin) / 65535;
    this.heights = heights;
    this.ox = -this.w * this.s / 2; this.oz = -this.h * this.s / 2;

    const hTex = new THREE.DataTexture(heights, this.w, this.h, THREE.RedIntegerFormat, THREE.UnsignedShortType);
    hTex.internalFormat = 'R16UI';
    hTex.needsUpdate = true;

    // normals from the heights, computed here instead of downloaded
    const n = new Uint8Array(this.w * this.h * 4);
    for (let j = 0; j < this.h; j++) for (let i = 0; i < this.w; i++) {
      const dx = (this.raw(i + 1, j) - this.raw(i - 1, j)) * this.hScale / (2 * this.s);
      const dz = (this.raw(i, j + 1) - this.raw(i, j - 1)) * this.hScale / (2 * this.s);
      const l = Math.hypot(dx, 1, dz), k = (j * this.w + i) * 4;
      n[k] = (-dx / l * 0.5 + 0.5) * 255; n[k + 1] = (1 / l * 0.5 + 0.5) * 255; n[k + 2] = (-dz / l * 0.5 + 0.5) * 255; n[k + 3] = 255;
    }
    const nTex = new THREE.DataTexture(n, this.w, this.h, THREE.RGBAFormat);
    nTex.wrapS = nTex.wrapT = THREE.MirroredRepeatWrapping;
    nTex.magFilter = THREE.LinearFilter; nTex.minFilter = THREE.LinearMipmapLinearFilter; nTex.generateMipmaps = true;
    nTex.needsUpdate = true;

    color.flipY = false; color.colorSpace = THREE.SRGBColorSpace;
    color.wrapS = color.wrapT = THREE.MirroredRepeatWrapping;
    color.anisotropy = 8;
    color.needsUpdate = true;

    this.morph = Array.from({ length: 12 }, () => new THREE.Vector2());
    this.uniforms = {
      ...fogUniforms,
      uHeight: { value: hTex }, uNormal: { value: nTex }, uColor: { value: color },
      uSize: { value: new THREE.Vector2(this.w, this.h) },
      uSpacing: { value: this.s }, uOrigin: { value: new THREE.Vector2(this.ox, this.oz) },
      uHMin: { value: this.hMin }, uHScale: { value: this.hScale },
      uMorph: { value: this.morph },
      uBright: { value: WORLD.terrainBrightness }, uRelief: { value: WORLD.terrainRelief },
    };
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        uniform highp usampler2D uHeight;
        uniform ivec2 uSize; uniform float uSpacing; uniform vec2 uOrigin; uniform float uHMin; uniform float uHScale;
        uniform vec2 uMorph[12];
        in vec4 aNode;
        out vec3 vWorld;
        int mirrorI(int i, int n) { int p = 2 * n; int m = i % p; if (m < 0) m += p; return m < n ? m : p - 1 - m; }
        float fetchH(int x, int y) { return float(texelFetch(uHeight, ivec2(mirrorI(x, uSize.x), mirrorI(y, uSize.y)), 0).r); }
        float heightAt(vec2 p) {
          vec2 g = (p - uOrigin) / uSpacing; vec2 f = floor(g); vec2 t = g - f; ivec2 i = ivec2(f);
          float a = fetchH(i.x, i.y), b = fetchH(i.x + 1, i.y), c = fetchH(i.x, i.y + 1), d = fetchH(i.x + 1, i.y + 1);
          return uHMin + uHScale * mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
        }
        void main() {
          vec2 grid = position.xz;
          vec2 wp = aNode.xy + grid * aNode.z;
          vec2 m = uMorph[int(aNode.w + 0.5)];
          float dist = distance(vec3(wp.x, heightAt(wp), wp.y), cameraPosition);
          float k = clamp((dist - m.x) / (m.y - m.x), 0.0, 1.0);
          grid -= fract(grid * 0.5) * 2.0 * k;
          wp = aNode.xy + grid * aNode.z;
          vWorld = vec3(wp.x, heightAt(wp), wp.y);
          gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uNormal; uniform sampler2D uColor;
        uniform ivec2 uSize; uniform float uSpacing; uniform vec2 uOrigin;
        uniform float uBright; uniform float uRelief;
        in vec3 vWorld;
        layout(location = 0) out highp vec4 outColor;
        #define gl_FragColor outColor
        ${FOG_GLSL}
        void main() {
          vec2 g = (vWorld.xz - uOrigin) / uSpacing;
          vec2 size = vec2(uSize);
          vec3 albedo = texture(uColor, g / size).rgb;
          vec3 n = normalize(texture(uNormal, (g + 0.5) / size).xyz * 2.0 - 1.0);
          float shade = (0.45 + max(dot(n, uSunDir), 0.0)) / (0.45 + max(uSunDir.y, 0.1));
          vec3 col = albedo * uBright * mix(1.0, shade, uRelief);
          col = applyFog(col, cameraPosition, vWorld);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.full = new THREE.Mesh(patchGeometry(PATCH, MAX), mat);
    this.half = new THREE.Mesh(patchGeometry(PATCH / 2, MAX), mat);
    for (const m of [this.full, this.half]) m.frustumCulled = false;
    this.group = new THREE.Group().add(this.full, this.half);
    this.frustum = new THREE.Frustum(); this.box = new THREE.Box3(); this.mat4 = new THREE.Matrix4();
    this.setDetail(WORLD.terrainDetail);
  }

  setDetail(range0) {
    this.ranges = Array.from({ length: LODS }, (_, i) => range0 * 2 ** i);
    for (let i = 0; i < LODS; i++) {
      const prev = i ? this.ranges[i - 1] : 0, r = this.ranges[i];
      this.morph[i].set(prev + (r - prev) * 0.6, r * 0.95);
    }
  }

  raw(i, j) { return this.heights[mirror(j, this.h) * this.w + mirror(i, this.w)]; }

  heightAt(x, z) {
    const gx = (x - this.ox) / this.s, gz = (z - this.oz) / this.s;
    const i = Math.floor(gx), j = Math.floor(gz), tx = gx - i, tz = gz - j;
    const a = this.raw(i, j), b = this.raw(i + 1, j), c = this.raw(i, j + 1), d = this.raw(i + 1, j + 1);
    return this.hMin + this.hScale * ((a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz);
  }

  update(camera) {
    this.frustum.setFromProjectionMatrix(this.mat4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    this.cam = camera.position;
    this.nFull = this.nHalf = 0;
    const leaf = PATCH * this.s, rootSize = leaf * 2 ** (LODS - 1), R = this.ranges[LODS - 1];
    const x0 = Math.floor((this.cam.x - R) / rootSize), x1 = Math.floor((this.cam.x + R) / rootSize);
    const z0 = Math.floor((this.cam.z - R) / rootSize), z1 = Math.floor((this.cam.z + R) / rootSize);
    for (let zi = z0; zi <= z1; zi++) for (let xi = x0; xi <= x1; xi++) this.select(xi * rootSize, zi * rootSize, rootSize, LODS - 1);
    for (const [mesh, n] of [[this.full, this.nFull], [this.half, this.nHalf]]) {
      mesh.geometry.instanceCount = n;
      mesh.geometry.attributes.aNode.needsUpdate = true;
    }
  }

  near(x, z, size, r) {
    const c = this.cam;
    const dx = Math.max(x - c.x, 0, c.x - x - size), dz = Math.max(z - c.z, 0, c.z - z - size);
    const dy = Math.max(this.hMin - c.y, 0, c.y - this.hMax);
    return dx * dx + dy * dy + dz * dz <= r * r;
  }

  add(mesh, x, z, cell, lod) {
    const n = mesh === this.full ? this.nFull++ : this.nHalf++;
    if (n >= MAX) return;
    mesh.geometry.attributes.aNode.array.set([x, z, cell, lod], n * 4);
  }

  select(x, z, size, lod) {
    if (!this.near(x, z, size, this.ranges[lod])) return false;
    this.box.min.set(x, this.hMin, z); this.box.max.set(x + size, this.hMax, z + size);
    if (!this.frustum.intersectsBox(this.box)) return true;
    const cell = size / PATCH;
    if (lod === 0 || !this.near(x, z, size, this.ranges[lod - 1])) { this.add(this.full, x, z, cell, lod); return true; }
    const h = size / 2;
    for (const [cx, cz] of [[x, z], [x + h, z], [x, z + h], [x + h, z + h]]) {
      if (!this.select(cx, cz, h, lod - 1)) this.add(this.half, cx, cz, cell, lod);
    }
    return true;
  }
}
