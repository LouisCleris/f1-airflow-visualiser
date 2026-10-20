// Phase 3.7 sections 2-3: guide curves -- authored 3D splines describing
// the paths air actually takes, replacing the analytic doublets as the
// mechanism that routes flow around bodywork. Doublets can't represent
// thin multi-element geometry (a front wing) and their combined field
// produces closed recirculation loops where local swirl exceeds
// freestream (PHASE-3.7.md's intro); an authored path has neither problem
// by construction -- it doesn't fight the freestream, it just says where
// the air goes.
//
// A guide curve is a Catmull-Rom spline through authored control points
// (data/rakes.json `guideCurves`, in the same alongFlow/lateral/vertical
// fractional convention as everything else -- see anchors.js), each with a
// `radius` (influence distance), `weight` (0-1, how strongly the field is
// pulled toward the curve's tangent), and `speedScale` (local multiplier
// on freestream speed along the curve, for accelerating through a
// constriction or decelerating through an expansion).
//
// Field evaluation at a point, per PHASE-3.7.md section 2:
//   1. Start with the freestream.
//   2. For each curve within `radius`, find the nearest point on the
//      spline, take its tangent, blend the direction toward that tangent
//      by `weight`, smoothly falling to zero at `radius`.
//   3. Scale speed by the blended `speedScale`.
// Where curves overlap, they combine by a distance-weighted average (see
// guideCurveVelocityAt()) rather than being applied one after another --
// sequential application would make the result depend on curve order,
// which authored config data should not.
//
// Curves are authored with their control points in DOWNSTREAM order (first
// point most upstream, last most downstream), so a curve's own tangent
// direction is never upstream by construction; section 1's invariant is
// still the actual backstop against an authored mistake or an overlap that
// produces a partially-cancelling blend.
//
// Zero dependency on three.js/DOM, like the rest of src/particles/.

import { anchorToWorld } from './anchors.js';

/** Reflects every control point's lateral coordinate -- the array-of-points equivalent of anchors.js's expandMirrored() (which only handles a single `.anchor`). */
function mirrorGuideCurve(entry) {
  return {
    ...entry,
    name: `${entry.name}-mirror`,
    points: entry.points.map((p) => ({ ...p, lateral: -p.lateral })),
  };
}

