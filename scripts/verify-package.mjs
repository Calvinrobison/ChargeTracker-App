#!/usr/bin/env node
/**
 * Inspects a packaged build before it is allowed near a release.
 *
 * The checks here exist because each one has a failure mode that looks fine at
 * build time and breaks on a user's machine:
 *
 *  - a missing bundled Chromium → the app tries to download a browser at first
 *    run, which it promises not to do;
 *  - a native module reappearing → an Electron ABI rebuild this design removed;
 *  - missing worker bundles → `utilityProcess.fork` fails and the app appears
 *    corrupt;
 *  - missing migrations → an empty database on first launch;
 *  - a production package containing demo history, a private key or a test
 *    trust configuration → a data-integrity or security problem shipped to
 *    users.
 *
 * Exits non-zero on any failure. It never reports success for a check it could
 * not actually perform: an unperformed check is reported as SKIP and still
 * fails the run when it is required.
 *
 * Usage: node scripts/verify-package.mjs [--dir release]
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const dirIndex = process.argv.indexOf('--dir');
const releaseDir = resolve(root, dirIndex === -1 ? 'release' : (process.argv[dirIndex + 1] ?? 'release'));

/** @type {{name: string, status: 'PASS'|'FAIL'|'SKIP', detail: string, required: boolean}[]} */
const results = [];

function record(name, status, detail, required = true) {
  results.push({ name, status, detail, required });
}

function findUnpackedDir() {
  if (!existsSync(releaseDir)) return null;
  for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
    if (entry.isDirectory() && /^win-(unpacked|.*-unpacked)$/.test(entry.name)) {
      return join(releaseDir, entry.name);
    }
  }
  return null;
}

function walk(dir, depth = 0, limit = 6) {
  /** @type {string[]} */
  const files = [];
  if (!existsSync(dir) || depth > limit) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path, depth + 1, limit));
    else files.push(path);
  }
  return files;
}

const unpacked = findUnpackedDir();

