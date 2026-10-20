// Phase 4 colour fix (why lines read white): the material was fine (unlit
// MeshBasicMaterial, vertex colours on, 4-channel colour attribute, per-frame
// update does not overwrite the hue). The colour was lost in the DATA and the
// blending: (1) the ramp was interpolated in RGB, whose blue-orange midpoint
// is grey, and the fixed speed range put most points near that midpoint; (2)
// the surface/vorticity boost and the pulse both lerped colour toward WHITE;
// (3) additive blending stacked overlapping lines to white. Now: OKLab ramp
// scaled to the scene's own 5th-95th percentile speed, normal alpha blending,
// boost raises opacity only, and the pulse changes brightness/opacity but
// keeps hue.
//
// Three.js wrapper around streamlines.js -- Phase 3.5 rebuild, updated for
// Phase 3.6 section 6: thin lines (not wide ribbons), additive blending at
// low base opacity (20-40%) so overlapping lines build brightness instead
// of ever reading as a white sheet, opacity fading in at a line's start and
// out at its end (via the traced `coherence` value -- see streamlines.js),
// speed-driven cool-to-warm colour, brightness boosted where |vorticity| is
// high (rotating regions read brighter than uniform flow), far-field points
// (near-zero `disturbance` -- see streamlines.js, |V-freestream|) faded
// toward invisible, and a brightness pulse that travels at the LOCAL flow
// speed rather than a uniform one.
//
// Still one static, indexed ribbon-strip THREE.Mesh built once at load
// (position buffer never touched again, per the author's "do not move the line
// geometry") with only the per-vertex COLOR buffer rewritten every frame --
// same shape as the Phase 3 addendum's renderer, just fed richer per-point
// data (speed, coherence, time-of-flight) and with far fewer, far shorter
// lines (PHASE-3.5.md's whole point: ~80 followable lines, not 360).
//
// Why still a hand-rolled ribbon and not three/addons/lines/LineMaterial
// (which gives genuinely constant screen-space width for free): that
// material's fragment shader hardcodes alpha = a single `opacity` uniform
// with no per-vertex alpha channel, so it cannot do the fade-in/fade-out/
// wake-incoherence-fade this phase explicitly requires without patching
// its shader. A thin, low-alpha, additively-blended ribbon avoids the
// "white sheet"/fence look this phase is actually guarding against, so the
// simpler, already-proven approach was kept instead of taking on custom
// shader-patching risk for the width alone.
//
// Pulse phasing against TIME-OF-FLIGHT (not arc length): each vertex
// carries the elapsed integration time since its line's seed, which
// advances by a fixed dt per step regardless of local speed (see
// streamlines.js). A pulse whose phase is (timeOfFlight - elapsedSeconds)
// mod period therefore reaches each vertex at a fixed moment in real time
// -- but since fast-flow vertices are spaced further apart in WORLD SPACE
// for the same time-of-flight step (fixed dt, position += velocity * dt),
// the pulse visibly covers more distance per second exactly where the
// field is faster. This is what makes it read as accelerating air rather
// than a moving texture, with no separate "pulse speed" tuning constant
// disconnected from the actual field.

import * as THREE from 'three';

