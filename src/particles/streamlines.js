// Streamline tracing, through Phase 3.6 (analytic primitives replaced a
// push-based SDF deflection) and Phase 3.7 (authored guide curves became
// the primary field mechanism; primitives now only add texture on top --
// see vectorField.js/primitives.js/guideCurves.js). Kept from 3.5: surface-
// scattered seeding (seeding.js) and the bidirectional trace-and-join shape.
//   - The true signed distance field (sdf.js, baked from the real full-
//     resolution mesh by scripts/bake_sdf.py) is the no-penetration
//     correction: if a step lands closer than `standoffCells` to the surface
//     (or inside it) the point is moved out along the interpolated
//     gradient by the penetration depth plus the standoff. The correction
//     is a continuous function of position -- no cell-sized jumps, no
//     per-cell normals, no neighbour-snap fallback. How often a step needed
//     a real (deeper than half-standoff) correction is tracked and returned
//     (`clampFireCount`/`clampFireRate`) -- frequent firing means the
//     field/guide-curve layout is wrong, per the Phase 3.6/3.7 specs.
//   - RK4 integration: three extra field samples per step for a much
//     smoother result around curvature, paid for once at trace/build time
//     (the geometry is static afterward), not per rendered frame.
//   - Vorticity |curl(V)| is recorded per point, via vectorField.js's
//     curlAt() -- also a build-time-only cost.
//   - Coherence (jitter/opacity loss) is driven by proximity to configured
//     WAKE regions (wakes.js) -- several small, placed, overlapping cones
//     -- instead of one global "past the car's trailing edge" zone. A wake
//     region is also where Phase 3.7 section 1's invariant (flowInvariant.js)
//     permits the streamwise component to go negative.
//
// Because the field has no direction-dependent behaviour baked in, backward
// integration is the exact negative of the forward field -- forward and
// backward tracing share ONE implementation (traceDirection), parameterised
// by a +1/-1 sign, rather than two near-duplicate functions.
//
// Zero dependency on three.js/DOM, like the rest of src/particles/, so this
// (and everything it calls) can run in plain Node.

import { createVectorField, curlAt } from './vectorField.js';
import { buildWakes, wakeImmersionAt } from './wakes.js';
import { generateSeeds, generateTopUpSeeds, computeGroupTargets, SEEDING_CONFIG } from './seeding.js';
import { streamwiseComponent, FLOW_INVARIANT_CONFIG } from './flowInvariant.js';
import { anchorToWorld, expandMirrored } from './anchors.js';

export const STREAMLINE_CONFIG = {
  stepTime: 0.014, // seconds of flight time integrated per logical RK4 step
  maxSteps: 500, // safety cap on logical steps (each may be sub-divided --
  // see nearSurfaceStepFraction); a line normally ends earlier, once it
  // crosses its direction's stop threshold
  upstreamRunCarLengths: 0.8, // backward integration stops once travelled
  // distance FROM THE SEED'S OWN STARTING POINT reaches this fraction of
  // the car's full length (2*domain.halfLength). Per-seed rather than a
  // fixed world position (the old upstreamStopFraction) so a nose/front-wing
  // seed -- already close to that fixed position -- doesn't get cut off
  // almost immediately while a rear seed gets its full run: every line gets
  // the same upstream reach regardless of where it starts
  cellWorld: 0.0289384, // world size of one occupancy-grid cell -- the unit every *Cells value below is in
  standoffCells: 0.5, // minimum distance (occupancy cells) a recorded point
  // may sit from the real surface; a step landing closer is pushed out
  // along the SDF gradient by (standoff - distance), which also covers
  // penetration (negative distance)
  standoffMaxIterations: 6, // the gradient is only locally exact, so the
  // push is repeated until the point clears the standoff
  stallWindow: 40, // sub-steps
  stallMinTravel: 0.02, // world units: a line that moves less than this over
  // `stallWindow` consecutive sub-steps is pinned (a head-on stagnation point
  // against a surface, bouncing between the field's push and its repulsion).
  // Tracing stops there and the line is culled as misbehaving -- it would
  // otherwise spend its whole step budget oscillating on one spot.
  clampFireDepthFraction: 0.5, // a correction counts as a clamp "fire" (for
  // the stats and the misbehaving-line cull) only if the step landed
  // closer than this fraction of the standoff -- routine sliding along the
  // standoff contour is not a routing failure
  nearSurfaceStepFraction: 0.4, // caps the effective per-step travel
  // distance to this fraction of an occupancy cell whenever the current point
  // is near the occupied region, subdividing the RK4 step as needed -- a
  // numerical safety net (a fast step could still cross a thin shell
  // between samples), not a curvature mechanism any more
  maxSubSteps: 3, // kept low since RK4 already costs 4x a plain Euler
  // step; combined with substeps this is at most 12x a single field
  // sample, and per section 2 the clamp -- and therefore this path --
  // should fire rarely if the primitives are placed well
  vorticitySampleH: 0.02, // finite-difference step for curlAt()
  wakeJitterMax: 1.1, // world units/second of random velocity noise at
  // full wake immersion (wakes.js wakeImmersionAt() == 1)
  surfaceDimRadiusCells: 4, // radius (grid cells) over which each point's
  // recorded `proximity` value ramps 0 (clear) -> 1 (at the surface) --
  // rendering-only (streamlineRenderer.js dims colour/alpha near the body),
  // unrelated to the clamp above

  // Optional, off unless a scene's rakes.json `trace` block sets them (the F1 sets none, so it traces exactly as
  // before). A scene merges its `trace` block over these defaults in buildAllStreamlines().
  upstreamStopAlong: null, // fixed upstream start plane (alongFlow fraction, -1 = the nose) for EVERY line, instead
  // of the per-seed upstreamRunCarLengths run
  downstreamStopAlong: null, // fixed downstream end plane (alongFlow fraction), instead of halfLength + downstreamMargin
  maxTurnPerStepDeg: 0, // > 0: a step whose direction would turn by more than this is subdivided, wherever it is --
  // a tight vortex turns ~35 degrees per plain step, which reads as a polygon (and fails assertion 6)
  maxTurnSubSteps: 8, // ceiling for that subdivision
};

