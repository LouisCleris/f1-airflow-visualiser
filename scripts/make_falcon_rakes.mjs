// Writes data/falcon/rakes.json, the Falcon 6X flow authoring (guide curves, primitives, seed groups, display).
// The positions are fractions in the domain's alongFlow / lateral / vertical convention (src/particles/anchors.js),
// measured from the baked distance field (data/falcon/sdf.bin): wing leading/trailing edges and surfaces per span
// station, the fuselage underside, the nacelle axis and lip, the fin and tailplane, the winglet tip.
//
// Usage: node scripts/make_falcon_rakes.mjs, then npm run bake:falcon -- --lines
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'falcon', 'rakes.json');
const r3 = (x) => Math.round(x * 1000) / 1000;
const P = (a, l, v, s) => (s === undefined ? { alongFlow: r3(a), lateral: r3(l), vertical: r3(v) } : { alongFlow: r3(a), lateral: r3(l), vertical: r3(v), speedScale: s });

// wing stations: lateral -> LE, TE, upper surface at chord 0.05/0.5/1.0, lower surface at 0.05/0.5/1.0
const WING = [
  [0.26, -0.060, 0.260, 0.200, 0.186, 0.168, 0.126, 0.106, 0.104],
  [0.36, 0.016, 0.288, 0.198, 0.184, 0.166, 0.136, 0.118, 0.104],
  [0.46, 0.092, 0.320, 0.196, 0.180, 0.162, 0.148, 0.130, 0.116],
  [0.56, 0.164, 0.368, 0.190, 0.176, 0.154, 0.148, 0.132, 0.124],
  [0.66, 0.232, 0.412, 0.186, 0.172, 0.156, 0.148, 0.134, 0.120],
  [0.76, 0.300, 0.460, 0.182, 0.168, 0.152, 0.150, 0.136, 0.126],
  [0.86, 0.372, 0.508, 0.178, 0.164, 0.144, 0.150, 0.136, 0.130],
  [0.93, 0.416, 0.540, 0.172, 0.162, 0.146, 0.152, 0.138, 0.130],
];

const curves = [];
for (const [l, le, te, u0, u5, u1, b0, b5, b1] of WING) {
  const c = te - le;
  const mid = (u0 + b0) / 2;
  const tag = String(Math.round(l * 100)).padStart(2, '0');
  // Fast just over the upper surface: up-wash ahead of the leading edge, a suction peak just behind it, easing off to
  // the trailing edge, then down-wash. Drifts slightly inboard over the top (swept wing).
  curves.push({
    name: `wing-top-${tag}`, mirror: true, radius: 0.15, weight: 0.85, speedScale: 1.0,
    points: [
      P(le - 0.32, l, mid - 0.012, 1.0),
      P(le - 0.11, l, mid + 0.022, 1.04),
      P(le + 0.10 * c, l - 0.004, u0 + 0.040, 1.42),
      P(le + 0.45 * c, l - 0.010, u5 + 0.038, 1.32),
      P(le + 0.80 * c, l - 0.015, (u5 + u1) / 2 + 0.034, 1.18),
      P(te + 0.03, l - 0.020, u1 + 0.024, 1.08),
      P(te + 0.20, l - 0.022, u1 - 0.016, 1.02),
      P(te + 0.45, l - 0.022, u1 - 0.060, 1.0),
    ],
  });
  // A gentler layer higher up, so the speed-up fades out with height instead of stopping at one curve's radius.
  curves.push({
    name: `wing-top-outer-${tag}`, mirror: true, radius: 0.19, weight: 0.65, speedScale: 1.0,
    points: [
      P(le - 0.32, l, mid + 0.05, 1.0),
      P(le - 0.10, l, mid + 0.085, 1.02),
      P(le + 0.15 * c, l - 0.004, u0 + 0.115, 1.14),
      P(le + 0.55 * c, l - 0.008, u5 + 0.110, 1.11),
      P(te + 0.04, l - 0.012, u1 + 0.095, 1.05),
      P(te + 0.25, l - 0.014, u1 + 0.050, 1.01),
      P(te + 0.50, l - 0.014, u1 + 0.005, 1.0),
    ],
  });
  // Slow under the lower surface (higher pressure), drifting slightly outboard; gentle down-wash behind.
  curves.push({
    name: `wing-bottom-${tag}`, mirror: true, radius: 0.14, weight: 0.85, speedScale: 1.0,
    points: [
      P(le - 0.32, l, mid - 0.030, 1.0),
      P(le - 0.11, l, mid - 0.016, 0.96),
      P(le + 0.10 * c, l + 0.004, b0 - 0.036, 0.84),
      P(le + 0.45 * c, l + 0.010, b5 - 0.036, 0.85),
      P(le + 0.80 * c, l + 0.015, (b5 + b1) / 2 - 0.033, 0.89),
      P(te + 0.03, l + 0.020, b1 - 0.030, 0.94),
      P(te + 0.20, l + 0.022, b1 - 0.050, 0.98),
      P(te + 0.45, l + 0.022, b1 - 0.070, 1.0),
    ],
  });
}