export const STREAMLINE_RENDER_CONFIG = {
  lineWidthPx: 1.75, // constant on-screen line width in CSS pixels (camera-facing, any view angle)
  // OPACITY FOLLOWS THE EFFECT: each point's opacity is set by how far its (smoothed) speed is from
  // freestream, so undisturbed air fades almost out and the strongest slowing / speeding-up is the most
  // opaque. This replaces the separate near-surface / vorticity boost and the disturbance fade.
  alphaUndisturbed: 0.08, // opacity at freestream speed
  alphaMax: 0.6, // opacity at the strongest slowing or speeding-up
  colorCurve: 0.5, // exponent applied to the normalised speed deviation (0.5 = square root): moderate
  // changes read clearly blue or orange instead of pastel; used for both colour and opacity
  speedSmoothSigma: 0.06, // world units of arc length over which each line's speed is smoothed before colouring
  minBlueRun: 0.1, // a run of 'slower than freestream' colour shorter than this (arc length) is ignored: it is
  // blended into its neighbours instead of showing as a speck
  pulseAlpha: 0.95,
  pulsePeriod: 0.85, // seconds between successive pulses passing a fixed
  // time-of-flight offset on one line
  pulseWidth: 0.28, // fraction of one period the bright band occupies
  glowMix: 0.3, // how much the pulse peak brightens the line (scales the same hue up; never toward white)
  fadeInFraction: 0.15, // fraction of a line's OWN point count over which
  // its opacity ramps 0 -> 1 at its upstream end, so no line begins with a
  // hard-edged bright tip. Was a fixed fadeInSteps (26, before that 6);
  // the author asked for the fade to scale with each line's own length instead
  // of a fixed step count, since upstreamRunCarLengths (streamlines.js) now
  // gives lines varying point counts depending on local flow speed
  freestreamSpeed: 5.5, // speed that maps to the neutral colour; streamlineField.js passes PARTICLE_CONFIG.flowSpeed
  neutralColor: [0x9a / 255, 0xa3 / 255, 0xb2 / 255], // freestream, #9AA3B2 -- a cool mid-grey so undisturbed lines sit back
  coolColor: [0x4c / 255, 0x7d / 255, 0xff / 255], // slower than freestream, #4C7DFF
  warmColor: [0xf2 / 255, 0x8c / 255, 0x38 / 255], // faster than freestream, #F28C38
  speedPercentiles: [0.05, 0.95], // slow side uses the 5th percentile of points below freestream, fast side the 95th of points above
  // Optional focus envelope (null = off; the F1 sets none). A list of world-space capsules { a, b, radius } round the
  // body's parts: a point's opacity is kept within focusFade[0] of the nearest capsule's surface and fades to zero by
  // focusFade[1], so lines read near the body and the undisturbed far field drops away. Offsets along the flow
  // (focusFlowDir) count only 1/focusAlongScale as much, so the envelope reaches further upstream and downstream than
  // sideways; [upstream, downstream] sets the two separately. streamlineField.js resolves a scene's rakes.json
  // `display.focus` into these.
  focus: null,
  focusFade: [0.2, 0.8],
  focusFlowDir: [0, 0, -1],
  focusAlongScale: 1,
  nearFade: [0, 0], // [start, end] camera distance (world units): lines closer to the camera than `start` are hidden,
  // fading in by `end`, so a line passing beside the lens never smears across the screen. [0, 0] = off (the F1).
  viewFade: null, // [start, end] |cos| of the angle between a segment and the line of sight: a segment pointing almost
  // straight at the camera (or away) fades out from `start` to `end`, so lines seen end-on never converge on the
  // viewer as radial spikes. null = off (the F1), and the shader is then exactly as before.
  focusMaxSegment: 0.12, // with a focus envelope, longer segments are split first: baked lines keep only the end
  // points of straight stretches, and opacity is interpolated per vertex, so a fade needs vertices to happen on
};

/** Splits every segment longer than `maxLen`, interpolating the per-point arrays the renderer reads. */
function densify(path, maxLen) {
  const P = path.positions, n = P.length / 3;
  const pos = [], speeds = [], coherence = [], tof = [];
  for (let i = 0; i < n; i++) {
    const k = i < n - 1 ? Math.ceil(Math.hypot(P[i * 3 + 3] - P[i * 3], P[i * 3 + 4] - P[i * 3 + 1], P[i * 3 + 5] - P[i * 3 + 2]) / maxLen) : 1;
    for (let j = 0; j < k; j++) {
      const t = j / k, i1 = Math.min(i + 1, n - 1);
      for (let c = 0; c < 3; c++) pos.push(P[i * 3 + c] + (P[i1 * 3 + c] - P[i * 3 + c]) * t);
      speeds.push(path.speeds[i] + (path.speeds[i1] - path.speeds[i]) * t);
      coherence.push(path.coherence[i] + (path.coherence[i1] - path.coherence[i]) * t);
      tof.push(path.timeOfFlight[i] + (path.timeOfFlight[i1] - path.timeOfFlight[i]) * t);
    }
  }
  return { ...path, positions: Float32Array.from(pos), speeds: Float32Array.from(speeds), coherence: Float32Array.from(coherence), timeOfFlight: Float32Array.from(tof) };
}