// Addendum to Phase 3.7: even with vectorField.js's soft repulsion making
// the hard SDF clamp rare, a tight-hugging line can still show residual
// sawtooth from the clamp's discrete corrections. Post-process smoothing
// removes it. Laplacian rather than Chaikin: it keeps every array
// (speeds/coherence/proximity/vorticity/disturbance/timeOfFlight) aligned
// index-for-index with `positions` -- Chaikin's corner-cutting changes the
// point count, which would orphan those parallel per-point arrays.
export const SMOOTHING_CONFIG = {
  enabled: true,
  maxSegmentWorld: 0.005, // before smoothing, any segment longer than this is
  // subdivided (per-point arrays linearly interpolated). A line wrapping the
  // standoff contour of a plate edge has a turning radius of one standoff
  // (~0.0145); at 5mm per segment that is ~20 degrees per segment, under
  // assertion 6's 30. Raw trace steps run up to ~13mm, which cannot bend
  // that tightly no matter how well they are smoothed.
  subdivideWithinCells: 2.5, // only segments this close to the body are subdivided
  finalStandoffCells: 0.15, // the LAST correction (the one assertion 4 relies
  // on) uses this smaller standoff; the rounds before it use the full one, so
  // by the end almost nothing is left for the final pass to move, and it
  // adds no jitter of its own
  rounds: 3, // correct -> smooth -> correct, repeated: each smoothing pass
  // can pull a hugging line toward the body, each correction restores the
  // standoff, and a couple of rounds settle both
  passes: 4, // Laplacian passes per round
  alpha: 0.5, // 0 = untouched, 1 = fully replaced by the neighbour average, per pass
};

// Two culling rules applied after tracing, both reusing quantities the
// trace already recorded (no new computation) -- see buildAllStreamlines().
export const CULL_CONFIG = {
  enabled: true,
  minMaxDeviationFraction: 0.15, // "uninteresting" cull: a line whose
  // largest departure from freestream velocity anywhere along its path
  // never exceeds this fraction of freestream speed is one that never
  // shows anything a plain background line wouldn't -- drop it. Measured
  // against the real field (seeding.js's surface-anchored seeds mean even
  // the least eventful line still deviates >=13% right at its own origin):
  // the observed distribution runs ~0.13 (min) to ~2.1 (max), median ~0.56
  // -- 0.15 sits just above the bottom of that range, catching only the
  // few percent that stay closest to undisturbed freestream everywhere
  maxClampFireCount: 100, // "misbehaving" cull: a line whose SDF safety
  // clamp fired more times than this during tracing was routed badly by
  // the field -- drop it rather than show the visible correction
  // artifacts. Re-measured after the occupancy grid became a solid fill
  // instead of a hollow shell (see bake_occupancy_grid.py): clamp-fire-
  // count per line is now bimodal, not a single skewed tail -- most lines
  // cluster under ~50, but a substantial ~25-30% cluster from ~300 up to
  // 2000+, because guide curves tuned/validated against the OLD (leaky)
  // grid now legitimately hit real, solid geometry the old grid simply
  // didn't represent. 100 sits just above the well-behaved cluster. That
  // second cluster is expected fallout of the grid fix, not something
  // this threshold should paper over -- it means the guide curves
  // themselves need retuning against the corrected grid, deliberately
  // left for a separate pass (the author: "do not adjust guide curves until
  // the grid and the assertion are correct")
  maxTurnDegrees: 30, // a line that still turns sharper than this between
  // consecutive segments outside a wake after correction + smoothing (the
  // rule assertion 6 enforces) is dropped like any other misbehaving line
  maxSeedOffsetCells: 3.2, // ceiling for the per-group seed offset (occupancy cells) top-up may escalate to
  seedOffsetStepCells: 0.4, // how much further off the surface a failing group's replacement seeds start, per round
  maxTopUpRounds: 14, // bounded retry budget for regenerating culled lines
  // back up to the pre-cull target count -- raised from 4 now that a much
  // larger fraction of candidates fail the clamp-count rule (see above),
  // so top-up needs more rounds to have a fair chance of reaching target;
  // still bounded to avoid looping forever in a truly degenerate config
};

function surfaceProximityAt(x, y, z, sdf, radiusWorld, tmp) {
  if (!sdf || !sdf.isNear(x, y, z)) return 0;
  const d = sdf.sampleAt(x, y, z, tmp);
  return Math.max(0, Math.min(1, 1 - d / radiusWorld));
}

function distanceAt(sdf, p, tmp) {
  return sdf.isNear(p[0], p[1], p[2]) ? sdf.sampleAt(p[0], p[1], p[2], tmp) : Infinity;
}

/**
 * The one correction every stage uses (trace-time and post-smoothing): if the
 * point is closer than `standoff` to the surface -- or inside it -- move it out
 * along the interpolated SDF gradient by (standoff - distance), i.e. the
 * penetration depth plus the standoff. Repeated a few times because the
 * gradient is only locally exact. Mutates `p` (3-element array). Returns the
 * distance the point had BEFORE the correction (so callers can classify how
 * deep the step landed).
 *
 * `refN` (optional unit vector) is the outward direction at a point known to
 * be clear -- the previous accepted point, or a point's own pre-smoothing
 * position. A thin sheet (wing element, endplate) is a ridge of the distance
 * field that one lattice cell cannot resolve: a step that crosses its
 * mid-plane lands in a cell whose gradient points the OTHER way, and pushing
 * along it would carry the point through the sheet. If the sampled gradient
 * disagrees with `refN` (dot < 0) the point has crossed such a ridge, so the
 * push uses `refN` instead -- it stays on the side it came from.
 *
 * `maxTotal` caps how far the point may be carried in total: a correction is
 * a nudge of order one standoff, never a relocation. A point that would need
 * more is left for the caller to handle (see resolveStep).
 */
