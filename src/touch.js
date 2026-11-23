// Touch controls (phones, tablets). Flight controls on the left, weapons on the right; icons only, no text.
//  - drag anywhere else to move the aim, like the mouse;
//  - left: a throttle lever in a slotted gate (stays where you leave it; a gate at full dry power, the afterburner
//    beyond it), the airbrake button beside it (hold), the landing-gear button above it (only shown when slow or low);
//  - right: fire (by the thumb), target zoom just above it (hold); tapping a weapon in the weapon panel selects it.
export const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

const MIL = 0.84;   // where the full-dry-power gate sits on the lever's travel (above it: afterburner)
// icons
const BRAKE = `<svg viewBox="0 0 24 24"><path d="M2 12h20" stroke-width="2"/><path d="M9 12 L16 5.5 M9 12 L16 18.5" stroke-width="2.6" stroke-linecap="round"/></svg>`;   // (side view: two panels opened into the airflow)
const GEAR = `<svg viewBox="0 0 24 24"><path d="M12 3v9" stroke-width="2.4" stroke-linecap="round"/><path d="M8 4h8" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16.5" r="4.5" stroke-width="2.2"/><circle cx="12" cy="16.5" r="1.2" fill="#fff" stroke="none"/></svg>`;
const ZOOM = `<svg viewBox="0 0 24 24"><path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.2" fill="#fff" stroke="none"/></svg>`;
const FIRE = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><path d="M12 1v5M12 18v5M1 12h5M18 12h5" stroke-width="2.4" stroke-linecap="round"/></svg>`;

export function createTouch(root, { onLook, onThrottle, onFire, onAirbrake, onGear, onZoom, sensitivity = 1.6 }) {
  // the throttle: a gate with tick marks, the lit slot below the lever, the afterburner range hatched above the gate
  const at = (f) => `bottom: calc(14px + (100% - 28px) * ${f.toFixed(3)})`;   // a point on the lever's travel (14 px of end play)
  const ticks = Array.from({ length: 11 }, (_, k) => `<i class="tk${k % 5 ? '' : ' big'}" style="${at(k / 10 * MIL)}"></i>`).join('');
  root.innerHTML = `
    <div class="t-throttle"><div class="ab" style="${at(MIL)}"></div>${ticks}<div class="gate" style="${at(MIL)}"></div>
      <div class="slot"><s></s></div>
      <div class="grip"><svg viewBox="0 0 34 26"><rect x="1" y="1" width="32" height="24" rx="6"/><path d="M7 9h20M7 13h20M7 17h20"/></svg></div></div>
    <button class="t-btn t-brake" aria-label="Airbrake">${BRAKE}</button>
    <button class="t-btn t-gear" aria-label="Landing gear" hidden>${GEAR}</button>
    <button class="t-btn t-zoom" aria-label="Zoom">${ZOOM}</button>
    <button class="t-fire" aria-label="Fire">${FIRE}</button>`;
  const thr = root.querySelector('.t-throttle'), grip = thr.querySelector('.grip'), lit = thr.querySelector('.slot s');
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
    const r = thr.getBoundingClientRect(), pad = 14;
    const f = Math.min(1, Math.max(0, 1 - (y - r.top - pad) / (r.height - 2 * pad)));
    const v = f > MIL + 0.02 ? 1.1 : Math.min(f / MIL, 1);
    grip.style.bottom = `calc(${(f * 100).toFixed(1)}% - ${(f * 2 * pad - pad).toFixed(1)}px)`;
    lit.style.height = `${(f * 100).toFixed(1)}%`;
    thr.classList.toggle('ab', v > 1);
    onThrottle(v);
  };
  thr.addEventListener('pointerdown', e => { thrId = e.pointerId; try { thr.setPointerCapture(e.pointerId); } catch { /* some browsers refuse; moves still arrive */ } setThr(e.clientY); e.preventDefault(); });
  thr.addEventListener('pointermove', e => { if (e.pointerId === thrId) setThr(e.clientY); });
  thr.addEventListener('pointerup', () => { thrId = null; });
  requestAnimationFrame(() => { const r = thr.getBoundingClientRect(); setThr(r.top + 14 + (1 - MIL) * (r.height - 28)); });   // start at full dry power

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
    // the gear button: shown only when it makes sense (slow or low, or the gear is already down); lit while down
    setGear(show, down) { if (gear.hidden === show) gear.hidden = !show; gear.classList.toggle('down', !!down); },
  };
}
