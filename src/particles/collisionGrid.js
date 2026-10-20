// Parses + provides fast lookup over the occupancy grid baked offline by
// scripts/bake_occupancy_grid.py (data/occupancy_grid.json header +
// data/occupancy_grid.bin binary payload -- see that script's module
// docstring for the exact bake methodology, and PROGRESS.md's Phase 3 entry
// for the parameters chosen and why).
//
// Zero dependency on three.js/DOM: `parseOccupancyGrid()` only touches a
// plain parsed-JSON object and an ArrayBuffer, so both tests/checks.js
// (Node, via node:fs) and the browser runtime (via fetch, see
// `fetchOccupancyGrid()` at the bottom of this file) call the exact same
// function against the exact same baked file on disk -- assertion 3 is a
// genuine check against the real data, not a mock of it.

export const DATA_DIR = 'data/';

// Packs a (i,j,k) grid index into one Number key for a plain Map. Safe for
// grids up to ~4095 voxels per axis -- the current bake is 69 x 36 x 181
// (see data/occupancy_grid.json), comfortable headroom for a future finer
// re-bake (CLAUDE.md: shrink voxels, never the display mesh, if particles
// ever clip).
const GRID_STRIDE = 4096;

function packKey(i, j, k) {
  return (i * GRID_STRIDE + j) * GRID_STRIDE + k;
}

/**
 * @param {object} header parsed contents of data/occupancy_grid.json
 * @param {ArrayBuffer} buffer contents of data/occupancy_grid.bin
 */
