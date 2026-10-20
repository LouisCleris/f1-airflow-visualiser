// Converts the fractional (alongFlow, lateral, vertical) coordinates used by
// data/rakes.json into world-space positions/directions, in the domain's own
// flow/right/up basis (see domain.js). This is the single shared convention
// seeding.js (rake placement) and vectorField.js (vortex core placement) both
// read, so a rake and a vortex core can be positioned with the exact same
// kind of number in the JSON file.
//
//   alongFlow: fraction of domain.halfLength from the car's centre, along
//     the flow direction -- roughly -1 at the car's front-most extent, +1 at
//     its rear-most extent (matches domain.js's own flow-sign convention).
//   lateral:   fraction of the car's own half-width (domain.carWidth / 2)
//     from the centreline, along domain.right.
//   vertical:  fraction of the car's own height (domain.carHeight) above the
//     ground (domain.originY is already ground level -- see domain.js).
//
// Zero dependency on three.js/DOM, like the rest of src/particles/ -- plain
// numbers in, plain numbers out.

/** @param {ReturnType<import('./domain.js').domainFromBounds>} domain */
export function anchorToWorld(domain, anchor) {
  const halfCarWidth = domain.carWidth / 2;
  const along = anchor.alongFlow * domain.halfLength;
  const lateral = anchor.lateral * halfCarWidth;
  const vertical = anchor.vertical * domain.carHeight;
  return {
    x: domain.originX + domain.dirX * along + domain.rightX * lateral + domain.upX * vertical,
    y: domain.originY + domain.dirY * along + domain.rightY * lateral + domain.upY * vertical,
    z: domain.originZ + domain.dirZ * along + domain.rightZ * lateral + domain.upZ * vertical,
  };
}

/**
 * A unit direction vector for a fractional {along, lateral, vertical}
 * triple in the same basis -- used for vortex core axes, which are
 * specified relative to the flow direction rather than as raw world XYZ so
 * they stay correct regardless of which world axis the car happens to face.
 */
export function directionToWorld(domain, dirFrac) {
  const x = domain.dirX * dirFrac.along + domain.rightX * dirFrac.lateral + domain.upX * dirFrac.vertical;
  const y = domain.dirY * dirFrac.along + domain.rightY * dirFrac.lateral + domain.upY * dirFrac.vertical;
  const z = domain.dirZ * dirFrac.along + domain.rightZ * dirFrac.lateral + domain.upZ * dirFrac.vertical;
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/**
 * Expands a rake or vortex config entry with `mirror: true` into two
 * entries -- itself and a copy reflected about the car's centreline
 * (lateral negated) -- so a single anchor covers both sides of a symmetric
 * feature (e.g. "front tyre" -> left and right). Entries without
 * `mirror: true` are returned as a single-item array unchanged.
 */
export function expandMirrored(entry) {
  if (!entry.mirror) return [entry];
  const mirrored = {
    ...entry,
    name: `${entry.name}-mirror`,
    anchor: { ...entry.anchor, lateral: -entry.anchor.lateral },
  };
  return [entry, mirrored];
}
