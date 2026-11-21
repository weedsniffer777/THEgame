// Dev-only tuning panel and flight readout (press ` to toggle). Never shown to players unless toggled.
import GUI from 'lil-gui';
import { TUNABLE, saveTuning, clearTuning, resetGroup } from './config.js';
import { setSun } from './world/sky.js';

let gui, readout, fps = 60;

export function toggleDev({ ac, terrain, renderer, spawn }) {
  if (gui) {
    const hidden = gui._hidden;
    gui.show(hidden); readout.style.display = hidden ? '' : 'none';
    return;
  }
  gui = new GUI({ title: 'tuning' });
  for (const [name, group] of Object.entries(TUNABLE)) {
    const f = gui.addFolder(name).close();
    for (const k of Object.keys(group)) {
      if (typeof group[k] !== 'number') continue;
      const v = Math.abs(group[k]) || 1;
      const [lo, hi, st] = name === 'DOORS' ? [-180, 180, 0.5] : [group[k] < 0 ? -v * 4 : 0, v * 4, v / 200];
      f.add(group, k, lo, hi, st).onChange(() => {
        saveTuning();
        if (name === 'WORLD') {
          setSun();
          terrain.uniforms.uBright.value = group.terrainBrightness;
          terrain.uniforms.uRelief.value = group.terrainRelief;
          terrain.setDetail(group.terrainDetail);
          renderer.setPixelRatio(Math.min(devicePixelRatio, group.pixelRatio));
        }
      });
    }
  }
  gui.add({ respawn: spawn }, 'respawn');
  gui.add({ copy: () => navigator.clipboard?.writeText(JSON.stringify(TUNABLE, null, 1)) }, 'copy').name('copy values');
  gui.add({ reset: () => { clearTuning(); location.reload(); } }, 'reset').name('reset to defaults');

  readout = document.createElement('div');
  readout.id = 'dev';
  document.body.append(readout);
  window.__dev = (dt) => {
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
    const t = ac.t;
    readout.textContent =
      `fps   ${fps.toFixed(0)}\n` +
      `tas   ${(t.speed * 3.6).toFixed(0)} km/h   ias ${(t.ias * 3.6).toFixed(0)}   M ${t.mach.toFixed(2)}\n` +
      `alt   ${t.alt.toFixed(0)} m   agl ${(t.alt - terrain.heightAt(ac.pos.x, ac.pos.z)).toFixed(0)}\n` +
      `aoa   ${t.aoa.toFixed(1)}   beta ${t.beta.toFixed(1)}   g ${t.g.toFixed(1)}\n` +
      `thr   ${(ac.throttle * 100).toFixed(0)}%   eng ${(ac.engine * 100).toFixed(0)}%   ${(t.thrust / 1000).toFixed(1)} kN\n` +
      `stick p ${ac.input.pitch.toFixed(2)} r ${ac.input.roll.toFixed(2)} y ${ac.input.yaw.toFixed(2)}`;
  };
}

// Model viewer panel: every animation the jet has, plus the door angles, live.
let vgui;
export function openViewer(anim, exit) {
  if (vgui) { vgui.show(); return; }
  vgui = new GUI({ title: 'model viewer' });
  vgui.domElement.style.top = '70px';
  const a = vgui.addFolder('animation');
  a.add(anim, 'cycle').name('play all');
  a.add(anim, 'pitch', -1, 1, 0.01); a.add(anim, 'roll', -1, 1, 0.01); a.add(anim, 'yaw', -1, 1, 0.01);
  a.add(anim, 'airbrake', 0, 1, 0.01).name('speed brakes');
  a.add(anim, 'engine', 0, 1.1, 0.01).name('engine (>1 = AB)');
  a.add(anim, 'gear', 0, 1, 0.01).name('gear (0 up, 1 down)');
  a.add(anim, 'canopy', 0, 1, 0.01).name('canopy open');
  const d = vgui.addFolder('door angles (closed)');
  for (const k of Object.keys(TUNABLE.DOORS)) d.add(TUNABLE.DOORS, k, -180, 180, 0.5).onChange(saveTuning);
  d.add({ copy: () => navigator.clipboard?.writeText(JSON.stringify(TUNABLE.DOORS, null, 1)).catch(() => {}) }, 'copy').name('copy door values');
  d.add({ reset: () => { resetGroup('DOORS'); d.controllers.forEach(c => c.updateDisplay()); } }, 'reset').name('reset to game angles');
  vgui.add({ exit: () => { vgui.hide(); exit(); } }, 'exit').name('exit viewer');
  for (const c of [...a.controllers]) c.listen();
}
