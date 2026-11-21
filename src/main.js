import * as THREE from 'three';
import { F5, INSTRUCTOR, CAMERA, WORLD, WEAPONS, loadTuning } from './config.js';
import { Aircraft } from './flight/aircraft.js';
import { instruct } from './flight/instructor.js';
import { CameraRig } from './camera.js';
import { createSky, setSun } from './world/sky.js';
import { loadTerrain } from './world/terrain.js';
import { loadJet, viewerAnim } from './jet.js';
import { createClouds } from './world/clouds.js';
import { createWeapons } from './weapons.js';

loadTuning();
const STEP = 1 / 120;
const params = new URLSearchParams(location.search);

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
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
let ready = false, wantStart = params.has('autostart'), running = false, locked = false;
function setRunning(on) { wantStart = on; running = on && ready; startEl.classList.toggle('show', !running); }
startEl.addEventListener('click', () => {
  try { const lock = canvas.requestPointerLock?.(); lock?.catch?.(() => {}); } catch { /* no pointer lock here */ }
  setRunning(true);
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
const weapons = await createWeapons(scene, jet, ac, WEAPONS, terrain);
const rig = new CameraRig(camera, CAMERA);
const prevPos = new THREE.Vector3(), prevQuat = new THREE.Quaternion();
const drawPos = new THREE.Vector3(), drawQuat = new THREE.Quaternion();

function spawn() {
  const s = WORLD.spawn;
  ac.reset(new THREE.Vector3(s.x, s.y, s.z), s.heading, s.speed);
  rig.reset(ac.quat);
  prevPos.copy(ac.pos); prevQuat.copy(ac.quat);
  if (typeof weapons !== 'undefined') { weapons.rearm(); jet.damage.repair(); }
}
spawn();

// input
const keys = new Set();
let mouseDX = 0, mouseDY = 0, abHold = 0;
const GAME_KEYS = new Set(['Space', 'Tab', 'ShiftLeft', 'ShiftRight', 'KeyZ', 'KeyX', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyB', 'Digit1', 'Digit2']);
addEventListener('keydown', e => { if (GAME_KEYS.has(e.code)) e.preventDefault(); keys.add(e.code); if (e.code === 'Backquote') import('./dev.js').then(m => m.toggleDev({ ac, terrain, renderer, spawn })); });
addEventListener('keyup', e => keys.delete(e.code));
// weapons: 1 guns, 2 missiles; Space or left mouse fires
addEventListener('keydown', e => {
  if (e.code === 'Digit1') weapons.select(1);
  if (e.code === 'Digit2') weapons.select(2);
  if (e.code === 'Space' && running && !e.repeat) weapons.setFiring(true, performance.now() / 1000);
});
addEventListener('keyup', e => { if (e.code === 'Space') weapons.setFiring(false); });
addEventListener('mousedown', e => { if (e.button === 0 && running && e.target === canvas) weapons.setFiring(true, performance.now() / 1000); });
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
  if (locked || cursorX === null) return;
  const s = Math.min(innerWidth, innerHeight) / 2;
  const dead = (v) => Math.sign(v) * Math.max(Math.abs(v) - 0.06, 0);
  mouseDX += dead((cursorX - innerWidth / 2) / s) * 900 * dt;
  mouseDY += dead((cursorY - innerHeight / 2) / s) * 900 * dt;
}
addEventListener('mousedown', e => { if (e.button === 2) rig.zooming = true; });
addEventListener('mouseup', e => { if (e.button === 2) rig.zooming = false; });
addEventListener('contextmenu', e => e.preventDefault());
ready = true;
startEl.classList.remove('loading');
setRunning(wantStart);

const aimPoint = new THREE.Vector3();
let manual = false;
function axis(neg, pos) { return (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0); }

function physics(dt) {
  // throttle; holding throttle-up at full power lights the afterburner (Space stays free for guns)
  ac.airbrakeCmd = keys.has('KeyB') ? 1 : 0;
  // Tab (or X) up, Shift (or Z) down
  const thUp = keys.has('Tab') || keys.has('KeyX'), thDown = keys.has('ShiftLeft') || keys.has('ShiftRight') || keys.has('KeyZ');
  const th = (thUp ? 1 : 0) - (thDown ? 1 : 0);
  if (th > 0 && ac.throttle >= 1) { abHold += dt; if (abHold > 0.25) ac.throttle = 1.1; }
  else { abHold = 0; if (th) ac.throttle = THREE.MathUtils.clamp(Math.min(ac.throttle, 1) + th * 0.6 * dt, 0, 1); }
  const kb = { pitch: axis('KeyW', 'KeyS'), roll: axis('KeyA', 'KeyD'), yaw: axis('KeyQ', 'KeyE') };
  kb.active = !!(kb.pitch || kb.roll);
  manual = kb.active;
  aimPoint.copy(camera.position).addScaledVector(rig.fwd, CAMERA.aimDistance);
  instruct(ac, aimPoint, INSTRUCTOR, kb, dt);
  ac.step(dt);
  weapons.step(dt, performance.now() / 1000);
  if (ac.pos.y < terrain.heightAt(ac.pos.x, ac.pos.z) + 1.5) spawn();
}

// HUD
const aimEl = document.getElementById('aim'), noseEl = document.getElementById('nose');
const thrEl = document.getElementById('throttle'), thrFill = thrEl.firstElementChild, vig = document.getElementById('vignette');
const _p = new THREE.Vector3();
const _n = new THREE.Vector3(), fpvEl = document.getElementById('fpv');
const seekerEl = document.getElementById('seeker'), lockEl = document.getElementById('lockc'), tgtEl = document.getElementById('tgt');
const pipsEl = document.getElementById('pips'), pipEls = [...pipsEl.children];
const iasEl = document.getElementById('ias'), gEl = document.getElementById('gload');
function place(el, worldPoint) {
  _p.copy(worldPoint).project(camera);
  const vis = _p.z < 1;
  el.style.display = vis ? '' : 'none';
  if (vis) el.style.transform = `translate(${(_p.x * 0.5 + 0.5) * innerWidth}px, ${(-_p.y * 0.5 + 0.5) * innerHeight}px)`;
}
function hud() {
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
    lockEl.className = W.locked ? 'locked' : tracking && (performance.now() % 250 < 125) ? 'flash' : '';
    seekerEl.className = W.locked ? 'locked' : '';
  }
  const dr = weapons.drone;
  tgtEl.hidden = !dr.alive || !running;
  if (dr.alive) place(tgtEl, dr.obj.position);
  pipEls.forEach((p, k) => { p.className = k < W.stock ? 'on' : ''; });
  pipsEl.classList.toggle('sel', msl);
  aimEl.classList.toggle('stall', ac.t.stall > 0.3);
  thrFill.style.height = `${Math.min(ac.throttle, 1) * 100}%`;
  thrEl.classList.toggle('ab', ac.throttle > 1);
  iasEl.textContent = Math.round(ac.t.ias * 1.94384);
  gEl.textContent = ac.t.g.toFixed(1);
  const g = ac.t.g;
  // effect only, never a real blackout: starts near 8.5 G, heavy by 10 G
  vig.style.opacity = THREE.MathUtils.clamp((g - 8.5) / 1.5, 0, 0.7) + THREE.MathUtils.clamp((-g - 2.5) / 1, 0, 0.4);
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let acc = 0, last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1); last = now;
  if (running) {
    cursorSteer(dt);
    rig.look(mouseDX, mouseDY);
    acc += dt;
    while (acc >= STEP) { prevPos.copy(ac.pos); prevQuat.copy(ac.quat); physics(STEP); acc -= STEP; }
  }
  mouseDX = mouseDY = 0;
  const a = acc / STEP;
  drawPos.lerpVectors(prevPos, ac.pos, a);
  drawQuat.slerpQuaternions(prevQuat, ac.quat, a);
  jet.object.position.copy(drawPos);
  jet.object.quaternion.copy(drawQuat);
  jet.animate(ac);
  weapons.render(camera, dt, now / 1000, a, drawPos, drawQuat);
  jet.damage.update(dt);
  ac.damageFx = jet.damage.effects();
  rig.zoom += ((rig.zooming ? 1 : 0) - rig.zoom) * Math.min(1, dt * 10);
  if (viewer.on) viewer.place(); else rig.update(dt, drawPos, THREE.MathUtils.clamp(ac.t.speed / 450, 0, 1));
  sun.position.copy(drawPos).addScaledVector(sunDir, 1000);
  sun.target.position.copy(drawPos);
  sky.position.copy(camera.position);
  camera.updateMatrixWorld();
  terrain.update(camera);
  cloudEl.style.opacity = clouds.update(camera);
  hud();
  renderer.render(scene, camera);
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
  if (on) { if (document.pointerLockElement) document.exitPointerLock(); setRunning(false); startEl.classList.remove('show'); }
  else startEl.classList.add('show');
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
const kitBtn = document.getElementById('devkit'), kitMenu = document.getElementById('devmenu');
kitBtn.addEventListener('click', e => { e.stopPropagation(); kitMenu.hidden = !kitMenu.hidden; });
document.getElementById('kit-viewer').addEventListener('click', e => {
  e.stopPropagation(); kitMenu.hidden = true;
  setViewer(true);
  import('./dev.js').then(m => m.openViewer(viewerAnim, () => setViewer(false), jet.damage));
});

window.__game = { ac, rig, terrain, camera, jet, renderer, scene, weapons };
