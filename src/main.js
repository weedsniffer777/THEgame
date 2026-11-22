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
import { createPauseMenu } from './ui/pauseMenu.js';
import { paintEnemy } from './enemy.js';
import { units } from './settings.js';
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
const pauseMenu = createPauseMenu({ onResume: resume });
startEl.addEventListener('click', resume);
addEventListener('keydown', e => {                                       // P: pause / resume
  if (e.code !== 'KeyP' || e.repeat || viewer.on) return;
  if (running) { if (document.pointerLockElement) document.exitPointerLock(); else setRunning(false); }
  else if (started) resume();
});
document.addEventListener('pointerlockchange', () => {
  const was = locked;
  locked = !!document.pointerLockElement;
  if (was && !locked) setRunning(false);
});

const [terrain, jet] = await Promise.all([loadTerrain('terrain/engadin/'), loadJet('models/jets/f5.gltf.json', F5)]);
scene.add(terrain.group, jet.object);
const clouds = createClouds(WORLD.clouds, WORLD.cloudBase);
scene.add(clouds.mesh);
const cloudEl = document.getElementById('cloudfog');

const ac = new Aircraft(F5);
const [enemyProto, bomberProto] = await Promise.all([loadEnemy('earlyJet'), loadEnemy('bomber')]);
const haze = createHeatHaze(renderer, jet.model, NOZZLES);
const weapons = await createWeapons(scene, jet, ac, WEAPONS, terrain, [{ proto: enemyProto, count: WEAPONS.drones - 1 }, { proto: bomberProto, count: 1 }]);
const rig = new CameraRig(camera, CAMERA);
const prevPos = new THREE.Vector3(), prevQuat = new THREE.Quaternion();
const drawPos = new THREE.Vector3(), drawQuat = new THREE.Quaternion();

