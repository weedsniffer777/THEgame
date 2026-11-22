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
const enemyProto = await loadEnemy('earlyJet');
const weapons = await createWeapons(scene, jet, ac, WEAPONS, terrain, enemyProto);
const rig = new CameraRig(camera, CAMERA);
const prevPos = new THREE.Vector3(), prevQuat = new THREE.Quaternion();
const drawPos = new THREE.Vector3(), drawQuat = new THREE.Quaternion();

function spawn() {
  const s = WORLD.spawn;
  ac.reset(new THREE.Vector3(s.x, s.y, s.z), s.heading, s.speed);
  rig.reset(ac.quat);
  prevPos.copy(ac.pos); prevQuat.copy(ac.quat);
  if (typeof weapons !== 'undefined') { weapons.rearm(); jet.damage.repair(); weapons.placeDrones(); }
  dead = 0; jet.object.visible = true; document.body.classList.remove('lost');
}
let dead = 0;   // seconds since the player was killed (0 = alive)
let tgtSwitch = 0;   // how long a better gun target has been waiting to take over
spawn();

// input
const keys = new Set();
let mouseDX = 0, mouseDY = 0, abHold = 0;
const GAME_KEYS = new Set(['Space', 'Tab', 'ShiftLeft', 'ShiftRight', 'KeyZ', 'KeyX', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyB', 'Digit1', 'Digit2', 'KeyR']);
addEventListener('keydown', e => { if (GAME_KEYS.has(e.code)) e.preventDefault(); keys.add(e.code); if (e.code === 'Backquote') import('./dev.js').then(m => m.toggleDev({ ac, terrain, renderer, spawn })); });
addEventListener('keyup', e => keys.delete(e.code));
// weapons: 1 guns, 2 missiles; Space or left mouse fires
addEventListener('keydown', e => {
  if (e.code === 'Digit1') weapons.select(1);
  if (e.code === 'Digit2') weapons.select(2);
  if (e.code === 'KeyR') weapons.cycleTarget();
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
  if (locked || cursorX === null || isTouch) return;   // phones fake mouse moves on taps: never steer from those
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
let manual = false, recentre = 0;   // seconds left of easing the camera back onto the nose after keyboard flying
// crash: the jet blows up and burns on the ground; the camera holds on it for a few seconds before respawning
function crash() {
  if (dead) return;
  dead = 1e-6;
  weapons.crash(ac.pos, ac.vel, jet);
  jet.object.visible = false;
  document.body.classList.remove('lost');
}
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
  if (kb.active) recentre = 0.45; else if (recentre > 0) recentre -= dt;
  manual = kb.active;
  aimPoint.copy(camera.position).addScaledVector(rig.fwd, CAMERA.aimDistance);
  const lost = jet.damage.dead;
  if (lost) { ac.input.pitch *= 0.97; ac.input.roll = 0.6; ac.input.yaw = 0.2; ac.throttle = 0; }   // plane lost: no control, it rolls off and goes in
  else instruct(ac, aimPoint, INSTRUCTOR, kb, dt);
  document.body.classList.toggle('lost', lost);
  ac.step(dt);
  weapons.step(dt, performance.now() / 1000);
  if (ac.pos.y < terrain.heightAt(ac.pos.x, ac.pos.z) + 1.5) crash();
}

// HUD
const aimEl = document.getElementById('aim'), noseEl = document.getElementById('nose');
const thrEl = document.getElementById('throttle'), thrFill = thrEl.firstElementChild, vig = document.getElementById('vignette');
const _p = new THREE.Vector3();
const _n = new THREE.Vector3(), fpvEl = document.getElementById('fpv');
const seekerEl = document.getElementById('seeker'), lockEl = document.getElementById('lockc'), tgtEl = document.getElementById('tgt'), tgtEls = [];
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
function hud(dt = 1 / 60) {
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
  // enemies: a solid diamond above each one with its distance in km (counts down as you close)
  weapons.drones.forEach((d, k) => {
    let el = tgtEls[k];
    if (!el) {
      el = tgtEls[k] = document.createElement('div');
      el.className = 'mark'; el.innerHTML = '<i></i><b></b>';
      tgtEl.parentNode.appendChild(el);
      el._b = el.lastChild; el._txt = '';
    }
    el.hidden = !d.alive || d.falling || !running;
    if (el.hidden) return;
    place(el, d.obj.position);
    const km = d.pos.distanceTo(ac.pos) / 1000;
    const txt = km < 10 ? km.toFixed(1) : Math.round(km).toString();
    if (txt !== el._txt) { el._b.innerHTML = `${txt}<small>KM</small>`; el._txt = txt; }
    el.classList.toggle('sel', d === W.target && !msl);
  });
  // gun-solution target: the enemy nearest the reticle on screen, weighted toward ones in gun range, and sticky:
  // the current target is kept while it stays near the reticle, so sweeping past other planes mid-fight doesn't steal it.
  // A new one takes over only if it is clearly better for a moment. Nothing is chosen through terrain.
  {
    const c = screenOf(_p.copy(camera.position).addScaledVector(rig.fwd, CAMERA.aimDistance));
    const score = (d) => {
      if (!d || !d.alive || d.falling || !weapons.clearLine(ac.pos, d.pos)) return Infinity;
      const q = screenOf(d.obj.position);
      if (!q || q[0] < 0 || q[0] > innerWidth || q[1] < 0 || q[1] > innerHeight) return Infinity;
      const px = Math.hypot(q[0] - c[0], q[1] - c[1]), km = d.pos.distanceTo(ac.pos) / 1000;
      return px * (1 + km / 1.5);          // near the reticle and close by wins
    };
    let best = null, bestS = Infinity;
    if (c) for (const d of weapons.drones) { const sc = score(d); if (sc < bestS) { bestS = sc; best = d; } }
    const cur = W.target, curS = c ? score(cur) : Infinity;
    if (!isFinite(curS)) { W.target = best; tgtSwitch = 0; }                 // current gone, hidden or off screen
    else if (best && best !== cur && bestS < curS * 0.4) {                    // clearly better...
      tgtSwitch += dt;
      if (tgtSwitch > 0.35) { W.target = best; tgtSwitch = 0; }               // ...for a moment, not a sweep past
    } else tgtSwitch = 0;
  }
  // gun solution: square on the selected enemy, a line, and the lead circle, drawn as one SVG shape so they always join
  const showSel = W.target && !msl && running && W.target.alive && !W.target.falling;
  const a = showSel ? screenOf(W.target.obj.position) : null;
  const b = showSel && W.lead && W.leadTime <= 2.5 ? screenOf(W.lead) : null;
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
    if (dead) {                                                           // killed: watch the crash site, then respawn
      dead += dt; acc = 0;
      weapons.step(dt, performance.now() / 1000);
      if (dead > 4) spawn();
    } else while (acc >= STEP) { prevPos.copy(ac.pos); prevQuat.copy(ac.quat); physics(STEP); acc -= STEP; }
  }
  mouseDX = mouseDY = 0;
  const a = acc / STEP;
  drawPos.lerpVectors(prevPos, ac.pos, a);
  drawQuat.slerpQuaternions(prevQuat, ac.quat, a);
  jet.object.position.copy(drawPos);
  jet.object.quaternion.copy(drawQuat);
  jet.animate(ac);
  weapons.render(camera, dt, now / 1000, a, drawPos, drawQuat, renderer);
  jet.damage.update(dt);
  ac.damageFx = jet.damage.effects();
  rig.zoom += ((rig.zooming ? 1 : 0) - rig.zoom) * Math.min(1, dt * 10);
  if (viewer.on) viewer.place(); else if (dead) { camera.lookAt(drawPos); } else rig.update(dt, drawPos, THREE.MathUtils.clamp(ac.t.speed / 450, 0, 1), ac.t.ias);
  sun.position.copy(drawPos).addScaledVector(sunDir, 1000);
  sun.target.position.copy(drawPos);
  sky.position.copy(camera.position);
  camera.updateMatrixWorld();
  terrain.update(camera);
  cloudEl.style.opacity = clouds.update(camera);
  hud(dt);
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
  if (!on) document.body.classList.remove('clean');
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
// --- dev kit: model viewer (separate static scene) -----------------------------------------------
const models = createModelViewer(renderer, canvas, scene.environment, {
  'player jet': () => jet.object,
  'enemy: early jet': () => enemyProto,
  'missile': () => weapons.missileProto,
});
function openModels() {
  if (viewer.on) { setViewer(false); document.querySelectorAll('.lil-gui').forEach(g => { if (g.querySelector('.title')?.textContent === 'cinematic camera') g.style.display = 'none'; }); }
  if (document.pointerLockElement) document.exitPointerLock();
  setRunning(false); startEl.classList.remove('show');
  document.body.classList.add('viewing');
  models.open(() => { document.body.classList.remove('viewing', 'clean'); startEl.classList.add('show'); });
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
    onFire: (on) => { if (running) weapons.setFiring(on, performance.now() / 1000); },
    onSwitch: () => weapons.select(weapons.S.selected === 1 ? 2 : 1),
  });
}

window.__game = { ac, rig, terrain, camera, jet, renderer, scene, weapons };
