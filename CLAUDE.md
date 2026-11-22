# THEgame: jet dogfighter (working title)

## Ground rules
- Three.js + Vite, plain JavaScript. Target CrazyGames first, Poki later; must run well on Chromebooks.
- Minimal text in the game. No labels, tooltips or explanatory copy; communicate visually. Allowed text so far: "CLICK TO START", the IAS (KT) and G readouts, the 1/2 weapon key hints, and enemy distances in km. Dev-only tools (the ` panel) are exempt.
- No real aircraft names, manufacturers, countries, flags or insignia anywhere in the game or store pages. Repaint all models.
- Every third-party asset must be commercial-use licensed (CC0, CC-BY, or a store license; never NC or ND) and listed in CREDITS.md.
- No sound yet.

## Layout
- `src/config.js`: every tunable number (flight model, mouse-aim instructor, camera, world).
- `src/flight/`: atmosphere, flight model (`aircraft.js`), mouse-aim autopilot (`instructor.js`), flight of doomed enemies from what is left of their airframe (`crippled.js`).
- `src/world/`: CDLOD terrain from a heightmap (mirrors past the map edge) and the shared sky/haze.
- `src/jet.js`: F-5 model, control surface pivots, gear/doors, afterburner.
- `src/damage.js`: break-apart damage model shared by every aircraft (parts, hit points, debris, flight effects); per-type region tables (REGIONS).
- `src/enemy.js`: enemy aircraft types (first: the early swept-wing jet, gear removed, split into parts).
- `src/weapons.js`: guns (tracer per round), missiles (6 stations, no reload), seeker/lock, explosions, target drone.
- `src/hudArms.js`, `src/hudXray.js`: weapon panel and X-ray damage view. `src/touch.js`: touch controls (drag to aim, throttle slider, fire/switch).
- Dev kit (top-right button): model viewer with every animation, door angles and part breaking.
- `tools/terrain/`: swisstopo download and build scripts. Raw tiles live in `terrain-raw/` (git-ignored); built files in `public/terrain/<area>/`.

## Run
npm install, then npm run dev. Press ` in game for the tuning panel.
