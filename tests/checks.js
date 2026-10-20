#!/usr/bin/env node
// Project-wide checks, per BUILD.md Phase 0 item 3, extended by Phase 3.6
// section 0's diagnosis, Phase 3.7 section 1, and the post-Phase-3.7 grid
// review. Exactly seven assertions:
//   1. every expected component name is present after the GLB loads
//   2. frame time stays under 16ms at maximum particle density
//   3. zero WAKE PARTICLES are located inside an occupied collision-grid cell
//   4. zero STREAMLINE points are within `MESH_VIOLATION_THRESHOLD` of the
//      REAL, full-resolution, as-displayed GLB mesh surface
//   5. no streamline point's physical field velocity has a negative
//      streamwise component outside a declared wake region
//   6. outside a declared wake region, no traced line turns more than 30
//      degrees between consecutive segments
//   7. speed is slower / faster than the oncoming air at named probe points (tests/speedProbes.js)
//
// Phase 6: assertions 2-7 also run on the Falcon 6X scene (data/falcon/, its own probes), reported with a
// "[falcon]" prefix; the F1 results keep their names. They skip if the Falcon model or its baked data is absent.
//
// Phase 5: assertions 2-7 also run on the F1 in Cornering (the yawed flow, src/particles/cornering.js), reported
// with a "[cornering]" prefix, followed by one extra check that the two sides of the car clearly differ there.
//
// Assertion 3 exercises particleSystem.js's wake particles ONLY -- it has
// never sampled a single streamline point, despite streamlines being the
// primary flow visualisation since Phase 3.5. Phase 3.6 section 0 found this
// gap explicitly ("assertion 3 should be catching this" -- it structurally
// cannot). Assertion 4 closes it: it traces the exact streamline set
// buildAllStreamlines() would hand to the renderer and checks every point.
//
// Assertion 4 used to check points against the baked occupancy GRID
// (`grid.isOccupiedWorld()`), not the real mesh. A mesh-accurate audit
// (the author's review, 2026-09) found that gap directly: streamlines that
// passed with zero grid violations were nonetheless visibly crossing the
// tyre crown, front wing endplate, and bodywork flank in renders -- the
// grid is a discretised proxy (and was, at the time, a hollow shell baked
// from a 90%-decimated copy; both fixed in bake_occupancy_grid.py, see its
// docstring), not the thing the user actually looks at. Assertion 4 now
// shells out to scripts/mesh_accuracy_check.py, which checks every point
// against the REAL, full-resolution, as-displayed mesh (car.js's exact
// per-component mirror, not the bake's approximation of it) via trimesh.
// Slower than a grid lookup and requires the project's .venv -- acceptable
// since this runs offline, never in the browser. The grid-based clamp-fire
// stats are still reported alongside it (useful tracing diagnostics), but
// no longer decide pass/fail.
//
// Assertion 5 is Phase 3.7 section 1's "invariant that comes first" --
// vectorField.js's velocityAt() clamps this internally (see
// flowInvariant.js), so this assertion should always pass by construction;
// it exists to CATCH a regression (e.g. a future primitive/guide-curve path
// that bypasses the clamp) rather than to trust the implementation.
//
// Assertions 2-5 depend on code that does not exist until Phase 2, Phase 3,
// Phase 3.5, and Phase 3.7 respectively. Until then they SKIP with a clear
// message rather than failing or being silently omitted. Do not weaken or
// delete an assertion to make it pass — extend it when the relevant phase
// lands.

import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { inspectGLB } from '../scripts/inspect-glb.js';
import { runParticleBenchmark } from './particles.bench.js';
import { parseOccupancyGrid } from '../src/particles/collisionGrid.js';
import { loadSdfSync } from '../src/particles/sdf.js';
import * as fsAll from 'node:fs';
import { domainFromBounds, computeWakeDomain } from '../src/particles/domain.js';
import { createParticleSystem } from '../src/particles/particleSystem.js';
import { buildAllStreamlines } from '../src/particles/streamlines.js';
import { PARTICLE_CONFIG, FALCON_PARTICLE_OVERRIDES } from '../src/particles/config.js';
import { buildWakes, wakeImmersionAt } from '../src/particles/wakes.js';
import { FLOW_INVARIANT_CONFIG } from '../src/particles/flowInvariant.js';
import { runSpeedProbes, PROBE_MARGIN } from './speedProbes.js';
import { corneringRakes, yawWakeDomain, wakeLeanDeg, CORNERING_CONFIG } from '../src/particles/cornering.js';

