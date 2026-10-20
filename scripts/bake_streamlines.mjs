#!/usr/bin/env node
// Traces the streamlines once, offline, and saves them to data/streamlines_full.*. The page loads these instead of
// tracing ~400 lines through the flow field on every visit. Re-run after changing data/rakes.json or anything in
// src/particles/ (npm run build does it).
//
// Usage: node scripts/bake_streamlines.mjs [f1|falcon] [--cornering]
//   (default f1; the Falcon reads/writes data/falcon/. --cornering bakes the F1's cornering set,
//   data/streamlines_corner_*, from the same rakes and distance field with src/particles/cornering.js applied.)
// BAKE_SEED=<n> makes the random seeding and wake jitter repeatable (used to prove a code change left a scene's lines identical).

import { readFileSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSdfSync } from '../src/particles/sdf.js';
import { domainFromBounds } from '../src/particles/domain.js';
import { buildAllStreamlines, simplifyPath } from '../src/particles/streamlines.js';
import { PARTICLE_CONFIG, FALCON_PARTICLE_OVERRIDES } from '../src/particles/config.js';
import { SCENE_CONFIGS } from '../src/sceneConfig.js';
import { encodeStreamlines } from '../src/particles/bakedStreamlines.js';
import { corneringRakes } from '../src/particles/cornering.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FULL_TOLERANCE = 0.0006; // world units: dropped points are indistinguishable from the line (under a tenth of a pixel at the closest camera)

const scene = process.argv[2] === 'falcon' ? 'falcon' : 'f1';
const cornering = scene === 'f1' && process.argv.includes('--cornering');
const outRoot = process.env.BAKE_OUT_ROOT || ROOT; // tests may redirect the output
if (process.env.BAKE_SEED) {
  let a = Number(process.env.BAKE_SEED) >>> 0; // mulberry32
  Math.random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const dataDir = scene === 'falcon' ? 'data/falcon' : 'data';
const header = JSON.parse(readFileSync(join(ROOT, scene === 'falcon' ? 'data/falcon/domain.json' : 'data/occupancy_grid.json'), 'utf8'));
const fd = scene === 'falcon' ? header : header.flowDomain;
const sceneCfg = SCENE_CONFIGS[scene];
const particleConfig = { ...PARTICLE_CONFIG, ...(scene === 'falcon' ? FALCON_PARTICLE_OVERRIDES : {}) };
const domain = domainFromBounds(
  { minX: fd.bboxMin[0], maxX: fd.bboxMax[0], minY: fd.bboxMin[1], maxY: fd.bboxMax[1], minZ: fd.bboxMin[2], maxZ: fd.bboxMax[2] },
  fd.flowAxis, fd.flowSign, particleConfig
);
const sdf = loadSdfSync(join(ROOT, dataDir) + '/', fs, sceneCfg.groundY);
const baseRakes = JSON.parse(readFileSync(join(ROOT, dataDir, 'rakes.json'), 'utf8'));
const rakes = cornering ? corneringRakes(baseRakes, domain) : baseRakes;
const prefix = cornering ? 'streamlines_corner' : 'streamlines';

function bake(name, config, tolerance) {
  const t0 = Date.now();
  const { paths } = buildAllStreamlines(domain, sdf, particleConfig, config);
  const kept = paths.map((p) => simplifyPath(p, tolerance));
  const { json, buffer } = encodeStreamlines(kept);
  writeFileSync(join(outRoot, `${dataDir}/${name}.json`), JSON.stringify(json));
  writeFileSync(join(outRoot, `${dataDir}/${name}.bin`), Buffer.from(buffer));
  console.log(`[bake_streamlines] ${name}: ${kept.length} lines, ${json.total.toLocaleString()} points, ${(buffer.byteLength / 1048576).toFixed(2)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

bake(`${prefix}_full`, rakes, FULL_TOLERANCE);
