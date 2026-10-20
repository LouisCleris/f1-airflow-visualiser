#!/usr/bin/env python3
"""Offline bake of the signed distance field around the Falcon 6X (the same kind of field scripts/bake_sdf.py makes
for the F1: true distance to the real, full-resolution, as-displayed mesh, block-sparse int16, narrow band, positive
outside / negative inside, sheets read positive on both sides).

Differences from the F1 bake: there is no occupancy grid to mask with, so the band is found from points sampled on the
mesh surface; the mesh is the complete aircraft placed by the scene config (scale, pitch), not a mirrored half; the
lattice pitch is the F1's (so every *Cells value in the shared pipeline means the same thing), and the output goes to
data/falcon/. It also writes data/falcon/domain.json: the flow domain's bounding box (from the placed vertices) and
the placement it was baked with, so the browser, the streamline bake and the checks all use one domain.

Memory: trimesh's closest_point needs about 81 kB per query point on this mesh (326k faces; measured), so the exact
distances run in small chunks (--chunk, default 2000 points = ~165 MB per worker). The first version sent 40,000-point
chunks to 4 workers (~13 GB at once), which is what crashed the Mac. The lattice itself is ~16M nodes (~0.5 GB for the
sign step's distance transform with indices). The bake prints its estimated peak before starting.

Usage:  npm run bake:falcon      (scripts/bake_falcon.mjs passes the values from src/sceneConfig.js)
        .venv/Scripts/python scripts/bake_falcon_sdf.py --scale 0.22 --pitch 2.5 --pivot 0 3.4673 0.5065
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import trimesh
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from falcon_mesh import ROOT, build_falcon_mesh  # noqa: E402

BLOCK = 8
OUT_DIR = ROOT / "data" / "falcon"
F1_PITCH = 0.01446922409037749  # the F1 lattice pitch: keeps "occupancy cell = 2 pitches" true in the shared code
CELL = 2 * F1_PITCH

MESH = None
BYTES_PER_QUERY = 85_000  # closest_point working memory per point, measured on this mesh (~81 kB) plus a margin


def _init_worker(vertices, faces):
    # spawn-safe (Windows has no fork): each worker rebuilds the mesh once from plain arrays
    global MESH
    MESH = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)


def _exact_chunk(task):
    s_, e_, pts = task
    _, dist, _ = trimesh.proximity.closest_point(MESH, pts)
    return s_, e_, dist.astype(np.float32)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--scale", type=float, required=True)
    ap.add_argument("--pitch", type=float, required=True, help="nose-up pitch, degrees")
    ap.add_argument("--pivot", type=float, nargs=3, required=True, help="model-space point the aircraft is pitched about and centred on")
    ap.add_argument("--band-cells", type=float, default=4.0)
    ap.add_argument("--inflate", type=float, default=0.6)
    ap.add_argument("--flow-axis", default="z")
    ap.add_argument("--flow-sign", type=int, default=-1)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--chunk", type=int, default=2000, help="query points per closest_point call (memory, not quality)")
    args = ap.parse_args()

    pitch = F1_PITCH
    band = args.band_cells * CELL
    t0 = time.time()
    mesh, face_names = build_falcon_mesh(args.scale, args.pitch, args.pivot)
    print(f"[bake_falcon_sdf] mesh {len(mesh.vertices)} verts / {len(mesh.faces)} faces, bounds {mesh.bounds.round(3).tolist()}", file=sys.stderr)

    lo = mesh.bounds[0] - band - 2 * pitch
    hi = mesh.bounds[1] + band + 2 * pitch
    origin = np.floor(lo / pitch) * pitch
    dims = np.ceil((hi - origin) / pitch).astype(int) + 1
    dims = (np.ceil(dims / BLOCK) * BLOCK).astype(int)
    print(f"[bake_falcon_sdf] lattice {dims.tolist()} at pitch {pitch:.5f} (band {band:.4f})", file=sys.stderr)

    # 1. which lattice nodes could be inside the band: voxels holding a surface sample, grown by band + 1.5 pitches
    count = int(mesh.area / (pitch * 0.6) ** 2) + 1000
    pts, _ = trimesh.sample.sample_surface(mesh, count, seed=7)
    occ = np.zeros(dims, dtype=bool)
    idx = np.floor((pts - origin) / pitch + 0.5).astype(int)
    occ[idx[:, 0], idx[:, 1], idx[:, 2]] = True
    # the aircraft's extreme vertices too (sampling can miss a thin tip)
    vi = np.floor((mesh.vertices - origin) / pitch + 0.5).astype(int)
    occ[vi[:, 0], vi[:, 1], vi[:, 2]] = True
    dist_to_occ = ndimage.distance_transform_edt(~occ)
    mask = dist_to_occ <= band / pitch + 1.5
    del dist_to_occ, occ
    near = np.nonzero(mask.ravel())[0]
    print(f"[bake_falcon_sdf] {len(near)} of {mask.size} lattice nodes need an exact distance ({time.time()-t0:.0f}s)", file=sys.stderr)

    # 2. exact distance to the real mesh (multiprocess, bounded chunks; see Memory above)
    import multiprocessing as mp
    ijk = np.stack(np.unravel_index(near, dims), axis=-1)
    centres = origin + ijk * pitch
    del ijk
    n_nodes = int(np.prod(dims))
    est = (args.workers * (args.chunk * BYTES_PER_QUERY + 150e6)  # per worker: queries + its own mesh copy and interpreter
           + n_nodes * (4 + 4 + 1) + len(near) * 40               # parent: d, sd, masks, centres
           + n_nodes * (8 + 12 + 4 + 1))                          # sign step: EDT distances + indices, labels, shell
    print(f"[bake_falcon_sdf] estimated peak memory {est/1e9:.1f} GB ({args.workers} workers x {args.chunk} points)", file=sys.stderr)
    step = args.chunk
    chunks = ((s_, min(s_ + step, len(near)), centres[s_:s_ + step]) for s_ in range(0, len(near), step))
    n_chunks = (len(near) + step - 1) // step
    d = np.full(n_nodes, band + 4 * pitch, dtype=np.float32)
    dd = np.empty(len(near), dtype=np.float32)
    with mp.get_context("spawn").Pool(args.workers, initializer=_init_worker, initargs=(np.asarray(mesh.vertices), np.asarray(mesh.faces))) as pool:
        for n_done, (s_, e_, dist) in enumerate(pool.imap_unordered(_exact_chunk, chunks, chunksize=1)):
            dd[s_:e_] = dist
            if n_done % 100 == 0:
                print(f"[bake_falcon_sdf] exact chunk {n_done+1}/{n_chunks} ({time.time()-t0:.0f}s)", file=sys.stderr)
    del centres
    d[near] = dd

    # 3. sign by flood fill, exactly as scripts/bake_sdf.py
    shell = (d < 1.0 * pitch).reshape(dims)
    lab, nlab = ndimage.label(~shell)
    border = np.unique(np.concatenate([
        lab[0].ravel(), lab[-1].ravel(), lab[:, 0].ravel(), lab[:, -1].ravel(), lab[:, :, 0].ravel(), lab[:, :, -1].ravel()]))
    outside_label = np.isin(lab, border[border > 0])
    _, nearest = ndimage.distance_transform_edt(shell, return_distances=True, return_indices=True)
    outside_full = outside_label[nearest[0], nearest[1], nearest[2]]
    sign = np.where(outside_full, 1.0, -1.0).astype(np.float32).ravel()
    del nearest
    sd = (d * sign).astype(np.float32)
    sd = np.where(d < band + 3 * pitch, sd - args.inflate * pitch, sd).astype(np.float32)
    print(f"[bake_falcon_sdf] sign done ({time.time()-t0:.0f}s); inside fraction of band voxels {float((sd[near] < 0).mean()):.3f}", file=sys.stderr)

    sd3 = sd.reshape(dims)
    bad = 0
    for ax in range(3):
        a = np.moveaxis(sd3, ax, 0)
        x, y = a[:-1], a[1:]
        m = (np.abs(x) > 1.5 * pitch) & (np.abs(y) > 1.5 * pitch) & (np.abs(x) < band) & (np.abs(y) < band)
        bad += int((m & (np.sign(x) != np.sign(y))).sum())
    print(f"[bake_falcon_sdf] sign-inconsistent neighbour pairs away from the surface: {bad}", file=sys.stderr)

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
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_bin = OUT_DIR / "sdf.bin"
    with open(out_bin, "wb") as f:
        f.write(table.astype("<i4").tobytes(order="C"))
        f.write(payload.tobytes(order="C"))
    header = {
        "version": 1,
        "generatedBy": "scripts/bake_falcon_sdf.py",
        "sourceModel": "models/Falcon 6X.glb (read-only; real full-resolution mesh, complete aircraft, placed by src/sceneConfig.js)",
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
        "refine": 2,
        "inflateCells": args.inflate,
    }
    (OUT_DIR / "sdf.json").write_text(json.dumps(header, indent=2))
    domain = {
        "version": 1,
        "generatedBy": "scripts/bake_falcon_sdf.py",
        "note": "Flow domain of the Falcon scene: bounding box of the placed full-resolution mesh. Streamline fractions in rakes.json are relative to it.",
        "placement": {"scale": args.scale, "pitchDeg": args.pitch, "pivot": list(args.pivot)},
        "flowAxis": args.flow_axis,
        "flowSign": args.flow_sign,
        "bboxMin": mesh.bounds[0].tolist(),
        "bboxMax": mesh.bounds[1].tolist(),
    }
    (OUT_DIR / "domain.json").write_text(json.dumps(domain, indent=2))
    print(f"[bake_falcon_sdf] wrote {out_bin} {out_bin.stat().st_size/1e6:.2f} MB, {int(keep.sum())} blocks ({time.time()-t0:.0f}s)", file=sys.stderr)


if __name__ == "__main__":
    main()
