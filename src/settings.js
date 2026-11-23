// Player settings (the pause menu edits them; kept in this browser's storage when it is available).
import { save, writeSave } from './save.js';
export const settings = { units: 'imperial', hudColor: 'default', shake: 'default' };   // units: 'imperial' (kts, ft, nm) or 'metric' (km/h, m, km); hudColor: 'default' (white HUD, our missiles blue) or 'green' (the whole HUD green)
Object.assign(settings, save.settings || {});      // (kept in the one save file)
const listeners = [];
export function setSetting(k, v) {
  settings[k] = v;
  save.settings = { ...settings }; writeSave();
  listeners.forEach(f => f(k, v));
  applyHud();
}
// green HUD: a body class the stylesheet keys every HUD colour off (enemy red stays red)
function applyHud() { document.body?.classList.toggle('hud-green', settings.hudColor === 'green'); }
if (document.body) applyHud(); else addEventListener('DOMContentLoaded', applyHud);
export function onSetting(f) { listeners.push(f); }

// unit conversions for display
export const units = {
  speed: (ms) => settings.units === 'metric' ? ms * 3.6 : ms * 1.94384,        // m/s -> km/h | kts
  speedLabel: () => settings.units === 'metric' ? 'KM/H' : 'KTS',
  alt: (m) => settings.units === 'metric' ? m : m * 3.28084,                   // m -> m | ft
  altLabel: () => settings.units === 'metric' ? 'M' : 'FT',
  dist: (m) => settings.units === 'metric' ? m / 1000 : m / 1852,              // m -> km | nm
  distLabel: () => settings.units === 'metric' ? 'KM' : 'NM',
};
