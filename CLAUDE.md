# THEgame: jet dogfighter (working title)

## Ground rules
- Three.js + Vite, plain JavaScript. Target CrazyGames first, Poki later; must run well on Chromebooks.
- Minimal text in the game. No labels, tooltips or explanatory copy; communicate visually. Allowed text so far: "CLICK TO START"; the flight HUD's numbers (speed tape and readout with KT, altitude tape and readout, G, heading tape and readout); the 1/2 weapon key hints; enemy distances (only on the nearest enemy and the one nearest the screen centre; nm, then ft inside 1.5 nm, or km/m); and enemy aircraft types in plain words ("Fighter", "Bomber"; never real names). Ticks, notches and numbers are fine; letters only where they are really needed. Menus (pause, settings) use short uppercase words. Tutorial prompts (a short sentence-case line high in the centre, with big keycaps that fill green while held, optionally in labelled groups such as Pitch / Roll / Yaw, Speed up / Slow down; never "click to continue") and the mission-complete card. The ring round the reticle: enemy type and km by its pointer. Status notices a little below the centre (white, sentence case, each in its own fixed row): Airbrake on, Landing gear extended. Warnings high in the centre (near-white with a hint of red, a bit bigger, steady, one per row): Slow down to extend landing gear!, Out of missiles! (when the selected weapon runs dry it switches to guns; an empty weapon can't be selected). Touch buttons GEAR and BRAKE. A bright solid diamond on each missile; enemy missiles show their distance (nm, ft inside 1.5 nm), ours none. Dev-only tools (the ` panel) are exempt.
- No real aircraft names, manufacturers, countries, flags or insignia anywhere in the game or store pages. Repaint all models.
- Every third-party asset must be commercial-use licensed (CC0, CC-BY, or a store license; never NC or ND) and listed in CREDITS.md.
- No sound yet.

## Layout
- `src/config.js`: every tunable number (flight model, mouse-aim instructor, camera, world).
- `src/flight/`: atmosphere, flight model (`aircraft.js`), mouse-aim autopilot (`instructor.js`), flight of doomed enemies from what is left of their airframe (`crippled.js`).
- `src/world/`: CDLOD terrain from a heightmap (mirrors past the map edge) and the shared sky/haze.
- `src/jet.js`: F-5 model, control surface pivots, gear/doors, afterburner. Surface travel and flap schedule come from the plane's config (`F5.surfaces`), never hard-coded.
- `src/damage.js`: break-apart damage model shared by every aircraft (parts, hit points, debris, flight effects); per-type region tables (REGIONS).
- `src/enemy.js`: enemy aircraft types (first: the early swept-wing jet, gear removed, split into parts).
- `src/weapons.js`: guns (tracer per round), missiles (6 stations, no reload), seeker/lock, explosions, target drone.
- Player jet paints (`F5_PAINTS` in jet.js; default 'grey', switchable in the model viewer): textures made by `tools/paint/f5_paints.py` from the texel-to-airframe map of `tools/paint/posmap.py` (the atlas is shared by both sides, so numbers and lettering are runtime decal cards, never painted into it).
- `src/paint.js`: paint schemes (per type in enemy.js / jet.js: texture file -> repainted file in `public/models/jets/paints/`). Enemies currently use 'standard'; 'unmarked' (no stars) is ready.
- `src/save.js`: the one save file (tutorialDone, settings, ...). `src/mission/mission1.js`: Mission 1 (formation on a straight track, completion). `src/ui/tutorial.js`: tutorial overlay (line + keycaps that fill and pulse, multi-hole spotlight; never freezes the game), mission-complete card; the steps live in `main.js` (tutorialStep). Default mode is Mission 1; `?mode=free` (dev kit level selector) is free flight.
- `src/settings.js`: player settings (units; HUD colour DEFAULT or GREEN: green turns every HUD element of ours green, enemy red stays; on the map we and our missiles are white) and unit conversions; `src/ui/pauseMenu.js`: pause menu with settings tabs.
- `src/hudFlight.js`: flight HUD (speed/altitude tapes, heading, G, throttle scale, pitch marks). `src/hudRing.js`: ring round the reticle with pointers to what is outside it (nearest enemy now; friendlies and missile warnings later). `src/hudMap.js`: minimap. `src/hudArms.js`, `src/hudXray.js`: weapon panel (one column per weapon, key number on top, weapons nose up) beside the X-ray damage view, bottom right. `src/touch.js`: touch controls (flight left: plain throttle (black bar, square grey block, detent notches on one side), airbrake, gear when slow/low; weapons right: fire, zoom, tap a weapon column). Missile lock: nose-fixed seeker circle, a small lock circle that slides onto the target.
- Dev kit (top-right button): model viewer with every animation, door angles and part breaking.
- `tools/terrain/`: swisstopo download and build scripts. Raw tiles live in `terrain-raw/` (git-ignored); built files in `public/terrain/<area>/`.

## Run
npm install, then npm run dev. Press ` in game for the tuning panel.
