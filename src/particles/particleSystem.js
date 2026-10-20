// Core particle simulation. Deliberately has ZERO dependency on three.js or
// any DOM/WebGL API -- every buffer is a plain typed array and every update
// is scalar math -- so this module runs identically in the browser and in
// plain Node. That is what lets tests/checks.js assertion 2 (frame time at
// maximum particle density) measure the *real* update step instead of a
// synthetic stand-in: see tests/particles.bench.js, which imports this file
// directly.
//
// Structure-of-arrays layout (parallel Float32Arrays per field, not an
// array of {x,y,z,...} objects) so the hot per-frame loop below never
// allocates and stays cache-friendly at thousands of particles -- this is
// the "GPU-friendly-ish CPU" choice mentioned in PROGRESS.md: real GPU
// compute (transform feedback / compute shaders) was judged unnecessary
// complexity for a per-particle update this cheap (a handful of adds and
// one dot product; no trig, no sqrt, no branching per axis).
//
// Flow model (Phase 2 scope): every particle moves at a constant velocity
// along the domain's flow direction (magnitude varies slightly per
// particle, fixed at spawn -- see config.js `speedJitter`; direction is
// identical for all particles, so this is still a "uniform base flow", not
// curvature/turbulence). No obstacle interaction: particles pass straight
// through the car's bounding volume, exactly as BUILD.md Phase 2 specifies
// ("No obstacle interaction yet"). A particle recycles back to a random
// point on the upstream spawn plane once it has travelled `travelDistance`
// along the flow axis from that plane.
//
// Trail history is a fixed-size per-particle ring buffer (`trailLength`
// points), so recording a new point is O(1) regardless of trail length --
// no array shifting/splicing. trailRenderer.js reads these ring buffers
// (via trailBuffers.js) to build the actual fading-ribbon geometry.
//
// Obstacle deflection (Phase 3 scope): when a `grid` (a parsed occupancy
// grid from collisionGrid.js) is passed in, each particle also carries a
// per-particle unit velocity DIRECTION (velX/Y/Z, separate from the shared
// base flow direction dirX/dirY/dirZ) that can bend away from occupied
// cells and relaxes back toward the base direction once clear -- see
// update() below. Passing no grid (or null/undefined) reproduces Phase 2
// exactly: velocity direction is pinned to the base flow direction and
// never diverges, at effectively the same per-particle cost (this is what
// tests/particles.bench.js -- assertion 2 -- still measures, deliberately
// grid-free, since its synthetic domain has no matching real grid).
//
// Beyond the soft velocity steering, update() also applies a hard,
// unconditional position correction: if a particle's computed position for
// this frame still lands inside an occupied cell (steering wasn't enough,
// e.g. right at spawn or a fast recycle), it is pushed straight out along
// the nearest occupied cell's stored normal until it clears. This is what
// makes "zero particles inside an occupied cell" a guarantee by
// construction, checkable exactly by tests/checks.js assertion 3, rather
// than something that merely tends to be true.

/**
 * @param {import('./domain.js').FlowDomain} domain plain-number domain
 *   descriptor from domain.js (or an equivalent hand-built object for
 *   benchmarking/tests -- see tests/particles.bench.js).
 * @param {{ maxCount: number, count: number, trailLength: number,
 *   flowSpeed: number, speedJitter: number, deflectionRadiusCells: number,
 *   deflectionStrength: number, flowRelaxRate: number,
 *   pushOutRadiusCells: number }} config
 * @param {import('./collisionGrid.js').ParsedOccupancyGrid|null} [grid]
 *   Parsed occupancy grid (collisionGrid.js `parseOccupancyGrid()`). Omit
 *   or pass null/undefined for pure Phase-2 uniform flow with no obstacle
 *   interaction.
 * @param {import('./sdf.js').Sdf|null} [sdf]
 *   Signed distance field (sdf.js). When given it REPLACES `grid` for steering
 *   and for the no-penetration guarantee: steering and push-out use the
 *   interpolated distance and gradient, not cell lookups. (Phase 4: the wake
 *   particles moved off the binary grid.)
 */