/** Catmull-Rom interpolation through `points[i-1..i+2]` at parameter t in [0,1], evaluating the segment between points[i] and points[i+1]. Endpoints are clamped (duplicated) so the curve doesn't need "phantom" control points beyond the authored ones. */
function catmullRomPoint(points, i, t) {
  const p0 = points[Math.max(0, i - 1)];
  const p1 = points[i];
  const p2 = points[i + 1];
  const p3 = points[Math.min(points.length - 1, i + 2)];
  const t2 = t * t, t3 = t2 * t;
  function axis(k) {
    return 0.5 * (
      2 * p1[k] +
      (-p0[k] + p2[k]) * t +
      (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
      (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3
    );
  }
  return { x: axis('x'), y: axis('y'), z: axis('z') };
}

/** Dense polyline sampling a Catmull-Rom spline through `points` (already world-space {x,y,z}), `samplesPerSegment` points per pair of control points. */
function sampleSpline(points, samplesPerSegment) {
  if (points.length < 2) return points.slice();
  const samples = [];
  for (let i = 0; i < points.length - 1; i++) {
    const count = i === points.length - 2 ? samplesPerSegment + 1 : samplesPerSegment; // include the very last point once
    for (let s = 0; s < count; s++) {
      const t = s / samplesPerSegment;
      samples.push(catmullRomPoint(points, i, t));
    }
  }
  return samples;
}

/** Unit tangent at each sample, via central differences (one-sided at the endpoints). */
function computeTangents(samples) {
  const tangents = [];
  for (let i = 0; i < samples.length; i++) {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(samples.length - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
    const len = Math.hypot(tx, ty, tz) || 1;
    tangents.push([tx / len, ty / len, tz / len]);
  }
  return tangents;
}

/**
 * Resolves data/rakes.json's `guideCurves` array (fractional control
 * points) into world-space sampled splines, expanding `mirror: true`
 * entries to both sides of the car.
 */
export function buildGuideCurves(domain, entries) {
  return entries.flatMap((entry) => (entry.mirror ? [entry, mirrorGuideCurve(entry)] : [entry])).map((entry) => {
    const controlPoints = entry.points.map((p) => anchorToWorld(domain, p));
    const samplesPerSegment = entry.samplesPerSegment || 14;
    const samples = sampleSpline(controlPoints, samplesPerSegment);
    const tangents = computeTangents(samples);
    // A control point may carry its own `speedScale`; between points it is interpolated (smoothstep) along the
    // curve, so one curve can slow down into a stagnation region and speed up out of it. Points without one use
    // the curve's own value.
    const pointScales = entry.points.map((p) => (typeof p.speedScale === 'number' ? p.speedScale : entry.speedScale));
    const speedScales = samples.map((_, i) => {
      const seg = Math.min(Math.floor(i / samplesPerSegment), pointScales.length - 2);
      if (seg < 0) return pointScales[0];
      const t = Math.min(1, (i - seg * samplesPerSegment) / samplesPerSegment);
      const e = t * t * (3 - 2 * t);
      return pointScales[seg] + (pointScales[seg + 1] - pointScales[seg]) * e;
    });

    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const s of samples) {
      if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
      if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
      if (s.z < minZ) minZ = s.z; if (s.z > maxZ) maxZ = s.z;
    }
    const r = entry.radius;
    const bbox = { minX: minX - r, minY: minY - r, minZ: minZ - r, maxX: maxX + r, maxY: maxY + r, maxZ: maxZ + r };

    return { name: entry.name, samples, tangents, speedScales, bbox, radius: entry.radius, weight: entry.weight, speedScale: entry.speedScale };
  });
}

/** Nearest sampled point on `curve` to (x,y,z), or null if outside its bbox or beyond its radius. Broad-phase bbox check first, since most points in the domain are near none of a handful of localized curves. */
function nearestOnCurve(curve, x, y, z) {
  const b = curve.bbox;
  if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ) return null;
  let bestD2 = Infinity, bestIdx = -1;
  for (let i = 0; i < curve.samples.length; i++) {
    const s = curve.samples[i];
    const dx = x - s.x, dy = y - s.y, dz = z - s.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
  }
  const distance = Math.sqrt(bestD2);
  if (distance > curve.radius) return null;
  return { distance, tangent: curve.tangents[bestIdx], speedScale: curve.speedScales[bestIdx] };
}

/** Smoothstep falloff: 1 at distance 0, 0 at distance >= radius, smooth (C1) in between. */
function falloff(distance, radius) {
  const t = Math.min(1, Math.max(0, distance / radius));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Evaluates the guide-curve-blended velocity at (x,y,z), starting from
 * `freestreamVec`. Overlapping curves combine by a distance-weighted
 * average: each active curve's (weight * falloff) contributes to both a
 * weighted-average target DIRECTION and an OR-combined blend STRENGTH
 * (`1 - product(1 - effectiveWeight_i)`, so one strongly-active curve
 * dominates but several weak ones can still add up), and `speedScale`
 * blends as a weighted average of the active curves' own values.
 *
 * @param {ReturnType<typeof buildGuideCurves>} curves
 * @param {number[]} freestreamVec
 * @param {Float64Array} out mutated and returned
 */
export function guideCurveVelocityAt(curves, x, y, z, freestreamVec, out) {
  const freestreamSpeed = Math.hypot(freestreamVec[0], freestreamVec[1], freestreamVec[2]) || 1;
  const fdx = freestreamVec[0] / freestreamSpeed, fdy = freestreamVec[1] / freestreamSpeed, fdz = freestreamVec[2] / freestreamSpeed;

  let sumTx = 0, sumTy = 0, sumTz = 0;
  let productOneMinusW = 1;
  let anyActive = false;
  let speedScaleWeightSum = 0;
  let speedScaleSum = 0;

  for (const curve of curves) {
    const hit = nearestOnCurve(curve, x, y, z);
    if (!hit) continue;
    const w = curve.weight * falloff(hit.distance, curve.radius);
    if (w <= 1e-6) continue;
    anyActive = true;
    sumTx += w * hit.tangent[0]; sumTy += w * hit.tangent[1]; sumTz += w * hit.tangent[2];
    productOneMinusW *= (1 - Math.min(1, w));
    speedScaleWeightSum += w;
    speedScaleSum += w * hit.speedScale;
  }

  if (!anyActive) {
    out[0] = freestreamVec[0]; out[1] = freestreamVec[1]; out[2] = freestreamVec[2];
    return out;
  }

  let tLen = Math.hypot(sumTx, sumTy, sumTz) || 1;
  const tx = sumTx / tLen, ty = sumTy / tLen, tz = sumTz / tLen;
  const combinedWeight = 1 - productOneMinusW;

  let bx = fdx + (tx - fdx) * combinedWeight;
  let by = fdy + (ty - fdy) * combinedWeight;
  let bz = fdz + (tz - fdz) * combinedWeight;
  const bLen = Math.hypot(bx, by, bz) || 1;
  bx /= bLen; by /= bLen; bz /= bLen;

  const combinedSpeedScale = speedScaleWeightSum > 0 ? speedScaleSum / speedScaleWeightSum : 1;
  const speed = freestreamSpeed * combinedSpeedScale;

  out[0] = bx * speed; out[1] = by * speed; out[2] = bz * speed;
  return out;
}
