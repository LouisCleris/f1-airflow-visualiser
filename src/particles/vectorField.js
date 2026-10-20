// Phase 3.7: the field is now built from AUTHORED guide curves first
// (guideCurves.js), not analytic primitives alone -- the primitives
// (vortex filaments + low-strength source/sinks; doublets removed
// entirely, see primitives.js) add local swirl/pull ON TOP of the guide
// curves' blended direction+speed, and section 1's invariant
// (flowInvariant.js) is applied to the final sum regardless of what
// produced it. That ordering matters: guide curves establish where the air
// actually goes (replacing doublets, which can't represent thin
// multi-element geometry like a front wing and whose combined field could
// produce closed recirculation loops), primitives add texture on top, and
// the invariant is what actually guarantees no loop can close, baked into
// velocityAt() itself so every caller (forward trace, backward trace,
// vorticity's finite-difference samples, seed scoring) automatically gets
// an invariant-respecting field with nothing to forget.
//
// The signed distance field (sdf.js) also drives a smooth no-penetration
// correction applied in streamlines.js, not something this field consults -- forward vs.
// backward integration are exact negatives of each other, no direction-
// dependent behaviour baked in here.
//
// Zero dependency on three.js/DOM, like the rest of src/particles/.

import { buildPrimitives, primitiveContributionAt } from './primitives.js';
import { buildGuideCurves, guideCurveVelocityAt } from './guideCurves.js';
import { wakeImmersionAt, wakeSpeedFactorAt } from './wakes.js';
import { applyFlowInvariant } from './flowInvariant.js';
import { cornerCentre } from './cornering.js';

// Addendum to Phase 3.7: the SDF safety clamp in streamlines.js was firing
// repeatedly along tight-hugging lines, producing visible sawtooth zigzags
// -- each firing is a hard, discontinuous correction, so a line that stays
// close enough to bodywork for long enough fires it over and over.
//
// First attempt (kept here as a note, not as the mechanism below) was an
// independent outward push added to velocity near a surface. Measured
// against the real field it made the clamp fire MORE often, not less
// (16.2% -> 19-20% at every strength tried): guide curves establish a
// tangential, surface-hugging direction on purpose, and an independent
// normal-outward vector fights that tangential component instead of
// cooperating with it, adding noise that RK4's four samples can disagree on
// in direction, not just magnitude.
//
// What actually needs to shrink is only the component of velocity heading
// INTO the surface -- the thing that makes the hard clamp fire in the first
// place. So this instead PROJECTS OUT (fades toward zero, never reverses)
// the inward part of the existing velocity as a point nears an occupied
// cell, leaving the tangential (hugging) part alone entirely. A line
// already curving away from the surface is untouched; one about to
// intersect it gets its approach softened before contact, over a few grid
// cells. Baked into the field itself (like the section 1 invariant) so
// every caller -- forward/backward trace, curl's finite differences, seed
// scoring -- gets it automatically. Does not replace the hard clamp (still
// the no-penetration guarantee of last resort) -- makes it rare instead of
// routine.
//
// Now driven by the true signed distance field (sdf.js), not the binary
// occupancy grid: the distance and the outward direction are the real
// distance to the real mesh and the interpolated field's own gradient, so the
// falloff below is a continuous function of position instead of a staircase
// in whole grid cells.
export const FIELD_REPULSION_CONFIG = {
  enabled: true,
  radiusCells: 3, // falloff distance in OCCUPANCY-grid cells (0.0289 world units each) -- "a few grid cells" per the author's ask
  pushCells: 1.0, // radius (occupancy cells) of the outward restoring term below
  pushStrength: 0.5, // outward speed at the surface, as a fraction of the
  // local speed; falls off as (1 - d/pushRadius)^2, so it is exactly zero
  // at pushCells and gentle just inside it. Cancelling the inward
  // component alone lets a line creep to the surface asymptotically; this
  // is what holds it a standoff away smoothly, as a force, rather than as
  // a per-step hard projection that chatters.
  strengthFraction: 1.0, // fraction of the inward-normal component removed
  // AT the surface (distance 0); falls off linearly to 0 by radiusCells away.
  // 1.0 = fully cancel inward motion at zero distance (never reverses it
  // into outward motion -- only ever removes, at most, exactly the inward
  // part that was there)
};

