// Scene setup: renderer, camera, lights, race track (track.js), free-orbit controls,
// and responsive resize handling. Kept separate from car/wheel loading so
// later phases (particles, Falcon scene) can reuse this without touching
// car-specific code.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSky, createSkyEnvironment, DUSK_SKY } from './sky.js';
import { createTrack } from './track.js';

/**
 * @param {HTMLCanvasElement} canvas
 */
export function createScene(canvas) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161a); // hidden behind the dusk dome; kept as the F1 scene's base colour
  // Fog in the dusk sky's horizon tone, starting well beyond the car, so only the far track and scenery fade into it.
  scene.fog = new THREE.Fog(DUSK_SKY.horizon, 30, 170);

  const camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / Math.max(window.innerHeight, 1),
    0.05,
    500
  );
  camera.position.set(6, 3.2, 8);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const f1Lights = addLights(scene);
  const road = createTrack();
  scene.add(road);
  const duskSky = createSky(DUSK_SKY);
  duskSky.name = 'Dusk Sky';
  scene.add(duskSky);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 2;
  controls.maxDistance = 60;
  controls.maxPolarAngle = Math.PI * 0.495; // stay just above the road plane
  controls.target.set(0, 0.4, 0);
  // Explicit touch mapping (rather than relying on defaults), for touchscreen
  // computers: one finger orbits, two fingers dolly + pan.
  controls.touches = {
    ONE: THREE.TOUCH.ROTATE,
    TWO: THREE.TOUCH.DOLLY_PAN,
  };
  controls.update();

  // The two scenes' surroundings. The F1 values are exactly what this function set up before there was a second scene.
  const f1Env = { background: scene.background, fog: scene.fog, environment: null, maxPolarAngle: controls.maxPolarAngle };
  let sky = null, falconLights = null, skyEnvironment = null;
  const deckDrift = [0, 0]; // kept here so a sky created later starts where the deck has got to
  function setEnvironment(id) {
    const falcon = id === 'falcon';
    if (falcon && !sky) {
      sky = createSky();
      sky.userData.setDeckDrift(deckDrift[0], deckDrift[1]);
      scene.add(sky);
      falconLights = addFalconLights(scene);
      skyEnvironment = createSkyEnvironment(renderer);
    }
    road.visible = !falcon;
    duskSky.visible = !falcon;
    f1Lights.visible = !falcon;
    if (sky) { sky.visible = falcon; falconLights.visible = falcon; }
    scene.background = falcon ? new THREE.Color(0x1b3561) : f1Env.background;
    scene.fog = falcon ? null : f1Env.fog;
    scene.environment = falcon ? skyEnvironment : f1Env.environment;
    controls.maxPolarAngle = falcon ? Math.PI : f1Env.maxPolarAngle; // open sky: orbit freely, including from below
  }
  /** Keeps the sky domes centred on the camera, so they never get nearer or farther. */
  function followCamera() {
    if (sky && sky.visible) sky.position.copy(camera.position);
    if (duskSky.visible) duskSky.position.copy(camera.position);
  }

  function resize() {
    const w = window.innerWidth;
    const h = Math.max(window.innerHeight, 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  /** The Falcon's cloud deck, moved (x, z) world units from where it started. */
  function setDeckDrift(x, z) {
    deckDrift[0] = x; deckDrift[1] = z;
    if (sky) sky.userData.setDeckDrift(x, z);
  }

  return { scene, camera, renderer, controls, road, resize, setEnvironment, followCamera, setDeckDrift };
}

function addLights(scene) {
  const group = new THREE.Group();
  group.name = 'F1 lights';
  scene.add(group);
  const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x2b2b2b, 1.1);
  group.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(8, 12, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -12;
  sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 12;
  sun.shadow.camera.bottom = -12;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 40;
  sun.shadow.bias = -0.0005;
  group.add(sun);

  const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
  fill.position.set(-6, 4, -8);
  group.add(fill);
  return group;
}


function addFalconLights(scene) {
  const group = new THREE.Group();
  group.name = 'Falcon lights';
  scene.add(group);
  // Lighting is independent of how dark the sky dome looks: a bright sun and an even hemisphere fill keep the white
  // aircraft crisp and solid against the navy sky (the dome itself only supplies reflections).
  group.add(new THREE.HemisphereLight(0xdfe8f5, 0x8a97ab, 1.15)); // open sky above, cloud deck below

  const sun = new THREE.DirectionalLight(0xfff6ea, 2.2);
  sun.position.set(6, 10, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -4.5;
  sun.shadow.camera.right = 4.5;
  sun.shadow.camera.top = 4.5;
  sun.shadow.camera.bottom = -4.5;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 30;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.01;
  group.add(sun);

  const fill = new THREE.DirectionalLight(0xbcd0ec, 0.5);
  fill.position.set(-6, 2, -7);
  group.add(fill);
  return group;
}
