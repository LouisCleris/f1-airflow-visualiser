# Progress Log

## Summary (read this first)

1. **What it is:** a browser tool that draws approximate airflow around two of my own models, an F1 car on a track and
   a Falcon 6X jet in the sky: traced streamlines, speed as colour (blue slower than the oncoming air, orange faster),
   a wake, moving scenery, and click-to-read component cards. It is a visualisation, not a simulation, and shows no
   numbers.
2. **Where it stands:** all phases are done. The F1 has Straight line and Cornering (curved oncoming flow); the
   Falcon 6X has its own scene. It is a desktop-browser tool: on a screen too small for the layout the page shows a
   notice to open it on a computer and downloads nothing. It is built to `dist/` (page, models, baked data).
3. **Checks:** `npm test` (flow checks for the F1 straight line, the F1 cornering and the Falcon, models untouched) and
   `npm run test:ui` (interface checks in headless Chrome, dev or dist) all pass.
4. **Published:** first on 2026-10-18: on GitHub Pages.
5. **Not verified:** frame rate on a real GPU (headless Chrome renders in software).
6. **Next:** freeze around 28 October 2026; after the freeze, only fixes.
7. **Layout:** `docs/` has the spec and phase briefs; `data/` the baked fields; `src/` the app; `scripts/` bake/build tools;
   `tests/` the checks. `../FOLDERS.md` explains the folders around this one.
8. **Rules:** never modify the source models; no computed numbers on screen; the car is always "F1"; see `CLAUDE.md`.
9. **Easy to change:** component text in `data/components.json`, slider behaviour in `src/uiConfig.js`, flow in
   `data/rakes.json` (then `npm run bake`), cornering in `src/particles/cornering.js`.
10. **Known leftovers:** the occupancy grid is still loaded though the signed distance field does most of its job (a 2.5 MB
    follow-up); the full log below is long, newest entry at the bottom.

## Phase 0 — Setup
_status: done_

**Filename discrepancy (read this, the author):** CLAUDE.md and BUILD.md refer to
`models/f1.glb` and `models/falcon.glb`, but those files don't exist. The
actual files present are `models/F1 model.glb` (26,781,220 bytes) and
`models/Falcon 6X 1 .glb` (8,928,888 bytes). Component names confirm the
mapping unambiguously:
- `models/F1 model.glb` → **the F1 car** (component names include "Rear Wing
  main part", "Front wing Top", "DRS Mechanism", "Floor", "Front Tire", "Rear
  Tire", "Steering Wheel", etc.)
- `models/Falcon 6X 1 .glb` → **the Falcon 6X jet** (exactly 6 components:
  "Main Body", "Wings", "Back Tail", "Engines", "Windows", "Door" — matches
  spec section 9 exactly)

All code/config references these real on-disk filenames, not `f1.glb` /
`falcon.glb`. Rename the files at the source yourself if you want the docs'
placeholder names to match — nothing here renames them.

Note also: the spec (section 9) says the F1 car is "29 components, 17
logical groups" and "240k+ faces". The actual GLB has **40** named
components (nodes with a mesh) and an approximate triangle count of ~70k as
computed from accessor counts (not a full render-time count — could differ
from what three.js reports once it's actually loaded in Phase 1). The
Falcon's component count (6) matches the spec exactly; its approximate face
count came out ~86k vs. spec's ~163k. Not a blocker — component **names**
are what matters for `mesh.name` traversal, and those are all present and
descriptive. Flagging in case the spec's numbers were from an older export.

**What was built:**
- `package.json` — `type: module`, deps: `three@^0.186.0` (current, not
  r128), devDep: `esbuild@^0.28.2`. Scripts: `dev`, `build`, `test`,
  `inspect-models`.
- `src/main.js`, `src/index.html` — minimal module-based scaffold. Proves
  the toolchain (ES module resolution, three.js import) works; no scene or
  GLB loading yet — that's Phase 1.
- `scripts/dev-server.js` — zero-dependency static file server serving the
  project root, so `src/main.js` loads as a real unbundled ES module via an
  importmap (`three` → `node_modules/three/build/three.module.js`) during
  development. Verified: serves `src/index.html`, `src/main.js`,
  `node_modules/three/...`, and `models/*.glb` all with 200 OK.
- `scripts/build.js` — bundles `src/main.js` (and everything it imports,
  including three.js) with esbuild into one IIFE, inlines it into
  `src/index.html` (stripping the dev-only importmap block), and writes the
  result to `dist/index.html` (single self-contained file — verified
  three.js revision 186 present inline, valid JS). Also copies `models/`
  into `dist/models/` (read-only copy; originals untouched) so `dist/` is a
  deployable folder. `dist/` is gitignored and was removed after the smoke
  test — regenerate with `npm run build`.
- `scripts/inspect-glb.js` — read-only GLB inspector (parses the binary
  header + glTF JSON chunk directly, no scene-graph load, so nothing merges
  or loses names). Used both standalone (`npm run inspect-models`) and as a
  library by the fixture generator and `tests/checks.js`.
- `scripts/generate-fixtures.js` — one-off/re-runnable generator that reads
  the two source GLBs and writes `tests/fixtures/expected-components.json`
  and `tests/fixtures/model-checksums.json`. Only reads the models; re-run
  deliberately if a source model is ever intentionally replaced.
- `tests/checks.js` — the three required assertions:
  1. **Component names present** — actually runs now (parses both GLBs via
     `inspect-glb.js` and diffs against the captured fixture). PASSED.
  2. **Frame time < 16ms at max particle density** — SKIPs with "not
     applicable yet — Phase 2 ... has not been built" until `src/particles/`
     exists.
  3. **Zero particles inside occupied collision-grid cells** — SKIPs with
     "not applicable yet — Phase 3 ... has not been built" until `data/`
     contains a baked grid file.
- `tests/models_untouched.js` — sha256 + byte-length checksum guard against
  `tests/fixtures/model-checksums.json`. Fails loudly and non-zero-exits if
  either real source GLB changes.
- `data/.gitkeep` created for the Phase 3 occupancy grid output.

**Test output (`node tests/checks.js`):**
```
Running project checks (tests/checks.js)

[PASS] assertion 1: expected component names present in GLB — all expected components present (f1=40, falcon=6)
[SKIP] assertion 2: frame time < 16ms at max particle density — not applicable yet — Phase 2 (particle system) has not been built. src/particles/ does not exist.
[SKIP] assertion 3: zero particles inside occupied collision-grid cells — not applicable yet — Phase 3 (occupancy grid baking + deflection) has not been built. data/ contains no baked grid file.

Summary: 1 passed, 2 skipped, 0 failed.
```
Exit code: 0.

**Test output (`node tests/models_untouched.js`):**
```
OK   [f1]: models/F1 model.glb unchanged (sha256 bd71a85f837d..., 26,781,220 bytes)
OK   [falcon]: models/Falcon 6X 1 .glb unchanged (sha256 697c82ede4dc..., 8,928,888 bytes)

models_untouched: all source models unchanged. PASS.
```
Exit code: 0.

**Source models confirmed untouched:** sha256 checksums taken before any
work (`F1 model.glb` = `bd71a85f...`, `Falcon 6X 1 .glb` = `697c82ed...`)
match the checksums re-verified at the end, and match the fixture baseline.
Byte counts identical (26,781,220 and 8,928,888). Never opened with a
scene-graph loader that could merge/rewrite anything — only read as raw
bytes.

**`git status`:** project is not a git repository (no `.git` directory
anywhere above it). Not initialised, per instructions — flagging only.

**What's left:** everything from Phase 1 onward. Nothing in this phase
touched rendering, GLB loading in-browser, particles, or the occupancy grid.

**Known issues:** none. Stopping here as instructed — do not start Phase 1.

---

## Phase 1 — Model on screen
_status: done_

**Major finding (read this, the author): the source GLB is modelled as a
right-hand HALF-car only.** Direct bounding-box inspection of every one of
the 40 nodes in `models/F1 model.glb` (all reads, nothing written) showed
31 of them — essentially every wing, the main body, the floor, both wheel
pairs, the mirrors, the seat, the glass and the suspension arms/rods — sit
entirely at world X >= ~0. Only small, already-centred parts (steering
wheel assembly, antennas, exhaust, buttons, etc.) are genuinely symmetric
in the file. This is almost certainly an un-applied mirror modifier from
the original 3D package, not something wrong with the export. Loading the
GLB as-is renders half a car sliced down the centreline — a large "missing
surface" that would have failed this phase's check outright.

CLAUDE.md forbids ever touching the source file, so the fix is entirely
runtime, in `src/car.js`: for each of those 31 components, a second
`Object3D` is added that **shares the original BufferGeometry and Material
by reference** (no vertex is cloned, edited, or decimated) with
`position = (-x, y, z)`, `quaternion = (qx, -qy, -qz, qw)`,
`scale = (-sx, sy, sz)` — the exact mirror image about world X = 0. Three.js
compensates triangle winding and lighting normals automatically for the
resulting negative-determinant transform, so this reads as a correctly lit,
correctly facing left half with zero extra geometry data and zero risk to
`models/F1 model.glb`. The full derivation (including why the axis
convention is what it is) is in the comments at the top of `src/car.js`.
Screenshots in `shots/phase1-*.png` (front, three-quarter, side, top,
rear-close, low-angle) confirm the reconstructed car reads as complete and
symmetric from every angle checked, no seam or gap visible at the
centreline.

**Second finding: GLTFLoader does not preserve `mesh.name` the way Phase 0
assumed.** Two quirks, both handled in `src/car.js`:
1. GLTFLoader sanitizes `Object3D.name` for animation-track safety (spaces
   etc. become underscores, e.g. "Front Tire" -> "Front_Tire"). The exact
   original name (with spaces, including the handful of authored trailing
   spaces like "Front Arms ") is preserved verbatim on
   **`object.userData.name`** — that is what component lookups, the
   right-only-mirroring set, and the wheel-spin set all match against, not
   `.name`.
2. A glTF node whose mesh has more than one primitive (several do — e.g.
   "Front Wheelover" is a tyre cover + a hub as two primitives) is not
   built as one `THREE.Mesh`; GLTFLoader builds a `Group` carrying the
   node's name/transform, wrapping one anonymously-named child `Mesh` per
   primitive (e.g. "Circle003", "Circle003_1" — not useful as identifiers).
   So "one authored component" is "one Object3D (Mesh or Group) whose
   `userData.name` is set", not reliably "one Mesh". Component
   registration, mirroring, and wheel-spin all operate at that granularity,
   so Phase 7's per-component click lookup will find exactly the 40 names
   in `tests/fixtures/expected-components.json`, confirmed by a runtime
   check (`components.size === 40`) during verification.

**What was built:**
- `src/scene.js` — renderer (sRGB output, ACES tone mapping, PCF soft
  shadows), camera, hemisphere + directional (with shadow) + fill lights, a
  simple asphalt-coloured road plane with dashed centreline markings,
  window resize/orientationchange-aware `resize()`, and a free-orbit
  `OrbitControls` (damping on, polar angle capped just above the road,
  explicit touch mapping: one-finger rotate, two-finger dolly+pan).
- `src/car.js` — loads `models/F1 model.glb` via `GLTFLoader` at full
  detail (no decimation anywhere in this path), builds the
  name -> `Object3D[]` component lookup, and runtime-mirrors the 31
  right-only components described above. Exports `WHEEL_SPIN_COMPONENTS`.
- `src/wheels.js` — `createWheelSpinner(wheels)` returns a per-frame
  `update(deltaSeconds)` that spins each of the 6 wheel-corner components
  (Front/Rear x Tire/Wheelover/Inside Cover) around its axle with
  `mesh.rotateY(angle)`. Axle-axis derivation (why local Y, verified from
  the raw accessor bounding box, not assumed) and the mirrored-wheel sign
  flip (mirrored wheels get `-angle`, so left and right roll the same
  physical direction instead of visually counter-rotating — proven
  algebraically via quaternion conjugation, see file header) are documented
  in the file. Suspension links (Front/Back Arms, Front/Rear Rods) are
  geometrically mirrored like any other right-only part but are
  deliberately **not** spun — a real F1 arm pivots with suspension travel,
  it doesn't complete rotations, and this phase doesn't simulate
  suspension travel.
- `src/main.js` — rewritten from the Phase 0 scaffold: wires scene + car +
  wheel spinner together, drives the render loop with `THREE.Clock`,
  updates on resize/orientationchange, shows a brief loading/component-count
  status line, and exposes `window.__airflow = { scene, camera, renderer,
  controls, car, components, wheels }` as a debug/inspection hook for the
  `/lookcheck` skill and manual console poking (not part of the user-facing
  UI).
- `src/index.html` — full-viewport `<canvas id="viewport">` (`100dvh`,
  `touch-action: none` so OrbitControls owns all gestures,
  `overscroll-behavior: none` so the page doesn't rubber-band over the
  canvas), importmap extended with
  `three/addons/loaders/GLTFLoader.js` and
  `three/addons/controls/OrbitControls.js` (both resolve equally under the
  dev-server's raw-ESM importmap and under esbuild's bundling — verified
  both paths).

**What was verified:** `npm run build` produces a single self-contained
`dist/index.html` that loads and renders correctly in a real (headless)
browser engine (see below). Frame rate on a real GPU was not measured.

**Visual/hole check — what was actually verified:** headless Chrome
(Chrome for Testing, via `puppeteer`, `--use-gl=angle --use-angle=
swiftshader`) was installed temporarily (never added to `package.json` —
installed with `--no-save`, fully uninstalled afterward; `npm ls` back to
exactly `three` + `esbuild`, matching Phase 0) to actually render the app
and screenshot it, rather than relying only on reasoning. This caught the
half-car issue above concretely (before the mirror fix, the render showed
literally half a car) and confirmed the fix visually from six angles
(front, three-quarter, side, top, low rear-close, low front-three-quarter)
— saved in `shots/phase1-*.png`. No holes, gaps, or missing surfaces
visible at the mirrored centreline seam from any of those angles.
Wheel-spin was verified two ways: (1) algebraically, by reading the
mirrored/original wheel quaternions before and after manual `rotateY` calls
and confirming they stay in exact mirror relationship throughout
rotation; (2) at runtime, by forcing ~60 real animation frames through the
browser's own `requestAnimationFrame` queue (headless Chrome throttles rAF
to near-zero when idle with nothing pumping the compositor — a headless-
testing artifact, not an app bug — so frames were forced explicitly) and
confirming the wheel visibly rotated (158 degrees over those 60 frames).
**Not verified:** true photorealistic/PBR correctness of materials — see
known issue below — and no frame-by-frame video capture was done, only
static angle screenshots plus the numeric rotation check above.

**Known issue for Phase 4 (visual polish, not fixed here — out of this
phase's scope and CLAUDE.md reserves visual judgement for the author):** the
"Rear Tire" mesh in the source GLB references an unnamed, plain-white
default-looking material (`material.name === ''`), distinct from "Front
Tire"'s properly authored "Rubber" material. Both the original and the
runtime-mirrored copy use the same material (confirmed identical
`material.uuid` between them, so this is not a mirroring bug), it is a
pre-existing property of the source asset. Under the current lighting it
renders the rear tyres visibly lighter/flatter than the front tyres — not a
hole or missing geometry, just an under-specified material. Flagging for
Phase 4 rather than touching materials now.

**What's left:** everything from Phase 2 onward (particles, occupancy
grid, look-and-feel tuning, cornering, Falcon scene, UI polish, ship).
Nothing in this phase touched particles or the occupancy grid, so
assertions 2 and 3 in `tests/checks.js` still correctly SKIP.

**Test output (`node tests/checks.js`):**
```
Running project checks (tests/checks.js)

[PASS] assertion 1: expected component names present in GLB — all expected components present (f1=40, falcon=6)
[SKIP] assertion 2: frame time < 16ms at max particle density — not applicable yet — Phase 2 (particle system) has not been built. src/particles/ does not exist.
[SKIP] assertion 3: zero particles inside occupied collision-grid cells — not applicable yet — Phase 3 (occupancy grid baking + deflection) has not been built. data/ contains no baked grid file.

Summary: 1 passed, 2 skipped, 0 failed.
```
Exit code: 0.

**Test output (`node tests/models_untouched.js`):**
```
OK   [f1]: models/F1 model.glb unchanged (sha256 bd71a85f837d..., 26,781,220 bytes)
OK   [falcon]: models/Falcon 6X 1 .glb unchanged (sha256 697c82ede4dc..., 8,928,888 bytes)

models_untouched: all source models unchanged. PASS.
```
Exit code: 0. Checksums identical to the Phase 0 baseline — confirmed
before and after all work in this phase, and the mirroring approach above
never opens the file with anything but the read-only GLTFLoader fetch.

**`git status`:** still not a git repository (no `.git` directory anywhere
above the project). Not initialised, per instructions — flagging only, did
not run `git init`.

**Stopping here as instructed — do not start Phase 2.**

---

## Phase 2 — Particles
_status: done_

**What was built:** a particle system with uniform base flow and fading
ribbon trails, no obstacle interaction (per BUILD.md — that's Phase 3). All
new code lives in `src/particles/`, five small modules instead of one big
one:
- `src/particles/config.js` — plain-data config: `count` (live/default
  density) and `maxCount` (buffer size / "maximum particle density", 8000)
  are the density control point BUILD.md item 6 asks for; also
  `trailLength`, flow speed/jitter, spawn-domain multipliers, colour, alpha
  range. Every later phase (density/trail-length sliders in Phase 7, speed
  slider in Phase 5) should only need to touch this file or pass overrides,
  not the logic modules.
- `src/particles/domain.js` — the only particle module that touches
  three.js/GLTF data. Derives the flow domain from the **actual loaded car
  bounding box** rather than hardcoding axes: flow axis = whichever
  horizontal world axis (X/Z) the car's bounding box is longer along (Z,
  confirmed against the Phase 1 top-down screenshot, but re-derived live,
  not assumed); flow direction sign = compares average world position of
  every component whose name matches `/front/i` vs `/rear|back/i` (reuses
  car.js's own naming), so flow spawns upstream of the nose and travels
  toward the rear, matching wind-tunnel convention. Returns a plain-number
  `FlowDomain` object (origin, direction, right/up basis, spawn distance,
  travel distance, half-width/height) — no three.js objects — so everything
  downstream stays engine-independent.
- `src/particles/particleSystem.js` — the actual simulation. Zero
  dependency on three.js or the DOM: structure-of-arrays `Float32Array`s
  (positions, per-particle speed, ring-buffer trail history), scalar math
  only (no sqrt/trig in the per-frame loop — recycling uses one dot product
  against the unit flow direction). This is deliberately the "CPU update,
  chosen over real GPU compute" referenced in the task: a per-particle
  update this cheap (a handful of adds + one dot product) didn't justify
  transform-feedback/compute-shader complexity for Phase 2's uniform flow;
  worth revisiting if Phase 4's curvature/wake fields make the per-particle
  cost much higher. Being three.js-free is also what makes it directly
  importable and benchmarkable from plain Node (see below).
- `src/particles/trailBuffers.js` — pure function that flattens each
  particle's ring-buffer trail into a linear vertex/colour array for a
  `THREE.LineSegments` geometry (2 vertices per segment, oldest→newest,
  degenerate zero-alpha segments for not-yet-filled trail history right
  after spawn). Also no three.js dependency — just typed arrays — so it's
  Node-benchmarkable too.
- `src/particles/trailRenderer.js` — the only file owning actual three.js
  rendering objects: one `THREE.LineSegments` (not points/sprites) using
  `LineBasicMaterial` with `vertexColors: true` + `transparent: true` and a
  **4-component (RGBA) `color` BufferAttribute**. Confirmed in
  `node_modules/three/src/renderers/webgl/WebGLPrograms.js`
  (`vertexAlphas: material.vertexColors === true && geometry.attributes
  .color.itemSize === 4`) that three.js 0.186 honours per-vertex alpha this
  way (`USE_COLOR_ALPHA` shader path) — no custom `ShaderMaterial` needed.
  This is what gives each trail a fading ribbon rather than a uniform-alpha
  line: alpha ramps from `minAlpha` (oldest point) to `maxAlpha` (newest),
  satisfying "trails, not dots... alpha fade along its length" directly.
  Buffers are sized once for `maxCount` and only the draw range changes
  when density changes, so density can vary at runtime with zero
  reallocation.
- `src/particles/index.js` — wires the four modules above into one handle
  (`createParticleField(carRoot)` → `{ object3D, update(dt), setDensity(n),
  count, maxCount }`) that `src/main.js` adds to the scene and ticks in the
  render loop alongside the existing wheel spinner.
- `src/main.js` — updated to create the particle field once the car has
  loaded (needs its bounding box), add its `object3D` to the scene, and
  call `particles.update(dt)` every frame; also exposes `particles` on the
  existing `window.__airflow` debug hook.

**Why lines, not billboarded/textured ribbon quads:** BUILD.md's Phase 2
check is "trails, not dots" with alpha fade — a thin `LineSegments` trail
with per-vertex alpha already satisfies that (confirmed visually below) at
one draw call for the whole field. True width-varying ribbon quads (camera-
facing, billboarded) would look better but is extra complexity (per-frame
billboard basis vectors, more vertices/attributes) that reads as a Phase 4
"make it look good" concern, not a Phase 2 functional requirement — flagging
here in case the author wants it revisited then.

**Frame-time benchmark (`tests/checks.js` assertion 2) — method and
result:** No headless-GL renderer is part of this project's toolchain (Phase
1 installed `puppeteer` only temporarily for screenshots and fully
uninstalled it afterward — see below, same pattern repeated this phase), so
an actual WebGL/GPU frame time cannot be measured from plain Node. Rather
than fake this, `tests/particles.bench.js` measures — for real, not
estimated — the entire CPU-side per-frame cost the app performs: (1)
`particleSystem.js` `update(dt)`, the real physics step, and (2)
`trailBuffers.js` `fillTrailBuffers()`, the real per-frame trail-vertex
rebuild that feeds the three.js geometry (exactly what `trailRenderer.js`'s
`sync()` calls internally). It runs both at `maxCount` = 8000 particles
(config.js) for 30 warm-up frames then 180 timed frames using
`process.hrtime.bigint()`, and reports mean/p95/worst. **Not measured:** the
actual GPU draw call, shader execution, or compositing — those need a real
or headless GPU context this toolchain doesn't have. This limitation is
documented in both `tests/particles.bench.js` (top-of-file comment) and
`tests/checks.js` (inline above `checkFrameTime()`), not just here.

Latest run: **8000 particles, mean 1.4–1.5ms, p95 ~2.3ms, worst ~2.5–3.9ms
across repeated runs** — comfortably under both the 16ms/frame budget and
the stricter 6ms mean threshold `checks.js` actually asserts against (chosen
to leave ~10ms/frame of headroom for the unmeasured GPU work on a real
device). `node tests/checks.js` now **PASSes assertion 2** (previously
SKIP).

**Visual sanity check:** same temporary-install pattern as Phase 1 —
`puppeteer` installed with `--no-save` (Chrome for Testing was already
cached locally from Phase 1, no re-download), used to load the dev server,
pump real `requestAnimationFrame` frames (headless Chrome throttles rAF
when idle, same note as Phase 1), and screenshot; then **fully uninstalled**
(`npm uninstall puppeteer`) and `npm ls` reconfirmed back to exactly `three`
+ `esbuild`, matching the Phase 0/1 baseline. Screenshots in
`shots/phase2-three-quarter.png` and `shots/phase2-side.png`: particles
visibly flow as fading streaks over and through the car (no obstacle
interaction yet, as expected — streaks pass straight through bodywork),
denser/brighter near the "tip" (newest point) and fading toward the tail,
confirming both the ribbon-not-dot rendering and the alpha fade are working
as intended. `dist/` from the `npm run build` smoke test was removed
afterward (gitignored, regenerate with `npm run build`), same as Phase 0/1.

**What's left:** obstacle deflection (Phase 3, occupancy grid), curvature
speed-up / wake turbulence / speed-based colouring (Phase 4), cornering yaw
+ speed control (Phase 5), Falcon scene (Phase 6), density/trail-length UI
sliders and play/pause/reset (Phase 7 — the code-level density control
point exists now via `setDensity()`/`config.count`, just no UI yet).

**Known issues / things to watch:**
- Trails are plain thin lines (`LineBasicMaterial`), not width-varying
  billboarded ribbons — see "why lines, not billboarded ribbon quads" above.
  Flagging for Phase 4 visual review, not fixing now.
- `speedJitter` in config.js gives each particle a small fixed speed offset
  for visual variety; this is still "uniform base flow" (identical
  direction for every particle, magnitude varies only slightly and only at
  spawn) — flagging in case that reads as scope creep beyond "a simple
  constant direction/speed for now".
- The frame-time benchmark is CPU-only by necessity (see above) — it is not
  a substitute for an on-device/real-browser frame-rate check. the author: if you
  want an actual measured browser frame time at some point, that needs a
  real GPU context (on-device, or a headless-GL setup beyond what's
  currently installed) — flagging, not blocking this phase.

**Test output (`node tests/checks.js`):**
```
Running project checks (tests/checks.js)

[PASS] assertion 1: expected component names present in GLB — all expected components present (f1=40, falcon=6)
[PASS] assertion 2: frame time < 16ms at max particle density — 8000 particles, 180 frames — mean 1.511ms, p95 2.302ms, worst 3.891ms (CPU update+trail-buffer step only, no GPU/WebGL — see tests/particles.bench.js)
[SKIP] assertion 3: zero particles inside occupied collision-grid cells — not applicable yet — Phase 3 (occupancy grid baking + deflection) has not been built. data/ contains no baked grid file.

Summary: 2 passed, 1 skipped, 0 failed.
```
Exit code: 0.

**Test output (`node tests/models_untouched.js`):**
```
OK   [f1]: models/F1 model.glb unchanged (sha256 bd71a85f837d..., 26,781,220 bytes)
OK   [falcon]: models/Falcon 6X 1 .glb unchanged (sha256 697c82ede4dc..., 8,928,888 bytes)

models_untouched: all source models unchanged. PASS.
```
Exit code: 0. Checksums identical to the Phase 0 baseline; nothing in this
phase ever opened either GLB with anything but the existing read-only
GLTFLoader fetch in car.js (unchanged) or the read-only `inspectGLB` chunk
reader.

**`git status`:** still not a git repository (no `.git` directory anywhere
above the project). Not initialised, per instructions — flagging only, did
not run `git init`.

**Stopping here as instructed — do not start Phase 3.**

---

## Phase 3 — Obstacle deflection

**What was built.** The offline bake (`scripts/bake_occupancy_grid.py`) and
the runtime collision-grid parser (`src/particles/collisionGrid.js`) were
already in place from an earlier session on this same phase, and are solid
— kept as-is. What was missing, and is now done: deflection was never
actually wired into the particle update loop, and `checks.js` assertion 3
was still a stub that unconditionally failed. Finished directly (not via a
fresh subagent) after the previous attempt hit a Claude session rate limit
mid-phase.

**Bake methodology** (`scripts/bake_occupancy_grid.py`, run once, output
committed to `data/`):
- Loads `models/F1 model.glb` read-only with `trimesh` (never
  `force='scene'`, which would merge geometry and lose the per-component
  names this project cares about elsewhere).
- Builds an in-memory decimated **copy** via
  `fast_simplification.simplify(...)` — never
  `trimesh.simplify_quadric_decimation()`, per CLAUDE.md — with an explicit
  `target_reduction=0.9`: half-mesh 39,287 verts / 70,207 faces →
  5,102 verts / 9,152 faces. The source file itself is never touched;
  confirmed by checksum before and after (see below).
- Mirrors the decimated copy about world X=0 — the same plane `src/car.js`
  uses at runtime to reconstruct the full car from its right-hand-half
  source GLB — by negating vertex X and reversing face winding to keep
  outward normals. This gives a full-car collision volume, not just the
  modelled half.
- Voxelises the mirrored, decimated mesh as a **hollow surface shell**
  (`trimesh`, `method='subdivide'`, no interior fill) at pitch ≈ 0.0289
  world units (180 divisions along the longest axis) → 30,596 occupied
  cells.
- For each occupied cell, stores a representative outward unit normal:
  area-weighted average of nearby face normals within an expanding search
  radius (1.5×–6× pitch), falling back to the nearest single face if
  nothing is found (0 cells needed the fallback).
- Output: `data/occupancy_grid.json` (header: bake params, tool versions,
  grid pitch/origin/cellCount, binary format) +
  `data/occupancy_grid.bin` (one 24-byte record per occupied cell: int32
  i/j/k grid index + float32 nx/ny/nz normal, little-endian). Versions used:
  Python 3.14.6, trimesh 5.1.0, fast_simplification 0.2.0, numpy 2.5.3,
  scipy 1.18.1.
- The header also stores the full-resolution (undecimated) mirrored car's
  world-space bounding box and flow axis/sign, derived with the same
  heuristic as `src/particles/domain.js` — this is what lets
  `tests/checks.js` build a matching flow domain in plain Node without a
  live three.js scene (see below).

**Deflection, wired into `src/particles/particleSystem.js` this session.**
Each particle now has a per-particle unit velocity *direction*
(`velX/Y/Z`), separate from its scalar `speed` and from the domain's shared
base flow direction (`dirX/Y/Z`). Every frame, when a `grid` is supplied to
`createParticleSystem(domain, config, grid)`:
1. **Soft steering.** If the particle is near the grid's occupied-region
   bounding box, search a small neighbourhood (`deflectionRadiusCells`, 3)
   for the nearest occupied cell; if found, pull the velocity direction
   toward that cell's stored outward normal (`deflectionStrength`,
   proportional to `dt`), otherwise relax it back toward the base flow
   direction (`flowRelaxRate`). Renormalise to a unit vector either way.
