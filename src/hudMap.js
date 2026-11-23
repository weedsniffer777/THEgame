// Map: the aerial photo in faint greyscale with sparse contour lines (every 250 m, heavier every 1000 m), lakes darker,
// made once from the terrain data, then a crop of it drawn in a framed square in the top right each frame, north up, with the
// player as an arrow and enemies as small red ticks. Hold M for the whole region.
const MAP = 1024;           // contour drawing resolution (whole terrain)

function drawContours(terrain) {
  const c = document.createElement('canvas'); c.width = c.height = MAP;
  const g = c.getContext('2d'), img = g.createImageData(MAP, MAP), d = img.data;
  const W = terrain.w, H = terrain.h, hAt = (i, j) => terrain.hMin + terrain.hScale * terrain.raw(i, j);
  const h = new Float32Array(MAP * MAP), wet = new Uint8Array(MAP * MAP);
  for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
    const i = Math.floor(x / MAP * W), j = Math.floor(y / MAP * H);
    h[y * MAP + x] = hAt(i, j); wet[y * MAP + x] = terrain.water[j * W + i] > 127 ? 1 : 0;
  }
  for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
    const k = y * MAP + x, v = h[k];
    const r = x < MAP - 1 ? h[k + 1] : v, b = y < MAP - 1 ? h[k + MAP] : v;
    // soft relief shading so ridges read, from the NW
    const sx = r - v, sy = b - v, shade = Math.max(-1, Math.min(1, -(sx + sy) * 0.012));
    // sparse contours (every 250 m, heavier every 1000 m) over the photo: lines only, the rest transparent
    const step = (a, s) => Math.floor(a / s);
    let col = 0, a = 0;
    if (!wet[k]) {
      if (step(v, 1000) !== step(r, 1000) || step(v, 1000) !== step(b, 1000)) { col = 215; a = 200; }
      else if (step(v, 250) !== step(r, 250) || step(v, 250) !== step(b, 250)) { col = 190; a = 95; }
    }
    if (!a && shade) { col = shade > 0 ? 255 : 0; a = Math.abs(shade) * 26; }   // faint relief shading
    d[k * 4] = col; d[k * 4 + 1] = col; d[k * 4 + 2] = col + 4; d[k * 4 + 3] = a;
  }
  // base: the aerial photo in faint greyscale, darkened; lakes darker still
  const photo = terrain.uniforms?.uColor?.value?.image;
  g.fillStyle = '#2b2e32'; g.fillRect(0, 0, MAP, MAP);
  if (photo) { g.filter = 'grayscale(1) brightness(0.55) contrast(1.15)'; g.globalAlpha = 0.85; g.drawImage(photo, 0, 0, MAP, MAP); g.filter = 'none'; g.globalAlpha = 1; }
  const lines = document.createElement('canvas'); lines.width = lines.height = MAP;
  lines.getContext('2d').putImageData(img, 0, 0);
  g.drawImage(lines, 0, 0);
  // lakes
  const lk = g.getImageData(0, 0, MAP, MAP), ld = lk.data;
  for (let k = 0; k < MAP * MAP; k++) if (wet[k]) { ld[k * 4] = ld[k * 4] * 0.45; ld[k * 4 + 1] = ld[k * 4 + 1] * 0.5; ld[k * 4 + 2] = ld[k * 4 + 2] * 0.6; }
  g.putImageData(lk, 0, 0);
  return c;
}

export function createMap(root, terrain) {
  const src = drawContours(terrain);
  const extent = terrain.w * terrain.s;                       // metres across the whole drawing
  const toPx = (x, z) => [(x - terrain.ox) / extent * MAP, (z - terrain.oz) / extent * MAP];
  const mk = (id) => { const w = document.createElement('div'); w.id = id; const c = document.createElement('canvas'); w.append(c); root.append(w); return [w, c]; };
  const [mini, mc] = mk('minimap'), [big, bc] = mk('bigmap');
  const draw = (cv, size, span, ac, drones) => {
    const dpr = Math.min(devicePixelRatio || 1, 2), px = Math.round(size * dpr);
    if (cv.width !== px) { cv.width = cv.height = px; cv.style.width = cv.style.height = `${size}px`; }
    const g = cv.getContext('2d');
    // the minimap follows the player; the big map (span = whole) shows the entire region
    const whole = span >= extent, [px0, py0] = toPx(ac.pos.x, ac.pos.z);
    const cx = whole ? MAP / 2 : px0, cy = whole ? MAP / 2 : py0, sp = Math.min(span, extent) / extent * MAP;
    g.imageSmoothingEnabled = true;
    g.fillStyle = '#2b2e32'; g.fillRect(0, 0, px, px);
    g.drawImage(src, cx - sp / 2, cy - sp / 2, sp, sp, 0, 0, px, px);
    const s = px / sp, P = (x, z) => { const [a, b] = toPx(x, z); return [(a - cx) * s + px / 2, (b - cy) * s + px / 2]; };
    // enemies: fighters a small dart like ours; bombers a wide, blunt chevron with a flat bar behind it
    g.fillStyle = '#ff4a3c'; g.strokeStyle = '#ff4a3c'; g.lineWidth = 1.4 * dpr; g.lineJoin = 'round';
    for (const d of drones) {
      if (!d.alive || d.falling || d.hidden) continue;
      const [x, y] = P(d.pos.x, d.pos.z); if (x < -6 || y < -6 || x > px + 6 || y > px + 6) continue;
      const hd = Math.atan2(d.vel.x, -d.vel.z);
      g.save(); g.translate(x, y); g.rotate(hd);
      if (d.def.label === 'Bomber') {
        const L = 4.2 * dpr;
        g.beginPath(); g.moveTo(-L * 1.3, L * 0.45); g.lineTo(0, -L * 0.55); g.lineTo(L * 1.3, L * 0.45); g.lineTo(0, L * 0.05); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(-L * 0.75, L * 1.05); g.lineTo(L * 0.75, L * 1.05); g.stroke();
      } else {
        const L = 4 * dpr;
        g.beginPath(); g.moveTo(0, -L); g.lineTo(L * 0.62, L * 0.7); g.lineTo(0, L * 0.35); g.lineTo(-L * 0.62, L * 0.7); g.closePath(); g.fill();
      }
      g.restore();
    }
    // the player: an arrow along the heading
    const f = ac.vel, hd = Math.atan2(f.x, -f.z), L = 7 * dpr, [ax, ay] = P(ac.pos.x, ac.pos.z);
    g.save(); g.translate(ax, ay); g.rotate(hd);
    g.fillStyle = '#ecf6ee'; g.beginPath(); g.moveTo(0, -L); g.lineTo(L * 0.62, L * 0.7); g.lineTo(0, L * 0.35); g.lineTo(-L * 0.62, L * 0.7); g.closePath(); g.fill();
    g.restore();
  };
  let held = false;
  addEventListener('keydown', (e) => { if (e.code === 'KeyM' && !e.repeat) { held = true; big.classList.add('on'); document.body.classList.add('bigmap'); } });
  addEventListener('keyup', (e) => { if (e.code === 'KeyM') { held = false; big.classList.remove('on'); document.body.classList.remove('bigmap'); } });
  addEventListener('blur', () => { held = false; big.classList.remove('on'); document.body.classList.remove('bigmap'); });
  let tick = 0;
  return (ac, drones) => {
    if ((tick = (tick + 1) % 2)) return;                      // every other frame is plenty
    draw(mc, 168, 9000, ac, drones);
    if (held) draw(bc, Math.min(innerWidth, innerHeight) * 0.72, 1e9, ac, drones);
  };
}