/**
 * @param {ReturnType<import('./domain.js').domainFromBounds>} domain
 * @param {{ flowSpeed: number }} particleConfig base flow speed (world
 *   units/second) -- reuses PARTICLE_CONFIG.flowSpeed so the streamline
 *   field and the wake particle field agree on a nominal speed.
 * @param {object[]} primitiveEntries data/rakes.json `primitives` array
 *   (vortex filaments + source/sinks only as of Phase 3.7 -- see
 *   primitives.js; doublets removed)
 * @param {object[]} [guideCurveEntries] data/rakes.json `guideCurves` array
 * @param {ReturnType<import('./wakes.js').buildWakes>} [wakes] resolved
 *   wake cones -- the invariant's "outside a declared wake region" test.
 *   Optional (defaults to none declared) so existing callers/tests that
 *   don't care about wakes still work.
 * @param {Partial<import('./flowInvariant.js').FLOW_INVARIANT_CONFIG>} [invariantOverrides]
 * @param {import('./sdf.js').Sdf|null} [sdf] baked signed distance field --
 *   enables the soft near-surface repulsion below when given; omitted
 *   entirely (no repulsion term) when null.
 * @param {number} [cellWorld] world size of one occupancy-grid cell, the unit
 *   `radiusCells` is expressed in
 * @param {Partial<typeof FIELD_REPULSION_CONFIG>} [repulsionOverrides]
 * @param {{ deg: number, exposedSpeedGain: number, shieldedSpeedLoss: number, cornerRadius?: number }|null} [yaw]
 *   cornering (cornering.js): the oncoming air arrives turned by `deg` from the car's right, and the speed along the
 *   exposed (right) and shielded (left) flanks is raised / lowered. With `cornerRadius` the oncoming air also moves in
 *   arcs about the corner's centre instead of straight lines (cornerFreestream below). null (the straight-line flow,
 *   the Falcon) leaves the field as it was.
 */
