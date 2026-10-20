// Phase 5: the F1 in a left-hand corner. Seen from the car, the air does not arrive in straight lines: it moves in
// arcs centred on the centre of the corner (the car is going round that centre), arriving along the track ahead and
// leaving along the track behind, both ends bending towards the inside. The car is also yawed a little relative to
// its path (nose into the corner), so the air reaches it slightly from the outside of the corner (the car's right):
// the right flank is exposed, the left flank sits in its lee, and everything the car leaves behind is carried
// towards the inside. Air further from the centre, on the outside, moves a little faster.
//
// The cornering flow is the straight-line flow re-authored, not mirrored or rotated wholesale (the car does not turn
// relative to its own bodywork, so the paths that hug the bodywork stay where they are):
//   - the oncoming air (the freestream) circulates about the corner's centre, its speed growing with the distance
//     from that centre, and is turned by the yaw angle on top (vectorField.js, `yaw.cornerRadius`);
//   - the guide curves keep their shape along the car, but their ends ahead of the nose and behind the car follow
//     those arcs, so air arrives from the right and leaves curving towards the left;
//   - every wake cone and trailing vortex leans with the curved, yawed flow instead of the car's centreline;
//   - two extra wakes on the shielded side (behind the left sidepod and the left rear tyre) carry the separated, slow
//     air of the lee;
//   - the field itself (vectorField.js, `yaw`) speeds the air along the exposed flank and slows it along the shielded
//     one, so the colours differ side to side.
// The straight-line flow never sees any of this: it is built from data/rakes.json unchanged.
//
// Zero dependency on three.js/DOM, like the rest of src/particles/.

import { expandMirrored } from './anchors.js';

/**
 * The corner the car is driving round, as drawn by src/track.js: a constant-radius left-hander. The car runs this far
 * inside the centreline, so it goes round the centre at radius + carOffset.
 */
export const CORNER_TRACK = {
  radius: 40, // centreline radius (m)
  carOffset: -4.2, // the car's line, from the centreline (negative = inside, its left side towards the inner kerb)
};

/** Yaw angle and its effects. Config values (BUILD.md Phase 5); positive yaw = air from the car's right. */
export const CORNERING_CONFIG = {
  yawDeg: 4, // angle between the car's centreline and the oncoming air (on top of the curve of the flow)
  carRadius: CORNER_TRACK.radius + CORNER_TRACK.carOffset, // distance from the corner's centre to the car (m)
  wakeLeanLength: 6, // the wake particles' release direction leans by the arc's mean turn over this distance (m)
  steerDeg: 4, // front-wheel steer, to the left, shown on the car (display only; the distance field is not re-baked)
  exposedSpeedGain: 0.1, // up to +10% speed along the exposed (right) flank
  shieldedSpeedLoss: 0.18, // up to -18% speed along the shielded (left) flank and in its lee
  shearStartAlong: 0.6, // guide-curve points behind this alongFlow fraction are carried sideways with the yawed flow...
  shearStartAlongUpstream: -0.85, // ...and so are points ahead of this one (in the opposite sense: air from the right)
  // Separated air in the lee of the left flank: extra wake cones, in the usual rakes.json form (lateral < 0 = left).
  shieldedWakes: [
    { name: 'shielded-sidepod', anchor: { alongFlow: 0.1, lateral: -0.85, vertical: 0.35 }, axis: { along: 1, lateral: -0.3, vertical: 0 }, expansionAngle: 0.3, decayLength: 2.0, speedDeficit: 0.3 },
    { name: 'shielded-rear-tyre', anchor: { alongFlow: 0.8, lateral: -0.95, vertical: 0.35 }, axis: { along: 1, lateral: -0.3, vertical: 0 }, expansionAngle: 0.34, decayLength: 2.2, speedDeficit: 0.45 },
  ],
};

/** A flow-relative axis ({ along, lateral, vertical }) turned by the yaw: the along part leans towards the left. */
function yawAxis(axis, yawRad) {
  const c = Math.cos(yawRad), s = Math.sin(yawRad);
  return { along: axis.along * c + axis.lateral * s, lateral: axis.lateral * c - axis.along * s, vertical: axis.vertical };
}

/** Mean turn (rad) of an arc of radius r over a straight chord-length `len`: half the arc's total turn. */
const meanTurn = (len, r) => len / (2 * r);

/**
 * Where the corner's centre lies, as seen from the car: on its left, at carRadius from the domain's origin, turned by
 * the yaw (the car points slightly into the corner, so the centre sits slightly ahead of square). Horizontal world
 * coordinates; the track (src/track.js) turns about the same point.
 */
