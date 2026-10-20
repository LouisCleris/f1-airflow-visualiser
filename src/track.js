// The F1 scene's surroundings: a minimalist race track built from simple swept geometry. Dark asphalt with white edge
// lines, low grey-and-white kerbs, barrier walls with catch-fence posts on both sides, and pit garages and grandstands
// for depth. Everything is greys and white so the airflow colours stay the only colours on
// screen.
//
// This is scenery only. The asphalt is flat at exactly y = 0 (the ground plane the flow already treats as exact, see
// particles/config.js groundY), and nothing here is part of the distance field or touches the airflow.
//
// Two layouts, both endless, because the track moves past the car (which never moves), like the rolling road of an
// F1 wind tunnel:
//   - Straight line: an endless straight along z. Everything on it repeats every TILE metres, and the whole straight
//     slides from the nose towards the tail, wrapping round every TILE metres, so it streams past seamlessly.
//   - Cornering: an endless left-hand corner of constant radius, a full ring (particles/cornering.js CORNER_TRACK).
//     The car sits on its line inside the centreline and the ring turns about its centre, so the kerbs sweep past
//     along the arc.
// Both move at exactly the speed of the oncoming air at the car (advance()).

import * as THREE from 'three';
import { CORNER_TRACK } from './particles/cornering.js';

const HALF_WIDTH = 7; // asphalt edge, either side of the centreline
const TILE = 120; // the straight repeats every TILE metres (a multiple of every spacing below)
const STRAIGHT_AHEAD = 200; // the straight reaches this far ahead of the car, and behind it, at any point of its slide
const KERB_BLOCK = 1.5; // kerb blocks alternate white and grey every KERB_BLOCK metres
const POST_SPACING = 4; // catch-fence posts along the barriers
const RING_RADIUS = CORNER_TRACK.radius;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const RING_START_ANGLE = 1.1; // the ring's turn at the start (radians): a grandstand in view from the usual cameras

/**
 * A path the track is swept along. `frameAt(s)` gives the point `p` on the centreline at arc length s, the direction
 * `t` along it and the horizontal normal `n`; positive offsets lie on the +n side (the outside of the ring).
 */
const straightPath = {
  length: 2 * STRAIGHT_AHEAD + TILE,
  frameAt: (s) => ({ p: new THREE.Vector3(0, 0, STRAIGHT_AHEAD + TILE - s), t: new THREE.Vector3(0, 0, -1), n: new THREE.Vector3(1, 0, 0) }),
  step: 20, // exact on a straight, however sparse
};

const ringPath = {
  length: RING_LENGTH,
  frameAt: (s) => {
    const a = s / RING_RADIUS, c = Math.cos(a), sn = Math.sin(a);
    return { p: new THREE.Vector3(RING_RADIUS * c, 0, RING_RADIUS * sn), t: new THREE.Vector3(-sn, 0, c), n: new THREE.Vector3(c, 0, sn) };
  },
  step: 1, // about one metre per segment round the ring
};

/** Arc-length samples between s0 and s1, at most `path.step` apart. */
function samples(path, s0, s1) {
  const n = Math.max(1, Math.ceil((s1 - s0) / path.step - 1e-9));
  return Array.from({ length: n + 1 }, (_, i) => s0 + ((s1 - s0) * i) / n);
}

/** Accumulates flat-shaded, vertex-coloured triangles into one geometry, so each material is a single draw call. */
class Builder {
  constructor(path) { this.path = path; this.pos = []; this.nor = []; this.col = []; }

  tri(a, b, c, normal, color) {
    // wind the triangle to face `normal`, so front-face culling works whichever order the corners arrive in
    const e1 = new THREE.Vector3().subVectors(b, a), e2 = new THREE.Vector3().subVectors(c, a);
    if (e1.cross(e2).dot(normal) < 0) [b, c] = [c, b];
    for (const v of [a, b, c]) {
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(normal.x, normal.y, normal.z);
      this.col.push(color.r, color.g, color.b);
    }
  }

