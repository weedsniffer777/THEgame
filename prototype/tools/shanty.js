// Authoring source for the shanty. Not loaded by the game: tools/bake.mjs runs this in a
// headless browser, merges everything by material and writes models/shanty.glb.
import * as THREE from "three";
function seeded(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
/* ---------- Procedural surface textures (rusted metal, painted metal, weathered wood, concrete) ---------- */
function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
function vnoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y, seed, oct = 4) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f, seed + i * 17); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const RIB = 0.076; // corrugation period in metres, shared by texture and geometry

// fn(xMetres, yMetres) -> [r, g, b, roughness 0..1, height 0..1]
// Produces colour, roughness (glTF layout: G = roughness, B = metalness mask) and a tangent-space
// normal map derived from the height field, so detail like corrugation costs no geometry.
function genSurface(px, metres, fn, normalStrength = 6) {
  const mk = () => { const c = document.createElement("canvas"); c.width = c.height = px; return c; };
  const cMap = mk(), cRough = mk(), cNorm = mk();
  const dMap = cMap.getContext("2d").createImageData(px, px), dRough = cRough.getContext("2d").createImageData(px, px), dNorm = cNorm.getContext("2d").createImageData(px, px);
  const k = metres / px, H = new Float32Array(px * px);
  for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) {
    const [r, g, b, ro, h] = fn(i * k, j * k), o = (j * px + i) * 4;
    dMap.data[o] = r; dMap.data[o + 1] = g; dMap.data[o + 2] = b; dMap.data[o + 3] = 255;
    dRough.data[o] = 0; dRough.data[o + 1] = ro * 255; dRough.data[o + 2] = 255; dRough.data[o + 3] = 255;
    H[j * px + i] = h;
  }
  for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) {
    const at = (x, y) => H[((y + px) % px) * px + ((x + px) % px)];
    const dx = (at(i + 1, j) - at(i - 1, j)) * normalStrength, dy = (at(i, j + 1) - at(i, j - 1)) * normalStrength;
    const len = Math.hypot(dx, dy, 1), o = (j * px + i) * 4;
    dNorm.data[o] = (-dx / len * 0.5 + 0.5) * 255; dNorm.data[o + 1] = (dy / len * 0.5 + 0.5) * 255; dNorm.data[o + 2] = (1 / len * 0.5 + 0.5) * 255; dNorm.data[o + 3] = 255;
  }
  cMap.getContext("2d").putImageData(dMap, 0, 0); cRough.getContext("2d").putImageData(dRough, 0, 0); cNorm.getContext("2d").putImageData(dNorm, 0, 0);
  const tex = (c, srgb) => { const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.userData.mimeType = "image/jpeg"; return t; };
  return { map: tex(cMap, true), roughnessMap: tex(cRough), normalMap: tex(cNorm), metres };
}
function rustAt(x, y, seed, amount) {
  // Rust mask: blotches plus drips running down from fastener rows every 0.9 m.
  const band = 0.9, fy = (y % band) / band;
  const drip = Math.pow(vnoise(x * 22, Math.floor(y / band) * 7.3, seed + 4), 5) * (1 - fy) * 1.6;
  const m = fbm(x * 2.1 + 5, y * 2.1, seed + 3, 5) + drip * 0.3 + (vnoise(x * 0.45, y * 0.45, seed + 9) - 0.5) * 0.35 + amount;
  return smooth(0.5, 0.66, m);
}
// Wide, soft stain around rust: the metal yellows and browns before it actually rusts.
function stainAt(x, y, seed, amount) {
  const band = 0.9, fy = (y % band) / band;
  const drip = Math.pow(vnoise(x * 22, Math.floor(y / band) * 7.3, seed + 4), 5) * (1 - fy) * 1.6;
  const m = fbm(x * 2.1 + 5, y * 2.1, seed + 3, 5) + drip * 0.3 + (vnoise(x * 0.45, y * 0.45, seed + 9) - 0.5) * 0.35 + amount;
  return smooth(0.3, 0.58, m);
}
function rustColor(x, y, seed) {
  const c = fbm(x * 5, y * 5, seed + 5, 3), dark = vnoise(x * 90, y * 90, seed + 6) > 0.8 ? 0.55 : 1;
  return [(92 + c * 104) * dark, (52 + c * 56) * dark, (34 + c * 26) * dark];
}
// Graded discolouration: clean -> dull yellow-grey -> tan -> rust.
function weather(r, g, b, x, y, seed, amount) {
  const st = stainAt(x, y, seed, amount), t = rustAt(x, y, seed, amount);
  const v = (r + g + b) / 3, mottle = fbm(x * 9, y * 9, seed + 12, 3);
  // stage 1: desaturate and warm the base
  r = mix(r, v * 1.04 + 6, st * 0.8); g = mix(g, v * 0.97, st * 0.8); b = mix(b, v * 0.86 - 6, st * 0.8);
  // stage 2: tan staining that deepens toward the rust edge
  const tan = st * st * (0.55 + mottle * 0.3);
  r = mix(r, 150, tan * 0.55); g = mix(g, 112, tan * 0.55); b = mix(b, 78, tan * 0.55);
  // stage 3: rust core, lighter orange at its edge, darker inside
  const [rr, rg, rb] = rustColor(x, y, seed), edge = 1 - smooth(0.35, 1, t);
  const er = mix(rr, 168, edge * 0.45), eg = mix(rg, 104, edge * 0.45), eb = mix(rb, 58, edge * 0.45);
  return [mix(r, er, t), mix(g, eg, t), mix(b, eb, t), st, t];
}
let SURF = null;
function surfaces() {
  if (SURF) return SURF;
  const galv = genSurface(1024, 5, (x, y) => {
    const mott = fbm(x * 1.1, y * 1.1, 1, 4), fine = vnoise(x * 70, y * 70, 2);
    const rib = 0.5 + 0.5 * Math.cos((x / RIB) * Math.PI * 2);
    const v = 122 + mott * 52 + fine * 9 - (1 - rib) * 12;
    // weathered zinc: dull warm grey with brown dirt clouds and vertical water stains
    const dirt = smooth(0.35, 0.75, fbm(x * 0.7 + 3, y * 0.7, 31, 4));
    const streak = Math.pow(vnoise(x * 9, y * 0.6, 32), 3) * 0.6;
    const d = Math.min(1, dirt * 0.65 + streak);
    const r0 = mix(v * 1.02, 140 + mott * 24, d), g0 = mix(v * 0.97, 122 + mott * 20, d), b0 = mix(v * 0.88, 100 + mott * 16, d);
    const [r, g, b, st, t] = weather(r0, g0, b0, x, y, 30, 0.04);
    return [r, g, b, mix(0.5, 0.97, Math.max(t, st * 0.6)), rib * 0.55 + t * 0.12 + fine * 0.06];
  });
  const PAINTS = [[86, 122, 117], [138, 66, 52], [176, 166, 136], [104, 110, 76], [78, 96, 120], [150, 120, 70]];
  const paint = genSurface(1024, 5, (x, y) => {
    const col = PAINTS[Math.floor(hash2(Math.floor(x / 1.25), Math.floor(y / 2.5), 77) * PAINTS.length)];
    const fade = fbm(x * 1.5, y * 1.5, 41, 3), fine = vnoise(x * 70, y * 70, 42);
    const rib = 0.5 + 0.5 * Math.cos((x / RIB) * Math.PI * 2);
    const chip = fbm(x * 3.2, y * 3.2, 43, 5) + Math.pow(vnoise(x * 20, Math.floor(y / 0.9) * 3, 44), 6) * (1 - (y % 0.9) / 0.9);
    const bare = smooth(0.56, 0.6, chip);                  // paint gone
    const k = (0.78 + fade * 0.32) - (1 - rib) * 0.07;
    let [r, g, b, st, t0] = weather(col[0] * k + 25 * fade, col[1] * k + 25 * fade, col[2] * k + 25 * fade, x, y, 45, -0.1);
    const chipT = bare * smooth(0.5, 0.62, chip + 0.05), t = Math.max(chipT, t0 * 0.8);
    const [rr, rg, rb] = rustColor(x, y, 46);
    r = mix(r, rr, chipT); g = mix(g, rg, chipT); b = mix(b, rb, chipT);
    return [r, g, b, mix(0.75, 0.97, t), rib * 0.55 + bare * 0.05 + fine * 0.05];
  });
  const wood = genSurface(1024, 4, (x, y) => {
    // Grain runs along x. Grey sun-bleached boards with dark stains and the odd knot.
    const warp = fbm(x * 0.6, y * 9, 61, 4);
    const grain = 0.5 + 0.5 * Math.sin(y * 210 + warp * 16);
    const ring = Math.pow(grain, 3);
    const stain = smooth(0.55, 0.8, fbm(x * 1.4, y * 3, 62, 4));
    const kx = x * 2.2, ky = y * 6, knot = Math.max(0, 1 - Math.hypot(kx - Math.round(kx), (ky - Math.round(ky)) * 0.4) * 6) * (hash2(Math.round(kx), Math.round(ky), 63) > 0.86 ? 1 : 0);
    const base = 0.62 + warp * 0.3 - ring * 0.14 - stain * 0.22 - knot * 0.35;
    return [128 * base + 34, 114 * base + 28, 100 * base + 22, 0.9, ring * 0.12 - knot * 0.1];
  });
  const concrete = genSurface(512, 2, (x, y) => {
    const n = fbm(x * 3, y * 3, 81, 5), pit = vnoise(x * 60, y * 60, 82) > 0.78 ? 0.7 : 1;
    const v = (120 + n * 70) * pit;
    return [v, v * 0.98, v * 0.95, 0.95, n * 0.2 + (pit < 1 ? 0 : 0.08)];
  });
  const m = (s, o = {}) => new THREE.MeshStandardMaterial({ map: s.map, roughnessMap: s.roughnessMap, normalMap: s.normalMap, roughness: 1, metalness: 0.0, vertexColors: true, side: THREE.DoubleSide, ...o });
  SURF = {
    galv, paint, wood, concrete,
    galvMat: m(galv, { metalness: 0.45 }), paintMat: m(paint, { metalness: 0.2 }), woodMat: m(wood),
    concreteMat: m(concrete, { side: THREE.FrontSide }),
    rockMat: m(concrete, { side: THREE.FrontSide, color: 0x9a958d }),
    darkMat: new THREE.MeshStandardMaterial({ color: 0x0d0d0e, roughness: 1 }),
    rubberMat: new THREE.MeshStandardMaterial({ color: 0x1b1b1c, roughness: 0.92 }),
    wireMat: new THREE.MeshStandardMaterial({ color: 0x5d544c, roughness: 0.55, metalness: 0.6 }),
  };
  return SURF;
}

