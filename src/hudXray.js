import * as THREE from 'three';

// X-ray damage view (bottom left): the actual aircraft as a glowing see-through wireframe, rendered top-down once at load.
// Pass 1 paints every part in its own flat id colour (which pixel belongs to which part); pass 2 renders the
// shape's shading. Each frame the silhouette is tinted per part by health: green, yellow, red, dark when gone.
const W = 160, H = 200;   // render size (drawn at half size on screen, so edges come out smooth)

function tint(f) {   // health 1 -> 0: green, yellow, red
  const g = [70, 255, 140], y = [250, 220, 70], r = [255, 70, 55];
  const [a, b, t] = f > 0.5 ? [y, g, (f - 0.5) * 2] : [r, y, f * 2];
  return a.map((v, i) => v + (b[i] - v) * t);
}

export function createXray(root, damage, maxHp, renderer, model) {
  const names = ['body', ...Object.keys(damage.parts)];

  // a copy of the airframe for the snapshots: flat id colours per part, missiles and effects left out
  const copy = model.clone(true);
  copy.position.set(0, 0, 0); copy.quaternion.identity(); copy.scale.copy(model.scale);
  const idMats = names.map((n, k) => new THREE.MeshBasicMaterial({ color: new THREE.Color((k + 1) * 12 / 255, 0, 0), toneMapped: false }));
  const shadeMat = new THREE.MeshNormalMaterial();
  const meshes = [];
  copy.traverse(o => {
    if (!o.isMesh) return;
    if (o.material.type === 'ShaderMaterial' || o.geometry.isInstancedBufferGeometry) { o.visible = false; return; }
    let part = 'body';
    for (let p = o; p; p = p.parent) if (p.userData.part) { part = p.userData.part; break; }
    let isMissile = false;
    for (let p = o; p && p !== copy; p = p.parent) if (p.userData.missile) isMissile = true;
    if (isMissile) { o.visible = false; return; }
    meshes.push([o, names.indexOf(part)]);
  });
  const scene = new THREE.Scene();
  scene.add(copy);
  copy.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const [o] of meshes) box.expandByObject(o);
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const half = Math.max(s.x / 2 * H / W, s.z / 2) * 1.06;
  const cam = new THREE.OrthographicCamera(-half * W / H, half * W / H, half, -half, 0.1, 100);
  cam.position.set(c.x, box.max.y + 10, c.z); cam.up.set(0, 0, 1); cam.lookAt(c.x, c.y, c.z);

  const rt = new THREE.WebGLRenderTarget(W, H);
  const ids = new Uint8Array(W * H * 4), shade = new Uint8Array(W * H * 4);
  const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(rt);
  for (const [o, k] of meshes) o.material = idMats[k];
  renderer.clear(); renderer.render(scene, cam); renderer.readRenderTargetPixels(rt, 0, 0, W, H, ids);
  for (const [o] of meshes) o.material = shadeMat;
  renderer.clear(); renderer.render(scene, cam); renderer.readRenderTargetPixels(rt, 0, 0, W, H, shade);
  renderer.setRenderTarget(prevTarget); renderer.setClearColor(prevClear, prevAlpha);
  rt.dispose();

  // per pixel: which part (or -1), and a wireframe-like line strength: outlines, part seams and shape creases
  const part = new Int8Array(W * H), nz = new Float32Array(W * H), line = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const src = (y * W + x) * 4, dst = (H - 1 - y) * W + x;   // render targets read bottom-up
    part[dst] = ids[src + 3] > 0 ? Math.round(ids[src] / 12) - 1 : -1;
    nz[dst] = shade[src + 2] / 255; nz[dst] += shade[src] / 2550;
  }
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (part[i] < 0) continue;
    let edge = 0, crease = 0;
    for (const j of [i - 1, i + 1, i - W, i + W]) {
      if (part[j] !== part[i]) edge = 1;                       // outline or seam between parts
      crease = Math.max(crease, Math.abs(nz[j] - nz[i]));      // a fold in the surface
    }
    line[i] = Math.max(edge, Math.min(1, crease * 9));
  }

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.style.width = `${W / 2 * 1.3}px`; canvas.style.height = `${H / 2 * 1.3}px`;   // (drawn 1.3x: a bit bigger on screen)
  root.innerHTML = ''; root.append(canvas);
  const ctx = canvas.getContext('2d'), img = ctx.createImageData(W, H);
  let lastKey = '';
  return () => {
    const cols = names.map(n => {
      if (n === 'body') return [...tint(Math.max(0, damage.bodyHp) / maxHp.body), 1];
      const p = damage.parts[n];
      return p.broken ? [120, 40, 36, 0.35] : [...tint(p.hp / (maxHp[n] || 1)), 1];   // lost: a faint red ghost
    });
    const key = cols.map(c => c.join()).join('|');
    if (key === lastKey) return;   // only repaint when something changed
    lastKey = key;
    const d = img.data;
    for (let i = 0; i < W * H; i++) {
      const k = part[i];
      if (k < 0) { d[i * 4 + 3] = 0; continue; }
      const col = cols[k], L = line[i];
      const bright = 0.55 + 0.45 * L;                         // lines glow brighter than the see-through fill
      d[i * 4] = Math.min(255, col[0] * bright + 60 * L); d[i * 4 + 1] = Math.min(255, col[1] * bright + 60 * L); d[i * 4 + 2] = Math.min(255, col[2] * bright + 60 * L);
      d[i * 4 + 3] = (28 + 227 * L) * col[3];
    }
    ctx.putImageData(img, 0, 0);
  };
}