function spawn() {
  const s = WORLD.spawn;
  ac.reset(new THREE.Vector3(s.x, s.y, s.z), s.heading, s.speed);
  rig.reset(ac.quat);
  prevPos.copy(ac.pos); prevQuat.copy(ac.quat);
  if (typeof weapons !== 'undefined') { weapons.rearm(); jet.damage.repair(); weapons.placeDrones(); }
  dead = 0; jet.object.visible = true; document.body.classList.remove('lost', 'dead');
}
let dead = 0;   // seconds since the player was killed (0 = alive)
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
  if (e.code === 'Digit1') weapons.select(1);
  if (e.code === 'Digit2') weapons.select(2);
  if (e.code === 'KeyR') weapons.cycleTarget();
  if (e.code === 'KeyG' && !e.repeat) ac.gearCmd = ac.gearCmd ? 0 : 1;   // landing gear up / down
  if (e.code === 'Space' && running && !dead && !e.repeat) weapons.setFiring(true, performance.now() / 1000);
});
addEventListener('keyup', e => { if (e.code === 'Space') weapons.setFiring(false); });
addEventListener('mousedown', e => { if (e.button === 0 && running && !dead && e.target === canvas) weapons.setFiring(true, performance.now() / 1000); });
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
  weapons.setFiring(false); document.body.classList.add('dead');   // dead: no shooting, no HUD
  deathCam.far = airborne ? 190 : 85;                                   // broken up: pull right back over the spreading debris
  wreck.airborne = airborne;                                          // (the fuselage still has to hit the ground)
  dead = 1e-6;
  {
    const o = _wv.subVectors(camera.position, ac.pos), L = Math.max(o.length(), 1);
    deathCam.yaw = Math.atan2(o.x, o.z); deathCam.pitch = Math.asin(THREE.MathUtils.clamp(o.y / L, -1, 1)); deathCam.dist = L;
  }
  jet.damage.doomed = true;                                          // every fire on it burns fully again
  wreck.inWater = terrain.isWater(ac.pos.x, ac.pos.z) && ac.pos.y < terrain.heightAt(ac.pos.x, ac.pos.z) + 3;   // (over a lake but still high up: it falls first)
  if (airborne) weapons.explode(ac.pos, ac.vel, 1.0); else weapons.crash(ac.pos, ac.vel, wreck.inWater, ditched);
  wreck.pos.copy(ac.pos); wreck.vel.copy(ac.vel); wreck.quat.copy(ac.quat); wreck.key = {};
  wreck.spin.set(-ac.q, -ac.r, ac.p).applyQuaternion(ac.quat);      // keeps the rotation it had (world axes)
  // hitting the ground tears off everything still attached (the rear fuselage can snap off too, on a hard
  // enough contact: see wreckStep)
  if (!ditched) for (const n of Object.keys(jet.damage.parts)) if (n !== 'tail') jet.damage.breakPart(n, ac.vel);   // (a ditched jet sinks in one piece)
  {
    const x = ac.pos.x, z = ac.pos.z;
    _wn.set(terrain.heightAt(x - 2, z) - terrain.heightAt(x + 2, z), 4, terrain.heightAt(x, z - 2) - terrain.heightAt(x, z + 2)).normalize();
    if (!ditched && ac.vel.dot(_wn) < -20) jet.damage.breakPart('tail', ac.vel);   // into the ground hard: the fuselage snaps behind the wing
  }
  if (wreck.inWater) jet.damage.quench();                              // into a lake: the water puts every fire out
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
  if (!wreck.inWater && terrain.isWater(wreck.pos.x, wreck.pos.z) && wreck.pos.y < terrain.heightAt(wreck.pos.x, wreck.pos.z) + 1.5) {
    wreck.inWater = true; weapons.splash(wreck.pos, wreck.vel, 1.2);
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
    if (vn < 0) {
      // normal impulse (restitution 0.1; a hard hit also crumples, taking extra energy out)
      const k = 1 + _wn.dot(_t1.crossVectors(invI(_t2.crossVectors(_r, _wn), _t2), _r));
      const jn = -(1 + (vn < -20 ? 0 : 0.1)) * vn / k;
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
        const jt = Math.min(sp / kt, 0.9 * jn);
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
  ac.airbrakeCmd = keys.has('KeyB') ? 1 : 0;
  // Tab (or X) up, Shift (or Z) down
  const thUp = keys.has('Tab') || keys.has('KeyX'), thDown = keys.has('ShiftLeft') || keys.has('ShiftRight') || keys.has('KeyZ');
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
      jet.damage.bodyHp -= left.length ? 3 : 8;
      if (!left.length && jet.damage.bodyHp <= 0) { crash(false, true); return; }
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
  if (g.crash) crash(); else if (g.touching && jet.damage.dead) crash(g.water);
  if (g.water && !dead && Math.random() < dt * 12) weapons.spray(ac.pos, ac.vel);   // skimming: spray
}

// HUD
const aimEl = document.getElementById('aim'), noseEl = document.getElementById('nose');
const thrEl = document.getElementById('throttle'), thrFill = thrEl.firstElementChild, vig = document.getElementById('vignette');
const _p = new THREE.Vector3();
const _n = new THREE.Vector3(), fpvEl = document.getElementById('fpv');
const seekerEl = document.getElementById('seeker'), lockEl = document.getElementById('lockc'), tgtEl = document.getElementById('tgt'), tgtEls = [], mslEls = [];
const armsHud = createArmsHud(document.getElementById('arms'), WEAPONS.missiles);
const gunSvg = document.getElementById('gunsol'), [gunBox, gunLine, gunCirc] = gunSvg.children;
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
// notices (red, high centre, stacked): airbrake out, gear down, gear blown back by speed
const notesEl = document.getElementById('notes');
let gearWarnT = 0, lastNotes = '';
function notes(dt) {
  if (ac.gearBlown) { gearWarnT = 2.5; ac.gearBlown = false; }
  gearWarnT = Math.max(0, gearWarnT - dt);
  const list = [];
  if (gearWarnT > 0) list.push('SLOW DOWN TO EXTEND LANDING GEAR!');
  if (ac.airbrakeCmd > 0 && ac.airbrake > 0.05) list.push('AIRBRAKE ON');
  if (ac.gearCmd && ac.gear > 0.05) list.push('LANDING GEAR EXTENDED');
  const html = running && !dead ? list.map(t => `<div>${t}</div>`).join('') : '';
  if (html !== lastNotes) { notesEl.innerHTML = html; lastNotes = html; }
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
function hud(dt = 1 / 60) {
  notes(dt);
  if (running && !dead) flightHud(ac, camera, rig);
  const D = CAMERA.aimDistance;
  place(aimEl, _p.copy(camera.position).addScaledVector(rig.fwd, D));
  aimEl.style.opacity = manual ? 0.25 : 1;
  place(noseEl, _n.set(0, 0, 1).applyQuaternion(drawQuat).multiplyScalar(D).add(drawPos));
  if (ac.t.speed > 5) place(fpvEl, _n.copy(ac.vel).normalize().multiplyScalar(D).add(drawPos));
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
    place(lockEl, W.locked && W.seeker ? W.seeker.obj.position : nosePt);
    // searching: both circles flash white / red; locked: both solid red
    const st = W.locked ? 'locked' : tracking ? (performance.now() % 250 < 125 ? 'flashW' : 'flashR') : '';
    lockEl.className = st; seekerEl.className = st;
  }
  // enemies: what kind of aircraft it is above it, its distance in km under that (counts down as you close)
  weapons.drones.forEach((d, k) => {
    let el = tgtEls[k];
    if (!el) {
      el = tgtEls[k] = document.createElement('div');
      el.className = 'mark'; el.innerHTML = '<i></i><b></b>';
      el.firstChild.textContent = d.def.label || 'Fighter';
      tgtEl.parentNode.appendChild(el);
      el._b = el.lastChild; el._txt = '';
    }
    el.hidden = !d.alive || d.falling || !running;
    if (el.hidden) return;
    place(el, d.obj.position);
    const dist = units.dist(d.pos.distanceTo(ac.pos));
    const txt = (dist < 10 ? dist.toFixed(1) : Math.round(dist).toString()) + units.distLabel();
    if (txt !== el._txt) { el._b.innerHTML = `${txt.replace(/[A-Z]+$/, '')}<small>${units.distLabel()}</small>`; el._txt = txt; }
    el.classList.toggle('sel', d === W.target);
  });
  // missiles in flight: a diamond on each, blue for ours, red for the enemy's
  {
    const ms = weapons.S.missiles;
    for (let k = 0; k < Math.max(ms.length, mslEls.length); k++) {
      let el = mslEls[k];
      if (!el) { el = mslEls[k] = document.createElement('div'); el.className = 'mmark'; tgtEl.parentNode.appendChild(el); }
      const m = ms[k];
      if (!m || !running) { el.style.display = 'none'; continue; }
      if (el._own !== m.owner) { el.classList.toggle('foe', m.owner !== 'player'); el._own = m.owner; }
      // none for a moment after launch, then it fades in over half a second
      const op = THREE.MathUtils.clamp((m.t - 0.2) / 0.5, 0, 1);
      el.style.opacity = op.toFixed(2);
      place(el, m.p);
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
      if (!d || !d.alive || d.falling || !weapons.clearLine(ac.pos, d.pos)) return Infinity;
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
  const showSel = W.target && running && W.target.alive && !W.target.falling && (!msl || W.target.pos.distanceTo(ac.pos) <= WEAPONS.gunRange);
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
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1); last = now;
  // paused or in the cinematic camera: every effect stands still (the game clock stops)
  const frozen = (started && !running) || viewer.on, vdt = frozen ? 0 : dt;   // (the cinematic camera freezes the moment too)
  gameT += vdt;
  if (models.on) { models.render(); requestAnimationFrame(frame); return; }   // dev model viewer: its own static scene
  if (running) {
    cursorSteer(dt);
    if (recentre > 0 && !manual) rig.recenter(_n.set(0, 0, 1).applyQuaternion(ac.quat), Math.min(1, dt * 12));
    rig.look(mouseDX, mouseDY);
    if (isTouch && weapons.S.lead && weapons.S.selected === 1) {          // aim assist on touch screens
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
      if (!wreck.inWater) weapons.burn(wreck.pos, wreck.vel, wreck.key);
      weapons.step(dt, performance.now() / 1000);
      if (dead > 9 && !window.__holdWreck) spawn();   // (__holdWreck: dev tests watch the wreck to rest)
    } else while (acc >= STEP && !dead) { prevPos.copy(ac.pos); prevQuat.copy(ac.quat); physics(STEP); acc -= STEP; }   // (stop stepping the moment it crashes)
  }
  mouseDX = mouseDY = 0;
  const a = acc / STEP;
  drawPos.lerpVectors(prevPos, ac.pos, a);
  drawQuat.slerpQuaternions(prevQuat, ac.quat, a);
  jet.object.position.copy(drawPos);
  jet.object.quaternion.copy(drawQuat);
  jet.animate(ac, gameT);
  if (running && !dead) weapons.vapour(vdt, drawPos, drawQuat);   // wing vapour / transonic collar, at the drawn jet
  if (vdt > 0) weapons.contrailsStep(drawPos, drawQuat, running && !dead);
  weapons.render(camera, vdt, gameT, a, drawPos, drawQuat, renderer);
  jet.damage.update(vdt);
  ac.damageFx = jet.damage.effects();
  rig.zoom += ((rig.zooming ? 1 : 0) - rig.zoom) * Math.min(1, dt * 10);
  if (viewer.on) viewer.place(); else if (dead) {
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
const models = createModelViewer(renderer, canvas, scene.environment, {
  'player jet': () => jet.object,
  'enemy: early jet': () => enemyProto,
  'enemy: bomber': () => bomberProto,
  'enemy: early jet (unmarked)': () => unmarked.earlyJet || enemyProto,
  'enemy: bomber (unmarked)': () => unmarked.bomber || bomberProto,
  'missile': () => weapons.missileProto,
});
function openModels() {
  if (viewer.on) { setViewer(false); document.querySelectorAll('.lil-gui').forEach(g => { if (g.querySelector('.title')?.textContent === 'cinematic camera') g.style.display = 'none'; }); }
  if (document.pointerLockElement) document.exitPointerLock();
  setRunning(false, false); pauseMenu.close(); startEl.classList.remove('show');
  document.body.classList.add('viewing');
  models.open(() => { document.body.classList.remove('viewing', 'clean'); if (started) pauseMenu.open(); else startEl.classList.add('show'); });
}
document.getElementById('kit-models').addEventListener('click', e => { e.stopPropagation(); kitMenu.hidden = true; openModels(); });
// Space in the cinematic camera or model viewer: hide / show every overlay for clean shots
addEventListener('keydown', e => {
  if (e.code !== 'Space' || !(viewer.on || models.on)) return;
  e.preventDefault();
  document.body.classList.toggle('clean');
});
const kitBtn = document.getElementById('devkit'), kitMenu = document.getElementById('devmenu');
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
  createTouch(document.getElementById('touch'), {
    onLook: (dx, dy) => { if (running) { mouseDX += dx; mouseDY += dy; } },
    onThrottle: (v) => { ac.throttle = v; },
    onFire: (on) => { if (running && !dead) weapons.setFiring(on, performance.now() / 1000); },
    onSwitch: () => weapons.select(weapons.S.selected === 1 ? 2 : 1),
  });
}

window.__game = { ac, rig, terrain, camera, jet, renderer, scene, weapons, crash, wreck };
