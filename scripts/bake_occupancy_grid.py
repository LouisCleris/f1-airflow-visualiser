#!/usr/bin/env python3
"""Offline bake of the invisible particle-collision occupancy grid.

Per CLAUDE.md's "one rule that matters": the source GLB is NEVER touched.
This script only ever READS `models/F1 model.glb` (default) and writes to
`data/`. Decimation happens on an in-memory COPY (via
`fast_simplification.simplify`) that is discarded once the bake finishes --
nothing decimated is ever written back over a display asset, and the
full-detail mesh src/car.js loads for on-screen rendering is completely
untouched by anything in this file.

Pipeline
--------
1. Load the source GLB with `trimesh.load(path)` (NOT `force='scene'` --
   CLAUDE.md flags that as silently merging geometry/losing names; letting
   trimesh auto-detect returns a `Scene` naturally here because the GLB has
   54 named geometries, which is what we want -- named per-instance access
   plus each node's world transform, before we concatenate anything
   ourselves for voxelisation).
2. Concatenate every geometry instance into one world-space mesh
   (`Scene.to_geometry()`) -- this is the RIGHT-HAND HALF car only, exactly
   as src/car.js documents (see its file header).
3. FULL RESOLUTION by default (`--target-reduction 0`, no decimation) --
   see "Solid voxelisation, decimation reconsidered" below for why the
   previous 90% decimation was dropped rather than kept as a speed
   trade-off. `fast_simplification.simplify` (never
   `trimesh.simplify_quadric_decimation`, per CLAUDE.md -- that is
   documented as unreliable) is still available via `--target-reduction`
   for anyone who wants to re-check the old behaviour, just not used by
   default any more.
4. Mirror the (by default full-resolution, undecimated) copy about world
   X = 0 to reconstruct the full car's collision volume. This uses the
   exact same plane as src/car.js's runtime mirror (see that file's
   header: `mirror.position.x = -x`, i.e. reflection through world X = 0).
   Concretely: negate every vertex's X coordinate, and reverse each face's
   winding order (swap two indices) so the reflected triangles keep
   outward-facing normals -- three.js does this reversal for us
   automatically at render time for a negative-determinant transform (see
   car.js), trimesh does not, so it is done explicitly here. Verified
   below: the small components that are already symmetric in the source
   file (steering wheel, antennas, etc. -- see PROGRESS.md Phase 1) mirror
   onto themselves and contribute nothing new; only the asymmetric
   right-only bodywork produces the missing left half, which is
   mathematically identical to car.js's per-component mirroring list
   without having to duplicate that name list in Python.
5. Voxelise the full mirrored mesh into a SOLID grid, not a hollow shell:
   `trimesh.Trimesh.voxelized(pitch, method='subdivide')` first (a surface
   voxelisation), then a 1-iteration binary dilation (grows the occupied
   set by one voxel layer in every direction -- the discrete equivalent of
   "inflate thin geometry by half a voxel": a wall/endplate thinner than
   one voxel, or a hairline gap the point-sampling subdivision missed,
   becomes solid either way), then `VoxelGrid.fill(method='holes')` to
   flood-fill any enclosed interior. Assertion 4 (tests/checks.js) checks
   whether a streamline POINT sits inside occupied space -- a hollow shell
   only blocks a point that lands exactly on the (already sparse) sampled
   surface, while a solid fill blocks any point that ends up anywhere
   under the skin, which is the actual invariant that matters. See "Solid
   voxelisation" below for benchmark numbers.
6. For every occupied cell, compute a representative local surface normal:
   an area-weighted average of nearby face normals within a small search
   radius (expanding the radius if the first attempt finds nothing, e.g.
   over a degenerate/zero-area sliver face left behind by decimation),
   falling back to the single nearest face's normal as a last resort. This
   is the "area-weighted average of nearby face normals" option named in
   BUILD.md/CLAUDE.md, chosen over plain nearest-face because a handful of
   decimated faces came back as exactly zero-area/zero-normal in testing
   (932 of 18304 on the default settings) and a single-nearest-face lookup
   would occasionally have picked one of those degenerate faces.
7. Save `data/occupancy_grid.json` (header: pitch, origin, dims, cell
   count, decimation/mirror/bake provenance, flow-domain bounding info) and
   `data/occupancy_grid.bin` (flat binary: per occupied cell, int32 grid
   index i,j,k + float32 unit normal nx,ny,nz -- 24 bytes/cell, see the
   header's `binaryFormat` field for the exact byte layout).

Solid voxelisation, decimation reconsidered (the author's post-Phase-3.7 review)
----------------------------------------------------------------------------
A mesh-accurate check (a one-off script, trimesh, against the real
full-resolution GLB) found real streamlines -- ones that passed assertion
4 against the OLD grid with zero violations -- actually crossing the tyre
crown, front wing endplate, and bodywork flank, at rates from 0.3% of
points (essentially touching) up to 8% (within one grid cell). Root cause
was two-fold, both traced to the previous bake:
  1. `voxelized(pitch, method='subdivide')` alone marks a hollow SHELL by
     recursively subdividing triangles and rounding sample points to the
     nearest voxel -- a point-sampling approximation of the surface, not a
     literal "every intersected cell" or "solid volume" test. Assertion 4
     checks whether a streamline POINT is occupied; a hollow shell only
     catches a point landing exactly on that sparse sample set, not one
     that has drifted past it into open interior space directly under the
     skin.
  2. The bake decimated to 10% of original face count
     (`target_reduction=0.9`) before voxelising. Decimating a CONVEX
     curved surface (a tyre crown, a wing's curvature) produces a coarser
     polygon hull that sits INSIDE the true curve -- a general property of
     mesh simplification, not a bug in any one setting -- so even a
     perfect voxelisation of the decimated copy would still under-represent
     the real, displayed surface. It also disproportionately loses small
     thin features (endplates) relative to large flat panels.

Benchmarked before changing the default (script: a one-off benchmark,
`.venv/Scripts/python` timing `voxelized()` + `.fill()` at several decimation
levels against this same GLB):

    | decimation      | bake time | filled cells | .bin size |
    |-----------------|-----------|--------------|-----------|
    | 90% (old)       |    ~7.2s  |       36,862 |    865 KB |
    | 50%             |   ~10.1s  |       60,594 |  1,420 KB |
    | 0% (full res)   |   ~11.1s  |       61,841 |  1,449 KB |

Full resolution costs ~4 seconds more than 90% decimation and produces
essentially the SAME cell count as 50% decimation -- decimation was never
buying much speed at this mesh/pitch, so it was dropped entirely rather
than kept as a trade-off. (For reference, `models/F1 model.glb` itself is
~26.8 MB, already fetched by the app; a ~1.4-2.7MB grid file is a small
fraction of that and not a realistic load-time concern.)

Final pipeline actually shipped, all at full resolution: shell voxelise ->
1-iteration binary dilation (inflate by one voxel layer -- the discrete
form of "half a voxel" a grid can actually represent, closes any hairline
gaps the shell step missed AND thickens sub-voxel-thin walls) -> flood-fill
enclosed interior (`VoxelGrid.fill(method='holes')`). This produced
110,908 cells / ~2.66 MB (`--voxel-divisions 180`, same as before) -- see
PROGRESS.md for the resulting mesh-accuracy re-check.

Usage
-----
    .venv/Scripts/python scripts/bake_occupancy_grid.py [--voxel-divisions N]
                                                       [--target-reduction F]
                                                       [--agg F]
                                                       [--dilate-iterations N]

Re-run this any time the voxel size needs to change (BUILD.md/CLAUDE.md:
"if the collision grid is too coarse ... make the voxels smaller" -- never
decimate the display mesh to compensate). Defaults below were chosen by
hands-on tuning against the real model -- see PROGRESS.md Phase 3 entry for
the numbers considered and why these were picked, and the section above for
why decimation defaults to off and the grid is now solid rather than a shell.
"""