  /**
   * Sweeps a cross-section along the centreline from s0 to s1. `profile` is a list of [offset, height] points in order
   * of increasing offset, going over the top, so each segment's outward side is to its left; `caps` closes both ends.
   */
  sweep(profile, s0, s1, color, caps = false) {
    const c = new THREE.Color(color);
    const ss = samples(this.path, s0, s1);
    const at = (f, [o, y]) => f.p.clone().addScaledVector(f.n, o).setY(y);
    for (let i = 0; i + 1 < ss.length; i++) {
      const f0 = this.path.frameAt(ss[i]), f1 = this.path.frameAt(ss[i + 1]);
      const fm = this.path.frameAt((ss[i] + ss[i + 1]) / 2);
      for (let k = 0; k + 1 < profile.length; k++) {
        const [o0, y0] = profile[k], [o1, y1] = profile[k + 1];
        const len = Math.hypot(o1 - o0, y1 - y0) || 1;
        const normal = fm.n.clone().multiplyScalar(-(y1 - y0) / len).add(new THREE.Vector3(0, (o1 - o0) / len, 0));
        const a = at(f0, profile[k]), b = at(f0, profile[k + 1]), d = at(f1, profile[k]), e = at(f1, profile[k + 1]);
        this.tri(a, b, d, normal, c);
        this.tri(b, e, d, normal, c);
      }
    }
    if (caps) {
      const contour = profile.map(([o, y]) => new THREE.Vector2(o, y));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      for (const [s, sign] of [[s0, 1], [s1, -1]]) {
        const f = this.path.frameAt(s);
        const normal = f.t.clone().multiplyScalar(-sign);
        for (const [i, j, k] of tris) this.tri(at(f, profile[i]), at(f, profile[j]), at(f, profile[k]), normal, c);
      }
    }
  }

