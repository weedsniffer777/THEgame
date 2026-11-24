// Touch layout: where the touch controls sit (throttle, airbrake, gear, zoom, fire, the weapon panel). Each one the
// player has moved is kept in the save as its centre, as a fraction of the screen (so it holds across sizes and
// orientations); the rest stay where the stylesheet puts them.
// The editor (Settings > Controls > EDIT LAYOUT) is full screen: a picture of the game behind the real controls,
// drag any of them anywhere; RESET and DONE at the top.
import { save, writeSave } from '../save.js';

const ITEMS = [
  { id: 'throttle', sel: '.t-throttle' }, { id: 'brake', sel: '.t-brake' }, { id: 'gear', sel: '.t-gear' },
  { id: 'zoom', sel: '.t-zoom' }, { id: 'fire', sel: '.t-fire' }, { id: 'arms', sel: '#arms' }, { id: 'pause', sel: '.t-pause' },
];
const SEL = ITEMS.map(i => i.sel).join(', ');
export const LAYOUT_PICTURE = 'ui/touch-layout.jpg';   // (a phone-sized shot of the game with these controls left out)

function place(el, p) {
  if (!el) return;
  if (!p) { for (const k of ['left', 'top', 'right', 'bottom', 'transform']) el.style[k] = ''; return; }
  el.style.left = `${(p[0] * 100).toFixed(3)}%`; el.style.top = `${(p[1] * 100).toFixed(3)}%`;
  el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.transform = 'translate(-50%, -50%)';
}
export function applyLayout() {
  const L = save.touchLayout || {};
  for (const it of ITEMS) place(document.querySelector(it.sel), L[it.id]);
}
export function resetLayout() { delete save.touchLayout; writeSave(); applyLayout(); }

let ed = null;
export function openLayoutEditor() {
  if (ed) return;
  applyLayout();
  ed = document.createElement('div');
  ed.id = 'layed';
  ed.style.backgroundImage = `url(${LAYOUT_PICTURE})`;
  ed.innerHTML = `<div class="bar"><button data-act="reset">RESET</button><button data-act="done">DONE</button></div>`;
  document.body.appendChild(ed);
  document.body.classList.add('layout-edit');
  let drag = null;
  const down = (e) => {
    if (e.target.closest('#layed .bar')) return;
    const el = e.target.closest(SEL);
    e.preventDefault(); e.stopImmediatePropagation();          // (the controls themselves do nothing while editing)
    if (!el || drag) return;
    const r = el.getBoundingClientRect();
    drag = { el, id: ITEMS.find(i => el.matches(i.sel)).id, pid: e.pointerId, dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2), w: r.width, h: r.height };
    el.classList.add('dragging');
  };
  const move = (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    e.preventDefault(); e.stopImmediatePropagation();
    // kept whole on the screen
    const x = Math.min(Math.max(e.clientX - drag.dx, drag.w / 2 + 4), innerWidth - drag.w / 2 - 4);
    const y = Math.min(Math.max(e.clientY - drag.dy, drag.h / 2 + 4), innerHeight - drag.h / 2 - 4);
    drag.p = [x / innerWidth, y / innerHeight];
    place(drag.el, drag.p);
  };
  const up = (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    e.stopImmediatePropagation();
    drag.el.classList.remove('dragging');
    if (drag.p) { save.touchLayout = { ...(save.touchLayout || {}), [drag.id]: drag.p }; writeSave(); }
    drag = null;
  };
  addEventListener('pointerdown', down, true); addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);
  ed.querySelector('.bar').addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'reset') resetLayout();
    if (act === 'done') {
      removeEventListener('pointerdown', down, true); removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true); removeEventListener('pointercancel', up, true);
      document.body.classList.remove('layout-edit'); ed.remove(); ed = null;
    }
  });
}
