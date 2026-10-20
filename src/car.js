// Loads the F1 car GLB at full detail (no decimation of the display mesh,
// per CLAUDE.md) and builds a name -> Object3D[] lookup for later phases
// (Phase 7 click-to-describe). Never writes to the source file; only reads
// it through GLTFLoader/fetch.
//
// IMPORTANT MODELLING FACT discovered while building this phase (see
// PROGRESS.md Phase 1 entry for the full derivation): the source file
// `models/F1 model.glb` is authored as a RIGHT-HAND HALF of the car only
// (every bodywork/wing/wheel/suspension node's local geometry sits at
// world X >= ~0, i.e. only one side of the centreline is modelled -- almost
// certainly an un-applied mirror modifier from the original 3D package).
// Loading the GLB as-is therefore renders half a car with a missing left
// side, which would fail BUILD.md's Phase 1 check ("no holes or missing
// surfaces anywhere on the bodywork").
//
// CLAUDE.md forbids ever modifying/re-exporting the source GLB, so the
// fix is entirely at runtime: for every component that is only modelled on
// one side, we add a second Object3D that SHARES the exact same
// BufferGeometry and Material (no vertices are cloned, edited, or
// decimated) and whose position/quaternion/scale are set to the exact
// mirror image about the car's centreline plane (world X = 0):
//   mirror.position  = (-x, y, z)
//   mirror.quaternion = (qx, -qy, -qz, qw)   -- reflects the rotation too
//   mirror.scale     = (-sx, sy, sz)
// Three.js's renderer automatically compensates triangle winding and
// lighting normals for the resulting negative-determinant transform, so
// this produces a correctly lit, correctly facing mirrored half with zero
// extra geometry data and zero risk to the source asset.

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const F1_MODEL_PATH = 'models/F1 model.glb';

// Components confirmed (by bounding-box inspection of the untouched GLB)
// to be modelled on only the right-hand half of the car. Reconstructed at
// runtime as a mirrored duplicate -- see file header. Trailing spaces in a
// few names are exactly as authored in the GLB; kept verbatim so lookups
// by mesh.name keep working in later phases.
const RIGHT_ONLY_COMPONENTS = new Set([
  'Rear Wing main part',
  'Rear Wing side plate',
  'Rear wing DRS ',
  'Rear Wing Holder',
  'Rear wing DRS .001',
  'DRS Holder',
  'DRS Mechanism',
  'Front wing side plates ',
  'Front Wing Bottom',
  'Front Wing middle',
  'Front wing Top',
  'Front wing Connecting pieces ',
  'Front Wing Mount',
  'Main body',
  'Floor',
  'Rear LED',
  'Top Intake Details',
  'Mirrors',
  'Inside Seat',
  'Glass',
  'Front Flap Details',
  'Front Wheelover',
  'Front Tire',
  'Front Inside Cover',
  'Rear Wheelover',
  'Rear Tire',
  'Rear Inside Cover',
  'Front Arms ',
  'Front Rods',
  'Back Arms',
  'Rear Rods',
]);

// Wheel-corner parts that physically rotate with the wheel/hub (tire, rim
// cover, inner brake-duct cover). Suspension links (arms/rods) are
// geometrically mirrored like any other right-only part above, but are
// deliberately NOT in this set: on the real car they don't complete full
// rotations, only pivot slightly with suspension travel, which is out of
// scope for this phase. See wheels.js.
export const WHEEL_SPIN_COMPONENTS = new Set([
  'Front Wheelover',
  'Front Tire',
  'Front Inside Cover',
  'Rear Wheelover',
  'Rear Tire',
  'Rear Inside Cover',
]);

/**
 * Build a mirror image of `node` about the world X = 0 plane. Shares the
 * source geometry/material references (Object3D.clone/Mesh.copy default
 * behaviour, recursive so multi-primitive components -- which GLTFLoader
 * represents as a Group of child Meshes, see below -- bring their children
 * along) -- no vertex data is duplicated, cloned, or edited.
 */
