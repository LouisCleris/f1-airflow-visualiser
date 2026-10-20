#!/usr/bin/env python3
"""Offline bake of a true signed distance field (SDF) around the car.

Why this exists: the runtime used to derive its "SDF" from the BINARY
occupancy grid (data/occupancy_grid.*): nearest occupied cell by integer
index offset, direction = that cell's baked normal. Distances were quantised
to whole cells and directions to per-cell normals, so every correction built
on it (clamp, reclamp, neighbour-snap) moved points in grid-aligned steps and
left staircase kinks in traced lines. This bakes the real thing: signed
distance to the REAL, full-resolution, as-displayed mesh (the same
reconstruction tests/mesh_accuracy_check.py uses -- car.js's exact
per-component mirror), sampled on a lattice twice as fine as the occupancy
grid, in a narrow band around the surface.

Output (read-only source GLB is never touched):
  data/sdf.json  header (origin, pitch, dims, block size, band, scale)
  data/sdf.bin   block-sparse payload:
                   Int32  blockTable[nbx*nby*nbz]  (index into payload, -1 = empty)
                   Int16  payload[nBlocks * B^3]   (distance / band * 32767)
Voxels in empty blocks are "far": the runtime returns +band for them. The
band covers every distance the streamlines care about (repulsion radius 3
occupancy cells, seeding reaches 3 cells out). Positive = outside the car, negative = inside.

Sign: flood-fill of the non-shell voxels (a component touching the lattice
boundary is outside, any other is inside); voxels within 1 fine voxel of the
surface take the sign of their nearest non-shell voxel. Open zero-thickness
sheets (wing elements, endplates) therefore read as positive on both sides.
The bake reports how many neighbouring voxel pairs disagree in sign while both
are well away from the surface (should be ~0).

Usage:  .venv/Scripts/python scripts/bake_sdf.py
        # finer local field for the floor slab, no conservative bias:
        .venv/Scripts/python scripts/bake_sdf.py --box -0.5 0.5 -0.02 0.12 -2.65 1.25 --refine 4 --band-cells 2 --inflate 0 --out sdf_floor
"""
import argparse
import importlib.util
import json
import sys
import time
from pathlib import Path

import numpy as np
import trimesh
from scipy import ndimage
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
BLOCK = 8


def load_real_mesh():
    spec = importlib.util.spec_from_file_location("mac", ROOT / "scripts" / "mesh_accuracy_check.py")
    mac = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mac)
    mesh, _ = mac.build_real_mesh(mac.DEFAULT_GLB)
    return mesh


MESH = None


def _init_worker(vertices, faces):
    # spawn-safe (Windows has no fork): each worker rebuilds the mesh once from plain arrays
    global MESH
    MESH = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)


