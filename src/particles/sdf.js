// Runtime reader for the true signed distance field baked offline by
// scripts/bake_sdf.py (data/sdf.json header + data/sdf.bin payload).
//
// This replaces the old "SDF" that streamlines.js/vectorField.js/seeding.js
// derived from the BINARY occupancy grid (nearest occupied cell by integer
// index offset, direction = that cell's baked normal). That quantised both
// distance (whole cells) and direction (per-cell normals), so every
// correction built on it moved points in grid-aligned steps. Here distance is
// the real distance to the real mesh, trilinearly interpolated, and the
// direction is the interpolated field's own gradient: corrections are
// continuous functions of position.
//
// Storage is block-sparse (8^3 blocks that touch the band around the car),
// int16-quantised. Positions outside the lattice or in an empty block read
// as "far" (+bandWorld, gradient zero). Positive = outside, negative = inside.
//
// Zero dependency on three.js/DOM, like the rest of src/particles/ -- the
// Node tests and the browser call the same parseSdf() on the same bytes.

export const SDF_DATA_DIR = 'data/';

/**
 * @param {object} header parsed data/sdf.json
 * @param {ArrayBuffer} buffer contents of data/sdf.bin
 */
export function parseSdf(header, buffer) {
  const [ox, oy, oz] = header.origin;
  const pitch = header.pitch;
  const [nx, ny, nz] = header.dims;
  const B = header.blockSize;
  const [nbx, nby, nbz] = header.blockGrid;
  const band = header.bandWorld;
  const scale = band / 32767;
  const B3 = B * B * B;

  const tableBytes = nbx * nby * nbz * 4;
  const expected = tableBytes + header.blockCount * B3 * 2;
  if (buffer.byteLength !== expected) {
    throw new Error(`sdf.bin size mismatch: header implies ${expected} bytes, file is ${buffer.byteLength}. Re-run scripts/bake_sdf.py.`);
  }
  const table = new Int32Array(buffer, 0, nbx * nby * nbz);
  const payload = new Int16Array(buffer, tableBytes, header.blockCount * B3);

  // Tight world AABB of the stored blocks -- cheap broad-phase reject.
  let minB = [Infinity, Infinity, Infinity], maxB = [-Infinity, -Infinity, -Infinity];
  for (let bx = 0; bx < nbx; bx++) for (let by = 0; by < nby; by++) for (let bz = 0; bz < nbz; bz++) {
    if (table[(bx * nby + by) * nbz + bz] < 0) continue;
    if (bx < minB[0]) minB[0] = bx; if (bx > maxB[0]) maxB[0] = bx;
    if (by < minB[1]) minB[1] = by; if (by > maxB[1]) maxB[1] = by;
    if (bz < minB[2]) minB[2] = bz; if (bz > maxB[2]) maxB[2] = bz;
  }
  const bounds = {
    minX: ox + minB[0] * B * pitch, maxX: ox + (maxB[0] + 1) * B * pitch,
    minY: oy + minB[1] * B * pitch, maxY: oy + (maxB[1] + 1) * B * pitch,
    minZ: oz + minB[2] * B * pitch, maxZ: oz + (maxB[2] + 1) * B * pitch,
  };

  /** Distance at lattice node (i,j,k); band for anything not stored. */
  function node(i, j, k) {
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return band;
    const bi = (i / B) | 0, bj = (j / B) | 0, bk = (k / B) | 0;
    const blk = table[(bi * nby + bj) * nbz + bk];
    if (blk < 0) return band;
    return payload[blk * B3 + ((i - bi * B) * B + (j - bj * B)) * B + (k - bk * B)] * scale;
  }

  function isNear(x, y, z) {
    return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY && z >= bounds.minZ && z <= bounds.maxZ;
  }

  /**
   * Trilinear distance at (x,y,z) and the interpolant's gradient (the outward
   * unit direction). Writes out[0]=distance, out[1..3]=unit gradient (zero
   * vector where the field is flat/far). Returns the distance.
   * @param {Float64Array|number[]} out 4-element scratch
   */
  function sampleAt(x, y, z, out) {
    const fx = (x - ox) / pitch, fy = (y - oy) / pitch, fz = (z - oz) / pitch;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const c000 = node(i, j, k), c100 = node(i + 1, j, k), c010 = node(i, j + 1, k), c110 = node(i + 1, j + 1, k);
    const c001 = node(i, j, k + 1), c101 = node(i + 1, j, k + 1), c011 = node(i, j + 1, k + 1), c111 = node(i + 1, j + 1, k + 1);
    const c00 = c000 + (c100 - c000) * tx, c10 = c010 + (c110 - c010) * tx;
    const c01 = c001 + (c101 - c001) * tx, c11 = c011 + (c111 - c011) * tx;
    const c0 = c00 + (c10 - c00) * ty, c1 = c01 + (c11 - c01) * ty;
    const d = c0 + (c1 - c0) * tz;
    // analytic gradient of the trilinear interpolant
    const gx = ((c100 - c000) * (1 - ty) + (c110 - c010) * ty) * (1 - tz) + ((c101 - c001) * (1 - ty) + (c111 - c011) * ty) * tz;
    const gy = (c10 - c00) * (1 - tz) + (c11 - c01) * tz;
    const gz = c1 - c0;
    const len = Math.hypot(gx, gy, gz);
    out[0] = d;
    if (len > 1e-12) { out[1] = gx / len; out[2] = gy / len; out[3] = gz / len; }
    else { out[1] = 0; out[2] = 0; out[3] = 0; }
    return d;
  }

  const cellWorld = header.pitch * (header.refine || 2); // occupancy-grid cell size
  return { pitch, cellWorld, band, bounds, isNear, sampleAt, blockCount: header.blockCount, dims: header.dims };
}

