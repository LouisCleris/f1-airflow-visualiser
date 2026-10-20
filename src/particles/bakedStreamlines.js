// Streamlines traced ahead of time (scripts/bake_streamlines.mjs) so the page does not have to trace ~400 lines
// through the field on load, which takes tens of seconds. The bake stores only what the renderer needs per
// point (position, speed, coherence, time of flight), quantised: positions to 16 bits across the lines' bounding box
// (about a tenth of a millimetre at car scale), speed and coherence to 8 bits, time of flight to 16 bits.
// Zero dependency on three.js/DOM; runs in Node and the browser.

export const BAKED_STREAMLINES_DIR = 'data/';

/** @param {Array<{ positions: ArrayLike<number>, speeds: ArrayLike<number>, coherence: ArrayLike<number>, timeOfFlight: ArrayLike<number>, group: string }>} paths */
export function encodeStreamlines(paths) {
  const groups = [];
  let total = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let speedMax = 0, tofMin = Infinity, tofMax = -Infinity;
  for (const p of paths) {
    if (!groups.includes(p.group)) groups.push(p.group);
    const n = p.positions.length / 3;
    total += n;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) { const v = p.positions[i * 3 + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
      if (p.speeds[i] > speedMax) speedMax = p.speeds[i];
      if (p.timeOfFlight[i] < tofMin) tofMin = p.timeOfFlight[i];
      if (p.timeOfFlight[i] > tofMax) tofMax = p.timeOfFlight[i];
    }
  }
  const buffer = new ArrayBuffer(total * 6 + total * 2 + total * 2);
  const pos = new Uint16Array(buffer, 0, total * 3);
  const tof = new Uint16Array(buffer, total * 6, total);
  const spd = new Uint8Array(buffer, total * 8, total);
  const coh = new Uint8Array(buffer, total * 9, total);
  const q16 = (v, lo, hi) => Math.round(((v - lo) / (hi - lo || 1)) * 65535);
  let o = 0;
  const counts = [], pathGroups = [];
  for (const p of paths) {
    const n = p.positions.length / 3;
    counts.push(n); pathGroups.push(groups.indexOf(p.group));
    for (let i = 0; i < n; i++, o++) {
      for (let k = 0; k < 3; k++) pos[o * 3 + k] = q16(p.positions[i * 3 + k], min[k], max[k]);
      tof[o] = q16(p.timeOfFlight[i], tofMin, tofMax);
      spd[o] = Math.round(Math.min(1, p.speeds[i] / speedMax) * 255);
      coh[o] = Math.round(Math.max(0, Math.min(1, p.coherence[i])) * 255);
    }
  }
  return { json: { version: 1, groups, counts, pathGroups, total, min, max, speedMax, tofMin, tofMax }, buffer };
}

export function decodeStreamlines(json, buffer) {
  const { total, counts, pathGroups, groups, min, max, speedMax, tofMin, tofMax } = json;
  const pos = new Uint16Array(buffer, 0, total * 3);
  const tof = new Uint16Array(buffer, total * 6, total);
  const spd = new Uint8Array(buffer, total * 8, total);
  const coh = new Uint8Array(buffer, total * 9, total);
  const paths = [];
  let o = 0;
  for (let j = 0; j < counts.length; j++) {
    const n = counts[j];
    const positions = new Float32Array(n * 3), speeds = new Float32Array(n), coherence = new Float32Array(n), timeOfFlight = new Float32Array(n);
    for (let i = 0; i < n; i++, o++) {
      for (let k = 0; k < 3; k++) positions[i * 3 + k] = min[k] + (pos[o * 3 + k] / 65535) * (max[k] - min[k]);
      timeOfFlight[i] = tofMin + (tof[o] / 65535) * (tofMax - tofMin);
      speeds[i] = (spd[o] / 255) * speedMax;
      coherence[i] = coh[o] / 255;
    }
    paths.push({ positions, speeds, coherence, timeOfFlight, group: groups[pathGroups[j]] });
  }
  return paths;
}

/** Browser loader: resolves to the decoded paths, or null if the baked files are not there. */
export async function fetchBakedStreamlines(baseUrl = BAKED_STREAMLINES_DIR, prefix = 'streamlines') {
  const name = `${prefix}_full`; // 'streamlines_corner' is the F1's cornering set
  const [jr, br] = await Promise.all([fetch(`${baseUrl}${name}.json`), fetch(`${baseUrl}${name}.bin`)]);
  if (!jr.ok || !br.ok) return null;
  return decodeStreamlines(await jr.json(), await br.arrayBuffer());
}
