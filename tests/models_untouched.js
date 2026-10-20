#!/usr/bin/env node
// Checksum guard for the two source GLBs. Fails loudly (non-zero exit,
// clear message) if either model has changed on disk since the Phase 0
// baseline in tests/fixtures/model-checksums.json. Run this at the end of
// every phase per CLAUDE.md's working rhythm.
//
// This only reads the model files — it never writes to them.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function main() {
  const fixturePath = join(ROOT, 'tests', 'fixtures', 'model-checksums.json');
  if (!existsSync(fixturePath)) {
    console.error(
      'FAIL: tests/fixtures/model-checksums.json is missing. Run ' +
      '`node scripts/generate-fixtures.js` once against the known-good ' +
      'source models to create the baseline.'
    );
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(fixturePath, 'utf8'));

  let ok = true;
  for (const [key, entry] of Object.entries(baseline)) {
    const fullPath = join(ROOT, entry.file);
    if (!existsSync(fullPath) && key === 'falcon') {
      console.log(`SKIP [${key}]: ${entry.file} is not present (not shipped in the public copy; needed from Phase 6)`);
      continue;
    }
    if (!existsSync(fullPath)) {
      console.error(`FAIL [${key}]: expected source model missing: ${entry.file}`);
      ok = false;
      continue;
    }
    const bytes = readFileSync(fullPath).length;
    const hash = sha256(fullPath);
    if (hash !== entry.sha256 || bytes !== entry.bytes) {
      console.error(
        `FAIL [${key}]: ${entry.file} has CHANGED since the Phase 0 baseline.\n` +
        `  expected sha256: ${entry.sha256} (${entry.bytes} bytes)\n` +
        `  actual   sha256: ${hash} (${bytes} bytes)\n` +
        `  Source models must never be modified, decimated, re-exported or moved. ` +
        `See CLAUDE.md "Never".`
      );
      ok = false;
    } else {
      console.log(`OK   [${key}]: ${entry.file} unchanged (sha256 ${hash.slice(0, 12)}..., ${bytes.toLocaleString()} bytes)`);
    }
  }

  if (!ok) {
    console.error('\nmodels_untouched: FAILED — see above.');
    process.exit(1);
  }
  console.log('\nmodels_untouched: all source models unchanged. PASS.');
}

main();
