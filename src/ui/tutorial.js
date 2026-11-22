// Tutorial cards and the mission-complete card. The tutorial pauses the game, darkens the screen around one
// spotlighted part of the HUD and shows a short instruction; a click (or Enter / Space) continues.
export function createOverlay() {
  const root = document.createElement('div');
  root.id = 'tut';
  root.innerHTML = `<div class="spot"></div><div class="card"><div class="txt"></div><div class="go">CLICK TO CONTINUE</div></div>`;
  document.body.appendChild(root);
  const spot = root.querySelector('.spot'), card = root.querySelector('.card'), txt = root.querySelector('.txt');
  const end = document.createElement('div');
  end.id = 'mend';
  document.body.appendChild(end);
  let onClose = null, armed = false;

  const close = () => { if (!onClose || !armed) return; root.classList.remove('on'); const f = onClose; onClose = null; f(); };
  addEventListener('mouseup', (e) => { if (onClose) { e.preventDefault(); close(); } }, true);
  addEventListener('keyup', (e) => { if (onClose && (e.code === 'Enter' || e.code === 'Space')) close(); }, true);

  return {
    get open() { return !!onClose || end.classList.contains('on'); },
    // target: a CSS selector to spotlight (or null for a plain darkened screen)
    show(text, target, done) {
      txt.innerHTML = text;
      const el = target && document.querySelector(target);
      const r = el?.getBoundingClientRect?.();
      if (r && r.width) {
        const pad = 14;
        Object.assign(spot.style, { display: 'block', left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
        // the card sits next to the spotlight, toward the middle of the screen
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        card.style.left = `${Math.min(Math.max(cx < innerWidth / 2 ? r.right + 30 : r.left - 30 - 340, 16), innerWidth - 356)}px`;
        card.style.top = `${Math.min(Math.max(cy - 50, 16), innerHeight - 140)}px`;
        root.classList.remove('nospot');
      } else {
        spot.style.display = 'none'; root.classList.add('nospot');
        card.style.left = `${innerWidth / 2 - 170}px`; card.style.top = `${innerHeight * 0.3}px`;
      }
      root.classList.add('on');
      onClose = done; armed = false;
      setTimeout(() => { armed = true; }, 350);              // (so the click that triggered nothing can't skip it)
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
    hideEnd() { end.classList.remove('on'); },
  };
}
