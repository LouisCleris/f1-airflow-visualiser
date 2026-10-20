// Phase 3.6 section 5: "many small wakes, not one big one." Each bluff
// feature (a tyre, a wing endplate, the sidepod trailing edge, the diffuser
// exit) sheds its own wake -- an expanding cone downstream of an origin,
// inside which a traced line should progressively lose coherence (rising
// jitter, falling opacity) rather than hit a hard boundary. Downstream,
// overlapping cones read as merging structures for free, since
// wakeImmersionAt() takes the max membership across all configured wakes
// at a point rather than picking just one.
//
// This is deliberately NOT noise: the shape of the incoherence comes from
// where these placed cones actually are and how they expand/decay (config
// data, data/rakes.json `wakes`), matching section 5's "wake structure
// comes from the placed vortex primitives decaying downstream; noise may
// only ever be a small perturbation on top." The random jitter
// streamlines.js mixes in once a point is immersed is that small
// perturbation, not the source of the wake shape itself.
//
// Zero dependency on three.js/DOM, like the rest of src/particles/.

import { anchorToWorld, directionToWorld, expandMirrored } from './anchors.js';

/**
 * Resolves data/rakes.json's `wakes` array into world-space cones,
 * expanding `mirror: true` entries to both sides of the car.
 */
export function buildWakes(domain, entries) {
  return entries.flatMap(expandMirrored).map((entry) => {
    const p = anchorToWorld(domain, entry.anchor);
    const axis = directionToWorld(domain, entry.axis);
    return {
      name: entry.name,
      x: p.x, y: p.y, z: p.z,
      axis,
      tanAngle: Math.tan(entry.expansionAngle),
      decayLength: entry.decayLength,
      speedDeficit: entry.speedDeficit || 0, // fraction of freestream speed lost at the wake's core
    };
  });
}

/**
 * How immersed (x,y,z) is in any configured wake, 0 (fully ordered/clean
 * flow) to 1 (fully incoherent). A point downstream of a wake's origin,
 * within its expanding cone, immersion is high near the origin/axis and
 * fades both radially (toward the cone's edge) and axially (with
 * downstream distance, at `decayLength`). Points upstream of a wake's own
 * origin are entirely unaffected by it (along <= 0).
 */
export function wakeImmersionAt(wakes, x, y, z) {
  let maxImmersion = 0;
  for (const w of wakes) {
    const immersion = singleWakeImmersion(w, x, y, z);
    if (immersion > maxImmersion) maxImmersion = immersion;
  }
  return Math.min(1, maxImmersion);
}

/**
 * Multiplier on the local flow speed from the wakes: 1 outside every wake, falling to (1 - speedDeficit) at a
 * wake's core. Follows the same cone and decay as wakeImmersionAt(), so the slow air fades back to the oncoming
 * speed with distance behind the car instead of persisting.
 */
export function wakeSpeedFactorAt(wakes, x, y, z) {
  let factor = 1;
  for (const w of wakes) {
    if (!w.speedDeficit) continue;
    const f = 1 - w.speedDeficit * singleWakeImmersion(w, x, y, z);
    if (f < factor) factor = f;
  }
  return factor;
}

function singleWakeImmersion(w, x, y, z) {
  const dx = x - w.x, dy = y - w.y, dz = z - w.z;
  const along = dx * w.axis[0] + dy * w.axis[1] + dz * w.axis[2];
  if (along <= 0) return 0;
  const rx = dx - along * w.axis[0], ry = dy - along * w.axis[1], rz = dz - along * w.axis[2];
  const radial = Math.hypot(rx, ry, rz);
  const coneRadius = Math.max(along * w.tanAngle, 1e-4);
  const radialFrac = radial / coneRadius;
  const radialMembership = Math.exp(-2 * radialFrac * radialFrac); // ~1 near the axis, fading by the cone edge
  const axialMembership = Math.exp(-along / w.decayLength); // ~1 near the origin, decaying downstream
  return radialMembership * axialMembership;
}
