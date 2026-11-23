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
  startBack: 6800,        // m from the player's start to the lead bomber, tutorial (the first straggler ~3.1 km ahead)
  formationBack: 5300,    // m to the lead bomber after the tutorial (the formation's tail ~2.5 nm ahead)
};

// slots: x right, y up, z behind the lead point (m)
const BOMBER_SLOTS = [
  [0, 0, 0], [-110, -30, 120], [110, -30, 120], [0, -60, 240],                  // lead box
  [-380, 60, 520], [-490, 30, 640], [-270, 30, 640],                             // left trailing box
  [380, -60, 520],                                                               // right
];
// breaking away from a missile: how close it is seen (aimed at this bomber / at another), turn rate, angle, sink
const EVADE = { seeAt: 1852, nearMiss: 600, rate: [4, 6], ang: [50, 100], sink: [8, 15] };
const _r = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _m = new THREE.Vector3();
// restart a bomber's track from where it is now, heading the way it's going (so a new turn starts from there)
function rebase(d, simT) {
  const T = d.track, h = new THREE.Vector3(d.vel.x, 0, d.vel.z);
  if (h.lengthSq() < 1) return;
  T.dir = h.normalize(); T.origin = d.pos.clone(); T.off = new THREE.Vector3(); T.t0 = simT; T.turn = null; T.weave = undefined;
}
// a hit bomber's peel-off: chance per hit taken, turn rate (deg/s), how far it turns (deg), how fast it sinks (m/s)
const PEEL = { chance: 0.07, rate: [1.5, 3], ang: [35, 110], sink: [2, 7] };
// the whole formation of ten (no stragglers), for the mission after the tutorial
const FULL_SLOTS = [...BOMBER_SLOTS, [490, -90, 640], [270, -90, 640]];
// two stragglers behind the main group, close together (the first one meets the player first): the second ~0.85 nm
// behind the main group's tail and off to the right, the first ~0.9 nm behind the second
const STRAGGLER_SLOTS = [[60, -120, 3700], [700, 40, 2200]];
// once the first one is engaged, the second breaks off into a steady 65 deg turn to the right (a crossing gun shot)
const STRAGGLER_TURN = { rate: 2.5 * Math.PI / 180, ang: 65 * Math.PI / 180 };   // (~32 deg of bank, 26 s)
// the first straggler (the guns lesson) jinks from side to side, banking into each turn: something to practise the lead on
const STRAGGLER_WEAVE = { a: 150, w: 0.26, ph: 0, phys: true };   // (~150 m each way, up to ~45 deg of bank, a reversal every ~12 s)
const FIGHTER_SLOTS = [[-260, 420, -150], [0, 470, -250], [260, 420, -150]];   // escorts above the main group

