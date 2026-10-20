// Seed selection for traced streamlines -- surface-scatter kept exactly as
// Phase 3.5 revised it (seeding from an upstream plane, even a
// feature-anchored one, cannot guarantee surface coverage: deflection
// pushes lines' PATHS away from the body, so the seeds that would end up
// hugging bodywork are exactly the ones least likely to survive from an
// upstream release). Seeds are scattered directly ON the car's surface
// (projected onto the real mesh surface via the baked signed distance field,
// then offset a small distance outward along its gradient), one region at a
// time, with a target line count PER COMPONENT GROUP so coverage can be
// tuned region by region in data/rakes.json without touching this code.
//
// Phase 3.6 addition (section 4): within each group, candidates are now
// scored by the field's velocity-gradient magnitude AND |vorticity| at the
// seed point, and the highest-scoring `count` survive (subject to the same
// minimum-separation rule) rather than just the first `count` that pass
// the surface-validity check. Both signals come from the field that
// already exists (vectorField.js/curlAt()) -- nothing new is computed to
// produce them, per PHASE-3.6.md's "this is a derivative of the field that
// already exists... not a solver output."
//
// Zero dependency on three.js/DOM, like the rest of src/particles/.

import { anchorToWorld } from './anchors.js';
import { curlAt } from './vectorField.js';

export const SEEDING_CONFIG = {
  lineCountCap: 150, // hard ceiling across all groups combined, applied in
  // the order groups are listed -- a safety net, not the primary control;
  // per-group `count` values are the actual tuning knobs.
  candidateMultiplier: 6, // candidates attempted per group, relative to
  // that group's target `count`, since surface rejection-sampling and the
  // minimum-separation rule both discard some fraction of attempts
  minSeparationWorld: 0.045,
  cellWorld: 0.0289384, // world size of one occupancy-grid cell -- the unit the *Cells values below are in
  maxSurfaceDistanceCells: 9, // a random sample further than this from any
  // surface is rejected and resampled -- it landed in open air well
  // clear of the component, not "near its surface"
  surfaceOffsetCells: 1.6, // how far off the surface (in grid-pitch units)
  // a seed is placed, along the found cell's own normal
  freeClearanceCells: 2.5, // 'free' seeds (open air) must be at least this far from the surface
  gradientWeight: 1.0, // score = gradientWeight * |grad(speed)| + vorticityWeight * |curl(V)|
  vorticityWeight: 1.0,
  scoreSampleH: 0.03, // finite-difference step for both the gradient and curlAt() terms
};

function randRange(a, b) {
  return a + Math.random() * (b - a);
}

/** A random point inside a region's fractional (alongFlow/lateral/vertical) bounding box. */
function sampleRegionPoint(domain, region) {
  return anchorToWorld(domain, {
    alongFlow: randRange(region.alongFlow[0], region.alongFlow[1]),
    lateral: randRange(region.lateral[0], region.lateral[1]),
    vertical: randRange(region.vertical[0], region.vertical[1]),
  });
}

function mirrorRegion(region) {
  return { alongFlow: region.alongFlow, lateral: [-region.lateral[1], -region.lateral[0]], vertical: region.vertical };
}

/** Expands `mirror: true` group entries into both sides -- shared by generateSeeds() and generateTopUpSeeds() so both draw from the exact same region list. */
function expandGroups(groups) {
  return groups.flatMap((g) => (
    g.mirror ? [g, { ...g, name: `${g.name}-mirror`, region: mirrorRegion(g.region), ...(g.ring ? { ring: { ...g.ring, lateral: -g.ring.lateral } } : {}) }] : [g]
  ));
}

/**
 * One rejection-sampling attempt: pick a random point in `region`; if it lies
 * within `maxSurfaceDistanceCells` of the real surface (per the signed
 * distance field), project it onto that surface along the field's gradient
 * and offset it outward by `surfaceOffsetCells`. Returns null if the sample
 * missed (caller retries).
 */
/**
 * Mid-gap seed for the underfloor group: the air under the floor lives in a
 * ~1.4-cell slab between the ground plane and the floor's underside, so the
 * usual "project onto the nearest surface, step out by an offset" rule has no
 * room (and the nearest surface may be the ground). Instead: take the (x, z)
 * of a region sample, scan upward from the ground for the first height where
 * the distance field says we have reached the floor, and seed halfway.
 */
function generateMidGapSeed(domain, sdf, region, cfg) {
  const p = sampleRegionPoint(domain, region);
  const groundY = sdf.groundY ?? 0;
  const s = new Float64Array(4);
  let floorY = null;
  for (let y = groundY + 0.004; y < groundY + 0.12; y += 0.001) {
    if (!sdf.isNear(p.x, y, p.z)) return null;
    if (sdf.sampleAt(p.x, y, p.z, s) < 0.002) { floorY = y; break; }
  }
  if (floorY === null) return null; // no floor above this (x, z)
  const gap = floorY - groundY;
  if (gap < 0.03 || gap > 0.09) return null; // not the underfloor slab (too tight / a different feature)
  return { x: p.x, y: groundY + gap / 2, z: p.z };
}

