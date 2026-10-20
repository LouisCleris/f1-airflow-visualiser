// Assertion 7 support: speed sanity probes. Samples the physical field's speed (the same quantity the streamline
// colour is driven by) at named points around the car (or the Falcon 6X) and checks it is slower / faster than the
// oncoming air in the direction known aerodynamics gives. Probe points are found by marching from open air in the domain's own
// flow/right/up basis until the signed distance field reports a surface a fixed standoff away, so they sit on the
// real bodywork wherever the model puts it. Pure numbers, no browser needed.

import { anchorToWorld, directionToWorld } from '../src/particles/anchors.js';
import { createVectorField } from '../src/particles/vectorField.js';
import { buildWakes } from '../src/particles/wakes.js';

export const PROBE_STANDOFF = 0.04; // world units off the surface
export const PROBE_MARGIN = 0.03;   // "slower" must be below (1 - margin) x freestream, "faster" above (1 + margin)

// fractions: a = alongFlow, l = lateral, v = vertical (see src/particles/anchors.js). `march` finds the surface:
// the point starts at `from` and travels along `dir` (downstream / up / down / inboard) until it is PROBE_STANDOFF
// from the bodywork. `at` is a fixed point instead.
export const SPEED_PROBES = [
  // slower than the oncoming air
  { name: 'nose tip', expect: 'slower', from: { a: -1.2, l: 0, v: 0.42 }, dir: 'downstream' },
  { name: 'front face of front tyre (left)', expect: 'slower', from: { a: -1.0, l: 0.85, v: 0.3 }, dir: 'downstream' },
  { name: 'front face of front tyre (right)', expect: 'slower', from: { a: -1.0, l: -0.85, v: 0.3 }, dir: 'downstream' },
  { name: 'front face of halo', expect: 'slower', from: { a: -0.6, l: 0, v: 0.9 }, dir: 'downstream' },
  { name: 'front face of airbox', expect: 'slower', from: { a: -0.3, l: 0, v: 0.97 }, dir: 'downstream' },
  { name: 'top of front wing (left)', expect: 'slower', from: { a: -0.92, l: 0.4, y: 0.7 }, dir: 'down' },
  { name: 'top of front wing (right)', expect: 'slower', from: { a: -0.92, l: -0.4, y: 0.7 }, dir: 'down' },
  { name: 'top of rear wing (left)', expect: 'slower', from: { a: 0.9, l: 0.3, y: 1.1 }, dir: 'down' },
  { name: 'top of rear wing (right)', expect: 'slower', from: { a: 0.9, l: -0.3, y: 1.1 }, dir: 'down' },
  { name: 'wake behind rear wheel (left)', expect: 'slower', at: { a: 1.1, l: 0.77, v: 0.3 } },
  { name: 'wake behind rear wheel (right)', expect: 'slower', at: { a: 1.1, l: -0.77, v: 0.3 } },
  { name: 'wake behind rear wing', expect: 'slower', at: { a: 1.1, l: 0, v: 0.68 } },
  { name: 'wake further behind rear wheel', expect: 'slower', at: { a: 1.25, l: 0.77, v: 0.3 } },
  // faster than the oncoming air
  { name: 'under front wing (left)', expect: 'faster', from: { a: -0.92, l: 0.4, y: 0.065 }, dir: 'up' },
  { name: 'under front wing (right)', expect: 'faster', from: { a: -0.92, l: -0.4, y: 0.065 }, dir: 'up' },
  { name: 'under floor, centre', expect: 'faster', at: { a: 0.3, l: 0, y: 0.0185 } },
  { name: 'under floor, outboard (left)', expect: 'faster', at: { a: 0.3, l: 0.6, y: 0.0185 } },
  { name: 'under floor, outboard (right)', expect: 'faster', at: { a: 0.3, l: -0.6, y: 0.0185 } },
  { name: 'outer shoulder of front tyre (left)', expect: 'faster', from: { a: -0.6, l: 1.5, v: 0.4 }, dir: 'inboard' },
  { name: 'outer shoulder of front tyre (right)', expect: 'faster', from: { a: -0.6, l: -1.5, v: 0.4 }, dir: 'inboard' },
  { name: 'over sidepod (left)', expect: 'faster', from: { a: -0.1, l: 0.6, y: 1.0 }, dir: 'down' },
  { name: 'over sidepod (right)', expect: 'faster', from: { a: -0.1, l: -0.6, y: 1.0 }, dir: 'down' },
  { name: 'under rear wing (left)', expect: 'faster', from: { a: 0.9, l: 0.3, y: 0.5 }, dir: 'up' },
  { name: 'under rear wing (right)', expect: 'faster', from: { a: 0.9, l: -0.3, y: 0.5 }, dir: 'up' },
];

// Diffuser exit must be slower than the underfloor just ahead of it.
export const DIFFUSER_PAIR = {
  exit: { name: 'diffuser exit', at: { a: 0.99, l: 0, y: 0.06 } },
  ahead: { name: 'underfloor just ahead of the diffuser', at: { a: 0.7, l: 0, y: 0.0185 } },
};

