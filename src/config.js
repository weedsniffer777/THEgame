// Every number that shapes how the game flies and looks lives here, so it can be tuned in one place
// (in the browser: press ` to open the dev panel; tuned values are kept in localStorage).

// One aircraft. Units: kg, m, m², N, m/s, degrees where marked.
export const F5 = {
  mass: 6200,
  wingArea: 17.3,

  // engines, both together
  thrustIdle: 0,          // zero throttle is zero thrust
  thrustMil: 35000,             // full dry power
  thrustAB: 51000,         // afterburner
  spoolUp: 0.8,           // fraction of full power gained per second
  spoolDown: 0.9,
  thrustLapse: 0.75,      // thrust scales with (air density ratio) ^ this
  ramThrust: 0.3,         // extra thrust per Mach

  // lift
  clAlpha: 5.0,           // lift per radian of angle of attack
  clMax: 2.0,            // generous: more G available at low speed than the real jet
  stallAoA: 24,           // deg
  stallWidth: 6,          // deg over which lift falls away past the stall
  postStallCl: 0.85,      // lift of a flat plate at 45 deg

  // drag
  cd0: 0.021,
  inducedDrag: 0.12,      // k in k * CL²
  stallDrag: 0.9,         // extra drag once fully stalled
  waveDrag: 0.024,        // extra drag at the transonic peak
  machCrit: 0.86,
  machPeak: 1.05,
  sideForce: 0.9,         // per radian of sideslip

  // pitch: control pulls the nose up, stability pulls it back into the airflow.
  // At the reference speed full stick holds about pitchControl / pitchStability radians of AoA.
  refSpeed: 200,          // m/s at sea level where the numbers below are "as written"
  pitchControl: 16,
  pitchStability: 26,
  pitchDamping: 6.2,
  pitchLockStart: 250,    // IAS m/s where controls start to stiffen
  pitchLockEnd: 400,
  pitchLock: 0.3,         // fraction of pitch authority lost at pitchLockEnd

  // yaw
  yawControl: 3.2,     
  yawStability: 12,
  yawDamping: 4,

  // roll is commanded as a rate
  rollRate: 220,          // deg/s at best speed
  rollFullIAS: 140,       // m/s where full roll rate is reached
  rollLockStart: 260,
  rollLockEnd: 420,
  rollLock: 0.5,
  rollResponse: 0.18,     // s to reach the commanded rate at reference speed
  stallRoll: 0.6,         // roll authority lost when fully stalled

  // low-speed floor so the jet never becomes completely uncontrollable while tumbling
  minAuthority: 0.03,
  lowSpeedAuthority: 0.6,  // control/rotation authority floor at low speed (fraction of reference)
  ctrlFadeLowIAS: 20,     // m/s IAS (~40 kt): below this the floor is gone (controls slack below flying speed)
  ctrlFadeFullIAS: 55,    // m/s IAS (~107 kt): full floor from here
  rotateStartIAS: 68,     // m/s IAS (~132 kt): on the wheels, nose-up stick starts to lift the nose from here
  rotateFullIAS: 78,      // m/s IAS (~152 kt): full rotation authority
  gFloorMax: 9,           // arcade lift: G guaranteed at full AoA once at gFloorFullIAS
  gFloorStartIAS: 28,     // m/s IAS where the guarantee starts (~55 kt)
  gFloorFullIAS: 120,     // m/s IAS where it reaches gFloorMax (~230 kt)
  gFloorCurve: 0.65,      // shape of the guarantee below full: ~3.6 G at 100 kt, ~6.7 G at 175 kt
  gFloorAoA: 20,          // deg, the AoA the guarantee is measured at
  turnBoost: 1.3,         // arcade: flight path turns this much harder than the G shown
  boostDrag: 0.22,        // drag per unit of extra lift: what slow tight turns cost in speed
  lowSpeedBleed: 3,       // that drag is up to (1 + this) times higher near the stall, fading out by lowSpeedBleedIAS,
  lowSpeedBleedIAS: 90,   // m/s IAS (~175 kt): so a slow, gliding jet can't hold 2-3 G turns for free
  airbrakeDrag: 0.14,     // extra drag coefficient with the speed brakes fully out
  airbrakeRate: 1.5,      // fraction of full travel per second
  gearDrag: 0.05,         // extra drag coefficient with the landing gear down
  gearTime: 4,            // s for the gear to go fully up or down
  gearMaxKt: 320,         // kt IAS: above this the gear retracts by itself (the real limit is ~260 kt; some leeway)
  afterburner: 'spray',   // 'spray' (this jet) or 'diamonds' (shock diamonds after the first flame)

  // sideslip rolls the jet away from the yaw (dihedral / sweep effect): rudder right rolls right
  dihedral: 1.0,
};

// The mouse-aim "instructor": flies the jet toward wherever the camera points.
export const INSTRUCTOR = {
  aimRate: 1.7,           // 1/s: turn rate commanded per radian of error (higher = snappier, too high = overshoot)
  maxRate: 30,            // deg/s cap on the commanded turn rate
  rateGain: 0.45,         // stick per rad/s of pitch-rate error (small trim on top of the lift-curve feed-forward)
  rollGain: 5,            // roll rate (rad/s) per radian of bank error
  yawGain: 7,             // rudder per radian of sideways error near the aim point (wings stay level, rudder slides the nose)
  yawDamp: 0.9,
  rollHold: 0.4,          // near the aim point: aileron per rad/s of roll rate, to hold the bank steady
  levelAngle: 5,          // deg off the aim point below which it holds the bank and corrects with pitch and rudder
  bankAngle: 16,          // deg off the aim point above which it fully rolls the lift onto it
  pushAngle: 18,          // deg: aim points a little below are reached by pushing, not rolling over
  pushMaxBank: 30,        // deg: pushing only with the wings within this of level; banked, it rolls first
  maxG: 9,                // game limit, between the real jet's 7.33 operating and ~11 ultimate
  maxNegG: 3,
  maxNegAoA: 12,          // deg
  maxAoA: 20,             // deg
  pitchLag: 0.06,         // s for each control to follow its command (smoothness)
  rollLag: 0.05,
  yawLag: 0.1,
  aimSmooth: 0.05,        // s low-pass on the mouse aim the autopilot chases
};

