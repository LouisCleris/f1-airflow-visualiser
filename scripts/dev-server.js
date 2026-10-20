#!/usr/bin/env node
// Zero-dependency static dev server. Serves the project root so that
// src/index.html can load src/main.js as a real ES module (via the
// importmap in src/index.html), models/*.glb, and node_modules/three
// directly — no bundling needed during development. The production build
// (scripts/build.js) is what produces the single inlined dist/index.html.
//
// The page must be served at the ROOT URL (not /src/...) because its app code fetches models/*.glb and
// data/*.json with paths relative to the page's own URL.
//
// Usage: node scripts/dev-server.js [port]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

function contentTypeFor(path) {
  return MIME[extname(path).toLowerCase()] || 'application/octet-stream';
}

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const relPath = urlPath === '/' ? '/src/index.html' : urlPath;
    const filePath = normalize(join(ROOT, relPath));

    // Prevent path traversal outside the project root.
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const st = await stat(filePath).catch(() => null);
    if (!st || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Not found: ${relPath}`);
      return;
    }

    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
    res.end(data);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Server error: ${err.message}`);
  }
});

// Listens on every interface, so another computer on the same network can reach it too.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[dev-server] serving ${ROOT}`);
  console.log(`[dev-server] this computer:  http://localhost:${PORT}/  (entry: src/index.html)`);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`[dev-server] open from another computer on this network:  http://${a.address}:${PORT}/`);
    }
  }
});
