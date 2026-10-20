// Flattens each particle's ring-buffer trail history (see
// particleSystem.js) into a linear vertex buffer suitable for a
// THREE.LineSegments geometry: two vertices per rendered segment, oldest
// point first. No three.js dependency -- pure typed-array math -- so it can
// be benchmarked in plain Node alongside the simulation update
// (tests/particles.bench.js includes this step for a more complete "CPU
// work three.js would do every frame" number; see PROGRESS.md for exactly
// what that CPU-only benchmark does and does not cover).
//
// Output layout, sized once for `maxCount` (not the live `activeCount`) so
// the caller's BufferGeometry never needs to be reallocated when density
// changes at runtime -- only its draw range does:
//   segmentsPerParticle = trailLength - 1
//   positions: Float32Array, 3 floats * 2 vertices * segmentsPerParticle * maxCount
//   colors:    Float32Array, 4 floats (RGBA) * 2 vertices * segmentsPerParticle * maxCount
// A particle's unfilled/absent segments (fewer than trailLength points
// recorded yet, e.g. right after spawn) are written as zero-length,
// zero-alpha segments rather than left stale, so nothing stray gets drawn.

export function segmentsPerParticle(trailLength) {
  return Math.max(1, trailLength - 1);
}

export function createTrailBuffers(maxCount, trailLength, color) {
  const segs = segmentsPerParticle(trailLength);
  const vertsPerParticle = segs * 2;
  const positions = new Float32Array(maxCount * vertsPerParticle * 3);
  const colors = new Float32Array(maxCount * vertsPerParticle * 4);
  return { positions, colors, segmentsPerParticle: segs, vertsPerParticle, color };
}

/**
 * @param {ReturnType<import('./particleSystem.js').createParticleSystem>} system
 * @param {ReturnType<typeof createTrailBuffers>} out
 * @param {{ minAlpha: number, maxAlpha: number }} appearance
 */
export function fillTrailBuffers(system, out, appearance) {
  const { trailLength, activeCount } = system;
  const { trailX, trailY, trailZ, trailHead, trailFilled } = system.buffers;
  const { positions, colors, segmentsPerParticle: segs, vertsPerParticle, color } = out;
  const [r, g, b] = color;
  const { minAlpha, maxAlpha } = appearance;

  let vi = 0; // vertex index (positions.length = vi*3, colors.length = vi*4)

  for (let i = 0; i < activeCount; i++) {
    const filled = trailFilled[i];
    const head = trailHead[i];
    const base = i * trailLength;
    // Oldest retained point's ring index -- see particleSystem.js header
    // comment for the write-order derivation.
    const oldestIdx = filled < trailLength ? 0 : (head + 1) % trailLength;
    const realSegs = Math.max(0, filled - 1);

    for (let s = 0; s < segs; s++) {
      let ax, ay, az, bx, by, bz, alphaA, alphaB;
      if (s < realSegs) {
        const ka = (oldestIdx + s) % trailLength;
        const kb = (oldestIdx + s + 1) % trailLength;
        ax = trailX[base + ka]; ay = trailY[base + ka]; az = trailZ[base + ka];
        bx = trailX[base + kb]; by = trailY[base + kb]; bz = trailZ[base + kb];
        // Age fraction: 0 at the oldest point, 1 at the newest (head).
        alphaA = minAlpha + (maxAlpha - minAlpha) * (s / segs);
        alphaB = minAlpha + (maxAlpha - minAlpha) * ((s + 1) / segs);
      } else {
        // Not enough history yet (just spawned) -- degenerate, invisible
        // segment pinned to the newest known point.
        const kb = head;
        ax = bx = trailX[base + kb];
        ay = by = trailY[base + kb];
        az = bz = trailZ[base + kb];
        alphaA = alphaB = 0;
      }

      const pOff = vi * 3;
      const cOff = vi * 4;
      positions[pOff] = ax; positions[pOff + 1] = ay; positions[pOff + 2] = az;
      colors[cOff] = r; colors[cOff + 1] = g; colors[cOff + 2] = b; colors[cOff + 3] = alphaA;
      vi += 1;

      const pOff2 = vi * 3;
      const cOff2 = vi * 4;
      positions[pOff2] = bx; positions[pOff2 + 1] = by; positions[pOff2 + 2] = bz;
      colors[cOff2] = r; colors[cOff2 + 1] = g; colors[cOff2 + 2] = b; colors[cOff2 + 3] = alphaB;
      vi += 1;
    }
  }

  // Vertices beyond the active particles' range are left at whatever they
  // held last (0 for a fresh buffer) -- the caller restricts the draw range
  // to `activeCount * vertsPerParticle` so they are never actually drawn.
  return activeCount * vertsPerParticle;
}
