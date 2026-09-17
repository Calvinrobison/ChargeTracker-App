/**
 * electron-builder afterPack hook.
 *
 * Fails the build rather than producing a package that is missing its browser
 * or its native SQLite module. Both of those produce an installer that looks
 * fine and breaks on the user's machine, which is the failure this hook exists
 * to prevent.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** @param {{appOutDir: string, electronPlatformName: string}} context */
export default async function afterPack(context) {
  const resources = join(context.appOutDir, 'resources');
  const problems = [];

  // 1. The bundled browser, outside app.asar.
  const executable = context.electronPlatformName === 'win32' ? 'chrome.exe' : 'chrome';
  const browserRoot = join(resources, 'browser');
  const found = existsSync(browserRoot) ? findFile(browserRoot, executable, 0) : null;
  if (!found) {
    problems.push(
      `The bundled browser is missing: no ${executable} under ${browserRoot}.\n` +
        '    Run "npm run setup:browser" and package again. The app must not download a\n' +
        '    browser at first run.',
    );
  }

  // 2. No stray native module.
  //
  // SQLite comes from `node:sqlite`, which Electron ships. If a `.node` binary
  // has appeared in the package, some dependency has pulled a native module
  // back in — which would reintroduce the ABI rebuild this design removed, and
  // would do it silently.
  const unpackedRoot = join(resources, 'app.asar.unpacked');
  const strayNative = existsSync(unpackedRoot) ? findFileBySuffix(unpackedRoot, '.node', 0) : null;
  if (strayNative) {
    problems.push(
      `A native module appeared in the package: ${strayNative}\n` +
        '    ChargeWatch uses node:sqlite and is meant to have no native dependency.\n' +
        '    Find what pulled this in before shipping it.',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `\nThis package is not usable:\n\n  - ${problems.join('\n\n  - ')}\n\nThe build has been stopped.\n`,
    );
  }

  const bytes = existsSync(browserRoot) ? directorySize(browserRoot) : 0;
  console.log(
    `  • afterPack: bundled browser present (${(bytes / (1024 * 1024)).toFixed(0)} MB), native SQLite unpacked`,
  );
}

function findFile(dir, name, depth) {
  if (depth > 6 || !existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = findFile(path, name, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** `findFile` matches an exact name; this matches an extension. */
function findFileBySuffix(dir, suffix, depth) {
  if (depth > 8 || !existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(suffix)) return path;
    if (entry.isDirectory()) {
      const found = findFileBySuffix(path, suffix, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function directorySize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(path);
    else {
      try {
        total += statSync(path).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}