// Nose and fuselage: stagnation just ahead of the nose, the air dividing over, round and under it, then running along.
// No slowing further upstream than the stagnation region itself.
curves.push(
  { name: 'nose-over-fuselage', radius: 0.2, weight: 0.85, speedScale: 1.0, points: [
    P(-1.30, 0, 0.30, 1.0), P(-1.06, 0, 0.33, 0.55), P(-0.96, 0, 0.42, 0.72), P(-0.86, 0, 0.53, 1.02), P(-0.75, 0, 0.61, 1.14),
    P(-0.60, 0, 0.625, 1.10), P(-0.30, 0, 0.59, 1.06), P(0.00, 0, 0.54, 1.04), P(0.25, 0, 0.52, 1.02), P(0.42, 0, 0.53, 1.0)] },
  { name: 'nose-round-fuselage', mirror: true, radius: 0.18, weight: 0.8, speedScale: 1.0, points: [
    P(-1.30, 0, 0.28, 1.0), P(-1.06, 0.035, 0.28, 0.58), P(-0.95, 0.09, 0.30, 0.82), P(-0.82, 0.145, 0.32, 1.04), P(-0.60, 0.17, 0.34, 1.08),
    P(-0.30, 0.18, 0.35, 1.06), P(0.00, 0.19, 0.36, 1.04), P(0.22, 0.18, 0.41, 1.02), P(0.36, 0.15, 0.47, 1.0)] },
  // Under the fuselage: ~0.03 world units below the measured underside (bottom at -0.9: 0.19, -0.5: 0.11, -0.1: 0.05,
  // 0.3: 0.01 at the wing-body fairing, then rising up the aft fuselage), at about the freestream speed after the nose.
  // (It used to dip 0.06 below the lowest point of the aircraft and slow the air 0.8 world units ahead of the nose,
  // which sent a fan of blue lines down under the fuselage.)
  { name: 'nose-under-fuselage', radius: 0.16, weight: 0.8, speedScale: 1.0, points: [
    P(-1.30, 0, 0.25, 1.0), P(-1.07, 0, 0.225, 0.62), P(-0.93, 0, 0.17, 0.86), P(-0.78, 0, 0.13, 0.98), P(-0.55, 0, 0.09, 1.0),
    P(-0.30, 0, 0.04, 1.0), P(-0.05, 0, 0.015, 1.0), P(0.20, 0, -0.01, 1.0), P(0.36, 0, -0.015, 1.0), P(0.50, 0, 0.05, 1.0),
    P(0.64, 0, 0.12, 1.0), P(0.80, 0, 0.21, 1.0), P(1.00, 0, 0.26, 1.0)] },
);

