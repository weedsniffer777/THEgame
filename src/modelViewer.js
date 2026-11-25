import * as THREE from 'three';
import { F5_PAINTS, F5_DEFAULT_PAINT } from './jet.js';
import GUI from 'lil-gui';
import { Damage } from './damage.js';
import { setBombBay } from './enemy.js';
import { TUNABLE, saveTuning, resetGroup } from './config.js';

// Dev kit model viewer: a separate, static scene (neutral studio light, ground grid) to inspect any model in the game.
// Drag to orbit, wheel to zoom, pick the model (and its paint) from the list. It has everything the cinematic
// camera has: the player jet is shown live (every animation, afterburner, gear, doors), and any model can have its
// parts broken off and repaired (the pieces fall away in the viewer).
const NO_GROUND = { heightAt: () => -1e9, isWater: () => false };
export function createModelViewer(renderer, canvas, environment, models, { anim, jet } = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x26303b);
  scene.environment = environment;
  scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x3a3530, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(5, 8, 6); scene.add(key);
  const grid = new THREE.GridHelper(40, 40, 0x56636f, 0x3a4550); grid.position.y = -3; scene.add(grid);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 500);
  const holder = new THREE.Group(); scene.add(holder);
  const st = { bay: 0, on: false, az: 2.3, el: 0.3, dist: 22, drag: null, name: Object.keys(models)[0], paint: F5_DEFAULT_PAINT };
  let bayCtl = null, gui = null, dmgFolder = null, animFolder = null, doorFolder = null, paintCtl = null, damage = null, live = null, last = performance.now();
  const props = [];

  // the live player jet is borrowed from the game scene while it is shown, and given back after
  function giveBack() {
    if (!live) return;
    jet.damage.repair(); jet.damage.scene = live.scene; jet.damage.terrain = live.terrain;
    live.parent.add(jet.object); jet.object.position.copy(live.pos); jet.object.quaternion.copy(live.quat);
    anim.active = false; live = null;
  }
  // the paint list for what is shown: the player jet's schemes, or the model's own (standard / unmarked ...)
  function paintsOf(name) { return models[name].live ? Object.keys(F5_PAINTS) : models[name].paints || []; }
  function buildPaintUi(name) {
    if (!gui) return;
    paintCtl?.destroy(); paintCtl = null;
    const list = paintsOf(name);
    if (!list.length) return;
    if (!list.includes(st.paint)) st.paint = models[name].live ? F5_DEFAULT_PAINT : list[0];
    paintCtl = gui.add(st, 'paint', list).name('paint').onChange(v => { if (models[name].live) jet.setPaint(v); else show(name); });
    paintCtl.domElement.parentElement.insertBefore(paintCtl.domElement, gui.controllers[0].domElement.nextSibling);   // (right under the model list)
  }
  function show(name) {
    giveBack();
    holder.clear(); damage = null; props.length = 0;
    let o;
    if (models[name].live && jet) {
      o = jet.object;
      live = { parent: o.parent, pos: o.position.clone(), quat: o.quaternion.clone(), scene: jet.damage.scene, terrain: jet.damage.terrain };
      jet.damage.scene = scene; jet.damage.terrain = NO_GROUND;
      damage = jet.damage; anim.active = true;
    } else {
      o = models[name](st.paint).clone(true);
      let hasParts = false; o.traverse(c => { if (c.userData.part) hasParts = true; });
      if (hasParts) { o.updateMatrixWorld(true); damage = new Damage(o.children[0] || o, scene, NO_GROUND, () => {}); }
      o.traverse(c => { if (c.userData.prop) props.push(c); });
    }
    o.position.set(0, 0, 0); o.quaternion.identity(); o.visible = true;
    holder.add(o);
    holder.updateMatrixWorld(true);   // clones carry the source's world matrices; refresh before measuring
    const box = new THREE.Box3().setFromObject(o), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
    o.position.sub(c);
    grid.position.y = -box.getSize(new THREE.Vector3()).y / 2 - 0.5;
    st.dist = size * 1.3;
    buildDamageUi();
    // a bomb bay to open (the bomber)
    bayCtl?.destroy(); bayCtl = null;
    if (gui && o.getObjectByName('bayL')) { st.bay = 0; bayCtl = gui.add(st, 'bay', 0, 1, 0.01).name('bomb bay').onChange(v => setBombBay(o, v)); }
    if (animFolder) animFolder.domElement.style.display = live ? '' : 'none';
    if (doorFolder) doorFolder.domElement.style.display = live ? '' : 'none';   // (player jet only)
  }
  function buildDamageUi() {
    if (!gui) return;
    dmgFolder?.destroy();
    if (!damage) { dmgFolder = null; return; }
    dmgFolder = gui.addFolder('damage (break off)');
    for (const n of Object.keys(damage.parts)) dmgFolder.add({ go: () => damage.breakPart(n, new THREE.Vector3(), 4) }, 'go').name(n);
    dmgFolder.add({ go: () => { for (const n of Object.keys(damage.parts)) damage.breakPart(n, new THREE.Vector3(), 4); } }, 'go').name('break everything');
    dmgFolder.add({ repair: () => { damage.repair(); } }, 'repair').name('repair all');
  }

  canvas.addEventListener('pointerdown', e => { if (st.on) { st.drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); } });
  canvas.addEventListener('pointermove', e => {
    if (!st.on || !st.drag) return;
    st.az -= (e.clientX - st.drag[0]) * 0.008;
    st.el = THREE.MathUtils.clamp(st.el + (e.clientY - st.drag[1]) * 0.008, -1.5, 1.5);
    st.drag = [e.clientX, e.clientY];
  });
  canvas.addEventListener('pointerup', () => { st.drag = null; });
  canvas.addEventListener('wheel', e => { if (st.on) { st.dist = THREE.MathUtils.clamp(st.dist * Math.exp(e.deltaY * 0.001), 1, 120); e.preventDefault(); } }, { passive: false });

  return {
    get on() { return st.on; },
    open(onExit) {
      st.on = true;
      if (!gui) {
        gui = new GUI({ title: 'model viewer' });
        gui.domElement.style.top = '70px';
        gui.add(st, 'name', Object.keys(models)).name('model').onChange((n) => { buildPaintUi(n); show(n); });
        if (anim) {
          animFolder = gui.addFolder('animation (player jet)');
          animFolder.add(anim, 'cycle').name('play all');
          animFolder.add(anim, 'pitch', -1, 1, 0.01); animFolder.add(anim, 'roll', -1, 1, 0.01); animFolder.add(anim, 'yaw', -1, 1, 0.01);
          animFolder.add(anim, 'airbrake', 0, 1, 0.01).name('speed brakes');
          animFolder.add(anim, 'engine', 0, 1.1, 0.01).name('engine (>1 = AB)');
          animFolder.add(anim, 'gear', 0, 1, 0.01).name('gear (0 up, 1 down)');
          animFolder.add(anim, 'canopy', 0, 1, 0.01).name('canopy open');
          animFolder.add(anim, 'aoa', 0, 20, 0.1).name('AoA (flaps)');
          animFolder.add(anim, 'mach', 0, 2.2, 0.01).name('Mach (intake cone)');
          for (const c of animFolder.controllers) c.listen();
          const d = doorFolder = gui.addFolder('door angles (closed)').close();
          for (const k of Object.keys(TUNABLE.DOORS)) d.add(TUNABLE.DOORS, k, -180, 180, 0.5).onChange(saveTuning);
          d.add({ reset: () => { resetGroup('DOORS'); d.controllers.forEach(c => c.updateDisplay()); } }, 'reset').name('reset to game angles');
        }
        gui.add({ exit: () => { st.on = false; gui.hide(); giveBack(); holder.clear(); onExit(); } }, 'exit').name('exit viewer');
      }
      gui.show();
      buildPaintUi(st.name);
      show(st.name);
    },
    toggleUi() { if (gui) gui.domElement.style.display = gui.domElement.style.display === 'none' ? '' : 'none'; },
    render() {
      const now = performance.now(), dt = Math.min((now - last) / 1000, 0.1); last = now;
      if (live) jet.animate({ input: anim, engine: anim.engine, airbrake: anim.airbrake, t: { aoa: anim.aoa, ias: 100 }, gear: anim.gear }, now / 1000);
      for (const p of props) p.rotateX(p.userData.prop * (Math.PI / 2) * 0.125);
      if (damage) { damage.update(dt); for (const d of damage.debris) if (d.t > 6) d.obj.visible = false; }
      camera.aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1); camera.updateProjectionMatrix();
      camera.position.set(Math.sin(st.az) * Math.cos(st.el), Math.sin(st.el), Math.cos(st.az) * Math.cos(st.el)).multiplyScalar(st.dist);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    },
  };
}