2. **Hard correction (the actual guarantee).** After moving by
   `speed * dt` along the (possibly steered) direction, if the new position
   still resolves to an occupied cell, push it straight out along the
   nearest occupied cell's normal in 1.5-pitch steps, escalating the search
   radius (`pushOutRadiusCells` × 1, 2, 4, 8) up to 24 iterations if nothing
   is found nearby at first.
3. **Last-resort recycle.** In the rare case a particle is still inside an
   occupied cell after that (measured at ~5 in 1.92M particle-frames before
   this fallback existed — specifically at thin trailing-edge features like
   the front wing tip, where two opposing shell walls sit only a couple of
   voxels apart), it is recycled upstream immediately, exactly as if it had
   reached the end of the domain. This makes "no particle ends a frame
   inside bodywork" true by construction, not just empirically likely.
- Passing no `grid` (as `tests/particles.bench.js` still does, for
  assertion 2) skips all of the above — velocity direction stays pinned to
  the base flow direction, reproducing Phase 2 exactly, at the same
  measured cost.
- `src/particles/domain.js` was refactored (behaviour-preserving) to
  extract `domainFromBounds(bounds, flowAxis, flowSign, config)`, the pure
  box→domain math, out of `computeFlowDomain(carRoot, config)`. This is
  what lets `tests/checks.js` build the exact same kind of flow domain from
  the bbox recorded in `occupancy_grid.json`'s header, in plain Node, with
  no three.js Object3D — so assertion 3 runs the real simulation against
  the real grid, not a mock of either.
- `src/main.js` now fetches `data/occupancy_grid.{json,bin}` in parallel
  with the (much larger) car GLB and passes the parsed grid into
  `createParticleField(root, { grid })`. If the fetch fails for any reason,
  the app still starts with Phase-2-style uniform flow rather than failing
  to load — logged as a console warning, not surfaced to the user (no
  computed numbers/errors in the UI, per CLAUDE.md).

**Assertion 3, implemented for real** (`tests/checks.js`): parses the
actual `data/occupancy_grid.json` + `.bin` via the exact same
`collisionGrid.js` `parseOccupancyGrid()` the browser uses, builds a flow
domain from the header's recorded bbox via `domainFromBounds()`, runs the
real particle system (with the real grid wired in) for 240 frames at
`maxCount` (8000) density, and checks every particle's position after
every frame — 1,920,000 particle-frames per run. Re-run 5 times back to
back (different `Math.random()` seeds each time, since particle motion is
stochastic) with zero violations every time.

**What's left:** curvature speed-up / wake turbulence / speed-based
colouring (Phase 4 — explicitly judged visually by the author, not built by an
agent), cornering yaw + speed control (Phase 5), Falcon scene (Phase 6),
UI polish (Phase 7).