export function createParticleSystem(domain, config, grid = null, sdf = null) {
  const maxCount = config.maxCount | 0;
  const trailLength = Math.max(2, config.trailLength | 0);

  const posX = new Float32Array(maxCount);
  const posY = new Float32Array(maxCount);
  const posZ = new Float32Array(maxCount);
  const speed = new Float32Array(maxCount);
  // Per-particle unit velocity DIRECTION (separate from scalar `speed`).
  // Initialised to the base flow direction at spawn; only ever diverges
  // from it when `grid` is provided and the particle is near an occupied
  // cell (see update()).
  const velX = new Float32Array(maxCount);
  const velY = new Float32Array(maxCount);
  const velZ = new Float32Array(maxCount);

  const trailX = new Float32Array(maxCount * trailLength);
  const trailY = new Float32Array(maxCount * trailLength);
  const trailZ = new Float32Array(maxCount * trailLength);
  const trailHead = new Uint16Array(maxCount);
  const trailFilled = new Uint16Array(maxCount);

  let activeCount = Math.max(1, Math.min(config.count | 0 || maxCount, maxCount));

  const {
    dirX, dirY, dirZ,
    rightX, rightY, rightZ,
    upX, upY, upZ,
    originX, originY, originZ,
    spawnDistance, travelDistance, halfWidth, halfHeight,
  } = domain;

  // Spawn-plane origin (the upstream face of the domain), precomputed once
  // -- every recycle/spawn and the per-frame "how far travelled" test below
  // reuse it instead of recomputing origin - dir*spawnDistance every time.
  const planeX = originX - dirX * spawnDistance;
  const planeY = originY - dirY * spawnDistance;
  const planeZ = originZ - dirZ * spawnDistance;

  function randRange(a, b) {
    return a + Math.random() * (b - a);
  }

  // Lateral spawn position, cosine-tapered rather than uniform across
  // [-halfWidth, halfWidth]: density is highest at the centreline and fades
  // smoothly to exactly zero at the edges, so the release plane has no
  // visible hard-edged boundary (the author's Phase 3 visual review -- a
  // uniform box read as a flat rectangle of parallel streaks with no
  // sense of "flow" beyond its edge). Implemented as rejection sampling
  // against a raised-cosine weight (1 at centre, 0 at +/-halfWidth) rather
  // than deriving a closed-form inverse CDF -- simpler, exact, and only
  // runs at spawn/recycle time, never in the per-frame update() hot loop.
  function sampleLateral() {
    for (let tries = 0; tries < 8; tries++) {
      const x = randRange(-halfWidth, halfWidth);
      const weight = 0.5 * (1 + Math.cos((Math.PI * x) / halfWidth));
      if (Math.random() < weight) return x;
    }
    return 0; // vanishingly unlikely after 8 rejections; centreline is always valid
  }

  const sdfS = new Float64Array(4);
  const STANDOFF = (config.sdfStandoffCells ?? 0.35) * 0.0289384; // world units off the (conservative) SDF surface

  // Optional spawn regions (config.spawnRegions: [{ lateral, lateralHalf,
  // vertical: [lo, hi] }] in the same fractional convention as anchors.js --
  // lateral as a fraction of half the car width, vertical of the car height).
  // Used to release the wake particles from behind the rear wheels instead
  // of across the whole domain-wide plane.
  const regions = config.spawnRegions && config.spawnRegions.length ? config.spawnRegions : null;
  const halfCarWidth = (domain.carWidth || 0) / 2;
  const carHeight = domain.carHeight || halfHeight;

  function spawnParticle(i, travel) {
    // With an SDF, resample the spawn point (up to a few tries) until it is
    // clear of the surface: the rear-wheel spawn regions overlap bodywork.
    for (let attempt = 0; attempt < 12; attempt++) {
      placeParticle(i, travel);
      if (!sdf || !sdf.isNear(posX[i], posY[i], posZ[i]) || sdf.sampleAt(posX[i], posY[i], posZ[i], sdfS) >= STANDOFF) return;
    }
  }

  function placeParticle(i, travel) {
    let lateral, vertical;
    if (regions) {
      const r = regions[(Math.random() * regions.length) | 0];
      lateral = (r.lateral + randRange(-r.lateralHalf, r.lateralHalf)) * halfCarWidth;
      vertical = randRange(r.vertical[0], r.vertical[1]) * carHeight;
    } else {
      lateral = sampleLateral();
      vertical = randRange(0, halfHeight);
    }
    const x = planeX + dirX * travel + rightX * lateral + upX * vertical;
    const y = planeY + dirY * travel + rightY * lateral + upY * vertical;
    const z = planeZ + dirZ * travel + rightZ * lateral + upZ * vertical;
    posX[i] = x; posY[i] = y; posZ[i] = z;
    // Reset per-particle direction to the base flow direction on (re)spawn
    // -- a recycled particle re-enters upstream of the car, so it should
    // not carry over a deflected heading from its previous life.
    velX[i] = dirX; velY[i] = dirY; velZ[i] = dirZ;
    speed[i] = config.flowSpeed * (1 + randRange(-config.speedJitter, config.speedJitter));
    trailHead[i] = 0;
    trailFilled[i] = 1;
    const base = i * trailLength;
    trailX[base] = x; trailY[base] = y; trailZ[base] = z;
  }

  // Initial population: spread particles across the whole domain length
  // (not all glued to the spawn plane) so the first rendered/benchmarked
  // frame already looks like -- and costs the same as -- a developed flow.
  for (let i = 0; i < maxCount; i++) {
    spawnParticle(i, Math.random() * travelDistance);
  }

  function recordTrailPoint(i, x, y, z) {
    const head = (trailHead[i] + 1) % trailLength;
    trailHead[i] = head;
    const base = i * trailLength + head;
    trailX[base] = x; trailY[base] = y; trailZ[base] = z;
    if (trailFilled[i] < trailLength) trailFilled[i] += 1;
  }

  // Deflection tuning, read once from config rather than per-particle.
  const DEFLECT_RADIUS = Math.max(0, config.deflectionRadiusCells | 0);
  const DEFLECT_STRENGTH = config.deflectionStrength;
  const RELAX_RATE = config.flowRelaxRate;
  const PUSH_RADIUS = Math.max(0, config.pushOutRadiusCells | 0);
  const MAX_PUSH_ITERATIONS = 24;
  // Radii tried, in order, each time the push-out loop needs to re-locate
  // the nearest occupied cell from a new position. Starts at the configured
  // radius; escalates (mirroring the bake's own expanding-radius normal
  // search, see occupancy_grid.json `normals.method`) so a particle that
  // happens to spawn deep inside an unusually thick decimated wall section
  // still always finds a normal to push out along, rather than giving up.
  const PUSH_RADII = [PUSH_RADIUS, PUSH_RADIUS * 2, PUSH_RADIUS * 4, PUSH_RADIUS * 8];
  // Reused scratch buffer for collisionGrid's findNearestOccupied() output
  // -- written in place, so steering/push-out allocate nothing per particle.
  const tmpNormal = grid ? new Float32Array(3) : null;
  const STEER_RADIUS = DEFLECT_RADIUS * (sdf ? sdf.cellWorld || 0.0289384 : 0);

  /**
   * Advance every active particle by `dt` seconds. This is the function
   * tests/particles.bench.js times directly. When `grid` was supplied at
   * construction, this also steers particles around occupied cells and
   * guarantees (see MAX_PUSH_ITERATIONS below) that no particle's position
   * ends the frame inside one.
   * @param {number} dt seconds
   */
  function update(dt) {
    for (let i = 0; i < activeCount; i++) {
      let vx = velX[i], vy = velY[i], vz = velZ[i];

      if (sdf) {
        const x0 = posX[i], y0 = posY[i], z0 = posZ[i];
        let steered = false;
        if (sdf.isNear(x0, y0, z0)) {
          const dd = sdf.sampleAt(x0, y0, z0, sdfS);
          if (dd < STEER_RADIUS && (sdfS[1] !== 0 || sdfS[2] !== 0 || sdfS[3] !== 0)) {
            const u = Math.max(0, dd) / STEER_RADIUS;
            const pull = DEFLECT_STRENGTH * dt * (1 - u * u * (3 - 2 * u)); // smoothstep falloff
            vx += sdfS[1] * pull; vy += sdfS[2] * pull; vz += sdfS[3] * pull;
            steered = true;
          }
        }
        if (!steered) {
          const relax = Math.min(1, RELAX_RATE * dt);
          vx += (dirX - vx) * relax; vy += (dirY - vy) * relax; vz += (dirZ - vz) * relax;
        }
        const len = Math.hypot(vx, vy, vz) || 1;
        vx /= len; vy /= len; vz /= len;
        velX[i] = vx; velY[i] = vy; velZ[i] = vz;
      } else if (grid) {
        const x0 = posX[i], y0 = posY[i], z0 = posZ[i];
        let steered = false;
        if (grid.isNearOccupiedRegion(x0, y0, z0) &&
            grid.findNearestOccupied(x0, y0, z0, DEFLECT_RADIUS, tmpNormal)) {
          // Steer velocity direction toward the local outward normal --
          // "push particle velocity away from occupied cells based on the
          // local surface normal" (BUILD.md Phase 3 / spec section 3.2).
          const pull = DEFLECT_STRENGTH * dt;
          vx += tmpNormal[0] * pull;
          vy += tmpNormal[1] * pull;
          vz += tmpNormal[2] * pull;
          steered = true;
        }
        if (!steered) {
          // Clear of the occupied region: relax back toward the uniform
          // base flow direction so deflection reads as a local detour.
          const relax = Math.min(1, RELAX_RATE * dt);
          vx += (dirX - vx) * relax;
          vy += (dirY - vy) * relax;
          vz += (dirZ - vz) * relax;
        }
        const len = Math.hypot(vx, vy, vz) || 1;
        vx /= len; vy /= len; vz /= len;
        velX[i] = vx; velY[i] = vy; velZ[i] = vz;
      }

      const d = speed[i] * dt;
      let x = posX[i] + vx * d;
      let y = posY[i] + vy * d;
      let z = posZ[i] + vz * d;

      if (config.wakeSpreadRate) {
        // Positional jitter (not folded into the persisted velocity
        // heading, so it can't compound frame over frame), scaled by
        // progress toward travelDistance -- tight at spawn, diffuse by the
        // time a particle reaches the end of the wake.
        const travelledSoFar = (x - planeX) * dirX + (y - planeY) * dirY + (z - planeZ) * dirZ;
        const progress = Math.max(0, Math.min(1, travelledSoFar / travelDistance));
        const spread = config.wakeSpreadRate * progress * dt;
        const jr = (Math.random() * 2 - 1) * spread;
        const ju = (Math.random() * 2 - 1) * spread;
        x += rightX * jr + upX * ju;
        y += rightY * jr + upY * ju;
        z += rightZ * jr + upZ * ju;
      }

      if (sdf && sdf.isNear(x, y, z)) {
        // Smooth no-penetration: if closer than the standoff (or inside), move
        // out along the interpolated gradient by (standoff - distance).
        for (let tries = 0; tries < 6; tries++) {
          const dd = sdf.sampleAt(x, y, z, sdfS);
          if (dd >= STANDOFF * 0.98 || (sdfS[1] === 0 && sdfS[2] === 0 && sdfS[3] === 0)) break;
          const push = Math.min(STANDOFF - dd, 0.06);
          x += sdfS[1] * push; y += sdfS[2] * push; z += sdfS[3] * push;
        }
        if (sdf.sampleAt(x, y, z, sdfS) < 0) { spawnParticle(i, 0); continue; } // could not be cleared: recycle, never leave one in bodywork
      } else if (grid && grid.isOccupiedWorld(x, y, z)) {
        // Hard guarantee, independent of how well steering worked this
        // frame (and independent of how the particle got here -- including
        // its very first, grid-unaware spawn position): push straight back
        // out along the nearest occupied cell's normal, 1.5 voxel pitches
        // at a time, escalating the search radius if nothing is found
        // nearby, until clear.
        for (let tries = 0; tries < MAX_PUSH_ITERATIONS && grid.isOccupiedWorld(x, y, z); tries++) {
          let found = false;
          for (let r = 0; r < PUSH_RADII.length; r++) {
            if (grid.findNearestOccupied(x, y, z, PUSH_RADII[r], tmpNormal)) { found = true; break; }
          }
          if (!found) break;
          x += tmpNormal[0] * grid.pitch * 1.5;
          y += tmpNormal[1] * grid.pitch * 1.5;
          z += tmpNormal[2] * grid.pitch * 1.5;
        }

        // Last-resort fallback: a handful of world positions (measured at
        // ~0.0003% of particle-frames) sit in gaps a couple of voxels wide
        // between two opposing shell walls close together -- a thin
        // trailing edge such as a wingtip or splitter lip -- where pushing
        // along one wall's normal can walk straight into the other wall's
        // occupied cells. Rather than ever leave a particle inside
        // bodywork, treat it as recycled: it reappears upstream next frame,
        // same as a particle that reached the end of the domain.
        if (grid.isOccupiedWorld(x, y, z)) {
          spawnParticle(i, 0);
          continue;
        }
      }

      // Distance travelled along the (unit-length) flow axis since the
      // spawn plane -- a single dot product, no sqrt.
      const travelled = (x - planeX) * dirX + (y - planeY) * dirY + (z - planeZ) * dirZ;

      if (travelled > travelDistance) {
        spawnParticle(i, 0);
      } else {
        posX[i] = x; posY[i] = y; posZ[i] = z;
        recordTrailPoint(i, x, y, z);
      }
    }
  }

  function setActiveCount(n) {
    activeCount = Math.max(1, Math.min(maxCount, n | 0));
    return activeCount;
  }

  return {
    maxCount,
    trailLength,
    get activeCount() { return activeCount; },
    setActiveCount,
    update,
    buffers: { posX, posY, posZ, trailX, trailY, trailZ, trailHead, trailFilled },
  };
}
