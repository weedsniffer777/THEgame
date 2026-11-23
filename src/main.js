import * as THREE from 'three';
import { F5, INSTRUCTOR, CAMERA, WORLD, WEAPONS, loadTuning } from './config.js';
import { Aircraft } from './flight/aircraft.js';
import { instruct } from './flight/instructor.js';
import { CameraRig } from './camera.js';
import { createSky, setSun } from './world/sky.js';
import { loadTerrain } from './world/terrain.js';
import { loadJet, viewerAnim , NOZZLES } from './jet.js';
import { createHeatHaze } from './heatHaze.js';
import { groundContact } from './flight/ground.js';
import { createFlightHud } from './hudFlight.js';
import { createMap } from './hudMap.js';
import { createPauseMenu } from './ui/pauseMenu.js';
import { paintEnemy } from './enemy.js';
import { createMission1 } from './mission/mission1.js';
import { createRing, ringPointer } from './hudRing.js';
import { edgeDistance } from './mission/area.js';
import { createOverlay } from './ui/tutorial.js';
import { save, writeSave, clearSave } from './save.js';
import { units, settings } from './settings.js';
import { createClouds } from './world/clouds.js';
import { createWeapons } from './weapons.js';
import { loadEnemy } from './enemy.js';
import { createModelViewer } from './modelViewer.js';
import { createArmsHud } from './hudArms.js';
import { createXray } from './hudXray.js';
import { isTouch, createTouch } from './touch.js';
import { PART_HP, BODY_HP } from './damage.js';

loadTuning();
const STEP = 1 / 120;
const params = new URLSearchParams(location.search);

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.localClippingEnabled = true;
renderer.info.autoReset = false;   // (several passes per frame: the perf counter sums them)   // (the gear legs are clipped at the underside of the wing while they swing)
renderer.setPixelRatio(Math.min(devicePixelRatio, WORLD.pixelRatio));
renderer.toneMapping = THREE.NeutralToneMapping;   // keeps hues and saturation, so the picked sky colours stay true
renderer.toneMappingExposure = 1.25;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 2, 160000);

const sky = createSky();
scene.add(sky);
const sunDir = setSun();
const sun = new THREE.DirectionalLight(0xfff1dc, WORLD.sunIntensity);
scene.add(sun, sun.target, new THREE.HemisphereLight(0x9cc8f0, 0x5a5444, 0.9));
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene(); envScene.add(createSky());
scene.environment = pmrem.fromScene(envScene, 0, 1, 2000).texture;

// start screen works while the world is still loading; the game begins as soon as both are ready
const startEl = document.getElementById('start');
let ready = false, wantStart = params.has('autostart'), running = false, locked = false, started = false;
// paused after the first start: the pause menu, not the start screen (menu=false: something else takes the screen)
function setRunning(on, menu = true) {
  wantStart = on; running = on && ready;
  if (running) { started = true; pauseMenu.close(); }
  else if (started && menu) pauseMenu.open();
  startEl.classList.toggle('show', !running && !started);
}
function resume() {
  try { const lock = canvas.requestPointerLock?.(); lock?.catch?.(() => {}); } catch { /* no pointer lock here */ }
  setRunning(true);
}
const pauseMenu = createPauseMenu({ onResume: resume, onRestart: () => { spawn(); resume(); } });   // (spawn is hoisted: a fresh start of the level)
startEl.addEventListener('click', resume);
addEventListener('keydown', e => {                                       // P: pause / resume
  if (e.code !== 'KeyP' || e.repeat || viewer.on) return;
  if (running) { if (document.pointerLockElement) document.exitPointerLock(); else setRunning(false); }
  else if (started) resume();
});
document.addEventListener('pointerlockchange', () => {
  const was = locked;
  locked = !!document.pointerLockElement;
  if (was && !locked && !overlay?.open && !overlay?.endOpen) setRunning(false);   // (the end card frees the mouse without pausing)
});

const [terrain, jet] = await Promise.all([loadTerrain('terrain/engadin/'), loadJet('models/jets/f5.gltf.json', F5)]);
scene.add(terrain.group, jet.object);
const clouds = createClouds(WORLD.clouds, WORLD.cloudBase);
scene.add(clouds.mesh);
const cloudEl = document.getElementById('cloudfog');

const ac = new Aircraft(F5);
const [enemyProto, bomberProto] = await Promise.all([loadEnemy('earlyJet'), loadEnemy('bomber')]);
const haze = createHeatHaze(renderer, jet.model, NOZZLES);
// what we fly: Mission 1 (default) or free flight (?mode=free, dev kit)
let devMode = null; try { devMode = localStorage.getItem('thegame.devmode'); } catch { /* */ }
const MODE = (params.get('mode') || devMode) === 'free' ? 'free' : 'mission1';   // (dev kit level selector; kept in this browser)
const roster = MODE === 'mission1' ? [{ proto: bomberProto, count: 10 }] :   // (Mission 1: the bomber formation alone, no escorts)
  [{ proto: enemyProto, count: WEAPONS.drones - 1 }, { proto: bomberProto, count: 1 }];
const weapons = await createWeapons(scene, jet, ac, WEAPONS, terrain, roster);
const rig = new CameraRig(camera, CAMERA);
const overlay = createOverlay();
const mission = MODE === 'mission1' ? createMission1({ weapons, ac, rig }) : null;
let missionEnded = false;
const prevPos = new THREE.Vector3(), prevQuat = new THREE.Quaternion();
const drawPos = new THREE.Vector3(), drawQuat = new THREE.Quaternion();

