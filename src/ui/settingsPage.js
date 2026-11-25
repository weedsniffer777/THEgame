// The settings page: tabs (CONTROLS, UI, GRAPHICS, AUDIO). Built once and placed by whoever shows it (the pause menu
// now, the main menu later), so it carries no knowledge of the game around it.
//  - CONTROLS on PC: every action with two key slots; click a slot, then press a key or a mouse button (Esc cancels,
//    Backspace clears it). A key already in use moves over (the other action gets this slot's old key). RESET.
//  - CONTROLS on touch screens: the button layout, edited full screen over a picture of the game (touchLayout.js).
import { settings, setSetting } from '../settings.js';
import { ACTIONS, bindings, bind, resetBindings, onBindings, keyLabel, mouseIcon } from '../controls.js';
import { ICONS } from './tutorial.js';
import { isTouch } from '../touch.js';
import { openLayoutEditor, resetLayout, LAYOUT_PICTURE } from './touchLayout.js';

const showKeys = !isTouch || matchMedia('(any-pointer: fine)').matches;   // (a touch screen with a mouse too: both)
const ARROW = `<svg viewBox="0 0 24 14" width="24" height="14"><path d="M3 3l9 8 9-8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function createSettingsPage({ onBack }) {
  const el = document.createElement('div');
  el.className = 'page settings';
  const groups = [...new Set(ACTIONS.map(a => a.group))];
  el.innerHTML = `
    <div class="tabs">
      <button data-tab="controls" class="on">CONTROLS</button><button data-tab="ui">UI</button><button data-tab="graphics">GRAPHICS</button><button data-tab="audio">AUDIO</button>
    </div>
    <div class="tabwrap">
    <div class="sbar"><i></i></div>
    <div class="tabbody">
    <div class="tab on" data-tab="controls">
      <div class="row slide"><span>${showKeys ? 'MOUSE SENSITIVITY' : 'TOUCH SENSITIVITY'}</span><span class="rng"><input type="range" min="-1" max="1" step="0.01" data-set="mouseSens" aria-label="Sensitivity"><b class="val"></b></span></div>
      ${isTouch ? `<div class="sub"><span>TOUCH LAYOUT</span><button class="small" data-act="reset-layout">RESET</button></div>
        <button class="layout" data-act="edit-layout"><span>EDIT LAYOUT</span></button>` : ''}
      ${showKeys ? `<div class="sub"><span>KEYS</span><button class="small" data-act="reset-keys">RESET</button></div>
        ${groups.map(g => `<div class="grp">${g}</div><div class="binds">${ACTIONS.filter(a => a.group === g).map(a => `
          <div class="bind" data-id="${a.id}"><span class="name">${a.name}</span><button class="slot" data-k="0"></button><button class="slot" data-k="1"></button></div>`).join('')}</div>`).join('')}` : ''}
    </div>
    <div class="tab" data-tab="ui">
      <div class="row"><span>UNITS</span><span class="seg" data-set="units"><button data-v="imperial">IMPERIAL</button><button data-v="metric">METRIC</button></span></div>
      <div class="row"><span>HUD COLOR</span><span class="seg" data-set="hudColor"><button data-v="default">DEFAULT</button><button data-v="green">GREEN</button></span></div>
    </div>
    <div class="tab" data-tab="graphics">
      <div class="row"><span>SCREEN SHAKE</span><span class="seg" data-set="shake"><button data-v="default">DEFAULT</button><button data-v="less">LESS</button><button data-v="off">OFF</button></span></div>
    </div>
    <div class="tab" data-tab="audio"></div>
    </div>
    <button class="more up" data-act="top" aria-label="Scroll up">${ARROW}</button>
    <button class="more down" data-act="bottom" aria-label="Scroll down">${ARROW}</button>
    </div>
    <button class="item back" data-act="back">BACK</button>`;

  // sensitivity: a log scale, x0.25 at the left end, x1 in the middle, x4 at the right
  const rng = el.querySelector('.rng input'), rngVal = el.querySelector('.rng .val');
  const syncRng = () => { const v = settings.mouseSens || 1; rng.value = String(Math.log(v) / Math.log(4)); rngVal.textContent = v.toFixed(2); paintRng(); };
  const paintRng = () => rng.style.setProperty('--f', `${((+rng.value + 1) / 2 * 100).toFixed(1)}%`);
  rng.addEventListener('input', () => { const v = Math.pow(4, +rng.value); rngVal.textContent = v.toFixed(2); paintRng(); setSetting('mouseSens', Math.round(v * 100) / 100); });

  // the scrolling: our own bar on the left (drag it, or click the track), and a dark fade with an arrow at whichever
  // edge has more beyond it (the arrow jumps to that end)
  const wrap = el.querySelector('.tabwrap'), body = el.querySelector('.tabbody'), bar = el.querySelector('.sbar'), thumb = bar.firstChild;
  function syncScroll() {
    const H = body.scrollHeight, h = body.clientHeight, top = body.scrollTop, can = H - h > 2;
    wrap.classList.toggle('can-up', can && top > 2); wrap.classList.toggle('can-down', can && top < H - h - 2);
    bar.hidden = !can; if (!can) return;
    const th = Math.max(28, bar.clientHeight * h / H);
    thumb.style.height = `${th.toFixed(0)}px`;
    thumb.style.transform = `translateY(${((bar.clientHeight - th) * top / (H - h)).toFixed(1)}px)`;
  }
  body.addEventListener('scroll', syncScroll, { passive: true });
  addEventListener('resize', syncScroll);
  let drag = null;
  thumb.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); drag = { y: e.clientY, top: body.scrollTop }; thumb.setPointerCapture(e.pointerId); thumb.classList.add('drag'); });
  thumb.addEventListener('pointermove', (e) => { if (!drag) return; const k = (body.scrollHeight - body.clientHeight) / Math.max(1, bar.clientHeight - thumb.offsetHeight); body.scrollTop = drag.top + (e.clientY - drag.y) * k; });
  const endDrag = () => { drag = null; thumb.classList.remove('drag'); };
  thumb.addEventListener('pointerup', endDrag); thumb.addEventListener('pointercancel', endDrag);
  bar.addEventListener('pointerdown', (e) => { if (e.target !== bar) return; const r = thumb.getBoundingClientRect(); body.scrollBy({ top: (e.clientY < r.top ? -1 : 1) * body.clientHeight * 0.85, behavior: 'smooth' }); });

  const syncSeg = () => el.querySelectorAll('.seg').forEach(s => s.querySelectorAll('button').forEach(b => b.classList.toggle('on', settings[s.dataset.set] === b.dataset.v)));
  // a slot shows its key (the player's own layout), a picture of the mouse for mouse buttons, or a dash
  const slotHtml = (code) => { const i = mouseIcon(code); return i ? ICONS[i] : code ? `<b>${keyLabel(code)}</b>` : '<b class="none">–</b>'; };
  const syncKeys = () => el.querySelectorAll('.bind').forEach(r => r.querySelectorAll('.slot').forEach(s => {
    if (s === listening?.slot) return;
    const code = bindings[r.dataset.id][+s.dataset.k];
    if (s._code !== code) { s._code = code; s.innerHTML = slotHtml(code); }
  }));
  onBindings(syncKeys);

  // binding: the next key or mouse button pressed anywhere goes to the slot (nothing else in the game sees it)
  let listening = null;
  function listen(slot) {
    stop();
    listening = { slot, id: slot.closest('.bind').dataset.id, k: +slot.dataset.k };
    slot.classList.add('wait'); slot.innerHTML = '<b>PRESS A KEY</b>';
    addEventListener('keydown', onKey, true); addEventListener('mousedown', onMouse, true);
  }
  function stop() {
    if (!listening) return;
    const s = listening.slot; listening = null;
    s.classList.remove('wait'); s._code = undefined;
    removeEventListener('keydown', onKey, true); removeEventListener('mousedown', onMouse, true);
    syncKeys();
  }
  function take(code) {
    const { id, k } = listening, before = ACTIONS.map(a => bindings[a.id].join());
    stop();
    bind(id, k, code);
    // show where a key moved from
    ACTIONS.forEach((a, i) => { if (a.id !== id && bindings[a.id].join() !== before[i]) flash(a.id); });
  }
  const flash = (id) => { const r = el.querySelector(`.bind[data-id="${id}"]`); if (!r) return; r.classList.remove('moved'); void r.offsetWidth; r.classList.add('moved'); };
  function onKey(e) {
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat) return;
    if (e.code === 'Escape') stop();
    else if (e.code === 'Backspace' || e.code === 'Delete') take(null);
    else take(e.code);
  }
  // (a mouse binding: the click that follows mustn't also press whatever is under the pointer, or start another)
  let eatClick = false;
  function onMouse(e) { e.preventDefault(); e.stopImmediatePropagation(); eatClick = true; take('Mouse' + e.button); }
  addEventListener('mousedown', () => { if (!listening) eatClick = false; }, true);
  addEventListener('click', (e) => { if (eatClick) { eatClick = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);

  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.classList.contains('slot')) { listen(b); return; }
    stop();
    const act = b.dataset.act;
    if (act === 'top') { body.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (act === 'bottom') { body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' }); return; }
    if (act === 'back') onBack?.();
    else if (act === 'reset-keys') resetBindings();
    else if (act === 'reset-layout') resetLayout();
    else if (act === 'edit-layout') openLayoutEditor();
    else if (b.dataset.tab) { el.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x.dataset.tab === b.dataset.tab)); body.scrollTop = 0; syncScroll(); }
    else if (b.dataset.v) { setSetting(b.closest('.seg').dataset.set, b.dataset.v); syncSeg(); }
  });
  const pic = el.querySelector('.layout'); if (pic) pic.style.backgroundImage = `url(${LAYOUT_PICTURE})`;
  syncSeg(); syncKeys(); syncRng();
  return { el, sync() { stop(); syncSeg(); syncKeys(); syncRng(); requestAnimationFrame(syncScroll); }, stop };
}