export function parseOccupancyGrid(header, buffer) {
  const { pitch, origin, cellCount } = header.grid;
  const [originX, originY, originZ] = origin;
  const RECORD_BYTES = header.binaryFormat.recordBytes;

  if (buffer.byteLength !== cellCount * RECORD_BYTES) {
    throw new Error(
      `occupancy grid binary size mismatch: header declares ${cellCount} cells * ` +
      `${RECORD_BYTES} bytes/cell = ${cellCount * RECORD_BYTES} bytes, but the ` +
      `binary file is ${buffer.byteLength} bytes. Re-run ` +
      `scripts/bake_occupancy_grid.py to regenerate a matching pair.`
    );
  }

  const view = new DataView(buffer);
  const normalX = new Float32Array(cellCount);
  const normalY = new Float32Array(cellCount);
  const normalZ = new Float32Array(cellCount);
  const cellIndexByKey = new Map();

  let minI = Infinity, minJ = Infinity, minK = Infinity;
  let maxI = -Infinity, maxJ = -Infinity, maxK = -Infinity;

  for (let r = 0; r < cellCount; r++) {
    const o = r * RECORD_BYTES;
    const i = view.getInt32(o, true);
    const j = view.getInt32(o + 4, true);
    const k = view.getInt32(o + 8, true);
    normalX[r] = view.getFloat32(o + 12, true);
    normalY[r] = view.getFloat32(o + 16, true);
    normalZ[r] = view.getFloat32(o + 20, true);
    cellIndexByKey.set(packKey(i, j, k), r);
    if (i < minI) minI = i; if (i > maxI) maxI = i;
    if (j < minJ) minJ = j; if (j > maxJ) maxJ = j;
    if (k < minK) minK = k; if (k > maxK) maxK = k;
  }

  // Tight world-space AABB of the occupied region, expanded by a couple of
  // voxels of margin. Used as a cheap broad-phase test so particles far
  // from the car -- the overwhelming majority at any given moment, per the
  // spawn spread in domain.js/config.js -- skip the per-cell lookup below
  // entirely instead of hashing every frame.
  const margin = pitch * 2;
  const bounds = {
    minX: originX + minI * pitch - margin,
    minY: originY + minJ * pitch - margin,
    minZ: originZ + minK * pitch - margin,
    maxX: originX + (maxI + 1) * pitch + margin,
    maxY: originY + (maxJ + 1) * pitch + margin,
    maxZ: originZ + (maxK + 1) * pitch + margin,
  };

  function cellIndexOf(x, y, z) {
    return [
      Math.floor((x - originX) / pitch),
      Math.floor((y - originY) / pitch),
      Math.floor((z - originZ) / pitch),
    ];
  }

  function isNearOccupiedRegion(x, y, z) {
    return (
      x >= bounds.minX && x <= bounds.maxX &&
      y >= bounds.minY && y <= bounds.maxY &&
      z >= bounds.minZ && z <= bounds.maxZ
    );
  }

  /** cellCount-array row index of the occupied cell at grid index (i,j,k), or -1. */
  function cellRowAt(i, j, k) {
    const row = cellIndexByKey.get(packKey(i, j, k));
    return row === undefined ? -1 : row;
  }

  function isOccupiedWorld(x, y, z) {
    const i = Math.floor((x - originX) / pitch);
    const j = Math.floor((y - originY) / pitch);
    const k = Math.floor((z - originZ) / pitch);
    return cellRowAt(i, j, k) !== -1;
  }

  /**
   * Search a (2*radiusCells+1)^3 neighbourhood of grid cells around world
   * position (x,y,z) for the nearest occupied cell (nearest by grid-index
   * offset, which is monotonic with world distance since voxels are
   * cubic), writing its unit normal into `outNormal` (a 3-element
   * array/typed-array view, mutated in place -- no allocation in the hot
   * path). Returns true if an occupied cell was found within range.
   * `radiusCells = 0` checks only the exact containing cell.
   *
   * @param {Float32Array} [outDistanceCells] optional 1-element scratch
   *   array; if given, receives the distance to the found cell in grid-cell
   *   units (0 = query point's own cell). Used by streamlines.js to fade
   *   deflection strength smoothly with distance rather than as a hard
   *   step at the search radius; particleSystem.js doesn't need it and
   *   omits this argument.
   * @param {Float32Array} [outPosition] optional 3-element scratch array;
   *   if given, receives the found cell's own world-space centre position.
   *   Used by seeding.js to snap a surface-scattered seed to the actual
   *   nearest baked surface point (then offset outward along its normal)
   *   rather than just nudging the original random sample, which could
   *   still be several cells away from any real surface.
   */
  function findNearestOccupied(x, y, z, radiusCells, outNormal, outDistanceCells, outPosition) {
    const ci = Math.floor((x - originX) / pitch);
    const cj = Math.floor((y - originY) / pitch);
    const ck = Math.floor((z - originZ) / pitch);
    let bestDist2 = Infinity;
    let bestRow = -1;
    let bestI = 0, bestJ = 0, bestK = 0;
    for (let di = -radiusCells; di <= radiusCells; di++) {
      for (let dj = -radiusCells; dj <= radiusCells; dj++) {
        for (let dk = -radiusCells; dk <= radiusCells; dk++) {
          const row = cellRowAt(ci + di, cj + dj, ck + dk);
          if (row === -1) continue;
          const d2 = di * di + dj * dj + dk * dk;
          if (d2 < bestDist2) {
            bestDist2 = d2;
            bestRow = row;
            bestI = ci + di; bestJ = cj + dj; bestK = ck + dk;
          }
        }
      }
    }
    if (bestRow === -1) return false;
    outNormal[0] = normalX[bestRow];
    outNormal[1] = normalY[bestRow];
    outNormal[2] = normalZ[bestRow];
    if (outDistanceCells) outDistanceCells[0] = Math.sqrt(bestDist2);
    if (outPosition) {
      outPosition[0] = originX + (bestI + 0.5) * pitch;
      outPosition[1] = originY + (bestJ + 0.5) * pitch;
      outPosition[2] = originZ + (bestK + 0.5) * pitch;
    }
    return true;
  }

  return {
    pitch, originX, originY, originZ, cellCount, bounds,
    cellIndexOf,
    isNearOccupiedRegion,
    isOccupiedWorld,
    findNearestOccupied,
  };
}

/**
 * Browser-only convenience loader (fetch). tests/checks.js does NOT use
 * this -- it loads the same two files directly from disk with node:fs and
 * calls parseOccupancyGrid() itself, so the Node test and the browser
 * runtime are provably reading identical bytes.
 * @param {string} [baseUrl]
 */
export async function fetchOccupancyGrid(baseUrl = DATA_DIR) {
  const [header, buffer] = await Promise.all([
    fetch(`${baseUrl}occupancy_grid.json`).then((r) => {
      if (!r.ok) throw new Error(`failed to fetch occupancy_grid.json: HTTP ${r.status}`);
      return r.json();
    }),
    fetch(`${baseUrl}occupancy_grid.bin`).then((r) => {
      if (!r.ok) throw new Error(`failed to fetch occupancy_grid.bin: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  return parseOccupancyGrid(header, buffer);
}