// The Falcon 6X (scene 'falcon', data/falcon/): slower at the nose, under the wing and in the tail's wake; faster over
// the wing and in the exhaust jets; and over the wing faster than under it at the same span station. Wing stations are
// mid-way between the fuselage and the tip (lateral 0.45) and toward the tip (0.75), each at about 30% chord.
const FALCON_WING_STATIONS = [{ l: 0.45, a: 0.16, side: 'inboard' }, { l: 0.75, a: 0.34, side: 'outboard' }];
const sides = [[1, 'right'], [-1, 'left']];
export const FALCON_SPEED_PROBES = [
  { name: 'nose tip', expect: 'slower', from: { a: -1.2, l: 0, v: 0.28 }, dir: 'downstream' },
  ...FALCON_WING_STATIONS.flatMap((w) => sides.flatMap(([k, side]) => [
    { name: `over the wing, ${w.side} (${side})`, expect: 'faster', from: { a: w.a, l: k * w.l, v: 0.6 }, dir: 'down' },
    { name: `under the wing, ${w.side} (${side})`, expect: 'slower', from: { a: w.a, l: k * w.l, v: -0.2 }, dir: 'up' },
  ])),
  { name: 'exhaust jet (right)', expect: 'faster', at: { a: 0.76, l: 0.185, v: 0.29 } },
  { name: 'exhaust jet (left)', expect: 'faster', at: { a: 0.76, l: -0.185, v: 0.29 } },
  { name: 'wake behind the tail cone', expect: 'slower', at: { a: 1.0, l: 0, v: 0.39 } },
];
export const FALCON_SPEED_PAIRS = FALCON_WING_STATIONS.flatMap((w) => sides.map(([k, side]) => ({
  name: `over the wing faster than under it, ${w.side} (${side})`,
  faster: { from: { a: w.a, l: k * w.l, v: 0.6 }, dir: 'down' },
  slower: { from: { a: w.a, l: k * w.l, v: -0.2 }, dir: 'up' },
})));

export function buildFieldForProbes(domain, sdf, particleConfig, rakesConfig) {
  const wakes = buildWakes(domain, rakesConfig.wakes || []);
  return createVectorField(domain, particleConfig, rakesConfig.primitives || [], rakesConfig.guideCurves || [], wakes, {}, sdf, rakesConfig.fieldRepulsion || {}, 0.0289384, rakesConfig.yaw || null);
}

function worldFor(domain, f) {
  const w = anchorToWorld(domain, { alongFlow: f.a, lateral: f.l, vertical: f.v ?? 0 });
  if (f.y !== undefined) w.y = f.y;
  return w;
}

function distanceAt(sdf, p, out) {
  if (!sdf.isNear(p.x, p.y, p.z)) return Infinity;
  return sdf.sampleAt(p.x, p.y, p.z, out);
}

/** Resolves a probe to a world point (or null if the march never met a surface). */
export function resolveProbe(domain, sdf, probe) {
  if (probe.at) return worldFor(domain, probe.at);
  const p = worldFor(domain, probe.from);
  const dirs = {
    downstream: [domain.dirX, domain.dirY, domain.dirZ],
    up: [0, 1, 0],
    down: [0, -1, 0],
    // toward the centreline from the side the probe starts on
    inboard: (() => { const s = Math.sign(probe.from.l) || 1; return [-s * domain.rightX, -s * domain.rightY, -s * domain.rightZ]; })(),
  };
  const d = dirs[probe.dir];
  const out = new Float64Array(4);
  const step = 0.005;
  for (let t = 0; t < 4; t += step) {
    const q = { x: p.x + d[0] * t, y: p.y + d[1] * t, z: p.z + d[2] * t };
    if (distanceAt(sdf, q, out) <= PROBE_STANDOFF) return q;
  }
  return null;
}

/** Speed of the field at `p`, as a fraction of freestream. */
export function speedRatio(field, domain, p, flowSpeed) {
  const v = new Float64Array(3);
  field.velocityAt(p.x, p.y, p.z, v);
  return Math.hypot(v[0], v[1], v[2]) / flowSpeed;
}

export function runSpeedProbes(domain, sdf, particleConfig, rakesConfig, scene = 'f1') {
  const field = buildFieldForProbes(domain, sdf, particleConfig, rakesConfig);
  const fs = particleConfig.flowSpeed;
  const rows = (scene === 'falcon' ? FALCON_SPEED_PROBES : SPEED_PROBES).map((probe) => {
    const p = resolveProbe(domain, sdf, probe);
    if (!p) return { name: probe.name, expect: probe.expect, ok: false, ratio: NaN, point: null, note: 'no surface found' };
    const ratio = speedRatio(field, domain, p, fs);
    const ok = probe.expect === 'slower' ? ratio < 1 - PROBE_MARGIN : ratio > 1 + PROBE_MARGIN;
    return { name: probe.name, expect: probe.expect, ok, ratio, point: p };
  });
  if (scene === 'falcon') {
    for (const pair of FALCON_SPEED_PAIRS) {
      const pf = resolveProbe(domain, sdf, pair.faster), ps = resolveProbe(domain, sdf, pair.slower);
      if (!pf || !ps) { rows.push({ name: pair.name, expect: 'over > under', ok: false, ratio: NaN, point: null, note: 'no surface found' }); continue; }
      const over = speedRatio(field, domain, pf, fs), under = speedRatio(field, domain, ps, fs);
      rows.push({ name: pair.name, expect: 'over > under', ok: over > under + 0.05, ratio: over, under, point: null });
    }
    return rows;
  }
  const exit = speedRatio(field, domain, resolveProbe(domain, sdf, DIFFUSER_PAIR.exit), fs);
  const ahead = speedRatio(field, domain, resolveProbe(domain, sdf, DIFFUSER_PAIR.ahead), fs);
  rows.push({ name: 'diffuser exit slower than underfloor ahead of it', expect: 'exit < ahead', ok: exit < ahead - 0.02, ratio: exit, ahead, point: null });
  return rows;
}