// Engines (nacelle axis at lateral 0.185, vertical 0.30; intake lip at along 0.40, exhaust exit at 0.68).
const EL = 0.185, EV = 0.30;
curves.push(
  // air converging into the intake from above, outboard and below, slowing as it reaches the lip (at cruise the
  // intake takes in a stream tube narrower than its own face, so the air just ahead of it decelerates)
  { name: 'intake-from-above', mirror: true, radius: 0.12, weight: 0.85, speedScale: 1.0, points: [
    P(0.12, EL, EV + 0.17, 1.0), P(0.26, EL, EV + 0.12, 0.95), P(0.36, EL, EV + 0.05, 0.86), P(0.44, EL, EV + 0.005, 0.8)] },
  { name: 'intake-from-outboard', mirror: true, radius: 0.12, weight: 0.85, speedScale: 1.0, points: [
    P(0.12, EL + 0.085, EV, 1.0), P(0.26, EL + 0.06, EV, 0.95), P(0.36, EL + 0.025, EV, 0.86), P(0.44, EL + 0.003, EV, 0.8)] },
  { name: 'intake-from-below', mirror: true, radius: 0.12, weight: 0.85, speedScale: 1.0, points: [
    P(0.12, EL, EV - 0.15, 1.0), P(0.26, EL, EV - 0.105, 0.95), P(0.36, EL, EV - 0.045, 0.86), P(0.44, EL, EV - 0.005, 0.8)] },
  // the jet leaving each exhaust: fast at the nozzle, mixing back to the freestream within about half a fuselage length
  { name: 'exhaust-jet', mirror: true, radius: 0.08, weight: 0.9, speedScale: 1.0, points: [
    P(0.58, EL, EV - 0.01, 1.2), P(0.68, EL, EV - 0.01, 1.75), P(0.78, EL, EV - 0.012, 1.7), P(0.92, EL, EV - 0.015, 1.45),
    P(1.08, EL, EV - 0.018, 1.18), P(1.25, EL, EV - 0.02, 1.03), P(1.45, EL, EV - 0.022, 1.0)] },
  // round the outside of the nacelle
  { name: 'nacelle-outboard', mirror: true, radius: 0.11, weight: 0.75, speedScale: 1.0, points: [
    P(0.25, 0.265, EV, 1.0), P(0.40, 0.272, EV, 1.04), P(0.50, 0.268, EV, 1.12), P(0.62, 0.255, EV, 1.08), P(0.76, 0.24, EV, 1.02), P(0.95, 0.235, EV, 1.0)] },
  { name: 'nacelle-over', mirror: true, radius: 0.11, weight: 0.75, speedScale: 1.0, points: [
    P(0.25, EL, 0.43, 1.0), P(0.40, EL, 0.45, 1.04), P(0.50, EL, 0.445, 1.12), P(0.62, EL, 0.425, 1.08), P(0.76, EL, 0.39, 1.02), P(0.95, EL, 0.375, 1.0)] },
);

// Wingtip: the higher-pressure air under the wing escapes outboard round the tip, up the outside of the winglet and
// inboard over its top -- the start of the trailing vortex (the `winglet-tip` primitive carries the spiral on). The
// winglet tip is at lateral 1.0, vertical 0.29; its trailing edge at alongFlow ~0.58.
curves.push({ name: 'tip-curl', mirror: true, radius: 0.09, weight: 0.7, speedScale: 1.0, points: [
  P(0.36, 0.90, 0.105, 0.92), P(0.46, 0.95, 0.11, 0.95), P(0.53, 1.015, 0.15, 1.05), P(0.57, 1.03, 0.23, 1.12), P(0.61, 1.01, 0.32, 1.15),
  P(0.66, 0.975, 0.33, 1.12)] });

