import * as THREE from 'three';
import '@fontsource/b612-mono/700.css';
import '@fontsource/rajdhani/700.css';   // (the banners across the screen)
import { settings, units } from './settings.js';

// Flight HUD, drawn as one SVG over the screen: thin single-colour strokes and a cockpit-display typeface.
//  - speed tape left of the reticle and altitude tape right of it, each with a readout box whose last digit rolls
//  - G under the speed box, heading tape across the top
//  - throttle: a tick scale beside the speed tape, notch at full dry power, hatched afterburner zone, a chevron for
//    the lever and a thin bar for what the engine is actually giving
//  - Mach above the speed box once past M 0.75
//  - units (speed kts / km/h, altitude ft / m) follow the Units setting
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent?.appendChild(e); return e; };
const DEG = Math.PI / 180;

export function createFlightHud(root, { ab = true } = {}) {   // ab: false for a jet without an afterburner (the scale ends at full power)
  const svg = el('svg', { id: 'fhud' }, root);
  const defs = el('defs', {}, svg);
  const hatch = el('pattern', { id: 'abHatch', width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
  el('rect', { width: 1.6, height: 4, fill: '#ffa640' }, hatch);
  const clips = {};
  const clip = (id) => { const c = el('clipPath', { id }, defs); clips[id] = el('rect', {}, c); return `url(#${id})`; };

  // ---- tapes (built once; positions set on resize; ticks redrawn each frame as one path each)
  const tape = (id, side) => {
    const g = el('g', { class: 'tape' }, svg);
    const inner = el('g', { 'clip-path': clip(id + 'Clip') }, g);
    const ticks = el('path', { class: 'tk' }, inner);
    const labels = Array.from({ length: 8 }, () => el('text', { class: 'tl', 'text-anchor': side < 0 ? 'start' : 'end' }, inner));
    const spine = el('path', { class: 'tk' }, g);
    const box = el('path', { class: 'box' }, g);
    const boxClip = clip(id + 'Box');
    const digits = el('g', { 'clip-path': boxClip }, g);
    const head = el('text', { class: 'bv', 'text-anchor': 'end' }, digits);
    const roll = [0, 1, 2].map(() => el('text', { class: 'bv', 'text-anchor': 'end' }, digits));
    return { g, ticks, labels, spine, box, head, roll, side, id };
  };
  const spd = tape('spd', -1), alt = tape('alt', 1);
  const gTxt = el('text', { class: 'gv', 'text-anchor': 'end' }, svg);
  const ktTxt = el('text', { class: 'unit', 'text-anchor': 'end' }, svg);
  const ftTxt = el('text', { class: 'unit', 'text-anchor': 'end' }, svg);
  const mTxt = el('text', { class: 'gv', 'text-anchor': 'end' }, svg);
  let machOn = false, shownPct = 20;

  // heading
  const hdg = { g: el('g', {}, svg) };
  hdg.inner = el('g', { 'clip-path': clip('hdgClip') }, hdg.g);
  hdg.ticks = el('path', { class: 'tk' }, hdg.inner);
  hdg.labels = Array.from({ length: 12 }, () => el('text', { class: 'tl', 'text-anchor': 'middle' }, hdg.inner));
  hdg.caret = el('path', { class: 'box' }, hdg.g);
  hdg.txt = el('text', { class: 'bv', 'text-anchor': 'middle' }, hdg.g);

  // throttle
  const thr = { g: el('g', { id: 'thrScale' }, svg) };
  thr.ab = el('rect', { fill: 'url(#abHatch)', opacity: 0.55 }, thr.g);
  thr.ticks = el('path', { class: 'tk' }, thr.g);
  thr.eng = el('rect', { class: 'eng' }, thr.g);
  thr.chev = el('path', { class: 'chev' }, thr.g);
  thr.txt = el('text', { class: 'gv thrv', 'text-anchor': 'middle' }, thr.g);   // lever position: 20% idle ... 99% full dry, 110% afterburner


  let W = 0, H = 0, L = {};
  function layout() {
    W = innerWidth; H = innerHeight;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const cx = W / 2, cy = H / 2, off = Math.min(W * 0.25, 330), th = Math.min(250, H * 0.42);
    L = { cx, cy, th, sx: cx - off, ax: cx + off, hy: Math.max(34, H * 0.07), hw: Math.min(340, W * 0.4) };
    for (const t of [spd, alt]) {
      const x = t.side < 0 ? L.sx : L.ax;
      const c = clips[t.id + 'Clip']; c.setAttribute('x', x - (t.side < 0 ? 0 : 60)); c.setAttribute('y', cy - th / 2); c.setAttribute('width', 60); c.setAttribute('height', th);
      t.spine.setAttribute('d', `M${x} ${cy - th / 2}V${cy + th / 2}`);
      // readout box: points at the tape, value inside, on the far side from the reticle
      const bw = t.side < 0 ? 54 : 62, bh = 22, s = t.side, bx = x + s * 4;   // (box outside the tape, pointing in at it)
      const far = bx + s * bw;
      t.box.setAttribute('d', `M${bx} ${cy}L${bx + s * 7} ${cy - bh / 2}H${far}V${cy + bh / 2}H${bx + s * 7}Z`);
      const bc = clips[t.id + 'Box']; bc.setAttribute('x', Math.min(bx, far)); bc.setAttribute('y', cy - bh / 2 + 1); bc.setAttribute('width', bw); bc.setAttribute('height', bh - 2);
      t.textX = s < 0 ? bx - 9 : far - 6;
      t.boxFar = far;
    }
    gTxt.setAttribute('x', spd.textX); gTxt.setAttribute('y', cy + 30);
    ktTxt.setAttribute('x', spd.textX); ktTxt.setAttribute('y', cy - 16);
    ftTxt.setAttribute('x', alt.textX); ftTxt.setAttribute('y', cy - 16);
    mTxt.setAttribute('x', spd.textX); mTxt.setAttribute('y', cy - 30);
    const hc = clips.hdgClip; hc.setAttribute('x', cx - L.hw / 2); hc.setAttribute('y', L.hy - 16); hc.setAttribute('width', L.hw); hc.setAttribute('height', 30);
    hdg.caret.setAttribute('d', `M${cx - 22} ${L.hy + 26}H${cx + 22}V${L.hy + 44}H${cx - 22}ZM${cx} ${L.hy + 14}L${cx - 5} ${L.hy + 21}H${cx + 5}Z`);
    hdg.txt.setAttribute('x', cx); hdg.txt.setAttribute('y', L.hy + 40);
    // throttle scale: outside the speed tape
    const tx = spd.boxFar - 22, ty0 = cy + th / 2, ty1 = cy - th / 2, mil = ty0 - (ty0 - ty1) * (ab ? 0.78 : 1);
    L.thr = { tx, ty0, ty1, mil };
    thr.ab.setAttribute('x', tx - 4); thr.ab.setAttribute('y', ty1); thr.ab.setAttribute('width', 8); thr.ab.setAttribute('height', mil - ty1);
    let d = `M${tx} ${ty0}V${ty1}`;
    for (let k = 0; k <= 10; k++) { const y = ty0 - (mil - ty0) * -k / 10; d += `M${tx} ${y}h${k % 5 ? -4 : -7}`; }
    if (ab) d += `M${tx - 9} ${mil}h18`;                           // the detent: full dry power
    thr.ab.style.display = ab ? '' : 'none';
    thr.ticks.setAttribute('d', d);
    thr.txt.setAttribute('x', tx); thr.txt.setAttribute('y', ty1 - 9);
  }
  addEventListener('resize', layout); layout();

  const fmt = (n) => String(Math.round(n));
  function rollBox(t, value, step) {
    // value shown with its last 'step' digit rolling: e.g. 347.6 -> "34" + rolling 7/8
    const v = Math.max(0, value), base = Math.floor(v / step), frac = v / step - base;
    const lastDigits = step === 1 ? 1 : String(step).length;           // digits that roll together (1 or 2)
    const unit = Math.pow(10, lastDigits);
    const headVal = Math.floor(v / unit), y = L.cy + 5;
    t.head.textContent = headVal > 0 ? String(headVal) : '';
    const w = lastDigits * 7.4;                                       // width of the rolling digits (12px mono)
    t.head.setAttribute('x', t.textX - w); t.head.setAttribute('y', y);
    for (let k = 0; k < 3; k++) {
      const n = (base + k - 1) * step % unit, txt = String(((n % unit) + unit) % unit).padStart(headVal > 0 ? lastDigits : 1, '0');
      const r = t.roll[k]; r.textContent = txt; r.setAttribute('x', t.textX); r.setAttribute('y', y + (frac - (k - 1)) * 15);
    }
  }
  function tapeTicks(t, value, per, minor, major, scale) {
    // scale: px per unit; ticks every 'minor', labels every 'major'
    const x = t.side < 0 ? L.sx : L.ax, s = -t.side, half = L.th / 2 / scale;   // (ticks toward the reticle)
    let d = '', li = 0;
    for (let v = Math.ceil((value - half) / minor) * minor; v <= value + half; v += minor) {
      if (v < 0) continue;
      const y = L.cy - (v - value) * scale, isMajor = Math.round(v) % major === 0;
      d += `M${x} ${y.toFixed(1)}h${s * (isMajor ? 10 : 5)}`;
      if (isMajor && li < t.labels.length) { const lb = t.labels[li++]; lb.textContent = fmt(v / per); lb.setAttribute('x', x + s * 14); lb.setAttribute('y', (y + 4).toFixed(1)); lb.style.display = ''; }
    }
    for (; li < t.labels.length; li++) t.labels[li].style.display = 'none';
    t.ticks.setAttribute('d', d);
  }

  const _f = new THREE.Vector3(), _p = new THREE.Vector3(), _r = new THREE.Vector3();
  return function update(ac, camera, rig) {
    if (W !== innerWidth || H !== innerHeight) layout();
    const metric = settings.units === 'metric';
    const v = units.speed(ac.t.ias), a = units.alt(ac.pos.y);
    if (metric) { tapeTicks(spd, v, 1, 20, 100, 0.65); tapeTicks(alt, a, 1, 50, 250, 0.33); }
    else { tapeTicks(spd, v, 1, 10, 50, 1.2); tapeTicks(alt, a, 1, 100, 500, 0.1); }
    rollBox(spd, v, 1); rollBox(alt, a, 10);
    ktTxt.textContent = units.speedLabel(); ftTxt.textContent = units.altLabel();
    gTxt.textContent = `${ac.t.g.toFixed(1)}G`;
    // Mach, once it matters (on past 0.75, off again below 0.73)
    machOn = ac.t.mach > (machOn ? 0.73 : 0.75);
    mTxt.textContent = machOn ? `M ${ac.t.mach.toFixed(2)}` : '';
    // heading of the nose, 0-360 clockwise from north (-z)
    _f.set(0, 0, 1).applyQuaternion(ac.quat);
    const h = ((Math.atan2(_f.x, -_f.z) / DEG) + 360) % 360, px = 2;   // px per degree
    let d = '', li = 0;
    for (let a = Math.ceil((h - 85) / 5) * 5; a <= h + 85; a += 5) {
      const x = L.cx + (a - h) * px, major = a % 10 === 0;
      d += `M${x.toFixed(1)} ${L.hy + 12}v${major ? -8 : -4}`;
      if (major && a % 30 === 0 && li < hdg.labels.length) { const lb = hdg.labels[li++]; lb.textContent = String(((a % 360) + 360) % 360 / 10).padStart(2, '0'); lb.setAttribute('x', x.toFixed(1)); lb.setAttribute('y', L.hy - 1); lb.style.display = ''; }
    }
    for (; li < hdg.labels.length; li++) hdg.labels[li].style.display = 'none';
    hdg.ticks.setAttribute('d', d);
    hdg.txt.textContent = String(Math.round(h) % 360).padStart(3, '0');
    // throttle: chevron at the lever, bar for the engine
    const T = L.thr, lever = (v) => v <= 1 ? T.ty0 + (T.mil - T.ty0) * v : T.mil + (T.ty1 - T.mil) * Math.min((v - 1) / 0.1, 1);
    const ly = lever(ac.throttle);
    thr.chev.setAttribute('d', `M${T.tx + 3} ${ly}l8 -6v12z`);
    thr.chev.classList.toggle('ab', ac.throttle >= 1.1);
    // full dry reads 99% (so 100+ means burner); holding for the burner spools it up toward 110, letting go early
    // runs it back down
    const want = !ab ? 20 + 80 * Math.max(0, Math.min(ac.throttle, 1)) : ac.throttle > 1 ? 99 + 11 * Math.min((ac.throttle - 1) / 0.1, 1) : 20 + 79 * Math.max(0, ac.throttle);
    shownPct = want >= shownPct ? want : Math.max(want, shownPct - 60 * (1 / 60));
    const pct = Math.round(shownPct);
    thr.txt.textContent = `${pct}%`; thr.txt.classList.toggle('ab', ac.throttle >= 1.1);
    update.pct = pct; update.ab = ac.throttle >= 1.1;      // (touch shows it on its own throttle instead)
    const ey = lever(ac.engine);
    thr.eng.setAttribute('x', T.tx + 1); thr.eng.setAttribute('width', 2); thr.eng.setAttribute('y', Math.min(ey, T.ty0)); thr.eng.setAttribute('height', Math.max(0, T.ty0 - ey));
    // (pitch marks removed for now)
  };
}
