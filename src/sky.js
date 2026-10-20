// The Falcon's open sky: a dome that follows the camera. A calm high-altitude gradient -- deep navy overhead fading
// to a muted blue at the horizon, dark enough to sit with the interface and let the white aircraft and the streamline
// colours stand out -- over a soft cloud deck well below the aircraft. There is no haze or fog anywhere: the clouds
// are on the dome, below the horizon, never between the camera and the aircraft. The same dome, rendered once into a
// cube map, reflects off the aircraft (scene.environment).
//
// The deck drifts past (Phase 5 review), so the aircraft reads as flying over it: it is drawn as a flat layer
// DECK_DEPTH below the aircraft, and moving it with the oncoming air (setDeckDrift, metres travelled by the air)
// slides the pattern at that speed, seen from that height. The noise is unbounded, so it never repeats or seams.

import * as THREE from 'three';

const VERT = `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = `
  uniform vec3 zenith;
  uniform vec3 upper;
  uniform vec3 horizon;
  uniform vec3 below;
  uniform vec3 cloudTop;
  uniform vec2 drift; // how far the deck has moved, in units of its depth below the aircraft
  varying vec3 vDir;

  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    // gradient: muted blue at the horizon, deepening to navy overhead
    vec3 col = mix(horizon, upper, smoothstep(0.0, 0.3, h));
    col = mix(col, zenith, smoothstep(0.25, 0.85, h));
    // below the horizon: the cloud deck, seen from above. Projected onto a flat layer under the aircraft so the
    // puffs foreshorten toward the horizon; soft-edged, a little brighter on top, deeper blue in the gaps.
    #ifndef NO_DECK
    if (h < 0.0) {
      vec2 uv = (d.xz / max(-h, 0.04) - drift) * 0.55;
      float n = fbm(vec3(uv, 0.0) + vec3(3.1, 0.0, 1.7));
      float tops = smoothstep(0.42, 0.72, n);
      vec3 deck = mix(below, cloudTop, tops);
      float spread = smoothstep(-0.04, -0.3, h); // the deck melts into the horizon tone with distance (and the far,
      // foreshortened puffs, which would alias into streaks, never show)
      col = mix(horizon, deck, spread);
    }
    #endif
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

const FALCON_SKY = {
  zenith: 0x0a1630,
  upper: 0x1b3561,
  horizon: 0x4f6d95,
  below: 0x34496b, // the gaps between the clouds
  cloudTop: 0x7385a1, // sunlit cloud tops, kept muted so the deck stays calm
  deck: true,
};

/**
 * The F1 track's dusk sky: the same calm gradient, in desaturated slate greys rather than blue, with no cloud deck
 * (the ground hides everything below the horizon). Its horizon tone is also the F1 fog colour, so the far scenery
 * fades into the sky without a seam.
 */
export const DUSK_SKY = { zenith: 0x0c0f14, upper: 0x1c2029, horizon: 0x585c65, below: 0x585c65, cloudTop: 0x585c65, deck: false };

/** How far below the aircraft the cloud deck is drawn, in world units (the aircraft is ~5.7 long). */
export const DECK_DEPTH = 14;

export function createSky(palette = FALCON_SKY) {
  const uniform = (hex) => ({ value: new THREE.Color(hex) });
  const material = new THREE.ShaderMaterial({
    uniforms: {
      zenith: uniform(palette.zenith),
      upper: uniform(palette.upper),
      horizon: uniform(palette.horizon),
      below: uniform(palette.below),
      cloudTop: uniform(palette.cloudTop),
      drift: { value: new THREE.Vector2() },
    },
    defines: palette.deck ? {} : { NO_DECK: '' },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), material);
  dome.name = 'Sky';
  dome.renderOrder = -1000;
  dome.frustumCulled = false;
  /** Moves the deck by (x, z) world units (the oncoming air's travel, horizontally); seen from DECK_DEPTH above it. */
  dome.userData.deckDepth = DECK_DEPTH;
  dome.userData.setDeckDrift = (x, z) => material.uniforms.drift.value.set(x / DECK_DEPTH, z / DECK_DEPTH);
  return dome;
}

/** Cube-map lighting made from the sky itself (so reflections and fill light match what is behind the aircraft). */
export function createSkyEnvironment(renderer) {
  const envScene = new THREE.Scene();
  envScene.add(createSky());
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(envScene, 0.02);
  pmrem.dispose();
  return target.texture;
}