// A streamline point within this many world units of the REAL mesh surface
// counts as a violation for assertion 4 -- "essentially touching" the
// visible skin, not scaled to the occupancy grid's pitch (that grid is no
// longer what this assertion checks against at all).
// Models a checkout may leave out (the public copy does not ship the Falcon model): their checks are skipped, not failed.
const OPTIONAL_MODELS = new Set(['falcon']);

const MESH_VIOLATION_THRESHOLD = 0.001;

// Assertion 6: outside a declared wake region, no traced line may turn by
// more than this many degrees between consecutive segments.
const MAX_TURN_DEGREES = 30;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const results = []; // { name, status: 'PASS'|'FAIL'|'SKIP', detail }

// What differs per scene. The F1 reads its flow domain from the occupancy grid header (as it always has); the Falcon,
// which has no occupancy grid, from data/falcon/domain.json (written by scripts/bake_falcon_sdf.py).
const SCENES = {
  f1: { id: 'f1', prefix: '', dataDir: 'data', config: PARTICLE_CONFIG, groundY: PARTICLE_CONFIG.groundY,
    domainFile: 'occupancy_grid.json', flowDomainOf: (h) => h.flowDomain, wakeLabel: 'rear-wheel spawn regions' },
  falcon: { id: 'falcon', prefix: '[falcon] ', dataDir: join('data', 'falcon'), config: { ...PARTICLE_CONFIG, ...FALCON_PARTICLE_OVERRIDES }, groundY: null,
    domainFile: 'domain.json', flowDomainOf: (h) => h, wakeLabel: 'tail-cone and exhaust spawn regions' },
};
// Phase 5: the F1 in Cornering -- the same car, data and distance field, with the yaw applied to the flow
// (src/particles/cornering.js) and to the wake particles' release.
SCENES.f1Cornering = { ...SCENES.f1, prefix: '[cornering] ', cornering: true, wakeLabel: 'rear-wheel spawn regions, yawed release' };

function domainFor(scene) {
  const fd = scene.flowDomainOf(JSON.parse(readFileSync(join(ROOT, scene.dataDir, scene.domainFile), 'utf8')));
  return domainFromBounds(
    { minX: fd.bboxMin[0], maxX: fd.bboxMax[0], minY: fd.bboxMin[1], maxY: fd.bboxMax[1], minZ: fd.bboxMin[2], maxZ: fd.bboxMax[2] },
    fd.flowAxis, fd.flowSign, scene.config
  );
}

