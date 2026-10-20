#!/usr/bin/env node
// Prints every speed probe (tests/speedProbes.js) with its speed relative to the oncoming air.
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { loadSdfSync } from '../src/particles/sdf.js';
import { domainFromBounds } from '../src/particles/domain.js';
import { PARTICLE_CONFIG } from '../src/particles/config.js';
import { runSpeedProbes } from '../tests/speedProbes.js';
const h = JSON.parse(readFileSync('data/occupancy_grid.json', 'utf8'));
const fd = h.flowDomain;
const domain = domainFromBounds({ minX: fd.bboxMin[0], maxX: fd.bboxMax[0], minY: fd.bboxMin[1], maxY: fd.bboxMax[1], minZ: fd.bboxMin[2], maxZ: fd.bboxMax[2] }, fd.flowAxis, fd.flowSign, PARTICLE_CONFIG);
const sdf = loadSdfSync('data/', fs, PARTICLE_CONFIG.groundY);
const rakes = JSON.parse(readFileSync('data/rakes.json', 'utf8'));
for (const r of runSpeedProbes(domain, sdf, PARTICLE_CONFIG, rakes)) {
  const pt = r.point ? ` @(${r.point.x.toFixed(2)},${r.point.y.toFixed(2)},${r.point.z.toFixed(2)})` : '';
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(50)} ${r.expect.padEnd(8)} ${Number.isNaN(r.ratio) ? 'n/a' : r.ratio.toFixed(2)}${r.ahead ? ' vs ' + r.ahead.toFixed(2) : ''}${pt}`);
}
