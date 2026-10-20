// Particle system configuration. Kept as plain data so every later phase
// (density slider in Phase 7, trail-length slider, speed slider in Phase 5)
// only has to change values here or pass overrides in -- nothing in
// particleSystem.js/trailRenderer.js hardcodes these numbers.
//
// BUILD.md Phase 2 explicitly asks for a "particle density control point in
// code, even if the actual UI slider isn't required until Phase 7" -- that
// control point is `count` below (the live/default density) together with
// `setDensity()` on the object `createParticleField()` returns in index.js.
// `maxCount` is the density tests/checks.js assertion 2 measures against
// ("maximum particle density") -- every typed-array buffer is sized for
// maxCount once, up front, so changing `count` at runtime never reallocates.

export const PARTICLE_CONFIG = {
  // Scene setup (kept as config so another scene can reuse the machinery):
  groundY: 0, // height of the road plane; treated as an EXACT flat plane by the distance queries (sdf.js composeSdf), not sampled from any grid

  // Density.
  count: 400, // wake particle count. Phase 4: "a quarter of the strength" meant the SPREAD
  // (wakeSpreadRate below, kept at 0.8), not the count; the count is back up
  // from 156 to ~400. Was 625 before Phase 4.
  // the author turns density back up himself via setDensity()/the Phase 7 slider.
  maxCount: 8000, // upper bound used to size buffers and for the "maximum
  // particle density" frame-time benchmark (tests/checks.js assertion 2) --
  // deliberately left unchanged: assertion 2 must keep stress-testing the
  // real worst case, independent of today's lower visual default.

  // Trail / ribbon shape.
  trailLength: 6, // trail points captured per particle (>= 2, the hard
  // floor enforced in particleSystem.js). Was 7; the author asked for ~20%
  // (7 * 0.2 = 1.4), which rounds down to exactly that floor -- shorter
  // ribbons overlap each other far less at a given density, so individual
  // streamlines (and where they bend) stay readable instead of blurring
  // into a solid band. Rendered as (trailLength - 1) = 1 line segment per
  // particle -- still a short ribbon with a fading start/end, not a dot.
  minAlpha: 0.04,
  maxAlpha: 0.45, // dimmer than the streamlines (base opacity 0.5, up to 1 near surfaces)

  // Base flow (Phase 2 scope only: uniform direction + speed for every
  // particle, no curvature/wake shaping -- that is Phase 4).
  flowSpeed: 5.5, // world units / second along the domain's flow axis
  speedJitter: 0.35, // +/- fractional per-particle speed offset, assigned
  // once at spawn and held constant for that particle's whole life. Purely
  // a visual variety measure (keeps thousands of particles from moving in
  // a perfectly rigid grid) -- every particle still travels in exactly the
  // same direction, so the field remains a "uniform base flow".

  // Domain / spawn shaping, all relative to the car's own bounding box (see
  // domain.js) so this scales automatically if the model ever changes.
  spawnMargin: 0.4, // world units upstream of the car's bounding box where
  // the spawn plane sits. Was 1.5; the author asked for the release plane closer
  // to the car so less of the frame is empty uniform upstream flow before
  // anything interesting happens.
  downstreamMargin: 4.0, // world units downstream of the car's bounding box
  // before a particle is recycled back to the spawn plane
  widthMultiplier: 3.0, // full spawn-plane width, as a multiple of the
  // car's own width (domain.js: fullWidth = widthMultiplier * carWidth).
  // Was 1.7 (a ~1.7x-car-width release plane, easy to fill edge-to-edge and
  // read as a hard-edged box); the author asked for ~3x. Combined with the
  // cosine-taper spawn distribution in particleSystem.js's spawnParticle()
  // (dense at the centreline, fading smoothly to zero at this width's
  // edges), the wider plane shows undisturbed flow well outside the car on
  // both sides for visual contrast, with no visible hard boundary.
  heightMultiplier: 2.0, // spawn plane height, as a multiple of the car's
  // own height above the ground

  // Appearance. Deliberately a single cool tint for Phase 2 (uniform flow
  // has no speed variation to colour by yet -- that's Phase 4's speed-based
  // colouring); kept desaturated/monochrome-adjacent per CLAUDE.md.
  color: [0.0723, 0.2051, 1.0], // #4C7DFF (the slow end of the streamline ramp) as LINEAR rgb, which is what vertex colours are

  // Obstacle deflection (Phase 3 scope only: steer velocity away from the
  // baked occupancy grid using the stored local normal -- see
  // src/particles/collisionGrid.js and particleSystem.js). Curvature
  // speed-up / wake turbulence shaping is Phase 4, not this.
  deflectionRadiusCells: 3, // how many grid cells out to search for the
  // nearest occupied cell once a particle enters the grid's broad-phase AABB
  deflectionStrength: 3.0, // how hard velocity direction is pushed toward
  // the local surface normal per second once near an occupied cell
  flowRelaxRate: 4.0, // how fast (per second) a particle's direction
  // relaxes back toward the uniform base flow direction once clear of the
  // occupied region, so deflection reads as a local detour, not a permanent
  // heading change
  pushOutRadiusCells: 2, // neighbourhood searched for the hard
  // position-correction fallback (see particleSystem.js) that guarantees no
  // particle ever ends a frame inside an occupied cell, even if the softer
  // velocity steering above wasn't enough to avoid it that frame

  // Wake spread (PHASE-3.5.md section 6: "particle spread should increase
  // with distance into the wake" -- these particles are now confined to
  // the wake region only, see domain.js computeWakeDomain() /
  // particles/index.js). A small random lateral/vertical positional jitter
  // is added each frame, scaled by how far a particle has travelled since
  // its spawn plane (0 at spawn, full strength once it reaches
  // downstreamMargin) -- applied to POSITION, not the persisted velocity
  // heading, so it can't accumulate/compound across frames.
  wakeSpreadRate: 0.8, // world units/second of jitter magnitude at full travel. Was 3.2; a quarter of it for the Phase 4 wake
  sdfStandoffCells: 0.35, // wake particles keep this far (occupancy cells) off the signed distance field's surface

  // Where the wake particles are released (Phase 4): the plane just behind
  // the rear wheels (alongFlow is the anchors.js fraction of the car's
  // half-length), over each rear wheel's width and height, so they carry the
  // wheel wake downstream rather than filling a domain-wide plane.
  wakeSpawn: {
    alongFlow: 0.92,
    regions: [
      { lateral: 0.77, lateralHalf: 0.2, vertical: [0.02, 0.6] },
      { lateral: -0.77, lateralHalf: 0.2, vertical: [0.02, 0.6] },
    ],
  },
};

// What the Falcon scene changes in PARTICLE_CONFIG (the rest -- flow speed, standoffs, step sizes -- is shared, because the
// Falcon is shown at the F1's size; see src/sceneConfig.js). No ground. Wake particles are released just behind the
// tail cone and the two exhausts (data/falcon/rakes.json: tail cone ends at alongFlow ~0.81, exhausts at lateral
// +-0.185, vertical ~0.29): a thin, tidy wake, not a wide one.
export const FALCON_PARTICLE_OVERRIDES = {
  groundY: null,
  count: 250,
  maxCount: 4000,
  wakeSpread: 0,
  wakeSpreadRate: 0.25,
  downstreamMargin: 3.0,
  wakeSpawn: {
    alongFlow: 0.84,
    regions: [
      { lateral: 0.0, lateralHalf: 0.04, vertical: [0.28, 0.5] },
      { lateral: 0.185, lateralHalf: 0.03, vertical: [0.25, 0.33] },
      { lateral: -0.185, lateralHalf: 0.03, vertical: [0.25, 0.33] },
    ],
  },
};
