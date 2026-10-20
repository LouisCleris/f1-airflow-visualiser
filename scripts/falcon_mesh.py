#!/usr/bin/env python3
"""The Falcon 6X mesh exactly as the browser displays it: full resolution, every node's own world transform applied,
then the scene placement (src/sceneConfig.js: uniform scale, nose-up pitch about a pivot). The GLB holds the complete
aircraft (mirror already applied in Blender), so unlike the F1 there is no runtime mirror to reproduce.

world = scale * Rx(-pitch) * (model - pivot)       (nose is +Z, up is +Y; a negative turn about +X lifts the nose)

Used by scripts/bake_falcon_sdf.py (the distance field) and scripts/mesh_accuracy_check.py (assertion 4). Read-only on
the GLB.
"""
import re
from pathlib import Path

import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parent.parent
FALCON_GLB = ROOT / "models" / "Falcon 6X.glb"
DEDUP_SUFFIX_RE = re.compile(r"_[0-9a-f]{6}$")


def placement(scale, pitch_deg, pivot):
    """4x4 matrix taking model coordinates to world coordinates."""
    a = -np.radians(pitch_deg)
    rx = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])
    m = np.eye(4)
    m[:3, :3] = scale * rx
    m[:3, 3] = -scale * rx @ np.asarray(pivot, dtype=float)
    return m


def build_falcon_mesh(scale, pitch_deg, pivot, glb_path=FALCON_GLB):
    """Returns (combined trimesh.Trimesh, per-face component-name array, per-component bounds dict)."""
    scene = trimesh.load(glb_path)
    place = placement(scale, pitch_deg, pivot)
    verts, faces, names = [], [], []
    offset = 0
    for node_name in scene.graph.nodes_geometry:
        transform, geom_name = scene.graph[node_name]
        geom = scene.geometry[geom_name]
        full = place @ transform
        v = (full[:3, :3] @ geom.vertices.T).T + full[:3, 3]
        f = geom.faces
        if np.linalg.det(full[:3, :3]) < 0:
            f = f[:, [0, 2, 1]]
        verts.append(v)
        faces.append(f + offset)
        names.extend([DEDUP_SUFFIX_RE.sub("", node_name)] * len(f))
        offset += len(v)
    mesh = trimesh.Trimesh(vertices=np.vstack(verts), faces=np.vstack(faces), process=False)
    return mesh, np.array(names)
