import { settings, setSetting } from '../settings.js';

// Pause menu: the game blurs behind a slanted panel that slides in from the left (HUD hidden).
// Resume / Settings; settings has four tabs (Controls, UI, Graphics, Audio), only UI has options so far: Units, Friendly colour.
export function createPauseMenu({ onResume }) {
  const root = document.createElement('div');
  root.id = 'pause';
  root.innerHTML = `
    <div class="panel">
      <div class="page main">
        <button class="item" data-act="resume">RESUME</button>
        <button class="item" data-act="settings">SETTINGS</button>
      </div>
      <div class="page settings">
        <div class="tabs">
          <button data-tab="controls">CONTROLS</button><button data-tab="ui" class="on">UI</button><button data-tab="graphics">GRAPHICS</button><button data-tab="audio">AUDIO</button>
        </div>
        <div class="tab" data-tab="controls"></div>
        <div class="tab on" data-tab="ui">
          <div class="row"><span>UNITS</span><span class="seg" data-set="units"><button data-v="imperial">IMPERIAL</button><button data-v="metric">METRIC</button></span></div>
          <div class="row"><span>FRIENDLY</span><span class="seg" data-set="friendColor"><button data-v="blue">BLUE</button><button data-v="green">GREEN</button></span></div>
        </div>
        <div class="tab" data-tab="graphics"></div>
        <div class="tab" data-tab="audio"></div>
        <button class="item back" data-act="back">BACK</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  const show = (page) => root.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.classList.contains(page)));
  const syncSeg = () => root.querySelectorAll('.seg').forEach(s => s.querySelectorAll('button').forEach(b => b.classList.toggle('on', settings[s.dataset.set] === b.dataset.v)));
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'resume') onResume();
    else if (b.dataset.act === 'settings') show('settings');
    else if (b.dataset.act === 'back') show('main');
    else if (b.dataset.tab) {
      root.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x.dataset.tab === b.dataset.tab));
    } else if (b.dataset.v) { setSetting(b.closest('.seg').dataset.set, b.dataset.v); syncSeg(); }
  });
  show('main'); syncSeg();
  return {
    open() { show('main'); syncSeg(); document.body.classList.add('paused'); },
    close() { document.body.classList.remove('paused'); },
    get isOpen() { return document.body.classList.contains('paused'); },
  };
}