export function cornerCentre(domain, overrides = {}) {
  const cfg = { ...CORNERING_CONFIG, ...overrides };
  const a = (cfg.yawDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  // the flow's own sideways axis (yawWakeDomain's `right`); the centre is on the other side of it, the left
  const ox = domain.rightX * c + domain.dirX * s, oy = domain.rightY * c + domain.dirY * s, oz = domain.rightZ * c + domain.dirZ * s;
  return [domain.originX - ox * cfg.carRadius, domain.originY - oy * cfg.carRadius, domain.originZ - oz * cfg.carRadius];
}

/**
 * How far the wake particles' release direction leans towards the inside: the yaw plus the arc's mean turn over
 * wakeLeanLength (the particles travel in straight lines, so they take the curve's average direction).
 */
export function wakeLeanDeg(overrides = {}) {
  const cfg = { ...CORNERING_CONFIG, ...overrides };
  return cfg.yawDeg + (meanTurn(cfg.wakeLeanLength, cfg.carRadius) * 180) / Math.PI;
}

/**
 * The cornering version of a scene's rakes.json. `domain` sizes the sideways offsets of the guide-curve ends: a point
 * a distance d (m) past the shear start is carried sideways by the yaw (tan(yaw) d) and, towards the inside, by the
 * curve of the arc (d^2 / 2R), expressed in the lateral fraction's own unit.
 *
 * @param {object} rakes data/rakes.json (not modified)
 * @param {ReturnType<import('./domain.js').domainFromBounds>} domain
 * @param {Partial<typeof CORNERING_CONFIG>} [overrides]
 */
export function corneringRakes(rakes, domain, overrides = {}) {
  const cfg = { ...CORNERING_CONFIG, ...overrides };
  const yawRad = (cfg.yawDeg * Math.PI) / 180;
  const tanYaw = Math.tan(yawRad), halfWidth = domain.carWidth / 2, R = cfg.carRadius;
  const shear = (p) => {
    let d = 0; // metres, + = the car's right
    if (p.alongFlow > cfg.shearStartAlong) { const m = (p.alongFlow - cfg.shearStartAlong) * domain.halfLength; d = -tanYaw * m - (m * m) / (2 * R); }
    else if (p.alongFlow < cfg.shearStartAlongUpstream) { const m = (cfg.shearStartAlongUpstream - p.alongFlow) * domain.halfLength; d = tanYaw * m - (m * m) / (2 * R); }
    return d ? { ...p, lateral: p.lateral + d / halfWidth } : p;
  };
  // Mirrored curves are expanded first: once sheared, the two sides are no longer reflections of each other.
  const guideCurves = (rakes.guideCurves || []).flatMap((g) => (g.mirror
    ? [{ ...g, mirror: false }, { ...g, mirror: false, name: `${g.name}-mirror`, points: g.points.map((p) => ({ ...p, lateral: -p.lateral })) }]
    : [g])).map((g) => ({ ...g, points: g.points.map(shear) }));
  // each cone or vortex leans by the yaw plus the arc's mean turn over its own length
  const turn = (e) => (e.axis ? { ...e, axis: yawAxis(e.axis, yawRad + meanTurn(e.decayLength || e.length || domain.halfLength * 2, R)) } : e);
  return {
    ...rakes,
    guideCurves,
    // a line the corrections leave inside the distance field's surface is replaced (streamlines.js endsInsideSurface)
    culling: { ...(rakes.culling || {}), dropInsideSurface: true },
    // expandMirrored flips only the anchor, so both copies of a mirrored wake or vortex lean the same way, downwind
    wakes: [...(rakes.wakes || []).flatMap(expandMirrored).map((w) => ({ ...turn(w), mirror: false })), ...cfg.shieldedWakes.map(turn)],
    primitives: (rakes.primitives || []).flatMap(expandMirrored).map((p) => ({ ...turn(p), mirror: false })),
    yaw: { deg: cfg.yawDeg, exposedSpeedGain: cfg.exposedSpeedGain, shieldedSpeedLoss: cfg.shieldedSpeedLoss, cornerRadius: R },
  };
}

/**
 * The wake particles' domain (domain.js computeWakeDomain) turned by `yawDeg` (wakeLeanDeg()), so the particles stream towards the
 * inside of the corner. The spawn plane stays where it is, just behind the rear wheels; only the direction it releases
 * particles along, and its sideways axis, turn.
 */
export function yawWakeDomain(domain, yawDeg) {
  const a = (yawDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const dir = [domain.dirX * c - domain.rightX * s, domain.dirY * c - domain.rightY * s, domain.dirZ * c - domain.rightZ * s];
  const right = [domain.rightX * c + domain.dirX * s, domain.rightY * c + domain.dirY * s, domain.rightZ * c + domain.dirZ * s];
  const sd = domain.spawnDistance;
  const plane = [domain.originX - domain.dirX * sd, domain.originY - domain.dirY * sd, domain.originZ - domain.dirZ * sd];
  return {
    ...domain,
    dirX: dir[0], dirY: dir[1], dirZ: dir[2],
    rightX: right[0], rightY: right[1], rightZ: right[2],
    originX: plane[0] + dir[0] * sd, originY: plane[1] + dir[1] * sd, originZ: plane[2] + dir[2] * sd,
  };
}
