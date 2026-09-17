#!/usr/bin/env node
/**
 * Builds the two utility-process workers into out/workers/.
 *
 * electron-vite's `main`/`preload`/`renderer` configs do not cover extra Node
 * entry points, and `utilityProcess.fork` needs a real file on disk. Without
 * this step the packaged app starts, finds no worker, and fails at runtime with
 * a message that looks like a corrupt install.
 *
 * Native and binary-backed modules stay external for the same reason they do in
 * electron.vite.config.ts: bundling them yields a build that breaks at runtime
 * instead of at build time.
 *
 * Usage: node scripts/build-workers.mjs [--watch]
 */

import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const EXTERNAL = [
  'playwright-core',
  'playwright',
  'electron',
  'electron-updater',
  /^node:/,
];

const ENTRIES = [
  { name: 'database', input: resolve(root, 'src/workers/database.ts') },
  { name: 'collector', input: resolve(root, 'src/workers/collector.ts') },
];

const watch = process.argv.includes('--watch');

for (const entry of ENTRIES) {
  if (!existsSync(entry.input)) {
    console.error(`Worker entry missing: ${entry.input}`);
    process.exit(1);
  }
}

for (const entry of ENTRIES) {
  await build({
    root,
    configFile: false,
    logLevel: 'info',
    build: {
      outDir: 'out/workers',
      emptyOutDir: entry.name === ENTRIES[0].name,
      sourcemap: true,
      target: 'node22',
      ssr: true,
      minify: false,
      ...(watch ? { watch: {} } : {}),
      lib: {
        entry: entry.input,
        formats: ['cjs'],
        fileName: () => `${entry.name}.js`,
      },
      rollupOptions: {
        external: EXTERNAL,
        output: { inlineDynamicImports: true },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(root, 'src/shared'),
        '@domain': resolve(root, 'src/domain'),
      },
    },
  });
  console.log(`Built out/workers/${entry.name}.js`);
}

console.log(
  'Worker bundles written. scripts/verify-package.mjs checks that the packaged build can actually load them.',
);