function mirrorAcrossCentreline(node) {
  const mirror = node.clone(true);
  mirror.position.set(-node.position.x, node.position.y, node.position.z);
  mirror.quaternion.set(node.quaternion.x, -node.quaternion.y, -node.quaternion.z, node.quaternion.w);
  mirror.scale.set(-node.scale.x, node.scale.y, node.scale.z);
  // Same name as the original: Phase 7's per-component description lookup
  // should describe both halves identically (they're the same physical
  // part, mirrored), not treat them as different components.
  mirror.name = node.name;
  mirror.userData = { ...node.userData, mirroredFrom: node.uuid, isMirrored: true };
  return mirror;
}

// GLTFLoader sanitizes Object3D.name for animation-path safety (e.g.
// "Front Tire" -> "Front_Tire"), so exact matching against the names above
// must use the UNSANITIZED original, which GLTFLoader separately preserves
// verbatim as node.userData.name for every named node (see GLTFLoader.js,
// GLTFParser#_loadNodeShallow: `node.userData.name = nodeDef.name`).
//
// A second GLTFLoader quirk that matters here: a glTF node whose mesh has
// more than one primitive (several of ours do -- e.g. "Front Wheelover" is
// tyre-cover + hub as two primitives) is NOT built as a single THREE.Mesh.
// It becomes a Group carrying the node's name/transform, wrapping one
// child Mesh per primitive (those children get auto-generated names off
// the raw glTF mesh data, e.g. "Circle003", and are NOT meaningful
// component identifiers on their own). So "one authored component" is not
// reliably "one THREE.Mesh" -- it is "one Object3D (Mesh or Group) whose
// userData.name is set", and that is the granularity components/wheels/
// mirroring below operate at. This preserves exactly one lookup entry per
// authored component for Phase 7, whether it is single- or multi-primitive.
const NON_COMPONENT_WRAPPER_NAMES = new Set([
  // Organisational empty (no mesh of its own) that groups the steering
  // wheel's sub-parts; those sub-parts (Buttons, Screen, etc.) are the
  // real components and are registered individually.
  'Steering Wheel Empty',
]);

/**
 * Load the F1 car GLB and return the populated root group plus lookup
 * tables used by later phases.
 *
 * @param {{ onProgress?: (evt: ProgressEvent) => void }} [opts]
 * @returns {Promise<{
 *   root: import('three').Group,
 *   components: Map<string, import('three').Object3D[]>,
 *   wheels: Array<{ mesh: import('three').Object3D, mirrored: boolean }>,
 *   gltf: unknown,
 * }>}
 */
export async function loadF1Car(opts = {}) {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(encodeURI(F1_MODEL_PATH), opts.onProgress);

  const root = gltf.scene;
  root.name = 'F1 Car';

  // Shadows: blanket pass over every actual Mesh, independent of the
  // component-registration granularity below.
  root.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  const components = new Map();
  const wheels = [];

  function registerComponent(obj) {
    // Use the exact, unsanitized authored name (see NON_COMPONENT_WRAPPER_
    // NAMES comment above) so this matches RIGHT_ONLY_COMPONENTS,
    // WHEEL_SPIN_COMPONENTS, and tests/fixtures/expected-components.json.
    const name = obj.userData && obj.userData.name;
    if (!components.has(name)) components.set(name, []);
    components.get(name).push(obj);
    if (WHEEL_SPIN_COMPONENTS.has(name)) {
      wheels.push({ mesh: obj, mirrored: !!obj.userData.isMirrored });
    }
  }

  const originalComponentNodes = [];
  root.traverse((obj) => {
    const originalName = obj.userData && obj.userData.name;
    if (!originalName || NON_COMPONENT_WRAPPER_NAMES.has(originalName)) return;
    originalComponentNodes.push(obj);
    registerComponent(obj);
  });

  const mirrors = [];
  for (const node of originalComponentNodes) {
    if (RIGHT_ONLY_COMPONENTS.has(node.userData.name)) {
      mirrors.push(mirrorAcrossCentreline(node));
    }
  }
  for (const mirror of mirrors) {
    root.add(mirror);
    registerComponent(mirror);
  }

  return { root, components, wheels, gltf };
}
