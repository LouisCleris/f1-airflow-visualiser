// Public entry point for the WAKE particle field, wired into main.js
// alongside (not instead of) streamlineField.js. Combines:
//   domain.js          -- derives the flow domain from the loaded car, then
//                          restricts it to the wake region (computeWakeDomain)
//   particleSystem.js  -- pure simulation (positions, recycling, trails)
//   trailRenderer.js   -- three.js LineSegments driven by the simulation
// into one handle main.js can add to the scene and tick every frame.
//
// Restricted to the wake (spawn plane at the car's trailing edge, travel
// range = just the downstream margin) rather than the whole domain: the
// clean/attached flow ahead of and around the car is now drawn as traced
// streamlines instead (streamlineField.js), because a short particle trail
// is shorter than the radius of any real deflection curve and so cannot
// show a bend in a still frame. The wake genuinely IS unsteady (turbulent,
// recirculating), which is exactly what a steady traced line cannot
// represent -- so particles remain the right tool there, and only there.
// See PROGRESS.md's Phase 3 addendum.

import { PARTICLE_CONFIG } from './config.js';
import { computeFlowDomain, computeWakeDomain } from './domain.js';
import { createParticleSystem } from './particleSystem.js';
import { createTrailRenderer } from './trailRenderer.js';
import { yawWakeDomain } from './cornering.js';

/**
 * @param {import('three').Object3D} carRoot fully-built (mirrored) car, per
 *   src/car.js -- used only to size/orient the flow domain, never mutated.
 * @param {{ grid?: import('./collisionGrid.js').ParsedOccupancyGrid|null } & Partial<typeof PARTICLE_CONFIG>} [options]
 *   `grid` (Phase 3): a parsed occupancy grid -- see collisionGrid.js
 *   `fetchOccupancyGrid()` -- to deflect particles around the car. Omit for
 *   Phase-2-style uniform flow with no obstacle interaction. Every other
 *   key is merged into PARTICLE_CONFIG as before.
 */
export function createParticleField(carRoot, options = {}) {
  const { grid = null, sdf = null, domain: domainOverride = null, yawDeg = 0, ...overrides } = options;
  const config = { ...PARTICLE_CONFIG, ...overrides };
  const fullDomain = domainOverride || computeFlowDomain(carRoot, config);
  const spawn = config.wakeSpawn;
  const wakeDomain = computeWakeDomain(fullDomain, spawn ? spawn.alongFlow : 1);
  const domain = yawDeg ? yawWakeDomain(wakeDomain, yawDeg) : wakeDomain; // cornering: released towards the inside
  const system = createParticleSystem(domain, { ...config, spawnRegions: spawn ? spawn.regions : null }, grid, sdf);
  const renderer = createTrailRenderer(config);

  renderer.sync(system); // populate before the first frame is drawn

  function update(dt) {
    system.update(dt);
    renderer.sync(system);
  }

  /** Density control point (BUILD.md Phase 2 item 6; UI slider is Phase 7). */
  function setDensity(count) {
    return system.setActiveCount(count);
  }

  return {
    object3D: renderer.object3D,
    update,
    setDensity,
    get count() { return system.activeCount; },
    maxCount: system.maxCount,
  };
}
