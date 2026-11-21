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
  pitchLock: 0.55,        // fraction of pitch authority lost at pitchLockEnd

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
  stickLag: 0.035,         // s for controls to follow a command (smooths jitter)
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
  sunElevation: 38,
  sunIntensity: 3.6,
  saturation: 1.3,
  clouds: 60,             // cloud clusters around the player (0 = none)
  cloudBase: 3700,        // m
  fogDensity: 0.00007,
  fogFalloff: 0.00035,    // 1 / haze scale height
  terrainBrightness: 1.45,
  terrainRelief: 0.65,    // how much our sun shading is added on top of the photo
  terrainDetail: 900,     // m: radius of full-detail terrain (lower = faster)
  pixelRatio: 1.5,        // render resolution cap
  spawn: { x: -6500, y: 3300, z: 15500, heading: 48, speed: 230 },
};

const KEY = 'thegame.tune';
export const TUNABLE = { F5, INSTRUCTOR, CAMERA, WORLD };

export function loadTuning() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const [group, values] of Object.entries(saved)) {
      if (TUNABLE[group]) for (const [k, v] of Object.entries(values)) if (typeof TUNABLE[group][k] === typeof v) TUNABLE[group][k] = v;
    }
  } catch { /* storage blocked or bad data: keep defaults */ }
}

export function saveTuning() {
  try { localStorage.setItem(KEY, JSON.stringify(TUNABLE)); } catch { /* ignore */ }
}

export function clearTuning() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