def _exact_chunk(task):
    s_, e_, pts = task
    cp, dist, tri = trimesh.proximity.closest_point(MESH, pts)
    side = np.einsum("ij,ij->i", pts - cp, MESH.face_normals[tri])
    return s_, e_, dist.astype(np.float32), side.astype(np.float32)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--band-cells", type=float, default=4.0, help="band half-width in OCCUPANCY cells")
    ap.add_argument("--refine", type=int, default=2, help="SDF lattice is this many times finer than the occupancy grid")
    ap.add_argument("--inflate", type=float, default=0.6, help="subtract this many lattice pitches from every distance (conservative near thin parts)")
    ap.add_argument("--box", type=float, nargs=6, metavar=("X0", "X1", "Y0", "Y1", "Z0", "Z1"), help="bake only this world-space box (a local, finer field) instead of the whole car")
    ap.add_argument("--out", default="sdf", help="output name under data/: <out>.bin / <out>.json")
    args = ap.parse_args()

    occ = json.loads((ROOT / "data" / "occupancy_grid.json").read_text())
    occ_pitch = occ["grid"]["pitch"]
    pitch = occ_pitch / args.refine
    band = args.band_cells * occ_pitch

    t0 = time.time()
    mesh = load_real_mesh()
    print(f"[bake_sdf] real mesh {len(mesh.vertices)} verts / {len(mesh.faces)} faces", file=sys.stderr)

    if args.box:
        lo = np.array([args.box[0], args.box[2], args.box[4]])
        hi = np.array([args.box[1], args.box[3], args.box[5]])
    else:
        lo = mesh.bounds[0] - band - 2 * pitch
        hi = mesh.bounds[1] + band + 2 * pitch
    # align the lattice origin to the occupancy grid's so the two share cell corners
    o = np.array(occ["grid"]["origin"])
    origin = o + np.floor((lo - o) / pitch) * pitch
    dims = np.ceil((hi - origin) / pitch).astype(int) + 1
    # round up to whole blocks
    dims = (np.ceil(dims / BLOCK) * BLOCK).astype(int)
    print(f"[bake_sdf] lattice {dims.tolist()} at pitch {pitch:.5f} (band {band:.4f})", file=sys.stderr)

    # 1. which lattice nodes could be inside the band? The occupancy grid is a
    #    solid fill of the car, so occupied cells dilated by (band + 1.5) cells
    #    cover every node whose distance to the surface is < band.
    cells = np.fromfile(ROOT / "data" / "occupancy_grid.bin", dtype=np.dtype([("i", "<i4"), ("j", "<i4"), ("k", "<i4"), ("n", "<f4", 3)]))
    ci0 = np.array([cells["i"].min(), cells["j"].min(), cells["k"].min()])
    shape = np.array([cells["i"].max(), cells["j"].max(), cells["k"].max()]) - ci0 + 1
    pad = int(np.ceil(args.band_cells + 2))
    occ_arr = np.zeros(shape + 2 * pad, dtype=bool)
    occ_arr[cells["i"] - ci0[0] + pad, cells["j"] - ci0[1] + pad, cells["k"] - ci0[2] + pad] = True
    near_cells = ndimage.distance_transform_edt(~occ_arr) <= args.band_cells + 1.5
    axes_idx = []
    for ax in range(3):
        p_ax = origin[ax] + np.arange(dims[ax]) * pitch
        c = np.floor((p_ax - o[ax]) / occ_pitch).astype(int) - ci0[ax] + pad
        axes_idx.append(c)
    in_range = [(a_ >= 0) & (a_ < near_cells.shape[i]) for i, a_ in enumerate(axes_idx)]
    cx, cy, cz = [np.clip(a_, 0, near_cells.shape[i] - 1) for i, a_ in enumerate(axes_idx)]
    mask = near_cells[cx[:, None, None], cy[None, :, None], cz[None, None, :]]
    mask &= in_range[0][:, None, None] & in_range[1][None, :, None] & in_range[2][None, None, :]
    near = np.nonzero(mask.ravel())[0]
    print(f"[bake_sdf] {len(near)} of {mask.size} lattice nodes need an exact distance ({time.time()-t0:.0f}s)", file=sys.stderr)

    # 2. exact closest point (multiprocess; trimesh's closest_point is per-point slow)
    import multiprocessing as mp
    ijk = np.stack(np.unravel_index(near, dims), axis=-1)
    centres = origin + ijk * pitch
    chunks = ((s_, min(s_ + 50_000, len(near)), centres[s_:s_ + 50_000]) for s_ in range(0, len(near), 50_000))
    n_chunks = (len(near) + 49_999) // 50_000
    d = np.full(int(np.prod(dims)), band + 4 * pitch, dtype=np.float32)
    dd = np.empty(len(near), dtype=np.float32)
    side = np.empty(len(near), dtype=np.float32)
    with mp.get_context("spawn").Pool(4, initializer=_init_worker, initargs=(np.asarray(mesh.vertices), np.asarray(mesh.faces))) as pool:
        for n_done, (s_, e_, dist, sd_side) in enumerate(pool.imap_unordered(_exact_chunk, chunks)):
            dd[s_:e_] = dist
            side[s_:e_] = sd_side
            if n_done % 10 == 0:
                print(f"[bake_sdf] exact chunk {n_done+1}/{n_chunks} ({time.time()-t0:.0f}s)", file=sys.stderr)
    d[near] = dd
    nrm = np.zeros((len(near), 3), dtype=np.float32)
    nrm[:, 0] = side

    # 3. sign: flood fill only. The shell (nodes within 1 voxel of the surface)
    #    seals the mesh; a non-shell component touching the lattice boundary is
    #    outside, anything enclosed is inside. Shell nodes take the sign of the
    #    nearest non-shell node. Crucially this makes an open, zero-thickness
    #    sheet (wing element, endplate) POSITIVE on both sides -- an unsigned
    #    distance -- instead of giving one side a spurious "inside" band, which
    #    is what a per-face-normal sign does.
    shell = (d < 1.0 * pitch).reshape(dims)
    lab, nlab = ndimage.label(~shell)
    border = np.unique(np.concatenate([
        lab[0].ravel(), lab[-1].ravel(), lab[:, 0].ravel(), lab[:, -1].ravel(), lab[:, :, 0].ravel(), lab[:, :, -1].ravel()]))
    outside_label = np.isin(lab, border[border > 0])
    _, nearest = ndimage.distance_transform_edt(shell, return_distances=True, return_indices=True)
    outside_full = outside_label[nearest[0], nearest[1], nearest[2]]
    sign = np.where(outside_full, 1.0, -1.0).astype(np.float32).ravel()
    del nearest
    # Conservative inflation: a lattice node only samples the surface at 14.5mm
    # spacing, so trilinear interpolation OVER-estimates distance next to
    # parts thinner than a cell (rods, wing edges) -- by a few mm typically, up
    # to ~18mm worst case. Subtracting part of a cell makes the stored field
    # read slightly 'closer' than the truth everywhere, so the runtime standoff
    # errs on the safe side of the real mesh. Subtracted from the signed value, so the gradient direction is preserved.
    sd = (d * sign).astype(np.float32)
    sd = np.where(d < band + 3 * pitch, sd - args.inflate * pitch, sd).astype(np.float32)
    inside_frac = float((sd[near] < 0).mean())
    print(f"[bake_sdf] sign done ({time.time()-t0:.0f}s); inside fraction of band voxels {inside_frac:.3f}", file=sys.stderr)

    # sign-consistency report: neighbouring voxel pairs, both > 1.5 pitch from the surface, with opposite sign
    sd3 = sd.reshape(dims)
    bad = 0
    for ax in range(3):
        a = np.moveaxis(sd3, ax, 0)
        x, y = a[:-1], a[1:]
        m = (np.abs(x) > 1.5 * pitch) & (np.abs(y) > 1.5 * pitch) & (np.abs(x) < band) & (np.abs(y) < band)
        bad += int((m & (np.sign(x) != np.sign(y))).sum())
    print(f"[bake_sdf] sign-inconsistent neighbour pairs away from the surface: {bad}", file=sys.stderr)

    # 4. quantise + block-sparse pack
    q = np.clip(np.round(sd / band * 32767.0), -32767, 32767).astype(np.int16).reshape(dims)
    far = np.abs(sd.reshape(dims)) >= band
    nb = dims // BLOCK
    blocks = q.reshape(nb[0], BLOCK, nb[1], BLOCK, nb[2], BLOCK).transpose(0, 2, 4, 1, 3, 5)
    farb = far.reshape(nb[0], BLOCK, nb[1], BLOCK, nb[2], BLOCK).transpose(0, 2, 4, 1, 3, 5)
    keep = ~farb.reshape(nb[0], nb[1], nb[2], -1).all(axis=-1)
    table = np.full(nb, -1, dtype=np.int32)
    table[keep] = np.arange(int(keep.sum()), dtype=np.int32)
    payload = blocks[keep].astype("<i2")
    out_bin = ROOT / "data" / f"{args.out}.bin"
    with open(out_bin, "wb") as f:
        f.write(table.astype("<i4").tobytes(order="C"))
        f.write(payload.tobytes(order="C"))
    header = {
        "version": 1,
        "generatedBy": "scripts/bake_sdf.py",
        "sourceModel": "models/F1 model.glb (read-only; real full-resolution mesh, car.js's exact per-component mirror)",
        "origin": origin.tolist(),
        "pitch": pitch,
        "dims": dims.tolist(),
        "blockSize": BLOCK,
        "blockGrid": nb.tolist(),
        "blockCount": int(keep.sum()),
        "bandWorld": band,
        "quantisation": "int16, value = distance / bandWorld * 32767; node-centred lattice (node i at origin + i*pitch); empty blocks read as +bandWorld",
        "sign": "positive outside, negative inside",
        "signInconsistentPairs": bad,
        "refine": args.refine,
        "box": args.box,
        "inflateCells": args.inflate,
    }
    (ROOT / "data" / f"{args.out}.json").write_text(json.dumps(header, indent=2))
    print(f"[bake_sdf] wrote {out_bin} {out_bin.stat().st_size/1e6:.2f} MB, {int(keep.sum())} blocks ({time.time()-t0:.0f}s)", file=sys.stderr)


if __name__ == "__main__":
    main()