export function createVectorField(domain, particleConfig, primitiveEntries, guideCurveEntries = [], wakes = [], invariantOverrides = {}, sdf = null, repulsionOverrides = {}, cellWorld = 0.0289384, yaw = null) {
  const baseSpeed = particleConfig.flowSpeed;
  const freestream = yaw ? yawedFreestream(domain, baseSpeed, yaw.deg) : [domain.dirX * baseSpeed, domain.dirY * baseSpeed, domain.dirZ * baseSpeed];
  // the oncoming air at a point: the same everywhere, or (cornering) following the arcs of the corner
  const curved = yaw && yaw.cornerRadius ? cornerFreestream(domain, baseSpeed, yaw) : null;
  const local = new Float64Array(3);
  const freestreamAt = curved || ((x, y, z, out) => { out[0] = freestream[0]; out[1] = freestream[1]; out[2] = freestream[2]; return out; });
  const primitives = buildPrimitives(domain, primitiveEntries);
  const guideCurves = buildGuideCurves(domain, guideCurveEntries);
  const repulsionCfg = { ...FIELD_REPULSION_CONFIG, ...repulsionOverrides };
  const tmp = new Float64Array(3);
  const base = new Float64Array(3);
  const repS = new Float64Array(4);

  /**
   * Writes the field velocity at (x,y,z) into `out` and returns it. The
   * section 1 invariant is always applied before returning -- see module
   * header for why that lives here rather than in each caller.
   */
  function velocityAt(x, y, z, out) {
    guideCurveVelocityAt(guideCurves, x, y, z, curved ? curved(x, y, z, local) : freestream, base);
    let vx = base[0], vy = base[1], vz = base[2];
    for (const prim of primitives) {
      primitiveContributionAt(prim, x, y, z, tmp);
      vx += tmp[0]; vy += tmp[1]; vz += tmp[2];
    }
    if (sdf && repulsionCfg.enabled && sdf.isNear(x, y, z)) {
      const radius = Math.max(repulsionCfg.radiusCells, repulsionCfg.pushCells) * cellWorld;
      const d = sdf.sampleAt(x, y, z, repS);
      if (d < radius) {
        const u = Math.min(1, Math.max(0, d / radius));
        const rIn = repulsionCfg.radiusCells * cellWorld;
        const ui = Math.min(1, Math.max(0, d / rIn));
        const falloff = 1 - ui * ui * (3 - 2 * ui); // smoothstep: 1 at/below the surface, 0 at radiusCells, C1 between
        const pushRadius = repulsionCfg.pushCells * cellWorld;
        if (d < pushRadius && (repS[1] !== 0 || repS[2] !== 0 || repS[3] !== 0)) {
          const q = 1 - Math.max(0, d) / pushRadius;
          const push = repulsionCfg.pushStrength * q * q * Math.hypot(vx, vy, vz);
          vx += repS[1] * push; vy += repS[2] * push; vz += repS[3] * push;
        }
        const inward = vx * repS[1] + vy * repS[2] + vz * repS[3]; // negative = heading into the surface
        if (inward < 0) {
          const removal = -inward * repulsionCfg.strengthFraction * falloff; // only ever cancels the inward part, never reverses it
          vx += repS[1] * removal;
          vy += repS[2] * removal;
          vz += repS[3] * removal;
        }
      }
    }
    if (yaw) {
      const f = flankSpeedFactor(domain, yaw, x, y, z);
      vx *= f; vy *= f; vz *= f;
    }
    out[0] = vx; out[1] = vy; out[2] = vz;
    const immersion = wakeImmersionAt(wakes, x, y, z);
    applyFlowInvariant(out, domain, baseSpeed, immersion, invariantOverrides);
    const wakeFactor = wakeSpeedFactorAt(wakes, x, y, z); // air inside a wake is slower than the oncoming air
    if (wakeFactor < 1) { out[0] *= wakeFactor; out[1] *= wakeFactor; out[2] *= wakeFactor; }
    return out;
  }

  return { velocityAt, freestream, freestreamAt, primitiveCount: primitives.length, guideCurveCount: guideCurves.length };
}

/** The oncoming air turned by `deg` about the vertical: along the flow, leaning towards the car's left (-right). */
function yawedFreestream(domain, speed, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [(domain.dirX * c - domain.rightX * s) * speed, (domain.dirY * c - domain.rightY * s) * speed, (domain.dirZ * c - domain.rightZ * s) * speed];
}

/**
 * The oncoming air in a corner, seen from the car: solid-body rotation about the corner's centre (cornering.js
 * cornerCentre, carRadius from the car on its left, turned by the yaw). Each point moves along the circle through it,
 * in the sense that matches the yawed freestream at the car, at a speed proportional to its distance from the centre,
 * so the air on the outside of the car is a little faster than on the inside. Horizontal only: the vertical axis is
 * the corner's axis.
 */
function cornerFreestream(domain, speed, yaw) {
  const R = yaw.cornerRadius;
  const [cx, cy, cz] = cornerCentre(domain, { yawDeg: yaw.deg, carRadius: R });
  const ux = domain.upX, uy = domain.upY, uz = domain.upZ;
  const omega = speed / R;
  // sense of rotation: (up x r) at the car, against the yawed freestream there
  const at = yawedFreestream(domain, 1, yaw.deg);
  const r0x = domain.originX - cx, r0y = domain.originY - cy, r0z = domain.originZ - cz;
  const sense = Math.sign((uy * r0z - uz * r0y) * at[0] + (uz * r0x - ux * r0z) * at[1] + (ux * r0y - uy * r0x) * at[2]) || 1;
  return function freestreamAt(x, y, z, out) {
    let rx = x - cx, ry = y - cy, rz = z - cz;
    const h = rx * ux + ry * uy + rz * uz; // drop the vertical part: circles about the vertical axis through the centre
    rx -= h * ux; ry -= h * uy; rz -= h * uz;
    const k = sense * omega; // velocity = omega (up x r): tangential, |v| = omega |r|
    out[0] = k * (uy * rz - uz * ry); out[1] = k * (uz * rx - ux * rz); out[2] = k * (ux * ry - uy * rx);
    return out;
  };
}

