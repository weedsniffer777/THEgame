import { MISSILE } from './hudArms.js';
// Touch controls (phones, tablets). Flight controls on the left, weapons on the right; icons, plus GEAR and BRAKE.
//  - drag anywhere else to move the aim, like the mouse;
//  - left: a throttle lever in a slotted gate (stays where you leave it; a gate at full dry power, the afterburner
//    beyond it), the airbrake button beside it (hold), the landing-gear button above it (only shown when slow or low);
//  - right: fire (by the thumb; it shows the selected weapon), target zoom just above it (hold); tapping a weapon in
//    the weapon panel selects it.
export const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

const MIL = 0.84;   // where the full-dry-power gate sits on the lever's travel (above it: afterburner)
// icons
const ZOOM = `<svg viewBox="0 0 24 24"><path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.2" fill="#fff" stroke="none"/></svg>`;
// the fire button shows the selected weapon as a white silhouette: guns a bullet with its trail, missiles the missile
// itself, bombs (later) a bomb; all pointing up and to the right
const BULLET = `<svg class="wpn" viewBox="0 0 48 16"><path d="M1 8h22" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="0.5"/><path d="M9 4.2h15M9 11.8h15" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity="0.4"/><path d="M27 3.5h9c6 0 10.5 2.3 11.5 4.5c-1 2.2-5.5 4.5-11.5 4.5h-9z" fill="#fff"/></svg>`;
const BOMB = `<svg class="wpn" viewBox="0 0 48 16"><path d="M10 4h22c8 0 14 2 15 4c-1 2-7 4-15 4H10z" fill="#fff"/><path d="M10 4L3 1v14l7-3z" fill="#fff"/></svg>`;

export function createTouch(root, { onLook, onThrottle, onFire, onAirbrake, onGear, onZoom, sensitivity = 1.6 }) {
  // the knob: a fighter throttle grip seen from the pilot's side (thumb ledge, castle hat, slew button, finger grooves)
  const KNOB = `<svg viewBox="0 0 44 56"><defs>
      <linearGradient id="tkb" x1="0" x2="1"><stop offset="0" stop-color="#1b1f24"/><stop offset="0.42" stop-color="#4b525a"/><stop offset="0.6" stop-color="#3a4047"/><stop offset="1" stop-color="#14171b"/></linearGradient>
      <linearGradient id="tkt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6a727b"/><stop offset="1" stop-color="#3a4047"/></linearGradient></defs>
    <rect x="17" y="46" width="10" height="9" rx="1.5" fill="#0c0e10"/>
    <path d="M9 12 Q9 3 18 2 L30 2 Q39 3 39 13 L38 40 Q37 48 28 49 L16 49 Q9 48 8.5 41 Z" fill="url(#tkb)" stroke="#07080a" stroke-width="1.2"/>
    <path d="M12 6 Q14 3.5 19 3.2 L29 3.2 Q35 4 36.5 9 Q30 7 22 7.2 Q15 7.4 12 6 Z" fill="url(#tkt)" opacity="0.9"/>
    <path d="M9 17 Q2 19 2.5 27 Q3 34 8.6 35.5 Z" fill="#2c3137" stroke="#07080a" stroke-width="1"/>
    <circle cx="27" cy="15" r="4.2" fill="#121417" stroke="#5d646c" stroke-width="0.9"/><path d="M27 12v6M24 15h6" stroke="#5d646c" stroke-width="1"/>
    <rect x="13" y="12" width="7" height="5" rx="2" fill="#121417" stroke="#5d646c" stroke-width="0.8"/>
    <rect x="15" y="22" width="16" height="4.5" rx="2.2" fill="#121417" stroke="#4d545c" stroke-width="0.8"/>
    <path d="M14 33h20M14 37h20M14 41h19" stroke="#101214" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M14 34h20M14 38h20M14 42h19" stroke="#59606a" stroke-width="0.6" stroke-linecap="round" opacity="0.7"/></svg>`;
  // the plate: brushed metal, engraved ticks, a gate at full dry power, the afterburner range hatched above it;
  // the lever runs in a slot lined with black rubber
  const at = (f) => `bottom: calc(18px + (100% - 36px) * ${f.toFixed(3)})`;   // a point on the lever's travel
  const ticks = Array.from({ length: 11 }, (_, k) => `<i class="tk${k % 5 ? '' : ' big'}" style="${at(k / 10 * MIL)}"></i>`).join('');
  root.innerHTML = `
    <div class="t-throttle"><div class="ab" style="${at(MIL)}"></div>${ticks}<div class="gate" style="${at(MIL)}"></div>
      <div class="slot"></div><div class="grip">${KNOB}</div></div>
    <button class="t-btn t-brake" aria-label="Airbrake">BRAKE</button>
    <button class="t-btn t-gear" aria-label="Landing gear" hidden>GEAR</button>
    <button class="t-btn t-zoom" aria-label="Zoom">${ZOOM}</button>
    <button class="t-fire" aria-label="Fire">${BULLET}</button>`;
  const thr = root.querySelector('.t-throttle'), grip = thr.querySelector('.grip');
  const looks = new Map();   // pointerId -> last x, y

  // aim: any touch that isn't on a control
  addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || e.target.closest('.t-throttle, .t-fire, .t-btn, #arms, #devkit, #devmenu, .lil-gui, #tut, #mend, #pause')) return;
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
    const r = thr.getBoundingClientRect(), pad = 18;
    const f = Math.min(1, Math.max(0, 1 - (y - r.top - pad) / (r.height - 2 * pad)));
    const v = f > MIL + 0.02 ? 1.1 : Math.min(f / MIL, 1);
    grip.style.bottom = `calc(${(f * 100).toFixed(1)}% - ${(f * 2 * pad - pad).toFixed(1)}px)`;
    thr.classList.toggle('ab', v > 1);
    onThrottle(v);
  };
  thr.addEventListener('pointerdown', e => { thrId = e.pointerId; try { thr.setPointerCapture(e.pointerId); } catch { /* some browsers refuse; moves still arrive */ } setThr(e.clientY); e.preventDefault(); });
  thr.addEventListener('pointermove', e => { if (e.pointerId === thrId) setThr(e.clientY); });
  thr.addEventListener('pointerup', () => { thrId = null; });
  requestAnimationFrame(() => { const r = thr.getBoundingClientRect(); setThr(r.top + 18 + (1 - MIL) * (r.height - 36)); });   // start at full dry power

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
  root.hidden = false;
  return {
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