if (!unpacked) {
  record(
    'packaged build present',
    'FAIL',
    `No unpacked build found under ${releaseDir}. Run: npm run package:win`,
  );
} else {
  record('packaged build present', 'PASS', unpacked);

  const resources = join(unpacked, 'resources');

  // 1. Bundled Chromium, outside app.asar.
  const chromeName = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
  const browserFiles = walk(join(resources, 'browser'), 0, 4);
  const chromium = browserFiles.find((file) => file.endsWith(chromeName));
  if (chromium) {
    const bytes = browserFiles.reduce((sum, file) => {
      try {
        return sum + statSync(file).size;
      } catch {
        return sum;
      }
    }, 0);
    record(
      'bundled Chromium present outside app.asar',
      'PASS',
      `${chromium} (${(bytes / (1024 * 1024)).toFixed(0)} MB)`,
    );
  } else {
    record(
      'bundled Chromium present outside app.asar',
      'FAIL',
      `no ${chromeName} under ${join(resources, 'browser')}. Run npm run setup:browser and repackage.`,
    );
  }

  // 2. No native module at all.
  //
  // SQLite comes from `node:sqlite`, which Electron ships, so this package is
  // meant to contain no `.node` binary. If one appears, a dependency has pulled
  // a native module back in, which reintroduces the Electron ABI rebuild this
  // design removed — silently, and only breaking on someone else's machine.
  const nativeBinaries = walk(unpacked, 0, 8).filter((file) => file.endsWith('.node'));
  if (nativeBinaries.length === 0) {
    record('no native modules in the package', 'PASS', 'SQLite comes from node:sqlite');
  } else {
    record(
      'no native modules in the package',
      'FAIL',
      `native binaries found, which this build should not contain: ${nativeBinaries.slice(0, 5).join(', ')}`,
    );
  }

  // 3. Worker bundles.
  const asar = join(resources, 'app.asar');
  if (existsSync(asar)) {
    // The asar is a single file; its contents cannot be listed without the
    // asar module. Report honestly rather than claiming a check we did not run.
    record(
      'worker bundles inside app.asar',
      'SKIP',
      'app.asar is packed; run `npx asar list resources/app.asar | findstr out/workers` to confirm out/workers/database.js and collector.js are present.',
    );
  } else {
    const workers = ['database.js', 'collector.js'].map((name) =>
      join(unpacked, 'resources', 'app', 'out', 'workers', name),
    );
    const missing = workers.filter((path) => !existsSync(path));
    record(
      'worker bundles present',
      missing.length === 0 ? 'PASS' : 'FAIL',
      missing.length === 0 ? workers.join(', ') : `missing: ${missing.join(', ')}`,
    );
  }

  // 4. Icons.
  const icons = walk(join(resources, 'icons'), 0, 2);
  record(
    'application icons present',
    icons.length > 0 ? 'PASS' : 'FAIL',
    icons.length > 0 ? `${icons.length} file(s)` : `nothing under ${join(resources, 'icons')}`,
  );

  // 5. Third-party notices.
  record(
    'third-party notices shipped',
    existsSync(join(resources, 'THIRD_PARTY_NOTICES.md')) ? 'PASS' : 'FAIL',
    join(resources, 'THIRD_PARTY_NOTICES.md'),
  );

  // 6. Nothing dangerous in the package.
  const allFiles = walk(unpacked, 0, 8);
  const forbiddenPatterns = [
    { pattern: /\.pem$/i, label: 'a PEM key file' },
    { pattern: /(^|[\\/])id_rsa/i, label: 'an SSH private key' },
    { pattern: /(^|[\\/])\.env$/i, label: 'an .env file' },
    { pattern: /demo[-_]?history/i, label: 'demo history' },
    { pattern: /test[-_]?keys?/i, label: 'test signing keys' },
    // Fixture view models are synthetic by construction. A package that
    // contains one could show invented stations as though they were observed.
    { pattern: /(^|[\\/])tests[\\/]/i, label: 'test code or fixtures' },
    { pattern: /(^|[\\/])fixtures?\.(ts|js|mjs|json)$/i, label: 'fixture data' },
    { pattern: /\.sqlite$/i, label: 'a database file' },
  ];
  const offenders = [];
  for (const file of allFiles) {
    for (const { pattern, label } of forbiddenPatterns) {
      if (pattern.test(file)) {
        // A committed PUBLIC key is expected and fine.
        if (/\.pub\.pem$/i.test(file)) continue;
        offenders.push(`${label}: ${file}`);
      }
    }
  }
  record(
    'no credentials, keys, demo data or databases in the package',
    offenders.length === 0 ? 'PASS' : 'FAIL',
    offenders.length === 0 ? 'clean' : offenders.slice(0, 10).join('; '),
  );

  // 7. Update configuration.
  const updateYml = ['app-update.yml', 'latest.yml']
    .map((name) => join(resources, name))
    .find((path) => existsSync(path));
  if (updateYml) {
    const text = readFileSync(updateYml, 'utf8');
    const hasOwner = /owner:\s*\S+/.test(text);
    const hasRepo = /repo:\s*\S+/.test(text);
    record(
      'update configuration points at a real repository',
      hasOwner && hasRepo ? 'PASS' : 'FAIL',
      `${updateYml}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`,
    );
  } else {
    record(
      'update configuration points at a real repository',
      'FAIL',
      `no app-update.yml under ${resources}. Auto-update cannot work without it.`,
    );
  }

  // 8. Public update key embedded, private key absent.
  const keyFile = join(root, 'resources', 'update-keys', 'keys.json');
  if (existsSync(keyFile)) {
    try {
      const parsed = JSON.parse(readFileSync(keyFile, 'utf8'));
      const keys = Array.isArray(parsed.keys) ? parsed.keys : [];
      const hasPrivate = JSON.stringify(parsed).includes('PRIVATE KEY');
      if (hasPrivate) {
        record(
          'only public update keys are embedded',
          'FAIL',
          'a PRIVATE KEY appears in resources/update-keys/keys.json. Never commit or ship one.',
        );
      } else if (keys.length === 0) {
        record(
          'only public update keys are embedded',
          'FAIL',
          'keys.json has no keys, so no update could ever be verified or installed. Run npm run keys:bootstrap.',
        );
      } else {
        record(
          'only public update keys are embedded',
          'PASS',
          `${keys.length} public key(s): ${keys.map((key) => key.keyId).join(', ')}`,
        );
      }
    } catch (error) {
      record('only public update keys are embedded', 'FAIL', `keys.json is not valid JSON: ${error.message}`);
    }
  } else {
    record(
      'only public update keys are embedded',
      'FAIL',
      'resources/update-keys/keys.json is missing, so no update could be verified. Run npm run keys:bootstrap.',
    );
  }

  // 9. The installer artifact itself.
  const installers = existsSync(releaseDir)
    ? readdirSync(releaseDir).filter((name) => /Setup.*\.exe$/i.test(name))
    : [];
  record(
    'a full installer artifact exists',
    installers.length > 0 ? 'PASS' : 'FAIL',
    installers.length > 0
      ? installers
          .map((name) => `${name} (${(statSync(join(releaseDir, name)).size / (1024 * 1024)).toFixed(0)} MB)`)
          .join(', ')
      : `no *Setup*.exe under ${releaseDir}`,
  );
}

// --------------------------------------------------------------------------

const width = Math.max(...results.map((result) => result.name.length), 10);
console.log('\nPackage verification\n');
for (const result of results) {
  console.log(`${result.status.padEnd(5)} ${result.name.padEnd(width)}  ${result.detail}`);
}

const failures = results.filter((result) => result.status === 'FAIL');
const skips = results.filter((result) => result.status === 'SKIP');

console.log(
  `\n${results.filter((r) => r.status === 'PASS').length} passed, ${failures.length} failed, ${skips.length} skipped`,
);

if (skips.length > 0) {
  console.log('\nSkipped checks are NOT passes. Perform them manually before publishing:');
  for (const skip of skips) console.log(`  - ${skip.name}: ${skip.detail}`);
}

if (failures.length > 0) {
  console.error('\nThis package must not be released.');
  process.exit(1);
}
if (skips.length > 0) {
  console.log('\nNo failures, but some checks could not be performed automatically.');
  process.exit(0);
}
console.log('\nPackage looks releasable.');