  /**
   * A box standing on the path at arc length s: `o0..o1` across it, `l0..l1` along it (relative to s), `y0..y1` high,
   * its faces shaded flat. Square to the path, so on the ring it follows the curve.
   */
  post(s, [o0, o1], [l0, l1], [y0, y1], color) {
    const c = new THREE.Color(color);
    const f = this.path.frameAt(s);
    const v = (o, l, y) => f.p.clone().addScaledVector(f.n, o ? o1 : o0).addScaledVector(f.t, l ? l1 : l0).setY(y ? y1 : y0);
    const faces = [
      [f.n, [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)]],
      [f.n.clone().negate(), [v(0, 0, 0), v(0, 1, 0), v(0, 1, 1), v(0, 0, 1)]],
      [new THREE.Vector3(0, 1, 0), [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)]],
      [f.t, [v(0, 1, 0), v(1, 1, 0), v(1, 1, 1), v(0, 1, 1)]],
      [f.t.clone().negate(), [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)]],
    ];
    for (const [normal, [a, b, d, e]] of faces) {
      this.tri(a, b, d, normal, c);
      this.tri(a, d, e, normal, c);
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Flat, slightly raised strips (paint) drawn over the asphalt without z-fighting. */
const paintMaterial = (color) => new THREE.MeshStandardMaterial({
  color, roughness: 0.8, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
});

/** The asphalt's slab-to-slab tone (a few percent either way), so the road surface itself shows it moving. */
const SLAB_TONES = [1, 0.95, 1.03, 0.97, 1.05, 0.96, 1.01, 0.94, 1.04, 0.98];

/**
 * One layout's track, swept along `path`: asphalt in slabs of slightly varying tone, edge lines, kerbs, barrier
 * walls with fence posts, and the distant shapes `addFar` adds. Every repeating element is spaced so it
 * repeats exactly over `period` (the straight's TILE, or the ring's whole length), which is what makes the motion
 * seamless.
 */
function buildLayout(name, path, { period, kerbSpans, addFar, materials }) {
  const group = new THREE.Group();
  group.name = name;
  const mesh = (builder, material, meshName, receiveShadow = false) => {
    const m = new THREE.Mesh(builder.geometry(), material);
    m.name = meshName;
    m.receiveShadow = receiveShadow;
    group.add(m);
    return m;
  };
  const along = (spacing, fn) => { // fn(s, i) at every multiple of a spacing that divides the period exactly
    const n = Math.round(period / spacing), step = period / n;
    for (let s = 0, i = 0; s < path.length - 1e-6; s += step, i++) fn(s, i, step);
  };

  // Asphalt: flat at exactly y = 0, catching the car's shadow; 12 m slabs a shade lighter or darker than each other.
  const asphalt = new Builder(path);
  along(12, (s, i, step) => {
    const k = SLAB_TONES[i % SLAB_TONES.length];
    asphalt.sweep([[-HALF_WIDTH, 0], [HALF_WIDTH, 0]], s, Math.min(s + step, path.length), new THREE.Color(k, k, k));
  });
  mesh(asphalt, materials.asphalt, 'Road Surface', true);

  // White edge lines, just inside each asphalt edge.
  const lines = new Builder(path);
  lines.sweep([[-HALF_WIDTH + 0.05, 0], [-HALF_WIDTH + 0.3, 0]], 0, path.length, 0xffffff);
  lines.sweep([[HALF_WIDTH - 0.3, 0], [HALF_WIDTH - 0.05, 0]], 0, path.length, 0xffffff);
  mesh(lines, materials.paint, 'Edge Lines', true);

  // Kerbs, inside and outside: low bevelled blocks alternating white and mid grey, over each span [s0, s1].
  const kerbs = new Builder(path);
  const kerbProfile = (a, b) => [[a, 0], [a + 0.18, 0.05], [b - 0.25, 0.05], [b, 0]];
  along(KERB_BLOCK, (s, i, step) => {
    if (!kerbSpans.some(([a, b]) => s >= a - 1e-6 && s + step <= b + 1e-6)) return;
    const color = i % 2 ? 0x6b6e73 : 0xd6d7d9;
    kerbs.sweep(kerbProfile(-HALF_WIDTH - 1.1, -HALF_WIDTH), s, s + step, color);
    kerbs.sweep(kerbProfile(HALF_WIDTH, HALF_WIDTH + 1.1), s, s + step, color);
  });
  mesh(kerbs, materials.kerbs, 'Kerbs');

  // Barrier walls along both sides (concrete faces with a pale cap), and the posts of the catch fence above them.
  const walls = new Builder(path);
  const wall = (a, b, h) => {
    walls.sweep([[a, 0], [a, h], [b, h], [b, 0]], 0, path.length, 0x63676e);
    walls.sweep([[a - 0.02, h], [a - 0.02, h + 0.08], [b + 0.02, h + 0.08], [b + 0.02, h]], 0, path.length, 0xb9bcc1);
  };
  wall(-12.4, -12, 0.9);
  wall(12, 12.4, 0.9);
  along(POST_SPACING, (s) => {
    walls.post(s, [-12.28, -12.14], [-0.07, 0.07], [0.98, 3.4], 0x8d9097);
    walls.post(s, [12.14, 12.28], [-0.07, 0.07], [0.98, 3.4], 0x8d9097);
  });
  mesh(walls, materials.walls, 'Barriers');

  const far = new Builder(path);
  addFar(far);
  mesh(far, materials.far, 'Distant Shapes');
  return group;
}

/**
 * @returns {THREE.Group} named 'Road'. userData: setLayout(mode, corner), advance(metres), resetMotion().
 */
export function createTrack() {
  const group = new THREE.Group();
  group.name = 'Road';
  const solid = (extra = {}) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, ...extra });
  const materials = {
    asphalt: new THREE.MeshStandardMaterial({ color: 0x2a2c30, vertexColors: true, roughness: 0.95, metalness: 0 }),
    paint: paintMaterial(0xd9dadc),
    kerbs: solid({ roughness: 0.7 }),
    walls: solid(),
    far: solid({ roughness: 0.95 }),
  };

  // Straight line: kerbs over a third of each tile, pit garages beyond the +x pit wall and a grandstand opposite,
  // alternating, each once per tile.
  const straight = buildLayout('Straight Track', straightPath, {
    period: TILE, materials,
    kerbSpans: Array.from({ length: Math.ceil(straightPath.length / TILE) }, (_, k) => [k * TILE + 66, k * TILE + 102]),
    addFar(far) {
      far.sweep([[12.4, 0], [24, 0]], 0, straightPath.length, 0x2e3034); // pit lane
      for (let s0 = 0; s0 < straightPath.length - 1e-6; s0 += TILE) {
        const a = s0 + 10, b = s0 + 70; // garages: ground floor, glazing band, roof
        far.post((a + b) / 2, [26, 36], [-(b - a) / 2, (b - a) / 2], [0, 3.2], 0x46494f);
        far.post((a + b) / 2, [26.6, 36], [-(b - a) / 2 + 0.6, (b - a) / 2 - 0.6], [3.2, 5.4], 0x1b1d21);
        far.post((a + b) / 2, [25.2, 36.4], [-(b - a) / 2 - 0.8, (b - a) / 2 + 0.8], [5.4, 6.0], 0xa9acb2);
        const c = s0 + 74, d = s0 + 114; // grandstand opposite, under a thin roof on slim columns
        far.sweep(standProfile(-36, -46, 7, 0.9), c, d, 0x464a51, true);
        far.sweep([[-47, 9.6], [-47, 9.9], [-35, 9.9], [-35, 9.6]], c - 1, d + 1, 0x7a7e85, true);
        for (let sc = c + 1; sc <= d - 1 + 1e-6; sc += 9.5) far.post(sc, [-46.8, -46.4], [-0.2, 0.2], [0, 9.6], 0x3c4046);
      }
    },
  });

  // Cornering: the ring, kerbs all the way round, three grandstands round the outside and one in the infield.
  const ring = buildLayout('Corner Track', ringPath, {
    period: RING_LENGTH, materials,
    kerbSpans: [[0, RING_LENGTH]],
    addFar(far) {
      for (let k = 0; k < 3; k++) {
        const c = (k * RING_LENGTH) / 3 + 10, d = c + 40;
        far.sweep(standProfile(24, 33, 6, 0.9), c, d, 0x464a51, true);
      }
      far.sweep(standProfile(-21, -27, 4, 0.8), RING_LENGTH / 6, RING_LENGTH / 6 + 22, 0x464a51, true);
    },
  });
  group.add(straight, ring);

  // Run-off either side, a shade lighter than the asphalt, set a little lower so the two never fight for depth.
  // Plain, so it never needs to show the motion; it covers both layouts.
  const runoff = new THREE.Mesh(
    new THREE.PlaneGeometry(800, 800),
    new THREE.MeshStandardMaterial({ color: 0x35383d, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 })
  );
  runoff.rotation.x = -Math.PI / 2;
  runoff.position.set(0, -0.05, 0);
  runoff.name = 'Run-off';
  group.add(runoff);

  let mode = 'straight';
  let corner = null; // { centre: [x, y, z], sense: +1 / -1 } in Cornering
  let slid = 0, turned = 0; // how far each layout has moved since the start (metres along the straight, radians of ring)
  let travelled = 0; // metres the road has moved past the car since the start (not wrapped)

  const place = () => {
    if (mode !== 'cornering' || !corner) {
      group.position.set(0, 0, -slid); // from the nose (+z) towards the tail, wrapping every TILE
      group.rotation.set(0, 0, 0);
    } else {
      group.position.set(corner.centre[0], 0, corner.centre[2]); // the road stays at y = 0
      group.rotation.set(0, RING_START_ANGLE + turned, 0);
    }
    straight.visible = mode !== 'cornering';
    ring.visible = mode === 'cornering';
  };

  /**
   * Straight line: the straight, centred on the car. Cornering: the ring, centred on the corner's centre as the
   * flow sees it (particles/cornering.js cornerCentre), turning so that at the car it moves along `flowDir` (the
   * oncoming air's direction there). opts: { centre, car, flowDir }, world [x, y, z] each.
   */
  group.userData.setLayout = (m, opts = null) => {
    mode = m === 'cornering' ? 'cornering' : 'straight';
    if (mode === 'cornering' && opts) {
      const [cx, , cz] = opts.centre;
      const rx = opts.car[0] - cx, rz = opts.car[2] - cz; // the car relative to the centre
      // a small turn about +y moves that point along (rz, 0, -rx)
      const sense = Math.sign(rz * opts.flowDir[0] - rx * opts.flowDir[2]) || 1;
      corner = { centre: opts.centre, sense, carRadius: Math.hypot(rx, rz) };
    }
    place();
  };

  /** Moves the track past the car by `metres`, at the car (the speed of the oncoming air there times the time step). */
  group.userData.advance = (metres) => {
    if (!metres) return;
    travelled += metres;
    slid = (slid + metres) % TILE;
    if (corner) turned = (turned + (corner.sense * metres) / corner.carRadius) % (2 * Math.PI);
    place();
  };

  /** Back to the start (Reset). */
  group.userData.resetMotion = () => { slid = 0; turned = 0; travelled = 0; place(); };

  /** Metres the road has moved past the car since the start or the last Reset. */
  group.userData.travelled = () => travelled;

  place();
  return group;
}

/**
 * Cross-section of a grandstand: `rows` steps of height `rise` climbing from offset `front` (nearest the track) to
 * `back`, with a vertical back wall. Returned in order of increasing offset, as Builder.sweep expects.
 */
function standProfile(front, back, rows, rise) {
  const depth = (back - front) / rows; // signed: negative on the -x side
  const pts = [[front, 0]];
  for (let i = 0; i < rows; i++) pts.push([front + i * depth, (i + 1) * rise], [front + (i + 1) * depth, (i + 1) * rise]);
  pts.push([back, 0]);
  return depth < 0 ? pts.reverse() : pts;
}
