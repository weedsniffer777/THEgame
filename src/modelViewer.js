import * as THREE from 'three';
import GUI from 'lil-gui';

// Dev kit model viewer: a separate, static scene (neutral studio light, ground grid) to inspect any model in the game.
// Drag to orbit, wheel to zoom, pick the model from the list. Space hides the panel.
export function createModelViewer(renderer, canvas, environment, models) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x26303b);
  scene.environment = environment;
  scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x3a3530, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(5, 8, 6); scene.add(key);
  const grid = new THREE.GridHelper(40, 40, 0x56636f, 0x3a4550); grid.position.y = -3; scene.add(grid);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 500);
  const holder = new THREE.Group(); scene.add(holder);
  const st = { on: false, az: 2.3, el: 0.3, dist: 22, drag: null, name: Object.keys(models)[0] };
  let gui = null;

  function show(name) {
    holder.clear();
    const o = models[name]().clone(true);
    o.position.set(0, 0, 0); o.quaternion.identity(); o.visible = true;
    holder.add(o);
    holder.updateMatrixWorld(true);   // clones carry the source's world matrices; refresh before measuring
    const box = new THREE.Box3().setFromObject(o), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
    o.position.sub(c);
    grid.position.y = -box.getSize(new THREE.Vector3()).y / 2 - 0.5;
    st.dist = size * 1.3;
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
        gui.add(st, 'name', Object.keys(models)).name('model').onChange(show);
        gui.add({ exit: () => { st.on = false; gui.hide(); holder.clear(); onExit(); } }, 'exit').name('exit viewer');
      }
      gui.show();
      show(st.name);
    },
    toggleUi() { if (gui) gui.domElement.style.display = gui.domElement.style.display === 'none' ? '' : 'none'; },
    render() {
      camera.aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1); camera.updateProjectionMatrix();
      camera.position.set(Math.sin(st.az) * Math.cos(st.el), Math.sin(st.el), Math.cos(st.az) * Math.cos(st.el)).multiplyScalar(st.dist);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    },
  };
}
