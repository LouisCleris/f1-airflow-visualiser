// Derives the particle flow domain (spawn plane, flow direction, recycle
// distance) from the *actual loaded car geometry*, instead of hardcoding
// world axes/extents that would silently go stale if the model or its
// scene placement ever changes. This is the only particle module that
// touches three.js Object3D/GLTF data -- everything downstream
// (particleSystem.js, trailBuffers.js) only sees the plain-number
// FlowDomain object returned here, which keeps them dependency-free and
// runnable in plain Node (see particleSystem.bench.js).
//
// Axis + direction derivation (both read from the geometry, not assumed):
// - Flow axis: whichever horizontal world axis (X or Z) the car's bounding
//   box is longer along. Confirmed by the Phase 1 screenshots
//   (shots/phase1-top-*.png) to be Z for the current model, but this does
//   not hardcode that -- it re-derives it from the live bounding box.
// - Flow sign (which end is "front"): compares the average world position,
//   along that axis, of every component whose authored name contains
//   "Front" against every component whose name contains "Rear"/"Back"
//   (matches car.js's own RIGHT_ONLY_COMPONENTS/WHEEL_SPIN_COMPONENTS
//   naming). Flow spawns upstream of "Front" and travels toward "Rear",
//   matching a wind-tunnel convention (car stationary, air enters at the
//   nose). Falls back to +axis if names are ever ambiguous/missing.

import * as THREE from 'three';

/**
 * Pure-number domain builder, factored out of computeFlowDomain() so the
 * exact same box-to-domain math can run somewhere that has no three.js
 * Object3D to hand -- specifically tests/checks.js assertion 3, which
 * derives its bounds from the flowDomain bbox recorded in
 * data/occupancy_grid.json (see scripts/bake_occupancy_grid.py) instead of
 * a live GLTF scene graph, so it can run in plain Node against the real
 * baked grid without a browser. Keeping one implementation means the
 * Node-side test domain and the real browser-side domain can never drift
 * apart in their math, only in *where the bounds come from*.
 *
 * @param {{minX:number,maxX:number,minY:number,maxY:number,minZ:number,maxZ:number}} bounds
 * @param {'x'|'z'} flowAxis
 * @param {1|-1} flowSign
 * @param {{ spawnMargin: number, downstreamMargin: number, widthMultiplier: number, heightMultiplier: number }} config
 */
export function domainFromBounds(bounds, flowAxis, flowSign, config) {
  const { minX, maxX, minY, maxY, minZ, maxZ } = bounds;
  const sizeX = maxX - minX;
  const sizeZ = maxZ - minZ;
  const crossAxis = flowAxis === 'x' ? 'z' : 'x';

  const dir = { x: 0, y: 0, z: 0 };
  dir[flowAxis] = flowSign;

  // right = WORLD_UP(0,1,0) x dir, normalized -- written out by hand
  // (instead of THREE.Vector3.crossVectors) so this function has zero
  // three.js/DOM dependency and can run in plain Node.
  const rightRaw = { x: dir.z, y: 0, z: -dir.x };
  const rightLen = Math.hypot(rightRaw.x, rightRaw.y, rightRaw.z) || 1;
  const right = { x: rightRaw.x / rightLen, y: rightRaw.y / rightLen, z: rightRaw.z / rightLen };

  const halfLength = (flowAxis === 'x' ? sizeX : sizeZ) / 2;
  const carWidth = crossAxis === 'x' ? sizeX : sizeZ;
  const halfWidth = (carWidth / 2) * config.widthMultiplier;
  const groundY = minY;
  const carHeight = maxY - groundY;
  const height = carHeight * config.heightMultiplier;

  const spawnDistance = halfLength + config.spawnMargin;
  const travelDistance = halfLength * 2 + config.spawnMargin + config.downstreamMargin;

  return {
    dirX: dir.x, dirY: dir.y, dirZ: dir.z,
    rightX: right.x, rightY: right.y, rightZ: right.z,
    upX: 0, upY: 1, upZ: 0,
    originX: (minX + maxX) / 2, originY: groundY, originZ: (minZ + maxZ) / 2,
    spawnDistance,
    travelDistance,
    halfWidth,
    halfHeight: height,
    // Raw (un-multiplied) car dimensions and the config margins used above,
    // exposed so downstream modules (streamlines.js's seed rake, which
    // wants the *actual* car width/height rather than the wider/taller
    // particle-spawn envelope; computeWakeDomain() below) can work from
    // real numbers instead of re-deriving them from the multiplied fields.
    halfLength,
    carWidth,
    carHeight,
    spawnMargin: config.spawnMargin,
    downstreamMargin: config.downstreamMargin,
  };
}