function smoothstep(e0, e1, x) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }

/**
 * Cornering speed multiplier beside the car. Along each flank -- outboard of the chassis (|lateral| past ~0.55 of the
 * half-width), up to the top of the bodywork and out to about two half-widths -- the exposed side (lateral > 0, the
 * right) runs faster from the front wheels to the rear wheels, and the shielded side (the left) runs slower from the
 * sidepod inlet back into the lee behind the car. 1 everywhere else, so the nose, the wings and the floor keep their
 * straight-line speeds.
 */
function flankSpeedFactor(domain, yaw, x, y, z) {
  const rx = x - domain.originX, ry = y - domain.originY, rz = z - domain.originZ;
  const a = (rx * domain.dirX + ry * domain.dirY + rz * domain.dirZ) / domain.halfLength;
  const l = (rx * domain.rightX + ry * domain.rightY + rz * domain.rightZ) / (domain.carWidth / 2);
  const v = ry / domain.carHeight;
  const al = Math.abs(l);
  const flank = smoothstep(0.55, 0.95, al) * (1 - smoothstep(1.7, 2.6, al)) * (1 - smoothstep(0.85, 1.3, v));
  if (flank <= 0) return 1;
  if (l > 0) return 1 + yaw.exposedSpeedGain * flank * smoothstep(-0.75, -0.45, a) * (1 - smoothstep(0.65, 0.95, a));
  return 1 - yaw.shieldedSpeedLoss * flank * smoothstep(-0.45, -0.1, a) * (1 - smoothstep(1.8, 2.6, a));
}

/**
 * Vorticity omega = curl(V) at (x,y,z), by central finite differences on
 * the field itself (PHASE-3.6.md section 4: "a derivative of the field
 * that already exists... not a solver output"). Called once per RECORDED
 * trace point (see streamlines.js) -- at trace/build time, never per
 * rendered frame, since the field is steady and the geometry is static
 * once traced.
 *
 * @param {ReturnType<typeof createVectorField>} field
 * @param {number} h finite-difference step (world units)
 * @param {Float64Array} out 3-element scratch, mutated and returned
 * @param {Float64Array} [scratch] optional 3-element scratch for the
 *   repeated velocityAt() calls, to avoid allocating in a hot loop
 */
export function curlAt(field, x, y, z, h, out, scratch = new Float64Array(3)) {
  function comp(px, py, pz, i) { field.velocityAt(px, py, pz, scratch); return scratch[i]; }
  const dVzdy = (comp(x, y + h, z, 2) - comp(x, y - h, z, 2)) / (2 * h);
  const dVydz = (comp(x, y, z + h, 1) - comp(x, y, z - h, 1)) / (2 * h);
  const dVxdz = (comp(x, y, z + h, 0) - comp(x, y, z - h, 0)) / (2 * h);
  const dVzdx = (comp(x + h, y, z, 2) - comp(x - h, y, z, 2)) / (2 * h);
  const dVydx = (comp(x + h, y, z, 1) - comp(x - h, y, z, 1)) / (2 * h);
  const dVxdy = (comp(x, y + h, z, 0) - comp(x, y - h, z, 0)) / (2 * h);
  out[0] = dVzdy - dVydz;
  out[1] = dVxdz - dVzdx;
  out[2] = dVydx - dVxdy;
  return out;
}
