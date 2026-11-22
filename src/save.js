// The one save file: everything the game remembers about the player, in this browser's storage (later: the portal's
// cloud save). Versioned so later fields can be migrated.
const KEY = 'thegame.save';
const DEFAULTS = () => ({ v: 1, tutorialDone: false, settings: {} });

export const save = DEFAULTS();
try {
  const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (raw && typeof raw === 'object') Object.assign(save, raw);
  else {
    // first run with this save format: bring over settings saved by older builds
    const old = JSON.parse(localStorage.getItem('thegame.settings') || 'null');
    if (old) save.settings = old;
  }
} catch { /* storage blocked or bad data: defaults */ }

export function writeSave() {
  try { localStorage.setItem(KEY, JSON.stringify(save)); } catch { /* ignore */ }
}

// wipes everything (dev kit: clear all player data)
export function clearSave() {
  try { localStorage.removeItem(KEY); localStorage.removeItem('thegame.settings'); } catch { /* ignore */ }
  for (const k of Object.keys(save)) delete save[k];
  Object.assign(save, DEFAULTS());
}
