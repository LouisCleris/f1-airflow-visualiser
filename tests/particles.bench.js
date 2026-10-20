// Frame-time benchmark for tests/checks.js assertion 2 ("frame time stays
// under 16ms at maximum particle density").
//
// WHAT THIS DOES AND DOES NOT MEASURE (read before trusting the number):
// This project has no headless-GL renderer installed (Phase 1 used
// puppeteer only temporarily, for screenshots, and explicitly uninstalled
// it afterwards -- see PROGRESS.md -- so tests/checks.js does not depend on
// a browser/GPU being present). There is therefore no way to measure an
// *actual* WebGL frame time (rasterisation, shader execution, compositing,
// vsync) from this Node script. What IS measured, honestly and in full, is
// every piece of CPU-side work the app performs once per animation frame at
// maximum particle density, run for real (not simulated/estimated):
//   1. src/particles/particleSystem.js `update(dt)` -- the actual physics
//      step: advance every active particle, test it against the domain,
//      recycle it if needed, record a new trail-history point.
//   2. src/particles/trailBuffers.js `fillTrailBuffers()` -- the actual
//      per-frame flattening of every particle's ring-buffer trail into the
//      linear vertex/colour arrays a THREE.LineSegments geometry consumes
//      (this is exactly what trailRenderer.js's `sync()` calls; the only
//      thing trailRenderer.js adds on top is marking the three.js
//      BufferAttributes dirty and setting the draw range, both O(1)).
// NOT measured: the actual GPU draw call, vertex/fragment shader execution,
// texture/compositing work, or browser event-loop/rAF scheduling overhead.
// Those require a real (or headless) GPU context, which is not part of this
// project's toolchain. The two steps above are the entire CPU-side per-frame
// cost this app does; three.js's own WebGLRenderer.render() call is the only
// unmeasured remainder, and it operates on data these two steps already
// finished preparing, not on anything this benchmark would need to redo.
//
// Method: run both steps for a fixed number of warm-up frames (let any JIT
// warm-up settle) then for N timed frames at config.maxCount active
// particles, using Node's high-resolution timer. Assert the mean AND the
// worst single frame stay comfortably under the 16ms budget (a generous
// margin is used, not a 15.99ms near-miss, specifically because real GPU
// work still has to fit in the same 16ms alongside this CPU work on a real
// device).

import { PARTICLE_CONFIG } from '../src/particles/config.js';
import { yawWakeDomain } from '../src/particles/cornering.js';
import { createParticleSystem } from '../src/particles/particleSystem.js';
import { createTrailBuffers, fillTrailBuffers } from '../src/particles/trailBuffers.js';

// A synthetic domain standing in for domain.js's output (domain.js itself
// needs a live three.js car Object3D, which requires a browser/GLTFLoader
// environment this Node script does not have -- see PROGRESS.md). The
// numbers below are representative of the real F1 domain (car roughly
// 5-6 world units long, spawn/travel margins from config.js) so the
// particle counts crossing the recycle boundary per frame -- the only
// branch-heavy part of update() -- are realistic, not artificially cheap.
function benchDomain() {
  return {
    dirX: 0, dirY: 0, dirZ: 1,
    rightX: 1, rightY: 0, rightZ: 0,
    upX: 0, upY: 1, upZ: 0,
    originX: 0, originY: 0, originZ: 0,
    spawnDistance: 4.5,
    travelDistance: 12,
    halfWidth: 2.5,
    halfHeight: 3.2,
  };
}

/**
 * @param {{ maxCount?: number, frames?: number, warmupFrames?: number }} [opts]
 */
export function runParticleBenchmark(opts = {}) {
  const maxCount = opts.maxCount ?? PARTICLE_CONFIG.maxCount;
  const frames = opts.frames ?? 180;
  const warmupFrames = opts.warmupFrames ?? 30;

  const config = { ...PARTICLE_CONFIG, maxCount, count: maxCount };
  const domain = opts.yawDeg ? yawWakeDomain(benchDomain(), opts.yawDeg) : benchDomain(); // cornering: yawed release
  const system = createParticleSystem(domain, config);
  system.setActiveCount(maxCount);

  const trailBuffers = createTrailBuffers(config.maxCount, config.trailLength, config.color);
  const appearance = { minAlpha: config.minAlpha, maxAlpha: config.maxAlpha };

  const dt = 1 / 60;

  function frameStep() {
    system.update(dt);
    fillTrailBuffers(system, trailBuffers, appearance);
  }

  for (let i = 0; i < warmupFrames; i++) frameStep();

  const samples = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const t0 = process.hrtime.bigint();
    frameStep();
    const t1 = process.hrtime.bigint();
    samples[i] = Number(t1 - t0) / 1e6; // ms
  }

  let sum = 0, max = 0;
  for (const s of samples) { sum += s; if (s > max) max = s; }
  const mean = sum / samples.length;

  const sorted = Array.from(samples).sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)];

  return { maxCount, frames, meanMs: mean, p95Ms: p95, maxMs: max };
}
