#!/usr/bin/env node
// One-off (re-runnable) generator for the Phase 0 test fixtures:
//   tests/fixtures/expected-components.json  — component names read from the
//     actual source GLBs, used by tests/checks.js assertion 1.
//   tests/fixtures/model-checksums.json      — sha256 of the actual source
//     GLBs at the time they were captured, used by tests/models_untouched.js.
//
// Only ever READS models/*.glb. Run again deliberately (e.g. if the author
// intentionally replaces a source model) to re-baseline both fixtures.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectGLB } from './inspect-glb.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const MODELS = {
  f1: join(ROOT, 'models', 'F1 model.glb'),
  falcon: join(ROOT, 'models', 'Falcon 6X 1 .glb'),
};

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const expectedComponents = {};
const checksums = {};

for (const [key, path] of Object.entries(MODELS)) {
  const info = inspectGLB(path);
  expectedComponents[key] = {
    file: path.slice(ROOT.length + 1),
    componentCount: info.meshNodeCount,
    componentNames: info.nodeNames,
  };
  checksums[key] = {
    file: path.slice(ROOT.length + 1),
    sha256: sha256(path),
    bytes: info.fileBytes,
  };
}

writeFileSync(
  join(ROOT, 'tests', 'fixtures', 'expected-components.json'),
  JSON.stringify(expectedComponents, null, 2) + '\n'
);
writeFileSync(
  join(ROOT, 'tests', 'fixtures', 'model-checksums.json'),
  JSON.stringify(checksums, null, 2) + '\n'
);

console.log('[generate-fixtures] wrote tests/fixtures/expected-components.json');
console.log('[generate-fixtures] wrote tests/fixtures/model-checksums.json');
