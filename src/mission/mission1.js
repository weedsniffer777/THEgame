import * as THREE from 'three';
import { bandArea, edgeDistance, distanceToEdge } from './area.js';

// Mission 1: intercept a bomber formation running up the big valley (the Engadin, from its foot by the south edge of
// the map to the north-east corner). Ten bombers in three boxes (no escorts: the fighter slots below are kept for a
// later mission); the player starts at the foot of the valley, behind and a little above, closing. Complete once all
// of them are down; failed if one gets out of the mission area (a band round the valley) or the player stays out of it.
export const MISSION1 = {
  heading: 41,            // deg, up the valley (its floor measured from the terrain)
  start: { x: -6200, z: 16400 },   // the foot of the valley
  // the mission area: a band along the valley, from 1.5 km behind the start to past the map edge, 8 km either side
  // of its middle, clipped to the map (the real terrain data, 20 km each way from the centre)
  area: { from: -1500, to: 45000, half: 8000, lim: 19600 },
  formationAlt: 4800,     // m (~15,700 ft)
  playerAlt: 5000,
  speed: 125,             // m/s, the formation (~4.4 min from the start to the far edge of the area)
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
const EVADE = { seeAt: 1852, nearMiss: 600, ignore: 0.25, away: 0.7, climb: 0.3, rate: [5, 8], ang: [25, 60], sink: [6, 12], climbRate: [3, 6] };   // (a short, sharp break: ~4-10 s, then back)
const _r = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _m = new THREE.Vector3();
// a hit bomber's peel-off: chance per hit taken, turn rate (deg/s), how far it turns (deg), how fast it sinks (m/s)
const PEEL = { chance: 0.07, rate: [2.5, 4], ang: [15, 40], sink: [1.5, 4] };   // (a brief lurch off course, ~5-15 s, then back)
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
    area: null,
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
      const A = M.area; this.area = bandArea([M.start.x, M.start.z], M.heading, A.from, A.to, A.half, A.lim);
      weapons.S.onHit = (d) => {
        if (!this.thinks(d) || d.track.free || Math.random() > PEEL.chance) return;
        const out = d.track.off.x === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(d.track.off.x);
        const side = Math.random() < 0.7 ? out : -out;                // (mostly away from the middle, not always)
        const deg = Math.PI / 180;
        weapons.breakOff(d, side * (PEEL.rate[0] + Math.random() * (PEEL.rate[1] - PEEL.rate[0])) * deg,
          (PEEL.ang[0] + Math.random() * (PEEL.ang[1] - PEEL.ang[0])) * deg, PEEL.sink[0] + Math.random() * (PEEL.sink[1] - PEEL.sink[0]));
        d.track.peeled = true;
      };   // (the second straggler's break-away turn is kept for later missions, not used now)
      bombers.forEach(d => { d.hidden = false; d.noLock = false; });
      fighters.forEach(d => { d.hidden = false; d.noLock = false; });
      fighters.forEach((d, i) => { d.track = track(FIGHTER_SLOTS[i % FIGHTER_SLOTS.length], { a: 160, w: 0.22 + 0.05 * i, ph: i * 2.1 }); });
      weapons.placeDrones();
      weapons.resetStats();
      ac.reset(new THREE.Vector3(M.start.x, M.playerAlt, M.start.z), M.heading, M.playerSpeed);
      rig.reset(ac.quat);
      state.t = 0; state.done = false; state.doneT = 0; state.escaped = false;
    },
    // true once everything is down (and a few seconds have passed to watch the last one go)
    // does this bomber think for itself? (not the tutorial's two lesson stragglers: they fly the lessons)
    thinks(d) { return !!d.track && d.alive && !d.falling && d.def.label === 'Bomber' && !(this.tutorial && (d === bombers[0] || d === bombers[1])); },
    update(dt) {
      state.t += dt;
      // missile warning: a bomber sees a missile coming at it inside 1 nm (or one going for another aircraft passing
      // within ~600 m) and breaks hard: a steep diving turn away from it (it won't outrun it, but the formation breaks up)
      // the missile is gone (or long past): a bomber that broke away heads back to its place, as does one that peeled off hurt
      for (const d of bombers) {
        const F = d.track?.free;
        const threat = d.track && weapons.S.missiles.some(m => m.owner === 'player' && m.p.distanceTo(d.pos) < 2500);
        if (d.track?.evading && !F && !threat) d.track.evading = false;   // (one that chose to sit tight can react next time)
        if (!F || F.rejoin || !this.thinks(d)) continue;
        if (!threat && F.rateT === 0) { F.rejoin = true; d.track.peeled = false; }   // (once its break is done)
      }
      for (const m of weapons.S.missiles) {
        if (m.owner !== 'player') continue;
        for (const d of bombers) {
          if (!this.thinks(d) || d.track.evading) continue;
          const r = m.p.distanceTo(d.pos);
          if (r > (m.target === d ? EVADE.seeAt : EVADE.nearMiss)) continue;
          d.track.evading = true;                                // (decided once, whatever it decides)
          if (Math.random() < EVADE.ignore) continue;           // some just hold on and hope
          // which way: mostly away from the missile's side, sometimes into it; mostly diving, sometimes climbing
          const right = _r.crossVectors(d.track.free ? d.track.free.dir : d.track.dir, _up).normalize();
          const away = _m.subVectors(m.p, d.pos).dot(right) > 0 ? -1 : 1, side = Math.random() < EVADE.away ? away : -away;
          const deg = Math.PI / 180, climb = Math.random() < EVADE.climb;
          const sink = climb ? -(EVADE.climbRate[0] + Math.random() * (EVADE.climbRate[1] - EVADE.climbRate[0])) : EVADE.sink[0] + Math.random() * (EVADE.sink[1] - EVADE.sink[0]);
          weapons.breakOff(d, side * (EVADE.rate[0] + Math.random() * (EVADE.rate[1] - EVADE.rate[0])) * deg,
            (EVADE.ang[0] + Math.random() * (EVADE.ang[1] - EVADE.ang[0])) * deg, sink);
        }
      }
      // the second straggler breaks away once the player closes on the first (the tutorial calls breakAway itself)
      const [A, B] = bombers;
      if (!this.noBreak && B.track && !B.track.turn && (A.pos.distanceTo(ac.pos) < 3000 || !A.alive || A.falling)) this.breakAway();
      // a bomber that gets out of the mission area: the mission is lost (not in the tutorial run)
      if (!this.tutorial && this.area && !state.escaped) for (const d of bombers) if (d.alive && !d.falling && edgeDistance(this.area, d.pos.x, d.pos.z) < 0) state.escaped = true;
      const left = weapons.drones.filter(d => d.alive && !d.falling).length;
      if (!left && !state.done) { state.done = true; state.doneT = 0; }
      if (state.done) state.doneT += dt;
      return state.done && state.doneT > 3;
    },
    // move the whole formation along its track by d metres (the tutorial keeps it just ahead while you learn to fly)
    shift(d) { for (const b of bombers) if (b.track) { b.track.t0 -= d / b.track.speed; if (b.track.turn) b.track.turn.t0 -= d / b.track.speed; } },
    shiftOne(b, d) { if (b.track) { b.track.t0 -= d / b.track.speed; if (b.track.turn) b.track.turn.t0 -= d / b.track.speed; } },
    // the tutorial's over: whoever is left flies the rounded square too
    toLoop() { weapons.toLoop(bombers.filter(d => d.alive && !d.falling), weapons.S.simT || 0, (x, z) => edgeDistance(this.area, x, z) > 1200); },
    breakAway() { const B = bombers[1]; if (B.track && !B.track.turn) B.track.turn = { ...STRAGGLER_TURN, t0: weapons.S.simT || 0 }; },
    // seconds until the formation's foremost bomber leaves the area at its speed (Infinity in the tutorial run)
    timeLeft() {
      if (this.tutorial || !this.area) return Infinity;
      let t = Infinity;
      for (const d of bombers) {
        if (!d.alive || d.falling || !d.track) continue;
        const v = Math.hypot(d.vel.x, d.vel.z); if (v < 1) continue;
        t = Math.min(t, distanceToEdge(this.area, d.pos.x, d.pos.z, d.vel.x / v, d.vel.z / v) / v);
      }
      return t;
    },
    stats() {
      const S = weapons.S;
      return { kills: S.kills.length, total: weapons.drones.length, time: state.t, accuracy: S.shots ? S.hits / S.shots : 0 };
    },
  };
}