// Tail: dividing at the fin leading edge (both sides), and over / under the tailplane.
for (const [v, le, te] of [[0.72, 0.66, 0.866], [0.88, 0.745, 0.902]]) {
  curves.push({ name: `fin-side-${Math.round(v * 100)}`, mirror: true, radius: 0.1, weight: 0.8, speedScale: 1.0, points: [
    P(le - 0.25, 0, v, 1.0), P(le - 0.03, 0.008, v, 0.9), P(le + 0.04, 0.034, v, 1.1), P((le + te) / 2, 0.036, v, 1.07), P(te + 0.02, 0.022, v, 1.0), P(te + 0.25, 0.006, v, 1.0)] });
}
for (const [l, le, te, top, bot] of [[0.15, 0.706, 0.871, 0.580, 0.538], [0.3, 0.808, 0.940, 0.600, 0.568]]) {
  const mid = (top + bot) / 2;
  curves.push({ name: `tailplane-over-${Math.round(l * 100)}`, mirror: true, radius: 0.09, weight: 0.8, speedScale: 1.0, points: [
    P(le - 0.22, l, mid + 0.01, 1.0), P(le - 0.03, l, mid + 0.02, 0.96), P(le + 0.25 * (te - le), l, top + 0.035, 1.06), P(te + 0.02, l, top + 0.025, 1.02), P(te + 0.25, l, top + 0.01, 1.0)] });
  curves.push({ name: `tailplane-under-${Math.round(l * 100)}`, mirror: true, radius: 0.09, weight: 0.8, speedScale: 1.0, points: [
    P(le - 0.22, l, mid - 0.01, 1.0), P(le - 0.03, l, mid - 0.02, 0.96), P(le + 0.25 * (te - le), l, bot - 0.035, 1.06), P(te + 0.02, l, bot - 0.025, 1.02), P(te + 0.25, l, bot - 0.01, 1.0)] });
}

const primitives = [
  // One trailing vortex per winglet tip. Mirroring flips the sign (primitives.js), so the two spin in opposite
  // directions: each one up outboard of its tip and inboard over the top, the air rolling up from below the wing.
  // Tight core (0.065 world units, about 0.3 m at full scale), turning about three times in the first fuselage length
  // behind the tip -- a long, smooth corkscrew; a faster swirl read as a zigzag from the side -- fading over about one
  // fuselage length (5.5 world units).
  { type: 'vortex', name: 'winglet-tip', anchor: P(0.56, 1.0, 0.29), axis: { along: 1, lateral: 0, vertical: 0 }, strength: 1.7, coreRadius: 0.065, decayLength: 6.0, profile: 'tight', mirror: true },
  // a gentle pull into each intake and push out of each exhaust (texture on top of the curves above)
  { type: 'sourceSink', name: 'engine-intake', anchor: P(0.43, EL, EV), strength: -0.03, coreRadius: 0.1, decayLength: 0.6, mirror: true },
  { type: 'sourceSink', name: 'engine-exhaust', anchor: P(0.685, EL, EV - 0.01), strength: 0.012, coreRadius: 0.08, decayLength: 0.5, mirror: true },
];

// Where lines end: at each fan face (air drawn into the intake) and just inside each exhaust (where the jet starts).
const terminals = [
  { name: 'fan-face', anchor: P(0.43, EL, EV), radius: 0.1, mirror: true },
  { name: 'exhaust-core', anchor: P(0.655, EL, EV - 0.01), radius: 0.075, mirror: true },
];

const wakes = [
  // a narrow, quiet wake behind the tail cone: slower air, a little loss of order, recovering within a few metres
  { name: 'tail', anchor: P(0.80, 0, 0.39), axis: { along: 1, lateral: 0, vertical: 0 }, expansionAngle: 0.13, decayLength: 1.6, speedDeficit: 0.3 },
];