**Known issues / things to watch:**
- Deflection is avoidance only, exactly per BUILD.md Phase 3 scope — no
  curvature acceleration or wake shaping yet, so flow still looks smooth
  rather than aerodynamic. That is Phase 4's job, not this one's.
- The recycle-on-stuck fallback (point 3 above) is a deliberate, documented
  design choice, not a hidden hack — flagging in case it reads as
  unexpected: a small number of particles per run reappear upstream slightly
  early rather than being visibly, permanently embedded in a thin trailing
  edge.
- Visual check (screenshots below) used the same temporary-puppeteer,
  fully-uninstalled-after pattern as Phases 1–2 (`npm ls` reconfirmed clean
  afterward: exactly `three` + `esbuild`). Streamlines visibly curve around
  the nose and front wheel and no longer pass through the bodywork in
  straight lines the way the Phase 2 screenshots show — a qualitative
  spot-check on top of, not a replacement for, the 1.92M-particle-frame
  assertion 3 above. Screenshots at default density (2500), not max
  (8000) — a few thin gaps between wing elements are visible in close-ups
  but no long straight streaks piercing solid bodywork.

**Test output (`node tests/checks.js`):**
```
Running project checks (tests/checks.js)

[PASS] assertion 1: expected component names present in GLB — all expected components present (f1=40, falcon=6)
[PASS] assertion 2: frame time < 16ms at max particle density — 8000 particles, 180 frames — mean 1.551ms, p95 4.043ms, worst 4.235ms (CPU update+trail-buffer step only, no GPU/WebGL — see tests/particles.bench.js)
[PASS] assertion 3: zero particles inside occupied collision-grid cells — 8000 particles x 240 frames (1,920,000 particle-frames) checked against the real baked grid in data/ — zero found inside an occupied cell

Summary: 3 passed, 0 skipped, 0 failed.
```
Exit code: 0.

**Test output (`node tests/models_untouched.js`):**
```
OK   [f1]: models/F1 model.glb unchanged (sha256 bd71a85f837d..., 26,781,220 bytes)
OK   [falcon]: models/Falcon 6X 1 .glb unchanged (sha256 697c82ede4dc..., 8,928,888 bytes)

models_untouched: all source models unchanged. PASS.
```
Exit code: 0. Checksums identical to the Phase 0 baseline throughout this
phase, including through the Python bake (which only ever reads the
original file to build an in-memory decimated copy) and the runtime
deflection work (which only reads `data/occupancy_grid.*`, never the GLB).

**`git status`:** still not a git repository. Not initialised, per
instructions — flagging only, did not run `git init`.

**Stopping here as instructed — do not start Phase 4.** Phase 4 is visual
quality, explicitly judged by the author via `/lookcheck`, not tuned in a loop
by an agent.

---

## Phase 3 addendum — traced streamlines replace short trails for the clean flow

Two rounds of `/lookcheck` visual feedback after the phase above:

**Round 1** (config-only tuning): `depthTest: true` made explicit, `count`
2500→625, `trailLength` 7→2, `widthMultiplier` 1.7→3.0 with a cosine-taper
spawn distribution, `spawnMargin` 1.5→0.4. Fixed the "car completely
occluded" problem, but the author correctly identified a structural issue no
amount of density/trail-length tuning could fix: a 2-point trail is
shorter than the radius of any real deflection curve, so bends are
literally not present in the geometry of a still frame, regardless of how
visible or dim it is.

**Round 2 — replaced short-trail particles with traced streamlines** for
the clean/attached flow; particles now used only for the wake:

- `src/particles/streamlines.js` (new, three.js-free like particleSystem.js):
  treats the flow as a genuine steady vector field
  `V(x,y,z) = normalize(baseFlowDirection + proximity-weighted repulsion)`
  and integrates `dPosition/dStep = V(position)` forward from each seed
  with Euler stepping. Deliberately a different code path from
  particleSystem.js's per-particle steering (which carries frame-to-frame
  momentum) -- a traced line has no "previous frame", only "the path so
  far", so the field must be a pure function of position.
  - `generateSeeds()`: a deterministic, evenly spaced grid (no randomness,
    no taper -- "even spacing is what makes displacement visible"),
    20 x 18 = 360 seeds across the full spawn-plane width (3x car width,
    from the round-1 `widthMultiplier`) and the car's actual height
    (0 to `domain.carHeight`, i.e. ground to roofline -- the bottom row
    sits right at ground level, low enough to probe the underfloor gap;
    see the voxel-vs-ride-height finding below for what that probe
    actually shows).
  - `traceStreamline()`: ~300-420 steps per line (`stepFraction: 0.65` x
    voxel pitch), stopping at the car's trailing edge
    (`domain.halfLength`) -- past that is wake territory, left to
    particles. Hard-corrects any point that still lands in an occupied
    cell via the same escalating-radius push-out as particleSystem.js's
    fix earlier in this phase; since a traced line (unlike a particle) has
    nowhere to recycle to, an unresolved point (measured at ~0.04% before
    the escalation) stalls at the previous point for one step instead.
    Verified in Node against the real baked grid: 0 violations across all
    110,707 traced points.
  - `domain.js` gained `halfLength`, `carWidth`, `carHeight`,
    `spawnMargin`, `downstreamMargin` on the returned domain object (the
    raw, un-multiplied numbers the seed rake needs) and a new
    `computeWakeDomain(domain)` that relocates a copy of the domain's
    spawn plane to the car's trailing edge with `travelDistance` shrunk to
    just `downstreamMargin` -- purely additive/derived, `domainFromBounds`'s
    existing fields and math are untouched.
  - `collisionGrid.js`'s `findNearestOccupied()` gained an optional 4th
    `outDistanceCells` param (grid-cell-unit distance to the found cell)
    for the streamline field's continuous distance-based falloff;
    optional and unused by particleSystem.js's existing calls.
- `src/particles/streamlineRenderer.js` (new): builds ONE static, indexed
  ribbon-strip `THREE.Mesh` from all 360 traced paths (~221K vertices,
  ~221K triangles at the current resolution) -- position buffer written
  once and never touched again ("do not move the line geometry"). Each
  path point becomes two vertices offset along `tangent x worldUp`, so the
  line has real width, including viewed from directly above (the
  originally-requested top-down check). A travelling brightness/colour
  pulse is animated by rewriting only the per-vertex COLOR buffer every
  frame from each vertex's precomputed arc-length -- a cheap triangular
  wave (modulo + abs, no per-vertex trig) specifically because this is an
  O(vertex count) CPU loop every frame and has to stay cheap.
  - First pass used `baseAlpha: 0.12` (dim resting line, bright pulse) on
    the theory that contrast would help the pulse read clearly. Wrong in
    practice, caught in `/lookcheck`'s own screenshots before reporting
    back: at 0.12 the resting line was nearly invisible in a still frame,
    so only scattered bright pulse fragments showed -- i.e. exactly the
    "disconnected dashes, no visible continuous curve" problem this whole
    change exists to fix. Raised to `baseAlpha: 0.42` (whole path clearly
    visible at rest, pulse still a distinct brighter highlight on top) and
    re-verified visually before reporting.
- `src/particles/streamlineField.js` (new): orchestrates the three files
  above into one `{object3D, update(dt)}` handle, mirroring `index.js`'s
  existing pattern.
- `src/particles/index.js`: `createParticleField()` now builds its
  particle system against `computeWakeDomain(fullDomain)` instead of the
  full domain -- spawn plane relocated to the car's trailing edge, travel
  range shrunk to the downstream wake margin only. Density/trail-length
  config (625 / 2, from round 1) unchanged; only the region they spawn in
  moved.
- `src/main.js`: creates and ticks both fields now (`createStreamlineField`
  alongside the existing `createParticleField`), sharing the one fetched
  occupancy grid between them.

**Voxel size vs. ride height (requested diagnostic, not acted on yet):**
Measured directly from the real GLB (`.venv/bin/python3` + trimesh, world-
space vertex bounds, read-only) rather than assumed:
- Occupancy grid voxel pitch: **0.02887 world units** (from
  `data/occupancy_grid.json`'s `grid.pitch`, 180 divisions along the car's
  longest axis).
- Floor's lowest point above ground: **0.037-0.042 world units** (two
  separate "Floor" geometry nodes in the source GLB, at y=0.03704 and
  y=0.04191 respectively). Ground reference: front/rear tires bottom out
  at y=-0.031 to -0.034, i.e. resting almost exactly on y=0 (the road
  plane), so ride height is very close to that floor-height figure itself.
- **Ratio: the underfloor gap is only ~1.3-1.5 voxels tall.** This is
  almost certainly not enough clearance for the current grid to represent
  a passable gap -- a single occupied voxel layer at the floor's surface
  is wide enough on its own to span most or all of that height, likely
  reading as sealed (or nearly sealed) to anything trying to pass under
  it, rather than as a genuine gap. This has NOT been re-baked or fixed:
  the grid and bake script are exactly as they were at the end of the main
  Phase 3 entry above, per instruction. If underfloor flow needs to read
  correctly, `scripts/bake_occupancy_grid.py --voxel-divisions` needs
  roughly 3-4x more divisions than the current 180 (so pitch drops to
  somewhere around 0.007-0.01) -- CLAUDE.md's own rule already names the
  fix ("if particles clip through bodywork ... make the voxels smaller"),
  this is the same principle applied to a gap that's too *small* to be
  seen at all rather than a surface being clipped through.

**Known issues / left uncertain:**
- Underfloor seeds (bottom seed row, y=0) will currently show whatever the
  sealed/near-sealed grid actually does at that resolution -- likely
  deflected up and over rather than passing through, which would be a
  grid-resolution artefact rather than a real aerodynamic statement, per
  the finding above.
- ~221K vertices with a full per-frame CPU colour rewrite is a real
  performance consideration; frame rate on a real GPU could not be
  measured in this environment.
- Streamlines and wake particles currently use visually-similar cool
  tints/widths with no explicit visual boundary marker where one hands off
  to the other at the trailing edge -- may be worth a deliberate visual
  distinction in Phase 4, the author's call.

