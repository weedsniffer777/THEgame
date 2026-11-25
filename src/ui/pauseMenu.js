import { createSettingsPage } from './settingsPage.js';

// menu icons (24-unit grid, white; drawn for this game; the exit door's arrow points out to the left)
const ICON = {
  resume: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.6 7.6 L16.8 12 L9.6 16.4 Z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
  restart: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12 A7.5 7.5 0 0 1 15.4 5.32 M19.5 12 A7.5 7.5 0 0 1 8.6 18.68" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M18.9 7.3 L16.68 2.4 L13.5 7.95 Z M5.1 16.7 L7.32 21.6 L10.5 16.05 Z" fill="currentColor" stroke="currentColor" stroke-width="0.8" stroke-linejoin="round"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.10 4.33 L10.34 1.53 L13.66 1.53 L13.90 4.33 L16.07 5.23 L18.23 3.42 L20.58 5.77 L18.77 7.93 L19.67 10.10 L22.47 10.34 L22.47 13.66 L19.67 13.90 L18.77 16.07 L20.58 18.23 L18.23 20.58 L16.07 18.77 L13.90 19.67 L13.66 22.47 L10.34 22.47 L10.10 19.67 L7.93 18.77 L5.77 20.58 L3.42 18.23 L5.23 16.07 L4.33 13.90 L1.53 13.66 L1.53 10.34 L4.33 10.10 L5.23 7.93 L3.42 5.77 L5.77 3.42 L7.93 5.23 Z M15.3 12 A3.3 3.3 0 1 0 8.7 12 A3.3 3.3 0 1 0 15.3 12 Z" fill="currentColor" fill-rule="evenodd"/></svg>`,
  exit: `<svg viewBox="0 0 24 24" aria-hidden="true"><g transform="matrix(-1 0 0 1 24 0)"><path d="M13.5 7.5 V3.5 H4 V20.5 H13.5 V16.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><path d="M4 3.5 L9.8 5.6 V22.4 L4 20.5 Z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/><path d="M11 12 H18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M22.2 12 L17.2 8.2 V15.8 Z" fill="currentColor" stroke="currentColor" stroke-width="0.8" stroke-linejoin="round"/></g></svg>`,
};

// Pause menu: the game blurs behind a slanted panel that slides in from the left (HUD hidden).
// Resume / Restart mission / Settings / Back to menu (the start screen for now), each with its icon on the left.
// In the settings the panel widens over most of the screen (a strip of the game is left on the right); the settings page itself (settingsPage.js) is shared with the main menu to come.
export function createPauseMenu({ onResume, onRestart, onMenu }) {
  const root = document.createElement('div');
  root.id = 'pause';
  root.innerHTML = `
    <div class="panel">
      <div class="page main">
        <button class="item" data-act="resume"><i class="ico">${ICON.resume}</i>RESUME</button>
        <button class="item" data-act="restart"><i class="ico">${ICON.restart}</i>RESTART</button>
        <button class="item" data-act="settings"><i class="ico">${ICON.settings}</i>SETTINGS</button>
        <button class="item" data-act="menu"><i class="ico">${ICON.exit}</i>BACK TO MENU</button>
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
    else if (act === 'menu') onMenu?.();
  });
  show('main');
  return {
    open() { show('main'); document.body.classList.add('paused'); },
    close() { settingsPage.stop(); document.body.classList.remove('paused'); },
    get isOpen() { return document.body.classList.contains('paused'); },
  };
}