const G = (name, count, region, extra = {}) => ({ name, count, ...extra, region: { alongFlow: region[0], lateral: region[1] || [0, 0], vertical: region[2] || [0, 0] } });
const groups = [
  G('nose', 30, [[-1.03, -0.72], [-0.12, 0.12], [0.12, 0.62]]),
  G('fuselage-top', 16, [[-0.72, 0.42], [-0.08, 0.08], [0.44, 0.66]]),
  G('fuselage-side', 10, [[-0.7, 0.3], [0.08, 0.16], [0.22, 0.5]], { mirror: true }),
  G('fuselage-belly', 14, [[-0.7, 0.75], [-0.1, 0.1], [-0.03, 0.14]]),
  G('wing-root', 8, [[-0.32, 0.3], [0.1, 0.24], [0.04, 0.3]], { mirror: true }),
  G('wing-top', 30, [[-0.08, 0.56], [0.24, 0.96], [0.15, 0.26]], { mirror: true }),
  G('wing-bottom', 22, [[-0.08, 0.56], [0.24, 0.96], [0.06, 0.14]], { mirror: true }),
  G('upwash', 12, [[-0.32, 0.3], [0.26, 0.94], [0.11, 0.2]], { mirror: true, seedMode: 'free' }),
  G('downwash', 12, [[0.33, 0.68], [0.3, 0.94], [0.09, 0.17]], { mirror: true, seedMode: 'free' }),
  // the underside near the tip and the winglet itself: the air that curls round the tip
  G('winglet', 6, [[0.36, 0.6], [0.86, 1.0], [0.06, 0.31]], { mirror: true }),
  // a few lines on one narrow ring round each vortex core, just behind the winglet: they spiral down the core together
  // as one tidy helix (lines at many radii and starting points crossed each other and read as a tangle)
  G('winglet-vortex', 5, [[0.6, 0.63]], { mirror: true, seedMode: 'ring', ring: { lateral: 1.0, vertical: 0.29, radius: [0.055, 0.068] } }),
  // a ring a little wider than the intake lip, just ahead of it: lines that visibly converge into the intake
  G('engine-intake', 12, [[0.3, 0.35]], { mirror: true, seedMode: 'ring', ring: { lateral: EL, vertical: EV, radius: [0.13, 0.19] } }),
  G('engine-side', 8, [[0.42, 0.66], [0.15, 0.25], [0.18, 0.42]], { mirror: true }),
  // inside the jet just behind the nozzle
  G('engine-exhaust', 10, [[0.69, 0.72]], { mirror: true, seedMode: 'ring', ring: { lateral: EL, vertical: EV - 0.01, radius: [0.0, 0.06] } }),
  G('tail-fin', 9, [[0.55, 0.92], [0.0, 0.05], [0.62, 1.0]], { mirror: true }),
  G('tail-stabiliser', 9, [[0.64, 1.0], [0.05, 0.43], [0.5, 0.64]], { mirror: true }),
];

