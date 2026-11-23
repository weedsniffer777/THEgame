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
  const draw = (cv, size, span, ac, drones, missiles = []) => {
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
    // icons: bright cores with a soft glow of their own colour (enemies red, with a thin white rim only when a priority
    // target (d.priority); our missiles and the player white); the glow is drawn first, then the crisp shape on top
    const dart = (L) => { g.beginPath(); g.moveTo(0, -L); g.lineTo(L * 0.62, L * 0.7); g.lineTo(0, L * 0.35); g.lineTo(-L * 0.62, L * 0.7); g.closePath(); };
    const glowDart = (x, y, hd, L, fill, glow, rim) => {
      g.save(); g.translate(x, y); g.rotate(hd);
      dart(L);
      g.shadowColor = glow; g.shadowBlur = 7 * dpr; g.fillStyle = glow; g.fill(); g.fill();   // (twice: a stronger halo)
      g.shadowBlur = 0; g.fillStyle = fill; g.fill();
      if (rim) { g.strokeStyle = rim; g.lineWidth = 0.9 * dpr; g.lineJoin = 'round'; g.stroke(); }
      g.restore();
    };
    for (const d of drones) {
      if (!d.alive || d.falling || d.hidden) continue;
      const [x, y] = P(d.pos.x, d.pos.z); if (x < -8 || y < -8 || x > px + 8 || y > px + 8) continue;
      glowDart(x, y, Math.atan2(d.vel.x, -d.vel.z), 5.5 * dpr, '#ff4b3e', 'rgba(255,70,55,0.9)', d.priority ? 'rgba(255,255,255,0.9)' : null);   // (white rim: priority targets only)
    }
    // missiles in flight: a short glowing line along each one's path
    g.lineCap = 'round';
    for (const m of missiles) {
      const [x, y] = P(m.p.x, m.p.z); if (x < -8 || y < -8 || x > px + 8 || y > px + 8) continue;
      const h = Math.hypot(m.v.x, m.v.z) || 1, L = 4.5 * dpr, dx = m.v.x / h * L, dy = m.v.z / h * L;
      const ours = m.owner === 'player', glow = ours ? 'rgba(255,255,255,0.8)' : '#ff5a48';   // ours white (like the player), the enemy's red
      g.beginPath(); g.moveTo(x - dx, y - dy); g.lineTo(x, y);
      g.shadowColor = glow; g.shadowBlur = 5 * dpr; g.strokeStyle = glow; g.lineWidth = 1.7 * dpr; g.stroke(); g.stroke();
      g.shadowBlur = 0; g.strokeStyle = ours ? '#ffffff' : '#ffd9d4'; g.lineWidth = 0.7 * dpr; g.stroke();   // white-hot core
    }
    g.shadowBlur = 0;
    // the player: a white arrow along the heading
    glowDart(...P(ac.pos.x, ac.pos.z), Math.atan2(ac.vel.x, -ac.vel.z), 7 * dpr, '#ffffff', 'rgba(255,255,255,0.75)', null);
  };
  let held = false;
  addEventListener('keydown', (e) => { if (e.code === 'KeyM' && !e.repeat) { held = true; big.classList.add('on'); document.body.classList.add('bigmap'); } });
  addEventListener('keyup', (e) => { if (e.code === 'KeyM') { held = false; big.classList.remove('on'); document.body.classList.remove('bigmap'); } });
  addEventListener('blur', () => { held = false; big.classList.remove('on'); document.body.classList.remove('bigmap'); });
  let tick = 0;
  return (ac, drones, missiles) => {
    if ((tick = (tick + 1) % 2)) return;                      // every other frame is plenty
    draw(mc, Math.round(Math.min(168, innerHeight * 0.3)), 9000, ac, drones, missiles);   // (smaller on short phone screens)
    if (held) draw(bc, Math.min(innerWidth, innerHeight) * 0.72, 1e9, ac, drones, missiles);
  };
}
