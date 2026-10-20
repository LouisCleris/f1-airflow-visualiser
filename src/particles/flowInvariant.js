// Phase 3.7 section 1 -- "the invariant that comes first." Applied to the
// FINAL field vector regardless of what produced it (guide curves,
// remaining vortex/source-sink primitives, anything summed before this
// runs): this is what actually prevents closed recirculation loops, not a
// property any individual primitive has to get right on its own.
//
//   - The streamwise component must never go negative outside an
//     explicitly declared wake region -- clamped to >= 0.
//   - The combined lateral+vertical magnitude is capped at
//     `lateralCapFraction` of freestream speed (default 0.6).
//
// A streamline may still curve, spiral, and diverge -- the cap on
// lateral+vertical magnitude allows that -- but outside a wake it always
// makes downstream progress, which is the actual mechanism that rules out
// a closed loop: a loop requires the streamwise component to reach zero
// and reverse somewhere on its path, and this makes that impossible
// wherever a wake doesn't explicitly say otherwise.
//
// Zero dependency on three.js/DOM, like the rest of src/particles/.

export const FLOW_INVARIANT_CONFIG = {
  lateralCapFraction: 0.6, // fraction of freestream speed the combined
  // lateral+vertical magnitude is capped at
  wakeImmersionThreshold: 0.02, // a point counts as "in a declared wake
  // region" once wakeImmersionAt() exceeds this -- a small positive
  // threshold rather than exactly 0, so the clamp doesn't chatter on and
  // off right at a wake cone's numerical edge
};

/**
 * Applies the section 1 invariant to velocity vector `v` (mutated in
 * place) at world position (x,y,z).
 *
 * @param {number[]|Float64Array} v 3-element velocity, mutated in place
 * @param {ReturnType<import('./domain.js').domainFromBounds>} domain
 * @param {number} freestreamSpeed world units/second (PARTICLE_CONFIG.flowSpeed)
 * @param {number} wakeImmersion precomputed wakeImmersionAt(wakes, x, y, z)
 *   -- passed in rather than recomputed here, since callers already need it
 *   for other purposes (coherence/jitter) and it's identical either way
 * @param {Partial<typeof FLOW_INVARIANT_CONFIG>} [cfg]
 * @returns {boolean} true if either clamp actually changed `v` (a
 *   "correction fired") -- used for the sandbox's live invariant readout
 *   and could drive a diagnostic counter the same way the SDF clamp does
 */
export function applyFlowInvariant(v, domain, freestreamSpeed, wakeImmersion, cfg = FLOW_INVARIANT_CONFIG) {
  const dirX = domain.dirX, dirY = domain.dirY, dirZ = domain.dirZ;
  const rightX = domain.rightX, rightY = domain.rightY, rightZ = domain.rightZ;
  const upX = domain.upX, upY = domain.upY, upZ = domain.upZ;

  let streamwise = v[0] * dirX + v[1] * dirY + v[2] * dirZ;
  let lateral = v[0] * rightX + v[1] * rightY + v[2] * rightZ;
  let vertical = v[0] * upX + v[1] * upY + v[2] * upZ;

  let corrected = false;

  const inWake = wakeImmersion > cfg.wakeImmersionThreshold;
  if (!inWake && streamwise < 0) {
    streamwise = 0;
    corrected = true;
  }

  const lateralVerticalMag = Math.hypot(lateral, vertical);
  const cap = cfg.lateralCapFraction * freestreamSpeed;
  if (lateralVerticalMag > cap && lateralVerticalMag > 1e-9) {
    const scale = cap / lateralVerticalMag;
    lateral *= scale;
    vertical *= scale;
    corrected = true;
  }

  v[0] = streamwise * dirX + lateral * rightX + vertical * upX;
  v[1] = streamwise * dirY + lateral * rightY + vertical * upY;
  v[2] = streamwise * dirZ + lateral * rightZ + vertical * upZ;

  return corrected;
}

/** Just the signed streamwise component of `v` -- used by assertion 5 and by streamlines.js's recorded per-point diagnostics, without re-deriving the dot product inline everywhere. */
export function streamwiseComponent(v, domain) {
  return v[0] * domain.dirX + v[1] * domain.dirY + v[2] * domain.dirZ;
}
