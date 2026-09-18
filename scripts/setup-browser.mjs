#!/usr/bin/env node
/**
 * Assembles the bundled Chromium into `.playwright-cache/chromium`.
 *
 * Why this exists rather than relying on `npx playwright install`: Playwright's
 * default install location is a per-user cache directory. That is fine for a
 * developer machine and useless for a packaged application, because the cache
 * does not exist on the user's PC. electron-builder copies THIS directory into
 * `resources/browser`, and `resolveBundledChromium` resolves it from
 * `process.resourcesPath` at runtime.
 *
 * The environment variable is set BEFORE importing Playwright, because
 * Playwright caches the browsers path at import time. Setting it afterwards is
 * a common and silent mistake.
 *
 * Usage:
 *   node scripts/setup-browser.mjs            # install into the local cache
 *   node scripts/setup-browser.mjs --verify   # only check what is present
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const cacheDir = join(root, '.playwright-cache');
const browserDir = join(cacheDir, 'chromium');

const verifyOnly = process.argv.includes('--verify');

function executableName() {
  return process.platform === 'win32' ? 'chrome.exe' : 'chrome';
}

/** Finds the Chromium executable anywhere under `dir`, up to a small depth. */
function findExecutable(dir, depth = 0) {
  if (!existsSync(dir) || depth > 4) return null;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (info.isFile() && entry === executableName()) return path;
    if (info.isDirectory()) {
      const found = findExecutable(path, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function directorySize(dir) {
  let total = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        try {
          total += statSync(path).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return total;
}

const existing = findExecutable(browserDir);

if (verifyOnly) {
  if (!existing) {
    console.error(
      `No bundled Chromium found under ${browserDir}.\n` +
        'Run: npm run setup:browser\n' +
        'The installer cannot be built without it, and the packaged app must not download a browser at first run.',
    );
    process.exit(1);
  }
  const bytes = directorySize(browserDir);
  console.log(`Bundled Chromium present: ${existing}`);
  console.log(`Payload size: ${(bytes / (1024 * 1024)).toFixed(0)} MB`);
  process.exit(0);
}

if (existing) {
  console.log(`Bundled Chromium already present at ${existing}. Nothing to do.`);
  console.log('Delete .playwright-cache to force a reinstall.');
  process.exit(0);
}

mkdirSync(browserDir, { recursive: true });

console.log(`Installing Chromium into ${browserDir}`);
console.log('This downloads roughly 150-200 MB and is required for the installer.\n');

// PLAYWRIGHT_BROWSERS_PATH must be set for the child process, not just this
// one, and Playwright reads it when its module is first loaded.
const result = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'playwright-core', 'cli.js'), 'install', 'chromium'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserDir },
  },
);

if (result.status !== 0) {
  console.error(
    '\nChromium could not be installed.\n' +
      "If this machine has no route to Playwright's CDN, copy a working .playwright-cache/chromium\n" +
      'directory from a machine that does. Do NOT ship an installer without it: the app would try to\n' +
      'download a browser at first run, which it promises not to do.',
  );
  process.exit(result.status ?? 1);
}

const installed = findExecutable(browserDir);
if (!installed) {
  console.error(
    `Chromium reported success but no ${executableName()} was found under ${browserDir}. Not usable.`,
  );
  process.exit(1);
}

pruneUnusedPayload();

console.log(`\nBundled Chromium ready: ${installed}`);
console.log(`Payload size: ${(directorySize(browserDir) / (1024 * 1024)).toFixed(0)} MB`);

/**
 * Removes the parts of Playwright's download that ChargeWatch never executes.
 *
 * `playwright install chromium` fetches everything a general Playwright user
 * might want. ChargeWatch launches with an explicit `executablePath` pointing
 * at chrome.exe (see src/collector/browser.ts), so Playwright never chooses a
 * binary for itself and the rest is dead weight in a 300 MB installer:
 *
 *   chromium_headless_shell   ~115 MB  only used when Playwright picks the
 *                                      binary itself for headless launches
 *   ffmpeg                    ~1.3 MB  video recording, which is never enabled
 *   winldd                    ~0.1 MB  a dependency-inspection tool for
 *                                      diagnosing missing DLLs, not a runtime
 *                                      component
 *
 * Every byte here ends up inside the installer and on every user's disk, and a
 * smaller installer is also less to go wrong during extraction.
 *
 * This prunes only directories it can identify by name, and it runs AFTER the
 * executable has been confirmed present, so a naming change upstream leaves a
 * slightly larger payload rather than a broken one.
 */
function pruneUnusedPayload() {
  const UNUSED_PREFIXES = ['chromium_headless_shell', 'ffmpeg', 'winldd'];
  let freedBytes = 0;

  for (const entry of readdirSync(browserDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!UNUSED_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;

    const path = join(browserDir, entry.name);
    // Never remove the directory the resolved executable lives in, whatever
    // it is called.
    if (installed.startsWith(path)) continue;

    const size = directorySize(path);
    rmSync(path, { recursive: true, force: true });
    freedBytes += size;
    console.log(
      `  removed ${entry.name} (${(size / (1024 * 1024)).toFixed(0)} MB, never executed)`,
    );
  }

  if (freedBytes > 0) {
    console.log(
      `  ${(freedBytes / (1024 * 1024)).toFixed(0)} MB trimmed from the installer payload`,
    );
  }
}