const rakes = {
  _comment: 'Falcon 6X flow, authored the same way as the F1 (data/rakes.json; see its comments and src/particles/anchors.js). Fractions are of the aircraft itself: alongFlow -1 = nose, +1 = rearmost point (tailplane tip); lateral +-1 = wingtips; vertical 0..1 = lowest to highest point. The aircraft is placed at a fixed cruise attitude (src/sceneConfig.js pitchDeg), so the oncoming air is horizontal and meets the wing at that angle. Group names are the flow groups data/components.json uses for "Show flow around this part only". Generated by scripts/make_falcon_rakes.mjs: edit that, run it, then re-bake with npm run bake:falcon -- --lines.',
  seeding: { lineCountCap: 400, candidateMultiplier: 6, minSeparationWorld: 0.03, maxSurfaceDistanceCells: 3, surfaceOffsetCells: 1.6 },
  fieldRepulsion: { enabled: true, radiusCells: 3, strengthFraction: 1 },
  smoothing: { enabled: true, maxSegmentWorld: 0.005, subdivideWithinCells: 2.5, finalStandoffCells: 0.5, rounds: 3, passes: 4, alpha: 0.5 },
  culling: { enabled: true, minMaxDeviationFraction: 0.15, maxClampFireCount: 100, maxTopUpRounds: 14, maxTurnDegrees: 30, maxSeedOffsetCells: 3.2, seedOffsetStepCells: 0.4 },
  groups,
  _traceComment: 'Every line starts on one plane about one fuselage length ahead of the nose (alongFlow -3) and ends about one fuselage length behind the winglets (2.6), so the tip vortices can be followed that far. A step that would turn more than 10 degrees (inside a vortex core) is subdivided (src/particles/streamlines.js).',
  trace: { upstreamStopAlong: -3.0, downstreamStopAlong: 2.6, maxTurnPerStepDeg: 10 },
  _displayComment: 'Focus envelope (src/particles/streamlineRenderer.js): lines are drawn at full strength within focusFade[0] world units of these capsules (fuselage, wings, engines and their jets, fin, tailplane, the two vortex cores) and fade out by focusFade[1], so the undisturbed far field drops away. Along the flow the envelope reaches focusAlongScale times further ([upstream, downstream]): lines are traced from one fuselage length ahead of the nose but read from about a third of one, because at full strength further out they converge on the camera in the front view. radius is in world units. Lines closer to the camera than nearFade[0] are hidden, fading in by nearFade[1] (camera close-ups). A segment pointing almost straight at the camera fades out (viewFade, |cos| of the angle to the line of sight), so lines seen end-on never show as radial spikes.',
  display: {
    alphaUndisturbed: 0.06,
    nearFade: [1.4, 3.0],
    viewFade: [0.97, 0.997],
    focusFade: [0.12, 0.7],
    focusAlongScale: [2.5, 3.5],
    focus: [
      { name: 'fuselage', from: P(-1.0, 0, 0.29), to: P(0.86, 0, 0.47), radius: 0.28 },
      { name: 'wing', from: P(0.08, 0.12, 0.15), to: P(0.48, 0.98, 0.2), radius: 0.16, mirror: true },
      { name: 'engine-and-jet', from: P(0.40, EL, EV), to: P(1.2, EL, EV - 0.02), radius: 0.15, mirror: true },
      { name: 'fin', from: P(0.70, 0, 0.62), to: P(0.86, 0, 0.98), radius: 0.12 },
      { name: 'tailplane', from: P(0.82, 0, 0.6), to: P(0.92, 0.43, 0.6), radius: 0.1, mirror: true },
      // ends well before the lines do (2.6), so each vortex fades out gradually over its last stretch
      { name: 'tip-vortex', from: P(0.58, 1.0, 0.29), to: P(1.6, 1.0, 0.28), radius: 0.1, mirror: true },
    ],
  },
  _primitivesComment: 'Winglet tip vortices (one per side, counter-rotating) and a gentle sink/source at each intake/exhaust.',
  primitives,
  _guideCurvesComment: 'Wing: three lanes per span station (fast just over the upper surface, a gentler layer above it, slow under the lower surface), each rising ahead of the leading edge (up-wash) and descending gently behind the trailing edge (down-wash). Wingtip: the air curling from under the wing round the winglet into the vortex. Fuselage: the air dividing at the nose over, round and under it. Engines: air converging and slowing into each intake, a short fast jet out of each exhaust, flow round the nacelle. Tail: dividing at the fin, over and under the tailplane.',
  guideCurves: curves,
  _terminalsComment: 'Spheres (radius in world units) where a traced line ends cleanly instead of running on: the fan faces and just inside the exhausts (src/particles/streamlines.js buildTerminals).',
  terminals,
  _wakesComment: 'Only the tail cone sheds a declared wake: a narrow, quiet one. The wingtip wake is the winglet vortices.',
  wakes,
};

const names = rakes.groups.flatMap((g) => (g.mirror ? [g.name, `${g.name}-mirror`] : [g.name]));
if (new Set(names).size !== names.length || names.length > 32) throw new Error(`group names must be unique and at most 32 (renderer limit): ${names.length}`);
writeFileSync(OUT, JSON.stringify(rakes, null, 2) + '\n');
console.log(`wrote ${OUT}: ${curves.length} curves (before mirroring), ${groups.length} seed regions, ${primitives.length} primitives`);