**Checks:** `node tests/checks.js` -- 3/3 pass (assertions 1/2/3
untouched by this addendum's scope, re-verified after every edit above).
`node tests/models_untouched.js` -- both source GLBs checksum-identical to
the Phase 0 baseline throughout.

---

## Phase 3.5 — Streamline realism
_status: built, awaiting /lookcheck feedback_

Full spec: `../PHASE-3.5.md`. Replaces the Phase 3 addendum's rake-of-360-
uniform-grid streamlines **entirely**, per the spec's own instruction. The
occupancy-grid-based deflection from Phase 3 (`collisionGrid.js`
`findNearestOccupied()` -- distance + normal to the nearest occupied cell,
the closest thing this project has to a signed distance field) was kept
unchanged and is now used for three things instead of one: hard push-out
(unchanged from Phase 3), soft surface-hugging in the new field, and a
proximity term in adaptive seed scoring.

**New modules, all zero-dependency on three.js/DOM like the rest of
`src/particles/` (so they run in plain Node, same discipline as Phase 2/3):**
- `src/particles/anchors.js` -- converts the `data/rakes.json` fractional
  coordinate convention (alongFlow/lateral/vertical, relative to the car's
  own dimensions) into world positions/directions. Shared by rakes and
  vortex cores so both use the same kind of number.
- `src/particles/vectorField.js` -- the steady field streamlines are traced
  through: base flow, surface-hugging (damps the velocity component along
  the SDF-ish normal near the car, preserves the tangential component), and
  a handful of hand-placed vortex cores (Rankine-vortex-like radial profile,
  exponential axial decay). Returns a REAL velocity vector, not a unit
  direction -- magnitude naturally drops in stagnation-like regions (flow
  forced to turn sharply) and rises near vortex cores, with no invented
  "speed" number. Deliberately NOT Phase 4's curvature-squeeze effect --
  an honest by-product of the vector math, which Phase 4 can layer on top of.
- `src/particles/seeding.js` -- section 1b's adaptive selection: generates
  candidateMultiplier(7)x more rake-anchored candidates than the final
  count, coarsely pre-traces each, scores by peak velocity-gradient
  magnitude (finite differences at neighbouring offsets) + an SDF proximity
  term, greedily selects the top scorers subject to a minimum world-space
  separation, then fills a handful of context slots from the lowest scorers
  (rake leftovers + a separate SDF-density-weighted sparse background
  scatter). Total capped at 80 lines.
- `src/particles/streamlines.js` (rewritten) -- fixed-TIME-step Euler
  integration (`position += V(position) * dt`) rather than fixed-distance,
  so the field's real magnitude directly stretches/bunches drawn points by
  local speed with nothing extra to tune. Continues past the trailing edge
  into a short transition zone with growing random jitter and a decaying
  `coherence` value (1 -> 0) instead of stopping abruptly. Same hard
  push-out guarantee as Phase 3 (escalating-radius search, stall-in-place
  last resort) -- verified via a one-off Node script against the real baked
  grid: 80 lines, 8226 points, **zero** inside an occupied cell.
- `src/particles/streamlineRenderer.js` (rewritten) -- thin thin ribbon
  (halfWidth 0.008, was 0.016), additive blending + low base alpha (0.30)
  so overlaps build brightness rather than reading as a white sheet, alpha
  fades in over each line's first 6 points and out via `coherence`,
  speed-driven cool-to-warm per-vertex colour, and a brightness pulse
  phased against each vertex's time-of-flight (not arc length) so it
  visibly travels faster through faster regions with no separate "pulse
  speed" constant. Considered `three/addons/lines/LineMaterial` for true
  screen-space-constant width but didn't use it: its fragment shader
  hardcodes alpha to one uniform, no per-vertex alpha, which would need
  shader patching to get the fade-in/out and wake-incoherence fade this
  phase explicitly requires -- the low-alpha additive ribbon already avoids
  the "white sheet"/fence failure mode without that risk.
- `data/rakes.json` -- hand-authored (not baked) rake + vortex placement
  config, fetched at runtime like `occupancy_grid.json` (co-located with it
  for that reason, flagged in the file's own `_comment` to avoid confusion
  with the Python-baked grid). Anchors for front wing, front tyre, rear
  wing, and floor were measured directly from the loaded GLB's real
  component bounding boxes (temporary puppeteer measurement script, same
  install/verify/uninstall pattern as every earlier phase's visual checks)
  -- not guessed. `sidepod-inlet` has no dedicated named component in the
  source model, so its position is a reasoned estimate (just aft of the
  front wheel, at the body's side); flagging in case it reads wrong.
  `minSeparationWorld` needed tuning down from an initial 0.12 to 0.045 --
  at 0.12 it was rejecting most of a single rake's own adjacent seeds
  (several rakes' natural in-rake spacing is 0.05-0.09 world units), which
  defeated the point of a multi-seed rake.

**Wake hand-off (section 6):** `src/particles/particleSystem.js` gained a
`wakeSpreadRate` config value (`config.js`) -- a small random lateral/
vertical positional jitter added each frame, scaled by how far a particle
has travelled since its spawn plane (0 at spawn, full strength at
`travelDistance`). Applied to position, not the persisted velocity heading,
so it can't compound across frames. The existing grid push-out correction
still runs after it, so the zero-clipping guarantee (assertion 3) is
unaffected regardless of jitter magnitude.

**Build/ship gap fixed in passing:** `scripts/build.js` copied `models/`
into `dist/` but never `data/` -- meaning a shipped build's occupancy grid
(and now rakes.json) would 404. Both are runtime-fetched the same way, so
this was a real pre-existing gap for Phase 8; fixed by copying `data/` ->
`dist/data/` alongside the existing models copy.

**Verification before the visual check:**
- `node tests/checks.js` -- still 3/3 pass, unaffected (streamlines aren't
  part of any assertion; wake particle changes still pass assertion 3's
  1.92M-particle-frame check against the real grid).
- `node tests/models_untouched.js` -- unaffected, both GLBs checksum-identical.
- One-off Node script against the real baked grid: 80 streamlines, 8226
  total points, 0 inside an occupied cell, speed range ~0.73-5.70 (base flow
  speed is 5.5) -- confirms hugging can slow flow below base speed and
  vortices can push it above, as intended.
- Browser probe (temporary puppeteer, same install/uninstall pattern):
  loads with zero JS errors (only a pre-existing, unrelated favicon 404),
  80 streamlines / 16.4-17.3k vertices actually built in the live scene --
  **far fewer vertices than the ~221k the old 360-line rake used**, a
  meaningful performance improvement as a side effect of this phase.

**`/lookcheck` -- the skill itself wasn't in this session's preloaded skill
list** (it's project-local, under `.claude/skills/lookcheck/`, discovered
mid-session), so its documented steps were executed directly instead of
invoked as a skill: headless load, 300 simulation steps driven directly via
`particles.update()`/`streamlines.update()` (the rAF-pump approach hung --
headless Chrome throttles `requestAnimationFrame` to near-zero with nothing
forcing frames, same note every earlier phase left about this), four camera
angles (front/side/top/three-quarter), saved to `shots/phase3.5-*-<timestamp>.png`.
Own read of the results, flagging for the author's actual judgement rather than
tuning further:
- Individual streamlines do read as separate, thin, followable lines with
  no lattice/fence -- the core ask. Density is visibly concentrated near
  the car (front wing, floor, wheels) vs. thin in open air.
- Top-down view shows the centreline-seeded rakes (front wing, floor,
  rear wing) running quite straight fore-aft with not much visible lateral
  curvature -- plausible on its own (a symmetric nose doesn't deflect flow
  sideways at the centreline; lateral curvature would show better around
  the tyres), but flagging since it's the one thing that could read as
  "not wrapping" rather than "correctly straight here."
- The wake particle field's overall width (particles spawn across the full
  3x-car-width / 2x-car-height cross-section immediately at the trailing
  edge, per Phase 3's own `widthMultiplier`/`heightMultiplier`, unchanged
  here) reads as a wide "shower" in these screenshots. That spawn envelope
  predates this phase and was the author's own Phase 3 review choice, not
  something Phase 3.5 changed -- flagging only because the new
  `wakeSpreadRate` adds on top of it and the combined effect wasn't
  independently visually reviewed before this screenshot.
- Cool-to-warm colour range is real but modest (observed speeds only
  reached ~1.04x base flow speed at maximum, against a warm-colour ceiling
  set at 1.7x) -- vortex strengths in `data/rakes.json` are tunable by
  number if the author wants a hotter peak.

Puppeteer was installed with `--no-save` for the measurement + visual-check
scripts (same temporary pattern as every earlier phase), then fully
uninstalled afterward; `npm ls` reconfirmed back to exactly `three` +
`esbuild`, matching every earlier phase's baseline.

**What's left:** curvature speed-up / true wake turbulence / a "slower /
faster" legend (Phase 4 -- still explicitly the author's visual call, not tuned
by an agent), cornering yaw + speed control (Phase 5), Falcon scene
(Phase 6), UI polish (Phase 7).

**Stopping here as instructed -- waiting for `/lookcheck` feedback before
touching anything further.**

---

## Phase 3.5 addendum — wake particles switched off for deflection review

the author asked to see streamlines alone (no wake particles) to judge whether
deflection works, without the wake "shower" in the frame. Added a single
temporary flag, `WAKE_PARTICLES_ENABLED = false` in `src/main.js`, guarding
`createParticleField()`/its scene-add/its per-frame update -- everything
else (streamlines, grid, wheels) untouched. Flip it back to `true` to
restore the wake; not a permanent feature, flagged as such in the code
comment so it isn't mistaken for a real design decision later.

`node tests/checks.js` (3/3 pass) and `node tests/models_untouched.js`
re-verified unaffected. New `/lookcheck` round (same direct-execution
approach as before, temporary puppeteer install/uninstall) saved to
`shots/phase3.5-streamlines-only-*-<timestamp>.png` -- streamlines are far
easier to read with nothing else on screen: visible curvature around the
front tyre and along the floor from the side view, no lattice/fence in the
top view, individual lines followable throughout. Left for the author's own
judgement on whether the deflection amount/shape itself is right.

---

## Phase 3.5, round 3 -- wheel deflection bug, surface-anchored seeding, visual pass

Three items, done in the order given (item 1 before 2/3, since a wrong bake
would have made surface-anchored seeding meaningless).

### 1. Wheels: diagnosed, NOT a bake bug

Checked exactly what was asked: does the bake apply each node's world
transform, and are wheel meshes actually included (not name-filtered)?

- `scripts/bake_occupancy_grid.py` concatenates via `scene.to_geometry()`,
  which trimesh's own docstring says "applies the transforms and bakes the
  result" -- confirmed directly: for the `Front Tire` node (mesh
  `Circle.004`), hand-computing world position from the raw glTF node's own
  TRS (translation/rotation/scale, read straight from the GLB's JSON)
  reproduced trimesh's reported world transform matrix exactly. No missing
  parent composition (`Front Tire` and `Front Wheelover` are both root
  scene-graph nodes, no intermediate empty above them).
- `Front Tire`, `Rear Tire`, `Front/Rear Wheelover` (both primitives) are
  all present in `scene.graph.nodes_geometry` -- nothing is filtered by
  name before concatenation.
- Most direct check: sampled 136 real vertex positions across
  `Front/Rear Tire` and `Front/Rear Inside Cover` (both sides, from the
  live three.js scene, via a temporary puppeteer probe) and queried the
  ALREADY-BAKED `data/occupancy_grid.*` at each one. **Zero** had no nearby
  occupied cell; mean distance 1.4-2.1 grid cells, max 5.4 -- well inside
  the field's `huggingRadiusCells` (3). The bake has real, correctly
  transformed wheel coverage. No re-bake was needed or done.

**Actual cause, found by elimination and confirmed by fix:** a streamline's
integration step could cross a thin (one-or-two-voxel) occupied shell --
exactly what a tyre's surface is -- entirely between its start and end
point, landing clear on the far side. The old push-out guarantee only ever
checked the LANDING point for occupation, so a clean tunnel-through was
invisible to it. Fixed in `src/particles/streamlines.js`: near the occupied
region, a step is now sub-divided (up to 8 sub-steps, each capped to 0.4x
the voxel pitch) and the push-out guarantee now checks the SEGMENT (its
midpoint too, not just its landing point) -- see `segmentHitsOccupied()`.
Verified with a one-off Node script that also checks segment midpoints
(not just the discrete points tests/checks.js's assertion 3 style check
would catch): 0 point violations, 0 swept-midpoint violations, repeated
across many runs.

### 2. Seeding rewritten: surface-scatter + bidirectional trace

Replaced the upstream-rake seeding entirely, per the diagnosis that
deflection steers a line's path away from the body -- so seeds released
upstream are systematically the ones LEAST likely to end up hugging
bodywork, which is exactly backwards from what's needed for coverage.

- `src/particles/seeding.js` (rewritten): for each configured component
  group (`data/rakes.json` `groups`), scatters random points in a rough
  fractional bounding region, rejection-samples against the real baked grid
  (`findNearestOccupied`, now returning the found cell's own world position
  too -- a small additive change to `collisionGrid.js`), and snaps the seed
  to that surface position offset outward along its normal. A seed that
  still lands inside an occupied cell (can happen at concave corners/thin
  double-wall features, e.g. the diffuser) is rejected and resampled --
  this was the single biggest source of remaining bugs (see below).
- `src/particles/streamlines.js` gained `traceBackward()` +
  `traceBidirectional()`: each seed is integrated backward (to its upstream
  origin) and forward (to its downstream wake hand-off), joined into one
  continuous line with the seed sitting in the middle, not at either end.
- `src/particles/vectorField.js` was split into `rawVelocityAt()` (base
  flow + vortices, no hugging) and `applyHugging()` (surface-avoidance,
  now a function of an arbitrary input vector, not just the raw forward
  field). This mattered more than expected: hugging is engineered so the
  FORWARD field's component into the surface shrinks toward zero and then
  flips positive very close to the surface. Backward integration was
  originally implemented as "negate the already-hugged forward vector" --
  which negates that flip too, meaning the backward trace was being
  actively steered INTO the surface exactly in the region closest to it
  (confirmed: this alone caused ~7200 of an early ~7220-violation run).
  Fixed by computing `rawVelocityAt`, negating THAT, then re-applying
  `applyHugging` to the negated vector -- so surface-avoidance points the
  right way regardless of integration direction.
- `data/rakes.json` rewritten to the new `groups` schema: front-wing, nose,
  front-wheel (mirrored), sidepod (mirrored), floor-underside, diffuser,
  rear-wing, engine-cover, rear-wheel (mirrored), each with its own `count`
  -- "so coverage can be tuned region by region," per the ask. Minimum
  separation and an overall `lineCountCap` are both kept (now 150, see
  below). `vortices` are unchanged from the previous round.

**Debugging note for whoever reads this next:** the seed-validity gap above
was genuinely nasty -- an un-rejected bad seed could get a trace stuck
re-emitting the exact same (occupied) point for its entire step budget
(one observed case: 7201 identical points, one line, effectively a stuck
trace). Symptoms were bimodal across runs (most runs: ~20 violations of
exactly 1 point each; some runs: one line contributing ~7200) because seeds
are randomly sampled each build -- whether the pathological case appears at
all depends on chance. If anything like this resurfaces, checking whether
a SEED itself is ever handed out unvalidated is the first thing to check.

### 3. Visual pass

- `data/rakes.json` group counts sum to 138 lines (cap raised to 150) --
  up from ~80.
- `src/particles/streamlineRenderer.js`: `baseAlpha` 0.30 -> 0.44,
  `ribbonHalfWidth` 0.008 -> 0.011.
- Surface-proximity dimming, newly added: `streamlines.js` records a
  `proximity` value per point (0 clear of the car, 1 right at the surface,
  via the same `findNearestOccupied` distance query) alongside speed/
  coherence; the renderer darkens both colour and alpha by
  `surfaceDimStrength` (0.62) toward that value, so bodywork reads through
  the line instead of every panel edge getting outlined in bright colour.
  depthTest/depthWrite were already on/off correctly from the first pass,
  unchanged.

**Verification:** `node tests/checks.js` (3/3 pass) and
`node tests/models_untouched.js` both still clean. The Node-side segment
+ midpoint check: 138 lines, ~98k points, 0 point violations, 0 swept-
midpoint violations, repeated across 6+ runs (stochastic seeding, so
repeat runs matter here more than usual).

**`/lookcheck` (steps executed directly, same as every round -- the skill
isn't in this session's preloaded list): saved to
`shots/phase3.5-v2-*-<timestamp>.png`, including an added close-up front-
wheel angle specifically to judge item 1. Own read, flagged rather than
acted on further (explicit "don't tune in a loop" instruction applies
here):**
- Wheel deflection close-up: lines do appear to bend around the front tyre
  and hub rather than passing straight through it -- the thing item 1 set
  out to fix. Worth the author's own close look though, since "appears to" from
  a still frame is exactly the kind of judgement call this project reserves
  for him.
- Two things read as regressions worth flagging honestly rather than
  quietly re-tuning: the top-down view is busier than the first Phase 3.5
  pass -- with seeds now anchored across 9 groups and each line's backward+
  forward extent often several car-lengths, many long, roughly-parallel
  open-air stretches overlap and the result reads closer to a "fence" than
  the individually-followable-lines goal. The front (nose-on) view also
  shows a wide radiating "starburst" spread that isn't fully explained --
  plausibly the many wheel/sidepod-anchored seeds' near-surface hugging
  portions, laterally spread across the car's width, but flagged as
  uncertain rather than asserted. Average line length also grew
  substantially (~700 points/line vs. the first pass's ~100), driven mostly
  by floor-underside/diffuser seeds staying "near the surface" (hence
  sub-stepped) for nearly their entire length -- vertex count is back up
  to ~163k, similar to the pre-Phase-3.5 baseline this rework was partly
  motivated by improving on. None of this is a correctness problem (zero
  clipping, verified repeatedly); it's a density/tuning question -- exactly
  what `lineCountCap`, `upstreamStopFraction`, or per-group `count` values
  in `data/rakes.json` are for, once the author says which direction to tune.

Wake particles remain off (`WAKE_PARTICLES_ENABLED = false` in
`src/main.js`, from the previous round) -- not touched this round, still a
one-line flag to revert whenever the author wants them back.

**Stopping here as instructed -- waiting for feedback before tuning
further.**

---

## Phase 3.6 — Physically structured flow field

Full spec: `../PHASE-3.6.md`. Section 0's diagnosis (reported separately,
verbatim, before any building) found: surface seeding from 3.5 had genuinely
landed (verified in code); `tests/checks.js` assertion 3 only ever covered
wake particles, never a single streamline point; depth testing was already
correctly configured; and the deflection falloff was 3 grid cells
(`0.0866` world units) against a `5.209`-unit car length -- about 1.7% of
car length, confined to a sliver at the surface. That last number is the
root cause the rest of this phase addresses.

### Section 0 fix: the missing assertion

`tests/checks.js` gained **assertion 4**: traces the exact streamline set
`buildAllStreamlines()` hands to the renderer and checks every recorded
point against the real baked grid -- the check that should have existed
since Phase 3.5. Verified passing across many runs (seeding is randomised,
so this isn't bit-for-bit reproducible run to run, by design -- a flaky
failure here would itself be signal).

### Sections 1-6: the field rewrite

- **`src/particles/primitives.js`** (new) -- three closed-form,
  divergence-free primitive types: `doublet` (bluff bodies: each tyre, nose,
  airbox, engine cover -- the exact potential-flow field whose sum with a
  uniform stream produces flow around a sphere), `vortex` (lifting-surface
  tip vortices + tyre/diffuser shed vortices -- a non-singular tangential
  field, automatically divergence-free everywhere including its own core,
  reused from Phase 3.5's swirl-vortex math), and `sourceSink` (sidepod
  inlet as a sink, diffuser exit as a source). Doublets/source-sinks are
  clamped inside their own `coreRadius` and shaped by an authored
  `decayLength` envelope (`exp(-|r|/decayLength)`) -- documented honestly in
  the file as a small residual-divergence tradeoff, since a doublet sized to
  a real small object (a tyre) decays within a few of its own radii
  naturally, nowhere near "roughly a car length." **`decayLength` is 5.2 for
  every primitive** (was ~0.087, i.e. 3 grid cells), per the explicit
  instruction.
- **`src/particles/vectorField.js`** (rewritten) -- the field is now just
  freestream + summed primitive contributions. No grid dependency at all
  any more: the occupancy grid moved entirely into streamlines.js as a
  post-step clamp. This also means forward and backward integration are
  now exact negatives of each other -- Phase 3.5's whole "hug the negated
  vector" complication is gone, because there's no direction-dependent
  surface-avoidance baked into the field any more. Also exports `curlAt()`
  -- vorticity via central finite differences on the field, 6 extra samples,
  called once per recorded trace point (build time only).
- **`src/particles/wakes.js`** (new) -- section 5's "many small wakes":
  each configured wake is an expanding cone (origin, axis, expansion angle,
  decay length); `wakeImmersionAt()` takes the max membership across all of
  them at a point. Replaces the old single "past domain.halfLength" zone.
  10 wake zones configured (front/rear tyre, front-wing endplate, sidepod
  trailing edge, diffuser exit, rear wing -- suspension arms left out,
  explicitly optional in the spec and no anchor data exists for them yet).
- **`src/particles/streamlines.js`** (rewritten) -- Euler replaced with
  classic RK4 (`rk4Step()`, 4 field samples/step). Forward and backward
  tracing unified into one `traceDirection(seed, ..., sign)` (was two
  near-duplicate functions in 3.5, now genuinely symmetric since the field
  has no direction-dependent behaviour left). The occupancy grid is
  consulted only as `segmentHitsOccupied()` + push-out-along-normal, exactly
  where PHASE-3.6.md section 2 says it should be -- a reactive clamp, not a
  field input -- with a `clampFireCount`/`subStepCount` counter threaded all
  the way up through `buildAllStreamlines()`'s return value specifically so
  the firing rate could be reported, per the spec's own diagnostic ask.
  Near-surface adaptive sub-stepping (capped at 3, down from 8) is kept as a
  pure numerical safety net against tunneling through a thin shell between
  RK4 samples -- not a curvature mechanism any more. Records
  `vorticity` and `disturbance` (`|V-freestream|`) per point alongside the
  existing speed/coherence/proximity.
- **`src/particles/seeding.js`** -- kept the surface-scatter/per-group
  structure from 3.5 exactly (the author's instruction). Section 4's ask
  ("drive the adaptive seed scoring... alongside the velocity gradient
  term") is implemented as: oversample each group as before, score every
  valid candidate by `gradientWeight * |grad(speed)| + vorticityWeight *
  |curl(V)|` at the seed point, keep the highest-scoring `count` per group
  (still subject to the same minimum-separation rule). No pre-trace needed
  -- unlike the original (long-removed) Phase 3.5 §1b scoring, seeds start
  on the real surface now, so a single field sample at the seed is enough.
- **`src/particles/streamlineRenderer.js`** -- `baseAlpha` 0.44 -> 0.32
  (into the 20-40% range section 6 asks for). New: brightness/alpha boost
  proportional to normalized `|vorticity|` (rotating regions read brighter),
  and an alpha fade toward `disturbanceFadeMinAlpha` (0.12) for points near
  pure freestream (`disturbance` ~ 0) -- "far field nearly invisible," using
  a quantity the field already produces rather than an arbitrary
  distance-from-car falloff. depthTest/depthWrite/additive blending/thin
  ribbon were already correct from the first pass (confirmed in section 0),
  unchanged.
- **`data/rakes.json`** -- `vortices` removed entirely, replaced with
  `primitives` (12 entries, expanding to ~20 with mirroring) and `wakes` (6
  entries, ~10 expanded). `groups`/`seeding` (surface regions, per-group
  counts, min-separation, line-count cap) untouched, per instruction.

### Verification

`node tests/checks.js` -- 4/4 pass. Re-ran assertion 4 five times back to
back given randomised seeding: zero point violations every time, SDF clamp
firing rate 14-22% across runs (mean roughly 18%) -- **flagging this
honestly rather than tuning it down myself**: PHASE-3.6.md section 2 says
frequent firing means the primitive layout is wrong, and 15-20% is not
"rare." Own hypothesis, not verified further: seeds are offset only ~1.6
grid cells (~0.05 world units) off the real surface, deep inside a doublet's
`coreRadius` (0.30 for tyres) -- a sphere-shaped doublet is a rough proxy
for a non-spherical mesh (worst for the pointed nose), so some mismatch
between "outside the doublet's implied safe radius" and "outside the actual
occupied cell" is inherent to this approach; how much of the 15-20% concentrates
at specific groups (nose vs. tyres) hasn't been broken down.

Profiled per section 3's "profile it": one-time trace/build cost is
**~6.9 seconds** at 138 lines (RK4's 4x sampling + vorticity's 6x
finite-difference sampling + seeding's own per-candidate scoring, each
against ~20 primitives, add up) -- a page-load cost, not a per-frame one.
The per-frame colour/pulse update -- the actual steady-state runtime cost,
same O(vertexCount) loop as every earlier phase -- measured **~4.9ms mean,
~7ms worst** at the resulting ~182k vertices (CPU-only proxy, no GPU/WebGL,
same benchmarking convention as `tests/particles.bench.js`). Flagging: this
is a real, non-trivial slice of a 16ms/frame budget on top of wake
particles, wheel spin, and the actual WebGL draw -- worth watching on a real
GPU once particles are back on.

`node tests/models_untouched.js` -- unaffected, both GLBs checksum-identical.

**`/lookcheck`** (steps executed directly, same as every round): saved to
`shots/phase3.6-*-<timestamp>.png`, including a front-quarter close-up
specifically for PHASE-3.6.md's own check section. Own read: a genuinely
different result from every earlier round, not just a numeric fix --
visible spiral/swirl structure at the front tyres (close-up and
three-quarter views both show it clearly), the flow visibly splitting and
diverging around the nose from the top view instead of running in near-
parallel straight lines, and real curvature along the bodywork in the side
view. The "fence"/"starburst" look flagged in the previous round is gone.
Wake particles remain off (`WAKE_PARTICLES_ENABLED = false`, unchanged from
before) so the field/streamlines are judged alone.

**Stopping here as instructed -- reporting the three requested numbers
(clamp firing rate, assertion 4 violation count, frame time) alongside the
screenshots, not tuning further.**

---

## Phase 3.6 continued — doublet sign bug found and fixed; clamp rate still too high

the author's hypothesis (18% clamp rate + convergent-looking flow at the front
wing = inverted doublet sign) was confirmed by an isolated unit test before
any code changed, per instruction: one doublet + uniform freestream, no
grid/clamp, using the real shipped strength/coreRadius/decayLength. Lines
seeded at 0.3x-1.5x coreRadius from the axis all crossed straight through
it instead of diverging around it, and on-axis velocity just past the core
came out at ~7x freestream (should decelerate toward a stagnation-like
value, not amplify). Source/sink and vortex audits (also run before any
fix): both clean -- only `diffuser-exit` is a source, both `sidepod-inlet`
entries are sinks, matching spec exactly; every vortex axis resolved to
exactly 0.0deg off the freestream direction.

**Fix:** `src/particles/primitives.js` `doubletContribution()` -- negated
the coefficient. Derivation (now in the code comment): a sphere of radius
`a` in freestream `U` has `v_r = U*cos(theta)*(1 - a^3/r^3)`, so the
doublet's own contribution (subtracting the freestream term) is
`-U*cos(theta)*a^3/r^3` -- negative on-axis downstream, opposing the
freestream to bring it to a stagnation point. The un-negated formula gave
the opposite sign. Re-ran the same isolated test after the fix: zero
axis-crossings, all five test lines diverged outward, on-axis velocity
reversed sign (now decelerating/reversing rather than amplifying) --
qualitatively correct sphere-like behaviour confirmed before touching
anything else.

**Re-ran assertion 4 per instruction. Clamp rate went UP, not down: 21-28%
across 4 runs (was ~15-22% before the fix).** Zero point violations in all
cases -- the safety guarantee held throughout -- but the explicit stop
condition ("should drop well below 5%... if it does not, the layout is
still wrong and I want to know before you re-render") was not met, so
**stopping here without running `/lookcheck`**, per instruction.

Broke the rate down by seeding group (temporary diagnostic script, traced
each group's seeds in isolation) to localize rather than guess:

| group | clamp fire rate |
|---|---|
| front-wing | 61.25% |
| nose | 47.10% |
| engine-cover | 42.96% |
| front-wheel | 18.71% |
| rear-wheel | 16.44% |
| sidepod | 7.58% |
| rear-wing | 4.84% |
| floor-underside | 3.02% |
| diffuser | 0.92% |

Floor/diffuser/rear-wing/sidepod are already at or under the 5% target.
The three bad outliers are all near a **doublet** specifically: `nose`
(alongFlow -0.92) sits almost inside the `front-wing` seeding region
(-1.05 to -0.88) -- likely explaining that group's 61% on its own -- and
`engine-cover`'s doublet is a sphere standing in for a shape (a flat
engine-cover hump) that isn't very sphere-like. Now that the sign is
correct, lines legitimately travel closer along each doublet's implied
"sphere surface" (that's what correct wrapping looks like) -- which
exposes the sphere-vs-real-mesh mismatch more than the old inverted
(convergent, clamp-rescued-immediately) behaviour did, rather than less.
This reads like a geometry/placement problem (coreRadius, position, or
whether a doublet belongs there at all for a non-sphere-like part), not
another sign error -- but per "do not tune," no coreRadius, strength, or
position values have been touched. Reporting and waiting.

---

## Phase 3.6 continued — ellipsoidal doublets, region separation, stopping per instruction

**1. Ellipsoidal doublet.** `src/particles/primitives.js` `doubletContribution()`
now supports an optional per-axis `scale: [along, lateral, vertical]`
(default `[1,1,1]`): the sample point is projected onto the domain's own
flow/right/up basis, divided by `scale` (so a real point exactly on the
ellipsoid's surface maps to local distance 1), the unchanged spherical
formula is evaluated there, and the result is transformed back by
multiplying by the same `scale` before reprojecting onto world axes.
Verified this is exactly a no-op at `scale=[1,1,1]` (bit-identical to the
pre-existing sphere output, checked numerically) and that an elongated
ellipsoid still diverges correctly around itself in isolation (same
methodology as the doublet sign test, no crossings).

**Real measurements, not hand-picked** (temporary puppeteer probe against
the live GLB): nose has no dedicated component, so measured as "Main body"
restricted to its along-flow slice; engine cover likewise, further
restricted to the upper 58% of car height to exclude the lower chassis;
front/rear wheel assemblies (Tire + Wheelover + Inside Cover, one side
only) gave the "flattened cylinder" shape directly. Half-extents
(along, lateral, vertical), world units:
front-tyre `[0.330, 0.235, 0.337]`, rear-tyre `[0.339, 0.243, 0.346]`,
nose `[0.283, 0.150, 0.180]`, engine-cover `[0.828, 0.675, 0.315]`.

**First attempt used these absolute measurements directly with
`coreRadius: 1.0` and `strength` rescaled by `1/coreRadius_old^3` (to keep
the near-surface intensity comparable to before) -- this was wrong and
made things much worse (clamp rate jumped to 51% overall, including in
groups nowhere near the primitives that changed).** Root cause: for an
anisotropic ellipsoid, the far-field contribution along a given axis scales
with that axis's own `scale^3`; using one scalar `strength` calibrated
against the near-core magnitude made the far field explode specifically
along whichever axis had the largest `scale` (engine-cover's `lateral`
1.20-equivalent-in-old-terms, etc.) -- direction-dependent, not caught by
a single before/after magnitude check. **Corrected**: normalized each
measured half-extent triple to a geometric mean of 1 (divide through by
the cube root of the product), so `scale` carries only the component's
*shape* (elongation/flattening ratio), while `coreRadius` and `strength`
stay at their original authored values -- keeping the ellipsoid's effective
size/reach comparable to the sphere it replaces. Verified via the same
isolated single-primitive test before touching the full config.

**2. Region separation.** Confirmed the overlap directly: the `nose`
doublet resolves to world z=2.376, which sits inside BOTH `front-wing`'s
seeding region (z=2.27-2.71) and `nose`'s own (z=1.75-2.45, at the old
bounds). Tightened both: `front-wing` alongFlow `[-1.05,-0.88]` ->
`[-1.08,-0.97]`, `nose` alongFlow `[-0.95,-0.68]` -> `[-0.96,-0.78]`
(the latter also now matches the real measured nose extent). No more
overlap between the two regions.

**3. Re-ran the per-group clamp table (fresh, after both fixes):**

| group | before (sign fix only) | after (ellipsoid + region separation) |
|---|---|---|
| front-wing | 61.3% | 45.8% |
| nose | 47.1% | 53.1% |
| engine-cover | 43.0% | 37.0% |
| front-wheel | 18.7% | 36.7% |
| floor-underside | 3.0% | 21.8% |
| rear-wheel | 16.4% | 7.1% |
| sidepod | 7.6% | 0.5% |
| rear-wing | 4.8% | 9.3% |
| diffuser | 0.9% | 0.4% |

`node tests/checks.js` -- 4/4 still pass, zero point violations throughout
every change above (the safety guarantee never lapsed; only the RATE of
correction moved). Global clamp rate this run: 24.8%.

**Mixed result, reported honestly.** sidepod/diffuser/rear-wheel/rear-wing
now comfortably clear the target (all previously in-scope groups improved
or stayed excellent). But **nose (53%) and front-wing (46%) both remain
well above the 20% ceiling even after ellipsoid fitting and region
separation** -- this is exactly the outcome the author's instruction named as
the stopping condition ("If nose and front-wing stay high after ellipsoid
fitting, stop and tell me"). front-wheel (37%) and engine-cover (37%) also
regressed or stayed high, and floor-underside regressed from 3% to 22% with
no clear mechanism identified (it isn't seeded near either doublet that
changed shape most; flagging as unexplained rather than guessing further).

**Stopping here without running `/lookcheck`, per instruction. Not tuning
coreRadius/strength/position further myself.**

---

## Phase 3.6 continued — `/lookcheck` run as requested, no tuning applied

the author asked to see the current state visually rather than judge by the
clamp-rate table -- ran `/lookcheck` (steps executed directly, same as
every round) with zero changes to primitives/config since the last entry.
Saved to `shots/phase3.6-v2-*-<timestamp>.png`. Scene stats this run: 133
streamlines, 372,506 vertices, clamp fired 35,154/186,120 sub-steps
(18.9%) -- reference numbers only, not being treated as a target per
instruction.

Per-group table for reference (same script as the previous entry, run
fresh -- seeding is randomised so exact figures shift run to run, same
overall pattern):

| group | clamp fire rate |
|---|---|
| sidepod | ~0.5% |
| diffuser | ~0.4% |
| rear-wheel | ~7% |
| rear-wing | ~9% |
| floor-underside | ~22% |
| front-wheel | ~37% |
| engine-cover | ~37% |
| front-wing | ~46% |
| nose | ~53% |

**Stopping here -- the author is judging the screenshots visually, not this
table.**

---

## Phase 3.7 — Authored flow (guide curves)

Full spec: `../PHASE-3.7.md`. Supersedes Phase 3.6's primitive-superposition
field as the PRIMARY mechanism: "the analytic primitives cannot represent
thin multi-element geometry such as the front wing, and their combined
field produces closed recirculation loops where local swirl exceeds the
freestream." Built in the order specified -- section 1 first, verified
alone, before anything else.

### 1. The invariant that comes first

`src/particles/flowInvariant.js` (new): applied to the FINAL summed
velocity regardless of source --
- streamwise component clamped to >= 0 outside a declared wake region
  (`wakeImmersionAt() > 0.02`)
- combined lateral+vertical magnitude capped at 0.6x freestream speed

Verified in isolation (four hand-picked cases: reversed-outside-wake ->
clamped to 0; reversed-inside-wake -> passed through unchanged; excess
lateral/vertical -> scaled to exactly the cap; normal flow -> untouched)
before wiring it into anything. Baked into `vectorField.js`'s `velocityAt()`
itself (not applied ad hoc by callers), so every caller -- forward trace,
backward trace via the existing sign-flip, vorticity's finite-difference
samples, seed scoring -- automatically gets an invariant-respecting field.

**New `tests/checks.js` assertion 5**: independently re-checks the
invariant at every real traced point (not trusting the implementation) --
recomputes the physical field's streamwise component and wake immersion via
the same functions the field itself uses, counts violations. Refactored
assertions 4 and 5 to share one `buildAllStreamlines()` call
(`buildStreamlinesForTests()`) rather than tracing the (expensive) full
streamline set twice.

Wired into the CURRENT (Phase 3.6) field first, before touching primitives
or seeding, per the "before anything else" instruction. Result, immediately:
`tests/checks.js` 5/5 pass, and the SDF clamp firing rate dropped from
15-53% per group (the number reported at the end of Phase 3.6) to 2.5-4%
globally -- capping lateral+vertical velocity directly limits how
aggressively primitives could fling a line toward geometry, so fewer lines
ever needed the hard clamp's rescue. This was true before any of sections
2-4 below were touched.

### 2-3. Guide curves + initial curve set

`src/particles/guideCurves.js` (new): a guide curve is a Catmull-Rom spline
through authored control points (same alongFlow/lateral/vertical fractional
convention as everything else), each with `radius`/`weight`/`speedScale`.
Field evaluation: nearest point + tangent on every curve within `radius`
(bbox-rejected first, since most of the domain is near none of a handful of
localized curves), direction blended toward the combined (distance-weighted)
tangent, speed scaled by the weighted-average `speedScale`. Overlapping
curves combine via an OR-style weight combination
(`1 - product(1-weight_i)`) rather than sequential application, so the
result doesn't depend on curve order. Verified in isolation (a rising-then-
descending test curve: near-curve points pulled toward the correct local
tangent direction including sign, far points revert cleanly to freestream,
speedScale blends correctly) before wiring in.

7 curve entries (9 after mirroring), control points anchored to the same
real component positions already measured in Phase 3.6 (front wing, front
tyre, sidepod inlet, floor, rear wing, rear tyre -- not re-measured, since
they describe the same features): over-nose-and-chassis, front-wheel-
outboard, sidepod-inlet-and-flank, underfloor-accelerate + diffuser-expand
(split into two curves since a single `speedScale` scalar can't represent
"accelerate then expand" on one curve), rear-wing-over-behind, rear-wheel-
outboard.

### 4. What remains of the primitives

`src/particles/primitives.js` rewritten: doublet code deleted entirely
(not just unused -- the ellipsoid/basis/scale machinery from the Phase 3.6
diagnosis round is gone with it). Kept: vortex filaments at the wing tips
and diffuser edges (their swirl is capped by section 1's global limit, so
none can close a loop regardless of strength) and the sidepod sink /
diffuser source, now at roughly half their Phase 3.6 strength ("low
strength" per the spec) since guide curves do the routing work now.

### 5. Sandbox

`src/sandbox.html` + `src/sandbox.js` (new), served at `/sandbox` in dev
mode. Found and fixed a real routing gap in `scripts/dev-server.js` along
the way: `/` was hardcoded to map to `src/index.html` specifically (not a
generic static-file map) so the page's OWN URL sits at the project root,
which is what makes its relative `fetch('models/...')`/`fetch('data/...')`
calls resolve correctly; loading `src/sandbox.html` directly hit the same
paths through `/src/` and 404'd. Added a matching `/sandbox` route.

Shows the car, ONE guide curve at a time (its own `mirror` forced off) with
streamlines seeded along its length only, a dropdown to pick the curve, and
three live sliders (radius/weight/speedScale, debounced ~120ms) that rebuild
the real pipeline -- `traceBidirectional`, RK4, the section 1 invariant, the
SDF clamp, not a simplified stand-in -- so a value tuned here behaves
identically once copied into `data/rakes.json`. Live readout: streamline/
point counts, SDF clamp fire rate, and whether the invariant fired.
Verified working end to end (temporary puppeteer probe): dropdown
populates, curve selection rebuilds, slider changes rebuild, readout
updates correctly. Not bundled into `dist/` -- a dev-only tuning tool.

### Line count

Per the author's explicit visual target (400-600, from a reference image treated
as "a look to aim at, not proof of what's achievable"): group seed counts
scaled up from a ~138-line total to sum to ~450 (`lineCountCap` raised
150 -> 550, `minSeparationWorld` tightened 0.045 -> 0.03 to fit that many
seeds into the same regions). No stats panel, no pressure/turbulence modes
added -- both explicitly out of scope per the spec.

### Verification

`node tests/checks.js` -- 5/5 pass, repeated across multiple runs (seeding
is randomised): zero point violations, zero streamwise reversals outside a
wake, every time. Streamline count 413-417 (within the 400-600 target).
SDF clamp firing rate 7.6-9.9% with the complete Phase 3.7 field (guide
curves + reduced primitives + ~450 lines) -- higher than section-1-alone's
2.5-4% (expected: far more lines, seeded across much larger regions, and
guide curves occasionally route a line close to geometry they don't
perfectly account for), but the author's instruction for this round was
explicitly not to treat the clamp rate as a target -- reported for
reference, not used to justify or withhold anything.

`node tests/models_untouched.js` -- unaffected, both GLBs checksum-identical.

**`/lookcheck`** (steps executed directly, same as every round): saved to
`shots/phase3.7-*-<timestamp>.png`. Own read: a genuinely different result
from Phase 3.6, not just a numeric one -- lines stay attached along the
bodywork flank instead of tangling into knots at the tyres, the top view
shows clean routing around the nose and outboard wheels rather than
chaotic radial spread, the side view shows a broad structured plume behind
the car rather than the earlier scattered-spark look, and no closed loops
are visible in any view. Matches the reference-image target reasonably
well for a first pass at the new mechanism.

**Stopping here -- reporting assertion 4, assertion 5, and the clamp rate
alongside the screenshots, as requested. Not tuning curve placement
further myself -- that's what the sandbox is for.**

Addendum, post-review: the SDF clamp firing repeatedly along tight-hugging
lines was producing visible sawtooth zigzags. Fixed in three parts --

1. Soft repulsion baked into the field itself (vectorField.js
   `FIELD_REPULSION_CONFIG`), fading over a few grid cells. First attempt
   (an independent outward push) measurably made the clamp fire MORE, not
   less, by fighting the guide curves' own tangential direction; the fix
   that actually works only cancels the component of velocity heading INTO
   the surface, leaving tangential flow alone. Verified on a fixed seed set
   against the real field: ~19% -> ~14% clamp-fire rate.
2. Post-trace Laplacian smoothing (streamlines.js `SMOOTHING_CONFIG`, 2
   passes) to remove residual sawtooth, with a re-check against the real
   grid afterward (smoothing can push a point back into geometry) --
   reclamp, light re-smooth, then one final reclamp with no further
   smoothing after it, since assertion 4 admits zero exceptions and the
   light re-smooth alone was still leaving a small number of points
   inside geometry.
3. Two culling rules (`CULL_CONFIG`), both reusing quantities already
   recorded at trace time: drop lines whose max deviation from freestream
   never clears a threshold ("uninteresting"), and lines whose clamp fired
   more than a threshold ("misbehaving"). Thresholds set from the real
   measured distributions, not guessed -- 0.15 (freestream-deviation
   fraction) and 75 (clamp-fire count) each sit just past the bulk of
   normal lines and before the pathological tail. Culled lines are
   replaced via new seeds (seeding.js `generateTopUpSeeds`) so the picture
   isn't thinned below `lineCountCap`.

`node tests/checks.js` -- 5/5 pass: 508 streamlines, 191,165 points, zero
inside geometry, zero reversals, clamp fired 15.98% of sub-steps, culling
removed 4 (deviation) + 22 (clamp) of 508 traced and added 26 replacements
back to reach 508 final. All three knobs also live in `data/rakes.json`
(`fieldRepulsion`/`smoothing`/`culling`), same as `seeding`.

**`/lookcheck`** (three-quarter only, per the author's request): saved to
`shots/phase3.7-v5-zigzagfix-three-quarter-<timestamp>.png`.

Post-review again: `lineCountCap` dropped 800 -> 300 in `data/rakes.json`
-- the picture at 800 was too dense to read the car itself. Phase 3.7 is
done as of this point.

## Deferred ideas

Not scheduled into any phase above yet; noted here so they aren't lost.

- **Per-component focus views**: isolate one guide-curve group's flow and
  zoom the camera to that part of the car, rather than always showing the
  whole field at once. the author wants this built in Phase 7 alongside the
  per-component descriptions (mechanical/aerospace-engineering
  perspective, per CLAUDE.md), presumably so a focus view and its
  description can be shown together.
- **Simplified mode**: an optional educational layer showing a small
  number of large arrows grouping the main flow paths, instead of the full
  streamline field. the author wants this considered after Phase 8 (ship), as
  an addition on top of the shipped default view rather than a
  replacement for it.

## Post-Phase-3.7 addendum: assertion 4 had a real gap (grid vs. real mesh)

the author flagged, from external close-up renders, lines visibly crossing the
front/rear wheel silhouette (especially the tyre crown), the front wing
outboard section/endplate, and emerging from the bodywork flank/rear
bodywork ahead of the rear wing -- despite assertion 4 reporting zero
violations. Asked for diagnosis before any fix.

**Diagnosis** (one-off scripts, trimesh, read-only against the real GLB;
deleted after use except the permanent one below):
1. Assertion 4 validated against the baked occupancy GRID
   (`grid.isOccupiedWorld()`), never the real mesh. That was the entire gap.
2. Mesh-accurate check against the real, full-resolution, as-displayed
   mesh (car.js's exact per-component mirror): of the then-current 300
   traced lines (135,770 points), 402 points (0.30%) were essentially
   touching real geometry, affecting 164/300 lines (55%). Worst
   components: Main body, Floor, Rear Tire, Front Inside Cover, Front
   Tire, Front Arms, Front wing side plates.
3. The bake's `voxelized(pitch, method='subdivide')` neither marks "every
   intersected cell" nor "centre inside a solid" -- it recursively
   subdivides triangles until edges are sub-pitch, then rounds sample
   points to the nearest voxel: a point-sampling approximation, with no
   interior test at all. Compounded by baking from a mesh decimated to
   10% of its original face count (`target_reduction=0.9`): decimating a
   CONVEX curved surface (tyre crown, wing curvature) produces a hull
   that sits inside the true curve (a general property of simplification,
   not a bug in any one setting), and disproportionately loses small thin
   features (endplates).
4. Wheel world transforms: no bug found. `Scene.dump()` applies each
   node's own world transform before concatenating (confirmed from
   trimesh's source); independently reconstructed Front Tire/Rear Tire
   world bounding boxes came out correctly separated front/rear, both on
   the ground plane. The wheel violations are explained by (3), not a
   transform error.

**Fix, in the order requested:**

1. **Solid voxelisation, decimation reconsidered** (`scripts/bake_occupancy_grid.py`).
   Benchmarked before changing anything:

   | decimation | bake time | filled cells | .bin size |
   |---|---|---|---|
   | 90% (old) | ~7.2s | 36,862 | 865 KB |
   | 50% | ~10.1s | 60,594 | 1,420 KB |
   | 0% (full res) | ~11.1s | 61,841 | 1,449 KB |

   Full resolution cost ~4s more than 90% decimation and landed at
   essentially the SAME cell count as 50% -- decimation wasn't buying
   meaningful speed at this mesh/pitch, so it's now off by default
   (`--target-reduction 0`). Final pipeline: shell voxelise -> 1-iteration
   binary dilation (the discrete form of "inflate by half a voxel" a grid
   can represent -- also closes hairline gaps the shell step's point-
   sampling missed) -> `VoxelGrid.fill(method='holes')` for a genuinely
   SOLID grid, not a hollow shell. Real bake result: **110,908 cells,
   2,661,792 bytes (2.66 MB, up from 734,304 bytes/717 KB), 21.9s total**
   (up from ~12s measured for the literal old settings). For scale,
   `models/F1 model.glb` itself is 26.8 MB, already fetched by the app --
   a 2.66 MB grid is a small fraction of that, not a realistic
   load-time concern. New dependency: `rtree` (trimesh's spatial index for
   `proximity.closest_point`), added to `.venv`.

2. **Re-check + reclamp against the new grid** (`src/particles/streamlines.js`).
   The much more solid grid legitimately raised the SDF clamp-fire rate
   (~15% -> ~37-41%) and exposed two follow-on issues, both fixed:
   - The post-smoothing reclamp only triggered on points the grid called
     strictly occupied; a point the grid called clear could still sit
     within a hair's breadth of the real CURVED surface right at a voxel
     boundary. Now triggers on "occupied OR within 1 cell of occupied",
     and pushes out by a larger margin (3x pitch vs. the trace-time
     clamp's 1.5x) since this is the last correction before the real-mesh
     check. Hard last resort added: if a point still can't be pushed
     clear, snap it onto whichever adjacent point on the same polyline is
     already clear (fires on a handful of points out of hundreds of
     thousands -- invisible).
   - `CULL_CONFIG.maxClampFireCount` (75, calibrated against the OLD
     leaky grid) was removing ~30-44% of lines against the new one.
     Re-measured: clamp-fire-count per line is now bimodal -- most lines
     under ~50, a real ~25-30% cluster from ~300 to 2000+. Raised the
     threshold to 100 (just above the well-behaved cluster) and
     `maxTopUpRounds` 4 -> 8. That second cluster is left as-is
     deliberately: it means guide curves tuned against the old grid now
     legitimately hit real geometry the old grid didn't represent, which
     needs a guide-curve retuning pass -- explicitly NOT done here per
     "do not adjust guide curves until the grid and the assertion are
     correct."

3. **Assertion 4 now validates against the real mesh** (new
   `scripts/mesh_accuracy_check.py`, permanent, shelled out to from
   `tests/checks.js`). Reconstructs the exact mesh car.js renders (full
   resolution, car.js's own per-component mirror, not the bake's
   approximation of it), and checks every traced point's nearest-surface
   distance via trimesh, threshold 0.001 world units ("essentially
   touching"). Slower (a few seconds) and requires the project's `.venv`
   -- both accepted since it's offline-only, never in the browser; SKIPs
   cleanly if the venv is missing. The old grid-based clamp-fire stats
   are still reported alongside it as tracing diagnostics, but no longer
   decide pass/fail.

4. **Re-run, true violation count**: `node tests/checks.js`, 5/5 pass,
   repeated across multiple runs (seeding is randomised) --
   **zero points within 0.001 of the real mesh surface** every time
   (nearest-surface-distance minimum 0.016-0.019 across runs, comfortably
   clear of the threshold). Down from 402/135,770 (0.30%) at the start of
   this diagnosis.

`node tests/models_untouched.js` -- unaffected, both GLBs checksum-identical.

**Own read, not hidden**: the fix is real and verified (grid is solid and
accurate now, assertion 4 checks the actual displayed mesh, true violation
count is zero) -- but the renders below show MORE visible zigzag/jitter
near the wheels than before, not less. That's the expected, direct
consequence of (2) above: the grid finally blocking paths it used to leak
through means guide curves that were tuned/validated against the old,
leaky grid are now legitimately fighting real geometry far more often.
Fixing that is a guide-curve retuning pass against the corrected grid,
deliberately not started here.

**`/lookcheck`-style external close-ups** (four, per the author's request --
both wheels, front wing outboard edge, rear flank): saved to
`shots/phase3.7-postfix-*-<timestamp>.png`. Front wing outboard and rear
flank framing ended up overlapping with the wheel shots rather than
cleanly isolated (anchor points landed close together) -- flagging this
honestly rather than presenting them as cleaner than they are.

**Stopping here for the author's review before any guide-curve retuning.**

## Post-Phase-3.7 addendum 2: true signed distance field replaces the grid-derived "SDF"

Cause of the staircase zigzags: every correction (trace clamp, post-smoothing
reclamp, neighbour-snap) ran on the BINARY occupancy grid -- whole-cell
distances, per-cell normals. Measured before the fix: 4,698 of 31,016
non-wake points turned >30 deg (15.15%, worst 179.5); the post-smoothing
reclamp accounted for ~4,700 of 5,650 kinks, ~48% bent along a grid axis.
The guide-curve retune had never been done (no git repo exists, so "restore
from git" was impossible; rakes.json curve values were untouched since 3.7 and
were used as the clean-render values; pre-offset copy kept outside the repo).

Done: `scripts/bake_sdf.py` -> `data/sdf.bin` (5.97 MB) + `sdf.json`: signed
distance to the real full-res mesh, 14.5 mm lattice, +-4 cells band,
block-sparse int16, flood-fill sign (thin sheets read positive on both sides),
inflated by 0.6 cell so thin parts are never over-estimated. `src/particles/sdf.js`
trilinear reader. Tracing, seeding, soft repulsion (now also an outward
restoring term) all use it; the neighbour-snap and grid reclamp are removed.
Corrections move a point along the gradient by (standoff - distance), with a
same-side guard against thin sheets and a tangential-slide fallback. Post-trace:
subdivide near the body, 3 x (correct, smooth), stall detection, and a cull of
lines still turning >30 deg outside a wake (assertion 6's rule). Guide curves
offset toward 1 cell clearance via `scripts/offset_guide_curves.mjs`
(control points capped at 3 cells of travel; the front-wing flaps and rear-wing
curve still hug the surface for part of their length).

`node tests/checks.js`: 6/6 pass (two consecutive runs). Assertion 6: before
15.15% violations, after 0, worst turn ~29 deg. Assertion 4 min real-mesh
distance 0.015-0.020. Heavy culling (~320 of ~620 traced lines dropped, mostly
stall/clamp), topped back up to 300. Wake particles still use the binary grid.
Render: shots/phase3.7-sdf-fix-three-quarter-*.png. Stopping for review.

## Plan change (after Phase 3.7)

Phase 5 (cornering) and Phase 6 (Falcon 6X) are deferred until after Phase 8.
New order: Phase 4, Phase 7, Phase 8, then 5 and 6 as later additions
(BUILD.md updated). Flow direction/yaw and scene setup stay config values so
both can be added later without a rewrite. Git initialised; first commit
"Phase 3.7 complete: true SDF flow field".

## Phase 4 (first pass) -- colour, legend, wake particles on the SDF

Done: streamline colour ramp #4C7DFF (slower) -> #F28C38 (faster) by local
speed, brightness boost near surfaces / high vorticity kept; legend
"Slower / Faster" (no numbers); permanent disclaimer line; wake particles back
on, moved from the binary grid to the SDF (steering + smooth push-out, spawn
re-sampled if inside bodywork), released behind the rear wheels, count
625 -> 156 and wake spread 3.2 -> 0.8 (a quarter of before), flow mainly
downstream. Assertion 3 now checks the wake particles against the SDF (same wake
domain and spawn regions as the app). `node tests/checks.js`: 6/6 pass; source
models untouched. Seeding groups now tag their lines (scripts/seeding_report.mjs).

Coverage after culling (requested -> surviving, avg of 3 runs): front-wing
66->21, nose 46->26, cockpit 24->16, chassis 44->26, front-wheel 66->54,
sidepod 52->62, floor-underside 73->17, diffuser 33->17, rear-wing 46->17,
engine-cover 26->9, rear-wheel 66->35. Total requested 542 vs cap 300; counts
above requested come from top-up.

Own read: in the renders the lines read almost white -- additive blending plus
the surface/vorticity brightness boost saturate the blue-orange ramp, so the
speed colour is only visible on a few far/dim lines. Wake particles are faint.
Not tuned (Phase 4 is judged by the author). Shots: shots/phase4-*.png. Stopping.

## Phase 4 fixes -- colour, coverage, wake

**Why there was no colour.** The material was never the problem (unlit
MeshBasicMaterial, vertexColors on, 4-channel colour attribute, and the
per-frame update did not overwrite hue). The colour was lost in the data and the
blend: the RGB blue-orange midpoint is grey and the fixed speed range put most
points near it; the surface/vorticity boost and the pulse both lerped toward
white; additive blending stacked overlapping lines to white. Fixed: OKLab ramp
(endpoints sRGB->linear, output linear), range = scene's own 5th-95th
percentile of per-point speed, normal alpha blending, boost raises opacity
only, pulse brightens the same hue (colour x gain) and lifts opacity. (A
variable-shadowing bug of mine -- a local `base` inside the vertex loop
shadowing the ribbon's index base -- briefly made most lines vanish; fixed.)

**Coverage.** The 300-line cap was filled in listing order, so later groups
(floor, rear wing) started with almost nothing. The cap is now shared out in
proportion to each group's configured count (computeGroupTargets), and top-up
refills each group only from its own region; a group that keeps failing starts
its replacement seeds +0.4 cell further off the surface per round (max 3.2).
Cull rules unchanged. Per-group, avg of 3 runs (requested -> target ->
surviving): front-wing 66/37/37, nose 46/25/25, cockpit 24/13/13, chassis
44/24/22.3, front-wheel 66/36/36, sidepod 52/28/28, floor-underside 73/40/40,
diffuser 33/18/18, rear-wing 46/25/25, engine-cover 26/14/14, rear-wheel
66/36/36. Every group sits at ~55% of its configured count because the total
cap is 300 against 542 requested; raise lineCountCap to raise them all.

**Wake.** Spread kept at 0.8, count 156 -> 400, trails 2 -> 6 points, max alpha
0.85 -> 0.45 (dimmer than the streamlines), colour = #4C7DFF.

## Phase 4 round 3 -- freestream-centred colour, camera-facing lines, 400 lines

Colour is now relative to the oncoming air: slower than freestream (5.5, PARTICLE_CONFIG.flowSpeed)
-> #4C7DFF, equal -> pale neutral #DCE3EE, faster -> #F28C38, OKLab on each half,
each side scaled by its own percentile (5th of points below, 95th of points
above). Legend gained an "Oncoming air" middle. Lines are now camera-facing
with constant screen width (2.5 CSS px): a custom ShaderMaterial (Line2's
LineMaterial has no per-vertex alpha) expands each segment in screen space,
keeps vertex colour + alpha, and the travelling pulse moved from a per-frame
CPU loop over every vertex to the vertex shader (CPU update cost ~0 ms).
lineCountCap 300 -> 400 (~649k vertices). GPU frame time cannot be measured in
headless software rendering; CPU side per frame is now just a uniform write.

## Phase 4 round 4 -- symmetry, underfloor attempt, smoother colour, transparency

Symmetry: two real causes found and fixed. (1) mirrored vortex primitives copied the
same signed strength to the mirror side (a reflected vortex spins the opposite way);
(2) my guide-curve offset had nudged the centreline curves sideways -- the offset
script now locks centreline control points to the centreline. Field at mirrored points
is now identical to 1e-15 for curves and primitives; with the SDF a ~0.1 speed
difference remains at <0.3% of sample points (SDF lattice noise). Group mean speeds
L vs R now differ by 0.1-0.6% (was up to 1.9%). scripts/symmetry_check.mjs.

Underfloor (one attempt): the ground was not in the distance field at all -- 14.3k
line points per run sat BELOW the road, and the underfloor guide curves sat at/below
y=0. Now: ground is an exact plane (config groundY), a finer unbiased local field for
the floor slab (data/sdf_floor.*, 3.07 MB, 7.2 mm lattice, no conservative bias,
blended into the main field over 3 cm), underfloor curves moved to mid-gap
(y=0.019), floor-underside group seeded at mid-gap with no offset. Result
(scripts/underfloor_report.mjs, 3 runs): ~38.7k points per run in the ground-floor
slab (was 28.8k) across ~77 lines, 0 below ground (was 14.3k), 21% of slab points
faster than freestream (was 5.6%). Only the centre ~0.15 either side is accelerated
(the authored curve's radius); the rest of the floor width stays at freestream.

Colour: speed smoothed along arc length (sigma 0.06), blue runs shorter than 0.1
dropped. Dev server on 0.0.0.0 (prints LAN address). Vertices: 835k. Transparency: baseAlpha 0.5 -> 0.26 (config),
near-surface boost adds at most boostAlpha 0.18, width 2.5 -> 1.75 px.

## Phase 4 round 5 -- colour does the work

Opacity now follows the effect: per point, alpha = alphaUndisturbed 0.08 -> alphaMax 0.6
by the (sqrt-curved) deviation of smoothed speed from freestream; the separate
near-surface/vorticity boost and disturbance fade were removed as redundant. Neutral is
#9AA3B2; ramp and opacity use colorCurve 0.5 (sqrt). All in STREAMLINE_RENDER_CONFIG
(alphaUndisturbed, alphaMax, colorCurve, neutralColor). Underfloor acceleration is three
parallel lanes (centre, +-0.36, +-0.72, radius 0.2) spanning the floor width; slab points
faster than freestream 21% -> 43%. Legend gradient middle stop updated to the new neutral.

---

## Speed check, Phase 7, Phase 8 and portfolio shots (one run)
_status: done, stopped before publishing_

**Speed check (assertion 7).** `tests/speedProbes.js` + `tests/checks.js`: 25 probes on the real bodywork (found by
marching from open air until the signed distance field says 0.04 from the surface, in the car's own flow/right/up
basis), compared with the oncoming air with a 3% margin. All pass. Fixed only in `data/rakes.json` and the field,
never the colour mapping:
- Guide-curve control points may now carry their own `speedScale` (interpolated along the curve), so one curve can
  slow into a stagnation region and speed up out of it (`src/particles/guideCurves.js`). Nose, nose pillars and the
  centre over-the-nose curve now start slow; front wing mainplane is fast, flaps slower; sidepod/chassis flanks fast.
- Underfloor: the three lanes now run the full floor to the diffuser (outboard lanes used to stop at the middle of
  the car, so the outer floor was slower than the oncoming air); fast through the throat, easing off through the
  diffuser, so the exit is slower than the floor ahead of it.
- Wakes got `speedDeficit` (`src/particles/wakes.js`, applied in `vectorField.js`): air in a wake is slower, with the
  same cone and decay as the incoherence, so it fades back to the oncoming speed. This fixes the orange lines that
  persisted far behind the car (rear curves also no longer end fast).
- New curve `rear-wing-underside` (fast air under the rear wing).
- Assertions 4, 5, 6 still pass (7 of 7).

**Phase 7 (interface).** Built from `design/`: layout from the PNGs, colours/sizes/spacing from the html files. Geist and
Geist Mono inlined. Files: `src/index.html` (markup + CSS), `src/ui.js`, `src/uiConfig.js`, `src/cameraRig.js`,
`src/components.js`. Streamline renderer gained group filtering, line-density and pulse-width controls.
- Sliders: Particle density = fraction of traced lines shown + wake particle count; Trail length = length of the
  travelling bright band on each line; Speed = flow animation and wheel spin rate. Pause freezes both. Streamlines
  switch hides the traced lines (wake particles stay).
- Camera: preset and part fly-tos arc around the target; a guard keeps the camera outside the car's bounding box
  (+0.35) at all times. Tested during every fly-to, with forced positions and with zooming in.
- Falcon 6X and Cornering are config only (`enabled: false`), not drawn.
- **Differences from your brief, please check:** (1) `data/components.json` has descriptions on all 18 entries, not
  eight, so every card shows text; an entry with an empty description shows its title only (the Wake entry is empty).
  (2) The file had no Wake entry; I added `wake` (empty description, `showsWakeParticles: true`): its "show flow around
  this part only" shows just the wake particles. (3) For entries with no flow group of their own (steering wheel,
  suspension, exhaust, mirrors, antennas, rear light) the "only" switch is disabled, since there is nothing to isolate.
  (4) The legend is the three-stop one (Slower / Oncoming air / Faster) with the Phase 4 grey midpoint, not the older
  two-stop design.
- Loading screen shows the word "Loading" and an animated bar, no percentage (no numbers on screen).

**Checks added** (`npm run test:ui`, `tests/ui_checks.mjs [dev|dist]`, headless Chrome via `puppeteer-core`, dev
dependency; uses the Chrome for Testing already in `~/.cache/puppeteer`): every mesh maps to a component (file and live
scene, both halves); loads with no console errors; every card; every part button; flow isolation; real clicks on both
halves of front wing, rear wing, front and rear wheels; camera never inside the car; no digits in the interface; none of
the banned words in the served files (base64 payloads excluded so font bytes cannot give a false hit).

**Phase 8 (ship).** `npm run build` -> `dist/`: `index.html` (1 MB: script, styles, fonts inline),
`models/F1 model.glb` (25.5 MB), `data/` (runtime data, 11.7 MB) = 38 MB. A single self-contained
index.html was rejected: it would be about 50 MB of base64, far too heavy to load. The Falcon model is not copied
into dist/ (unused until Phase 6). **Streamlines are precomputed at build time** (`scripts/bake_streamlines.mjs` ->
`data/streamlines_full.*`, 0.5 MB, quantised): the page used to trace ~400 lines in the
browser on every load (~35 s or more in headless Chrome); it now loads in about 8 s there, and the lines are simplified
to a 0.0006 world-unit tolerance (invisible). If the baked files
are missing the page falls back to tracing them itself. The build re-bakes automatically when rakes.json, the SDF or
`src/particles/` is newer than the baked files. README.md has a `[YOUR FULL NAME]` placeholder and your disclosure with the component-descriptions sentence
changed as asked.

**Known limits.** Headless Chrome with software GL renders about 2 frames/s, so frame rate
was not measured on a real GPU (assertion 2 still measures only the CPU side). `npm test` takes about 3.5 minutes
(the real-mesh check).

**Portfolio shots:** `shots/portfolio/` (git-ignored with the rest of `shots/`).

---

## Move to Windows, and Phase 6 -- Falcon 6X scene (2026-10-19)
_status: built, checks pass, waiting for your visual review. Not published._

**Move to Windows** (commit "Move to Windows"): repo-local `core.autocrlf false`, `core.fileMode false`, git identity.
Mac `.venv` moved to `_to_delete/`; new `.venv` (Python 3.12: numpy, scipy, trimesh, fast_simplification, rtree,
psutil). Run Python as `.venv/Scripts/python`. Chrome for the UI checks: `tests/browser.mjs` uses `CHROME_PATH`, a
Chrome for Testing in `~/.cache/puppeteer`, or the installed Chrome (used here). `scripts/bake_sdf.py` pool made
spawn-safe (Windows has no fork). F1 verified before touching Phase 6: npm test 7/7, test:ui 13/13 dev and dist,
build 38.3 MB, same as the Mac. Publishing needs `gh` and the two clones set up again.

**Why the Mac crashed:** not the distance transform. trimesh `closest_point` needs ~81 kB per query point on the
Falcon (326k faces); the bake sent 40,000-point chunks to 4 workers (~13 GB). Now 2,000-point chunks: measured
peak 1.8 GB on this 16 GB PC, 192 s, same pitch/band/inflate. The same trap was in `mesh_accuracy_check.py`
(~0.9 MB per streamline point, ~170 GB for the Falcon): now chunked, and for the Falcon only points within the
baked field's band get the exact query (the rest are provably farther than ~0.1 from the surface).

**Built:**
- `models/Falcon 6X.glb` (complete aircraft, untouched, checksum updated) shown at full detail, scale 0.22, fixed
  cruise pitch 2.5 deg nose up (`src/sceneConfig.js`, `pitchDeg`). No pitch control, no ground, no mirroring.
- Sky (`src/sky.js`): calm gradient, faint soft clouds. Scene switch F1 / Falcon 6X; Falcon loads on first use.
- Flow (`data/falcon/rakes.json`, same pipeline as the F1): air dividing at the nose over/round/under the fuselage;
  three lanes per wing station (fast over the top, gentler layer above, slow underneath) with upwash ahead and
  downwash behind; air converging into each intake and a fast jet from each exhaust; a vortex per winglet
  (counter-rotating); dividing at the fin, over/under the tailplane; a narrow quiet tail wake. 370 lines.
- New shared feature: `terminals` in rakes.json (spheres where a line ends cleanly), used at the fan faces and
  inside the exhausts. The F1 has none; F1 lines baked with a fixed seed are byte-identical before/after.
- Interface: camera presets for both scenes, Falcon parts Full aircraft / Wings / Engines / Tail / Wake, Falcon
  cards with title only (descriptions empty for you to write). Build copies the Falcon model + `data/falcon/`
  (dist 57.8 MB). `npm run bake:falcon` (field + lines) or `npm run bake:falcon -- --lines`.
- Fixed a bug from the Mac session: `ui.js` read `world.components` instead of `world.componentIndex`, so every
  card/part button threw in both scenes.

**Checks:** `npm test` 13/13 (F1 1-7 unchanged; Falcon 2-7: wake particles, zero line points within 0.001 of the
real mesh (min 0.021), no reversal, no kink > 30 deg, 16 speed probes: nose slower, over the wing faster and under
slower at two stations each side, exhaust faster, tail wake slower). `test:ui` 26/26 dev and dist: all 13 per scene,
plus F1 -> Falcon and back restoring the F1 exactly. Note: run UI checks alone; a second headless Chrome alongside
makes the tap-length click checks flaky.

**Screenshots:** `shots/phase6/phase6-20261019-{three-quarter,side,top,front,wingtip}.png`.

**For you to decide:**
- Existing F1 bug, left unchanged as asked: "Show flow around this part only" for Sidepods and Front wheels shows
  one side only (their cards list `sidepod`/`front-wheel` but not the `-mirror` halves).
- Top-left title still reads "F1 AIRFLOW" in the Falcon scene.


---

## Phase 6 review fixes (2026-10-19)
_status: built, checks pass, waiting for your visual review. Not published._

Your seven points from the first Phase 6 screenshots, in order:

1. **Sky and contrast** (`src/sky.js`, `src/scene.js`): deep navy overhead fading to a muted blue at the horizon, and a
   soft cloud deck below the aircraft (projected onto a layer, melting into the horizon tone, so nothing hazy sits
   at aircraft height). No fog. Lighting no longer depends on how dark the dome is: a stronger hemisphere fill and
   the sun keep the jet white and solid.
2. **Fewer far-field lines:** every line now starts on one plane a fuselage length ahead of the nose and ends a
   fuselage length behind the winglets (rakes.json `trace`). A focus envelope (rakes.json `display.focus`,
   `src/particles/streamlineRenderer.js`) keeps lines at full strength near capsules round the fuselage, wings,
   engines and jets, fin, tailplane and the two vortex cores, and fades them out by 0.7 units, reaching 2.5x further
   upstream and 3.5x further downstream. So lines read from about a third of a fuselage length ahead of the nose:
   any further out and they converge on the camera in the front view. Lines closer than 1.4 units to the camera fade
   out. The baked lines keep only the end points of straight stretches, so the renderer splits long segments before
   fading. The presets are closer: three-quarter, front, side and top.
3. **Wingtip vortices:** one per winglet, a tight core (0.06 units, Gaussian fall-off: `profile: 'tight'` in
   `primitives.js`), turning 3 to 6.5 times over the first fuselage length, the two sides opposite (measured on the
   baked lines). A `tip-curl` guide curve brings the air from under the tip, up round the winglet and inboard over
   its top into the core. 14 lines per side are seeded on rings round the core (new seed mode `ring`). Steps that
   would turn more than 10 degrees are subdivided (`maxTurnPerStepDeg`), so the spiral is smooth and passes
   assertion 6.
4. **Front view:** two causes. (a) The nose lines were traced 0.8 aircraft lengths upstream, which ended exactly at
   the front camera (z = 7.2), so lines ran under and past the lens and fanned out in perspective. (b) The
   under-fuselage guide curve slowed the air 0.8 units ahead of the nose and dipped 0.06 below the lowest point of the
   aircraft, so those lines were blue and dropped. Now: the under-fuselage curve follows the measured underside, about
   0.03 below it, at freestream speed after the nose. The front camera sits at fuselage height. There's the near-camera
   fade, and the downwash under the wing is gentler.
5. **Engines:** 12 lines per side seeded on a ring just ahead of each intake converge into it, slowing (blue), and end
   at the fan face. A short orange jet leaves each exhaust: 10 lines per side seeded inside the nozzle, 1.75x the
   oncoming air at the exit, mixing back within about half a fuselage length.
6. **F1 "Show flow around this part only":** `ui.js` now isolates each flow group and its `-mirror` half, so Sidepods,
   Front wheels, Rear wheels and Nose show both sides. The UI check now expects both halves.
7. **Title:** follows the scene: "F1 AIRFLOW" / "FALCON 6X AIRFLOW" (`SCENES[].title` in `src/uiConfig.js`).

**F1 unchanged:** every new feature is off unless a scene's rakes.json turns it on, and the F1's does not. F1 lines
baked with a fixed seed are byte-identical before and after. A frozen-clock render of the normal F1 three-quarter view
(paused, no wake particles) is pixel-identical to the previous commit's: 0 of 1,296,000 pixels differ.

**Source of the Falcon flow:** `scripts/make_falcon_rakes.mjs` writes `data/falcon/rakes.json`. Edit it, run it, then
`npm run bake:falcon -- --lines`.

**Checks:** `npm test` 13/13, models untouched. `test:ui` 26/26 on dev and dist (two checks updated: part-only now
expects both halves; the no-numbers check accepts "FALCON 6X" in capitals). Build: dist is 57.8 MB.

**Screenshots:** `shots/phase6/phase6-fixes-20261019-{three-quarter,side,top,front,wingtip}.png`, plus
`-f1-three-quarter.png` and `-f1-sidepods-only.png`.

### Phase 6 review fixes, round 2 (2026-10-19): Falcon front view, tidy vortices, F1 race track

1. **Falcon front view (starburst):** the Front preset now uses a long lens: field of view 15 degrees from 19 units
   ahead (`fov` on a camera preset; `cameraRig.flyTo` animates it, and every other move returns to the normal 50).
   Lines along the view axis now look short. A new opt-in `display.viewFade` in rakes.json ([0.97, 0.997]) fades any
   line segment pointing almost straight at the camera. It is added to the line shader only when a scene sets it, so
   the F1 shader text is unchanged. The air now parts round the nose and wings with no radial spikes.
2. **Wingtip vortices:** 5 lines per side (was 14) on a narrower ring (radius 0.055 to 0.068 round the core). The swirl
   is slower (strength 1.7, core 0.065, `profile: 'tight'`), giving about 3 smooth turns. The tip-vortex focus capsule
   now ends at 1.6 behind the nose, so each vortex fades out gradually before the lines end instead of fraying.
   Falcon: 366 lines.
3. **F1 race track** (`src/track.js`, replacing the plain road): swept from simple geometry along a centreline. A
   straight past the car runs into a 90-degree left corner (radius 40) behind it. It has dark asphalt (same colour and
   finish as the old road, flat at exactly y = 0, catching the car's shadow), white edge lines, and low bevelled kerbs
   alternating white and grey through the corner. Barrier walls with pale caps line both sides; the pit-side wall is
   taller. Run-off is a shade lighter than the asphalt. Distant shapes: a pit lane and
   pit building, a roofed grandstand opposite, and a stand round the outside of the corner. The F1 dusk sky reuses the
   Falcon dome with a slate palette and no cloud deck (`DUSK_SKY` in `sky.js`). The fog now uses the sky's horizon
   tone and starts at 30 units (was 25), so the far track fades into the sky without a seam. All greys and white. The
   object is still named 'Road'; nothing is in the distance field, and the flow is untouched.

**F1 unchanged:** a fingerprint was taken with the page clock frozen. It hashes the line geometry, colours, shaders and
uniforms, every car mesh's geometry, world matrix and material, the F1 lights, exposure and environment. It is
identical to the previous commit's. F1 lines baked with a fixed seed are byte-identical to the reference.

**Checks:** `npm test` 13/13, models untouched. `test:ui` 26/26 on dev and dist. Build: dist is 57.8 MB.

**Screenshots:** `shots/phase6/r2-{three-quarter,side,top,front,wingtip}.png` and `r2-f1-{three-quarter,side,top}.png`.

## Phase 5 (2026-10-19): Straight line vs Cornering (F1), plus a Falcon top-view fix

**Falcon top view:** the bar-code of white streaks ahead of the nose and behind the tail came from the travelling
pulse. It lifted every line toward full opacity whatever its resting opacity, so lines already faded out by the focus
envelope still flashed their pulses. The pulse is now scaled by the same envelope (and the line's fade-in): a new
per-vertex `envelope` attribute, added to the shader only for a scene with a focus envelope (the Falcon). The F1
shader text is unchanged. Nothing else in the Falcon scene changed (rakes, lines, cameras).

**Cornering** (`src/particles/cornering.js`, `CORNERING_CONFIG`): a left-hand corner. The oncoming air arrives yawed
8 degrees (config `yawDeg`) from the outside of the corner, the car's right. The cornering flow is the straight-line
flow re-authored, not mirrored:
- the freestream is turned by the yaw (opt-in `yaw` argument to `createVectorField`);
- the guide curves keep their shape along the car, but their ends ahead of the nose and behind the car are sheared
  sideways along the yawed flow (mirrored curves are expanded first, so the two sides are no longer reflections);
- every wake cone and trailing vortex leans with the yawed flow;
- two extra wakes carry the separated air in the lee of the left sidepod and left rear tyre;
- along the flanks the exposed right side runs up to 10% faster (`exposedSpeedGain`) and the shielded left side up
  to 18% slower (`shieldedSpeedLoss`).

The wake particles are released along the yawed flow (`yawWakeDomain`: same spawn plane behind the rear wheels,
turned direction). The front wheels steer 4 degrees left (`steerDeg`, `createFrontSteer` in `wheels.js`, on top of
the spin). The distance field is the same, so the steered tyres are not in it.

**Bake:** `node scripts/bake_streamlines.mjs f1 --cornering` writes `data/streamlines_corner_full` (395
lines), from the same rakes and distance field. `npm run build` bakes it when stale and ships it.

**Runtime:** both states' lines and wake particles are built at load and the switch only changes visibility, so
switching takes under a millisecond. Every flow setting (part-only groups, density, trail, speed) goes to both. The
switch ("Straight line" / "Cornering", from the design's `#driving` group) is shown in the F1 only and hidden in the
Falcon 6X. Straight line is the default, Reset returns to it, and the F1 keeps its state across a trip to the Falcon.

**Track:** in Cornering the track (not the car) is moved and turned so the car sits at the apex of the left-hand
corner, 4.2 m inside the centreline with the inside kerb on its left. Straight line puts it back exactly.

**Speed slider:** drives both the line speed and the wheel rotation in both states (measured: half the slider gives
half of each, in both).

**Straight line unchanged:**
- the baked straight data files are untouched, and the fixed-seed re-bake is byte-identical to the reference;
- the F1 fingerprint (frozen clock: lines, uniforms, shaders, car, lights) is identical to the previous commit;
- a frozen-clock render differs only inside the controls panel, which now holds the switch.

**Checks:** `npm test` 20/20, models untouched. Assertions 2 to 7 also run on Cornering ("[cornering]": frame time
with the yawed release, wake particles, mesh penetration, reversal, turn angle, 25 speed probes). The new asymmetry
check measures the cornering lines: exposed right flank 1.05x the oncoming air against 0.70x on the shielded left,
and the air behind the car 0.50 half-widths to the left. Straight line, measured the same way, gives 0.88x / 0.88x
and 0.00. `test:ui` 31/31 on dev and dist. The new checks cover:
- the default state;
- a real click on Cornering swapping lines and wake, steering, and moving the track but not the car, with settings
  kept;
- Straight line restoring everything exactly;
- the switch hidden in the Falcon;
- the F1 keeping its driving state across a trip to the Falcon.

Build: dist is 58.3 MB.

**Screenshots:** `shots/phase5/p5-f1-{three-quarter,top,front}.png`, `p5-f1-cornering-{three-quarter,top,front}.png`,
`p5-falcon-top.png`.

## Phase 5 review: curved cornering flow, moving background

**Curved cornering flow.** Seen from the car in a corner, the oncoming air now moves in arcs centred on the corner's
centre instead of straight lines (`src/particles/vectorField.js`, `cornerFreestream`). It is a solid-body rotation:
speed grows with distance from the centre, so the air on the outside of the car is a little faster. The radius comes
from the drawn track (`CORNER_TRACK` in `src/particles/cornering.js`, shared with `src/track.js`): 40 m centreline,
car 4.2 m inside, so 35.8 m to the car. The car's yaw is applied on top and is now 4 degrees (`CORNERING_CONFIG.yawDeg`).
- Guide-curve ends ahead of and behind the car follow the arcs (yaw offset plus d²/2R towards the inside).
- Wake cones and trailing vortices lean by the yaw plus the arc's mean turn over their own length. The wake
  particles' release leans the same way (yaw plus the mean turn over 6 m).
- Same distance field and guide curves; the cornering lines were re-baked.
- New safety net, cornering set only: a line whose final points are still inside the distance field is dropped and
  replaced. Without it, about 1 in 4 random seeds left a point touching a thin front arm, mirror or rear rod.
- Measured: right flank 1.02x vs left 0.69x, air behind the car 0.30 half-widths to the left, line ends bent 0.27 m
  towards the inside. Straight line, measured the same way: 0.89x / 0.89x, +0.01, +0.01 m.

**Moving background.** Scenery only, never in the distance field, driven by the same simulated time as the lines (the
Speed slider scales it, Pause stops it, Reset returns it to the start).
- F1 Straight line: an endless straight that slides from nose to tail at exactly the speed of the oncoming air at the
  car, wrapping every 120 m. Everything on it repeats with that period: asphalt slabs in slightly varying tones,
  edge lines, kerb sections, catch-fence posts every 4 m, and pit garages and a grandstand once per tile.
- F1 Cornering: the track is a full ring of constant radius. It turns about the corner's centre so the road at the
  car moves with the oncoming air; the kerbs run all the way round, with three grandstands outside and one in the
  infield.
- Wheels roll without slipping: road speed under each tyre divided by that tyre's radius, measured from its
  vertices. In Cornering, the outside tyres turn faster than the inside ones. Measured contact-patch speed:
  5.51 against road 5.50 on the straight; 5.42 against 5.37 inside and 5.64 against 5.60 outside in the corner.
- Falcon 6X: the cloud deck drifts with the oncoming air, drawn as a layer 14 world units below the aircraft
  (`DECK_DEPTH` in `src/sky.js`). The noise is unbounded, so it never repeats or seams.
- Weight: the whole track is about 22k triangles. Only one layout is drawn at a time (at most 5 draw calls), and
  motion is one transform per frame.

**Straight-line lines unchanged:**
- fixed-seed bake byte-identical to the reference;
- frozen-clock fingerprint identical (lines ce08cacf11c3edf8, uniforms 7d18bba424c05fd9, car c22ed018a8810d2e,
  lights a2708a763a7392dd);
- the shipped straight data files were not touched.

The scenery around it has changed: an endless straight replaces the straight-then-corner layout.

**Checks:** `npm test` 20/20, models untouched. The cornering asymmetry check now also requires the line ends to bend
towards the inside. `test:ui` 34/34 on dev and dist; the new checks cover the track in both states and the Falcon
deck. Each one must:
- move at exactly the flow speed per simulated second at two Speed settings;
- stop on Pause;
- return to the start on Reset.

**Screenshots** in `shots/p5r/`:
- `v-f1-cornering-{three-quarter,top,front}.png`;
- `m-{f1-straight,f1-cornering,falcon}-three-quarter-t{0,1,2}.png`, each step exactly 1 s of app time at the default
  Speed, with playback paused for the stepping.

## Falcon descriptions, desktop only, README (2026-10-20)

**Falcon descriptions.** Your text for the fuselage, wings, engines, tail and wake is in `data/components.json`;
windows and door stay title-only. Every Falcon card shows its full text without scrolling or clipping at 1440x900,
1280x720 and 1024x640.

**Desktop only.** The site is for desktop browsers. On a screen narrower than 760 px or shorter than 500 px, the page
shows only a centred notice in the same style (the title, then "Open this page on a computer to explore the airflow.").
The app is not started there, so the models and data are never downloaded; if the window grows to desktop size, the
app starts then. The desktop view is unchanged: a frozen-clock render of the F1 is pixel-identical to the previous
commit (0 differing pixels), the fingerprint matches (lines, uniforms, car, lights), and the baked lines that ship are
the same files as before. The interface checks cover the notice at 390x844 and 844x390 (only the notice is shown,
nothing is downloaded, no console errors, growing the window starts the app) and confirm it is hidden at desktop size.

**README** rewritten for the public repo: both scenes, Straight line and Cornering with the curved flow, and the moving
scenery. The disclosure is unchanged, word for word.

**Fix found by the checks.** The Falcon "click either side of a part" UI check failed intermittently (the left
engine). Cause: an immediate camera jump (`flyTo(..., true)` in `src/cameraRig.js`) did not cancel a fly-to already
under way, so the old fly carried on and the camera ended up somewhere else. A jump now cancels it. In the interface
the only immediate jump is at load, when nothing is flying, so the visible behaviour is unchanged. The checks then
passed on 3 dev runs in a row and on dist.

**Checks:** `npm test` 20/20, models untouched; `test:ui` 32/32 on dev and on dist.

## Published: Falcon, cornering, moving scenery, desktop only (2026-10-20)

Publishing set up on this PC. The public copy now includes the Falcon model, the name scrub covers every data file on
the site, and the publish scan also rejects e-mail addresses. Pushed `main` and `gh-pages`, both committed with the
GitHub no-reply address. GitHub Pages built the new site; it loads both scenes and the cornering switch in headless
Chrome, with no console errors, no failed requests and the disclaimer shown.

## Model rename and a fresh public history (2026-10-20)

- The F1 model is now `models/F1 model.glb` (renamed with `git mv`; sha256 `bd71a85f...2903` unchanged, so the file
  itself is untouched). Every reference is updated: `src/car.js`, `src/sceneConfig.js`, the data JSON, `package.json`,
  the bake and build scripts, the test fixtures and this log.
- The publish scan also checks the text files it writes for wording left over from the removed small-screen version.
- The public history was replaced: `main` and `gh-pages` each hold a single new commit.
- Checks: `npm test` 20/20, models untouched; `test:ui` 32/32 on dist.

## Credit line, README authorship, About box (2026-10-20)

- Site: a credit line under the disclaimer, inside the same bottom-right panel and in the same type, with "GitHub"
  linking to the source repo. It fits beside the part buttons and under the component card at 1440x900, 1280x720 and
  1024x640 (no overlap, no card scrolling). A new UI check covers the disclaimer and the credit line and its link.
- README: an authorship paragraph and the live-viewer link under the name; the disclosure paragraph replaced.
- `make_public.py`: the full name is allowed only in the credit phrase (the page and the built page) and the site
  address only in the README's live-viewer line; each must be present there, and both stay blocked everywhere else.
  Text files are now read and written as UTF-8 with their line endings kept: before, Windows line endings crept into
  every file the name scrub touched.
- GitHub About box: description and website set with `gh repo edit`.
- Known, older: at 1024 px wide the camera buttons wrap to a second row behind the controls panel.