/** Distance from p to the nearest focus capsule's surface, with the along-flow part of the offset scaled down. */
function focusDistance(focus, dir, alongScale, px, py, pz) {
  const [scaleUp, scaleDown] = Array.isArray(alongScale) ? alongScale : [alongScale, alongScale];
  let best = Infinity;
  for (const c of focus) {
    const [ax, ay, az] = c.a, [bx, by, bz] = c.b;
    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const len2 = ex * ex + ey * ey + ez * ez || 1e-12;
    const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / len2));
    let dx = px - (ax + ex * t), dy = py - (ay + ey * t), dz = pz - (az + ez * t);
    const along = dx * dir[0] + dy * dir[1] + dz * dir[2];
    const k = along * (1 - 1 / (along < 0 ? scaleUp : scaleDown));
    dx -= dir[0] * k; dy -= dir[1] * k; dz -= dir[2] * k;
    const d = Math.hypot(dx, dy, dz) - c.radius;
    if (d < best) best = d;
  }
  return best;
}

function lerp(a, b, t) { return a + (b - a) * t; }

// sRGB <-> linear and linear sRGB <-> OKLab (Bjorn Ottosson's matrices).
function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function linearToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function oklabToLinear(L, a, b) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Speed ramp CENTRED on the freestream speed: t in [-1, 1] -> LINEAR rgb.
 * t < 0 (slower than freestream) goes neutral -> `cool`, t = 0 is the pale
 * neutral, t > 0 goes neutral -> `warm`. Each half is interpolated in OKLab so
 * the middle stays a clean colour. Inputs are sRGB 0-1; the renderer converts
 * the linear output to sRGB on screen.
 */
function makeCentredRamp(cool, neutral, warm, curve = 1) {
  const c = linearToOklab(...cool.map(srgbToLinear));
  const n = linearToOklab(...neutral.map(srgbToLinear));
  const w = linearToOklab(...warm.map(srgbToLinear));
  return (t) => {
    const end = t < 0 ? c : w;
    const u = Math.pow(Math.min(1, Math.abs(t)), curve);
    return oklabToLinear(lerp(n[0], end[0], u), lerp(n[1], end[1], u), lerp(n[2], end[2], u)).map(clamp01);
  };
}

/** Gaussian-smooths `values` along a polyline by ARC LENGTH (so denser points near surfaces don't change the amount of smoothing). `arc` = cumulative arc length per point. */
function smoothAlongArc(values, arc, sigma) {
  const n = values.length, out = new Float32Array(n);
  if (sigma <= 0) { out.set(values); return out; }
  const reach = 3 * sigma;
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    while (arc[i] - arc[lo] > reach) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < n && arc[hi + 1] - arc[i] <= reach) hi++;
    let sw = 0, sv = 0;
    for (let j = lo; j <= hi; j++) { const d = arc[j] - arc[i]; const w = Math.exp(-0.5 * d * d / (sigma * sigma)); sw += w; sv += w * values[j]; }
    out[i] = sv / sw;
  }
  return out;
}

/** Replaces runs where `t` < 0 (slower than freestream) that are shorter than `minArc` with a linear blend of the values on either side of the run. Mutates `t`. */
function dropShortBlueRuns(t, arc, minArc) {
  const n = t.length;
  let i = 0;
  while (i < n) {
    if (t[i] >= 0) { i++; continue; }
    let j = i;
    while (j + 1 < n && t[j + 1] < 0) j++;
    const runArc = arc[j] - arc[i];
    if (runArc < minArc && i > 0 && j < n - 1) {
      const a = t[i - 1], b = t[j + 1], span = arc[j + 1] - arc[i - 1] || 1;
      for (let k = i; k <= j; k++) t[k] = Math.max(0, a + (b - a) * ((arc[k] - arc[i - 1]) / span));
    }
    i = j + 1;
  }
}

/** p-th percentile (0-1) of `values` (sorted in place); 0 if empty. */
function percentile(values, p) {
  if (values.length === 0) return 0;
  values.sort((x, y) => x - y);
  return values[Math.min(values.length - 1, Math.floor(p * (values.length - 1)))];
}

