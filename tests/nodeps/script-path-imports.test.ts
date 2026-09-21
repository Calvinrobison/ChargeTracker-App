/**
 * A filesystem path is not a URL, and `import()` takes a URL.
 *
 * `scripts/release-verify.mjs` did `await import(join(root, ...))`. On POSIX
 * that string looks like an absolute path and the loader accepts it. On
 * Windows it is `C:\Users\...`, which the ESM loader parses as a URL with the
 * scheme `c:` and refuses:
 *
 *     ERR_UNSUPPORTED_ESM_URL_SCHEME: Only URLs with a scheme in: file, data,
 *     and node are supported. Received protocol 'c:'
 *
 * So `release:verify` crashed on the only platform this application ships on,
 * and `release:publish` runs verification first, so the publish gate could
 * never pass there either. It failed closed — nothing was published wrongly —
 * but the release path was unusable rather than strict.
 *
 * This is the third bug of exactly this shape in this project: `appOrigins`
 * built `file://` + a Windows path, the browser resolver assumed a POSIX-ish
 * layout, and now this. All three were invisible on Linux, and all three sat
 * under passing specs.
 *
 * So this spec is not about one call site. It reads every build and release
 * script and fails if any of them hands a bare path to `import()`.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = join(repoRoot, 'scripts');

function scriptFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...scriptFiles(full));
    } else if (entry.endsWith('.mjs') || entry.endsWith('.js')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * `import(` followed by something that is not a quoted specifier and not
 * already wrapped in pathToFileURL.
 *
 * A bare quoted string — import('node:crypto'), import('electron-updater') —
 * is a package specifier and always fine. What this looks for is a computed
 * argument: a call, a variable or a template, which in these scripts always
 * means a path built with join/resolve.
 */
const COMPUTED_IMPORT = /\bimport\(\s*(?!['"`])([^)]*)\)/g;

describe('no build script hands a filesystem path to import()', () => {
  const files = scriptFiles(scriptsDir);

  it('finds scripts to check, so a rename cannot make this vacuous', () => {
    assert.ok(files.length > 5, `only ${files.length} scripts found under scripts/`);
  });

  for (const file of files) {
    const relative = file.slice(repoRoot.length + 1).replace(/\\/g, '/');

    it(`${relative} converts any computed import to a file URL`, () => {
      const source = readFileSync(file, 'utf8');
      const offenders: string[] = [];

      for (const match of source.matchAll(COMPUTED_IMPORT)) {
        const argument = (match[1] ?? '').trim();
        if (argument === '') continue;
        if (argument.includes('pathToFileURL')) continue;
        // import.meta.resolve already yields a URL string.
        if (argument.includes('import.meta.resolve')) continue;
        offenders.push(argument);
      }

      assert.deepEqual(
        offenders,
        [],
        `${relative} imports a computed specifier without pathToFileURL. On Windows an ` +
          'absolute path is parsed as a URL scheme and the import throws ' +
          'ERR_UNSUPPORTED_ESM_URL_SCHEME.',
      );
    });
  }
});

describe('the conversion this depends on behaves as assumed', () => {
  it('produces a file: URL that import() would accept', () => {
    const url = pathToFileURL(join(repoRoot, 'package.json'));
    assert.equal(url.protocol, 'file:');
    assert.ok(url.href.startsWith('file:///'), `expected three slashes, got ${url.href}`);
  });

  it('is what actually loads the module release-verify needs', async () => {
    // The real import, by the real path, through the real conversion. If this
    // throws, release:verify is broken on this platform.
    const module = await import(
      pathToFileURL(join(repoRoot, 'src', 'shared', 'release-manifest.ts')).href
    );
    for (const name of [
      'verifyArtifactBytes',
      'verifyManifest',
      'isDirectUpgradePermitted',
      'UPDATE_PROTOCOL_VERSION',
    ]) {
      assert.ok(name in module, `release-verify.mjs destructures ${name} and it is missing`);
    }
  });
});
