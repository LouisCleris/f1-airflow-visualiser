// Component cards: loads data/components.json, maps every mesh of the car to its entry, and picks a part of the car
// from a click. Both mirrored halves carry the same authored name (car.js) so they resolve to the same entry.

import * as THREE from 'three';

export const COMPONENTS_URL = 'data/components.json';

export async function fetchComponents(url = COMPONENTS_URL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: HTTP ${res.status}`);
  return res.json();
}

/** The entries of one scene (an entry with no `scene` belongs to the F1). */
export function componentsOf(data, sceneId = 'f1') {
  return data.components.filter((c) => (c.scene || 'f1') === sceneId);
}

/** authored mesh name -> component id */
export function buildMeshIndex(data, sceneId = 'f1') {
  const index = new Map();
  for (const c of componentsOf(data, sceneId)) for (const m of c.meshes) index.set(m, c.id);
  return index;
}

/** The authored name of the component an object belongs to (walks up from a child mesh), or null. */
export function authoredNameOf(obj) {
  for (let o = obj; o; o = o.parent) if (o.userData && o.userData.name) return o.userData.name;
  return null;
}

/**
 * @param {object} data parsed components.json
 * @param {THREE.Object3D} carRoot
 * @param {string} [sceneId]
 */
export function createComponentIndex(data, carRoot, sceneId = 'f1') {
  const byId = new Map(componentsOf(data, sceneId).map((c) => [c.id, c]));
  const meshIndex = buildMeshIndex(data, sceneId);
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function idForObject(obj) {
    const name = authoredNameOf(obj);
    return name ? meshIndex.get(name) || null : null;
  }

  /** The component under a pointer position, or null. */
  function pick(clientX, clientY, canvas, camera) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(carRoot, true);
    for (const h of hits) {
      const id = idForObject(h.object);
      if (id) return id;
    }
    return null;
  }

  /** World bounding box of every mesh of a component (both mirrored halves). Empty for entries with no mesh. */
  function boxFor(id) {
    const box = new THREE.Box3();
    const c = byId.get(id);
    if (!c) return box;
    carRoot.updateMatrixWorld(true);
    const names = new Set(c.meshes);
    carRoot.traverse((o) => {
      if (o.userData && names.has(o.userData.name)) box.expandByObject(o);
    });
    return box;
  }

  return { byId, idForObject, pick, boxFor };
}