export function createMission1({ weapons, ac, rig }) {
  const M = MISSION1;
  const bombers = weapons.drones.filter(d => d.def.label === 'Bomber');
  const fighters = weapons.drones.filter(d => d.def.label !== 'Bomber');
  const h = M.heading * Math.PI / 180, dir = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
  const state = { t: 0, done: false, doneT: 0 };

  return {
    noBreak: false,          // (the tutorial keeps the second straggler on its track: it's the missile target)
    state, bombers, fighters, stragglers: bombers.slice(0, 2),
    // puts everyone in place (call on mission start and replay)
    // tutorial: the two stragglers behind the group (the lessons); otherwise all ten in formation, the nearest about
    // 2.5 nm ahead: a straight shoot
    start(simT, tutorial = false) {
      const origin = new THREE.Vector3(M.start.x, M.formationAlt, M.start.z).addScaledVector(dir, tutorial ? M.startBack : M.formationBack);
      const track = (off, weave) => ({ origin, dir, speed: M.speed, off: new THREE.Vector3(...off), t0: simT, w0: simT, weave });
      if (tutorial) bombers.forEach((d, i) => { d.track = track(i < 2 ? STRAGGLER_SLOTS[i] : BOMBER_SLOTS[(i - 2) % BOMBER_SLOTS.length], i === 0 ? STRAGGLER_WEAVE : undefined); });
      else bombers.forEach((d, i) => { d.track = track(FULL_SLOTS[i % FULL_SLOTS.length]); });
      this.noBreak = true;
      // AI (every bomber but the tutorial's two lesson stragglers): each is on its own and on alert; one that is hit but still flying may peel
      // off: a slow banked turn away from the formation, sinking as it goes (no orders, no word to the others)
      this.tutorial = tutorial;
      weapons.S.onHit = (d) => {
        if (!this.thinks(d) || d.track.turn || Math.random() > PEEL.chance) return;
        const side = d.track.off.x === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(d.track.off.x);   // (away from the middle)
        const deg = Math.PI / 180;
        d.track.turn = { t0: weapons.S.simT || 0, rate: side * (PEEL.rate[0] + Math.random() * (PEEL.rate[1] - PEEL.rate[0])) * deg,
          ang: (PEEL.ang[0] + Math.random() * (PEEL.ang[1] - PEEL.ang[0])) * deg, climb: -(PEEL.sink[0] + Math.random() * (PEEL.sink[1] - PEEL.sink[0])) };
      };   // (the second straggler's break-away turn is kept for later missions, not used now)
      bombers.forEach(d => { d.hidden = false; d.noLock = false; });
      fighters.forEach(d => { d.hidden = false; d.noLock = false; });
      fighters.forEach((d, i) => { d.track = track(FIGHTER_SLOTS[i % FIGHTER_SLOTS.length], { a: 160, w: 0.22 + 0.05 * i, ph: i * 2.1 }); });
      weapons.placeDrones();
      weapons.resetStats();
      ac.reset(new THREE.Vector3(M.start.x, M.playerAlt, M.start.z), M.heading, M.playerSpeed);
      rig.reset(ac.quat);
      state.t = 0; state.done = false; state.doneT = 0;
    },
    // true once everything is down (and a few seconds have passed to watch the last one go)
    // does this bomber think for itself? (not the tutorial's two lesson stragglers: they fly the lessons)
    thinks(d) { return !!d.track && d.alive && !d.falling && d.def.label === 'Bomber' && !(this.tutorial && (d === bombers[0] || d === bombers[1])); },
    update(dt) {
      state.t += dt;
      // missile warning: a bomber sees a missile coming at it inside 1 nm (or one going for another aircraft passing
      // within ~600 m) and breaks hard: a steep diving turn away from it (it won't outrun it, but the formation breaks up)
      for (const m of weapons.S.missiles) {
        if (m.owner !== 'player') continue;
        for (const d of bombers) {
          if (!this.thinks(d) || d.track.evading) continue;
          const r = m.p.distanceTo(d.pos);
          if (r > (m.target === d ? EVADE.seeAt : EVADE.nearMiss)) continue;
          // turn away from the missile's side
          const right = _r.crossVectors(d.track.dir, _up).normalize(), side = _m.subVectors(m.p, d.pos).dot(right) > 0 ? -1 : 1;
          const deg = Math.PI / 180, simT = weapons.S.simT || 0;
          // (a turn already under way: carry on from where it got to, by restarting the track there)
          if (d.track.turn) rebase(d, simT);
          d.track.turn = { t0: simT, rate: side * (EVADE.rate[0] + Math.random() * (EVADE.rate[1] - EVADE.rate[0])) * deg,
            ang: (EVADE.ang[0] + Math.random() * (EVADE.ang[1] - EVADE.ang[0])) * deg, climb: -(EVADE.sink[0] + Math.random() * (EVADE.sink[1] - EVADE.sink[0])) };
          d.track.evading = true;
        }
      }
      // the second straggler breaks away once the player closes on the first (the tutorial calls breakAway itself)
      const [A, B] = bombers;
      if (!this.noBreak && B.track && !B.track.turn && (A.pos.distanceTo(ac.pos) < 3000 || !A.alive || A.falling)) this.breakAway();
      const left = weapons.drones.filter(d => d.alive && !d.falling).length;
      if (!left && !state.done) { state.done = true; state.doneT = 0; }
      if (state.done) state.doneT += dt;
      return state.done && state.doneT > 3;
    },
    // move the whole formation along its track by d metres (the tutorial keeps it just ahead while you learn to fly)
    shift(d) { for (const b of bombers) if (b.track) { b.track.t0 -= d / b.track.speed; if (b.track.turn) b.track.turn.t0 -= d / b.track.speed; } },
    shiftOne(b, d) { if (b.track) { b.track.t0 -= d / b.track.speed; if (b.track.turn) b.track.turn.t0 -= d / b.track.speed; } },
    breakAway() { const B = bombers[1]; if (B.track && !B.track.turn) B.track.turn = { ...STRAGGLER_TURN, t0: weapons.S.simT || 0 }; },
    stats() {
      const S = weapons.S;
      return { kills: S.kills.length, total: weapons.drones.length, time: state.t, accuracy: S.shots ? S.hits / S.shots : 0 };
    },
  };
}
