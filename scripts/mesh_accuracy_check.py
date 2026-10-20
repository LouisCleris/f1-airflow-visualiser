#!/usr/bin/env python3
"""Assertion 4's real implementation (tests/checks.js shells out to this):
checks streamline points against the ACTUAL displayed GLB mesh, not the
baked occupancy grid.

Why this exists, not a grid check: a mesh-accurate audit (2026-09,
the author's review) found streamlines that passed the old grid-only assertion
4 with zero violations nonetheless crossing the tyre crown, front wing
endplate, and bodywork flank in renders. The grid is a discretised proxy;
this checks the thing the user actually sees. It's slower (a few seconds
per run, dominated by loading + reconstructing the full-resolution mesh)
and requires the project's .venv (trimesh, numpy, rtree) -- acceptable
since this runs offline in tests/checks.js, never in the browser.

Reconstructs the exact mesh src/car.js renders: full resolution (no
decimation), every node's own world transform applied, and car.js's exact
per-component runtime mirror (RIGHT_ONLY_COMPONENTS, copied verbatim) --
not bake_occupancy_grid.py's blanket whole-mesh mirror, which is a
reasonable proxy for collision purposes but not the literal displayed
geometry this check needs to be honest about.

Usage
-----
    .venv/Scripts/python scripts/mesh_accuracy_check.py \\
        --points scripts/.tmp_mesh_check_points.bin \\
        --threshold 0.001 [--scene falcon]

Reads --points as a flat float32 binary (x,y,z triples, native-endian --
tests/checks.js writes it with Node's Buffer, which is little-endian on
every platform this project targets). Prints ONE line of JSON to stdout;
everything else goes to stderr so stdout stays parseable by the caller.
"""
import argparse
import itertools
import json
import re
import sys
from pathlib import Path

import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_GLB = ROOT / "models" / "F1 model.glb"

# Copied verbatim from src/car.js's RIGHT_ONLY_COMPONENTS -- see that
# file's header for why these specific components are mirrored at
# runtime rather than the whole mesh. Trailing spaces are exactly as
# authored; kept verbatim so this stays a faithful reproduction of what
# car.js actually renders, not an approximation of it.
RIGHT_ONLY_COMPONENTS = {
    'Rear Wing main part', 'Rear Wing side plate', 'Rear wing DRS ',
    'Rear Wing Holder', 'Rear wing DRS .001', 'DRS Holder', 'DRS Mechanism',
    'Front wing side plates ', 'Front Wing Bottom', 'Front Wing middle',
    'Front wing Top', 'Front wing Connecting pieces ', 'Front Wing Mount',
    'Main body', 'Floor', 'Rear LED', 'Top Intake Details', 'Mirrors',
    'Inside Seat', 'Glass', 'Front Flap Details', 'Front Wheelover',
    'Front Tire', 'Front Inside Cover', 'Rear Wheelover', 'Rear Tire',
    'Rear Inside Cover', 'Front Arms ', 'Front Rods', 'Back Arms', 'Rear Rods',
}

DEDUP_SUFFIX_RE = re.compile(r'_[0-9a-f]{6}$')


def base_name(node_name):
    """Strips trimesh's auto-appended 6-hex-char disambiguation suffix
    (added when >1 scene node shares an authored name -- e.g. a
    multi-primitive component like 'Front Wheelover' becomes two trimesh
    nodes) to recover the true authored glTF node name."""
    return DEDUP_SUFFIX_RE.sub('', node_name)


def mirror_vertices_faces(vertices, faces):
    """Same reflection as src/car.js's mirrorAcrossCentreline (world X=0
    plane): negate X, reverse winding to keep outward-facing normals."""
    mv = vertices.copy()
    mv[:, 0] *= -1
    mf = faces[:, [0, 2, 1]]
    return mv, mf


def build_real_mesh(glb_path):
    """Returns (combined trimesh.Trimesh, per-face component-name array),
    reconstructed exactly as src/car.js renders it."""
    scene = trimesh.load(glb_path)

    per_component = {}
    for node_name in scene.graph.nodes_geometry:
        transform, geom_name = scene.graph[node_name]
        geom = scene.geometry[geom_name]
        v_world = (transform[:3, :3] @ geom.vertices.T).T + transform[:3, 3]
        name = base_name(node_name)
        per_component.setdefault(name, []).append((v_world, geom.faces))

    combined_v, combined_f, face_component = [], [], []
    voffset = 0
    for name, parts in per_component.items():
        all_v, all_f, offset = [], [], 0
        for v, f in parts:
            all_v.append(v)
            all_f.append(f + offset)
            offset += len(v)
        v_cat, f_cat = np.vstack(all_v), np.vstack(all_f)

        if name in RIGHT_ONLY_COMPONENTS:
            mv, mf = mirror_vertices_faces(v_cat, f_cat)
            v_full = np.vstack([v_cat, mv])
            f_full = np.vstack([f_cat, mf + len(v_cat)])
        else:
            v_full, f_full = v_cat, f_cat

        combined_v.append(v_full)
        combined_f.append(f_full + voffset)
        face_component.extend([name] * len(f_full))
        voffset += len(v_full)

    combined = trimesh.Trimesh(vertices=np.vstack(combined_v), faces=np.vstack(combined_f), process=False)
    return combined, np.array(face_component)