/**
 * Composes the full distance query the tracer, seeder and wake particles use:
 *   - the car-wide field (`base`, conservative: inflated by 0.6 lattice cell),
 *   - optionally a finer, UNBIASED local field for the floor slab (`floor`),
 *     blended in over `blendWidth` world units inside `box` so there is no step
 *     where one hands over to the other,
 *   - the ground as an exact flat plane at y = groundY (not sampled from any
 *     grid): distance = y - groundY, gradient straight up.
 * Returns the same interface as parseSdf() (isNear, sampleAt, band, ...).
 *
 * @param {ReturnType<typeof parseSdf>} base
 * @param {{ groundY?: number|null, floor?: { sdf: ReturnType<typeof parseSdf>, box: number[], blendWidth?: number }|null }} [opts]
 *   `box` = [x0, x1, y0, y1, z0, z1]
 */
export function composeSdf(base, opts = {}) {
  const groundY = opts.groundY ?? null;
  const floor = opts.floor || null;
  const tmpF = new Float64Array(4);
  const smooth = (u) => u * u * (3 - 2 * u);

  function isNear(x, y, z) {
    return base.isNear(x, y, z) || (groundY !== null && y < groundY + base.band) ||
      (floor !== null && floor.sdf.isNear(x, y, z));
  }

  function sampleAt(x, y, z, out) {
    let d = base.band;
    out[1] = 0; out[2] = 0; out[3] = 0;
    if (base.isNear(x, y, z)) d = base.sampleAt(x, y, z, out);
    if (floor) {
      const b = floor.box, w = floor.blendWidth ?? 0.03;
      const inset = Math.min(x - b[0], b[1] - x, y - b[2], b[3] - y, z - b[4], b[5] - z);
      if (inset > 0 && floor.sdf.isNear(x, y, z)) {
        const dl = floor.sdf.sampleAt(x, y, z, tmpF);
        if (dl < floor.sdf.band * 0.98) {
          const t = smooth(Math.min(1, inset / w));
          d = d + (dl - d) * t;
          let gx = out[1] + (tmpF[1] - out[1]) * t, gy = out[2] + (tmpF[2] - out[2]) * t, gz = out[3] + (tmpF[3] - out[3]) * t;
          const l = Math.hypot(gx, gy, gz);
          if (l > 1e-9) { out[1] = gx / l; out[2] = gy / l; out[3] = gz / l; }
        }
      }
    }
    if (groundY !== null) {
      const dg = y - groundY;
      if (dg < d) { d = dg; out[1] = 0; out[2] = 1; out[3] = 0; }
    }
    out[0] = d;
    return d;
  }

  return { ...base, isNear, sampleAt, groundY, hasFloorField: floor !== null };
}

/**
 * Builds the composed field from raw file contents (Node and browser share it).
 * @param {{ json: object, buffer: ArrayBuffer }} main data/sdf.*
 * @param {{ json: object, buffer: ArrayBuffer }|null} floor data/sdf_floor.* (optional)
 * @param {number|null} groundY exact ground plane height, or null for none
 */
export function buildSdf(main, floor, groundY) {
  const base = parseSdf(main.json, main.buffer);
  let floorOpt = null;
  if (floor) floorOpt = { sdf: parseSdf(floor.json, floor.buffer), box: floor.json.box, blendWidth: 0.03 };
  return composeSdf(base, { groundY, floor: floorOpt });
}

/** Node-only convenience: read data/sdf.* (+ data/sdf_floor.* if present) from `dataDir` with the given node:fs functions. */
export function loadSdfSync(dataDir, fs, groundY = 0) {
  const rd = (f) => { const b = fs.readFileSync(dataDir + f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const rj = (f) => JSON.parse(fs.readFileSync(dataDir + f, 'utf8'));
  const floor = fs.existsSync(dataDir + 'sdf_floor.bin') ? { json: rj('sdf_floor.json'), buffer: rd('sdf_floor.bin') } : null;
  return buildSdf({ json: rj('sdf.json'), buffer: rd('sdf.bin') }, floor, groundY);
}

/** Browser-only loader (fetch). `groundY` is the exact ground plane height (a scene config value; null = no ground). `floor: false` skips the optional fine floor field (a scene without one must not request a file that is not there). */
export async function fetchSdf(baseUrl = SDF_DATA_DIR, groundY = 0, { floor: wantFloor = true } = {}) {
  const get = async (f, kind) => {
    const r = await fetch(`${baseUrl}${f}`);
    if (!r.ok) throw new Error(`failed to fetch ${f}: HTTP ${r.status}`);
    return kind === 'json' ? r.json() : r.arrayBuffer();
  };
  const [json, buffer] = await Promise.all([get('sdf.json', 'json'), get('sdf.bin', 'buf')]);
  let floor = null;
  if (wantFloor) try { floor = { json: await get('sdf_floor.json', 'json'), buffer: await get('sdf_floor.bin', 'buf') }; } catch (e) { /* optional */ }
  return buildSdf({ json, buffer }, floor, groundY);
}
