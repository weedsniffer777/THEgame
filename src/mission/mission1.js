import * as THREE from 'three';

// Mission 1: intercept a bomber formation. Ten bombers in three boxes on one straight, endless track (no escorts:
// the fighter slots below are kept for a later mission); the player starts behind and a little above, closing. The mission is complete once
// all of them are down. (No enemy AI yet: everything flies its track.)
export const MISSION1 = {
  heading: 48,            // deg, the track's direction (same as the free-flight spawn)
  start: { x: -6500, z: 15500 },
  formationAlt: 4800,     // m (~15,700 ft)
  playerAlt: 5000,
  speed: 140,             // m/s, the formation
  playerSpeed: 230,
  startBack: 8500,        // m from the player's start to the lead bomber (the first straggler ~4.8 km ahead)
};

// slots: x right, y up, z behind the lead point (m)
const BOMBER_SLOTS = [
  [0, 0, 0], [-110, -30, 120], [110, -30, 120], [0, -60, 240],                  // lead box
  [-380, 60, 520], [-490, 30, 640], [-270, 30, 640],                             // left trailing box
  [380, -60, 520],                                                               // right
];
// two stragglers behind the main group, close together (the first one meets the player first): the second ~0.85 nm
// behind the main group's tail and off to the right, the first ~0.9 nm behind the second
const STRAGGLER_SLOTS = [[60, -120, 3700], [700, 40, 2200]];
// once the first one is engaged, the second breaks off into a steady 65 deg turn to the right (a crossing gun shot)
const STRAGGLER_TURN = { rate: 2.5 * Math.PI / 180, ang: 65 * Math.PI / 180 };   // (~32 deg of bank, 26 s)
// the second straggler (the guns lesson) zigzags slowly, banking into each turn: something to practise the lead on
const STRAGGLER_WEAVE = { a: 180, w: 0.15, ph: 0, phys: true };   // (up to ~22 deg of bank)
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
      bombers.forEach((d, i) => { d.track = track(i < 2 ? STRAGGLER_SLOTS[i] : BOMBER_SLOTS[(i - 2) % BOMBER_SLOTS.length], i === 1 ? STRAGGLER_WEAVE : undefined); d.hidden = false; d.noLock = false; });
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
      // the second straggler breaks away once the player closes on the first (the tutorial calls breakAway itself)
      const [A, B] = bombers;
      if (B.track && !B.track.turn && (A.pos.distanceTo(ac.pos) < 3000 || !A.alive || A.falling)) this.breakAway();
      const left = weapons.drones.filter(d => d.alive && !d.falling).length;
      if (!left && !state.done) { state.done = true; state.doneT = 0; }
      if (state.done) state.doneT += dt;
      return state.done && state.doneT > 3;
    },
    breakAway() { const B = bombers[1]; if (B.track && !B.track.turn) B.track.turn = { ...STRAGGLER_TURN, t0: weapons.S.simT || 0 }; },
    stats() {
      const S = weapons.S;
      return { kills: S.kills.length, total: weapons.drones.length, time: state.t, accuracy: S.shots ? S.hits / S.shots : 0 };
    },
  };
}