/* ---------- Geometry helpers ---------- */
// Write a per-vertex grime colour: darker near the bottom of a piece (in its own local y).
function grime(geo, h, bottom = 0.35, topDark = 0.08) {
  const pos = geo.attributes.position, col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) + h / 2) / h;
    const k = 1 - 0.28 * (1 - smooth(0, bottom, t)) - topDark * smooth(0.92, 1, t);
    col[i * 3] = k; col[i * 3 + 1] = k * 0.98; col[i * 3 + 2] = k * 0.95;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
}
// Corrugated sheet in the XY plane, ribs vertical, mapped onto a random patch of the surface atlas.
function sheetGeo(w, h, rnd, surf, { amp = 0.017, dent = 0.03, grimeBottom = 0.35 } = {}) {
  const geo = new THREE.PlaneGeometry(w, h, Math.max(2, Math.ceil(w / 0.35)), Math.max(3, Math.ceil(h / 0.5)));
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  const ribsMax = Math.floor((surf.metres - w) / RIB);
  const u0 = Math.floor(rnd() * ribsMax) * RIB, v0 = rnd() * (surf.metres - h);
  const seed = Math.floor(rnd() * 1e6);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), lx = x + w / 2, ly = y + h / 2;
    let z = 0;
    z += (fbm(lx * 1.3, ly * 1.3, seed, 3) - 0.5) * dent * 2;                     // dents and waviness
    z += Math.pow(Math.max(0, 1 - ly / 0.35), 2) * (vnoise(lx * 2, 0, seed + 1) - 0.4) * 0.06; // bottom edge kicked out
    pos.setZ(i, z);
    uv.setXY(i, (u0 + lx) / surf.metres, (v0 + ly) / surf.metres);
  }
  grime(geo, h, grimeBottom);
  geo.computeVertexNormals();
  return geo;
}
// Box whose UVs are in metres so the atlas never stretches; grain runs along the longest side of each face.
function surfBox(w, h, d, surf, rnd) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv, dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [fu, fv] = dims[f], swap = fv > fu, ou = rnd() * (surf.metres - Math.max(fu, fv)), ov = rnd() * (surf.metres - Math.min(fu, fv));
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k, u = uv.getX(i), v = uv.getY(i);
      const a = swap ? v * fv : u * fu, b = swap ? u * fu : v * fv;
      uv.setXY(i, (ou + a) / surf.metres, (ov + b) / surf.metres);
    }
  }
  grime(geo, h, 0.25, 0);
  return geo;
}
function shadowed(o) { o.traverse(m => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } }); return o; }