const VERTEX_SHADER = `
  attribute vec3 tangent;     // unit direction of travel (world space)
  attribute float side;       // -1 / +1: which edge of the line this vertex is
  attribute vec4 color;       // rest colour (linear rgb) + rest opacity
  attribute float timeOfFlight;
  attribute float coherence;
  attribute float groupId;    // index of the seeding group this line belongs to
  attribute float lineRank;   // 0..1, evenly spread over the lines: the density slider keeps lines whose rank is below it
  uniform float groupOn[MAX_GROUPS];  // 1 if this group is shown, else 0
  uniform float density;
  uniform vec2 resolution;    // drawing-buffer size in pixels
  uniform float halfWidthPx;  // half line width in drawing-buffer pixels
  uniform float time;
  uniform float pulsePeriod;
  uniform float pulseWidth;
  uniform float pulseAlpha;
  uniform float glowMix;
  uniform vec2 nearFade;
  varying vec4 vColor;
  void main() {
    // Camera-facing line of constant SCREEN width: push each vertex sideways
    // in screen space, perpendicular to the line's projected direction.
    vec4 c0 = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec4 c1 = projectionMatrix * modelViewMatrix * vec4(position + tangent * 0.05, 1.0);
    vec2 s0 = c0.xy / c0.w * resolution * 0.5;
    vec2 s1 = c1.xy / c1.w * resolution * 0.5;
    vec2 d = s1 - s0;
    float len = length(d);
    d = len > 1e-4 ? d / len : vec2(1.0, 0.0);
    vec2 n = vec2(-d.y, d.x);
    c0.xy += n * side * halfWidthPx / (resolution * 0.5) * c0.w;
    gl_Position = c0;

    // Travelling pulse (was a per-frame CPU loop over every vertex): it only
    // brightens the line's own hue and lifts its opacity.
    float phase = mod(timeOfFlight - time, pulsePeriod);
    if (phase < 0.0) phase += pulsePeriod;
    float u = phase / pulsePeriod;
    float pulse = (u < pulseWidth ? 1.0 - abs(u / pulseWidth - 0.5) * 2.0 : 0.0) * coherence;
    float gain = 1.0 + glowMix * pulse;
    float a = color.a;
    float shown = groupOn[int(groupId + 0.5)] * step(lineRank, density);
    float near = nearFade.y > 0.0 ? smoothstep(nearFade.x, nearFade.y, c0.w) : 1.0; // c0.w = distance in front of the camera
    vColor = vec4(min(vec3(1.0), color.rgb * gain), near * shown * max(a, min(1.0, a + (pulseAlpha - a) * pulse)));
  }
`;
const FRAGMENT_SHADER = `
  varying vec4 vColor;
  void main() {
    gl_FragColor = vColor;
    #include <colorspace_fragment>
  }
`;

/**
 * @param {ReturnType<import('./streamlines.js').traceStreamline>[]} paths
 * @param {Partial<typeof STREAMLINE_RENDER_CONFIG>} [overrides]
 */
export const MAX_STREAMLINE_GROUPS = 32;