/**
 * Open-air seed (`seedMode: 'free'`): a random point in the region that is clear of the surface by at least
 * `freeClearanceCells`. For flow that does not start on a surface -- the air ahead of the nose, a wingtip vortex, the
 * exhaust and the wake behind the tail -- where there is nothing to project onto.
 */
function generateFreeSeed(domain, sdf, region, cfg) {
  const p = sampleRegionPoint(domain, region);
  if (sdf && sdf.isNear(p.x, p.y, p.z)) {
    const s = new Float64Array(4);
    if (sdf.sampleAt(p.x, p.y, p.z, s) < cfg.freeClearanceCells * cfg.cellWorld) return null;
  }
  return { x: p.x, y: p.y, z: p.z };
}

/**
 * Ring seed (`seedMode: 'ring'`): an open-air point on a ring round an axis parallel to the flow -- the group's
 * `ring: { lateral, vertical, radius: [min, max] }` (axis position as fractions, radius in world units), at an
 * alongFlow drawn from the region. For flow that is organised round an axis: a tip vortex, an intake, a jet.
 */
function generateRingSeed(domain, sdf, region, ring, cfg) {
  const c = anchorToWorld(domain, { alongFlow: randRange(region.alongFlow[0], region.alongFlow[1]), lateral: ring.lateral, vertical: ring.vertical });
  const a = Math.random() * 2 * Math.PI;
  const r = randRange(ring.radius[0], ring.radius[1]);
  const cr = Math.cos(a) * r, sr = Math.sin(a) * r;
  const p = { x: c.x + domain.rightX * cr + domain.upX * sr, y: c.y + domain.rightY * cr + domain.upY * sr, z: c.z + domain.rightZ * cr + domain.upZ * sr };
  if (sdf && sdf.isNear(p.x, p.y, p.z)) {
    const s = new Float64Array(4);
    if (sdf.sampleAt(p.x, p.y, p.z, s) < cfg.freeClearanceCells * cfg.cellWorld) return null;
  }
  return p;
}

function generateSurfaceSeed(domain, sdf, region, cfg, offsetCells = cfg.surfaceOffsetCells, mode = null, ring = null) {
  if (mode === 'midGap') return generateMidGapSeed(domain, sdf, region, cfg);
  if (mode === 'free') return generateFreeSeed(domain, sdf, region, cfg);
  if (mode === 'ring') return generateRingSeed(domain, sdf, region, ring, cfg);
  const p = sampleRegionPoint(domain, region);
  if (!sdf || !sdf.isNear(p.x, p.y, p.z)) return null;
  const s = new Float64Array(4);
  const d = sdf.sampleAt(p.x, p.y, p.z, s);
  if (d >= sdf.band * 0.98 || (s[1] === 0 && s[2] === 0 && s[3] === 0)) return null;
  if (Math.abs(d) > cfg.maxSurfaceDistanceCells * cfg.cellWorld) return null;
  // Project onto the surface (two Newton-style passes, since the gradient
  // is only locally exact), then step out to the requested offset.
  let x = p.x, y = p.y, z = p.z;
  for (let it = 0; it < 3; it++) {
    const di = sdf.sampleAt(x, y, z, s);
    x -= s[1] * di; y -= s[2] * di; z -= s[3] * di;
  }
  sdf.sampleAt(x, y, z, s);
  const offset = cfg.cellWorld * offsetCells;
  const seed = { x: x + s[1] * offset, y: y + s[2] * offset, z: z + s[3] * offset };
  // A thin double-wall feature (wing element, diffuser strake) or a concave
  // corner can leave the offset point inside or too near a DIFFERENT part of
  // the body -- reject rather than hand back a seed that starts in bodywork.
  if (sdf.sampleAt(seed.x, seed.y, seed.z, s) < offset * 0.5) return null;
  return seed;
}

function tooCloseToAny(p, points, minSep) {
  const minSep2 = minSep * minSep;
  return points.some((s) => {
    const dx = p.x - s.x, dy = p.y - s.y, dz = p.z - s.z;
    return dx * dx + dy * dy + dz * dz < minSep2;
  });
}

/**
 * Scores a candidate seed by the field's velocity-gradient magnitude plus
 * |vorticity| at that point (PHASE-3.6.md section 4) -- both quantities the
 * field already computes, sampled once at the seed itself (no pre-trace:
 * seeding no longer needs one now that seeds start on the real surface).
 */
function scoreSeed(seed, field, cfg) {
  const h = cfg.scoreSampleH;
  const v = new Float64Array(3);
  function speedAt(x, y, z) { field.velocityAt(x, y, z, v); return Math.hypot(v[0], v[1], v[2]); }
  const gx = speedAt(seed.x + h, seed.y, seed.z) - speedAt(seed.x - h, seed.y, seed.z);
  const gy = speedAt(seed.x, seed.y + h, seed.z) - speedAt(seed.x, seed.y - h, seed.z);
  const gz = speedAt(seed.x, seed.y, seed.z + h) - speedAt(seed.x, seed.y, seed.z - h);
  const gradMag = Math.hypot(gx, gy, gz) / (2 * h);

  const curlOut = new Float64Array(3);
  curlAt(field, seed.x, seed.y, seed.z, h, curlOut, v);
  const vortMag = Math.hypot(curlOut[0], curlOut[1], curlOut[2]);

  return cfg.gradientWeight * gradMag + cfg.vorticityWeight * vortMag;
}

