// Player settings (the pause menu edits them; kept in this browser's storage when it is available).
import { save, writeSave } from './save.js';
export const settings = { units: 'imperial', friendColor: 'blue' };   // units: 'imperial' (kts, ft, nm) or 'metric' (km/h, m, km); friendColor: our missiles etc. in 'blue' (default) or 'green'
Object.assign(settings, save.settings || {});      // (kept in the one save file)
const listeners = [];
export function setSetting(k, v) {
  settings[k] = v;
  save.settings = { ...settings }; writeSave();
  listeners.forEach(f => f(k, v));
  applyFriendly();
}
// the colour for our own things on the HUD and map (missiles); also as the CSS variable --friend
export const FRIENDLY = { green: '#52e47c', blue: '#5ca8ff' };
// a brighter version for the map (drawn with a soft glow)
export const FRIENDLY_MAP = { green: '#8affa8', blue: '#8cc6ff' };
export const friendMapColor = () => FRIENDLY_MAP[settings.friendColor] || FRIENDLY_MAP.blue;
export const friendColor = () => FRIENDLY[settings.friendColor] || FRIENDLY.blue;
function applyFriendly() { document.documentElement.style.setProperty('--friend', friendColor()); }
applyFriendly();
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