/* ---------- The shanty ---------- */
function buildShack() {
  const S = surfaces(), rnd = seeded(1337);
  const g = new THREE.Group(); g.name = "shanty";
  const L = 5.6, W = 3.8, HF = 2.85, HB = 2.25, FLOOR = 0.24;   // length x, depth z, front/back wall height
  const wallTop = (z) => FLOOR + mix(HB, HF, (z + W / 2) / W);
  const plank = (w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(surfBox(w, h, d, S.wood, rnd), S.woodMat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); g.add(m); return m; };
  const sheet = (w, h, x, y, z, ry, opts = {}) => {
    const painted = opts.painted ?? rnd() < 0.3;
    const surf = painted ? S.paint : S.galv;
    const m = new THREE.Mesh(sheetGeo(w, h, rnd, surf, opts), painted ? S.paintMat : S.galvMat);
    m.position.set(x, y, z); m.rotation.set(0, ry, (rnd() - 0.5) * 0.035);
    (opts.parent || g).add(m); return m;
  };

  // Cinder block footings and a plank floor deck that pokes out under the walls
  for (const x of [-L / 2 + 0.25, -0.1, L / 2 - 0.25]) for (const z of [-W / 2 + 0.25, W / 2 - 0.25]) {
    const b = new THREE.Mesh(surfBox(0.4, 0.2, 0.2, S.concrete, rnd), S.concreteMat); b.position.set(x, 0.1, z); b.rotation.y = (rnd() - 0.5) * 0.3; g.add(b);
  }
  for (let i = 0; i < 13; i++) plank(L + 0.15 + (rnd() - 0.5) * 0.2, 0.04, 0.27, (rnd() - 0.5) * 0.08, FLOOR - 0.02, -W / 2 + 0.15 + i * 0.29);

  // Timber frame: corner and mid posts, top plates following the roof slope
  const post = (x, z) => plank(0.1, wallTop(z) - FLOOR, 0.1, x, (wallTop(z) + FLOOR) / 2, z, 0, 0, (rnd() - 0.5) * 0.02);
  for (const x of [-L / 2, -0.4, L / 2]) for (const z of [-W / 2, W / 2]) post(x, z);
  plank(L + 0.3, 0.1, 0.1, 0, wallTop(W / 2) - 0.05, W / 2);
  plank(L + 0.3, 0.1, 0.1, 0, wallTop(-W / 2) - 0.05, -W / 2);

  // Walls: patchwork of corrugated sheets, cut around openings
  // wall: origin, run direction (unit x/z), length, outward normal yaw, openings [{a,b,y0,y1}] along the run
  const wall = (ox, oz, dx, dz, len, ry, openings, outward) => {
    let s = 0, flip = 0;
    while (s < len - 0.05) {
      let w = 0.78 + rnd() * 0.3;
      const op = openings.find(o => s >= o.a - 0.01 && s < o.b);
      const next = openings.find(o => o.a > s + 0.01 && o.a < s + w);
      if (next) w = next.a - s + 0.04;
      if (op) w = Math.min(w, op.b - s + 0.04);
      w = Math.min(w, len - s + 0.06);
      const cx = ox + dx * (s + w / 2), cz = oz + dz * (s + w / 2);
      const top = Math.min(wallTop(cz), wallTop(oz + dz * s), wallTop(oz + dz * (s + w))) - (rnd() * 0.06);
      const out = outward + (flip ^= 1) * 0.022;
      const px = cx + Math.sin(ry) * out, pz = cz + Math.cos(ry) * out;
      const bot = FLOOR - 0.12 - rnd() * 0.06;
      if (op) {
        if (op.y0 - bot > 0.15) sheet(w, op.y0 - bot, px, (bot + op.y0) / 2, pz, ry);
        if (top - op.y1 > 0.12) sheet(w, top - op.y1, px, (op.y1 + top) / 2, pz, ry, { grimeBottom: 0.05 });
      } else sheet(w, top - bot, px, (bot + top) / 2, pz, ry);
      s = op ? Math.max(op.b, s + 0.1) : s + Math.max(0.15, w - 0.05);
    }
  };
  const DOOR = { a: 0.95, b: 1.85, y0: FLOOR, y1: FLOOR + 2.0 }, WIN_F = { a: 3.35, b: 4.45, y0: FLOOR + 1.0, y1: FLOOR + 1.85 };
  wall(-L / 2, W / 2, 1, 0, L, 0, [DOOR, WIN_F], 0.07);
  wall(L / 2, -W / 2, -1, 0, L, Math.PI, [{ a: 2.0, b: 2.8, y0: FLOOR + 1.1, y1: FLOOR + 1.7 }], 0.07);
  wall(L / 2, W / 2, 0, -1, W, Math.PI / 2, [{ a: 1.2, b: 2.25, y0: FLOOR + 0.95, y1: FLOOR + 1.85 }], 0.07);
  wall(-L / 2, -W / 2, 0, 1, W, -Math.PI / 2, [], 0.07);

  // Dark interior behind openings
  const hole = (w, h, x, y, z, ry) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), S.darkMat); m.position.set(x, y, z); m.rotation.y = ry; g.add(m); };
  const doorX = -L / 2 + (DOOR.a + DOOR.b) / 2, winX = -L / 2 + (WIN_F.a + WIN_F.b) / 2;
  hole(0.9, 2.0, doorX, FLOOR + 1.0, W / 2 + 0.02, 0);
  hole(1.1, 0.85, winX, FLOOR + 1.43, W / 2 + 0.02, 0);
  hole(1.05, 0.9, L / 2 + 0.02, FLOOR + 1.4, W / 2 - 1.72, Math.PI / 2);

  // Door: plank door with a rusted sheet patch, strap hinges, hasp and padlock
  const door = new THREE.Group(); door.position.set(doorX - 0.42, 0, W / 2 + 0.12); door.rotation.y = -0.18; g.add(door);
  for (let i = 0; i < 5; i++) { const p = new THREE.Mesh(surfBox(0.17, 1.95 - (i % 2) * 0.04, 0.035, S.wood, rnd), S.woodMat); p.position.set(0.09 + i * 0.17, FLOOR + 1.0, 0); door.add(p); }
  for (const y of [0.4, 1.5]) { const p = new THREE.Mesh(surfBox(0.85, 0.12, 0.035, S.wood, rnd), S.woodMat); p.position.set(0.43, FLOOR + y, 0.035); door.add(p); }
  const patch = new THREE.Mesh(sheetGeo(0.7, 0.75, rnd, S.galv, { amp: 0.008, dent: 0.01 }), S.galvMat); patch.position.set(0.45, FLOOR + 0.55, 0.06); patch.rotation.z = 0.06; door.add(patch);
  const iron = new THREE.MeshStandardMaterial({ color: 0x2f2a26, roughness: 0.7, metalness: 0.5 });
  for (const y of [0.35, 1.65]) { const h = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 0.015), iron); h.position.set(0.18, FLOOR + y, 0.06); door.add(h); }
  const lock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.03), new THREE.MeshStandardMaterial({ color: 0x8a7a52, metalness: 0.7, roughness: 0.4 })); lock.position.set(0.8, FLOOR + 1.0, 0.07); door.add(lock);
  plank(0.08, 2.1, 0.08, doorX - 0.5, FLOOR + 1.05, W / 2 + 0.1); plank(0.08, 2.1, 0.08, doorX + 0.5, FLOOR + 1.05, W / 2 + 0.1);
  plank(1.15, 0.09, 0.08, doorX, FLOOR + 2.08, W / 2 + 0.1, 0, 0, 0.03);

  // Front window: rough frame and a rusted bar grate
  plank(1.3, 0.08, 0.1, winX, FLOOR + 0.98, W / 2 + 0.1, 0, 0, -0.02); plank(1.3, 0.08, 0.1, winX, FLOOR + 1.88, W / 2 + 0.1);
  plank(0.08, 1.0, 0.1, winX - 0.6, FLOOR + 1.43, W / 2 + 0.1); plank(0.08, 1.0, 0.1, winX + 0.6, FLOOR + 1.43, W / 2 + 0.1);
  [[0.28, 0.05, 1.35], [-0.02, -0.04, 1.3], [-0.3, 0.07, 1.38], [0.0, 0.62, 1.45]].forEach(([dy, rz, w], i) =>
    plank(w, 0.17, 0.035, winX + (rnd() - 0.5) * 0.08, FLOOR + 1.43 + dy, W / 2 + 0.16 + i * 0.012, 0, 0, rz));
  // Side window: boarded up with crooked planks
  const sx = L / 2 + 0.13, sz = W / 2 - 1.72;
  [[0.32, 0.06], [0.08, -0.05], [-0.18, 0.04], [-0.38, -0.03], [0.0, 0.55]].forEach(([dy, rot], i) => plank(0.035, 0.17, 1.3, sx + i * 0.012, FLOOR + 1.4 + dy, sz, rot, 0, 0));

  // Shed roof: purlins, then overlapping sheets running down the slope with a ragged eave
  const slope = Math.atan2(HF - HB, W);
  const roof = new THREE.Group(); roof.position.set(0, FLOOR + (HF + HB) / 2 + 0.08, 0); roof.rotation.x = -slope; g.add(roof);
  const roofLen = W / Math.cos(slope);
  for (const z of [-roofLen / 2 + 0.1, -0.2, roofLen / 2 - 0.15]) { const p = new THREE.Mesh(surfBox(L + 0.7 + rnd() * 0.3, 0.1, 0.09, S.wood, rnd), S.woodMat); p.position.set((rnd() - 0.5) * 0.2, -0.05, z); roof.add(p); }
  let x = -L / 2 - 0.35, flip = 0;
  while (x < L / 2 + 0.3) {
    const w = 0.8 + rnd() * 0.25, len = roofLen + 0.55 + rnd() * 0.45, shift = (rnd() - 0.4) * 0.3;
    const painted = rnd() < 0.25;
    const s = new THREE.Mesh(sheetGeo(w, len, rnd, painted ? S.paint : S.galv, { dent: 0.035, grimeBottom: 0.15 }), painted ? S.paintMat : S.galvMat);
    s.rotation.set(-Math.PI / 2, 0, (rnd() - 0.5) * 0.05);
    s.position.set(x + w / 2, 0.02 + (flip ^= 1) * 0.025 + (rnd() < 0.15 ? 0.05 : 0), shift + 0.08);
    if (rnd() < 0.2) s.rotation.x += (rnd() - 0.5) * 0.06;     // a lifted sheet here and there
    roof.add(s); x += w - 0.07;
  }
  // Roof clutter: tyres and a block weighing sheets down
  const tyre = (x, z, parent = roof, y = 0.1) => { const t = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.11, 8, 18), S.rubberMat); t.rotation.x = Math.PI / 2; t.scale.z = 0.85; t.position.set(x, y, z); parent.add(t); return t; };
  tyre(-1.6, 0.6); tyre(1.1, -0.9); tyre(-0.2, 1.4);
  const rb = new THREE.Mesh(surfBox(0.4, 0.2, 0.2, S.concrete, rnd), S.concreteMat); rb.position.set(2.2, 0.13, 0.9); rb.rotation.y = 0.4; roof.add(rb);

  // Stovepipe with rain cap
  const pipeMat = new THREE.MeshStandardMaterial({ map: S.galv.map, roughnessMap: S.galv.roughnessMap, color: 0xb08868, roughness: 1, metalness: 0.4 });
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.5, 12), pipeMat); pipe.position.set(-1.9, wallTop(-1) + 0.55, -1.0); g.add(pipe);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.14, 12), pipeMat); cap.position.set(-1.9, wallTop(-1) + 1.42, -1.0); g.add(cap);

  // Satellite dish on a bracket at the front corner
  const dishPaint = new THREE.MeshStandardMaterial({ map: S.paint.map, roughnessMap: S.paint.roughnessMap, color: 0xf2efe6, roughness: 1, metalness: 0.2, side: THREE.DoubleSide });
  const dishPts = []; for (let i = 0; i <= 12; i++) { const r = (i / 12) * 0.48; dishPts.push(new THREE.Vector2(r, (r * r) / 0.9)); }
  const dishG = new THREE.Group(); dishG.position.set(L / 2 - 0.35, wallTop(1.2) + 0.55, 1.2); g.add(dishG);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.75, 8), iron); mast.position.y = -0.3; dishG.add(mast);
  const dishHead = new THREE.Group(); dishHead.rotation.set(-1.0, 0.7, 0); dishG.add(dishHead);
  dishHead.add(new THREE.Mesh(new THREE.LatheGeometry(dishPts, 20), dishPaint));
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.5, 5), iron); arm.position.set(0, 0.2, 0.2); arm.rotation.x = 0.75; dishHead.add(arm);
  const lnb = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.06), new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.6 })); lnb.position.set(0, 0.42, 0.03); dishHead.add(lnb);

  // Antenna mast with crossbars and guy wires
  const mx = -L / 2 + 0.4, mz = -W / 2 + 0.4, my = wallTop(mz);
  const mastM = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 2.4, 6), iron); mastM.position.set(mx, my + 1.2, mz); g.add(mastM);
  [[2.2, 0.9], [1.9, 0.7], [1.6, 0.5]].forEach(([h, w]) => { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, w, 4), iron); b.rotation.z = Math.PI / 2; b.rotation.y = 0.5; b.position.set(mx, my + h, mz); g.add(b); });
  const cable = (a, b, sag, r = 0.006, mtl = S.wireMat) => {
    const mid = a.clone().lerp(b, 0.5); mid.y -= sag;
    const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, mid, b), 10, r, 3), mtl); g.add(m); return m;
  };
  cable(new THREE.Vector3(mx, my + 2.0, mz), new THREE.Vector3(mx + 1.4, wallTop(mz + 1) + 0.12, mz + 1.0), 0.05);
  cable(new THREE.Vector3(mx, my + 2.0, mz), new THREE.Vector3(mx + 1.2, wallTop(mz) + 0.12, mz + 0.05), 0.05);
  const blackCable = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.6 });
  cable(new THREE.Vector3(L / 2 - 0.35, wallTop(1.2) + 0.2, 1.2), new THREE.Vector3(L / 2 + 0.12, FLOOR + 1.9, W / 2 - 0.4), 0.25, 0.01, blackCable);
  cable(new THREE.Vector3(mx, my + 0.3, mz), new THREE.Vector3(-L / 2 - 0.1, FLOOR + 1.2, -W / 2 + 1.6), 0.4, 0.01, blackCable);

  // Porch: two crooked posts holding the front overhang
  for (const px of [-L / 2 + 0.3, L / 2 - 0.5]) plank(0.11, HF + 0.1, 0.11, px, FLOOR + (HF + 0.1) / 2 - 0.05, W / 2 + 0.55, 0.03, 0, (rnd() - 0.5) * 0.06);
  return shadowed(g);
}

