// Entry point. Bundled by scripts/build.js into dist/index.html, and loaded
// directly as an ES module by scripts/dev-server.js during development.
//
// Phase 1: load the F1 car, render it on a road surface, free-orbit camera,
// rotating wheels.
// Phase 2: uniform-flow particle trails, spawned once the car (and its
// bounding box, which sizes the flow domain -- see src/particles/domain.js)
// has loaded.
// Phase 3: the occupancy grid baked offline by scripts/bake_occupancy_grid.py
// is fetched in parallel with the car GLB, then passed into both flow
// fields below so they deflect around the bodywork instead of passing
// straight through it. If the grid fails to load for any reason, the app
// still runs with Phase-2-style uniform flow rather than failing to start.
// Phase 3 addendum (visual review): the flow is now drawn as TWO separate
// fields rather than one uniform particle system --
//   - streamlineField.js: traced streamlines for the clean/attached flow
//     ahead of, around, and alongside the car (a bend needs its whole
//     curve drawn to be visible in a still frame; a short particle trail
//     can't show that).
//   - particles/index.js: the original short-trail particles, now
//     restricted to the wake directly behind the car, where the flow is
//     genuinely unsteady and a steady traced line would misrepresent it.
// See PROGRESS.md's Phase 3 addendum for the full reasoning.

import * as THREE from 'three';
import { createScene } from './scene.js';
import { loadF1Car } from './car.js';
import { loadFalcon } from './falcon.js';
import { createWheelSpinner, createFrontSteer } from './wheels.js';
import { createParticleField } from './particles/index.js';
import { createStreamlineField, fetchRakesConfig } from './particles/streamlineField.js';
import { fetchOccupancyGrid } from './particles/collisionGrid.js';
import { fetchSdf } from './particles/sdf.js';
import { fetchBakedStreamlines } from './particles/bakedStreamlines.js';
import { domainFromBounds, computeFlowDomain } from './particles/domain.js';
import { corneringRakes, wakeLeanDeg, cornerCentre, CORNERING_CONFIG } from './particles/cornering.js';
import { PARTICLE_CONFIG, FALCON_PARTICLE_OVERRIDES } from './particles/config.js';
import { createCameraRig } from './cameraRig.js';
import { fetchComponents, createComponentIndex } from './components.js';
import { createUi } from './ui.js';
import { SCENE_UI } from './uiConfig.js';
import { SCENE_CONFIGS } from './sceneConfig.js';

// Temporary debug toggle (the author, 2026-09-12): wake particles switched off so
// deflection can be judged from the streamlines alone, with nothing else on
// screen. Flip back to true to restore the wake. Not a permanent feature --
// remove this flag once streamline deflection has been reviewed.
const WAKE_PARTICLES_ENABLED = true;