import argparse
import importlib.metadata
import json
import platform
import re
import struct
import sys
import time
from pathlib import Path

import numpy as np
import trimesh
import fast_simplification
from scipy.spatial import cKDTree
from trimesh.voxel import morphology

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "models" / "F1 model.glb"
OUT_JSON = ROOT / "data" / "occupancy_grid.json"
OUT_BIN = ROOT / "data" / "occupancy_grid.bin"


def pkg_version(name):
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def derive_flow_domain(scene, half_mesh):
    """Reproduce src/particles/domain.js's axis/sign derivation in Python,
    from the RAW (un-decimated, un-mirrored) half-car scene graph, so the
    baked header carries real, re-derived-not-assumed flow-domain metadata
    instead of a hardcoded axis. Mirrors domain.js's own comment: flow axis
    is whichever horizontal world axis (X/Z) the bounding box is longer
    along; flow direction is derived by comparing the average world
    position of every node whose name matches /front/i against every node
    matching /rear|back/i, along that axis.
    """
    bounds = half_mesh.bounds
    size_x = bounds[1][0] - bounds[0][0]
    size_z = bounds[1][2] - bounds[0][2]
    flow_axis = "x" if size_x >= size_z else "z"
    axis_i = 0 if flow_axis == "x" else 2

    front_vals, rear_vals = [], []
    for node_name in scene.graph.nodes_geometry:
        transform, geom_name = scene.graph[node_name]
        geom = scene.geometry[geom_name]
        world_centroid = (transform @ np.append(geom.centroid, 1.0))[:3]
        if re.search(r"front", node_name, re.I):
            front_vals.append(world_centroid[axis_i])
        elif re.search(r"rear|back", node_name, re.I):
            rear_vals.append(world_centroid[axis_i])

    if front_vals and rear_vals:
        flow_sign = 1 if np.mean(rear_vals) >= np.mean(front_vals) else -1
    else:
        flow_sign = 1  # fallback, matches domain.js

    return {"flowAxis": flow_axis, "flowSign": flow_sign}