// The ending ("last air-to-air kill"): the HUD goes, the camera rides with the last enemy as it falls for a few
// seconds, then slowly pulls out and up into a wide, drifting shot from high above; the picture softens and the
// results come up over it. The jet flies on by itself.
const ending = { on: false, win: true, t: 0, d: null, focus: new THREE.Vector3(), cam: new THREE.Vector3(), cv: new THREE.Vector3(), look: new THREE.Vector3(), yaw: 0, card: false };
const _ec = new THREE.Vector3(), _el = new THREE.Vector3(), _ew = new THREE.Vector3();
// win: the last enemy down (the camera on it); otherwise the mission is failed with the player still flying (the
// camera on the player's jet, which levels off by itself)
function startEnding(win = true) {
  const d = win ? (weapons.S.kills[weapons.S.kills.length - 1]?.d || weapons.drones[0]) : { obj: jet.object, vel: ac.vel };
  Object.assign(ending, { on: true, win, t: 0, d, card: false, placed: false, banner: false });
  const away = _ew.subVectors(camera.position, d.obj.position); ending.yaw = Math.atan2(away.x, away.z);
  weapons.setFiring(false); rig.zooming = false;
  document.body.classList.add('ending');
}
function endingStep(dt) {
  ending.t += dt;
  if (ending.t > 0.6 && !ending.banner) { ending.banner = true; showBanner(ending.win ? 'Mission complete' : 'Mission failed', ending.win ? 'win' : 'fail', 4.2); }
  if (ending.t > 5.5 && !ending.card) {                         // the results (or retry), over a softened picture
    ending.card = true; missionEnded = true;
    document.body.classList.add('ending-blur');
    if (ending.win) overlay.showEnd(mission.stats(), () => { spawn(); resume(); });
    else overlay.showDeath(() => { spawn(); resume(); });
    if (document.pointerLockElement) document.exitPointerLock();
  }
  // the jet flies on by itself: levelling off slowly, climbing away from any ground ahead
  if (!dead) {
    const v = _el.set(ac.vel.x, 0, ac.vel.z); if (v.lengthSq() < 1) v.set(0, 0, 1).applyQuaternion(ac.quat).setY(0);
    v.normalize();
    let pitch = 0;
    for (const sec of [3, 6, 10]) { const x = ac.pos.x + v.x * ac.vel.length() * sec, z = ac.pos.z + v.z * ac.vel.length() * sec; if (ac.pos.y - terrain.heightAt(x, z) < 500) pitch = 0.25; }
    rig.recenter(v.multiplyScalar(Math.cos(pitch)).setY(Math.sin(pitch)).normalize(), Math.min(1, dt * 0.5));
  }
}
// the banner across the screen: 'win' (faint green), 'fail' / 'warn' (faint red); white text in the middle
let bannerEl = null, bannerT = 0;
function showBanner(text, kind, sec = 0) {
  bannerEl ||= Object.assign(document.createElement('div'), { id: 'banner' });
  if (!bannerEl.isConnected) document.body.appendChild(bannerEl);
  bannerEl.className = 'on ' + kind; bannerEl.innerHTML = text;
  bannerT = sec;                                                // (0: stays until hidden)
}
function hideBanner() { if (bannerEl) bannerEl.className = ''; bannerT = 0; }
// The camera: placed off the aircraft's nose (a front three-quarter view, a little above, looking down at it), it then
// lets go of it: it keeps the aircraft's speed for a moment and slows, rising, so it falls away below and ahead; then it
// pulls out to a slow, wide shot from high up, drifting round (a helicopter shot)
function endingCamera(dt) {
  const d = ending.d, t = ending.t, P = d.obj.position;
  if (!ending.placed) {
    ending.focus.copy(P);
    const n = _ew.set(0, 0, 1).applyQuaternion(d.obj.quaternion), fl = Math.hypot(n.x, n.z) > 0.2;
    const sx = fl ? -n.z : 1, sz = fl ? n.x : 0, sl = Math.hypot(sx, sz);
    ending.cam.copy(P).addScaledVector(n, ending.win ? 60 : -45).add(_el.set(sx / sl * 42, ending.win ? 22 : 14, sz / sl * 42));
    ending.cv.copy(d.vel);
  }
  if (ending.win) {
    ending.focus.lerp(P, Math.min(1, dt * 1.2));
    ending.cv.multiplyScalar(Math.exp(-dt * 0.55));              // let go: slowing...
    ending.cv.y += dt * 7 * (1 - THREE.MathUtils.smoothstep(t, 4, 8));   // ...and rising
    ending.cam.addScaledVector(ending.cv, dt);
  } else {
    // failed while still flying: the camera travels with the jet (it would fly out of the shot), drifting back and up
    if (!ending.placed) ending.rel = _el.subVectors(ending.cam, P).clone();
    ending.focus.copy(P);
    ending.rel.multiplyScalar(1 + dt * 0.12); ending.rel.y += dt * 9;
    ending.cam.copy(P).add(ending.rel);
  }
  ending.yaw += dt * 0.035;
  const wide = _ew.set(Math.sin(ending.yaw) * 900, 0, Math.cos(ending.yaw) * 900).add(ending.focus);
  wide.y = Math.max(ending.focus.y, terrain.heightAt(ending.focus.x, ending.focus.z)) + 420;
  const k = THREE.MathUtils.smoothstep(t, 2.5, 10);              // pulling out to the wide shot
  if (ending.win) ending.cam.lerp(wide, Math.min(1, dt * 0.9 * k));
  ending.cam.y = Math.max(ending.cam.y, terrain.heightAt(ending.cam.x, ending.cam.z) + 25);
  ending.look.copy(P).lerp(ending.focus, k);
  const snap = !ending.placed; ending.placed = true;
  camera.position.copy(ending.cam); camera.up.set(0, 1, 0); camera.lookAt(ending.look);
  const fov = THREE.MathUtils.lerp(34, CAMERA.fov - 8, k);     // narrow close in, wider as it pulls out
  if (snap || Math.abs(camera.fov - fov) > 0.01) { camera.fov = snap ? fov : camera.fov + (fov - camera.fov) * Math.min(1, dt * 2); camera.updateProjectionMatrix(); }
}
// the mission area: within 0.5 nm of its edge a warning across the screen; outside it, a countdown, and at the end of
// it the mission is failed
const AREA_GRACE = 20, AREA_WARN = 926;
let areaT = AREA_GRACE, areaShown = '';
function areaCheck(dt) {
  const d = dead ? 1e9 : edgeDistance(mission.area, ac.pos.x, ac.pos.z);
  let want = '';
  if (d < 0) { areaT -= dt; want = `<b>${Math.max(0, Math.ceil(areaT))}</b>Outside mission area`; }
  else { areaT = AREA_GRACE; if (d < AREA_WARN) want = 'Leaving mission area'; }
  if (want !== areaShown) { areaShown = want; if (want) showBanner(want, 'warn'); else if (bannerEl?.classList.contains('warn')) hideBanner(); }
}
function spawn() {
  const s = WORLD.spawn;
  weapons.rearm(); jet.damage.repair();
  if (mission) { mission.start(weapons.S.simT || 0, !!tutActive()); tutReset(); missionEnded = false; overlay.hideEnd(); }   // (a restart replays the whole mission)
  else { weapons.S.allow.gun = weapons.S.allow.missile = true; ac.reset(new THREE.Vector3(s.x, s.y, s.z), s.heading, s.speed); rig.reset(ac.quat); weapons.placeDrones(); }
  ending.on = false; deathShown = false; deathBanner = false; areaT = AREA_GRACE; hideBanner(); overlay.hideEnd(); document.body.classList.remove('ending', 'ending-blur', 'dead-blur');
  prevPos.copy(ac.pos); prevQuat.copy(ac.quat);
  dead = 0; jet.object.visible = true; document.body.classList.remove('lost', 'dead');
}
let dead = 0, deathShown = false, deathBanner = false;
let shake = 0, shakeT = 0, machSide = null;   // (screen shake: how much, its clock; which side of Mach 1 the jet was)
weapons.S.onBoom = (p, size) => {             // an explosion: shakes the view, more the bigger and nearer it is
  const d = p.distanceTo(camera.position), reach = 260 + 220 * size;
  if (d < reach) shake = Math.min(1, shake + size * 0.45 * (1 - d / reach) ** 2);
};   // seconds since the player was killed (0 = alive)
// Tutorial (Mission 1, first time only), choreographed; it never waits for a click and never stops the game. The main
// group starts far ahead and hidden (no markers, no lock, not on the map); the weapons panel and the map are hidden
// too, and nothing fires. Flying is taught with big keycaps that fill green while held (any key in a row will do),
// pulse, and move on. Then a straggler is revealed: the map appears and, for a moment, the map and the bomber (or the
// ring pointer toward it) are spotlit; missiles: select, keep it in the circle, fire on the lock. Then the second
// straggler, zigzagging gently, with guns: put the gun cross on the lead circle. Then everything is revealed.
const tut = { camT: 0, camD: null, step: 'off', t: 0, wait: 0, entered: false, f: 0, doneT: 0, fwd: new THREE.Vector3(), thr: 0, stock: 0, lost: 0, gt: null };
const isTouchDev = isTouch, tv = new THREE.Vector3();
// what the player may use yet: each control is locked until the tutorial step that teaches it
const tutAllow = { throttle: true, brake: true, gear: true, w1: true, w2: true };
function tutUnlock() { for (const k in tutAllow) tutAllow[k] = true; }
function tutActive() { return mission && !save.tutorialDone; }
// tutorial: at least one bomber in every 1-3 bomber kills blows up (the usual chance applies in between), but never
// one that would catch the player in its blast (checked when decided and again when it goes off)
let tutBlow = 1 + Math.floor(Math.random() * 3);
{
  const base = weapons.S.detonateChance;
  weapons.S.detonateChance = (d) => {
    if (!d.def.detonate) return false;
    if (!tutActive()) return base(d);
    const blow = --tutBlow <= 0 || base(d);
    if (blow) tutBlow = 1 + Math.floor(Math.random() * 3);
    return blow;
  };
  weapons.S.detonateOK = (d) => !tutActive() || d.pos.distanceTo(ac.pos) > (d.def.detonate?.radius || 100) + 20;
}
function tutGo(step, wait = 0.4) { tut.fs = []; tut.showT = 0; tut.after = null; tut.step = step; tut.t = 0; tut.wait = wait; tut.entered = false; tut.f = 0; tut.doneT = 0; tut.lost = 0; overlay.clear(); }
function tutReset() {
  overlay.hold(0, null); overlay.clear();
  const on = !!tutActive(), W = weapons.S;
  document.body.classList.toggle('tut-noarms', on); document.body.classList.toggle('tut-nomap', on);
  if (!on) { tut.step = 'off'; W.allow.gun = W.allow.missile = true; tutUnlock(); if (!W.selected) weapons.select(1); return; }
  mission.noBreak = true;
  for (const k in tutAllow) tutAllow[k] = false;   // (each is unlocked by the step that teaches it; gear: after the tutorial)
  weapons.select(0);                                 // (no weapon at all until the tutorial has one picked)
  for (const d of weapons.drones) { d.hidden = true; d.noLock = true; }
  W.allow.gun = W.allow.missile = false;
  tutGo('steer', 1.2);
}
// spotlights: the reticle; an enemy in the air, or (off screen) the ring's pointer toward it
const aimSpot = { at: () => { const c = screenOf(tv.copy(camera.position).addScaledVector(rig.fwd, CAMERA.aimDistance)); return c && [c[0], c[1], 26]; } };
const foeSpot = (d) => ({ at: () => {
  if (!d || !d.alive || d.hidden) return null;
  const c = screenOf(d.obj.position);
  if (c && c[0] > 40 && c[0] < innerWidth - 40 && c[1] > 50 && c[1] < innerHeight - 40) return [c[0], c[1] - 10, 44];
  const p = ringPointer(); return p && [p[0], p[1], 36];
} });
// one keycap row: every frame `add(dt)` is how much it fills (0..1 a frame); full: the row pulses, then `then`
function capsStep(dt, add, then) {
  if (tut.doneT > 0) { if ((tut.doneT -= dt) <= 0) then(); return; }
  tut.f = Math.min(1, tut.f + add(dt));
  for (let k = 0; k < 10; k++) overlay.fill(k, tut.f);
  if (tut.f >= 1) { overlay.done(); tut.doneT = 0.8; }
}
// several labelled keycap groups that fill separately (tut.fs); all full: the row pulses, then `then`
function groupsStep(dt, adds, then) {
  if (tut.doneT > 0) { if ((tut.doneT -= dt) <= 0) then(); return; }
  tut.fs = tut.fs || [];
  adds.forEach((add, k) => { tut.fs[k] = Math.min(1, (tut.fs[k] || 0) + add(dt)); overlay.fill(k, tut.fs[k]); });
  if (adds.every((_, k) => tut.fs[k] >= 1)) { overlay.done(); tut.doneT = 0.8; }
}
const anyKey = (...codes) => (dt) => codes.some(c => keys.has(c)) ? dt / 0.5 : 0;
// a new enemy: the map appears, the game freezes for a moment on the map and the enemy, then carries on
// a new enemy: it appears, and for a moment the view swings round to it on its own (as right click does)
function tutSpot(d, text, then) {
  d.hidden = false;
  weapons.setFiring(false);
  overlay.say(text); overlay.keys([]);
  overlay.spot([foeSpot(d)], 0.2);
  tut.camD = d;
  tut.showT = 3.4; tut.after = then;                        // (the game never stops)
}
// spotlights on our missiles in flight (up to three)
const missileSpots = () => [0, 1, 2].map(k => ({ at: () => { const m = weapons.S.missiles.filter(m => m.owner === 'player')[k]; const c = m && screenOf(m.p); return c && c[0] > 0 && c[0] < innerWidth && c[1] > 0 && c[1] < innerHeight ? [c[0], c[1], 26] : null; } }));
const FIRE_KEYS = () => isTouchDev ? [{ icon: 'tap' }] : [{ label: 'Space' }, { text: 'or' }, { icon: 'lmb' }];
function tutorialStep(dt) {
  if (!mission || tut.step === 'off') return;
  // during the flying lessons the (hidden) formation is on rails: the first straggler stays 2.2 km ahead along the
  // track however fast or slow the player goes, so it is never close when the shooting starts
  if (['steer', 'keys', 'throttle', 'brake'].includes(tut.step)) {
    const A0 = mission.stragglers[0], ahead = _wv.subVectors(A0.pos, ac.pos).dot(A0.track.dir);
    if (Math.abs(ahead - 2200) > 1) mission.shift(2200 - ahead);
  }
  if ((tut.wait -= dt) > 0) return;
  const W = weapons.S, [A, B] = mission.stragglers, down = (d) => !d.alive || d.falling, T = isTouchDev;
  if (tut.showT > 0) { if ((tut.showT -= dt) <= 0) { overlay.clear(); const f = tut.after; tut.after = null; f?.(); } return; }
  const first = !tut.entered; tut.entered = true; tut.t += dt;
  const gunsDone = () => { W.allow.gun = false; weapons.setFiring(false); tutGo(tut.gt === A && !down(B) ? 'spotB' : 'final', 2.5); };
  switch (tut.step) {
    case 'steer': {
      if (first) { overlay.say(T ? 'Drag anywhere to steer' : 'Move the mouse to steer'); overlay.keys([{ icon: T ? 'drag' : 'mouse' }]); overlay.spot([aimSpot], 0.3); tut.fwd.copy(rig.fwd); }
      const turn = rig.fwd.angleTo(tut.fwd); tut.fwd.copy(rig.fwd);
      capsStep(dt, () => turn / 1.4, () => tutGo(T ? 'throttle' : 'keys'));
      break;
    }
    case 'keys':     // the keys work too: one from each column (pitch, roll, yaw)
      if (first) { overlay.say('You can also use keyboard controls'); overlay.keys([{ group: 'Pitch', keys: [{ label: 'W' }, { label: 'S' }] }, { group: 'Roll', keys: [{ label: 'A' }, { label: 'D' }] }, { group: 'Yaw', keys: [{ label: 'Q' }, { label: 'E' }] }]); }
      groupsStep(dt, [anyKey('KeyW', 'KeyS'), anyKey('KeyA', 'KeyD'), anyKey('KeyQ', 'KeyE')], () => tutGo('throttle'));
      break;
    case 'throttle': {   // speed up and slow down, both
      if (first) {
        tutAllow.throttle = true;
        overlay.keys([{ group: 'Speed up', keys: [T ? { icon: 'drag' } : { label: 'Tab' }] }, { br: true }, { group: 'Slow down', keys: [T ? { icon: 'drag' } : { label: 'Shift' }] }]);
        overlay.spot([{ sel: T ? '.t-throttle' : '#thrScale', pad: 8 }], 0.3); tut.thr = ac.throttle;
      }
      const d = ac.throttle - tut.thr; tut.thr = ac.throttle;
      groupsStep(dt, T ? [() => Math.max(0, d) / 0.25, () => Math.max(0, -d) / 0.25] : [anyKey('Tab', 'KeyX'), anyKey('ShiftLeft', 'ShiftRight', 'KeyZ')], () => tutGo('brake', 0.3));
      break;
    }
    case 'brake':
      if (first) { tutAllow.brake = true; overlay.say('Slow down faster with airbrakes'); overlay.keys([T ? { label: 'BRAKE' } : { label: 'B' }]); overlay.spot(T ? [{ sel: '.t-brake', round: true, pad: 6 }] : [], 0.3); }
      capsStep(dt, (dt) => ac.airbrakeCmd > 0 ? dt / 0.6 : 0, () => tutGo('spotA', 1.2));
      break;
    // ---- spotting: the first enemy, tracking it (the map is mentioned, not required) ----
    case 'spotA':    // the view swings to it once by itself, then: hold right click to track it
      if (first) {
        A.hidden = false; document.body.classList.remove('tut-nomap'); weapons.setFiring(false);
        tut.camD = A;
        overlay.say(T ? 'Hold to track an enemy!' : 'Right click to track an enemy!');
        overlay.keys([T ? { icon: 'tap' } : { icon: 'rmb' }, ...(T ? [] : [{ br: true }, { text: 'You can also check the map with' }, { label: 'M', small: true }])]);
        overlay.spot([foeSpot(A), ...(T ? [{ sel: '.t-zoom', round: true, pad: 6 }] : [])], 0.2);
      }
      groupsStep(dt, [(dt) => rig.zooming ? dt / 0.9 : 0], () => { tut.gt = A; tutGo('select1', 0.3); });
      break;
    // ---- guns, on the first one (it jinks): select, aim (weapons still safe), then shoot ----
    case 'select1':
      if (first) { tutAllow.w1 = true; document.body.classList.remove('tut-noarms'); overlay.say('Select cannon to destroy the enemy'); overlay.keys(T ? [{ icon: 'tap' }] : [{ label: '1' }]); overlay.spot([{ sel: '#arms .col[data-w="1"]', pad: 6 }], 0.35); }
      capsStep(dt, (dt) => W.selected === 1 ? dt / 0.2 : 0, () => tutGo('close', 0.1));
      break;
    case 'close':
      if (first) { overlay.say('Close in'); overlay.spot([{ sel: gunBox, pad: 5 }], 0.2); }
      if (down(tut.gt)) { gunsDone(); break; }
      if (tut.gt.pos.distanceTo(ac.pos) <= WEAPONS.gunRange) tutGo(W.allow.gun ? 'kill' : 'aim', 0);
      break;
    case 'aim':      // aim and shoot, one step: two lines over the keys
      if (first) { W.allow.gun = true; overlay.say('Aim by pointing the nose in the circle!\nShoot by pressing'); overlay.keys(FIRE_KEYS()); overlay.spot([{ sel: gunCirc, round: true, pad: 8 }, { sel: '#nose', round: true, pad: 10 }, ...(T ? [{ sel: '.t-fire', round: true, pad: 6 }] : [])], 0.15); }
      if (down(tut.gt)) { gunsDone(); break; }
      capsStep(dt, (dt) => W.firing && W.selected === 1 ? dt / 0.8 : 0, () => { overlay.clear(); tut.step = 'kill'; tut.t = 0; });
      if (tut.doneT <= 0 && tut.gt.pos.distanceTo(ac.pos) > WEAPONS.gunRange * 1.2) tutGo('close', 0);
      break;
    case 'kill':     // shown how: now the fight is theirs (but "close in" comes back if they drift well out of range)
      if (down(tut.gt)) gunsDone();
      else if (tut.gt.pos.distanceTo(ac.pos) > WEAPONS.gunRange * 1.5) tutGo('close', 0);
      break;
    // ---- missiles, on the second one: out of gun range on purpose ----
    case 'spotB':
      if (first) {
        W.allow.gun = W.allow.missile = false; weapons.setFiring(false); weapons.select(0);
        tutAllow.w1 = false;                                 // (missiles only now: no switching back to guns)
        // put it well beyond gun range (but inside missile range) ahead of the player
        const ahead = _wv.subVectors(B.pos, ac.pos).dot(B.track.dir);
        if (ahead < 4300) mission.shiftOne(B, 4300 - ahead);
        B.hidden = false;
        tutAllow.w2 = true;
        overlay.say('Use missiles to destroy farther enemies!'); overlay.keys(T ? [{ icon: 'tap' }] : [{ label: '2' }]);
        overlay.spot([foeSpot(B), { sel: '#arms .col[data-w="2"]', pad: 6 }], 0.25);
      }
      capsStep(dt, (dt) => W.selected === 2 ? dt / 0.2 : 0, () => { B.noLock = false; tutGo('lock', 0.1); });
      break;
    case 'lock':
      if (first) { overlay.say('Wait for the missile to lock on the target'); overlay.spot([{ sel: '#seeker', round: true, pad: 4 }], 0.25); }
      if (down(B)) { tutUnlock(); tutGo('final', 0.4); break; }
      if (W.selected !== 2) { if (W.stock > 0) tutGo('spotB2', 0); else { tutAllow.w1 = W.allow.gun = true; tut.gt = B; tutGo('close', 0.3); } break; }
      if (W.locked && W.seeker === B) { W.allow.missile = true; tutGo('fire', 0); }
      break;
    case 'spotB2':   // (switched away from missiles: back to them)
      if (first) { overlay.say('Use missiles to destroy farther enemies!'); overlay.keys(T ? [{ icon: 'tap' }] : [{ label: '2' }]); overlay.spot([{ sel: '#arms .col[data-w="2"]', pad: 6 }], 0.3); }
      capsStep(dt, (dt) => W.selected === 2 ? dt / 0.2 : 0, () => tutGo('lock', 0.1));
      break;
    case 'fire':
      if (first) { overlay.say('When the missile is locked, launch with'); overlay.keys(FIRE_KEYS()); overlay.spot([foeSpot(B), ...missileSpots(), ...(T ? [{ sel: '.t-fire', round: true, pad: 6 }] : [])], 0.2); tut.stock = W.stock; }
      if (down(B)) { tutUnlock(); tutGo('final', 0.4); break; }
      capsStep(dt, () => W.stock < tut.stock ? 1 : 0, () => { tut.step = 'chase'; tut.t = 0; overlay.say(''); overlay.keys([]); });
      if (tut.doneT <= 0 && (tut.lost = W.locked ? 0 : tut.lost + dt) > 1) tutGo('lock', 0);   // lost the lock: find it again
      break;
    case 'chase': {  // a missile on its way (the enemy and the missile stay spotlit)
      const flying = W.missiles.some(m => m.owner === 'player');
      if (down(B)) { tutUnlock(); tutGo('final', 0.4); }
      else if (!flying && tut.t > 0.5) {
        if (W.stock > 0) tutGo('lock', 0.3);                 // missed: again
        else { tutAllow.w1 = W.allow.gun = true; tut.gt = B; tutGo('close', 0.3); }   // out of missiles (it switched to guns): finish it with those
      }
      break;
    }
    case 'final':
      if (first) {
        for (const d of weapons.drones) { d.hidden = false; d.noLock = false; }
        W.allow.gun = W.allow.missile = true; tutUnlock();
        mission.toLoop();
        weapons.setFiring(false);
        overlay.say('Destroy the remaining enemies!');
        // no spotlight while any of them is in view; if none is, the map and the ring's pointer to the nearest
        const inView = weapons.drones.some(d => { if (!d.alive || d.falling) return false; const c = screenOf(d.obj.position); return c && c[0] > 0 && c[0] < innerWidth && c[1] > 0 && c[1] < innerHeight; });
        overlay.spot(inView ? [] : [{ sel: '#minimap', pad: 4 }, { at: () => { const q = ringPointer(); return q && [q[0], q[1], 36]; } }], 0.3);
        save.tutorialDone = true; writeSave();
        tut.showT = 3; tut.after = () => { tut.step = 'off'; };
      }
      break;
  }
}
// selecting a weapon: not until the tutorial has taught it, and never an empty one (that says so instead)
let outT = 0;   // how long the "out of missiles" notice still shows
function pickWeapon(k) {
  if (!tutAllow['w' + k]) return;
  if (k === 2 && weapons.S.stock === 0) { outT = 2.5; return; }
  weapons.select(k);
}
// landing gear up / down: not before the tutorial is done, and never up while sitting on it
function toggleGear() {
  if (!tutAllow.gear) return;
  if (ac.gearCmd && ac.onGround) return;
  ac.gearCmd = ac.gearCmd ? 0 : 1;
}
let trackLock = null;   // the aircraft right click is tracking
function trackTarget() {
  const ok = (d) => d && d.alive && !d.falling && !d.hidden;
  if (weapons.S.selected === 2 && ok(weapons.S.seeker)) return weapons.S.seeker;
  if (ok(weapons.S.target)) return weapons.S.target;
  let best = null, bd = Infinity;
  for (const d of weapons.drones) if (ok(d)) { const dd = d.pos.distanceToSquared(ac.pos); if (dd < bd) { bd = dd; best = d; } }
  return best;
}
let touchBrake = false, touchUi = null;   // (touch screens: airbrake button held; the touch controls)
let tgtSwitch = 0;   // how long a better gun target has been waiting to take over
spawn();

