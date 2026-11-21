// Every number that shapes how the game flies and looks lives here, so it can be tuned in one place
// (in the browser: press ` to open the dev panel; tuned values are kept in localStorage).

// One aircraft. Units: kg, m, m², N, m/s, degrees where marked.
export const F5 = {
  mass: 6200,
  wingArea: 17.3,

  // engines, both together
  thrustIdle: 0,          // zero throttle is zero thrust
  thrustMil: 31000,       // full dry power
  thrustAB: 44400,        // afterburner
  spoolUp: 0.55,          // fraction of full power gained per second
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
  yawControl: 1.6,
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
  gFloorMax: 9,           // arcade lift: G guaranteed at full AoA once at gFloorFullIAS
  gFloorStartIAS: 28,     // m/s IAS where the guarantee starts (~55 kt)
  gFloorFullIAS: 120,     // m/s IAS where it reaches gFloorMax (~230 kt)
  gFloorCurve: 0.65,      // shape of the guarantee below full: ~3.6 G at 100 kt, ~6.7 G at 175 kt
  gFloorAoA: 20,          // deg, the AoA the guarantee is measured at
  turnBoost: 1.3,         // arcade: flight path turns this much harder than the G shown
  boostDrag: 0.22,        // drag per unit of extra lift: what slow tight turns cost in speed
  airbrakeDrag: 0.08,     // extra drag coefficient with the speed brakes fully out
  airbrakeRate: 1.5,      // fraction of full travel per second
  afterburner: 'spray',   // 'spray' (this jet) or 'diamonds' (shock diamonds after the first flame)

  // sideslip rolls the jet away from the yaw (dihedral / sweep effect): rudder right rolls right
  dihedral: 2.5,
};

// The mouse-aim "instructor": flies the jet toward wherever the camera points.
export const INSTRUCTOR = {
  pitchGain: 5.0,         // stick per radian of pitch error
  pitchLead: 0.4,         // s: how far ahead the pitch controller looks at the closing error
  yawGain: 3.0,
  yawLead: 0.25,
  rollGain: 3.2,
  rollDamp: 0.3,
  levelGain: 2.0,         // how hard it levels the wings when the target is dead ahead
  levelAngle: 3,          // deg off target below which it only levels the wings
  bankAngle: 14,           // deg off target above which it fully banks toward the target
  pushAngle: 12,          // targets below and closer than this are reached by pushing, not rolling over
  maxG: 9,                // game limit, between the real jet's 7.33 operating and ~11 ultimate
  maxNegG: 3,
  maxNegAoA: 12,          // deg
  pitchLag: 0.07,         // s for each control to follow its command (smoothness)
  rollLag: 0.06,
  yawLag: 0.1,
  aimSmooth: 0.06,        // s low-pass on the mouse aim the autopilot chases         // s for controls to follow a command (smooths jitter)
  maxAoA: 20,             // deg
};

export const CAMERA = {
  fov: 66,
  zoomFov: 32,
  speedFov: 8,            // extra fov at top speed
  distance: 17,
  height: 4.2,
  sensitivity: 0.0022,    // rad per pixel
  levelRate: 2.2,         // how fast the camera rolls itself upright
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
  tracerWidth: 0.2,       // m, close up
  tracerMinPixels: 0.0026, // keeps far tracers at least ~2-3 px wide
  roundLife: 3,           // s
  missiles: 6,            // one per station: 2 wingtips + 4 pylons, no reload
  seekerFov: 24,          // deg, full width of the seeker circle
  lockTime: 0.8,          // s on target to lock
  lockRange: 4000,        // m
  missileThrust: 230,     // m/s² while the motor burns
  motorTime: 2.6,         // s
  missileMaxG: 28,
  missileLife: 14,        // s
  proximity: 12,          // m
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
