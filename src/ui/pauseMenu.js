import { createSettingsPage } from './settingsPage.js';

// Pause menu: the game blurs behind a slanted panel that slides in from the left (HUD hidden).
// Resume / Restart mission / Settings. In the settings the panel widens over most of the screen (a strip of the
// game is left on the right); the settings page itself (settingsPage.js) is shared with the main menu to come.
export function createPauseMenu({ onResume, onRestart }) {
  const root = document.createElement('div');
  root.id = 'pause';
  root.innerHTML = `
    <div class="panel">
      <div class="page main">
        <button class="item" data-act="resume">RESUME</button>
        <button class="item" data-act="restart">RESTART</button>
        <button class="item" data-act="settings">SETTINGS</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  const panel = root.querySelector('.panel');
  const settingsPage = createSettingsPage({ onBack: () => show('main') });
  panel.appendChild(settingsPage.el);
  function show(page) {
    root.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.classList.contains(page)));
    panel.classList.toggle('wide', page === 'settings');
    if (page === 'settings') settingsPage.sync(); else settingsPage.stop();
  }
  root.querySelector('.page.main').addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'resume') onResume();
    else if (act === 'restart') onRestart?.();
    else if (act === 'settings') show('settings');
  });
  show('main');
  return {
    open() { show('main'); document.body.classList.add('paused'); },
    close() { settingsPage.stop(); document.body.classList.remove('paused'); },
    get isOpen() { return document.body.classList.contains('paused'); },
  };
}