function record(name, status, detail) {
  results.push({ name, status, detail });
  const tag = status.padEnd(4);
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

// --- Assertion 1: every expected component name is present after the GLB loads ---
function checkComponentNames() {
  const name = 'assertion 1: expected component names present in GLB';
  const fixturePath = join(ROOT, 'tests', 'fixtures', 'expected-components.json');
  if (!existsSync(fixturePath)) {
    record(name, 'FAIL', 'tests/fixtures/expected-components.json is missing');
    return;
  }
  const expected = JSON.parse(readFileSync(fixturePath, 'utf8'));

  let allOk = true;
  const problems = [];
  const notPresent = [];

  for (const [key, spec] of Object.entries(expected)) {
    const fullPath = join(ROOT, spec.file);
    if (!existsSync(fullPath)) {
      if (OPTIONAL_MODELS.has(key)) { notPresent.push(key); continue; } // not shipped in the public copy; only needed from Phase 6
      allOk = false;
      problems.push(`${key}: file missing (${spec.file})`);
      continue;
    }
    // "the GLB loads" — parsed here via the same GLB/glTF chunk reader the
    // rest of the tooling uses. This does not require a WebGL context, so
    // it can run in plain Node ahead of Phase 1's in-browser GLTFLoader.
    const info = inspectGLB(fullPath);
    const actualNames = new Set(info.nodeNames);
    const missing = spec.componentNames.filter((n) => !actualNames.has(n));
    if (missing.length > 0) {
      allOk = false;
      problems.push(`${key}: missing components: ${missing.join(', ')}`);
    }
    if (info.meshNodeCount !== spec.componentCount) {
      allOk = false;
      problems.push(
        `${key}: component count changed (expected ${spec.componentCount}, found ${info.meshNodeCount})`
      );
    }
  }

  if (allOk) {
    const summary = Object.entries(expected)
      .filter(([k]) => !notPresent.includes(k))
      .map(([k, s]) => `${k}=${s.componentCount}`)
      .join(', ');
    record(name, 'PASS', `all expected components present (${summary})` + (notPresent.length ? ` — skipped ${notPresent.join(', ')}: model file not present` : ''));
  } else {
    record(name, 'FAIL', problems.join('; '));
  }
}

// --- Assertion 2: frame time stays under 16ms at maximum particle density ---
//
// No headless-GL renderer is part of this project's toolchain (see
// PROGRESS.md Phase 1/2), so an actual WebGL frame time cannot be measured
// from plain Node. What IS measured here, honestly, is the full CPU-side
// per-frame cost of the particle system at its configured maximum density:
// the physics update (src/particles/particleSystem.js) plus the trail
// vertex-buffer rebuild (src/particles/trailBuffers.js) that three.js's
// renderer would otherwise have to wait on before it could even start
// drawing. See tests/particles.bench.js for the full method and exactly
// what is/isn't covered. Thresholds below leave deliberate headroom for
// the unmeasured GPU-side work, rather than skimming right under 16ms.
// 16ms/frame is the ~60fps budget this whole assertion is named after.
const MEAN_BUDGET_MS = 6; // leaves the remaining ~10ms/frame for actual GPU work
const WORST_FRAME_BUDGET_MS = 16; // even the single worst CPU frame must fit the budget alone

function checkFrameTime(scene = SCENES.f1) {
  const name = `${scene.prefix}assertion 2: frame time < 16ms at max particle density`;
  const particleSystemPath = join(ROOT, 'src', 'particles');
  if (!existsSync(particleSystemPath)) {
    record(
      name,
      'SKIP',
      'not applicable yet — Phase 2 (particle system) has not been built. ' +
      'src/particles/ does not exist.'
    );
    return;
  }

  const result = runParticleBenchmark({ maxCount: scene.config.maxCount, yawDeg: scene.cornering ? wakeLeanDeg() : 0 });
  const detail =
    `${result.maxCount} particles, ${result.frames} frames — ` +
    `mean ${result.meanMs.toFixed(3)}ms, p95 ${result.p95Ms.toFixed(3)}ms, ` +
    `worst ${result.maxMs.toFixed(3)}ms (CPU update+trail-buffer step only, ` +
    `no GPU/WebGL — see tests/particles.bench.js)`;

  if (result.meanMs < MEAN_BUDGET_MS && result.maxMs < WORST_FRAME_BUDGET_MS) {
    record(name, 'PASS', detail);
  } else {
    record(name, 'FAIL', detail + ` — exceeds budget (mean < ${MEAN_BUDGET_MS}ms, worst < ${WORST_FRAME_BUDGET_MS}ms)`);
  }
}

// --- Assertion 3: zero particles are located inside an occupied collision-grid cell ---
//
// This is a genuine check against the real baked grid, not a mock: it
// parses the actual data/occupancy_grid.json + .bin produced by
// scripts/bake_occupancy_grid.py (via the exact same collisionGrid.js
// `parseOccupancyGrid()` the browser runtime uses), builds a flow domain in
// the same real-world coordinate space from the bbox the bake recorded
// (via domain.js's `domainFromBounds()` -- the same pure math
// computeFlowDomain() uses from a live three.js scene, just fed bounds from
// the grid's own header instead of an Object3D, so it needs no browser),
// then runs the real particle simulation -- including deflection -- for
// several hundred frames at maximum density and checks every particle's
// position after every frame.
const COLLISION_CHECK_FRAMES = 240; // several full spawn-to-recycle cycles
// at config.downstreamMargin/flowSpeed, at maxCount density

function checkCollisionGrid(scene = SCENES.f1) {
  const name = `${scene.prefix}assertion 3: zero wake particles inside the signed-distance surface`;
  const jsonPath = join(ROOT, scene.dataDir, scene.domainFile);
  const sdfJsonPath = join(ROOT, scene.dataDir, 'sdf.json');
  const sdfBinPath = join(ROOT, scene.dataDir, 'sdf.bin');

  if (!existsSync(jsonPath) || !existsSync(sdfJsonPath) || !existsSync(sdfBinPath)) {
    record(
      name,
      'SKIP',
      'not applicable yet — data/ contains no baked occupancy grid / signed distance field.'
    );
    return;
  }

  // Phase 4: the wake particles run on the SDF (src/particles/sdf.js), not the
  // binary occupancy grid, so this checks the SDF. The same wake domain and
  // rear-wheel spawn regions as src/particles/index.js are used, so the test
  // exercises the real configuration. The stored field is deliberately
  // inflated by 0.6 of a lattice cell, so "distance >= 0" means at least
  // that far from the real surface.
  const sdf = loadSdfSync(join(ROOT, scene.dataDir) + '/', fsAll, scene.groundY);
  const fullDomain = domainFor(scene);
  const spawn = scene.config.wakeSpawn;
  const wakeDomain = computeWakeDomain(fullDomain, spawn.alongFlow);
  const domain = scene.cornering ? yawWakeDomain(wakeDomain, wakeLeanDeg()) : wakeDomain;

  const maxCount = scene.config.maxCount;
  const config = { ...scene.config, count: maxCount, spawnRegions: spawn.regions };
  const system = createParticleSystem(domain, config, null, sdf);
  system.setActiveCount(maxCount);

  const dt = 1 / 60;
  let violations = 0;
  let firstViolation = null;
  let particleFramesChecked = 0;
  const tmp = new Float64Array(4);

  for (let f = 0; f < COLLISION_CHECK_FRAMES; f++) {
    system.update(dt);
    const { posX, posY, posZ } = system.buffers;
    for (let i = 0; i < system.activeCount; i++) {
      particleFramesChecked++;
      if (sdf.isNear(posX[i], posY[i], posZ[i]) && sdf.sampleAt(posX[i], posY[i], posZ[i], tmp) < 0) {
        violations++;
        if (!firstViolation) firstViolation = { frame: f, particle: i, x: posX[i], y: posY[i], z: posZ[i] };
      }
    }
  }

  if (violations === 0) {
    record(
      name,
      'PASS',
      `${maxCount} particles x ${COLLISION_CHECK_FRAMES} frames ` +
      `(${particleFramesChecked.toLocaleString()} particle-frames) checked against ` +
      `the baked signed distance field, wake domain + ${scene.wakeLabel} — zero inside the surface`
    );
  } else {
    const v = firstViolation;
    record(
      name,
      'FAIL',
      `${violations} particle-frame(s) out of ${particleFramesChecked.toLocaleString()} ` +
      `inside the signed-distance surface — first at frame ${v.frame}, particle ${v.particle}, ` +
      `world position (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`
    );
  }
}

// --- Assertion 4: zero STREAMLINE points are located inside an occupied collision-grid cell ---
//
// The gap Phase 3.6 section 0 found: assertion 3 above only ever exercises
// particleSystem.js's wake particles. It has never traced or sampled a
// single streamline point, even though streamlines have been the primary
// flow visualisation since Phase 3.5. This traces the EXACT streamline set
// buildAllStreamlines() would hand to streamlineRenderer.js (same domain,
// same grid, same rakes config, same PARTICLE_CONFIG base speed) and checks
// every recorded point on every line against the real baked grid.
//
// Seeding is randomised (seeding.js's rejection sampling uses Math.random()),
// so unlike assertions 1-3 this is not bit-for-bit reproducible between
// runs — a flaky failure here is itself signal (a rare seed/geometry
// combination the tracer's safety clamp didn't handle), not just noise.
//
// Shared by assertions 4 and 5 so the (potentially expensive, RK4 +
// vorticity + guide-curve) streamline set is only traced ONCE, not twice.
// Returns null (having already recorded a SKIP for both assertions) if the
// required baked/config files don't exist yet.
function buildStreamlinesForTests(scene = SCENES.f1) {
  const p = scene.prefix;
  const dir = join(ROOT, scene.dataDir);
  const rakesPath = join(dir, 'rakes.json');
  const sdfJsonPath = join(dir, 'sdf.json');
  const sdfBinPath = join(dir, 'sdf.bin');
  const domainPath = join(dir, scene.domainFile);
  const skipAll = (detail) => {
    record(`${p}assertion 4: zero streamline points within the real mesh surface`, 'SKIP', detail);
    record(`${p}assertion 5: no streamline reverses streamwise direction outside a declared wake region`, 'SKIP', detail);
    record(`${p}assertion 6: no sharp kinks outside a wake region`, 'SKIP', detail);
    record(`${p}assertion 7: speed sanity probes`, 'SKIP', detail);
    return null;
  };

  if (!existsSync(sdfJsonPath) || !existsSync(sdfBinPath)) {
    return skipAll(`not applicable — ${scene.dataDir}/sdf.json + sdf.bin are missing; streamlines are traced against that signed distance field.`);
  }
  if (!existsSync(domainPath)) {
    return skipAll(`not applicable yet — ${scene.dataDir}/${scene.domainFile} (the flow domain) is missing.`);
  }
  if (!existsSync(rakesPath)) {
    return skipAll(`not applicable yet — ${scene.dataDir}/rakes.json (streamline seeding) is missing.`);
  }

  // The F1 also loads its occupancy grid (returned for the tracing diagnostics, as before); the Falcon has none.
  let grid = null;
  if (scene.id === 'f1') {
    const binNode = readFileSync(join(dir, 'occupancy_grid.bin'));
    const binArrayBuffer = binNode.buffer.slice(binNode.byteOffset, binNode.byteOffset + binNode.byteLength);
    grid = parseOccupancyGrid(JSON.parse(readFileSync(domainPath, 'utf8')), binArrayBuffer);
  }
  const domain = domainFor(scene);
  const baseRakes = JSON.parse(readFileSync(rakesPath, 'utf8'));
  const rakesConfig = scene.cornering ? corneringRakes(baseRakes, domain) : baseRakes;
  const sdf = loadSdfSync(dir + '/', fsAll, scene.groundY);

  const result = buildAllStreamlines(domain, sdf, scene.config, rakesConfig);
  return { grid, sdf, result, domain, rakesConfig, scene };
}

function checkStreamlinePenetration(built) {
  const { result, scene } = built;
  const name = `${scene.prefix}assertion 4: zero streamline points within the real mesh surface`;
  const { paths, clampFireCount, subStepCount, clampFireRate, requestedLineCount, deviationCulled, clampCulled, topUpAdded } = result;

  const clampDetail = `signed-distance correction fired deeper than half the standoff on ` +
    `${clampFireCount.toLocaleString()}/${subStepCount.toLocaleString()} sub-steps (${(clampFireRate * 100).toFixed(3)}%)`;
  const cullDetail = `culling (of ${requestedLineCount} traced): ${deviationCulled} removed for staying below the ` +
    `freestream-deviation threshold, ${clampCulled} removed for exceeding the clamp-fire-count threshold, ` +
    `${topUpAdded} replacement line(s) added back — ${paths.length} final`;

  const pythonBin = process.platform === 'win32'
    ? join(ROOT, '.venv', 'Scripts', 'python.exe')
    : join(ROOT, '.venv', 'bin', 'python3');
  const checkScript = join(ROOT, 'scripts', 'mesh_accuracy_check.py');
  if (!existsSync(pythonBin) || !existsSync(checkScript)) {
    record(
      name,
      'SKIP',
      'not applicable — the project .venv (trimesh/numpy/rtree) or ' +
      'scripts/mesh_accuracy_check.py is missing; this assertion validates against the ' +
      'REAL GLB mesh (not the occupancy grid) and needs both. See BUILD.md/CLAUDE.md for venv setup.'
    );
    return;
  }

  let pointCount = 0;
  for (const p of paths) pointCount += p.positions.length / 3;
  const flat = new Float32Array(pointCount * 3);
  let w = 0;
  for (const p of paths) for (let i = 0; i < p.positions.length; i++) flat[w++] = p.positions[i];

  const pointsFile = join(ROOT, 'scripts', '.tmp_mesh_check_points.bin');
  writeFileSync(pointsFile, Buffer.from(flat.buffer));

  try {
    const stdout = execFileSync(
      pythonBin,
      [checkScript, '--points', pointsFile, '--threshold', String(MESH_VIOLATION_THRESHOLD), '--scene', scene.id],
      { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    const meshResult = JSON.parse(stdout.trim().split('\n').pop());
    const { violationCount, violationsByComponent, distancePercentiles, farPointCount } = meshResult;

    const meshDetail = `checked against the real full-resolution GLB mesh (scripts/mesh_accuracy_check.py, ` +
      `threshold ${MESH_VIOLATION_THRESHOLD}) — nearest-surface distance p50=${distancePercentiles['50'].toFixed(4)}, ` +
      `p90=${distancePercentiles['90'].toFixed(4)}, min=${distancePercentiles['0'].toFixed(4)}` +
      (farPointCount ? ` (exact for the points within the baked field's band; ${farPointCount.toLocaleString()} farther points skipped)` : '');

    if (violationCount === 0) {
      record(
        name,
        'PASS',
        `${paths.length} streamlines, ${pointCount.toLocaleString()} points — zero within ` +
        `${MESH_VIOLATION_THRESHOLD} of the real mesh surface — ${meshDetail} — ${clampDetail} — ${cullDetail}`
      );
    } else {
      const byComponent = Object.entries(violationsByComponent)
        .map(([c, n]) => `${c}: ${n}`).join(', ');
      record(
        name,
        'FAIL',
        `${violationCount} point(s) out of ${pointCount.toLocaleString()} within ` +
        `${MESH_VIOLATION_THRESHOLD} of the real mesh surface — by component: ${byComponent} — ` +
        `${meshDetail} — ${clampDetail} — ${cullDetail}`
      );
    }
  } catch (err) {
    record(
      name,
      'FAIL',
      `scripts/mesh_accuracy_check.py did not run successfully: ${err.message}`
    );
  } finally {
    if (existsSync(pointsFile)) unlinkSync(pointsFile);
  }
}

// --- Assertion 5: no streamline reverses streamwise direction outside a declared wake region ---
//
// Phase 3.7 section 1's invariant, checked against real traced points
// rather than trusted from the implementation: streamlines.js independently
// recomputes the physical field's streamwise component and wake immersion
// at every recorded point (see its recordAt()) and counts violations. This
// should always be zero -- vectorField.js's velocityAt() clamps the
// invariant internally -- so a nonzero count here means some code path
// (a future primitive, a guide curve, anything summed into the field)
// bypassed that clamp.
function checkStreamlineReversal(built) {
  const { result, scene } = built;
  const name = `${scene.prefix}assertion 5: no streamline reverses streamwise direction outside a declared wake region`;
  const { paths, reversalCount } = result;

  const totalPoints = paths.reduce((sum, p) => sum + p.positions.length / 3, 0);

  if (reversalCount === 0) {
    record(
      name,
      'PASS',
      `${paths.length} streamlines, ${totalPoints.toLocaleString()} points checked — ` +
      `zero streamwise reversals found outside a declared wake region`
    );
  } else {
    record(
      name,
      'FAIL',
      `${reversalCount} point(s) out of ${totalPoints.toLocaleString()} had a negative ` +
      `streamwise field velocity outside any declared wake region`
    );
  }
}

// --- Assertion 6: no sharp kinks outside a declared wake region ---
//
// Added after renders showed grid-aligned staircase zigzags: the old binary
// corrections (clamp / reclamp / neighbour-snap) each moved a point by a
// whole-cell step along a per-cell normal, producing turns of 90 degrees and
// more between consecutive segments. A traced line is a physical-looking
// streamline outside a wake, so consecutive segments may never turn by more
// than MAX_TURN_DEGREES. Inside a wake region (wakes.js immersion above the
// flow invariant's own threshold) random jitter is deliberate and excluded;
// a point only counts as outside if it AND both its neighbours are.
function checkStreamlineKinks(built) {
  const { result, domain, rakesConfig, scene } = built;
  const name = `${scene.prefix}assertion 6: no line turns more than ${MAX_TURN_DEGREES} degrees between segments outside a wake region`;
  const wakes = buildWakes(domain, rakesConfig.wakes || []);
  const thr = FLOW_INVARIANT_CONFIG.wakeImmersionThreshold;
  const cosMax = Math.cos((MAX_TURN_DEGREES * Math.PI) / 180);
  let checked = 0, violations = 0, worst = 0;
  for (const path of result.paths) {
    const P = path.positions;
    const n = P.length / 3;
    const outside = new Uint8Array(n);
    for (let i = 0; i < n; i++) outside[i] = wakeImmersionAt(wakes, P[i * 3], P[i * 3 + 1], P[i * 3 + 2]) <= thr ? 1 : 0;
    for (let i = 1; i < n - 1; i++) {
      if (!outside[i - 1] || !outside[i] || !outside[i + 1]) continue;
      const ax = P[i * 3] - P[i * 3 - 3], ay = P[i * 3 + 1] - P[i * 3 - 2], az = P[i * 3 + 2] - P[i * 3 - 1];
      const cx = P[i * 3 + 3] - P[i * 3], cy = P[i * 3 + 4] - P[i * 3 + 1], cz = P[i * 3 + 5] - P[i * 3 + 2];
      const la = Math.hypot(ax, ay, az), lc = Math.hypot(cx, cy, cz);
      if (la < 1e-9 || lc < 1e-9) continue; // a repeated point has no direction
      checked++;
      const cos = (ax * cx + ay * cy + az * cz) / (la * lc);
      const deg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
      if (deg > worst) worst = deg;
      if (cos < cosMax) violations++;
    }
  }
  const detail = `${result.paths.length} streamlines, ${checked.toLocaleString()} interior points outside any wake checked — worst turn ${worst.toFixed(1)}°`;
  if (violations === 0) record(name, 'PASS', `${detail} — zero turns over ${MAX_TURN_DEGREES}°`);
  else record(name, 'FAIL', `${violations} turn(s) over ${MAX_TURN_DEGREES}° (${(100 * violations / checked).toFixed(2)}% of points) — ${detail}`);
}

// --- Assertion 7: speed sanity ---
//
// The streamline colour is the field's speed relative to the oncoming air, so the field has to get the known
// F1 pattern right: slower than the oncoming air at the nose tip, the front of each tyre, halo and airbox, the
// tops of both wings and in the wake behind the rear wheels and rear wing; faster under the front wing, under the
// floor, round the outer shoulders of the front tyres, over the sidepods and under the rear wing; and the diffuser
// exit slower than the underfloor just ahead of it. Probe points sit on the real bodywork (tests/speedProbes.js).
// A failure is fixed in data/rakes.json (guide-curve speedScale, wake speedDeficit), never in the colour mapping.
function checkSpeedSanity(built) {
  const { domain, sdf, rakesConfig, scene } = built;
  const name = scene.id === 'falcon'
    ? `${scene.prefix}assertion 7: speed is slower/faster than the oncoming air where aircraft aerodynamics says, and faster over the wing than under it (margin ${PROBE_MARGIN * 100}%)`
    : `${scene.prefix}assertion 7: speed is slower/faster than the oncoming air where F1 aerodynamics says (margin ${PROBE_MARGIN * 100}%)`;
  const rows = runSpeedProbes(domain, sdf, scene.config, rakesConfig, scene.id);
  const bad = rows.filter((r) => !r.ok);
  if (bad.length === 0) {
    record(name, 'PASS', `${rows.length} probes, all in the expected direction`);
  } else {
    record(name, 'FAIL', bad.map((r) => `${r.name}: ${Number.isNaN(r.ratio) ? 'no surface' : r.ratio.toFixed(2) + 'x'} (expected ${r.expect})`).join('; '));
  }
}

// --- Phase 5 asymmetry: in Cornering the two sides of the car must clearly differ ---
//
// Measured on the traced cornering lines, beside each flank (alongFlow -0.3..0.8, 0.8..1.8 half-widths out, below
// the top of the bodywork) and well behind the car (alongFlow 1.4..1.7): the exposed right flank must run at least 8%
// of the oncoming speed faster than the shielded left, and the air behind the car must have moved at least 0.15
// half-widths towards the inside of the corner (the left). The straight-line lines, measured the same way, are
// reported alongside: there both numbers are near zero.
function flowSides(paths, domain) {
  const hw = domain.carWidth / 2, fs = PARTICLE_CONFIG.flowSpeed;
  const flank = { right: [0, 0], left: [0, 0] };
  let lateralSum = 0, lateralN = 0;
  for (const p of paths) {
    const P = p.positions;
    for (let i = 0; i < P.length / 3; i++) {
      const rx = P[i * 3] - domain.originX, ry = P[i * 3 + 1] - domain.originY, rz = P[i * 3 + 2] - domain.originZ;
      const a = (rx * domain.dirX + rz * domain.dirZ) / domain.halfLength;
      const l = (rx * domain.rightX + rz * domain.rightZ) / hw;
      const v = ry / domain.carHeight;
      if (a > -0.3 && a < 0.8 && Math.abs(l) > 0.8 && Math.abs(l) < 1.8 && v < 0.9) {
        const side = flank[l > 0 ? 'right' : 'left'];
        side[0] += p.speeds[i] / fs; side[1]++;
      }
      if (a > 1.4 && a < 1.7) { lateralSum += l; lateralN++; }
    }
  }
  const mean = ([s, n]) => (n ? s / n : NaN);
  return { right: mean(flank.right), left: mean(flank.left), nRight: flank.right[1], nLeft: flank.left[1], wakeLateral: lateralN ? lateralSum / lateralN : NaN };
}

/**
 * How much the lines bend, in metres: for every line that runs from 1.5 half-lengths ahead of the car's centre to 1.5
 * behind it, the mean of its sideways positions at those two ends minus its sideways position level with the centre.
 * Negative = both ends towards the car's left (the inside of a left-hander); ~0 for straight, symmetric flow.
 */
function lineBend(paths, domain) {
  const lateralAt = (P, target) => {
    for (let i = 0; i + 1 < P.length / 3; i++) {
      const a0 = ((P[i * 3] - domain.originX) * domain.dirX + (P[i * 3 + 2] - domain.originZ) * domain.dirZ) / domain.halfLength;
      const a1 = ((P[i * 3 + 3] - domain.originX) * domain.dirX + (P[i * 3 + 5] - domain.originZ) * domain.dirZ) / domain.halfLength;
      if ((a0 - target) * (a1 - target) <= 0 && a0 !== a1) {
        const t = (target - a0) / (a1 - a0);
        const x = P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * t, z = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * t;
        return (x - domain.originX) * domain.rightX + (z - domain.originZ) * domain.rightZ;
      }
    }
    return null;
  };
  let sum = 0, n = 0;
  for (const p of paths) {
    const ahead = lateralAt(p.positions, -1.5), mid = lateralAt(p.positions, 0), behind = lateralAt(p.positions, 1.5);
    if (ahead === null || mid === null || behind === null) continue;
    sum += (ahead + behind) / 2 - mid; n++;
  }
  return { bend: n ? sum / n : NaN, n };
}

function checkCorneringAsymmetry(built, straightBuilt) {
  const name = '[cornering] asymmetry and curve: the exposed right flank runs faster than the shielded left, the wake swings towards the inside, and the lines bend round the corner at both ends';
  const c = { ...flowSides(built.result.paths, built.domain), ...lineBend(built.result.paths, built.domain) };
  const s = straightBuilt ? { ...flowSides(straightBuilt.result.paths, straightBuilt.domain), ...lineBend(straightBuilt.result.paths, straightBuilt.domain) } : null;
  const diff = c.right - c.left;
  const fmt = (x) => `right flank ${x.right.toFixed(2)}x, left flank ${x.left.toFixed(2)}x (${x.nRight}/${x.nLeft} points), air behind the car at ${x.wakeLateral >= 0 ? '+' : ''}${x.wakeLateral.toFixed(2)} half-widths (negative = left), line ends bent ${x.bend >= 0 ? '+' : ''}${x.bend.toFixed(2)} m (${x.n} lines; negative = towards the inside)`;
  const detail = `cornering: ${fmt(c)}${s ? ` — straight line, for comparison: ${fmt(s)}` : ''}`;
  record(name, diff >= 0.08 && c.wakeLateral <= -0.15 && c.bend <= -0.08 ? 'PASS' : 'FAIL', detail);
}

function main() {
  console.log('Running project checks (tests/checks.js)\n');
  checkComponentNames();
  let straightBuilt = null;
  for (const scene of [SCENES.f1, SCENES.f1Cornering, SCENES.falcon]) {
    if (scene.id === 'falcon') {
      const fx = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'expected-components.json'), 'utf8')).falcon;
      if (!existsSync(join(ROOT, fx.file))) {
        record('[falcon] assertions 2-7', 'SKIP', `${fx.file} is not in this checkout`);
        continue;
      }
      console.log();
    }
    checkFrameTime(scene);
    checkCollisionGrid(scene);
    const built = buildStreamlinesForTests(scene);
    if (built) {
      checkStreamlinePenetration(built);
      checkStreamlineReversal(built);
      checkStreamlineKinks(built);
      checkSpeedSanity(built);
      if (scene === SCENES.f1) straightBuilt = built;
      if (scene.cornering) checkCorneringAsymmetry(built, straightBuilt);
    }
  }

  console.log();
  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  const passed = results.filter((r) => r.status === 'PASS');
  console.log(`Summary: ${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed.`);

  if (failed.length > 0) {
    process.exit(1);
  }
}

main();
