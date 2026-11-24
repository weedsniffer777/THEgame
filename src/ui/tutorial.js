// Tutorial overlay and the mission-complete card.
// The tutorial never waits for a click. It shows a short line high in the centre with big keycaps under it; each
// keycap fills green while its key is held and pulses once the whole row is full, then the tutorial moves on by
// itself. Parts of the screen can be spotlit (several at once: the rest darkens), and a short hold() freezes the game
// for a moment to show something (a new enemy on the map and in the air), then carries on on its own.
const MOUSE = `<svg viewBox="0 0 24 34" width="22" height="31" aria-hidden="true"><rect x="2" y="2" width="20" height="30" rx="10" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 2v11" stroke="currentColor" stroke-width="2"/></svg>`;
const LMB = `<svg viewBox="0 0 24 34" width="22" height="31" aria-hidden="true"><path d="M12 2 A10 10 0 0 0 2 12 V13 H12 Z" fill="currentColor"/><rect x="2" y="2" width="20" height="30" rx="10" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 2v11M2 13h20" stroke="currentColor" stroke-width="2"/></svg>`;
const RMB = `<svg viewBox="0 0 24 34" width="22" height="31" aria-hidden="true"><path d="M12 2 A10 10 0 0 1 22 12 V13 H12 Z" fill="currentColor"/><rect x="2" y="2" width="20" height="30" rx="10" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 2v11M2 13h20" stroke="currentColor" stroke-width="2"/></svg>`;
const DRAG = `<svg viewBox="0 0 34 34" width="30" height="30" aria-hidden="true"><circle cx="17" cy="17" r="5" fill="currentColor"/><path d="M17 3v6M17 25v6M3 17h6M25 17h6M17 3l-3 3M17 3l3 3M17 31l-3-3M17 31l3-3M3 17l3-3M3 17l3 3M31 17l-3-3M31 17l-3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const TAP = `<svg viewBox="0 0 34 34" width="30" height="30" aria-hidden="true"><circle cx="17" cy="17" r="6" fill="currentColor"/><circle cx="17" cy="17" r="12" fill="none" stroke="currentColor" stroke-width="2" opacity="0.6"/></svg>`;
const ICONS = { mouse: MOUSE, lmb: LMB, rmb: RMB, drag: DRAG, tap: TAP };
const SVGNS = 'http://www.w3.org/2000/svg';

export function createOverlay() {
  const root = document.createElement('div');
  root.id = 'tut';
  root.innerHTML = `<svg class="dim"><defs><mask id="tutmask" maskUnits="userSpaceOnUse"><rect class="all" fill="#fff"/><g class="holes"></g></mask></defs>
    <rect class="shade all" mask="url(#tutmask)"/><g class="rings"></g></svg><div class="fx"></div>
    <div class="card"><div class="txt"></div><div class="keys"></div></div>`;
  document.body.appendChild(root);
  const svg = root.querySelector('svg'), holes = root.querySelector('.holes'), rings = root.querySelector('.rings');
  const fx = root.querySelector('.fx');
  const shade = root.querySelector('.shade'), cardEl = root.querySelector('.card'), txt = root.querySelector('.txt'), keysEl = root.querySelector('.keys');
  const end = document.createElement('div');
  end.id = 'mend';
  document.body.appendChild(end);

  let spots = [], dim = 0, holdT = 0, onHold = null, caps = [], size = '', arrows = [], chevs = [];

  // a spot: { sel, pad, round } (an element), or { at: () => [x, y, r] | null } (a moving point, a circle)
  function shapeOf(s) {
    if (s.at) { const c = s.at(); return !c ? null : c.length === 4 ? { x: c[0], y: c[1], w: c[2], h: c[3] } : { x: c[0], y: c[1], r: c[2] }; }
    const el = typeof s.sel === 'string' ? document.querySelector(s.sel) : s.sel;
    if (!el || el.hidden || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return null;
    const pad = s.pad ?? 8;
    if (s.round) return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: Math.max(r.width, r.height) / 2 + pad };
    return { x: r.left - pad, y: r.top - pad, w: r.width + 2 * pad, h: r.height + 2 * pad };
  }
  // one hole in the mask and one outline per spot; the elements are reused frame to frame
  function drawSpots() {
    const shapes = spots.map(shapeOf).filter(Boolean);
    while (holes.children.length > shapes.length) { holes.lastChild.remove(); rings.lastChild.remove(); }
    shapes.forEach((s, k) => {
      const tag = s.r != null ? 'circle' : 'rect';
      let h = holes.children[k], o = rings.children[k];
      if (!h || h.tagName !== tag) {
        const nh = document.createElementNS(SVGNS, tag), no = document.createElementNS(SVGNS, tag);
        nh.setAttribute('fill', '#000');
        if (h) { h.replaceWith(nh); o.replaceWith(no); } else { holes.appendChild(nh); rings.appendChild(no); }
        h = nh; o = no;
      }
      // (only touched when it moved: every change re-renders the full-screen mask)
      const key = tag === 'circle' ? `${s.x.toFixed(0)},${s.y.toFixed(0)},${s.r.toFixed(0)}` : `${s.x.toFixed(0)},${s.y.toFixed(0)},${s.w.toFixed(0)},${s.h.toFixed(0)}`;
      if (h._key === key) return;
      h._key = key;
      for (const e of [h, o]) {
        if (tag === 'circle') { e.setAttribute('cx', s.x.toFixed(0)); e.setAttribute('cy', s.y.toFixed(0)); e.setAttribute('r', s.r.toFixed(0)); }
        else { e.setAttribute('x', s.x.toFixed(0)); e.setAttribute('y', s.y.toFixed(0)); e.setAttribute('width', s.w.toFixed(0)); e.setAttribute('height', s.h.toFixed(0)); e.setAttribute('rx', 6); }
      }
    });
    const op = String(dim);
    if (shade.style.opacity !== op) shade.style.opacity = op;
  }
  const show = () => root.classList.toggle('on', !!(spots.length || txt.textContent || caps.length || arrows.length || chevs.length));
  // arrows pointing at things (touch: the control to use) and chevrons streaming one way (which way to drag); placed
  // every frame, as the spots are
  function drawFx() {
    for (const a of arrows) {
      const s = shapeOf(a.s);
      if (!s) { a.el.style.display = 'none'; continue; }
      a.el.style.display = '';
      const cx = s.r != null ? s.x : s.x + s.w / 2, cy = s.r != null ? s.y : s.y + s.h / 2;
      // which side it comes from: a.s.from (deg: 0 right, 90 below, 180 left, 270 above), else the screen's centre
      const ang = a.s.from != null ? a.s.from * Math.PI / 180 : Math.atan2(innerHeight / 2 - cy, innerWidth / 2 - cx);
      const ux = Math.cos(ang), uy = Math.sin(ang);
      const edge = s.r != null ? s.r : Math.min(Math.abs(ux) > 1e-3 ? s.w / 2 / Math.abs(ux) : 1e9, Math.abs(uy) > 1e-3 ? s.h / 2 / Math.abs(uy) : 1e9);
      const tf = `translate(${(cx + ux * (edge + 8)).toFixed(0)}px, ${(cy + uy * (edge + 8)).toFixed(0)}px) rotate(${(ang * 180 / Math.PI + 180).toFixed(0)}deg)`;
      if (a.el._tf !== tf) { a.el.style.transform = tf; a.el._tf = tf; }
    }
    for (const c of chevs) {
      const p = c.s.at();
      if (!p) { c.el.style.display = 'none'; continue; }
      c.el.style.display = '';
      const tf = `translate(${p[0].toFixed(0)}px, ${p[1].toFixed(0)}px) rotate(${c.s.ang}deg)`;
      if (c.el._tf !== tf) { c.el.style.transform = tf; c.el._tf = tf; }
      const len = Math.max(20, c.s.len()).toFixed(0) + 'px';
      if (c.el._len !== len) { c.el.style.setProperty('--len', len); c.el._len = len; }
    }
  }
  const ARROW = `<svg viewBox="0 0 46 30" width="46" height="30"><path d="M0 10h26V2l20 13-20 13v-8H0z"/></svg>`;
  const CHEV = `<svg viewBox="0 0 16 24" width="16" height="24"><path d="M3 3l10 9-10 9"/></svg>`;

  return {
    // the game stands still while true (a hold, or the end card)
    get open() { return holdT > 0; },                     // (the end card doesn't stop the game: the ending shot plays on behind it)
    get endOpen() { return end.classList.contains('on'); },
    get holdLeft() { return holdT; },
    // a short line high in the centre ('' for none)
    say(text) { txt.textContent = text || ''; cardEl.classList.toggle('notxt', !text); show(); },
    // a row of keycaps: { label } or { icon: 'mouse' | 'lmb' | 'drag' | 'tap', wide }; replaces the row
    // ({ br: true } starts a new row, laid out like the keyboard)
    keys(list = []) {
      keysEl.innerHTML = '';
      let row = null, g = 0;
      const newRow = () => { row = document.createElement('div'); row.className = 'krow'; keysEl.appendChild(row); };
      newRow();
      // ({ text } is a few words between keycaps; { group: 'Pitch', keys: [...] } is a labelled set of keycaps that
      // fill together, side by side with the next group in the same row)
      caps = [];
      const cap = (k, parent, gi) => {
        const el = document.createElement('div');
        el.className = 'cap' + (k.wide || (k.label && k.label.length > 1) ? ' wide' : '') + (k.icon ? ' icon' : '') + (k.small ? ' small' : '');
        el.innerHTML = `<i></i><span>${k.icon ? ICONS[k.icon] : ''}</span>`;
        if (!k.icon) el.lastChild.textContent = k.label;
        parent.appendChild(el);
        caps.push({ el, fill: el.firstChild, f: -1, g: gi });
      };
      for (const k of list) {
        if (k.br) { newRow(); continue; }
        if (k.text != null) { const t = document.createElement('span'); t.className = 'ktxt'; t.textContent = k.text; row.appendChild(t); continue; }
        if (k.group) {
          const box = document.createElement('div'); box.className = 'kgrp';
          const lab = document.createElement('div'); lab.className = 'klabel'; lab.textContent = k.group;
          const inner = document.createElement('div'); inner.className = 'krow';
          box.append(lab, inner); row.appendChild(box);
          const gi = g++; k.keys.forEach(c => cap(c, inner, gi));
          continue;
        }
        cap(k, row, g++);
      }
      keysEl.classList.remove('done'); fx.classList.remove('done');
      cardEl.classList.toggle('nokeys', !caps.length);
      show();
    },
    // how full keycap (or group of keycaps) k is (0..1)
    fill(k, f) {
      f = Math.min(Math.max(f, 0), 1);
      for (const c of caps) {
        if (c.g !== k || Math.abs(f - c.f) < 0.005) continue;
        c.f = f; c.fill.style.height = `${(f * 100).toFixed(1)}%`;
        c.el.classList.toggle('full', f >= 1);
      }
      for (const c of chevs) if (c.s.g === k) c.el.classList.toggle('full', f >= 1);
    },
    // arrows: [{ sel, pad, round } | { at }, from?] each pointing at that, bobbing toward it
    point(list = []) {
      for (const a of arrows) a.el.remove();
      arrows = list.map(s => { const el = document.createElement('div'); el.className = 'tarrow'; el.innerHTML = ARROW; fx.appendChild(el); return { s, el }; });
      drawFx(); show();
    },
    // chevrons: [{ at: () => [x, y], ang (deg, 0 = right, 90 = down), len: () => px, g }] three of them streaming from
    // the point along ang (group g: they turn green when fill(g) is full)
    chevrons(list = []) {
      for (const c of chevs) c.el.remove();
      chevs = list.map(s => {
        const el = document.createElement('div'); el.className = 'tchev';
        el.innerHTML = [0, 1, 2].map(k => `<i style="animation-delay:${(-k * 0.4).toFixed(1)}s">${CHEV}</i>`).join('');
        fx.appendChild(el); return { s, el };
      });
      drawFx(); show();
    },
    // the whole row is full: it pulses
    done() { keysEl.classList.add('done'); fx.classList.add('done'); },
    // spotlight these (see shapeOf); dim: how dark the rest of the screen goes (0..1)
    spot(list = [], d = 0.5) { spots = list; dim = list.length ? d : 0; drawSpots(); show(); },
    // freeze the game for a moment, then carry on by itself
    hold(sec, done) { holdT = sec; onHold = done; },
    clear() { this.say(''); this.keys([]); this.spot([]); this.point([]); this.chevrons([]); },
    // every frame, in real time (also while the game is frozen)
    tick(dt) {
      if (holdT > 0 && (holdT -= dt) <= 0) { holdT = 0; const f = onHold; onHold = null; f?.(); }
      if (arrows.length || chevs.length) drawFx();
      if (!spots.length) return;
      if (size !== innerWidth + 'x' + innerHeight) {
        size = innerWidth + 'x' + innerHeight;
        svg.setAttribute('width', innerWidth); svg.setAttribute('height', innerHeight);
        for (const r of root.querySelectorAll('.all')) { r.setAttribute('width', innerWidth); r.setAttribute('height', innerHeight); }
      }
      drawSpots();
    },
    // the end-of-mission card
    showEnd(stats, onReplay) {
      const mm = Math.floor(stats.time / 60), ss = String(Math.floor(stats.time % 60)).padStart(2, '0');
      end.innerHTML = `<div class="box"><div class="h">MISSION COMPLETE</div>
        <div class="row"><span>KILLS</span><b>${stats.kills} / ${stats.total}</b></div>
        <div class="row"><span>TIME</span><b>${mm}:${ss}</b></div>
        <div class="row"><span>ACCURACY</span><b>${Math.round(stats.accuracy * 100)}%</b></div>
        <button class="replay">REPLAY</button></div>`;
      end.classList.add('on');
      end.querySelector('.replay').addEventListener('click', () => { end.classList.remove('on'); onReplay(); });
    },
    // the death screen: just the way back in for now (back to menu and the match's stats come later)
    showDeath(onRetry) {
      end.innerHTML = `<div class="box"><button class="replay">RETRY</button></div>`;
      end.classList.add('on');
      end.querySelector('.replay').addEventListener('click', () => { end.classList.remove('on'); onRetry(); });
    },
    hideEnd() { end.classList.remove('on'); },
  };
}
