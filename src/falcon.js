// Loads the Falcon 6X GLB at full detail and places it in the scene. Unlike the F1 file (a right-hand half, mirrored at
// run time in car.js), this file is the complete aircraft with the mirror and smoothing already applied in Blender, so
// nothing is mirrored here and no geometry is touched: the only thing done to it is one transform on the root (a uniform
// scale and the fixed cruise pitch, both from src/sceneConfig.js), exactly the transform the distance field was baked
// with (scripts/falcon_mesh.py).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SCENE_CONFIGS, falconPlacementTransform } from './sceneConfig.js';

export const FALCON_MODEL_PATH = SCENE_CONFIGS.falcon.modelPath;

/**
 * @param {{ onProgress?: (evt: ProgressEvent) => void }} [opts]
 * @returns {Promise<{ root: THREE.Group, components: Map<string, THREE.Object3D[]>, gltf: unknown }>}
 */
export async function loadFalcon(opts = {}) {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(encodeURI(FALCON_MODEL_PATH), opts.onProgress);

  const inner = gltf.scene; // untouched
  inner.name = 'Falcon 6X (model)';
  inner.traverse((obj) => {
    if (obj.isMesh) { obj.castShadow = true; obj.receiveShadow = true; }
  });

  // Placement: world = scale * Rx(-pitch) * (model - pivot)
  const t = falconPlacementTransform();
  const root = new THREE.Group();
  root.name = 'Falcon 6X';
  root.add(inner);
  root.scale.setScalar(t.scale);
  root.rotation.x = t.rotationX;
  root.position.set(...t.position);
  root.updateMatrixWorld(true);

  // One lookup entry per authored component (a node with several primitives becomes a Group of Meshes, so the
  // registered object is the node that carries the authored name).
  const components = new Map();
  inner.traverse((obj) => {
    const name = obj.userData && obj.userData.name;
    if (!name) return;
    if (!components.has(name)) components.set(name, []);
    components.get(name).push(obj);
  });

  return { root, components, gltf };
}
