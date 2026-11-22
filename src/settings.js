// Player settings (the pause menu edits them; kept in this browser's storage when it is available).
import { save, writeSave } from './save.js';
export const settings = { units: 'imperial' };   // 'imperial' (kts, ft, nm) or 'metric' (km/h, m, km)
Object.assign(settings, save.settings || {});      // (kept in the one save file)
const listeners = [];
export function setSetting(k, v) {
  settings[k] = v;
  save.settings = { ...settings }; writeSave();
  listeners.forEach(f => f(k, v));
}
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