// input
const keys = new Set();
let mouseDX = 0, mouseDY = 0, abHold = 0;
const GAME_KEYS = new Set(['Space', 'Tab', 'ShiftLeft', 'ShiftRight', 'KeyZ', 'KeyX', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyB', 'Digit1', 'Digit2', 'KeyR', 'KeyG']);
addEventListener('keydown', e => { if (GAME_KEYS.has(e.code)) e.preventDefault(); keys.add(e.code); if (e.code === 'Backquote') import('./dev.js').then(m => m.toggleDev({ ac, terrain, renderer, spawn })); });
addEventListener('keyup', e => keys.delete(e.code));
// weapons: 1 guns, 2 missiles; Space or left mouse fires
addEventListener('keydown', e => {
  if (e.code === 'Digit1') pickWeapon(1);
  if (e.code === 'Digit2') pickWeapon(2);
  if (e.code === 'KeyR') weapons.cycleTarget();
  if (e.code === 'KeyG' && !e.repeat) toggleGear();   // landing gear up / down
  if (e.code === 'Space' && running && !dead && !overlay.open && !ending.on && !e.repeat) weapons.setFiring(true, performance.now() / 1000);
});
addEventListener('keyup', e => { if (e.code === 'Space') weapons.setFiring(false); });
addEventListener('mousedown', e => { if (e.button === 0 && running && !dead && !overlay.open && !ending.on && e.target === canvas) weapons.setFiring(true, performance.now() / 1000); });
addEventListener('mouseup', e => { if (e.button === 0) weapons.setFiring(false); });
addEventListener('blur', () => keys.clear());
// With pointer lock the mouse turns the camera directly. Where the page can't lock the pointer
// (some embedded views), the cursor's distance from the screen centre turns it like a joystick instead.
let cursorX = null, cursorY = null;
addEventListener('mousemove', e => {
  cursorX = e.clientX; cursorY = e.clientY;
  if (running && locked) { mouseDX += e.movementX; mouseDY += e.movementY; }
});
addEventListener('keydown', e => { if (e.code === 'Escape' && !locked) setRunning(false); });
function cursorSteer(dt) {
  if (locked || cursorX === null || isTouch) return;   // phones fake mouse moves on taps: never steer from those
  const s = Math.min(innerWidth, innerHeight) / 2;
  const dead = (v) => Math.sign(v) * Math.max(Math.abs(v) - 0.06, 0);
  mouseDX += dead((cursorX - innerWidth / 2) / s) * 900 * dt;
  mouseDY += dead((cursorY - innerHeight / 2) / s) * 900 * dt;
}
addEventListener('mousedown', e => { if (e.button === 2) rig.zooming = true; });
addEventListener('mouseup', e => { if (e.button === 2) rig.zooming = false; });
addEventListener('contextmenu', e => e.preventDefault());
// compile every shader now, hidden things included (effects, wrecks, the vapour cone...), so nothing stalls the
// first time it appears mid-game (a likely source of the rare hitches, worst on phones)
{
  const hidden = [];
  scene.traverse(o => { if (!o.visible) { hidden.push(o); o.visible = true; } });
  try { renderer.compile(scene, camera); } catch { /* not fatal: they compile on first use instead */ }
  for (const o of hidden) o.visible = false;
}
ready = true;
startEl.classList.remove('loading');
setRunning(wantStart);

const aimPoint = new THREE.Vector3();
let manual = false, recentre = 0;   // seconds left of easing the camera back onto the nose after keyboard flying
// crash: the jet blows up and burns on the ground; the camera holds on it for a few seconds before respawning
// crash: the airframe keeps its momentum and is simulated as a tumbling, bouncing, sliding body until it stops,
// burning; a hard hit can tear the outer wings off. The camera holds on it, then the player respawns.
const wreck = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(), spin: new THREE.Vector3(), key: {} };
// killed: the camera lets go of the jet and pulls far back, circling slowly while it goes in
const deathCam = { yaw: 0, pitch: 0, dist: 0, far: 85 };
function crash(ditched = false, airborne = false) {   // ditched: worn out after a water landing (sinks whole); airborne: broke up in the air
  if (dead) return;
  // the last enemy went down: if the player dies too in those first moments, it's a loss after all; once the ending is
  // under way the jet flying on by itself can't die
  if (ending.on) { if (ending.t >= 3) return; ending.on = false; document.body.classList.remove('ending', 'ending-blur'); }
  weapons.setFiring(false); document.body.classList.add('dead');   // dead: no shooting, no HUD
  deathCam.far = airborne ? 190 : 85;                                   // broken up: pull right back over the spreading debris
  wreck.airborne = airborne;                                          // (the fuselage still has to hit the ground)
  dead = 1e-6;
  {
    const o = _wv.subVectors(camera.position, ac.pos), L = Math.max(o.length(), 1);
    deathCam.yaw = Math.atan2(o.x, o.z); deathCam.pitch = Math.asin(THREE.MathUtils.clamp(o.y / L, -1, 1)); deathCam.dist = L;
  }
  jet.damage.doomed = true;                                          // every fire on it burns fully again
  // into a lake (judged by the lowest point of the airframe, up to ~8 m below the middle in a steep dive): steeply or
  // slowly it goes straight under; at a shallow angle it skips and slides across the surface first (see wreckStep)
  const onLake = terrain.isWater(ac.pos.x, ac.pos.z) && ac.pos.y < terrain.heightAt(ac.pos.x, ac.pos.z) + 9;
  const spd = ac.vel.length(), steep = -ac.vel.y / Math.max(spd, 1);
  wreck.inWater = onLake && (steep > 0.45 || spd < 20); wreck.lake = onLake;
  if (airborne && !onLake) weapons.explode(ac.pos, ac.vel, 1.0); else weapons.crash(ac.pos, ac.vel, onLake, ditched);
  wreck.pos.copy(ac.pos); wreck.vel.copy(ac.vel); wreck.quat.copy(ac.quat); wreck.key = {};
  wreck.spin.set(-ac.q, -ac.r, ac.p).applyQuaternion(ac.quat);      // keeps the rotation it had (world axes)
  // hitting the ground tears off everything still attached (the rear fuselage can snap off too, on a hard
  // enough contact: see wreckStep)
  // (into the water it stays in one piece and sinks: no parts flung across the lake, no fire or smoke, just water)
  if (!ditched && !onLake) for (const n of Object.keys(jet.damage.parts)) if (n !== 'tail') jet.damage.breakPart(n, ac.vel);
  {
    const x = ac.pos.x, z = ac.pos.z;
    _wn.set(terrain.heightAt(x - 2, z) - terrain.heightAt(x + 2, z), 4, terrain.heightAt(x, z - 2) - terrain.heightAt(x, z + 2)).normalize();
    if (!ditched && !onLake && ac.vel.dot(_wn) < -20) jet.damage.breakPart('tail', ac.vel);   // into the ground hard: the fuselage snaps behind the wing
  }
  if (onLake) jet.damage.quench();                                     // into a lake: the water puts every fire out
  ac.throttle = ac.engine = 0;
  document.body.classList.remove('lost');
}
const _wn = new THREE.Vector3(), _wv = new THREE.Vector3(), _wq = new THREE.Quaternion();
// The wreck is a rigid body that touches the ground at points on its airframe (body frame: +x left wing, +y up,
// +z nose; points on parts that have broken off no longer count). Each touching point gets a normal impulse with
// almost no bounce and a friction impulse, applied at that point, so it tumbles only as much as the contacts make it,
// slides, settles on whatever it lands on and comes to rest.
const WRECK_PTS = [
  [[0, -0.2, 7.2], 'nose'], [[0, -0.5, 4.6]], [[0, 0.3, -7], 'tail'], [[0, -0.9, -6], 'tail'], [[0, -1.0, 0.5]], [[0, -0.9, -3.4]], [[0, 0.7, -3.3]],
  [[0, 1.2, 2.6]], [[0, 3.1, -6.4], 'fin'],
  [[4.0, -0.1, -1.6], 'wingOuterL'], [[-4.0, -0.1, -1.6], 'wingOuterR'], [[2.0, -0.3, -0.6], 'wingInnerL'], [[-2.0, -0.3, -0.6], 'wingInnerR'],
  [[2.6, 0.2, -5.6], 'stabL'], [[-2.6, 0.2, -5.6], 'stabR'],
].map(([p, part]) => ({ p: new THREE.Vector3(...p), part }));
const WRECK_I = new THREE.Vector3(1 / 16, 1 / 18, 1 / 4);   // inverse inertia per unit mass about body x (pitch), y (yaw), z (roll), 1/m²
const _r = new THREE.Vector3(), _vc = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _qInv = new THREE.Quaternion();
function invI(v, out) {   // world-space inverse inertia applied to a world vector
  _qInv.copy(wreck.quat).invert();
  out.copy(v).applyQuaternion(_qInv).multiply(WRECK_I).applyQuaternion(wreck.quat);
  return out;
}
function wreckStep(dt) {
  const wsp = wreck.vel.length();
  if (!wreck.inWater && terrain.isWater(wreck.pos.x, wreck.pos.z) && wreck.pos.y < terrain.heightAt(wreck.pos.x, wreck.pos.z) + 1.5 && (wsp < 20 || -wreck.vel.y / Math.max(wsp, 1) > 0.45)) {   // (skipping across it at speed: see the contacts)
    wreck.inWater = true; weapons.crash(wreck.pos, wreck.vel, true, false); jet.damage.quench();   // (falls into a lake: the big splash, fires out)
  }
  if (wreck.inWater) {                                                 // in a lake: dragged to a stop, then it sinks
    wreck.vel.multiplyScalar(Math.exp(-2.5 * dt)); wreck.vel.y += (-1.4 - wreck.vel.y) * Math.min(1, 2 * dt);
    wreck.spin.multiplyScalar(Math.exp(-2 * dt));
    wreck.pos.addScaledVector(wreck.vel, dt);
    const w0 = wreck.spin.length();
    if (w0 > 1e-5) { _wq.setFromAxisAngle(_wn.copy(wreck.spin).divideScalar(w0), w0 * dt); wreck.quat.premultiply(_wq).normalize(); }
    if (wreck.pos.y < terrain.heightAt(wreck.pos.x, wreck.pos.z) - 14) jet.object.visible = false;
    return;
  }
  wreck.vel.y -= 9.81 * dt;
  // in the air: drag on the tumbling airframe, and a tumble the air slows (faster tumbling, harder braking)
  const V = wreck.vel.length(), W = wreck.spin.length();
  wreck.vel.multiplyScalar(1 / (1 + 0.0007 * V * dt));
  wreck.spin.multiplyScalar(1 / (1 + (0.4 + 0.25 * W) * dt));
  wreck.pos.addScaledVector(wreck.vel, dt);
  const w0 = wreck.spin.length();
  if (w0 > 1e-5) { _wq.setFromAxisAngle(_wn.copy(wreck.spin).divideScalar(w0), w0 * dt); wreck.quat.premultiply(_wq).normalize(); }
  let touching = 0, lift = 0;
  for (const c of WRECK_PTS) {
    if (c.part && jet.damage.parts[c.part]?.broken) continue;
    _r.copy(c.p).applyQuaternion(wreck.quat);
    const x = wreck.pos.x + _r.x, z = wreck.pos.z + _r.z, ground = terrain.heightAt(x, z);
    const pen = ground - (wreck.pos.y + _r.y);
    if (pen <= 0) continue;
    touching++; lift = Math.max(lift, pen);
    _wn.set(terrain.heightAt(x - 2, z) - terrain.heightAt(x + 2, z), 4, terrain.heightAt(x, z - 2) - terrain.heightAt(x, z + 2)).normalize();
    // velocity of this point
    _vc.crossVectors(wreck.spin, _r).add(wreck.vel);
    const vn = _vc.dot(_wn);
    // the water: hit steeply or slowly it goes under; a glancing hit skips it off the surface, throwing spray
    const wet = terrain.isWater(x, z);
    if (wet && vn < 0) {
      const sp = wreck.vel.length();
      jet.damage.quench(); wreck.lake = true;
      if (sp < 20 || -vn / Math.max(sp, 1) > 0.45) { wreck.inWater = true; weapons.crash(wreck.pos, wreck.vel, true, false); return; }
      for (let k = 0; k < 3 + sp / 15; k++) weapons.spray(wreck.pos, wreck.vel);
      if (-vn > 6) weapons.splash(wreck.pos, wreck.vel, Math.min(2.4, 0.6 + -vn / 15));
    }
    if (vn < 0) {
      // normal impulse (restitution 0.1; a hard hit also crumples, taking extra energy out)
      const k = 1 + _wn.dot(_t1.crossVectors(invI(_t2.crossVectors(_r, _wn), _t2), _r));
      const jn = -(1 + (wet ? 0.3 : vn < -20 ? 0 : 0.1)) * vn / k;   // (water: it skips)
      if (vn < -12) wreck.vel.multiplyScalar(1 - Math.min(0.45, -vn / 120));   // a hard hit crumples the airframe: much of the speed goes
      if (vn < -22 && !jet.damage.parts.tail?.broken) jet.damage.breakPart('tail', wreck.vel);   // hard enough: the fuselage snaps behind the wing
      wreck.vel.addScaledVector(_wn, jn);
      wreck.spin.add(invI(_t1.crossVectors(_r, _wn).multiplyScalar(jn), _t2));
      // friction: oppose the sliding of this point, up to mu times the normal impulse
      _vc.crossVectors(wreck.spin, _r).add(wreck.vel);
      const vt = _t1.copy(_vc).addScaledVector(_wn, -_vc.dot(_wn)), sp = vt.length();
      if (sp > 1e-4) {
        const tdir = vt.divideScalar(sp);
        const kt = 1 + tdir.dot(_vc.crossVectors(invI(_t2.crossVectors(_r, tdir), _t2), _r));
        const jt = Math.min(sp / kt, (wet ? 0.3 : 0.9) * jn);   // (water: it slides)
        wreck.vel.addScaledVector(tdir, -jt);
        wreck.spin.add(invI(_t2.crossVectors(_r, tdir).multiplyScalar(-jt), _vc));
      }
    }
  }
  if (wreck.spin.lengthSq() > 25) wreck.spin.setLength(5);          // a graze at speed can't set it whirling
  if (touching && wreck.airborne) {                                   // what was left after breaking up hits the ground: it goes up
    wreck.airborne = false;
    weapons.crash(wreck.pos, wreck.vel, terrain.isWater(wreck.pos.x, wreck.pos.z));
  }
  if (touching) {
    wreck.pos.y += lift * 0.8;                                     // push out of the ground
    wreck.vel.multiplyScalar(Math.exp(-0.8 * dt));                 // ground scraping and crumpling
    wreck.spin.multiplyScalar(Math.exp(-(2.5 + 1.2 * touching) * dt));   // rolling and grinding over the ground stops it turning
    if (touching >= 3 && wreck.vel.lengthSq() < 0.15 && wreck.spin.lengthSq() < 0.01) { wreck.vel.set(0, 0, 0); wreck.spin.set(0, 0, 0); }   // at rest
  }
}
function axis(neg, pos) { return (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0); }

function physics(dt) {
  // throttle; holding throttle-up at full power lights the afterburner (Space stays free for guns)
  ac.airbrakeCmd = (keys.has('KeyB') || touchBrake) && tutAllow.brake ? 1 : 0;
  // Tab (or X) up, Shift (or Z) down
  const thUp = tutAllow.throttle && (keys.has('Tab') || keys.has('KeyX')), thDown = tutAllow.throttle && (keys.has('ShiftLeft') || keys.has('ShiftRight') || keys.has('KeyZ'));
  const th = (thUp ? 1 : 0) - (thDown ? 1 : 0);
  // holding throttle-up at full dry power pushes the lever into the burner over ~0.25 s (the burner lights and
  // grows as it goes); let go before the end and it drops back to full dry
  if (th > 0 && ac.throttle >= 1) { if (ac.throttle < 1.1) { abHold += dt; ac.throttle = Math.min(1.1, 1 + 0.1 * abHold / 0.25); } }
  else { if (ac.throttle > 1 && ac.throttle < 1.1) ac.throttle = 1; abHold = 0; if (th) ac.throttle = THREE.MathUtils.clamp(Math.min(ac.throttle, 1) + th * 1.2 * dt, 0, 1); }
  const kb = { pitch: axis('KeyW', 'KeyS'), roll: axis('KeyA', 'KeyD'), yaw: axis('KeyQ', 'KeyE') };
  kb.active = !!(kb.pitch || kb.roll || kb.yaw);   // any flying key takes over from mouse aim (the camera eases back after)
  if (kb.active) recentre = 0.45; else if (recentre > 0) recentre -= dt;
  // letting go of the keys: the camera only eases back onto the nose if it was roughly looking along it (not when it
  // has been turned to look at something else)
  if (manual && !kb.active && rig.fwd.angleTo(_n.set(0, 0, 1).applyQuaternion(ac.quat)) > 25 * Math.PI / 180) recentre = 0;
  manual = kb.active;
  aimPoint.copy(camera.position).addScaledVector(rig.fwd, CAMERA.aimDistance);
  const lost = jet.damage.dead;
  // the fuselage is the real health bar: once it is gone the jet is destroyed on the spot (it blows apart in the air)
  if (jet.damage.bodyHp <= 0) { crash(false, true); return; }
  if (lost) {                                                         // critically damaged: still flown (what's left of it)...
    const maxG = INSTRUCTOR.maxG; INSTRUCTOR.maxG = maxG * (1 - 0.4 * ac.gear);
    instruct(ac, aimPoint, INSTRUCTOR, kb, dt);
    INSTRUCTOR.maxG = maxG;
    // ...but it comes apart in the air: a piece at a time, the fuselage failing with it, until nothing is left flying
    breakupT -= dt;
    if (breakupT <= 0) {
      breakupT = 0.45 + Math.random() * 0.8;
      const left = Object.keys(jet.damage.parts).filter(n => !jet.damage.parts[n].broken);
      if (left.length) jet.damage.breakPart(left[Math.floor(Math.random() * left.length)], ac.vel);
      jet.damage.bodyHp -= left.length ? 3 : 8;                          // (the fuselage failing with it: at 0, see above)
    }
  } else {
    breakupT = 0.6;
    // gear down: the flaps are held at their landing notches, so less turn is available
    const maxG = INSTRUCTOR.maxG; INSTRUCTOR.maxG = maxG * (1 - 0.4 * ac.gear);
    instruct(ac, aimPoint, INSTRUCTOR, kb, dt);
    INSTRUCTOR.maxG = maxG;
  }
  document.body.classList.toggle('lost', lost);
  ac.step(dt);
  weapons.step(dt, performance.now() / 1000);
  // touching the ground: roll, bounce, scrape and lose parts; only a really hard hit or a wrecked airframe is a crash
  const g = groundContact(ac, terrain, jet.damage, dt, keys.has('KeyB') && ac.throttle < 0.05);
  if (g.crash) crash(); else if (g.touching && jet.damage.dead) crash(g.water); else if (g.bogged) crash(true);
  // skimming: spray, a lot of it, more the faster it goes
  if (g.water && !dead) { const n = 2 + ac.vel.length() / 18; for (let k = 0; k < n; k++) if (Math.random() < dt * 40) weapons.spray(ac.pos, ac.vel); }
}

// HUD
const aimEl = document.getElementById('aim'), noseEl = document.getElementById('nose');
const thrEl = document.getElementById('throttle'), thrFill = thrEl.firstElementChild, vig = document.getElementById('vignette');
const _p = new THREE.Vector3();
const _n = new THREE.Vector3(), fpvEl = document.getElementById('fpv');
const seekerEl = document.getElementById('seeker'), lockEl = document.getElementById('lockc'), tgtEl = document.getElementById('tgt'), tgtEls = [], mslEls = [];
const armsHud = createArmsHud(document.getElementById('arms'), WEAPONS.missiles, (k) => { if (running) pickWeapon(k); });
const gunSvg = document.getElementById('gunsol'), [gunBox, gunLine, gunCirc] = gunSvg.children;

// a distance for the HUD: nm (km), then ft (m) close in: inside 1.5 nm (2 km)
function distText(m) {
  const metric = settings.units === 'metric', far = metric ? m >= 2000 : m >= 1.5 * 1852;
  if (far) { const v = units.dist(m); return `${v < 10 ? v.toFixed(1) : Math.round(v)}<small>${units.distLabel()}</small>`; }
  const st = metric ? 10 : 50;
  return `${Math.round(units.alt(m) / st) * st}<small>${units.altLabel()}</small>`;
}
function screenOf(p) { _p.copy(p).project(camera); return _p.z < 1 ? [(_p.x * 0.5 + 0.5) * innerWidth, (-_p.y * 0.5 + 0.5) * innerHeight] : null; }
const xray = createXray(document.getElementById('xray'), jet.damage, { ...PART_HP, body: BODY_HP }, renderer, jet.model);
const iasEl = document.getElementById('ias'), gEl = document.getElementById('gload');
function place(el, worldPoint) {
  _p.copy(worldPoint).project(camera);
  const vis = _p.z < 1;
  el.style.display = vis ? '' : 'none';
  if (vis) el.style.transform = `translate(${(_p.x * 0.5 + 0.5) * innerWidth}px, ${(-_p.y * 0.5 + 0.5) * innerHeight}px)`;
}
let gStrain = 0, gTime = 0, breakupT = 0.6;
// notices: warnings (gear blown back by speed, out of missiles) high in the centre in light red; status (airbrake out,
// gear down) a little below the centre in white; one per row
const notesEl = document.getElementById('notes'), warnsEl = document.getElementById('warns');
let gearWarnT = 0, lastNotes = '', lastWarns = '';
function notes(dt) {
  if (ac.gearBlown) { gearWarnT = 2.5; ac.gearBlown = false; }
  gearWarnT = Math.max(0, gearWarnT - dt);
  // the selected weapon ran dry: back to guns, and say so
  // (the trigger is let go: still holding fire doesn't start the guns, it takes a fresh press)
  if (weapons.S.selected === 2 && weapons.S.stock === 0 && running && !dead) { weapons.setFiring(false); weapons.select(1); outT = 2.5; }
  outT = Math.max(0, outT - dt);
  // warnings: high in the centre, light red, one per row; status: a little below the centre, white, one per row
  const warn = [];
  if (gearWarnT > 0) warn.push('Slow down to extend landing gear!');
  if (outT > 0) warn.push('Out of missiles!');
  const show = running && !dead, row = (t) => `<div>${t}</div>`;
  const w = show ? warn.map(row).join('') : '';
  if (w !== lastWarns) { warnsEl.innerHTML = w; lastWarns = w; }
  // status: each has its own row (airbrake first, gear below), so one coming or going never moves the other
  const st2 = show ? `${+(ac.airbrakeCmd > 0 && ac.airbrake > 0.05)}${+(ac.gearCmd && ac.gear > 0.05)}` : '00';
  if (st2 !== lastNotes) { notesEl.children[0].style.visibility = st2[0] === '1' ? 'visible' : 'hidden'; notesEl.children[1].style.visibility = st2[1] === '1' ? 'visible' : 'hidden'; lastNotes = st2; }
}
// The player's shadow: each frame their jet alone is drawn white-on-black from the sun into a small texture; the
// terrain darkens wherever that silhouette lands beyond them (softer and fainter the higher they are).
const shadowRT = new THREE.WebGLRenderTarget(256, 256);
const shadowCam = new THREE.OrthographicCamera(-14, 14, 14, -14, 1, 400);
shadowCam.layers.set(5);
const shadowMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
jet.object.traverse(o => { if (o.isMesh && o.material.type !== 'ShaderMaterial') o.layers.enable(5); });
const _shadowM = new THREE.Matrix4(), _clr = new THREE.Color();
function playerShadow(time) {
  const U = terrain.uniforms;
  U.uTime.value = time;
  const h = drawPos.y - terrain.heightAt(drawPos.x, drawPos.z);
  const k = jet.object.visible && !viewer.on ? 0.55 * (1 - THREE.MathUtils.smoothstep(h, 150, 900)) : 0;
  U.uShadowK.value = k;
  if (k <= 0) return;
  shadowCam.position.copy(drawPos).addScaledVector(sunDir, 200); shadowCam.lookAt(drawPos); shadowCam.updateMatrixWorld();
  const prevT = renderer.getRenderTarget(), prevA = renderer.getClearAlpha(); renderer.getClearColor(_clr);
  renderer.setRenderTarget(shadowRT); renderer.setClearColor(0x000000, 1); renderer.clear();
  scene.overrideMaterial = shadowMat; renderer.render(scene, shadowCam); scene.overrideMaterial = null;
  renderer.setRenderTarget(prevT); renderer.setClearColor(_clr, prevA);
  U.uShadow.value = shadowRT.texture;
  U.uShadowMat.value.multiplyMatrices(shadowCam.projectionMatrix, shadowCam.matrixWorldInverse);
  U.uShadowPos.value.copy(drawPos);
  U.uShadowSoft.value = 0.002 + Math.min(h, 900) * 0.000025;
}
const flightHud = createFlightHud(document.getElementById('hud'));
const mapHud = createMap(document.getElementById('hud'), terrain);
const ringHud = createRing(document.getElementById('hud'));
const timerEl = document.createElement('div'); timerEl.id = 'mtimer'; document.getElementById('hud').appendChild(timerEl);
function hud(dt = 1 / 60) {
  notes(dt);
  if (bannerT > 0 && (bannerT -= dt) <= 0) hideBanner();
  // the time left before the formation gets out of the mission area (by the map)
  {
    const t = mission && running && !dead && !ending.on ? mission.timeLeft() : Infinity;
    const txt = isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '';
    if (txt !== timerEl.textContent) { timerEl.textContent = txt; timerEl.classList.toggle('low', isFinite(t) && t < 60); }
  }
  if (mission) mapHud.setArea(mission.area);
  if (running && !dead) { flightHud(ac, camera, rig); mapHud(ac, weapons.drones, weapons.S.missiles); }
  const D = CAMERA.aimDistance;
  place(aimEl, _p.copy(camera.position).addScaledVector(rig.fwd, D));
  aimEl.style.opacity = manual ? 0.25 : weapons.S.selected === 1 ? 0.45 : 1;   // (guns: the gun cross is what aims, the steering circle steps back)
  place(noseEl, _n.set(0, 0, 1).applyQuaternion(drawQuat).multiplyScalar(D).add(drawPos));
  if (ac.t.speed > 5) place(fpvEl, _n.copy(ac.vel).normalize().multiplyScalar(D).add(drawPos));
  {   // the flight path marker fades out as it closes on the gun cross, gone a little before they would overlap
    const a = screenOf(_n.copy(ac.vel).normalize().multiplyScalar(D).add(drawPos)), b = screenOf(_p.set(0, 0, 1).applyQuaternion(drawQuat).multiplyScalar(D).add(drawPos));
    const k = a && b ? THREE.MathUtils.smoothstep(Math.hypot(a[0] - b[0], a[1] - b[1]), 26, 70) : 1;
    const o = k.toFixed(2); if (fpvEl.style.opacity !== o) fpvEl.style.opacity = o;
  }
  // weapons HUD
  const W = weapons.S, msl = W.selected === 2;
  noseEl.style.visibility = msl ? 'hidden' : '';
  seekerEl.hidden = lockEl.hidden = !msl;
  if (msl) {
    const nosePt = _n.set(0, 0, 1).applyQuaternion(drawQuat).multiplyScalar(D).add(drawPos);
    place(seekerEl, nosePt);
    const r = Math.tan(WEAPONS.seekerFov / 2 * Math.PI / 180) / Math.tan(camera.fov / 2 * Math.PI / 180) * innerHeight / 2;
    seekerEl.style.width = seekerEl.style.height = `${2 * r}px`; seekerEl.style.margin = `${-r}px 0 0 ${-r}px`;
    const tracking = W.seeker && !W.locked;
    // the lock circle slides from the middle of the seeker onto the target as the lock builds (S.lock / lockTime)
    const ns = screenOf(nosePt), ts = W.seeker ? screenOf(W.seeker.obj.position) : null;
    const k = W.seeker ? THREE.MathUtils.smoothstep(Math.min(W.lock / WEAPONS.lockTime, 1), 0, 1) : 0;
    const at = ns && ts ? [ns[0] + (ts[0] - ns[0]) * k, ns[1] + (ts[1] - ns[1]) * k] : ns;
    if (at) { lockEl.style.display = ''; lockEl.style.transform = `translate(${at[0]}px, ${at[1]}px)`; } else lockEl.style.display = 'none';

    // searching: both circles flash white / red; locked: both solid red
    const st = W.locked ? 'locked' : tracking ? (performance.now() % 250 < 125 ? 'flashW' : 'flashR') : '';
    lockEl.className = st; seekerEl.className = st;
  }
  // enemies: what kind of aircraft it is above each. The distance under that only on a few: the nearest enemy, the
  // one nearest the middle of the screen, and the gun or missile target (nm, then ft inside 1.5 nm; km, then m inside 2 km, like missiles)
  let nearD = null, nearM = Infinity, midD = null, midPx = Infinity;
  for (const d of weapons.drones) {
    if (!d.alive || d.falling || d.hidden) continue;
    const m = d.pos.distanceTo(ac.pos); if (m < nearM) { nearM = m; nearD = d; }
    const q = screenOf(d.obj.position);
    if (q && q[0] >= 0 && q[0] <= innerWidth && q[1] >= 0 && q[1] <= innerHeight) {
      const px = Math.hypot(q[0] - innerWidth / 2, q[1] - innerHeight / 2); if (px < midPx) { midPx = px; midD = d; }
    }
  }
  weapons.drones.forEach((d, k) => {
    let el = tgtEls[k];
    if (!el) {
      el = tgtEls[k] = document.createElement('div');
      el.className = 'mark'; el.innerHTML = '<i></i><b></b>';
      el.firstChild.textContent = d.def.label || 'Fighter';
      tgtEl.parentNode.appendChild(el);
      el._b = el.lastChild; el._txt = '';
    }
    el.hidden = !d.alive || d.falling || !running || d.hidden;
    if (el.hidden) return;
    place(el, d.obj.position);
    const sel = (W.selected === 1 && d === W.target) || (W.selected === 2 && d === W.seeker);   // (a selected target always shows it)
    const txt = d === nearD || d === midD || sel ? distText(d.pos.distanceTo(ac.pos)) : '';
    if (txt !== el._txt) { el._b.innerHTML = txt; el._txt = txt; }
    el.classList.toggle('sel', d === W.target);
  });
  // the ring round the reticle: a pointer toward the nearest enemy, only while no enemy at all is on screen
  {
    let near = null, nd = Infinity, seen = false;
    if (running && !dead) for (const d of weapons.drones) {
      if (!d.alive || d.falling || d.hidden) continue;
      const q = screenOf(d.obj.position);
      if (q && q[0] >= 0 && q[0] <= innerWidth && q[1] >= 0 && q[1] <= innerHeight) { seen = true; break; }
      const dd = d.pos.distanceToSquared(ac.pos); if (dd < nd) { nd = dd; near = d; }
    }
    const items = [];
    if (near && !seen) {
      items.push({ pos: near.obj.position, kind: 'foe', type: near.def.label || 'Fighter', dist: distText(Math.sqrt(nd)) });
    }
    ringHud(screenOf(_n.copy(camera.position).addScaledVector(rig.fwd, D)), items, camera);
  }
  // missiles in flight: a bright solid diamond on each (ours white, or green with the green HUD; the enemy's red), the
  // enemy's with their distance above
  // (nm, then ft inside 1.5 nm; km, then m inside 2 km)
  {
    const ms = weapons.S.missiles;
    for (let k = 0; k < Math.max(ms.length, mslEls.length); k++) {
      let el = mslEls[k];
      if (!el) { el = mslEls[k] = document.createElement('div'); el.className = 'mmark'; el.innerHTML = '<b></b><u></u>'; el._b = el.firstChild; el._txt = ''; tgtEl.parentNode.appendChild(el); }
      const m = ms[k];
      if (!m || !running) { el.style.display = 'none'; continue; }
      if (el._own !== m.owner) { el.classList.toggle('foe', m.owner !== 'player'); el._own = m.owner; }
      // ours: none while the motor burns (the smoke trail shows where it is), fading in as the trail ends; the enemy's:
      // a moment after launch, fading in over half a second
      const burnout = 0.12 + WEAPONS.motorTime;
      const op = m.owner === 'player' ? THREE.MathUtils.clamp((m.t - burnout + 1.1) / 0.6, 0, 1) : THREE.MathUtils.clamp((m.t - 0.2) / 0.5, 0, 1);
      el.style.opacity = op.toFixed(2);
      place(el, m.p);
      if (m.owner === 'player') { if (el._txt) { el._b.innerHTML = ''; el._txt = ''; } continue; }   // (ours: no distance)
      const txt = distText(m.p.distanceTo(ac.pos));
      if (txt !== el._txt) { el._b.innerHTML = txt; el._txt = txt; }
    }
  }
  // gun-solution target: the enemy nearest the reticle on screen, weighted toward ones in gun range, and sticky:
  // the current target is kept while it stays near the reticle, so sweeping past other planes mid-fight doesn't steal it.
  // A new one takes over only if it is clearly better for a moment. Nothing is chosen through terrain.
  // Planes inside gun range are strongly preferred, so a close fight isn't lost to a far-off plane that happens
  // to sit a little nearer the centre.
  {
    const c = screenOf(_p.copy(camera.position).addScaledVector(rig.fwd, CAMERA.aimDistance));
    const score = (d) => {
      if (!d || !d.alive || d.falling || d.hidden || !weapons.clearLine(ac.pos, d.pos)) return Infinity;
      const q = screenOf(d.obj.position);
      if (!q || q[0] < 0 || q[0] > innerWidth || q[1] < 0 || q[1] > innerHeight) return Infinity;
      const px = Math.hypot(q[0] - c[0], q[1] - c[1]), km = d.pos.distanceTo(ac.pos) / 1000;
      const inGun = km * 1000 <= WEAPONS.gunRange;
      // near the reticle and close by wins; inside gun range counts as twice as near the reticle (a strong
      // preference, but a far plane put right under the reticle still takes over from a close one off to the side)
      return (px + 25) * (1 + km / 1.5) * (inGun ? 0.5 : 1);
    };
    let best = null, bestS = Infinity;
    if (c) for (const d of weapons.drones) { const sc = score(d); if (sc < bestS) { bestS = sc; best = d; } }
    const cur = W.target, curS = c ? score(cur) : Infinity;
    if (!isFinite(curS)) { W.target = best; tgtSwitch = 0; }                 // current gone, hidden or off screen
    else if (best && best !== cur && bestS < curS * 0.6) {                    // clearly better...
      tgtSwitch += dt;
      if (tgtSwitch > 0.35) { W.target = best; tgtSwitch = 0; }               // ...for a moment, not a sweep past
    } else tgtSwitch = 0;
  }
  // gun solution: square on the selected enemy, a line, and the lead circle, drawn as one SVG shape so they always join
  // guns selected: the box shows at any range; another weapon selected: only once the target is inside gun range
  const showSel = W.target && running && W.target.alive && !W.target.falling && (W.selected === 1 || (msl && W.target.pos.distanceTo(ac.pos) <= WEAPONS.gunRange));
  const a = showSel ? screenOf(W.target.obj.position) : null;
  const b = showSel && W.lead && W.target.pos.distanceTo(ac.pos) <= WEAPONS.gunRange ? screenOf(W.lead) : null;
  gunSvg.style.display = a ? '' : 'none';
  if (a) {
    const H = 11, R = 6.5;                                 // square half size, circle radius (px)
    gunBox.setAttribute('x', a[0] - H); gunBox.setAttribute('y', a[1] - H);
    gunCirc.style.display = gunLine.style.display = b ? '' : 'none';
    if (b) {
      gunCirc.setAttribute('cx', b[0]); gunCirc.setAttribute('cy', b[1]);
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const from = H / Math.max(Math.abs(ux), Math.abs(uy), 1e-3);
      const show = len > from + R + 1;
      gunLine.style.display = show ? '' : 'none';
      if (show) {
        gunLine.setAttribute('x1', a[0] + ux * from); gunLine.setAttribute('y1', a[1] + uy * from);
        gunLine.setAttribute('x2', b[0] - ux * R); gunLine.setAttribute('y2', b[1] - uy * R);
      }
      const onTarget = _n.subVectors(W.lead, camera.position).normalize().angleTo(rig.fwd) < 0.012;
      gunCirc.setAttribute('fill', onTarget ? 'rgba(255,85,65,0.35)' : 'none');
    }
  }
  xray();
  armsHud(W.selected, W.stock, msl && W.locked);
  if (touchUi) {                                         // the gear button: only when slow or low (or already down)
    const agl = ac.pos.y - terrain.heightAt(ac.pos.x, ac.pos.z);
    touchUi.setGear(running && !dead && tutAllow.gear && (ac.t.ias * 1.944 < 250 || agl < 300 || ac.gearCmd > 0), ac.gearCmd > 0);
    touchUi.setLocked(msl && W.locked);
    touchUi.setWeapon(W.selected);
  }
  aimEl.classList.toggle('stall', ac.t.stall > 0.3);
  thrFill.style.height = `${Math.min(ac.throttle, 1) * 100}%`;
  thrEl.classList.toggle('ab', ac.throttle > 1);
  iasEl.textContent = Math.round(ac.t.ias * 1.94384);
  gEl.textContent = ac.t.g.toFixed(1);
  const g = ac.t.g;
  // G strain (effect only, never a real blackout): builds over about a second of sustained G and eases off faster.
  // From ~6 G the view closes in and drains of colour; at the 9 G limit it is heavy.
  // it only starts after ~3 s spent above 6 G (short pulls never trigger it); the clock drains twice as fast as it fills
  gTime = g > 6 && !dead ? gTime + dt : Math.max(0, gTime - 2 * dt);
  const want = dead ? 0 : THREE.MathUtils.clamp((g - 6) / 3.5, 0, 1) * THREE.MathUtils.smoothstep(gTime, 3, 4);   // (dead: no G effects)
  gStrain += (want - gStrain) * (1 - Math.exp(-dt / (want > gStrain ? 1.0 : 0.6)));
  const k = gStrain;
  vig.style.opacity = (0.95 * Math.pow(k, 1.2) + (dead ? 0 : THREE.MathUtils.clamp((-g - 2.5) / 1, 0, 0.4))).toFixed(3);
  vig.style.setProperty('--inner', `${(35 - 22 * k).toFixed(1)}%`);
  const f = k > 0.01 && !document.body.classList.contains('lost') ? `saturate(${(1 - 0.85 * k).toFixed(2)}) brightness(${(1 - 0.18 * k).toFixed(2)})` : '';
  if (f !== canvas.style.filter) canvas.style.filter = f;
}

// dev performance readout under the dev kit button (remove for release builds)
const perfEl = document.getElementById('perf');
let perfFps = 60, perfT = 0;
function perf(dt) {
  perfFps += (1 / Math.max(dt, 1e-3) - perfFps) * 0.08;
  if ((perfT += dt) < 0.25) return;
  perfT = 0;
  const r = renderer.info.render;
  perfEl.textContent = `${Math.round(perfFps)} FPS\n${(r.triangles / 1000).toFixed(0)}K TRIS\n${r.calls} CALLS`;
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let acc = 0, last = performance.now(), gameT = 0;
function frameBody(now) {
  const dt = Math.min((now - last) / 1000, 0.1); last = now;
  // paused or in the cinematic camera: every effect stands still (the game clock stops)
  overlay.tick(running ? dt : 0);
  const frozen = (started && !running) || viewer.on || overlay.open, vdt = frozen ? 0 : dt;   // (the cinematic camera and tutorial cards freeze the moment too)
  gameT += vdt;
  if (models.on) { models.render(); requestAnimationFrame(frame); return; }   // dev model viewer: its own static scene
  if (running && !overlay.open && !dead) {
    tutorialStep(dt);
    if (mission && !missionEnded) mission.update(dt);
    // the last enemy just went down: the ending
    if (mission && !ending.on && !missionEnded && weapons.drones.length && weapons.drones.every(d => !d.alive || d.falling)) startEnding(true);
    // failed: a bomber got out of the mission area, or the player stayed out of it too long
    else if (mission && !ending.on && !missionEnded && (mission.state.escaped || areaT <= 0)) startEnding(false);
    if (mission?.area && !ending.on) areaCheck(dt);
  }
  if (ending.on && running) endingStep(dt);
  if (running && !overlay.open) {
    if (!ending.on) {                                                     // (in the ending the jet flies on by itself)
    cursorSteer(dt);
    if (recentre > 0 && !manual) rig.recenter(_n.set(0, 0, 1).applyQuaternion(ac.quat), Math.min(1, dt * 12));
    rig.look(mouseDX, mouseDY);
    }
    if (!ending.on && isTouch && weapons.S.lead && weapons.S.selected === 1) {          // aim assist on touch screens
      const toLead = _n.subVectors(weapons.S.lead, camera.position).normalize();
      const off = toLead.angleTo(rig.fwd);
      if (off < 0.08) rig.recenter(toLead, Math.min(1, dt * 6 * WEAPONS.magnetism * (1 - off / 0.08)));
    }
    acc += dt;
    if (dead) {                                                           // killed: watch the wreck, then respawn
      dead += dt; acc = 0;
      for (let k = 0; k < 4; k++) wreckStep(dt / 4);
      ac.pos.copy(wreck.pos); ac.quat.copy(wreck.quat); ac.vel.copy(wreck.vel);
      prevPos.copy(ac.pos); prevQuat.copy(ac.quat);
      if (!wreck.inWater && !wreck.lake) weapons.burn(wreck.pos, wreck.vel, wreck.key);   // (on or in a lake: no fire)
      weapons.step(dt, performance.now() / 1000);
      // a couple of seconds of the wreck, then the picture softens and the death screen comes up (retry waits for the player)
      if (dead > 0.8 && !deathBanner && !ending.on) { deathBanner = true; showBanner('Mission failed', 'fail', 4); }
      if (dead > 2.2 && !deathShown && !window.__holdWreck && !ending.on) {   // (__holdWreck: dev tests watch the wreck to rest)
        deathShown = true; document.body.classList.add('dead-blur');
        overlay.showDeath(() => { spawn(); resume(); });
        if (document.pointerLockElement) document.exitPointerLock();
      }
    } else while (acc >= STEP && !dead) { prevPos.copy(ac.pos); prevQuat.copy(ac.quat); physics(STEP); acc -= STEP; }   // (stop stepping the moment it crashes)
  }
  mouseDX = mouseDY = 0;
  const a = acc / STEP;
  drawPos.lerpVectors(prevPos, ac.pos, a);
  drawQuat.slerpQuaternions(prevQuat, ac.quat, a);
  jet.object.position.copy(drawPos);
  jet.object.quaternion.copy(drawQuat);
  jet.animate(ac, gameT);
  if (vdt > 0) weapons.vapour(dead ? -1 : vdt, drawPos, drawQuat);   // wing vapour / transonic collar, at the drawn jet (dead: all off)
  if (vdt > 0) weapons.contrailsStep(drawPos, drawQuat, running && !dead);
  weapons.render(camera, vdt, gameT, a, drawPos, drawQuat, renderer);
  jet.damage.update(vdt);
  ac.damageFx = jet.damage.effects();
  rig.zoom += ((rig.zooming ? 1 : 0) - rig.zoom) * Math.min(1, dt * 10);
  // tracking: held right click (or the tutorial, a moment after a new enemy appears) turns the view to an enemy: the
  // gun target if there is one, otherwise the nearest
  {
    if (tut.camT > 0) tut.camT -= dt;
    // the aircraft is picked when the button goes down and kept while it's held (nothing else takes the view over);
    // if it goes down, the view zooms back out and it takes a fresh press to track again
    if (!rig.zooming) trackLock = null;
    else if (!trackLock) trackLock = trackTarget();
    if (trackLock && (!trackLock.alive || trackLock.falling)) { rig.zooming = false; trackLock = null; }
    const want = running && !dead && (rig.zooming || tut.camT > 0) ? (tut.camT > 0 ? tut.camD : trackLock) : null;
    if (want) rig.trackPt = want.obj.position;
    rig.trackK += ((want ? 1 : 0) - rig.trackK) * Math.min(1, dt * 4);
  }
  if (viewer.on) viewer.place(); else if (ending.on) endingCamera(dt); else if (dead) {
    const e = 1 - Math.exp(-dt / 1.1);
    deathCam.dist += ((deathCam.far || 85) - deathCam.dist) * e;
    deathCam.pitch += (0.32 - deathCam.pitch) * e * 0.6;
    deathCam.yaw += dt * 0.18;
    const cp = Math.cos(deathCam.pitch);
    camera.position.set(Math.sin(deathCam.yaw) * cp, Math.sin(deathCam.pitch), Math.cos(deathCam.yaw) * cp).multiplyScalar(deathCam.dist).add(drawPos);
    camera.position.y = Math.max(camera.position.y, terrain.heightAt(camera.position.x, camera.position.z) + 15);
    camera.up.set(0, 1, 0); camera.lookAt(drawPos);
    const fov = CAMERA.fov;
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov += (fov - camera.fov) * e; camera.updateProjectionMatrix(); }
  } else rig.update(dt, drawPos, THREE.MathUtils.clamp(ac.t.speed / 450, 0, 1), ac.t.ias);
  // screen shake: explosions near the camera (any shot: flying, the death camera, the ending) and going through the
  // sound barrier; a small, quick wobble of the view that dies away
  if (!dead && !ending.on && ac.t.mach > 0) { const sup = ac.t.mach >= 1; if (sup !== machSide) { if (machSide !== null) shake = Math.min(1, shake + 0.45); machSide = sup; } }
  if (shake > 0.002 && !viewer.on && vdt > 0) {
    shakeT += dt;
    const a = 0.018 * shake, n = (k) => Math.sin(shakeT * (37 + k * 11) + k * 1.7) * 0.6 + Math.sin(shakeT * (61 + k * 7) + k) * 0.4;
    camera.rotateX(n(1) * a); camera.rotateY(n(2) * a); camera.rotateZ(n(3) * a * 0.6);
    shake *= Math.exp(-dt * 2.6);
  }
  sun.position.copy(drawPos).addScaledVector(sunDir, 1000);
  sun.target.position.copy(drawPos);
  sky.position.copy(camera.position);
  camera.updateMatrixWorld();
  terrain.update(camera);
  cloudEl.style.opacity = clouds.update(camera);
  hud(vdt || 1e-6);
  renderer.info.reset();
  playerShadow(gameT);
  renderer.render(scene, camera);
  // heat shimmer behind our own nozzles (dry power a little, afterburner a lot)
  haze.render(camera, dead ? 0 : THREE.MathUtils.clamp(ac.engine, 0, 1) * 0.4 + THREE.MathUtils.clamp((ac.engine - 1) / 0.1, 0, 1) * 0.6, gameT);
  perf(dt);
  window.__dev?.(dt);
  requestAnimationFrame(frame);
}
// Errors: shown in a small box (dev aid; copy it to report) and logged with the stack. The frame loop survives any
// single error, so one bad frame can no longer freeze the whole game.
const errBox = document.createElement('div'); errBox.id = 'errbox'; document.body.appendChild(errBox);
let errCount = 0, lastErr = '';
function reportError(e, where) {
  const msg = `${where}: ${e?.message || e}`;
  console.error('[game]', where, e);
  if (msg === lastErr) { errCount++; } else { lastErr = msg; errCount = 1; }
  errBox.textContent = `${msg}${errCount > 1 ? `  (x${errCount})` : ''}\n${(e?.stack || '').split('\n').slice(1, 5).join('\n')}`;
  errBox.style.display = 'block';
}
addEventListener('error', (e) => reportError(e.error || e.message, 'error'));
addEventListener('unhandledrejection', (e) => reportError(e.reason, 'promise'));
function frame(now) {
  try { frameBody(now); }
  catch (e) { reportError(e, 'frame'); last = now; requestAnimationFrame(frame); }
}
requestAnimationFrame(frame);
// --- dev kit: model viewer -------------------------------------------------------------------
const viewer = {
  on: false, az: 2.4, el: -0.35, dist: 18, drag: null,
  place() {
    const o = jet.object;
    const d = new THREE.Vector3(Math.sin(this.az) * Math.cos(this.el), Math.sin(this.el), Math.cos(this.az) * Math.cos(this.el)).multiplyScalar(this.dist);
    camera.position.copy(o.position).add(d.applyQuaternion(o.quaternion));
    camera.up.set(0, 1, 0).applyQuaternion(o.quaternion);
    camera.lookAt(o.position);
    if (camera.fov !== 40) { camera.fov = 40; camera.updateProjectionMatrix(); }
  },
};
function setViewer(on) {
  viewer.on = on; viewerAnim.active = on;
  document.body.classList.toggle('viewing', on);
  if (!on) document.body.classList.remove('clean');
  if (on) { if (document.pointerLockElement) document.exitPointerLock(); setRunning(false, false); pauseMenu.close(); startEl.classList.remove('show'); }
  else if (started) pauseMenu.open(); else startEl.classList.add('show');
}
canvas.addEventListener('pointerdown', e => { if (viewer.on) { viewer.drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); } });
canvas.addEventListener('pointermove', e => {
  if (!viewer.on || !viewer.drag) return;
  viewer.az -= (e.clientX - viewer.drag[0]) * 0.008;
  viewer.el = THREE.MathUtils.clamp(viewer.el + (e.clientY - viewer.drag[1]) * 0.008, -1.5, 1.5);
  viewer.drag = [e.clientX, e.clientY];
});
canvas.addEventListener('pointerup', () => { viewer.drag = null; });
canvas.addEventListener('wheel', e => { if (viewer.on) { viewer.dist = THREE.MathUtils.clamp(viewer.dist * Math.exp(e.deltaY * 0.001), 4, 60); e.preventDefault(); } }, { passive: false });
// --- dev kit: model viewer (separate static scene) -----------------------------------------------
// the alternative paint schemes, for the model viewer (loaded in the background)
const unmarked = {};
paintEnemy(enemyProto, 'unmarked').then(o => { unmarked.earlyJet = o; });
paintEnemy(bomberProto, 'unmarked').then(o => { unmarked.bomber = o; });
const liveJet = () => jet.object; liveJet.live = true;   // (shown live: animations, afterburner, gear, doors)
const models = createModelViewer(renderer, canvas, scene.environment, {
  'player jet': liveJet,
  'enemy: early jet': Object.assign((paint) => paint === 'unmarked' ? unmarked.earlyJet || enemyProto : enemyProto, { paints: ['standard', 'unmarked'] }),
  'enemy: bomber': Object.assign((paint) => paint === 'unmarked' ? unmarked.bomber || bomberProto : bomberProto, { paints: ['standard', 'unmarked'] }),
  'missile': () => weapons.missileProto,
}, { anim: viewerAnim, jet });
function openModels() {
  if (viewer.on) { setViewer(false); document.querySelectorAll('.lil-gui').forEach(g => { if (g.querySelector('.title')?.textContent === 'cinematic camera') g.style.display = 'none'; }); }
  if (document.pointerLockElement) document.exitPointerLock();
  setRunning(false, false); pauseMenu.close(); startEl.classList.remove('show');
  document.body.classList.add('viewing');
  models.open(() => { document.body.classList.remove('viewing', 'clean'); if (started) pauseMenu.open(); else startEl.classList.add('show'); });
}
document.getElementById('kit-models').addEventListener('click', e => { e.stopPropagation(); kitMenu.hidden = true; openModels(); });
// Space in the cinematic camera: hide / show every overlay for clean shots (not in the model viewer)
addEventListener('keydown', e => {
  if (e.code !== 'Space' || !viewer.on) return;
  e.preventDefault();
  document.body.classList.toggle('clean');
});
const kitBtn = document.getElementById('devkit'), kitMenu = document.getElementById('devmenu');
// dev kit: level, player aircraft, clear all player data
{
  const lv = document.getElementById('kit-level'), pl = document.getElementById('kit-plane');
  lv.value = MODE;
  lv.addEventListener('change', () => { try { localStorage.setItem('thegame.devmode', lv.value); } catch { /* */ } location.reload(); });
  pl.addEventListener('change', () => {});            // (only one aircraft so far)
  // (two clicks: the browser's confirm dialog is blocked inside the page's frame)
  const clr = document.getElementById('kit-clear'); let armedClear = 0;
  clr.addEventListener('click', (e) => {
    e.stopPropagation();
    if (performance.now() - armedClear > 5000) { armedClear = performance.now(); clr.textContent = 'CLICK AGAIN TO DELETE'; setTimeout(() => { clr.textContent = 'CLEAR ALL PLAYER DATA'; }, 5000); return; }
    clearSave(); try { localStorage.removeItem('thegame.devmode'); localStorage.removeItem('thegame.tune2'); } catch { /* */ }
    location.reload();                                    // a fresh start: Mission 1 with the tutorial
  });
  for (const el of [lv, pl]) el.addEventListener('click', (e) => e.stopPropagation());
}
kitBtn.addEventListener('click', e => { e.stopPropagation(); kitMenu.hidden = !kitMenu.hidden; });
document.getElementById('kit-viewer').addEventListener('click', e => {
  e.stopPropagation(); kitMenu.hidden = true;
  setViewer(true);
  import('./dev.js').then(m => m.openViewer(viewerAnim, () => setViewer(false), jet.damage));
});

// touch screens: drag to aim, throttle slider, fire and switch buttons, bigger hit radius
if (isTouch) {
  document.body.classList.add('touch');
  weapons.S.hitScale = 1.5;
  touchUi = createTouch(document.getElementById('touch'), {
    onLook: (dx, dy) => { if (running) { mouseDX += dx; mouseDY += dy; } },
    onThrottle: (v) => { if (tutAllow.throttle) ac.throttle = v; },
    onFire: (on) => { if (running && !dead && !overlay.open) weapons.setFiring(on, performance.now() / 1000); },
    onAirbrake: (on) => { touchBrake = on; },
    onZoom: (on) => { rig.zooming = on; },
    onGear: () => { if (running && !dead) toggleGear(); },
  });
}

window.__game = { ac, rig, terrain, camera, jet, renderer, scene, weapons, crash, wreck, tut, overlay, mission, state: () => ({ running, locked, started, dead }) };
