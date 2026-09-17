#!/usr/bin/env node
/**
 * A static file server for the BUILT renderer, used only by the UI tests.
 *
 * Deliberately dependency-free and deliberately not a dev server: the UI tests
 * should exercise the same bundle that ships, not a hot-reloading variant of
 * it. It binds to loopback only and serves a single directory.
 *
 * Usage: node tests/ui/serve.mjs [--dir out/renderer] [--port 4173]
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const rootDir = resolve(arg('dir', 'out/renderer'));
const port = Number(arg('port', '4173'));

if (!existsSync(join(rootDir, 'index.html'))) {
  console.error(
    `No index.html under ${rootDir}. Build the renderer first:\n\n    npm run build\n\n` +
      'The UI tests run against the built bundle on purpose, so there is nothing to serve until it exists.',
  );
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  // Normalise, then confirm the result is still inside the served directory.
  // A path-traversal request must not be able to read the repository.
  const requested = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const candidate = resolve(rootDir, requested === '' ? 'index.html' : requested);

  if (candidate !== rootDir && !candidate.startsWith(rootDir + sep)) {
    response.writeHead(403).end('forbidden');
    return;
  }

  let filePath = candidate;
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html');
  }
  if (!existsSync(filePath)) {
    // The renderer is a single page; an unknown path is a route, not a 404.
    filePath = join(rootDir, 'index.html');
  }

  response.writeHead(200, {
    'content-type': TYPES[extname(filePath)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${rootDir} at http://127.0.0.1:${port}`);
});
