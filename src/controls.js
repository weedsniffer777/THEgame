// Key bindings (PC): every action the keyboard or the mouse buttons drive, two slots each, rebindable in
// Settings > Controls and kept in the save file. Codes are KeyboardEvent.code values, or 'Mouse0'..'Mouse4' for mouse
// buttons (0 left, 1 middle, 2 right, 3/4 the side buttons). Left and right Shift / Ctrl / Alt count as one key.
// (Steering with the mouse itself isn't an action: the flying keys are its alternative.)
import { save, writeSave } from './save.js';

export const ACTIONS = [
  { id: 'pitchDown', name: 'PITCH DOWN', group: 'FLIGHT', def: ['KeyW', 'ArrowUp'] },
  { id: 'pitchUp', name: 'PITCH UP', group: 'FLIGHT', def: ['KeyS', 'ArrowDown'] },
  { id: 'rollLeft', name: 'ROLL LEFT', group: 'FLIGHT', def: ['KeyA', 'ArrowLeft'] },
  { id: 'rollRight', name: 'ROLL RIGHT', group: 'FLIGHT', def: ['KeyD', 'ArrowRight'] },
  { id: 'yawLeft', name: 'YAW LEFT', group: 'FLIGHT', def: ['KeyQ', null] },
  { id: 'yawRight', name: 'YAW RIGHT', group: 'FLIGHT', def: ['KeyE', null] },
  { id: 'throttleUp', name: 'THROTTLE UP', group: 'FLIGHT', def: ['Tab', 'KeyX'] },
  { id: 'throttleDown', name: 'THROTTLE DOWN', group: 'FLIGHT', def: ['ShiftLeft', 'KeyZ'] },
  { id: 'airbrake', name: 'AIRBRAKE', group: 'FLIGHT', def: ['KeyB', null] },
  { id: 'gear', name: 'LANDING GEAR', group: 'FLIGHT', def: ['KeyG', null] },
  { id: 'fire', name: 'FIRE', group: 'COMBAT', def: ['Mouse0', 'Space'] },
  { id: 'track', name: 'TRACK ENEMY', group: 'COMBAT', def: ['Mouse2', null] },
  { id: 'guns', name: 'CANNON', group: 'COMBAT', def: ['Digit1', null] },
  { id: 'missiles', name: 'MISSILES', group: 'COMBAT', def: ['Digit2', null] },
  { id: 'rockets', name: 'ROCKETS', group: 'COMBAT', def: ['Digit3', null] },
  { id: 'nextTarget', name: 'NEXT TARGET', group: 'COMBAT', def: ['KeyR', null] },
  { id: 'map', name: 'MAP', group: 'OTHER', def: ['KeyM', null] },
  { id: 'pause', name: 'PAUSE', group: 'OTHER', def: ['KeyP', null] },   // (Esc always pauses too)
];
const BY_ID = Object.fromEntries(ACTIONS.map(a => [a.id, a]));

// the current bindings: defaults with the player's changes over them
export const bindings = {};
function load() {
  const saved = save.controls || {};
  for (const a of ACTIONS) bindings[a.id] = Array.isArray(saved[a.id]) ? [saved[a.id][0] ?? null, saved[a.id][1] ?? null] : [...a.def];
}
load();
const listeners = [];
export function onBindings(f) { listeners.push(f); }
function changed() {
  save.controls = Object.fromEntries(ACTIONS.map(a => [a.id, bindings[a.id]]));
  writeSave();
  listeners.forEach(f => f());
}
// put `code` in slot k of action id; whoever had it gets this slot's old key instead (a swap, so nothing is lost)
export function bind(id, k, code) {
  const old = bindings[id][k];
  if (code) for (const a of ACTIONS) for (let j = 0; j < 2; j++) {
    if ((a.id !== id || j !== k) && same(bindings[a.id][j], code)) bindings[a.id][j] = old;
  }
  bindings[id][k] = code;
  changed();
}
export function resetBindings() { delete save.controls; load(); changed(); }

// left / right modifier keys are one key
const norm = (c) => c && c.replace(/(Shift|Control|Alt|Meta)Right$/, '$1Left');
const same = (a, b) => !!a && norm(a) === norm(b);
export const codeOfMouse = (button) => 'Mouse' + button;

// what's held down now (keyboard codes and mouse buttons, normalised)
const down = new Set();
export function press(code) { down.add(norm(code)); }
export function release(code) { down.delete(norm(code)); }
export function releaseAll() { down.clear(); }
export const held = (id) => bindings[id].some(c => c && down.has(norm(c)));
// the actions a key or button drives
export const actionsOf = (code) => ACTIONS.filter(a => bindings[a.id].some(c => same(c, code))).map(a => a.id);
export const isBound = (code) => ACTIONS.some(a => bindings[a.id].some(c => same(c, code)));
export const actionName = (id) => BY_ID[id]?.name;

// how a key reads on screen: the player's own keyboard layout where the browser tells us (an AZERTY Q shows as A)
let layout = null;
try { navigator.keyboard?.getLayoutMap?.().then(m => { layout = m; listeners.forEach(f => f()); }).catch(() => {}); } catch { /* not offered */ }
const NAMES = { Space: 'Space', Tab: 'Tab', ShiftLeft: 'Shift', ControlLeft: 'Ctrl', AltLeft: 'Alt', MetaLeft: 'Meta', Enter: 'Enter', Backspace: 'Bksp',
  CapsLock: 'Caps', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Mouse3: 'M4', Mouse4: 'M5',
  PageUp: 'PgUp', PageDown: 'PgDn', Insert: 'Ins', Delete: 'Del', Home: 'Home', End: 'End' };
export function keyLabel(code) {
  if (!code) return '';
  const c = norm(code);
  if (NAMES[c]) return NAMES[c];
  const l = layout?.get(c);
  if (l && l.trim()) return l.toUpperCase();
  return c.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ').replace(/^F(\d+)$/, 'F$1');
}
// a mouse button shows as a picture of the mouse (the tutorial's keycaps and the settings): 'lmb' | 'mmb' | 'rmb'
export const mouseIcon = (code) => ({ Mouse0: 'lmb', Mouse1: 'mmb', Mouse2: 'rmb' })[code] || null;
// one binding as a keycap for the tutorial ({ label } or { icon })
export function capOf(code) { const i = mouseIcon(code); return i ? { icon: i } : { label: keyLabel(code) }; }
// the first bound key of an action (for one-key prompts)
export const primary = (id) => bindings[id].find(Boolean) || null;
