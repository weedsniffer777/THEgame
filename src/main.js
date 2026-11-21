import * as THREE from 'three';
import { F5, INSTRUCTOR, CAMERA, WORLD, loadTuning } from './config.js';
import { Aircraft } from './flight/aircraft.js';
import { instruct } from './flight/instructor.js';
import { CameraRig } from './camera.js';
import { createSky, setSun } from './world/sky.js';
import { loadTerrain } from './world/terrain.js';
import { loadJet } from './jet.js';

loadTuning();
const STEP = 1 / 120;
const params = new URLSearchParams(location.search);

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, WORLD.pixelRatio));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 2, 160000);

const sky = createSky();
scene.add(sky);
const sunDir = setSun();
const sun = new THREE.DirectionalLight(0xfff1dc, WORLD.sunIntensity);
scene.add(sun, sun.target, new THREE.HemisphereLight(0xb8d0f0, 0x5a5040, 0.6));
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene(); envScene.add(createSky());
scene.environment = pmrem.fromScene(envScene, 0, 1, 2000).texture;

const [terrain, jet] = await Promise.all([loadTerrain('terrain/engadin/'), loadJet('models/jets/f5.glb')]);
scene.add(terrain.group, jet.object);

const ac = new Aircraft(F5);
const rig = new CameraRig(camera, CAMERA);
const prevPos = new THREE.Vector3(), prevQuat = new THREE.Quaternion();
const drawPos = new THREE.Vector3(), drawQuat = new THREE.Quaternion();

function spawn() {
  const s = WORLD.spawn;
  ac.reset(new THREE.Vector3(s.x, s.y, s.z), s.heading, s.speed);
  rig.reset(ac.quat);
  prevPos.copy(ac.pos); prevQuat.copy(ac.quat);
}
spawn();

// input
const keys = new Set();
let running = false, mouseDX = 0, mouseDY = 0, abHold = 0;
addEventListener('keydown', e => { keys.add(e.code); if (e.code === 'Backquote') import('./dev.js').then(m => m.toggleDev({ ac, terrain, renderer, spawn })); });
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
addEventListener('mousemove', e => { if (running) { mouseDX += e.movementX; mouseDY += e.movementY; } });
addEventListener('mousedown', e => { if (e.button === 2) rig.zooming = true; });
addEventListener('mouseup', e => { if (e.button === 2) rig.zooming = false; });
addEventListener('contextmenu', e => e.preventDefault());
const startEl = document.getElementById('start');
function setRunning(on) { running = on; startEl.classList.toggle('show', !on); }
startEl.addEventListener('click', () => {
  const lock = canvas.requestPointerLock?.();
  if (lock?.catch) lock.catch(() => {});
  setRunning(true);
});
document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement) setRunning(false); });
if (params.has('autostart')) setRunning(true);

function axis(neg, pos) { return (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0); }

function physics(dt) {
  // throttle: W/S, holding W at full power lights the afterburner
  const th = axis('KeyS', 'KeyW');
  if (th > 0 && ac.throttle >= 1) { abHold += dt; if (abHold > 0.25) ac.throttle = 1.1; }
  else { abHold = 0; if (th) ac.throttle = THREE.MathUtils.clamp(Math.min(ac.throttle, 1) + th * 0.6 * dt, 0, 1); }
  instruct(ac, rig.fwd, INSTRUCTOR, { roll: axis('KeyA', 'KeyD'), yaw: axis('KeyQ', 'KeyE'), pitch: 0 });
  ac.step(dt);
  if (ac.pos.y < terrain.heightAt(ac.pos.x, ac.pos.z) + 1.5) spawn();
}

// HUD
const aimEl = document.getElementById('aim'), noseEl = document.getElementById('nose');
const thrEl = document.getElementById('throttle'), thrFill = thrEl.firstElementChild, vig = document.getElementById('vignette');
const _p = new THREE.Vector3();
function place(el, worldPoint) {
  _p.copy(worldPoint).project(camera);
  const vis = _p.z < 1;
  el.style.display = vis ? '' : 'none';
  if (vis) el.style.transform = `translate(${(_p.x * 0.5 + 0.5) * innerWidth}px, ${(-_p.y * 0.5 + 0.5) * innerHeight}px)`;
}
function hud() {
  place(aimEl, _p.copy(camera.position).addScaledVector(rig.fwd, 3000));
  place(noseEl, new THREE.Vector3(0, 0, 1).applyQuaternion(drawQuat).multiplyScalar(1500).add(drawPos));
  aimEl.classList.toggle('stall', ac.t.stall > 0.3);
  thrFill.style.height = `${Math.min(ac.throttle, 1) * 100}%`;
  thrEl.classList.toggle('ab', ac.throttle > 1);
  const g = ac.t.g;
  vig.style.opacity = THREE.MathUtils.clamp((g - 5) / 4, 0, 0.85) + THREE.MathUtils.clamp((-g - 1.5) / 3, 0, 0.6);
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
  rig.zoom += ((rig.zooming ? 1 : 0) - rig.zoom) * Math.min(1, dt * 10);
  rig.update(dt, drawPos, THREE.MathUtils.clamp(ac.t.speed / 450, 0, 1));
  sun.position.copy(drawPos).addScaledVector(sunDir, 1000);
  sun.target.position.copy(drawPos);
  sky.position.copy(camera.position);
  camera.updateMatrixWorld();
  terrain.update(camera);
  hud();
  renderer.render(scene, camera);
  window.__dev?.(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__game = { ac, rig, terrain, camera };
