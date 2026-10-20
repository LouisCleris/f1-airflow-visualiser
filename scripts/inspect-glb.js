#!/usr/bin/env node
// Read-only GLB inspector. Parses the binary header and the embedded glTF
// JSON chunk directly (no dependencies) to list node/mesh names and rough
// face counts, without ever loading the file into a scene graph (which would
// merge geometry and lose names). Never writes to the file it inspects.
//
// Usage: node scripts/inspect-glb.js <file.glb> [<file2.glb> ...]

import { readFileSync } from 'node:fs';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

export function inspectGLB(path) {
  const buf = readFileSync(path);
  const magic = buf.readUInt32LE(0);
  if (magic !== GLB_MAGIC) {
    throw new Error(`${path}: not a valid GLB (bad magic bytes)`);
  }
  const version = buf.readUInt32LE(4);
  const length = buf.readUInt32LE(8);

  let offset = 12;
  let json = null;
  let binByteLength = 0;
  while (offset < length) {
    const chunkLength = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const chunkData = buf.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === CHUNK_JSON) {
      json = JSON.parse(chunkData.toString('utf8'));
    } else if (chunkType === CHUNK_BIN) {
      binByteLength = chunkLength;
    }
    offset += 8 + chunkLength;
  }
  if (!json) throw new Error(`${path}: no JSON chunk found`);

  const nodes = json.nodes || [];
  const meshes = json.meshes || [];
  const meshNodes = nodes.filter((n) => n.mesh !== undefined);
  const nodeNames = nodes.map((n) => n.name || '(unnamed)');
  const meshNodeNames = meshNodes.map((n) => n.name || '(unnamed)');
  const meshDataNames = meshes.map((m) => m.name || '(unnamed)');

  let totalFaces = 0;
  for (const mesh of meshes) {
    for (const prim of mesh.primitives || []) {
      if (prim.indices !== undefined) {
        totalFaces += Math.floor(json.accessors[prim.indices].count / 3);
      } else if (prim.attributes && prim.attributes.POSITION !== undefined) {
        totalFaces += Math.floor(json.accessors[prim.attributes.POSITION].count / 3);
      }
    }
  }

  return {
    path,
    fileBytes: buf.length,
    glTFVersion: version,
    generator: json.asset && json.asset.generator,
    nodeCount: nodes.length,
    meshNodeCount: meshNodes.length,
    meshCount: meshes.length,
    nodeNames,
    meshNodeNames,
    meshDataNames,
    totalFacesApprox: totalFaces,
    binByteLength,
  };
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: node scripts/inspect-glb.js <file.glb> [<file2.glb> ...]');
    process.exit(1);
  }
  for (const f of files) {
    const r = inspectGLB(f);
    console.log('='.repeat(70));
    console.log(r.path);
    console.log('='.repeat(70));
    console.log(`file size:              ${r.fileBytes.toLocaleString()} bytes`);
    console.log(`glTF version:           ${r.glTFVersion}`);
    console.log(`generator:              ${r.generator}`);
    console.log(`node count:             ${r.nodeCount}`);
    console.log(`nodes with mesh (components): ${r.meshNodeCount}`);
    console.log(`total faces (approx):   ${r.totalFacesApprox.toLocaleString()}`);
    console.log(`\ncomponent (node) names:`);
    r.nodeNames.forEach((n, i) => console.log(`  [${i}] ${n}`));
    console.log();
  }
}

// Only run the CLI when this file is executed directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