function pushToStandoff(sdf, p, standoff, maxIterations, tmp, refN = null, maxTotal = Infinity) {
  let first = null;
  let moved = 0;
  for (let it = 0; it < maxIterations; it++) {
    if (!sdf.isNear(p[0], p[1], p[2])) break;
    const d = sdf.sampleAt(p[0], p[1], p[2], tmp);
    if (first === null) first = d;
    if (d >= standoff * 0.98) break;
    let nx = tmp[1], ny = tmp[2], nz = tmp[3];
    if (nx === 0 && ny === 0 && nz === 0) break;
    if (refN && nx * refN[0] + ny * refN[1] + nz * refN[2] < 0) { nx = refN[0]; ny = refN[1]; nz = refN[2]; }
    const push = Math.min(standoff - d, maxTotal - moved);
    if (push <= 0) break;
    moved += push;
    p[0] += nx * push; p[1] += ny * push; p[2] += nz * push;
  }
  return first === null ? Infinity : first;
}

/** Classic 4th-order Runge-Kutta step. `velocityFn` already encodes the trace direction (see traceDirection). Writes the new position into `out`; `k1` also ends up holding the (signed) velocity AT the step's start, reused by the caller for speed/colour. */
function rk4Step(velocityFn, x, y, z, dt, k1, k2, k3, k4, out) {
  velocityFn(x, y, z, k1);
  velocityFn(x + k1[0] * dt / 2, y + k1[1] * dt / 2, z + k1[2] * dt / 2, k2);
  velocityFn(x + k2[0] * dt / 2, y + k2[1] * dt / 2, z + k2[2] * dt / 2, k3);
  velocityFn(x + k3[0] * dt, y + k3[1] * dt, z + k3[2] * dt, k4);
  out[0] = x + (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
  out[1] = y + (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
  out[2] = z + (dt / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
  return out;
}

/**
 * Traces one direction (sign = +1 forward, -1 backward) from `seed` through
 * `field`, recording position/speed/coherence/proximity/vorticity/
 * disturbance/time-of-flight at every (sub-)step, and applying the SDF
 * safety clamp whenever a step's segment would otherwise end inside
 * occupied geometry.
 *
 * @returns {{ positions:number[], speeds:number[], coherence:number[], proximity:number[], vorticity:number[], disturbance:number[], timeOfFlight:number[], clampFireCount:number, subStepCount:number }}
 */
function traceDirection(seed, domain, field, sdf, wakes, cfg, sign) {
  const maxStepWorld = cfg.cellWorld * cfg.nearSurfaceStepFraction;
  const standoff = cfg.standoffCells * cfg.cellWorld;
  const maxPush = standoff * 2;
  const proxRadius = cfg.surfaceDimRadiusCells * cfg.cellWorld;
  // Backward stop is relative to the SEED's own travelled position, not a
  // fixed world position -- see upstreamRunCarLengths above.
  const seedTravelled = (seed.x - domain.originX) * domain.dirX + (seed.y - domain.originY) * domain.dirY + (seed.z - domain.originZ) * domain.dirZ;
  let stopThreshold = sign > 0
    ? (domain.halfLength + domain.downstreamMargin)
    : (seedTravelled - domain.halfLength * 2 * cfg.upstreamRunCarLengths);
  if (sign > 0 && cfg.downstreamStopAlong != null) stopThreshold = cfg.downstreamStopAlong * domain.halfLength;
  if (sign < 0 && cfg.upstreamStopAlong != null) stopThreshold = cfg.upstreamStopAlong * domain.halfLength;
  const maxTurnCos = cfg.maxTurnPerStepDeg > 0 ? Math.cos((cfg.maxTurnPerStepDeg * Math.PI) / 180) : null;
  const turnProbe = new Float64Array(3);
  const freestream = field.freestream;
  const localFreestream = new Float64Array(3);
  const terminals = field.terminals || [];

  function velocityFn(x, y, z, out) {
    field.velocityAt(x, y, z, out);
    if (sign < 0) { out[0] = -out[0]; out[1] = -out[1]; out[2] = -out[2]; }
    return out;
  }

  let x = seed.x, y = seed.y, z = seed.z;
  const positions = [x, y, z];
  const speeds = [];
  const coherence = [];
  const proximity = [];
  const vorticity = [];
  const disturbance = [];
  const timeOfFlight = [0];

  const k1 = new Float64Array(3), k2 = new Float64Array(3), k3 = new Float64Array(3), k4 = new Float64Array(3), cand = new Float64Array(3);
  const curlOut = new Float64Array(3), curlScratch = new Float64Array(3);
  const fieldV = new Float64Array(3);
  const sdfTmp = new Float64Array(4);
  const candP = [0, 0, 0];
  const refBuf = [0, 0, 0];

  function recordAt(px, py, pz, speed, coh) {
    speeds.push(speed);
    coherence.push(coh);
    proximity.push(surfaceProximityAt(px, py, pz, sdf, proxRadius, sdfTmp));
    curlAt(field, px, py, pz, cfg.vorticitySampleH, curlOut, curlScratch);
    vorticity.push(Math.hypot(curlOut[0], curlOut[1], curlOut[2]));
    // |V - freestream|: how much this point differs from undisturbed
    // uniform flow -- 0 far from any primitive, large near one. Drives
    // streamlineRenderer.js's "far field nearly invisible" (PHASE-3.6.md
    // section 6), using a quantity the field already produces.
    field.velocityAt(px, py, pz, fieldV);
    const fs = field.freestreamAt ? field.freestreamAt(px, py, pz, localFreestream) : freestream; // cornering: the local arc
    disturbance.push(Math.hypot(fieldV[0] - fs[0], fieldV[1] - fs[1], fieldV[2] - fs[2]));
    // PHASE-3.7 section 1 / assertion 5: independently re-check the
    // invariant at this real traced point (not just trust that
    // vectorField.js applied it correctly) -- the physical field's own
    // streamwise component must not be negative outside a declared wake.
    // field.velocityAt() already clamps this internally, so this should
    // always come out false; it exists to CATCH a regression (e.g. a
    // future primitive/guide-curve path that bypasses the clamp), which is
    // the entire point of a dedicated assertion rather than trusting the
    // implementation.
    const immersionHere = wakeImmersionAt(wakes, px, py, pz);
    if (immersionHere <= FLOW_INVARIANT_CONFIG.wakeImmersionThreshold &&
        streamwiseComponent(fieldV, domain) < -1e-6) {
      reversalCount++;
    }
  }

  field.velocityAt(x, y, z, k1);
  recordAt(x, y, z, Math.hypot(k1[0], k1[1], k1[2]), 1);

  let t = 0;
  let stopped = false;
  let clampFireCount = 0;
  let subStepCount = 0;
  let reversalCount = 0;
  let stalled = false;

  for (let step = 0; step < cfg.maxSteps && !stopped; step++) {
    const nearSurface = !!(sdf && sdf.isNear(x, y, z));
    velocityFn(x, y, z, k1);
    const speedEstimate = Math.hypot(k1[0], k1[1], k1[2]);

    let subSteps = 1;
    if (nearSurface) {
      const stepWorld = speedEstimate * cfg.stepTime;
      if (stepWorld > maxStepWorld) subSteps = Math.min(cfg.maxSubSteps, Math.ceil(stepWorld / maxStepWorld));
    }
    if (maxTurnCos !== null && speedEstimate > 1e-9) {
      // direction one full step ahead vs. here: the angle the step would turn through
      velocityFn(x + k1[0] * cfg.stepTime, y + k1[1] * cfg.stepTime, z + k1[2] * cfg.stepTime, turnProbe);
      const s2 = Math.hypot(turnProbe[0], turnProbe[1], turnProbe[2]);
      if (s2 > 1e-9) {
        const c = Math.max(-1, Math.min(1, (k1[0] * turnProbe[0] + k1[1] * turnProbe[1] + k1[2] * turnProbe[2]) / (speedEstimate * s2)));
        if (c < maxTurnCos) subSteps = Math.max(subSteps, Math.min(cfg.maxTurnSubSteps, Math.ceil(Math.acos(c) / Math.acos(maxTurnCos))));
      }
    }
    const subDt = cfg.stepTime / subSteps;

    for (let sub = 0; sub < subSteps; sub++) {
      subStepCount++;
      rk4Step(velocityFn, x, y, z, subDt, k1, k2, k3, k4, cand);
      const localSpeed = Math.hypot(k1[0], k1[1], k1[2]); // magnitude is direction-agnostic
      let nx = cand[0], ny = cand[1], nz = cand[2];

      const travelled = (nx - domain.originX) * domain.dirX + (ny - domain.originY) * domain.dirY + (nz - domain.originZ) * domain.dirZ;
      let coh = 1;
      const immersion = wakeImmersionAt(wakes, nx, ny, nz);
      if (immersion > 0) {
        coh = 1 - immersion;
        const jitterMag = cfg.wakeJitterMax * immersion * subDt;
        nx += (Math.random() * 2 - 1) * jitterMag;
        ny += (Math.random() * 2 - 1) * jitterMag;
        nz += (Math.random() * 2 - 1) * jitterMag;
      }

      if (sdf) {
        candP[0] = nx; candP[1] = ny; candP[2] = nz;
        let refN = null;
        if (sdf.isNear(x, y, z)) {
          sdf.sampleAt(x, y, z, sdfTmp);
          if (sdfTmp[1] !== 0 || sdfTmp[2] !== 0 || sdfTmp[3] !== 0) { refN = refBuf; refN[0] = sdfTmp[1]; refN[1] = sdfTmp[2]; refN[2] = sdfTmp[3]; }
        }
        const dBefore = pushToStandoff(sdf, candP, standoff, cfg.standoffMaxIterations, sdfTmp, refN, maxPush);
        if (dBefore < standoff * cfg.clampFireDepthFraction) clampFireCount++;
        if (distanceAt(sdf, candP, sdfTmp) < standoff * 0.5) {
          // The nudge was not enough (a corner, or a ridge the gradient
          // mislabels): slide instead. Drop the part of the step heading INTO
          // the surface as seen from the last clear point, then push out from
          // there -- the standard smooth collision response, still a
          // continuous function of position.
          let dx = nx - x, dy = ny - y, dz = nz - z;
          if (refN) {
            const inward = dx * refN[0] + dy * refN[1] + dz * refN[2];
            if (inward < 0) { dx -= inward * refN[0]; dy -= inward * refN[1]; dz -= inward * refN[2]; }
          }
          candP[0] = x + dx; candP[1] = y + dy; candP[2] = z + dz;
          pushToStandoff(sdf, candP, standoff, cfg.standoffMaxIterations, sdfTmp, refN, maxPush);
          if (distanceAt(sdf, candP, sdfTmp) < standoff * 0.25) { candP[0] = x; candP[1] = y; candP[2] = z; } // hold this sub-step; a line pinned like this is culled by the stall check
        }
        nx = candP[0]; ny = candP[1]; nz = candP[2];
      }

      x = nx; y = ny; z = nz;
      t += sign * subDt;
      positions.push(x, y, z);
      recordAt(x, y, z, localSpeed, coh);
      timeOfFlight.push(t);

      const nPts = positions.length / 3;
      if (nPts > cfg.stallWindow + 1) {
        const q = (nPts - 1 - cfg.stallWindow) * 3;
        if (Math.hypot(x - positions[q], y - positions[q + 1], z - positions[q + 2]) < cfg.stallMinTravel) { stalled = true; stopped = true; break; }
      }

      if (sign > 0 ? travelled > stopThreshold : travelled < stopThreshold) { stopped = true; break; }
      if (insideTerminal(terminals, x, y, z)) { stopped = true; break; } // drawn into an intake / out of an exhaust: a clean end, not a stall
    }
  }

  return { positions, speeds, coherence, proximity, vorticity, disturbance, timeOfFlight, clampFireCount, subStepCount, reversalCount, stalled };
}

/**
 * Traces one continuous line through `seed` in both directions -- backward
 * to its upstream origin, forward to its downstream wake -- joined so the
 * seed sits in the middle, not at either end.
 *
 * @param {{x:number,y:number,z:number}} seed
 * @param {ReturnType<import('./domain.js').domainFromBounds>} domain
 * @param {ReturnType<import('./vectorField.js').createVectorField>} field
 * @param {import('./sdf.js').Sdf|null} sdf
 * @param {ReturnType<import('./wakes.js').buildWakes>} wakes
 * @param {typeof STREAMLINE_CONFIG} cfg
 */
export function traceBidirectional(seed, domain, field, sdf, wakes, cfg = STREAMLINE_CONFIG) {
  const back = traceDirection(seed, domain, field, sdf, wakes, cfg, -1);
  const fwd = traceDirection(seed, domain, field, sdf, wakes, cfg, +1);

  const nBack = back.positions.length / 3;
  const positions = [];
  const speeds = [];
  const coherence = [];
  const proximity = [];
  const vorticity = [];
  const disturbance = [];
  const timeOfFlight = [];

  // Skip back's own index 0 -- it's the seed itself, which fwd's index 0
  // already provides (both traceDirection() calls start from the same seed).
  for (let i = nBack - 1; i >= 1; i--) {
    positions.push(back.positions[i * 3], back.positions[i * 3 + 1], back.positions[i * 3 + 2]);
    speeds.push(back.speeds[i]);
    coherence.push(back.coherence[i]);
    proximity.push(back.proximity[i]);
    vorticity.push(back.vorticity[i]);
    disturbance.push(back.disturbance[i]);
    timeOfFlight.push(back.timeOfFlight[i]);
  }
  for (let i = 0; i < fwd.positions.length / 3; i++) {
    positions.push(fwd.positions[i * 3], fwd.positions[i * 3 + 1], fwd.positions[i * 3 + 2]);
    speeds.push(fwd.speeds[i]);
    coherence.push(fwd.coherence[i]);
    proximity.push(fwd.proximity[i]);
    vorticity.push(fwd.vorticity[i]);
    disturbance.push(fwd.disturbance[i]);
    timeOfFlight.push(fwd.timeOfFlight[i]);
  }

  return {
    positions: Float32Array.from(positions),
    speeds: Float32Array.from(speeds),
    coherence: Float32Array.from(coherence),
    proximity: Float32Array.from(proximity),
    vorticity: Float32Array.from(vorticity),
    disturbance: Float32Array.from(disturbance),
    timeOfFlight: Float32Array.from(timeOfFlight),
    clampFireCount: back.clampFireCount + fwd.clampFireCount,
    subStepCount: back.subStepCount + fwd.subStepCount,
    reversalCount: back.reversalCount + fwd.reversalCount,
    stalled: back.stalled || fwd.stalled,
  };
}

/** One Laplacian smoothing pass: each interior point moves toward its two neighbours' average by `alpha`; endpoints are left untouched (they're the line's actual upstream/downstream extent, not sawtooth). Returns a NEW Float32Array -- does not mutate `positions`. */
function laplacianPass(positions, alpha) {
  const n = positions.length / 3;
  const out = positions.slice();
  for (let i = 1; i < n - 1; i++) {
    const i3 = i * 3, p3 = i3 - 3, x3 = i3 + 3;
    out[i3] = positions[i3] + alpha * ((positions[p3] + positions[x3]) / 2 - positions[i3]);
    out[i3 + 1] = positions[i3 + 1] + alpha * ((positions[p3 + 1] + positions[x3 + 1]) / 2 - positions[i3 + 1]);
    out[i3 + 2] = positions[i3 + 2] + alpha * ((positions[p3 + 2] + positions[x3 + 2]) / 2 - positions[i3 + 2]);
  }
  return out;
}

function smoothPositions(positions, passes, alpha) {
  let cur = positions;
  for (let p = 0; p < passes; p++) cur = laplacianPass(cur, alpha);
  return cur;
}

/**
 * Pushes every point of `positions` (mutated) out to the standoff. `tracedPositions`
 * are the same points before smoothing: each one's outward direction there is
 * the same-side reference for its push (see pushToStandoff), and a point that
 * smoothing dragged somewhere a bounded nudge cannot rescue is blended back
 * toward its own traced position until it clears -- a continuous retreat,
 * not a jump to a neighbour.
 */
function correctAllPoints(positions, sdf, standoff, maxIterations, tracedPositions) {
  const tmp = new Float64Array(4);
  const p = [0, 0, 0];
  const ref = [0, 0, 0];
  const n = positions.length / 3;
  const maxPush = standoff * 2;
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    let refN = null;
    if (sdf.isNear(tracedPositions[i3], tracedPositions[i3 + 1], tracedPositions[i3 + 2])) {
      sdf.sampleAt(tracedPositions[i3], tracedPositions[i3 + 1], tracedPositions[i3 + 2], tmp);
      if (tmp[1] !== 0 || tmp[2] !== 0 || tmp[3] !== 0) { ref[0] = tmp[1]; ref[1] = tmp[2]; ref[2] = tmp[3]; refN = ref; }
    }
    const sx = positions[i3], sy = positions[i3 + 1], sz = positions[i3 + 2];
    let ok = false;
    for (let w = 0; w <= 1 && !ok; w += 0.25) {
      p[0] = sx + (tracedPositions[i3] - sx) * w;
      p[1] = sy + (tracedPositions[i3 + 1] - sy) * w;
      p[2] = sz + (tracedPositions[i3 + 2] - sz) * w;
      pushToStandoff(sdf, p, standoff, maxIterations, tmp, refN, maxPush);
      ok = distanceAt(sdf, p, tmp) >= standoff * 0.5;
      // also require staying on the traced point's side of any thin sheet
      if (ok && refN && (tmp[1] !== 0 || tmp[2] !== 0 || tmp[3] !== 0) && tmp[1] * refN[0] + tmp[2] * refN[1] + tmp[3] * refN[2] < 0) ok = false;
    }
    positions[i3] = p[0]; positions[i3 + 1] = p[1]; positions[i3 + 2] = p[2];
  }
}

const PER_POINT_ARRAYS = ['speeds', 'coherence', 'proximity', 'vorticity', 'disturbance', 'timeOfFlight'];

/**
 * Subdivides every segment longer than `maxLen` into equal pieces, linearly
 * interpolating positions and every per-point array so they stay index-aligned
 * with `positions`. Mutates `path`. Only segments within `nearWorld` of the
 * surface are subdivided (density costs render triangles, and it is only near
 * the body that a line has to bend tightly). Point density is what lets
 * smoothing and the standoff correction bend a line around a tight contour
 * without any one segment turning sharply.
 */
function subdividePath(path, maxLen, sdf, nearWorld) {
  const P = path.positions;
  const n = P.length / 3;
  const counts = new Uint16Array(n); // extra points to insert after point i
  const tmp = new Float64Array(4);
  let extra = 0;
  for (let i = 0; i < n - 1; i++) {
    const len = Math.hypot(P[i * 3 + 3] - P[i * 3], P[i * 3 + 4] - P[i * 3 + 1], P[i * 3 + 5] - P[i * 3 + 2]);
    let k = 0;
    if (len > maxLen) {
      const mx = (P[i * 3] + P[i * 3 + 3]) / 2, my = (P[i * 3 + 1] + P[i * 3 + 4]) / 2, mz = (P[i * 3 + 2] + P[i * 3 + 5]) / 2;
      // only near the body: away from it the long steps are smooth already
      if (!sdf || (sdf.isNear(mx, my, mz) && sdf.sampleAt(mx, my, mz, tmp) < nearWorld)) k = Math.min(60, Math.ceil(len / maxLen) - 1);
    }
    counts[i] = k;
    extra += k;
  }
  if (extra === 0) return path;
  const total = n + extra;
  const outP = new Float32Array(total * 3);
  const outArrays = {};
  for (const name of PER_POINT_ARRAYS) outArrays[name] = new Float32Array(total);
  let w = 0;
  for (let i = 0; i < n; i++) {
    outP[w * 3] = P[i * 3]; outP[w * 3 + 1] = P[i * 3 + 1]; outP[w * 3 + 2] = P[i * 3 + 2];
    for (const name of PER_POINT_ARRAYS) outArrays[name][w] = path[name][i];
    w++;
    for (let j = 1; j <= counts[i]; j++) {
      const t = j / (counts[i] + 1);
      outP[w * 3] = P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * t;
      outP[w * 3 + 1] = P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * t;
      outP[w * 3 + 2] = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * t;
      for (const name of PER_POINT_ARRAYS) outArrays[name][w] = path[name][i] + (path[name][i + 1] - path[name][i]) * t;
      w++;
    }
  }
  path.positions = outP;
  for (const name of PER_POINT_ARRAYS) path[name] = outArrays[name];
  return path;
}

/**
 * Post-trace polish: subdivide, then `rounds` x (correct -> Laplacian smooth),
 * ending on a correction.
 *
 * The correction before each smoothing means smoothing never averages in a
 * point inside the body; the one after undoes smoothing's inward pull on a
 * line hugging a convex surface. Both are the same continuous SDF push the
 * tracer uses -- there is no neighbour-snap or other discrete fallback. The
 * final correction is the last step, which is what keeps assertion 4 (zero
 * points on the real mesh).
 *
 * Mutates and returns `path`.
 */
function smoothPath(path, sdf, cfg, smoothCfg) {
  const standoff = cfg.standoffCells * cfg.cellWorld;
  subdividePath(path, smoothCfg.maxSegmentWorld, sdf, smoothCfg.subdivideWithinCells * cfg.cellWorld);
  const traced = path.positions;
  let positions = traced.slice();
  if (sdf) correctAllPoints(positions, sdf, standoff, cfg.standoffMaxIterations, traced);
  for (let round = 0; round < smoothCfg.rounds; round++) {
    positions = smoothPositions(positions, smoothCfg.passes, smoothCfg.alpha);
    if (sdf) correctAllPoints(positions, sdf, round === smoothCfg.rounds - 1 ? smoothCfg.finalStandoffCells * cfg.cellWorld : standoff, cfg.standoffMaxIterations, traced);
  }
  path.positions = positions;
  return path;
}

/** Largest |V - freestream| recorded anywhere along `path` -- what CULL_CONFIG.minMaxDeviationFraction is measured against. Reuses `disturbance`, already recorded per point at trace time (see traceDirection()'s recordAt()); nothing new is sampled. */
function maxDisturbance(path) {
  let m = 0;
  for (let i = 0; i < path.disturbance.length; i++) if (path.disturbance[i] > m) m = path.disturbance[i];
  return m;
}

/** Whether `path` fails either cull rule, evaluated independently (not short-circuited) so callers can tally a per-rule removed count even though a line failing both rules is only ever actually removed once. */
/** True if, outside any wake, two consecutive segments turn by more than `maxDegrees` -- the same rule tests/checks.js assertion 6 enforces. */
function hasSharpKink(path, wakes, maxDegrees) {
  const P = path.positions;
  const n = P.length / 3;
  const cosMax = Math.cos((maxDegrees * Math.PI) / 180);
  const thr = FLOW_INVARIANT_CONFIG.wakeImmersionThreshold;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = wakeImmersionAt(wakes, P[i * 3], P[i * 3 + 1], P[i * 3 + 2]) <= thr ? 1 : 0;
  for (let i = 1; i < n - 1; i++) {
    if (!out[i - 1] || !out[i] || !out[i + 1]) continue;
    const ax = P[i * 3] - P[i * 3 - 3], ay = P[i * 3 + 1] - P[i * 3 - 2], az = P[i * 3 + 2] - P[i * 3 - 1];
    const cx = P[i * 3 + 3] - P[i * 3], cy = P[i * 3 + 4] - P[i * 3 + 1], cz = P[i * 3 + 5] - P[i * 3 + 2];
    const la = Math.hypot(ax, ay, az), lc = Math.hypot(cx, cy, cz);
    if (la < 1e-9 || lc < 1e-9) continue;
    if ((ax * cx + ay * cy + az * cz) / (la * lc) < cosMax) return true;
  }
  return false;
}

/**
 * True if any final (smoothed, corrected) point is still inside the distance field's surface: the corrections could
 * not clear it (a line squeezed between two thin parts, e.g. a suspension arm and the bodywork). Such a line is
 * dropped and replaced rather than shown touching the car. Opt-in (culling.dropInsideSurface): the cornering set uses
 * it (cornering.js); the straight-line set, baked before it existed, does not.
 */
function endsInsideSurface(path, sdf) {
  if (!sdf) return false;
  const P = path.positions, tmp = new Float64Array(4);
  for (let i = 0; i < P.length; i += 3) {
    if (sdf.isNear(P[i], P[i + 1], P[i + 2]) && sdf.sampleAt(P[i], P[i + 1], P[i + 2], tmp) < 0) return true;
  }
  return false;
}

function evaluateCull(path, cullCfg, freestreamSpeed, wakes, sdf = null) {
  const failsDeviation = maxDisturbance(path) < cullCfg.minMaxDeviationFraction * freestreamSpeed;
  const failsClamp = path.clampFireCount > cullCfg.maxClampFireCount || path.stalled === true ||
    (cullCfg.maxTurnDegrees > 0 && hasSharpKink(path, wakes, cullCfg.maxTurnDegrees)) || (cullCfg.dropInsideSurface === true && endsInsideSurface(path, sdf));
  return { failsDeviation, failsClamp, culled: failsDeviation || failsClamp };
}

/**
 * Filters `paths` by CULL_CONFIG's two rules -- "uninteresting" (never
 * strays far from freestream anywhere along its length) and "misbehaving"
 * (the SDF clamp fired on it more than the configured threshold, the mark
 * of a line the field routed badly). Returns the survivors plus a
 * per-rule removed count.
 */
function cullPaths(paths, cullCfg, freestreamSpeed, wakes, sdf = null) {
  if (!cullCfg.enabled) return { survivors: paths, deviationRemoved: 0, clampRemoved: 0 };
  let deviationRemoved = 0, clampRemoved = 0;
  const survivors = [];
  for (const path of paths) {
    const { failsDeviation, failsClamp, culled } = evaluateCull(path, cullCfg, freestreamSpeed, wakes, sdf);
    if (failsDeviation) deviationRemoved++;
    if (failsClamp) clampRemoved++;
    if (!culled) survivors.push(path);
  }
  return { survivors, deviationRemoved, clampRemoved };
}

/**
 * Builds the vector field, scatters surface-anchored seeds (seeding.js,
 * scored by velocity gradient + vorticity), and traces each one in both
 * directions.
 *
 * @param {ReturnType<import('./domain.js').domainFromBounds>} domain
 * @param {import('./sdf.js').Sdf|null} sdf
 * @param {{ flowSpeed: number }} particleConfig PARTICLE_CONFIG (shared base speed)
 * @param {{ groups: object[], primitives: object[], wakes: object[], seeding: object }} rakesConfig data/rakes.json
 * @param {Partial<typeof STREAMLINE_CONFIG>} [traceOverrides]
 * @returns {{ paths: ReturnType<typeof traceBidirectional>[], clampFireCount: number, subStepCount: number, clampFireRate: number, reversalCount: number, requestedLineCount: number, deviationCulled: number, clampCulled: number, topUpAdded: number }}
 */
/**
 * Terminals (data/rakes.json `terminals`, optional): spheres where a line ends cleanly instead of running on -- an
 * engine's fan face, so air drawn into the intake ends there, and just inside its exhaust, so the jet starts there.
 * `anchor` uses the usual fractional convention, `radius` is in world units, `mirror: true` covers both sides.
 */
export function buildTerminals(domain, entries) {
  return entries.flatMap(expandMirrored).map((e) => ({ ...anchorToWorld(domain, e.anchor), r2: e.radius * e.radius, name: e.name }));
}

function insideTerminal(terminals, x, y, z) {
  for (const t of terminals) {
    const dx = x - t.x, dy = y - t.y, dz = z - t.z;
    if (dx * dx + dy * dy + dz * dz < t.r2) return true;
  }
  return false;
}

export function buildAllStreamlines(domain, sdf, particleConfig, rakesConfig, traceOverrides = {}) {
  const cfg = { ...STREAMLINE_CONFIG, ...(rakesConfig.trace || {}), ...traceOverrides };
  const smoothCfg = { ...SMOOTHING_CONFIG, ...(rakesConfig.smoothing || {}) };
  const cullCfg = { ...CULL_CONFIG, ...(rakesConfig.culling || {}) };
  const wakes = buildWakes(domain, rakesConfig.wakes || []);
  // wakes built BEFORE the field: the field needs them to apply the section
  // 1 invariant ("streamwise never negative outside a declared wake")
  // internally, in vectorField.js's velocityAt() itself.
  const field = createVectorField(
    domain, particleConfig, rakesConfig.primitives || [], rakesConfig.guideCurves || [],
    wakes, {}, sdf, rakesConfig.fieldRepulsion || {}, cfg.cellWorld, rakesConfig.yaw || null
  );
  field.terminals = buildTerminals(domain, rakesConfig.terminals || []);
  const seeds = generateSeeds(domain, sdf, field, rakesConfig, rakesConfig.seeding);

  let clampFireCount = 0;
  let subStepCount = 0;
  let reversalCount = 0;

  function traceOne(seed) {
    const path = traceBidirectional(seed, domain, field, sdf, wakes, cfg);
    path.group = seed.group;
    if (smoothCfg.enabled) smoothPath(path, sdf, cfg, smoothCfg);
    clampFireCount += path.clampFireCount;
    subStepCount += path.subStepCount;
    reversalCount += path.reversalCount;
    return path;
  }

  const tracedPaths = seeds.map(traceOne);
  const targetCount = tracedPaths.length; // the pre-cull line count -- what culling tops back up to

  let { survivors: paths, deviationRemoved, clampRemoved } = cullPaths(tracedPaths, cullCfg, particleConfig.flowSpeed, wakes, sdf);
  let topUpAdded = 0;

  if (cullCfg.enabled) {
    // Refill each group to ITS OWN target -- a replacement for a culled floor
    // line is another floor line, never a sidepod one. A group that keeps
    // failing starts its replacement seeds a little further from the surface
    // each round (rather than relaxing the cull).
    const seedCfg = { ...SEEDING_CONFIG, ...(rakesConfig.seeding || {}) };
    const targets = computeGroupTargets(rakesConfig, rakesConfig.seeding || {});
    const avoid = seeds.slice(); // seeds already placed (culled or not)
    const offsets = {}; // group -> surfaceOffsetCells for its next replacement seeds
    const have = {};
    for (const path of paths) have[path.group] = (have[path.group] || 0) + 1;
    for (let round = 0; round < cullCfg.maxTopUpRounds; round++) {
      const need = {};
      let any = false;
      for (const [name, target] of Object.entries(targets)) {
        const deficit = target - (have[name] || 0);
        if (deficit > 0) { need[name] = deficit; any = true; }
      }
      if (!any) break;
      for (const name of Object.keys(need)) {
        offsets[name] = Math.min(cullCfg.maxSeedOffsetCells, (offsets[name] ?? seedCfg.surfaceOffsetCells) + (round === 0 ? 0 : cullCfg.seedOffsetStepCells));
      }
      const newSeeds = generateTopUpSeeds(domain, sdf, rakesConfig, need, avoid, offsets, rakesConfig.seeding || {});
      if (newSeeds.length === 0) break;
      for (const seed of newSeeds) {
        avoid.push(seed);
        const path = traceOne(seed);
        const { failsDeviation, failsClamp, culled } = evaluateCull(path, cullCfg, particleConfig.flowSpeed, wakes, sdf);
        if (failsDeviation) deviationRemoved++;
        if (failsClamp) clampRemoved++;
        if (!culled) {
          paths.push(path);
          have[path.group] = (have[path.group] || 0) + 1;
          topUpAdded++;
        }
      }
    }
  }

  return {
    paths, clampFireCount, subStepCount, reversalCount,
    clampFireRate: subStepCount > 0 ? clampFireCount / subStepCount : 0,
    requestedLineCount: targetCount,
    deviationCulled: deviationRemoved,
    clampCulled: clampRemoved,
    topUpAdded,
  };
}

/**
 * Lighter-mode thinning: Ramer-Douglas-Peucker on the polyline, dropping every
 * point whose removal keeps the line within `tolerance` of the straight chord
 * (so nearly-straight stretches collapse to their end points while bends keep
 * their points). The per-point arrays are filtered with the same indices.
 * Returns a NEW path object; the input is untouched.
 */
export function simplifyPath(path, tolerance) {
  const P = path.positions;
  const n = P.length / 3;
  if (n <= 2) return path;
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const dx = P[b * 3] - ax, dy = P[b * 3 + 1] - ay, dz = P[b * 3 + 2] - az;
    const len2 = dx * dx + dy * dy + dz * dz || 1e-12;
    let worst = 0, worstI = -1;
    for (let i = a + 1; i < b; i++) {
      const px = P[i * 3] - ax, py = P[i * 3 + 1] - ay, pz = P[i * 3 + 2] - az;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / len2));
      const ex = px - dx * t, ey = py - dy * t, ez = pz - dz * t;
      const d = Math.hypot(ex, ey, ez);
      if (d > worst) { worst = d; worstI = i; }
    }
    if (worst > tolerance && worstI > 0) { keep[worstI] = 1; stack.push([a, worstI], [worstI, b]); }
  }
  const idx = [];
  for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
  const out = { ...path, positions: new Float32Array(idx.length * 3) };
  idx.forEach((i, k) => { out.positions[k * 3] = P[i * 3]; out.positions[k * 3 + 1] = P[i * 3 + 1]; out.positions[k * 3 + 2] = P[i * 3 + 2]; });
  for (const name of PER_POINT_ARRAYS) out[name] = Float32Array.from(idx, (i) => path[name][i]);
  return out;
}