/**
 * Each group's own line target. `lineCountCap` is shared out in proportion to
 * the groups' configured `count`s (a mirrored group counts once per side), so
 * no group is starved by listing order -- the old rule filled the cap in
 * listing order and left the later groups (the floor, rear wing) with almost
 * nothing before culling even started.
 * @returns {Record<string, number>} group name (mirror copies included) -> target
 */
export function computeGroupTargets(rakesConfig, overrides = {}) {
  const cfg = { ...SEEDING_CONFIG, ...overrides };
  const groups = expandGroups(rakesConfig.groups);
  const total = groups.reduce((n, g) => n + g.count, 0);
  const scale = Math.min(1, cfg.lineCountCap / Math.max(1, total));
  const targets = {};
  for (const g of groups) targets[g.name] = Math.max(1, Math.round(g.count * scale));
  return targets;
}

/**
 * Builds the final seed list from data/rakes.json's per-group component
 * regions. Without a baked signed distance field there is no surface to scatter
 * from, so this returns an empty list -- streamlines simply don't render
 * rather than falling back to some other seeding method (matches
 * streamlineField.js's existing "no grid -> no meaningful streamlines"
 * posture from Phase 3.5's first pass).
 *
 * @param {ReturnType<import('./domain.js').domainFromBounds>} domain
 * @param {import('./sdf.js').Sdf|null} sdf
 * @param {ReturnType<import('./vectorField.js').createVectorField>} field
 * @param {{ groups: object[] }} rakesConfig data/rakes.json
 * @param {Partial<typeof SEEDING_CONFIG>} [overrides]
 * @returns {{x:number,y:number,z:number}[]}
 */
export function generateSeeds(domain, sdf, field, rakesConfig, overrides = {}) {
  const cfg = { ...SEEDING_CONFIG, ...overrides };
  if (!sdf) return [];

  const groups = expandGroups(rakesConfig.groups);
  const targets = computeGroupTargets(rakesConfig, cfg);

  const accepted = [];
  for (const group of groups) {
    const groupTarget = targets[group.name];
    const maxAttempts = Math.max(1, Math.round(group.count * cfg.candidateMultiplier));

    const candidates = [];
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const seed = generateSurfaceSeed(domain, sdf, group.region, cfg, cfg.surfaceOffsetCells, group.seedMode, group.ring);
      if (!seed) continue;
      seed.score = scoreSeed(seed, field, cfg);
      seed.group = group.name;
      candidates.push(seed);
    }
    candidates.sort((a, b) => b.score - a.score); // best (highest gradient+vorticity) first

    let groupAccepted = 0;
    for (const candidate of candidates) {
      if (groupAccepted >= groupTarget) break;
      if (tooCloseToAny(candidate, accepted, cfg.minSeparationWorld)) continue;
      accepted.push(candidate);
      groupAccepted++;
    }
  }

  return accepted;
}

/**
 * Generates NEW surface seeds group by group: `needByGroup[name]` seeds for
 * each named group, drawn only from that group's own region (so a refill never
 * spills into another group), each checked against `minSeparationWorld` from
 * `avoidPoints` and from what this call has accepted so far.
 *
 * `offsetCellsByGroup[name]` (optional) overrides how far off the surface that
 * group's seeds start -- streamlines.js raises it for groups whose lines keep
 * failing the cull, rather than relaxing the cull.
 *
 * @param {Record<string, number>} needByGroup
 * @param {{x:number,y:number,z:number}[]} avoidPoints
 * @param {Record<string, number>} [offsetCellsByGroup]
 * @returns {{x:number,y:number,z:number,group:string}[]}
 */
export function generateTopUpSeeds(domain, sdf, rakesConfig, needByGroup, avoidPoints, offsetCellsByGroup = {}, overrides = {}) {
  const cfg = { ...SEEDING_CONFIG, ...overrides };
  if (!sdf) return [];
  const accepted = [];
  for (const group of expandGroups(rakesConfig.groups)) {
    const need = needByGroup[group.name] || 0;
    if (need <= 0) continue;
    const offset = offsetCellsByGroup[group.name] ?? cfg.surfaceOffsetCells;
    let got = 0;
    for (let attempt = 0; attempt < need * 30 && got < need; attempt++) {
      const candidate = generateSurfaceSeed(domain, sdf, group.region, cfg, offset, group.seedMode, group.ring);
      if (!candidate) continue;
      if (tooCloseToAny(candidate, avoidPoints, cfg.minSeparationWorld)) continue;
      if (tooCloseToAny(candidate, accepted, cfg.minSeparationWorld)) continue;
      candidate.group = group.name;
      accepted.push(candidate);
      got++;
    }
  }
  return accepted;
}
