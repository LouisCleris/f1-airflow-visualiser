// Interface configuration: everything the interface decides from data rather than code, so Phases 5 and 6 can
// switch their controls on by flipping `enabled`, with no rewrite.

// Scene and driving-state switchers. A group with fewer than two enabled entries is not drawn at all.
export const SCENES = [
  { id: 'f1', label: 'F1', title: 'F1 AIRFLOW', enabled: true }, // `title`: the top-left label while this scene is shown
  { id: 'falcon', label: 'Falcon 6X', title: 'FALCON 6X AIRFLOW', enabled: true },
];
export const DRIVING_STATES = [
  { id: 'straight', label: 'Straight line', enabled: true },
  { id: 'cornering', label: 'Cornering', enabled: true }, // Phase 5: F1 only (hidden in a scene without setDriving)
];

// Camera presets: `position` and `target` in world units (the car is centred on x = 0, nose toward +z).
export const CAMERA_PRESETS = [
  { id: 'three-quarter', label: 'Three-quarter', position: [4.4, 2.3, 5.8], target: [0, 0.45, 0] },
  { id: 'front', label: 'Front', position: [0, 1.0, 7], target: [0, 0.5, 0] },
  { id: 'side', label: 'Side', position: [7.5, 1.0, 0], target: [0, 0.5, 0] },
  { id: 'top', label: 'Top', position: [0, 11, 0.01], target: [0, 0.3, 0] },
];
export const DEFAULT_PRESET = 'three-quarter';

// The part buttons, in order. `component` is an id in data/components.json. `view` is only needed where the part has
// no mesh of its own to frame (Sidepods, Wake): a camera position and target in world units.
export const PART_BUTTONS = [
  { id: 'full', label: 'Full car' },
  { id: 'front-wing', label: 'Front wing', component: 'front-wing' },
  { id: 'front-wheels', label: 'Front wheels', component: 'front-wheels' },
  { id: 'sidepods', label: 'Sidepods', component: 'sidepods', view: { position: [3.6, 1.7, 1.2], target: [0.6, 0.5, 0.1] } },
  { id: 'floor', label: 'Floor', component: 'floor' },
  { id: 'rear-wing', label: 'Rear wing', component: 'rear-wing' },
  { id: 'wake', label: 'Wake', component: 'wake', view: { position: [4.2, 1.9, -8.8], target: [0, 0.5, -3.8] } },
];

// Framing for components reached from a button but with no mesh: same shape as PART_BUTTONS' `view`.
export const VIRTUAL_VIEWS = {
  diffuser: { position: [2.6, 0.9, -5.2], target: [0, 0.15, -2.2] },
};

export const CAMERA_CONFIG = {
  flyDurationMs: 900,
  frameDistanceFactor: 2.7, // camera distance = bounding-sphere radius x this, for a part with meshes
  minFrameDistance: 1.7,
  frameDirection: [0.62, 0.42, 0.66], // from which side/height a part is framed (nose-side three-quarter)
  rearFrameDirection: [0.62, 0.42, -0.66], // for parts behind the car's middle
  keepOutMargin: 0.35, // the camera never gets closer than this to the car's bounding box
  minDistance: 2.5,
  maxDistance: 40,
};

// Slider defaults (0-100) and how they map to the flow.
export const SLIDER_DEFAULTS = { density: 60, trail: 40, speed: 70 };
export const SLIDER_MAPPING = {
  fullDensityAt: 60, // at or above this every traced line is shown; the wake particle count keeps growing
  minLineFraction: 0.15,
  wakeCountExponent: 1.5,
  pulseWidth: [0.08, 0.7], // trail length -> fraction of a pulse period lit
  speedAtDefault: 1, // speed slider default maps to normal speed
};

// Everything the interface needs per scene. The F1 entry is the lists above, unchanged. The Falcon is shown at the
// F1's size (src/sceneConfig.js), nose toward +z, the air travelling toward -z, centred on the origin.
export const FALCON_CAMERA_PRESETS = [
  { id: 'three-quarter', label: 'Three-quarter', position: [3.75, 1.45, 3.65], target: [0, -0.15, -0.3] },
  // a long lens from far ahead: lines running along the line of sight look short, so they do not fan out at the viewer
  { id: 'front', label: 'Front', position: [0, -0.12, 19], target: [0, -0.36, 0], fov: 15 },
  { id: 'side', label: 'Side', position: [6.1, 0.15, 0.45], target: [0, -0.15, 0.45] },
  { id: 'top', label: 'Top', position: [0, 8.1, -0.29], target: [0, -0.15, -0.3] },
];
// Wings: the left wing from above and ahead. Engines and Tail: from behind, above the fin. Wake: well behind the tail.
export const FALCON_PART_BUTTONS = [
  { id: 'full', label: 'Full aircraft' },
  { id: 'wings', label: 'Wings', component: 'falcon-wings', view: { position: [4.4, 1.9, 1.6], target: [1.1, -0.45, -0.7] } },
  { id: 'engines', label: 'Engines', component: 'falcon-engines', view: { position: [2.3, 0.95, -4.2], target: [0.2, -0.3, -1.5] } },
  { id: 'tail', label: 'Tail', component: 'falcon-tail', view: { position: [3.0, 1.3, -5.0], target: [0, 0.0, -2.1] } },
  { id: 'wake', label: 'Wake', component: 'falcon-wake', view: { position: [4.2, 1.6, -8.4], target: [0, -0.2, -4.4] } },
];
export const FALCON_CAMERA_CONFIG = {
  ...CAMERA_CONFIG,
  frameDistanceFactor: 2.4,
  minFrameDistance: 2.6,
  minDistance: 1.2, // a wingtip close-up is a normal thing to look at
  maxDistance: 40,
  keepOutMargin: 0.2,
  rearFrameDirection: [0.62, 0.3, -0.66],
};

export const SCENE_UI = {
  f1: { presets: CAMERA_PRESETS, defaultPreset: DEFAULT_PRESET, parts: PART_BUTTONS, virtualViews: VIRTUAL_VIEWS, camera: CAMERA_CONFIG },
  falcon: { presets: FALCON_CAMERA_PRESETS, defaultPreset: DEFAULT_PRESET, parts: FALCON_PART_BUTTONS, virtualViews: {}, camera: FALCON_CAMERA_CONFIG },
};