export const CAMERA = {
  fov: 66,
  zoomFov: 32,
  speedFov: 8,            // extra fov at top speed
  distance: 17,
  height: 4.2,
  sensitivity: 0.0022,    // rad per pixel
  levelRate: 2.2,         // how fast the camera rolls itself upright
  closeFactor: 0.68,      // camera distance when slow, as a share of the normal distance
  closeIAS: 80,           // m/s IAS (~155 kt) at or below which the camera is fully in close
  farIAS: 200,            // m/s IAS (~390 kt) at or above which it is at the normal distance
  distSmooth: 0.9,        // s for the distance to settle
  aimDistance: 1200,      // m: the jet points its nose at the spot this far down the aim line
};

export const WORLD = {
  sunAzimuth: 160,        // deg clockwise from north
  sunElevation: 32,
  sunIntensity: 5.0,
  saturation: 1.5,
  clouds: 0,              // cloud clusters around the player (0 = none)
  cloudBase: 3700,        // m
  fogDensity: 0.00009,
  fogFalloff: 0.00028,    // 1 / haze scale height
  terrainBrightness: 1.4,
  terrainRelief: 1.0,     // how much our sun shading is added on top of the photo
  terrainDetail: 900,     // m: radius of full-detail terrain (lower = faster)
  pixelRatio: 1.5,        // render resolution cap
  spawn: { x: -6500, y: 3300, z: 15500, heading: 48, speed: 230 },
};

// Gear-up door angles (degrees about each door's hinge). Adjustable live in the dev panel.
export const DOORS = {
  innerMain: 69.5,        // inner main gear doors (rear pair)
  outerMain: 104,         // doors on the main gear legs
  smallNose: -105,        // small door at the back of the nose gear well
  noseMain: 90,           // long nose gear doors
  speedBrakeClosed: 38,
  speedBrakeOpen: -7,     // 45 deg open
};

// Weapons. Guns: infinite ammo, every round a tracer. Missiles: limited, reload over time.
export const WEAPONS = {
  gunRate: 50,            // rounds per second, both guns together
  muzzleVelocity: 1030,   // m/s
  gunSpread: 0.0012,      // rad
  tracerLength: 24,       // m
  tracerWidthPx: 3.5,       // px half-width of a tracer up close
  tracerMinPx: 1.5,         // px half-width far away
  gunRange: 2000,         // m: gun solution and aim assist only within this
  roundLife: 1.7,         // s: rounds (muzzle speed + our own) cover about 2 km
  missiles: 6,            // one per station: 2 wingtips + 4 pylons, no reload
  seekerFov: 24,          // deg, full width of the seeker circle
  lockTime: 0.8,          // s on target to lock
  lockRange: 5556,        // m (3 nm)
  missileThrust: 230,     // m/s² while the motor burns
  motorTime: 4,           // s
  missileDrag: 4e-5,      // speed loss per second = this x speed²
  missileMaxG: 28,
  missileLife: 11,        // s: self-destructs after this (a fleeing target at 6 km is caught in about 9.7 s)
  missileMinSpeed: 300,   // m/s: after burnout, self-destructs once slower than this (it can't catch anything)
  proximity: 12,          // m
  assistFull: 1.5,        // deg: nose within this of the gun solution -> rounds fly to the intercept
  assistAngle: 4,         // deg: assist fades out by here (both x1.5 on touch screens)
  hitRadius: 7,           // m around a target's centre that a round counts as a hit (x1.5 on touch screens)
  magnetism: 0.35,        // touch screens: how strongly aim is pulled onto the lead point when close to it
  drones: 8,              // test targets circling near the player
  droneMinDist: 3000,     // m from the player where they (re)spawn
  droneMaxDist: 8000,
};

const KEY = 'thegame.tune2';
export const TUNABLE = { F5, INSTRUCTOR, CAMERA, WORLD, DOORS, WEAPONS };
// the shipped defaults, so stale saved values can be told apart and reset
export const DEFAULTS = JSON.parse(JSON.stringify(TUNABLE));

// A saved value is only applied if it was tuned against the same default the code has now;
// when a default changes in code, the new default wins.
export function loadTuning() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const [group, values] of Object.entries(saved.values || {})) {
      if (!TUNABLE[group]) continue;
      for (const [k, v] of Object.entries(values)) {
        if (typeof TUNABLE[group][k] === typeof v && saved.defaults?.[group]?.[k] === DEFAULTS[group][k]) TUNABLE[group][k] = v;
      }
    }
  } catch { /* storage blocked or bad data: keep defaults */ }
}

export function saveTuning() {
  try { localStorage.setItem(KEY, JSON.stringify({ values: TUNABLE, defaults: DEFAULTS })); } catch { /* ignore */ }
}

export function clearTuning() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function resetGroup(group) {
  Object.assign(TUNABLE[group], JSON.parse(JSON.stringify(DEFAULTS[group])));
  saveTuning();
}
