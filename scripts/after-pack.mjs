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

  // 2. Native SQLite, unpacked from the asar.
  const unpackedRoot = join(resources, 'app.asar.unpacked');
  const nativeModule = existsSync(unpackedRoot)
    ? findFile(unpackedRoot, 'better_sqlite3.node', 0)
    : null;
  if (!nativeModule) {
    problems.push(
      `better_sqlite3.node was not found under ${unpackedRoot}.\n` +
        '    A native module cannot be loaded from inside app.asar. Check "asarUnpack" in\n' +
        '    electron-builder.yml, and that "electron-builder install-app-deps" ran.',
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
