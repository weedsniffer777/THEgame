// Touch controls (phones, tablets): drag anywhere to move the aim, like the mouse; throttle slider on the left;
// fire button by the right thumb; tapping a weapon in the weapon panel selects it. Icons only, no text.
export const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

export function createTouch(root, { onLook, onThrottle, onFire, onSwitch, sensitivity = 1.6 }) {
  root.innerHTML = `
    <div class="t-throttle"><i></i><b></b></div>
    <button class="t-fire" aria-label="Fire"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><path d="M12 1v5M12 18v5M1 12h5M18 12h5" stroke-width="2.4" stroke-linecap="round"/></svg></button>`;
  const thr = root.querySelector('.t-throttle'), thrFill = thr.querySelector('i');
  const looks = new Map();   // pointerId -> last x, y

  // aim: any touch that isn't on a control
  addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || e.target.closest('.t-throttle, .t-fire, #arms, #devkit, #devmenu, .lil-gui, #tut, #mend, #pause')) return;
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
  addEventListener('contextmenu', e => e.preventDefault());   // no long-press menu

  // throttle: hold and slide; the top 12% is afterburner
  let thrId = null;
  const setThr = (y) => {
    const r = thr.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, 1 - (y - r.top) / r.height));
    const v = f > 0.88 ? 1.1 : f / 0.88;
    thrFill.style.height = `${f * 100}%`;
    thr.classList.toggle('ab', v > 1);
    onThrottle(v);
  };
  thr.addEventListener('pointerdown', e => { thrId = e.pointerId; try { thr.setPointerCapture(e.pointerId); } catch { /* some browsers refuse; moves still arrive */ } setThr(e.clientY); e.preventDefault(); });
  thr.addEventListener('pointermove', e => { if (e.pointerId === thrId) setThr(e.clientY); });
  thr.addEventListener('pointerup', () => { thrId = null; });
  root.hidden = false;
  requestAnimationFrame(() => { const r = thr.getBoundingClientRect(); setThr(r.top + 0.12 * r.height + 1); });   // start at full dry power

  const fire = root.querySelector('.t-fire');
  fire.addEventListener('pointerdown', e => { e.preventDefault(); fire.classList.add('on'); onFire(true); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) fire.addEventListener(ev, () => { fire.classList.remove('on'); onFire(false); });
  root.hidden = false;
  return { setLocked(on) { fire.classList.toggle('locked', on); } };
}
