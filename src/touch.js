import { MISSILE } from './hudArms.js';
// Touch controls (phones, tablets). Flight controls on the left, weapons on the right; icons, plus GEAR and BRAKE.
//  - drag anywhere else to move the aim, like the mouse;
//  - left: a throttle (a thin black bar with a sliding block and the power % over it; stays where you leave it; notches for the detents, the
//    afterburner past full dry power), the airbrake button beside it (hold), the landing-gear button above it (only shown when slow or low);
//  - right: fire (by the thumb; it shows the selected weapon), target zoom just above it (hold); tapping a weapon in
//    the weapon panel selects it.
export const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

let MIL = 0.84;   // where the full-dry-power gate sits on the lever's travel (above it: afterburner)
// icons
const ZOOM = `<svg viewBox="0 0 24 24"><path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.2" fill="#fff" stroke="none"/></svg>`;
// the fire button shows the selected weapon as a white silhouette: guns a bullet with its trail, missiles the missile
// itself, bombs (later) a bomb; all pointing up and to the right
const BULLET = `<svg class="wpn" viewBox="0 0 48 16"><path d="M1 8h22" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="0.5"/><path d="M9 4.2h15M9 11.8h15" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity="0.4"/><path d="M27 3.5h9c6 0 10.5 2.3 11.5 4.5c-1 2.2-5.5 4.5-11.5 4.5h-9z" fill="#fff"/></svg>`;
const BOMB = `<svg class="wpn" viewBox="0 0 48 16"><path d="M10 4h22c8 0 14 2 15 4c-1 2-7 4-15 4H10z" fill="#fff"/><path d="M10 4L3 1v14l7-3z" fill="#fff"/></svg>`;

const PAUSE = `<svg viewBox="0 0 24 24"><path d="M8.5 5v14M15.5 5v14" stroke-width="3.2" stroke-linecap="round"/></svg>`;

export function createTouch(root, { ab = true, onLook, onThrottle, onFire, onAirbrake, onGear, onZoom, onPause, sensitivity = 1.6 }) {
  // the throttle: a plain black bar, a square grey block that slides in it, and notches down one side for the detents
  // (idle, every 10 %, a long one at full dry power where the afterburner begins)
  if (!ab) MIL = 1;                                         // (no afterburner: the whole travel is dry power)
  const at = (f) => `bottom: calc(10px + (100% - 20px) * ${f.toFixed(3)})`;   // a point on the lever's travel
  const ticks = Array.from({ length: 11 }, (_, k) => `<i class="tk${k % 5 ? '' : ' big'}" style="${at(k / 10 * MIL)}"></i>`).join('') + (ab ? `<i class="tk mil" style="${at(MIL)}"></i>` : '');
  root.innerHTML = `
    <div class="t-throttle"><b class="pct"></b><div class="bar"></div>${ticks}<div class="grip"></div></div>
    <button class="t-btn t-brake" aria-label="Airbrake">BRAKE</button>
    <button class="t-btn t-gear" aria-label="Landing gear" hidden>GEAR</button>
    <button class="t-btn t-zoom" aria-label="Zoom">${ZOOM}</button>
    <button class="t-fire" aria-label="Fire">${BULLET}</button>
    <button class="t-btn t-pause" aria-label="Pause">${PAUSE}</button>`;
  const thr = root.querySelector('.t-throttle'), grip = thr.querySelector('.grip'), pctEl = thr.querySelector('.pct');
  const looks = new Map();   // pointerId -> last x, y

  // aim: any touch that isn't on a control
  addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || e.target.closest('.t-throttle, .t-fire, .t-btn, #arms, #devkit, #devmenu, .lil-gui, #tut, #mend, #pause, #layed')) return;
    looks.set(e.pointerId, [e.clientX, e.clientY]);
  });
  addEventListener('pointermove', e => {
    const l = looks.get(e.pointerId);
    if (!l) return;
    onLook((e.clientX - l[0]) * sensitivity, (e.clientY - l[1]) * sensitivity);
    l[0] = e.clientX; l[1] = e.clientY;
  });
  const end = e => looks.delete(e.pointerId);
  addEventListener('pointerup', end); addEventListener('pointercancel', end);
  addEventListener('contextmenu', e => e.preventDefault());   // (no long-press menu)

  // throttle: grab the lever (or touch the slot) and slide; it stays put. Past the gate is afterburner.
  let thrId = null;
  const setThr = (y) => {
    const r = thr.getBoundingClientRect(), pad = 10;
    const f = Math.min(1, Math.max(0, 1 - (y - r.top - pad) / (r.height - 2 * pad)));
    const v = f > MIL + 0.02 ? 1.1 : Math.min(f / MIL, 1);
    grip.style.bottom = `calc(${(f * 100).toFixed(1)}% - ${(f * 2 * pad - pad).toFixed(1)}px)`;
    thr.classList.toggle('ab', v > 1);
    onThrottle(v);
  };
  thr.addEventListener('pointerdown', e => { thrId = e.pointerId; try { thr.setPointerCapture(e.pointerId); } catch { /* some browsers refuse; moves still arrive */ } setThr(e.clientY); e.preventDefault(); });
  thr.addEventListener('pointermove', e => { if (e.pointerId === thrId) setThr(e.clientY); });
  thr.addEventListener('pointerup', () => { thrId = null; });
  requestAnimationFrame(() => { const r = thr.getBoundingClientRect(); setThr(r.top + 10 + (1 - MIL) * (r.height - 20)); });   // start at full dry power

  // hold buttons (airbrake, zoom, fire) and the gear toggle
  const hold = (el, f) => {
    el.addEventListener('pointerdown', e => { e.preventDefault(); el.classList.add('on'); f(true); });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, () => { if (el.classList.contains('on')) { el.classList.remove('on'); f(false); } });
  };
  const fire = root.querySelector('.t-fire'), gear = root.querySelector('.t-gear');
  hold(fire, (on) => onFire(on));
  hold(root.querySelector('.t-brake'), (on) => onAirbrake?.(on));
  hold(root.querySelector('.t-zoom'), (on) => onZoom?.(on));
  gear.addEventListener('pointerdown', e => { e.preventDefault(); onGear?.(); });
  root.querySelector('.t-pause').addEventListener('click', () => onPause?.());
  root.hidden = false;
  return {
    // the engine power readout over the lever (the HUD's own throttle scale is hidden on touch)
    setPct(p, ab) { const t = p == null ? '' : p + '%'; if (pctEl.textContent !== t) pctEl.textContent = t; pctEl.classList.toggle('ab', !!ab); },
    setLocked(on) { fire.classList.toggle('locked', on); },
    // the fire button's icon: 1 guns, 2 missiles, 3 bombs (later)
    setWeapon(k) {
      if (k === fire._w) return; fire._w = k;
      fire.innerHTML = k === 2 ? MISSILE.replace('<svg ', '<svg class="wpn msl" ') : k === 3 ? BOMB : BULLET;
    },
    // the gear button: shown only when it makes sense (slow or low, or the gear is already down); lit while down
    setGear(show, down) { if (gear.hidden === show) gear.hidden = !show; gear.classList.toggle('down', !!down); },
  };
}
