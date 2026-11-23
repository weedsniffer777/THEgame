import * as THREE from 'three';

// Mission 1: intercept a bomber formation. Ten bombers in three boxes on one straight, endless track, three escort
// fighters weaving above them; the player starts behind and a little above, closing. The mission is complete once
// all of them are down. (No enemy AI yet: everything flies its track.)
export const MISSION1 = {
  heading: 48,            // deg, the track's direction (same as the free-flight spawn)
  start: { x: -6500, z: 15500 },
  formationAlt: 4800,     // m (~15,700 ft)
  playerAlt: 5000,
  speed: 140,             // m/s, the formation
  playerSpeed: 230,
  startBack: 10000,       // m from the player's start to the lead bomber (the first straggler ~4.8 km ahead)
};

// slots: x right, y up, z behind the lead point (m)
const BOMBER_SLOTS = [
  [0, 0, 0], [-110, -30, 120], [110, -30, 120], [0, -60, 240],                  // lead box
  [-380, 60, 520], [-490, 30, 640], [-270, 30, 640],                             // left trailing box
  [380, -60, 520],                                                               // right
];
// two stragglers far behind the main group (the first one meets the player first)
const STRAGGLER_SLOTS = [[60, -120, 5200], [-90, 40, 3400]];   // (the second one ~1.5 nm behind the main group's tail)
const FIGHTER_SLOTS = [[-260, 420, -150], [0, 470, -250], [260, 420, -150]];   // escorts above the main group

export function createMission1({ weapons, ac, rig }) {
  const M = MISSION1;
  const bombers = weapons.drones.filter(d => d.def.label === 'Bomber');
  const fighters = weapons.drones.filter(d => d.def.label !== 'Bomber');
  const h = M.heading * Math.PI / 180, dir = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
  const state = { t: 0, done: false, doneT: 0 };

  return {
    state, bombers, fighters, stragglers: bombers.slice(0, 2),
    // puts everyone in place (call on mission start and replay)
    start(simT) {
      const origin = new THREE.Vector3(M.start.x, M.formationAlt, M.start.z).addScaledVector(dir, M.startBack);
      const track = (off, weave) => ({ origin, dir, speed: M.speed, off: new THREE.Vector3(...off), t0: simT, weave });
      bombers.forEach((d, i) => { d.track = track(i < 2 ? STRAGGLER_SLOTS[i] : BOMBER_SLOTS[(i - 2) % BOMBER_SLOTS.length]); d.hidden = false; d.noLock = false; });
      fighters.forEach(d => { d.hidden = false; d.noLock = false; });
      fighters.forEach((d, i) => { d.track = track(FIGHTER_SLOTS[i % FIGHTER_SLOTS.length], { a: 160, w: 0.22 + 0.05 * i, ph: i * 2.1 }); });
      weapons.placeDrones();
      weapons.resetStats();
      ac.reset(new THREE.Vector3(M.start.x, M.playerAlt, M.start.z), M.heading, M.playerSpeed);
      rig.reset(ac.quat);
      state.t = 0; state.done = false; state.doneT = 0;
    },
    // true once everything is down (and a few seconds have passed to watch the last one go)
    update(dt) {
      state.t += dt;
      const left = weapons.drones.filter(d => d.alive && !d.falling).length;
      if (!left && !state.done) { state.done = true; state.doneT = 0; }
      if (state.done) state.doneT += dt;
      return state.done && state.doneT > 3;
    },
    stats() {
      const S = weapons.S;
      return { kills: S.kills.length, total: weapons.drones.length, time: state.t, accuracy: S.shots ? S.hits / S.shots : 0 };
    },
  };
}