def mirror_about_x(vertices, faces):
    """Reflect `vertices`/`faces` about world X = 0, matching src/car.js's
    runtime mirror plane exactly (see module docstring point 4). Reversing
    the face winding keeps normals outward-facing after the reflection --
    three.js does this compensation for us at render time for the on-screen
    mirrored halves (negative-determinant transform); trimesh does not, so
    it is done explicitly here.
    """
    mirrored_vertices = vertices.copy()
    mirrored_vertices[:, 0] *= -1
    mirrored_faces = faces[:, [0, 2, 1]]
    return mirrored_vertices, mirrored_faces


def compute_cell_normals(mesh, points, base_radius):
    """Area-weighted average of nearby face normals for each point (see
    module docstring point 6), expanding the search radius if a first
    attempt finds nothing usable (e.g. only zero-area decimation slivers
    nearby), with a last-resort nearest-single-face fallback.
    """
    centroids = mesh.triangles_center
    tree = cKDTree(centroids)
    face_normals = mesh.face_normals
    face_areas = mesh.area_faces

    normals = np.empty((len(points), 3), dtype=np.float64)
    fallback_used = 0
    for i, p in enumerate(points):
        radius = base_radius
        found = False
        for _ in range(6):  # expand up to 6 times (~64x the base radius)
            idxs = tree.query_ball_point(p, r=radius)
            if idxs:
                areas = face_areas[idxs]
                weight_sum = areas.sum()
                if weight_sum > 1e-12:
                    n = (face_normals[idxs] * areas[:, None]).sum(axis=0)
                    length = np.linalg.norm(n)
                    if length > 1e-9:
                        normals[i] = n / length
                        found = True
                        break
            radius *= 2
        if not found:
            fallback_used += 1
            _, nearest_face = tree.query(p, k=1)
            n = face_normals[nearest_face]
            length = np.linalg.norm(n)
            normals[i] = n / length if length > 1e-9 else np.array([0.0, 1.0, 0.0])

    return normals, fallback_used


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=str(DEFAULT_SOURCE), help="source GLB (read-only)")
    parser.add_argument("--target-reduction", type=float, default=0.0,
                         help="fast_simplification target_reduction (fraction of faces removed). "
                              "0 = full resolution, the default since the benchmark in this file's "
                              "docstring found decimation wasn't buying meaningful bake-time savings "
                              "at this mesh/pitch, while costing real accuracy on convex/thin geometry.")
    parser.add_argument("--agg", type=float, default=5.0,
                         help="fast_simplification aggressiveness (0=quality/slow .. 10=fast/crude), "
                              "only relevant when --target-reduction > 0")
    parser.add_argument("--voxel-divisions", type=int, default=180,
                         help="voxel pitch = (largest bbox extent) / this number")
    parser.add_argument("--dilate-iterations", type=int, default=1,
                         help="binary dilation passes applied to the shell voxelisation before the "
                              "solid fill -- the discrete form of 'inflate thin geometry by half a "
                              "voxel' (a grid can only inflate in whole-cell steps); also closes small "
                              "gaps the shell step's point-sampling missed, which the interior fill "
                              "step needs anyway to avoid leaking through into where it shouldn't")
    args = parser.parse_args()

    source_path = Path(args.source)
    if not source_path.exists():
        print(f"FAIL: source model not found: {source_path}", file=sys.stderr)
        sys.exit(1)

    t_start = time.time()
    print(f"Loading (read-only) {source_path} ...")
    # No force='scene' (CLAUDE.md) -- trimesh auto-returns a Scene here
    # because the GLB genuinely has multiple named geometries.
    scene = trimesh.load(source_path)
    if not isinstance(scene, trimesh.Scene):
        print("FAIL: expected trimesh.load() to return a Scene (multi-geometry GLB) — "
              "got a single Trimesh instead. The source model may have changed shape; "
              "re-check this script's assumptions before proceeding.", file=sys.stderr)
        sys.exit(1)
    print(f"  {len(scene.geometry)} named geometries, "
          f"{len(list(scene.graph.nodes_geometry))} scene-graph node instances")

    half_mesh = scene.to_geometry()  # concatenated, world-space, RIGHT-HALF only
    orig_verts, orig_faces = len(half_mesh.vertices), len(half_mesh.faces)
    print(f"  concatenated half-car mesh (undecimated): {orig_verts} verts, {orig_faces} faces")

    flow_domain = derive_flow_domain(scene, half_mesh)
    print(f"  derived flow domain: axis={flow_domain['flowAxis']} sign={flow_domain['flowSign']}")

    # --- Decimate a COPY (never the original arrays are touched on disk) ---
    # Default is 0 (full resolution, no decimation at all) -- see this
    # file's docstring, "Solid voxelisation, decimation reconsidered", for
    # the benchmark that found decimation wasn't buying meaningful bake-time
    # savings while costing real accuracy on convex/thin geometry.
    if args.target_reduction > 0:
        print(f"Decimating a copy (target_reduction={args.target_reduction}, agg={args.agg}) ...")
        dec_vertices, dec_faces = fast_simplification.simplify(
            half_mesh.vertices, half_mesh.faces,
            target_reduction=args.target_reduction, agg=args.agg,
        )
        print(f"  decimated half-car: {len(dec_vertices)} verts, {len(dec_faces)} faces "
              f"({100 * (1 - len(dec_faces) / orig_faces):.1f}% face reduction)")
    else:
        print("No decimation (--target-reduction 0, full resolution) ...")
        dec_vertices, dec_faces = half_mesh.vertices, half_mesh.faces

    # --- Mirror the decimated copy about world X = 0 (src/car.js's plane) ---
    mirror_vertices, mirror_faces = mirror_about_x(dec_vertices, dec_faces)
    offset = len(dec_vertices)
    full_vertices = np.vstack([dec_vertices, mirror_vertices])
    full_faces = np.vstack([dec_faces, mirror_faces + offset])
    full_mesh = trimesh.Trimesh(vertices=full_vertices, faces=full_faces, process=False)
    print(f"  mirrored full-car collision mesh: {len(full_mesh.vertices)} verts, "
          f"{len(full_mesh.faces)} faces, watertight={full_mesh.is_watertight}")
    print(f"  full-car bounds (collision copy, target_reduction={args.target_reduction}): "
          f"min={full_mesh.bounds[0].tolist()} max={full_mesh.bounds[1].tolist()}")

    # Also compute the FULL-RESOLUTION (undecimated) mirrored bounds -- more
    # faithful car dimensions for the runtime flow-domain metadata, decoupled
    # from how coarse the collision copy is.
    full_res_mirror_v, _ = mirror_about_x(half_mesh.vertices, half_mesh.faces)
    full_res_bounds_min = np.minimum(half_mesh.bounds[0], full_res_mirror_v.min(axis=0)).tolist()
    full_res_bounds_max = np.maximum(half_mesh.bounds[1], full_res_mirror_v.max(axis=0)).tolist()

    # --- Voxelise: shell -> dilate (inflate) -> solid fill ---
    extent = full_mesh.bounds[1] - full_mesh.bounds[0]
    pitch = float(max(extent) / args.voxel_divisions)
    print(f"Voxelising at pitch={pitch:.5f} (bbox largest extent / {args.voxel_divisions}) ...")
    t0 = time.time()
    vox = full_mesh.voxelized(pitch, method="subdivide")
    shell_cells = len(vox.points)
    print(f"  shell: {shell_cells} occupied cells, {time.time() - t0:.2f}s")

    t0 = time.time()
    if args.dilate_iterations > 0:
        vox.encoding = morphology.binary_dilation(vox.encoding, iterations=args.dilate_iterations)
    dilated_cells = len(vox.points)
    print(f"  dilated ({args.dilate_iterations}x): {dilated_cells} occupied cells "
          f"(+{dilated_cells - shell_cells}), {time.time() - t0:.2f}s")

    t0 = time.time()
    vox.fill(method="holes")
    filled_cells = len(vox.points)
    print(f"  solid fill: {filled_cells} occupied cells (+{filled_cells - dilated_cells} interior), "
          f"{time.time() - t0:.2f}s")

    sparse_indices = vox.sparse_indices  # (N, 3) int, grid-space i,j,k
    points = vox.points  # (N, 3) float, world-space cell centers
    origin = vox.transform[:3, 3].tolist()  # world coords of index (0,0,0)

    # --- Per-cell normals ---
    print("Computing per-cell surface normals (area-weighted nearby faces) ...")
    t0 = time.time()
    normals, fallback_used = compute_cell_normals(full_mesh, points, base_radius=pitch * 1.5)
    print(f"  done in {time.time() - t0:.2f}s "
          f"({fallback_used} cells needed the last-resort nearest-face fallback)")

    # --- Write outputs ---
    ROOT.joinpath("data").mkdir(exist_ok=True)

    with open(OUT_BIN, "wb") as f:
        for (i, j, k), (nx, ny, nz) in zip(sparse_indices, normals):
            f.write(struct.pack("<iiifff", int(i), int(j), int(k), float(nx), float(ny), float(nz)))

    header = {
        "version": 1,
        "sourceModel": str(source_path.relative_to(ROOT)) if source_path.is_relative_to(ROOT) else str(source_path),
        "sourceModelNote": (
            "Source GLB is READ ONLY here -- never modified, decimated, or "
            "overwritten. It is a right-hand HALF car; this bake mirrors a "
            f"{'DECIMATED' if args.target_reduction > 0 else 'FULL-RESOLUTION (undecimated)'} "
            "copy about world X=0 (same plane as src/car.js's runtime mirror) "
            "to build the full-car collision volume."
        ),
        "generatedBy": "scripts/bake_occupancy_grid.py",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "toolVersions": {
            "python": platform.python_version(),
            "trimesh": pkg_version("trimesh"),
            "fast_simplification": pkg_version("fast-simplification"),
            "numpy": pkg_version("numpy"),
            "scipy": pkg_version("scipy"),
        },
        "decimation": {
            "method": "fast_simplification.simplify (NOT trimesh.simplify_quadric_decimation, per CLAUDE.md)"
                      if args.target_reduction > 0 else "none -- full resolution (see docstring: "
                      "'Solid voxelisation, decimation reconsidered' -- decimating a convex surface "
                      "shrinks it inside its true envelope, and wasn't buying meaningful bake-time "
                      "savings at this mesh/pitch anyway)",
            "targetReduction": args.target_reduction,
            "agg": args.agg,
            "halfMeshOriginalVerts": orig_verts,
            "halfMeshOriginalFaces": orig_faces,
            "halfMeshDecimatedVerts": int(len(dec_vertices)),
            "halfMeshDecimatedFaces": int(len(dec_faces)),
        },
        "mirror": {
            "plane": "world X = 0",
            "method": "negate vertex.x, reverse face winding [0,2,1] to keep outward normals",
            "note": (
                "Matches src/car.js's runtime mirror plane. Mirroring the whole "
                "half-mesh (rather than re-deriving car.js's per-component "
                "RIGHT_ONLY_COMPONENTS name list in Python) is equivalent: the "
                "small already-symmetric parts documented in PROGRESS.md Phase 1 "
                "mirror onto themselves and contribute no new geometry, so the "
                "result is the same full-car shape."
            ),
        },
        "grid": {
            "pitch": pitch,
            "voxelDivisions": args.voxel_divisions,
            "origin": origin,
            "cellCount": int(len(sparse_indices)),
            "method": (
                "SOLID: trimesh surface voxelisation (method='subdivide') -> "
                f"{args.dilate_iterations}x binary dilation (inflate ~half a voxel, the discrete "
                "form a grid can represent) -> VoxelGrid.fill(method='holes') to flood-fill the "
                "interior. Replaces the previous hollow-shell-only bake -- see docstring 'Solid "
                "voxelisation, decimation reconsidered' for why."
            ),
            "shellCellCount": int(shell_cells),
            "dilatedCellCount": int(dilated_cells),
            "dilateIterations": args.dilate_iterations,
        },
        "normals": {
            "method": "area-weighted average of face normals within an expanding search radius "
                      "(base radius = 1.5x pitch, doubled up to 6x if nothing usable is found), "
                      "falling back to nearest single face as a last resort",
            "fallbackCellCount": int(fallback_used),
        },
        "flowDomain": {
            **flow_domain,
            "note": (
                "Re-derived from the RAW undecimated half-car scene graph using "
                "the same axis/sign heuristic as src/particles/domain.js (longer "
                "horizontal bbox axis = flow axis; compare avg world position of "
                "/front/i vs /rear|back/i named nodes along that axis). Bounds "
                "below are the full mirrored car at FULL mesh resolution (not the "
                "decimated collision copy), for accurate flow-domain sizing."
            ),
            "bboxMin": full_res_bounds_min,
            "bboxMax": full_res_bounds_max,
        },
        "binaryFormat": {
            "file": "occupancy_grid.bin",
            "recordBytes": 24,
            "byteOrder": "little-endian",
            "fields": [
                {"name": "i", "type": "int32", "offset": 0},
                {"name": "j", "type": "int32", "offset": 4},
                {"name": "k", "type": "int32", "offset": 8},
                {"name": "nx", "type": "float32", "offset": 12},
                {"name": "ny", "type": "float32", "offset": 16},
                {"name": "nz", "type": "float32", "offset": 20},
            ],
            "recordCount": int(len(sparse_indices)),
            "worldPositionFormula": "world[axis] = origin[axis] + index[axis] * pitch",
            "normalUnits": "unit vector, points away from the occupied surface (outward)",
        },
    }

    with open(OUT_JSON, "w") as f:
        json.dump(header, f, indent=2)

    print(f"\nWrote {OUT_JSON.relative_to(ROOT)} and {OUT_BIN.relative_to(ROOT)}")
    print(f"Total bake time: {time.time() - t_start:.2f}s")
    print(f"\nSource model untouched (read-only load only): {source_path}")


if __name__ == "__main__":
    main()