// Phase 6: two scenes. A "world" is everything one scene needs -- its model, flow, component index, camera rig and the
// settings the interface drives -- built once, kept, and shown or hidden. The F1 is built first; the Falcon 6X is built
// the first time it is asked for (its model is 16 MB).
function init() {
  const canvas = document.getElementById('viewport');
  const statusEl = document.getElementById('status');
  if (!canvas) return;

  const { scene, camera, renderer, controls, road, resize, setEnvironment, followCamera, setDeckDrift } = createScene(canvas);
  const componentsPromise = fetchComponents();

  let simSpeed = 1;
  let playing = true;
  let current = null;
  const worlds = {};

  const flowApi = (streamlines, particles) => ({
    setStreamlinesVisible: (v) => { if (streamlines) streamlines.object3D.visible = v; },
    setLineGroups: (g) => { if (streamlines) streamlines.setVisibleGroups(g); },
    setLineFraction: (f) => { if (streamlines) streamlines.setDensity(f); },
    setPulseWidth: (w) => { if (streamlines) streamlines.setPulseWidth(w); },
    setWakeVisible: (v) => { if (particles) particles.object3D.visible = v; },
    setWakeCount: (n) => { if (particles) particles.setDensity(n); },
    setSpeed: (k) => { simSpeed = k; },
    setPlaying: (p) => { playing = p; },
    resetTime: () => { if (streamlines) streamlines.resetTime(); },
  });

  // ---- F1
  async function createF1World() {
    const cfg = SCENE_CONFIGS.f1;
    const carPromise = loadF1Car({ onProgress: () => {} });

    // Fetched in parallel with the (much larger) car GLB. Failure here must
    // never block the app from starting -- it just means particles pass
    // straight through the car (Phase 2 behaviour) instead of deflecting.
    const gridPromise = fetchOccupancyGrid().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(
        '[airflow-visualiser] occupancy grid unavailable, particles will not ' +
        'deflect around the car:', err
      );
      return null;
    });

    // The signed distance field the streamlines are traced against
    // (data/sdf.bin, baked from the real mesh). Without it streamlines have
    // nothing to hug, so a failed fetch just skips them like a missing rakes
    // config does.
    const sdfPromise = fetchSdf(undefined, cfg.groundY).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[airflow-visualiser] signed distance field unavailable, skipping streamlines:', err);
      return null;
    });

    const rakesPromise = fetchRakesConfig().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[airflow-visualiser] rakes config unavailable, skipping streamlines:', err);
      return null;
    });

    // Lines traced at build time; if they are missing the page falls back to tracing them itself (slow). Phase 5: a
    // second set for Cornering, traced the same way with the yawed flow (src/particles/cornering.js).
    const bakedPromise = fetchBakedStreamlines().catch(() => null);
    const bakedCornerPromise = fetchBakedStreamlines(undefined, 'streamlines_corner').catch(() => null);

    const [{ root, components, wheels }, grid, rakesConfig, sdf, componentsData, bakedPaths, bakedCornerPaths] =
      await Promise.all([carPromise, gridPromise, rakesPromise, sdfPromise, componentsPromise, bakedPromise, bakedCornerPromise]);

    const holder = new THREE.Group();
    holder.name = 'F1 scene';
    holder.add(root);
    scene.add(holder);
    const updateWheelSpin = createWheelSpinner(wheels, THREE, PARTICLE_CONFIG.flowSpeed);
    const setSteer = createFrontSteer(wheels, THREE);

    // Two driving states, each with its own lines and wake particles, all built up front so switching is instant.
    let particles = null, cornerParticles = null;
    if (WAKE_PARTICLES_ENABLED) {
      particles = createParticleField(root, { grid, sdf });
      cornerParticles = createParticleField(root, { grid, sdf, yawDeg: wakeLeanDeg() });
      cornerParticles.object3D.visible = false;
      holder.add(particles.object3D, cornerParticles.object3D);
    }

    const streamlines = rakesConfig && sdf ? createStreamlineField(root, sdf, rakesConfig, {}, {}, bakedPaths) : null;
    if (streamlines) holder.add(streamlines.object3D);
    const flowDomain = computeFlowDomain(root, PARTICLE_CONFIG);
    const cornerRakes = rakesConfig ? corneringRakes(rakesConfig, flowDomain) : null;
    // Where the track's ring turns about in Cornering: the corner's centre as the flow sees it, moving with the
    // oncoming air at the car (the yawed freestream there).
    const yawRad = (CORNERING_CONFIG.yawDeg * Math.PI) / 180;
    const cornerLayout = {
      centre: cornerCentre(flowDomain),
      car: [flowDomain.originX, flowDomain.originY, flowDomain.originZ],
      flowDir: ['X', 'Y', 'Z'].map((k) => flowDomain[`dir${k}`] * Math.cos(yawRad) - flowDomain[`right${k}`] * Math.sin(yawRad)),
    };
    // in the corner the road under each tyre moves in proportion to its distance from the centre
    const carRadius = Math.hypot(cornerLayout.car[0] - cornerLayout.centre[0], cornerLayout.car[2] - cornerLayout.centre[2]);
    const cornerSpeedFactor = (x, z) => Math.hypot(x - cornerLayout.centre[0], z - cornerLayout.centre[2]) / carRadius;
    const cornerStreamlines = cornerRakes && sdf ? createStreamlineField(root, sdf, cornerRakes, {}, {}, bakedCornerPaths) : null;
    if (cornerStreamlines) { cornerStreamlines.object3D.visible = false; holder.add(cornerStreamlines.object3D); }
    const flows = {
      straight: { streamlines, particles },
      cornering: { streamlines: cornerStreamlines, particles: cornerParticles },
    };
    let driving = 'straight';

    // Interface: camera moves, component cards, controls.
    root.updateMatrixWorld(true);
    const carBox = new THREE.Box3().setFromObject(root);
    const rig = createCameraRig(camera, controls, carBox);
    const componentIndex = createComponentIndex(componentsData, root, 'f1');

    // eslint-disable-next-line no-console
    console.log(
      `[airflow-visualiser] F1 car loaded: ${components.size} unique ` +
      `component names, ${wheels.length} wheel meshes (incl. reconstructed ` +
      `mirrored left side), ${streamlines ? streamlines.streamlineCount : 0} traced streamlines ` +
      `(${streamlines ? streamlines.triangleCount : 0} triangles), ` +
      `${particles ? `${particles.count}/${particles.maxCount} wake particles` : 'wake particles OFF'}, ` +
      `occupancy grid ${grid ? `loaded (${grid.cellCount} cells)` : 'NOT loaded'}.`
    );

    // Every flow setting goes to both states' lines and particles, so switching keeps them; only the active state's
    // are shown.
    const view = { lines: true, wake: true };
    const both = (fn) => { for (const f of Object.values(flows)) fn(f); };
    const showActive = () => {
      for (const [mode, f] of Object.entries(flows)) {
        if (f.streamlines) f.streamlines.object3D.visible = view.lines && mode === driving;
        if (f.particles) f.particles.object3D.visible = view.wake && mode === driving;
      }
    };
    const flow = {
      setStreamlinesVisible: (v) => { view.lines = v; showActive(); },
      setLineGroups: (g) => both((f) => f.streamlines && f.streamlines.setVisibleGroups(g)),
      setLineFraction: (x) => both((f) => f.streamlines && f.streamlines.setDensity(x)),
      setPulseWidth: (w) => both((f) => f.streamlines && f.streamlines.setPulseWidth(w)),
      setWakeVisible: (v) => { view.wake = v; showActive(); },
      setWakeCount: (n) => both((f) => f.particles && f.particles.setDensity(n)),
      setSpeed: (k) => { simSpeed = k; },
      setPlaying: (p) => { playing = p; },
      resetTime: () => { both((f) => f.streamlines && f.streamlines.resetTime()); road.userData.resetMotion(); },
    };

    return {
      id: 'f1', holder, root, components, wheels, grid, sdf, rig, componentIndex,
      get particles() { return flows[driving].particles; },
      get streamlines() { return flows[driving].streamlines; },
      get driving() { return driving; },
      /** Phase 5: 'straight' (the default) or 'cornering' -- lines, wake, steer and track layout change together. */
      setDriving(mode) {
        driving = mode === 'cornering' ? 'cornering' : 'straight';
        showActive();
        setSteer(driving === 'cornering' ? CORNERING_CONFIG.steerDeg : 0);
        road.userData.setLayout(driving, cornerLayout);
      },
      ui: SCENE_UI.f1,
      flow,
      limits: { wakeDefaultCount: PARTICLE_CONFIG.count, wakeMaxCount: particles ? particles.maxCount : 0 },
      update(simDt) {
        // the speed slider scales simDt: wheels, track and flow together, in both states. The track moves past at the
        // speed of the oncoming air and the wheels roll on it without slipping.
        updateWheelSpin(simDt, driving === 'cornering' ? cornerSpeedFactor : null);
        road.userData.advance(PARTICLE_CONFIG.flowSpeed * simDt);
        const { particles: p, streamlines: s } = flows[driving];
        if (p) p.update(simDt);
        if (s) s.update(simDt);
      },
    };
  }

  // ---- Falcon 6X
  async function createFalconWorld() {
    const cfg = SCENE_CONFIGS.falcon;
    const getJson = async (f) => { const r = await fetch(cfg.dataDir + f); if (!r.ok) throw new Error(`failed to fetch ${cfg.dataDir}${f}: HTTP ${r.status}`); return r.json(); };
    const [{ root, components }, sdf, rakesConfig, domainJson, bakedPaths, componentsData] = await Promise.all([
      loadFalcon({ onProgress: () => {} }),
      fetchSdf(cfg.dataDir, cfg.groundY, { floor: false }).catch((err) => { console.warn('[airflow-visualiser] Falcon distance field unavailable, skipping streamlines:', err); return null; }), // eslint-disable-line no-console
      getJson('rakes.json').catch((err) => { console.warn('[airflow-visualiser] Falcon rakes config unavailable, skipping streamlines:', err); return null; }), // eslint-disable-line no-console
      getJson('domain.json'),
      fetchBakedStreamlines(cfg.dataDir).catch(() => null),
      componentsPromise,
    ]);

    const holder = new THREE.Group();
    holder.name = 'Falcon 6X scene';
    holder.add(root);
    scene.add(holder);

    // The flow domain is the one the distance field and the streamlines were baked with (data/falcon/domain.json).
    const particleConfig = { ...PARTICLE_CONFIG, ...FALCON_PARTICLE_OVERRIDES };
    const domain = domainFromBounds(
      { minX: domainJson.bboxMin[0], maxX: domainJson.bboxMax[0], minY: domainJson.bboxMin[1], maxY: domainJson.bboxMax[1], minZ: domainJson.bboxMin[2], maxZ: domainJson.bboxMax[2] },
      domainJson.flowAxis, domainJson.flowSign, particleConfig
    );

    let particles = null;
    if (WAKE_PARTICLES_ENABLED && sdf) {
      particles = createParticleField(root, { grid: null, sdf, domain, ...FALCON_PARTICLE_OVERRIDES });
      holder.add(particles.object3D);
    }
    const streamlines = rakesConfig && sdf ? createStreamlineField(root, sdf, rakesConfig, {}, {}, bakedPaths, { domain }) : null;
    if (streamlines) holder.add(streamlines.object3D);

    // The cloud deck below moves along the flow's horizontal direction, as far as the air has travelled.
    const deck = { travelled: 0 };
    const deckDir = [domain.dirX, domain.dirZ], deckLen = Math.hypot(deckDir[0], deckDir[1]) || 1;
    const moveDeck = () => setDeckDrift((deckDir[0] / deckLen) * deck.travelled, (deckDir[1] / deckLen) * deck.travelled);

    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const rig = createCameraRig(camera, controls, box, SCENE_UI.falcon.camera, { hasGround: false });
    const componentIndex = createComponentIndex(componentsData, root, 'falcon');

    // eslint-disable-next-line no-console
    console.log(
      `[airflow-visualiser] Falcon 6X loaded: ${components.size} components, ` +
      `${streamlines ? streamlines.streamlineCount : 0} traced streamlines (${streamlines ? streamlines.triangleCount : 0} triangles), ` +
      `${particles ? `${particles.count}/${particles.maxCount} wake particles` : 'wake particles OFF'}.`
    );

    return {
      id: 'falcon', holder, root, components, wheels: [], particles, streamlines, grid: null, sdf, rig, componentIndex,
      ui: SCENE_UI.falcon,
      flow: { ...flowApi(streamlines, particles), resetTime: () => { if (streamlines) streamlines.resetTime(); deck.travelled = 0; moveDeck(); } },
      limits: { wakeDefaultCount: particles ? particles.count : 0, wakeMaxCount: particles ? particles.maxCount : 0 },
      update(simDt) {
        if (particles) particles.update(simDt);
        if (streamlines) streamlines.update(simDt);
        // the cloud deck drifts past with the oncoming air (the Speed slider and Pause scale simDt)
        if (simDt) { deck.travelled += particleConfig.flowSpeed * simDt; moveDeck(); }
      },
    };
  }

  const creators = { f1: createF1World, falcon: createFalconWorld };
  const showStatus = () => { if (statusEl) { statusEl.hidden = false; statusEl.classList.remove('done'); } };
  const hideStatus = () => { if (statusEl) { statusEl.classList.add('done'); setTimeout(() => { if (statusEl.classList.contains('done')) statusEl.hidden = true; }, 500); } };

  async function loadWorld(id) {
    if (!worlds[id]) {
      showStatus();
      try { worlds[id] = await creators[id](); } finally { hideStatus(); }
    }
    return worlds[id];
  }

  function show(world, previous) {
    if (previous) previous.holder.visible = false;
    world.holder.visible = true;
    setEnvironment(world.id);
    world.rig.activate();
    current = world;
  }

  // Debug/inspection hook used by the headless checks and screenshot scripts, and by manual console poking. Not part
  // of the user-facing UI. It always describes the scene being shown.
  function exposeDebugHook(ui) {
    const hook = { THREE, ui, scene, camera, renderer, controls, worlds, loadWorld };
    for (const key of ['rig', 'componentIndex']) Object.defineProperty(hook, key, { get: () => current[key], enumerable: true });
    for (const [key, field] of [['car', 'root'], ['components', 'components'], ['wheels', 'wheels'], ['particles', 'particles'], ['streamlines', 'streamlines'], ['grid', 'grid'], ['sdf', 'sdf']]) {
      Object.defineProperty(hook, key, { get: () => current[field], enumerable: true });
    }
    window.__airflow = hook;
  }

  loadWorld('f1')
    .then((world) => {
      show(world, null);
      const ui = createUi({
        world,
        loadWorld,
        onSceneChange: (from, to) => show(to, from),
      });
      ui.attachPicking(canvas, camera);
      ui.goPreset(world.ui.defaultPreset, true);
      exposeDebugHook(ui);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[airflow-visualiser] failed to load F1 model:', err);
      if (statusEl) statusEl.textContent = 'Could not load the model';
    });

  window.addEventListener('resize', resize);

  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);
    const simDt = playing ? dt * simSpeed : 0; // pause and the speed slider scale the flow and the wheels, not the camera
    if (current) {
      current.update(simDt);
      current.rig.update();
    } else {
      controls.update();
    }
    followCamera();
    renderer.render(scene, camera);
  }
  animate();
}

// Screens too small for the layout get a notice instead (src/index.html #smallScreen), and the models and data are not
// downloaded there. A window that grows past the limit starts the app then.
const SMALL_SCREEN = '(max-width: 760px), (max-height: 500px)';

function start() {
  const small = window.matchMedia(SMALL_SCREEN);
  if (!small.matches) { init(); return; }
  const onChange = () => { if (!small.matches) { small.removeEventListener('change', onChange); init(); } };
  small.addEventListener('change', onChange);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}
