// Closed-form, divergence-free analytic primitives that add local texture
// on top of Phase 3.7's guide-curve field (guideCurves.js) -- swirl at wing
// tips and diffuser edges, and a gentle pull/push at the sidepod inlets and
// diffuser exit. Each is divergence-free everywhere EXCEPT its own
// singularity, which is what keeps a sum of them from crossing or bunching
// unphysically the way an arbitrary hand-tuned push field could.
//
// Two types remain as of Phase 3.7 (doublets removed -- see below):
//   - vortex: a lifting-surface tip vortex or a bluff-body shed vortex
//     (wing endplates, diffuser edges). A non-singular tangential
//     (curl-type) field -- automatically divergence-free everywhere,
//     including at its own core, so no clamp is needed for it. Its swirl
//     is capped by flowInvariant.js's global lateral+vertical magnitude
//     limit (applied to the FINAL summed field in vectorField.js), so it
//     can never close a recirculation loop on its own.
//   - sourceSink: a sidepod inlet (negative strength, pulls flow in) or a
//     diffuser exit (positive strength, pushes flow out), kept at low
//     strength per PHASE-3.7.md section 4.
//     V(r) = strength * r^ / |r|^2, the classic point source/sink,
//     divergence-free everywhere except at r=0 (by definition -- that
//     singularity IS the source/sink).
//
// Doublets (bluff-body obstacles: tyres, nose, airbox, engine cover) were
// REMOVED in Phase 3.7 -- PHASE-3.7.md's own diagnosis: "the analytic
// primitives cannot represent thin multi-element geometry such as the
// front wing, and their combined field produces closed recirculation loops
// where local swirl exceeds the freestream... the doublets are the source
// of both the clipping and the shape-mismatch problem." Guide curves now
// do the work of routing flow around bodywork instead (an authored path
// rather than a sphere/ellipsoid standing in for a shape it can't match).
//
// Every remaining primitive is clamped inside its own `coreRadius`
// (denominator floored, so nothing blows up right at the singularity) and
// shaped by an authored `decayLength` -- an exp(-|r|/decayLength) envelope
// multiplied onto the natural power-law falloff, so influence reaches
// roughly a car length rather than a few voxels.
//
// Do NOT solve for strengths from the mesh (a panel method, explicitly out
// of scope) -- every strength/coreRadius/decayLength below is an authored
// config value (data/rakes.json `primitives`), tuned by eye.
//
// Zero dependency on three.js/DOM, like the rest of src/particles/.

import { anchorToWorld, directionToWorld, expandMirrored } from './anchors.js';

/**
 * Resolves data/rakes.json's `primitives` array (fractional anchors/axes)
 * into world-space primitive objects, expanding `mirror: true` entries to
 * both sides of the car.
 */
export function buildPrimitives(domain, entries) {
  return entries.flatMap(expandMirrored).map((entry) => {
    const p = anchorToWorld(domain, entry.anchor);
    const axis = entry.axis ? directionToWorld(domain, entry.axis) : null;
    // A vortex reflected across the centreline spins the OPPOSITE way (wing-tip
    // vortices counter-rotate); copying the same signed strength to the mirror
    // copy made the left and right swirl the same direction and broke
    // left/right symmetry. Source/sinks are scalar, so they mirror unchanged.
    const mirroredCopy = entry.name.endsWith('-mirror');
    const strength = entry.type === 'vortex' && mirroredCopy ? -entry.strength : entry.strength;
    return {
      type: entry.type,
      name: entry.name,
      x: p.x, y: p.y, z: p.z,
      axis,
      strength,
      coreRadius: entry.coreRadius,
      decayLength: entry.decayLength,
      tight: entry.profile === 'tight',
    };
  });
}

function sourceSinkContribution(prim, x, y, z, out) {
  const dx = x - prim.x, dy = y - prim.y, dz = z - prim.z;
  const r = Math.hypot(dx, dy, dz);
  if (r < 1e-9) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  const rhx = dx / r, rhy = dy / r, rhz = dz / r;
  const rc = Math.max(r, prim.coreRadius);
  const coeff = (prim.strength / (rc * rc)) * Math.exp(-r / prim.decayLength);
  out[0] = rhx * coeff; out[1] = rhy * coeff; out[2] = rhz * coeff;
  return out;
}

/**
 * Non-singular tangential (curl-type) field. `radialProfile` is 0 at the
 * core axis, peaks at coreRadius, decays smoothly beyond -- no clamp
 * needed, it's finite and smooth everywhere including r=0.
 */
function vortexContribution(prim, x, y, z, out) {
  const dx = x - prim.x, dy = y - prim.y, dz = z - prim.z;
  const along = dx * prim.axis[0] + dy * prim.axis[1] + dz * prim.axis[2];
  if (along < 0) { out[0] = 0; out[1] = 0; out[2] = 0; return out; } // trailing vortex only exists downstream of its core
  const rx = dx - along * prim.axis[0], ry = dy - along * prim.axis[1], rz = dz - along * prim.axis[2];
  const rLen = Math.hypot(rx, ry, rz);
  if (rLen < 1e-6) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  let tx = prim.axis[1] * rz - prim.axis[2] * ry;
  let ty = prim.axis[2] * rx - prim.axis[0] * rz;
  let tz = prim.axis[0] * ry - prim.axis[1] * rx;
  const tLen = Math.hypot(tx, ty, tz) || 1;
  tx /= tLen; ty /= tLen; tz /= tLen;
  const rNorm = rLen / prim.coreRadius;
  // Default profile r*e^(1-r): peaks at the core radius and decays slowly, so air several core radii out still
  // circles. `profile: 'tight'` (data/rakes.json) uses r*e^((1-r^2)/2), the same peak with a Gaussian fall-off: a
  // concentrated core, like a real wingtip vortex, instead of a wide swirl.
  const radialProfile = prim.tight ? rNorm * Math.exp((1 - rNorm * rNorm) / 2) : rNorm * Math.exp(1 - rNorm);
  const axialProfile = Math.exp(-along / prim.decayLength);
  const mag = prim.strength * radialProfile * axialProfile;
  out[0] = tx * mag; out[1] = ty * mag; out[2] = tz * mag;
  return out;
}

/** Dispatches to the right closed-form contribution by primitive type. */
export function primitiveContributionAt(prim, x, y, z, out) {
  switch (prim.type) {
    case 'sourceSink': return sourceSinkContribution(prim, x, y, z, out);
    case 'vortex': return vortexContribution(prim, x, y, z, out);
    default: out[0] = 0; out[1] = 0; out[2] = 0; return out;
  }
}
