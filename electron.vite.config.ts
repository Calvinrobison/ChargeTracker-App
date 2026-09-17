/**
 * Build configuration for the three bundles plus the two worker entries.
 *
 * Two things here exist for packaging correctness rather than convenience:
 *
 * 1. The workers are built as SEPARATE entry points into `out/workers/`, so
 *    `utilityProcess.fork` has a real file to run inside app.asar. A worker
 *    bundled into the main chunk cannot be forked.
 *
 * 2. `playwright-core` is EXTERNAL. It depends on a browser binary on disk;
 *    bundling it produces a build that fails at runtime rather than at build
 *    time, which is the worse failure.
 *
 *    SQLite is NOT in this list, because there is no SQLite dependency: the
 *    application uses `node:sqlite`, which Electron already ships. There is no
 *    native module to rebuild for the Electron ABI and nothing to unpack from
 *    the asar.
 */

import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const NATIVE_OR_BINARY_DEPS = ['playwright-core', 'playwright', 'electron-updater'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      sourcemap: true,
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        external: NATIVE_OR_BINARY_DEPS,
      },
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@domain': resolve('src/domain'),
      },
    },
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      sourcemap: true,
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // The preload runs in a sandboxed context; it must be a single file
        // with no dynamic imports.
        output: { format: 'cjs', inlineDynamicImports: true },
      },
    },
  },

  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      sourcemap: true,
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
      // Everything the renderer needs is bundled: no CDN for code or fonts.
      assetsInlineLimit: 8192,
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@domain': resolve('src/domain'),
        '@renderer': resolve('src/renderer/src'),
      },
    },
  },
});

/**
 * The worker bundles are built by a second pass, because electron-vite's three
 * named configs do not cover extra Node entry points. See
 * `scripts/build-workers.mjs`, which `npm run build` runs after this config.
 */
export const WORKER_ENTRIES = {
  database: resolve('src/workers/database.ts'),
  collector: resolve('src/workers/collector.ts'),
} as const;

export { NATIVE_OR_BINARY_DEPS };