export function createStreamlineRenderer(paths, overrides = {}) {
  const cfg = { ...STREAMLINE_RENDER_CONFIG, ...overrides };
  if (cfg.focus) paths = paths.map((p) => densify(p, cfg.focusMaxSegment));
  const groupNames = [];
  for (const p of paths) if (!groupNames.includes(p.group)) groupNames.push(p.group);
  if (groupNames.length > MAX_STREAMLINE_GROUPS) throw new Error('too many streamline groups');
  const pathCount = paths.length;

  let vertexCount = 0;
  let indexCount = 0;
  for (const p of paths) {
    const n = p.positions.length / 3;
    if (n < 2) continue;
    vertexCount += n * 2;
    indexCount += (n - 1) * 6;
  }

  const positions = new Float32Array(vertexCount * 3);
  const tangents = new Float32Array(vertexCount * 3);
  const sides = new Float32Array(vertexCount);
  const timeOfFlight = new Float32Array(vertexCount);
  const coherenceAtVertex = new Float32Array(vertexCount);
  const envelopes = cfg.focus ? new Float32Array(vertexCount) : null; // focus envelope per vertex (scenes with one only)
  const groupIds = new Float32Array(vertexCount);
  const lineRanks = new Float32Array(vertexCount);
  const colors = new Float32Array(vertexCount * 4); // rest colour + rest opacity, written once
  const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(indexCount);

  // Speed relative to the freestream: slower -> cool, equal -> neutral,
  // faster -> warm. Each side is scaled separately, by the 5th percentile of
  // the points below freestream and the 95th of the points above it.
  const ramp = makeCentredRamp(cfg.coolColor, cfg.neutralColor, cfg.warmColor, cfg.colorCurve);
  const fs = cfg.freestreamSpeed;
  // Smooth each line's speed along its arc length FIRST; the percentile scaling below then
  // describes what is actually coloured.
  const arcs = new Map(), smoothed = new Map();
  for (const path of paths) {
    const q = path.positions, m = q.length / 3;
    if (m < 2) continue;
    const arc = new Float32Array(m);
    for (let i = 1; i < m; i++) arc[i] = arc[i - 1] + Math.hypot(q[i * 3] - q[i * 3 - 3], q[i * 3 + 1] - q[i * 3 - 2], q[i * 3 + 2] - q[i * 3 - 1]);
    arcs.set(path, arc);
    smoothed.set(path, smoothAlongArc(path.speeds, arc, cfg.speedSmoothSigma));
  }
  const below = [], above = [];
  for (const sp of smoothed.values()) for (let i = 0; i < sp.length; i++) (sp[i] < fs ? below : above).push(sp[i]);
  const slowRef = Math.min(fs - 1e-6, percentile(below, cfg.speedPercentiles[0]));
  const fastRef = Math.max(fs + 1e-6, percentile(above, cfg.speedPercentiles[1]));
  const { fadeInFraction } = cfg;

  let vi = 0;
  let ii = 0;
  let pathIndex = -1;
  for (const path of paths) {
    pathIndex++;
    const gid = groupNames.indexOf(path.group);
    const rank = (pathIndex * 0.6180339887) % 1; // golden-ratio spacing: any prefix of ranks is evenly spread across the lines
    const p = path.positions;
    const n = p.length / 3;
    if (n < 2) continue;
    const base = vi;
    const fadeInSteps = Math.max(1, Math.round(n * fadeInFraction)); // this line's own share, not a fixed count

    // Speed -> colour parameter t in [-1, 1], smoothed along the line so colour changes gradually.
    const arc = arcs.get(path);
    const smoothSpeed = smoothed.get(path);
    const tLine = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = smoothSpeed[i];
      tLine[i] = v < fs ? -clamp01((fs - v) / (fs - slowRef)) : clamp01((v - fs) / (fastRef - fs));
    }
    dropShortBlueRuns(tLine, arc, cfg.minBlueRun);

    for (let i = 0; i < n; i++) {
      const pi = i > 0 ? i - 1 : i;
      const ni = i < n - 1 ? i + 1 : i;
      let tx = p[ni * 3] - p[pi * 3];
      let ty = p[ni * 3 + 1] - p[pi * 3 + 1];
      let tz = p[ni * 3 + 2] - p[pi * 3 + 2];
      const tLen = Math.hypot(tx, ty, tz) || 1;
      tx /= tLen; ty /= tLen; tz /= tLen;

      const [r, g, b] = ramp(tLine[i]); // hue comes from speed relative to freestream alone
      const fadeIn = Math.min(1, i / fadeInSteps);
      const coh = path.coherence[i];
      const effect = Math.pow(Math.min(1, Math.abs(tLine[i])), cfg.colorCurve); // 0 undisturbed .. 1 strongest slowing/speeding-up
      let alpha = fadeIn * coh * (cfg.alphaUndisturbed + (cfg.alphaMax - cfg.alphaUndisturbed) * effect);
      let envelope = 1;
      if (cfg.focus) {
        const u = clamp01((focusDistance(cfg.focus, cfg.focusFlowDir, cfg.focusAlongScale, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) - cfg.focusFade[0]) / (cfg.focusFade[1] - cfg.focusFade[0]));
        envelope = 1 - u * u * (3 - 2 * u);
        alpha *= envelope;
      }

      for (let k = 0; k < 2; k++) {
        const idx = vi + k;
        positions[idx * 3] = p[i * 3]; positions[idx * 3 + 1] = p[i * 3 + 1]; positions[idx * 3 + 2] = p[i * 3 + 2];
        tangents[idx * 3] = tx; tangents[idx * 3 + 1] = ty; tangents[idx * 3 + 2] = tz;
        sides[idx] = k === 0 ? 1 : -1;
        timeOfFlight[idx] = path.timeOfFlight[i];
        coherenceAtVertex[idx] = coh;
        if (envelopes) envelopes[idx] = fadeIn * envelope;
        groupIds[idx] = gid;
        lineRanks[idx] = rank;
        colors[idx * 4] = r; colors[idx * 4 + 1] = g; colors[idx * 4 + 2] = b; colors[idx * 4 + 3] = alpha;
      }
      vi += 2;

      if (i < n - 1) {
        const l0 = base + i * 2, r0 = l0 + 1, l1 = l0 + 2, r1 = l0 + 3;
        indices[ii++] = l0; indices[ii++] = r0; indices[ii++] = l1;
        indices[ii++] = r0; indices[ii++] = r1; indices[ii++] = l1;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('tangent', new THREE.BufferAttribute(tangents, 3));
  geometry.setAttribute('side', new THREE.BufferAttribute(sides, 1));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  geometry.setAttribute('timeOfFlight', new THREE.BufferAttribute(timeOfFlight, 1));
  geometry.setAttribute('coherence', new THREE.BufferAttribute(coherenceAtVertex, 1));
  if (envelopes) geometry.setAttribute('envelope', new THREE.BufferAttribute(envelopes, 1));
  geometry.setAttribute('groupId', new THREE.BufferAttribute(groupIds, 1));
  geometry.setAttribute('lineRank', new THREE.BufferAttribute(lineRanks, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  const uniforms = {
    resolution: { value: new THREE.Vector2(1, 1) },
    halfWidthPx: { value: 1 },
    time: { value: 0 },
    pulsePeriod: { value: cfg.pulsePeriod },
    pulseWidth: { value: cfg.pulseWidth },
    pulseAlpha: { value: cfg.pulseAlpha },
    glowMix: { value: cfg.glowMix },
    nearFade: { value: new THREE.Vector2(...cfg.nearFade) },
    groupOn: { value: new Array(MAX_STREAMLINE_GROUPS).fill(1) },
    density: { value: 1 },
  };
  let vertexShader = VERTEX_SHADER.replace(/MAX_GROUPS/g, String(MAX_STREAMLINE_GROUPS));
  if (envelopes) {
    // The pulse lifts a line toward pulseAlpha whatever its resting opacity, so outside the focus envelope (where
    // the resting opacity is zero) it would still flash as a row of streaks. Scale the pulse by the envelope too.
    vertexShader = vertexShader
      .replace('attribute float coherence;', 'attribute float coherence;\n  attribute float envelope;')
      .replace('a + (pulseAlpha - a) * pulse', 'a + (pulseAlpha * envelope - a) * pulse');
  }
  if (cfg.viewFade) {
    uniforms.viewFade = { value: new THREE.Vector2(...cfg.viewFade) };
    vertexShader = vertexShader
      .replace('uniform vec2 nearFade;', 'uniform vec2 nearFade;\n  uniform vec2 viewFade;')
      .replace('    vColor = vec4(', `    vec3 viewTangent = normalize((modelViewMatrix * vec4(tangent, 0.0)).xyz);
    vec3 viewRay = normalize((modelViewMatrix * vec4(position, 1.0)).xyz);
    near *= 1.0 - smoothstep(viewFade.x, viewFade.y, abs(dot(viewTangent, viewRay)));
    vColor = vec4(`);
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending, // overlapping lines keep their own hue
  });

  const object3D = new THREE.Mesh(geometry, material);
  object3D.name = 'Streamlines';
  object3D.frustumCulled = false;

  // Keep the screen-space width constant at any resolution / pixel ratio.
  const size = new THREE.Vector2();
  object3D.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(size);
    uniforms.resolution.value.copy(size);
    uniforms.halfWidthPx.value = (cfg.lineWidthPx * renderer.getPixelRatio()) / 2;
  };

  function update(elapsedSeconds) {
    uniforms.time.value = elapsedSeconds; // the pulse runs on the GPU; nothing is rewritten per frame
  }

  /** Show only the lines in these seeding groups (null = all of them). */
  function setVisibleGroups(names) {
    for (let i = 0; i < MAX_STREAMLINE_GROUPS; i++) uniforms.groupOn.value[i] = !names || names.includes(groupNames[i]) ? 1 : 0;
  }
  /** Fraction of the lines kept, 0..1. */
  function setDensity(fraction) { uniforms.density.value = fraction; }
  /** Fraction of a pulse period the bright band occupies, 0..1. */
  function setPulseWidth(fraction) { uniforms.pulseWidth.value = fraction; }

  return { object3D, update, setVisibleGroups, setDensity, setPulseWidth, groupNames, vertexCount, triangleCount: indexCount / 3 };
}
