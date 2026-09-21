/**
 * The four places that name the repository releases come from must agree.
 *
 * `release-publish.mjs` defaulted its publish target to a fork while
 * `electron-builder.yml`, the generated `app-update.yml` and
 * `BRANDING.releaseOwner` all named `Calvinrobison`. So 0.2.0 was published
 * where no installed copy would ever look, and the updater reported
 * "Found version 0.1.0" — the application checking one repository while the
 * releases sat in another. Nothing failed; it just quietly did not work, which
 * is the hardest kind of wrong to notice.
 *
 * These are read as text rather than imported: `src/main/index.ts` imports
 * Electron and cannot be loaded by the dependency-free runner, and that is
 * exactly the reason its constants have gone unchecked before. A regular
 * expression over the file is a poor instrument, but an unchecked constant is
 * a worse one.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), 'utf8');

function capture(source: string, pattern: RegExp, label: string): string {
  const found = pattern.exec(source);
  assert.ok(found, `${label} could not be located; this spec needs updating, not deleting`);
  return (found[1] ?? '').trim();
}

describe('every declaration of the release repository agrees', () => {
  const builderYml = read('electron-builder.yml');
  const mainIndex = read('src', 'main', 'index.ts');
  const publishScript = read('scripts', 'release-publish.mjs');

  const builderOwner = capture(builderYml, /^\s*owner:\s*(\S+)\s*$/m, 'publish.owner');
  const builderRepo = capture(builderYml, /^\s*repo:\s*(\S+)\s*$/m, 'publish.repo');
  const brandingOwner = capture(mainIndex, /releaseOwner:\s*'([^']+)'/, 'BRANDING.releaseOwner');
  const brandingRepo = capture(mainIndex, /releaseRepo:\s*'([^']+)'/, 'BRANDING.releaseRepo');
  const publishDefault = capture(
    publishScript,
    /arg\('repo',\s*'([^']+)'\)/,
    "release-publish.mjs --repo default",
  );

  it('electron-builder and the application name the same repository', () => {
    assert.equal(
      `${builderOwner}/${builderRepo}`,
      `${brandingOwner}/${brandingRepo}`,
      'the installer publishes to one repository and the app checks another',
    );
  });

  it('the publish script defaults to that same repository', () => {
    assert.equal(
      publishDefault,
      `${builderOwner}/${builderRepo}`,
      'releases would be uploaded where installed copies do not look',
    );
  });

  it('no declaration points at a fork', () => {
    for (const [label, value] of [
      ['publish.owner', builderOwner],
      ['BRANDING.releaseOwner', brandingOwner],
      ['release-publish default', publishDefault],
    ] as const) {
      assert.ok(
        !/the-x1x1/i.test(value),
        `${label} names a fork (${value}); updates would be fetched from a repository the ` +
          'owner does not control',
      );
    }
  });
});