/**
 * Derives a second domain, restricted to the wake region directly behind
 * the car, from an existing full domain (as returned by domainFromBounds()
 * / computeFlowDomain()). Used to confine the discrete short-trail
 * particles (particleSystem.js) to the unsteady wake only, now that the
 * clean/attached flow ahead of and around the car is drawn as traced
 * streamlines instead (see streamlines.js) -- a 2-point particle trail is
 * shorter than the radius of any real deflection curve, so it cannot show
 * bends in a still frame, but the wake itself is genuinely unsteady
 * (turbulent, recirculating) where a traced steady-field line would be
 * misleading, so particles remain the right tool there specifically.
 *
 * Same dir/right/up/origin/halfWidth/halfHeight as the full domain -- only
 * spawnDistance/travelDistance move, to relocate the spawn plane from far
 * upstream to exactly the car's trailing edge (where streamlines stop) and
 * shrink the travel range to just the downstream wake margin.
 *
 * @param {ReturnType<typeof domainFromBounds>} domain
 */
export function computeWakeDomain(domain, alongFlow = 1) {
  return {
    ...domain,
    spawnDistance: -domain.halfLength * alongFlow, // plane = origin - dir*spawnDistance
    // = origin + dir*halfLength = the car's trailing edge
    travelDistance: domain.downstreamMargin,
  };
}

/**
 * @param {import('three').Object3D} carRoot
 * @param {{ spawnMargin: number, downstreamMargin: number, widthMultiplier: number, heightMultiplier: number }} config
 */
export function computeFlowDomain(carRoot, config) {
  carRoot.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(carRoot);
  const sizeX = box.max.x - box.min.x;
  const sizeZ = box.max.z - box.min.z;
  const flowAxis = sizeX >= sizeZ ? 'x' : 'z';
  const flowSign = deriveFlowSign(carRoot, flowAxis);

  return domainFromBounds(
    {
      minX: box.min.x, maxX: box.max.x,
      minY: box.min.y, maxY: box.max.y,
      minZ: box.min.z, maxZ: box.max.z,
    },
    flowAxis,
    flowSign,
    config
  );
}

function deriveFlowSign(carRoot, axis) {
  let frontSum = 0, frontCount = 0;
  let rearSum = 0, rearCount = 0;
  const worldPos = new THREE.Vector3();

  carRoot.traverse((obj) => {
    const name = obj.userData && obj.userData.name;
    if (!name) return;
    obj.getWorldPosition(worldPos);
    const v = worldPos[axis];
    if (/front/i.test(name)) {
      frontSum += v; frontCount += 1;
    } else if (/rear|back/i.test(name)) {
      rearSum += v; rearCount += 1;
    }
  });

  if (frontCount === 0 || rearCount === 0) return 1; // fallback: +axis
  const frontAvg = frontSum / frontCount;
  const rearAvg = rearSum / rearCount;
  // Flow travels from the front toward the rear, so it spawns on the
  // opposite side of "front" and moves in the +sign direction that
  // increases toward "rear".
  return rearAvg >= frontAvg ? 1 : -1;
}