/* ---------- Yard: barbed wire, concertina coil, junk ---------- */
let WIRE = [];
function barbedRun(g, pts, S, rnd) {
  const barbs = [];
  const strand = (a, b, sag) => {
    const mid = a.clone().lerp(b, 0.5); mid.y -= sag;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const cp = curve.getPoints(16); for (let i = 1; i < cp.length; i++) WIRE.push(cp[i - 1], cp[i]);
    const n = Math.floor(curve.getLength() / 0.14);
    for (let i = 1; i < n; i++) barbs.push(curve.getPoint(i / n));
  };
  for (let i = 0; i < pts.length; i++) {
    const [x, z, lean] = pts[i];
    const p = new THREE.Mesh(surfBox(0.09, 1.45, 0.09, S.wood, rnd), S.woodMat); p.position.set(x, 0.68, z); p.rotation.set(lean, rnd() * 3, lean * 0.5); g.add(p);
    if (i > 0) { const [px, pz] = pts[i - 1]; for (const y of [0.45, 0.85, 1.25]) strand(new THREE.Vector3(px, y, pz), new THREE.Vector3(x, y + (rnd() - 0.5) * 0.06, z), 0.04 + rnd() * 0.06); }
  }
  return barbs;
}
function concertina(g, a, b, S, rnd, r = 0.38) {
  const dir = b.clone().sub(a), len = dir.length(); dir.normalize();
  const side = new THREE.Vector3(-dir.z, 0, dir.x), loops = Math.floor(len / 0.13), pts = [];
  const steps = loops * 18;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, ang = t * loops * Math.PI * 2, rr = r * (0.92 + vnoise(t * 30, 0, 5) * 0.16);
    pts.push(a.clone().addScaledVector(dir, t * len + Math.sin(ang * 0.5) * 0.02).addScaledVector(side, Math.cos(ang) * rr).add(new THREE.Vector3(0, r + Math.sin(ang) * rr * 0.95, 0)));
  }
  for (let i = 1; i < pts.length; i++) WIRE.push(pts[i - 1], pts[i]);
  const barbs = []; for (let i = 0; i < steps; i += 3) barbs.push(pts[i]);
  return barbs;
}
function addBarbs(g, points, S, rnd) {
  const v = new THREE.Vector3();
  for (const p of points) for (let k = 0; k < 2; k++) {
    v.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).setLength(0.022);
    WIRE.push(p.clone().add(v), p.clone().sub(v));
  }
}
function drum(S, rnd, painted = true) {
  const geo = new THREE.CylinderGeometry(0.29, 0.29, 0.88, 28, 8);
  const pos = geo.attributes.position, uv = geo.attributes.uv, seed = Math.floor(rnd() * 1e5), u0 = rnd() * 3, v0 = rnd() * 3;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), a = Math.atan2(z, x), r = Math.hypot(x, z);
    if (r > 0.28) {
      const rib = Math.abs(y - 0.15) < 0.03 || Math.abs(y + 0.15) < 0.03 ? 0.012 : 0;
      const dent = (fbm(a * 2, y * 3, seed, 3) - 0.5) * 0.07;
      const k = (0.29 + rib + Math.min(0, dent)) / r; pos.setX(i, x * k); pos.setZ(i, z * k);
      uv.setXY(i, u0 + (a + Math.PI) * 0.29, v0 + y + 0.44);
    } else uv.setXY(i, u0 + x + 0.3, v0 + z + 0.3);
  }
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 5, uv.getY(i) / 5);
  grime(geo, 0.88, 0.3); geo.computeVertexNormals();
  return new THREE.Mesh(geo, painted ? S.paintMat : S.galvMat);
}
function buildShackYard() {
  const S = surfaces(), rnd = seeded(4242);
  const g = new THREE.Group(); g.name = "shanty_yard"; WIRE = [];
  // Fence along the left and front-left, posts leaning a little
  const barbs = barbedRun(g, [[-5.2, -3.2, 0.05], [-5.4, -1.0, -0.04], [-5.3, 1.3, 0.07], [-5.0, 3.6, -0.03], [-3.4, 4.9, 0.1], [-1.6, 5.4, 0.18]], S, rnd);
  // Concertina coil behind the shack and a loose one at the front right
  barbs.push(...concertina(g, new THREE.Vector3(-4.6, 0, -3.6), new THREE.Vector3(3.8, 0, -3.4), S, rnd));
  barbs.push(...concertina(g, new THREE.Vector3(2.4, 0, 5.2), new THREE.Vector3(4.6, 0, 3.9), S, rnd, 0.3));
  addBarbs(g, barbs, S, rnd);
  const wire = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(WIRE), new THREE.LineBasicMaterial({ color: 0x4a443e }));
  wire.name = "wire"; g.add(wire);

  // Drums: two standing, one on its side
  const d1 = drum(S, rnd); d1.position.set(3.4, 0.44, 2.4); g.add(d1);
  const d2 = drum(S, rnd); d2.position.set(3.95, 0.44, 1.9); d2.rotation.y = 1; g.add(d2);
  const d3 = drum(S, rnd, false); d3.position.set(4.2, 0.29, 3.0); d3.rotation.set(Math.PI / 2, 0, 0.6); g.add(d3);
  // Tyre stack
  for (let i = 0; i < 3; i++) { const t = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.12, 8, 18), S.rubberMat); t.rotation.set(Math.PI / 2 + (rnd() - 0.5) * 0.15, 0, 0); t.scale.z = 0.85; t.position.set(-3.7 + (rnd() - 0.5) * 0.08, 0.1 + i * 0.2, 3.2); g.add(t); }
  // Scrap sheets leaning on the right wall and one lying flat
  for (let i = 0; i < 2; i++) {
    const s = new THREE.Mesh(sheetGeo(0.85, 1.8, rnd, i ? S.paint : S.galv, { dent: 0.05 }), i ? S.paintMat : S.galvMat);
    s.position.set(3.15 + i * 0.08, 0.85, -0.6 - i * 0.7); s.rotation.set(0, Math.PI / 2, 0); s.rotateX(-0.32); g.add(s);
  }
  const flat = new THREE.Mesh(sheetGeo(0.9, 2.0, rnd, S.galv, { dent: 0.06 }), S.galvMat); flat.rotation.set(-Math.PI / 2 + 0.04, 0, 0.5); flat.position.set(1.6, 0.04, 4.6); g.add(flat);
  // Plank pile
  for (let i = 0; i < 7; i++) { const p = new THREE.Mesh(surfBox(2.2 + rnd() * 0.6, 0.05, 0.18, S.wood, rnd), S.woodMat); p.position.set(-2.4 + (rnd() - 0.5) * 0.3, 0.03 + Math.floor(i / 3) * 0.05, 4.2 + (i % 3) * 0.2); p.rotation.y = 0.25 + (rnd() - 0.5) * 0.25; g.add(p); }
  // Loose cinder blocks and rubble
  [[0.6, 4.3], [0.95, 4.5], [-4.3, 0.3], [2.6, -3.0]].forEach(([x, z], i) => { const b = new THREE.Mesh(surfBox(0.4, 0.2, 0.2, S.concrete, rnd), S.concreteMat); b.position.set(x, 0.1, z); b.rotation.set(i === 1 ? Math.PI / 2 : 0, rnd() * 3, 0); if (i === 1) b.position.y = 0.2; g.add(b); });
  for (let i = 0; i < 26; i++) { const r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.05 + rnd() * 0.09, 0), S.rockMat); r.position.set(-4 + rnd() * 8.5, 0.03, 2.6 + rnd() * 3); r.rotation.set(rnd() * 3, rnd() * 3, 0); r.scale.y = 0.6; g.add(r); }
  // Rusted pipes
  const pipeMat = new THREE.MeshStandardMaterial({ map: S.galv.map, roughnessMap: S.galv.roughnessMap, color: 0xa47a5c, roughness: 1, metalness: 0.4 });
  for (let i = 0; i < 3; i++) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2 + rnd(), 10, 1, true), pipeMat); p.rotation.set(0, 0.9 + i * 0.15, Math.PI / 2); p.position.set(-3.8 + i * 0.13, 0.06, -0.8 - i * 0.12); g.add(p); }
  // Broken pallet
  const pal = new THREE.Group(); pal.position.set(1.0, 0.0, 3.1); pal.rotation.set(0.06, -0.4, 0); g.add(pal);
  for (let i = 0; i < 5; i++) if (i !== 2) { const s = new THREE.Mesh(surfBox(0.12, 0.025, 1.0 - (i === 4 ? 0.35 : 0), S.wood, rnd), S.woodMat); s.position.set(-0.48 + i * 0.24, 0.12, i === 4 ? -0.17 : 0); pal.add(s); }
  for (const z of [-0.42, 0, 0.42]) { const s = new THREE.Mesh(surfBox(1.1, 0.09, 0.09, S.wood, rnd), S.woodMat); s.position.set(0, 0.05, z); pal.add(s); }
  return shadowed(g);
}

export { buildShack, buildShackYard, surfaces, vnoise };
