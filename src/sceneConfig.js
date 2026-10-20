// Per-scene configuration. Everything that differs between the F1 scene and the Falcon 6X scene and is not a flow
// authoring choice lives here as data (placement, ground, flow direction, data files), so a scene is a config value,
// not a branch in the code. The F1 values reproduce what the code did before there was a second scene.
//
// Pure data, no three.js: Node (bakes, checks) and the browser import the same file.

export const FALCON_PLACEMENT = {
  // The GLB is the complete aircraft in metres (nose toward +Z, up +Y, 25 m long, 21.7 m span). It is shown at a
  // uniform scale so it is about the size of the F1 (5.5 world units long): every length in the shared flow code
  // (standoffs, step sizes, smoothing, the speed of the air) is in those units and then means the same thing for both.
  modelScale: 0.22,
  // Fixed cruise attitude, degrees nose up. A config value: change it and re-run `npm run bake:falcon`.
  pitchDeg: 2.5,
  // Model-space point the aircraft is pitched about and centred on (the middle of its bounding box).
  pivot: [0, 3.4673, 0.5065],
};

export const SCENE_CONFIGS = {
  f1: {
    id: 'f1',
    dataDir: 'data/',
    modelPath: 'models/F1 model.glb',
    groundY: 0, // the road
    flowAxis: null, // null = derived from the loaded model (domain.js)
    flowSign: null,
  },
  falcon: {
    id: 'falcon',
    dataDir: 'data/falcon/',
    modelPath: 'models/Falcon 6X.glb',
    groundY: null, // open sky: no ground in the distance field
    flowAxis: 'z', // nose toward +Z, so the air travels toward -Z
    flowSign: -1,
    placement: FALCON_PLACEMENT,
  },
};

/** Model -> world placement of the Falcon as a plain object: position, rotation about X (radians), uniform scale. */
export function falconPlacementTransform(p = FALCON_PLACEMENT) {
  const a = (-p.pitchDeg * Math.PI) / 180; // a negative turn about +X lifts the nose (+Z) toward +Y
  const c = Math.cos(a), s = Math.sin(a);
  // position = -scale * R * pivot
  const [px, py, pz] = p.pivot;
  const rx = [px, c * py - s * pz, s * py + c * pz];
  return { scale: p.modelScale, rotationX: a, position: [-p.modelScale * rx[0], -p.modelScale * rx[1], -p.modelScale * rx[2]] };
}

/** Model-space point -> world point for the Falcon placement. */
export function falconToWorld(point, p = FALCON_PLACEMENT) {
  const t = falconPlacementTransform(p);
  const c = Math.cos(t.rotationX), s = Math.sin(t.rotationX);
  const [x, y, z] = point;
  return [t.scale * x + t.position[0], t.scale * (c * y - s * z) + t.position[1], t.scale * (s * y + c * z) + t.position[2]];
}
