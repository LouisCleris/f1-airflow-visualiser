// Public entry point for the traced-streamline field, wired into main.js
// alongside (not instead of) the wake particle field in index.js. Combines:
//   domain.js         -- derives the (full, car-to-domain) flow domain
//   streamlines.js     -- analytic-primitive field + surface seeding + RK4 tracing (Phase 3.6)
//   streamlineRenderer.js -- static ribbon mesh + speed/vorticity colour + travelling pulse
// See PROGRESS.md's Phase 3.6 entry for the field rewrite (push-based SDF
// deflection -> summed analytic primitives, SDF demoted to a safety clamp).

import { computeFlowDomain } from './domain.js';
import { buildAllStreamlines, STREAMLINE_CONFIG } from './streamlines.js';
import { createStreamlineRenderer, STREAMLINE_RENDER_CONFIG } from './streamlineRenderer.js';
import { PARTICLE_CONFIG } from './config.js';
import { anchorToWorld } from './anchors.js';

export const RAKES_CONFIG_URL = 'data/rakes.json';

/** Browser-only convenience loader, mirroring collisionGrid.js's fetchOccupancyGrid(). */
export async function fetchRakesConfig(url = RAKES_CONFIG_URL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: HTTP ${res.status}`);
  return res.json();
}

/**
 * A scene's rakes.json `display` block (optional; the F1 has none): its render settings, with the focus capsules'
 * fractional end points ({ from, to, radius, mirror }, the usual anchor convention) resolved to world space.
 */
function displayOverrides(rakesConfig, domain) {
  const display = rakesConfig && rakesConfig.display;
  if (!display) return {};
  const { focus, ...rest } = display;
  const out = { ...rest };
  if (focus) {
    const flip = (q) => ({ ...q, lateral: -q.lateral });
    const world = (q) => { const w = anchorToWorld(domain, q); return [w.x, w.y, w.z]; };
    out.focus = focus.flatMap((c) => (c.mirror ? [c, { ...c, from: flip(c.from), to: flip(c.to) }] : [c]))
      .map((c) => ({ a: world(c.from), b: world(c.to), radius: c.radius }));
    out.focusFlowDir = [domain.dirX, domain.dirY, domain.dirZ];
  }
  return out;
}

/**
 * @param {import('three').Object3D} carRoot fully-built (mirrored) car, per
 *   src/car.js -- used only to size/orient the flow domain, never mutated.
 * @param {import('./sdf.js').Sdf|null} sdf baked signed distance field (sdf.js):
 *   drives the smooth near-surface correction and the soft repulsion.
 * @param {{ groups: object[], primitives: object[], wakes: object[], seeding: object }} rakesConfig data/rakes.json (already parsed)
 * @param {Partial<typeof STREAMLINE_CONFIG>} [traceOverrides]
 * @param {Partial<typeof STREAMLINE_RENDER_CONFIG>} [renderOverrides]
 * @param {ReturnType<import('./bakedStreamlines.js').decodeStreamlines>|null} [bakedPaths] lines traced ahead of time; skips tracing
 */
export function createStreamlineField(carRoot, sdf, rakesConfig, traceOverrides = {}, renderOverrides = {}, bakedPaths = null, { domain: domainOverride = null } = {}) {
  const domain = domainOverride || computeFlowDomain(carRoot, PARTICLE_CONFIG); // a scene whose domain is baked (the Falcon) passes it in

  // Lines traced ahead of time (scripts/bake_streamlines.mjs) are used as they are; otherwise they are traced now.
  const built = bakedPaths ? { paths: bakedPaths, clampFireCount: 0, subStepCount: 0, clampFireRate: 0 } : buildAllStreamlines(domain, sdf, PARTICLE_CONFIG, rakesConfig, traceOverrides);
  const { clampFireCount, subStepCount, clampFireRate } = built;
  const paths = built.paths;
  // The colour ramp is centred on the freestream speed (see streamlineRenderer.js).
  const speedRenderOverrides = {
    freestreamSpeed: PARTICLE_CONFIG.flowSpeed, // colour is relative to the oncoming air
    ...displayOverrides(rakesConfig, domain),
    ...renderOverrides,
  };
  const renderer = createStreamlineRenderer(paths, speedRenderOverrides);

  let elapsed = 0;
  function update(dt) {
    elapsed += dt;
    renderer.update(elapsed);
  }

  return {
    object3D: renderer.object3D,
    update,
    resetTime() { elapsed = 0; renderer.update(0); },
    setVisibleGroups: renderer.setVisibleGroups,
    setDensity: renderer.setDensity,
    setPulseWidth: renderer.setPulseWidth,
    groupNames: renderer.groupNames,
    streamlineCount: paths.length,
    vertexCount: renderer.vertexCount,
    triangleCount: renderer.triangleCount,
    clampFireCount,
    subStepCount,
    clampFireRate,
  };
}