QUERY_CHUNK = 2000  # points per closest_point call: its working memory grows with distance from the mesh (measured
#                     ~0.9 MB per point for Falcon streamline points), so one call over every point could need >100 GB


def exact_distances(mesh, points):
    """trimesh closest_point in bounded chunks (identical results to one call)."""
    dist = np.empty(len(points))
    tri = np.empty(len(points), dtype=np.int64)
    for s_ in range(0, len(points), QUERY_CHUNK):
        _, dist[s_:s_ + QUERY_CHUNK], tri[s_:s_ + QUERY_CHUNK] = trimesh.proximity.closest_point(mesh, points[s_:s_ + QUERY_CHUNK])
    return dist, tri


def outside_baked_band(points, sdf_dir):
    """True where none of the 8 lattice nodes around a point lies in a non-empty block of the baked distance field of
    the same mesh (sdf.json/.bin): such a point is farther than the field's band (~0.1 world units) from the surface,
    far beyond any violation threshold, so it skips the exact query (which is most expensive exactly there)."""
    h = json.loads((sdf_dir / "sdf.json").read_text())
    nb = np.array(h["blockGrid"])
    dims = np.array(h["dims"])
    table = np.fromfile(sdf_dir / "sdf.bin", dtype="<i4", count=int(np.prod(nb))).reshape(nb)
    i0 = np.floor((points - np.array(h["origin"])) / h["pitch"]).astype(np.int64)
    near = np.zeros(len(points), dtype=bool)
    for corner in itertools.product((0, 1), repeat=3):
        idx = i0 + np.array(corner)
        inside = np.all((idx >= 0) & (idx < dims), axis=1)
        b = np.clip(idx // h["blockSize"], 0, nb - 1)
        near |= inside & (table[b[:, 0], b[:, 1], b[:, 2]] >= 0)
    return ~near


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--points", required=True, help="flat float32 binary of x,y,z triples")
    parser.add_argument("--source", default=str(DEFAULT_GLB), help="source GLB (read-only)")
    parser.add_argument("--scene", choices=["f1", "falcon"], default="f1",
                        help="falcon: the Falcon 6X as src/falcon.js displays it (complete aircraft, placement from "
                             "data/falcon/domain.json), via scripts/falcon_mesh.py")
    parser.add_argument("--threshold", type=float, default=0.001,
                         help="a point within this many world units of the real surface counts as "
                              "a violation -- 0.001 is 'essentially touching', not grid-scale")
    args = parser.parse_args()

    points = np.fromfile(args.points, dtype=np.float32).reshape(-1, 3)
    print(f"[mesh_accuracy_check] loaded {len(points)} points from {args.points}", file=sys.stderr)

    if args.scene == "falcon":
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from falcon_mesh import build_falcon_mesh
        placement = json.loads((ROOT / "data" / "falcon" / "domain.json").read_text())["placement"]
        combined, face_component = build_falcon_mesh(placement["scale"], placement["pitchDeg"], placement["pivot"])
        print(f"[mesh_accuracy_check] real Falcon mesh: {len(combined.vertices)} verts, {len(combined.faces)} faces "
              f"(full resolution, placed as src/falcon.js displays it)", file=sys.stderr)
    else:
        combined, face_component = build_real_mesh(args.source)
        print(f"[mesh_accuracy_check] real mesh: {len(combined.vertices)} verts, {len(combined.faces)} faces "
              f"(full resolution, car.js's exact per-component mirror)", file=sys.stderr)

    # F1: exact distance for every point. Falcon: exact for every point within the baked field's band; the rest are
    # reported as a count (farther than the band), not as distances.
    far = outside_baked_band(points, ROOT / "data" / "falcon") if args.scene == "falcon" else np.zeros(len(points), dtype=bool)
    near_points = points[~far]
    distance, triangle_id = exact_distances(combined, near_points)
    nearest_component = face_component[triangle_id]

    violated = distance < args.threshold
    n_violations = int(violated.sum())

    by_component = {}
    if n_violations:
        comps, counts = np.unique(nearest_component[violated], return_counts=True)
        order = np.argsort(-counts)
        by_component = {str(c): int(n) for c, n in zip(comps[order], counts[order])}

    pct_keys = [0, 1, 5, 10, 25, 50, 75, 90, 95, 99, 100]
    percentiles = {str(p): float(v) for p, v in zip(pct_keys, np.percentile(distance, pct_keys))}

    result = {
        "pointCount": int(len(points)),
        "exactPointCount": int(len(near_points)),
        "farPointCount": int(far.sum()),
        "violationCount": n_violations,
        "threshold": args.threshold,
        "violationsByComponent": by_component,
        "distancePercentiles": percentiles,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
