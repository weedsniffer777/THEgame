# THEgame: jet dogfighter (working title)

## Ground rules
- Three.js + Vite, plain JavaScript. Target CrazyGames first, Poki later; must run well on Chromebooks.
- Minimal text in the game. No labels, tooltips or explanatory copy; communicate visually. The only allowed text so far is "CLICK TO START". Dev-only tools (the ` panel) are exempt.
- No real aircraft names, manufacturers, countries, flags or insignia anywhere in the game or store pages. Repaint all models.
- Every third-party asset must be commercial-use licensed (CC0, CC-BY, or a store license; never NC or ND) and listed in CREDITS.md.
- No sound yet.

## Layout
- `src/config.js`: every tunable number (flight model, mouse-aim instructor, camera, world).
- `src/flight/`: atmosphere, flight model (`aircraft.js`), mouse-aim autopilot (`instructor.js`).
- `src/world/`: CDLOD terrain from a heightmap (mirrors past the map edge) and the shared sky/haze.
- `src/jet.js`: F-5 model, control surface pivots, afterburner.
- `tools/terrain/`: swisstopo download and build scripts. Raw tiles live in `terrain-raw/` (git-ignored); built files in `public/terrain/<area>/`.

## Run
npm install, then npm run dev. Press ` in game for the tuning panel.
