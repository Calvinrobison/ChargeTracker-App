/**
 * Which files in `release/` belong to the release being prepared.
 *
 * Preparing 0.2.0 with both installers present failed with "The installer is
 * named ChargeWatch-Setup-0.1.0.exe, which does not contain 0.2.0" — while the
 * 0.2.0 installer sat in the same directory. `readdirSync` returns names
 * alphabetically and the check inspected the first installer it found.
 *
 * The misleading message was the smaller half of it. Every matching file was
 * collected into the artifact list before that check ran, so had the check
 * passed, a signed manifest would have listed an installer from a different
 * release — and the manifest is the document telling an installed copy which
 * bytes to trust.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  partitionArtifactsByVersion,
  foreignArtifactFailure,
} from '../../scripts/lib/release-artifacts.mjs';

describe('splitting a release directory by version', () => {
  it('separates the release being prepared from a leftover build', () => {
    const { belonging, foreign, unversioned } = partitionArtifactsByVersion(
      [
        'ChargeWatch-Setup-0.1.0.exe',
        'ChargeWatch-Setup-0.1.0.exe.blockmap',
        'ChargeWatch-Setup-0.2.0.exe',
        'ChargeWatch-Setup-0.2.0.exe.blockmap',
        'latest.yml',
      ],
      '0.2.0',
    );

    assert.deepEqual(belonging, [
      'ChargeWatch-Setup-0.2.0.exe',
      'ChargeWatch-Setup-0.2.0.exe.blockmap',
    ]);
    assert.deepEqual(foreign, [
      'ChargeWatch-Setup-0.1.0.exe',
      'ChargeWatch-Setup-0.1.0.exe.blockmap',
    ]);
    assert.deepEqual(unversioned, ['latest.yml'], 'latest.yml belongs to whichever release is cut');
  });

  it('does not depend on directory order, which is what caused the original bug', () => {
    const names = ['ChargeWatch-Setup-0.2.0.exe', 'ChargeWatch-Setup-0.1.0.exe'];
    const forward = partitionArtifactsByVersion(names, '0.2.0');
    const reversed = partitionArtifactsByVersion([...names].reverse(), '0.2.0');

    assert.deepEqual(forward.belonging, ['ChargeWatch-Setup-0.2.0.exe']);
    assert.deepEqual(reversed.belonging, ['ChargeWatch-Setup-0.2.0.exe']);
  });

  it('matches the whole version, so 0.2.0 does not claim 0.2.10', () => {
    const { belonging, foreign } = partitionArtifactsByVersion(
      ['ChargeWatch-Setup-0.2.10.exe', 'ChargeWatch-Setup-0.2.0.exe'],
      '0.2.0',
    );
    assert.deepEqual(belonging, ['ChargeWatch-Setup-0.2.0.exe']);
    assert.deepEqual(foreign, ['ChargeWatch-Setup-0.2.10.exe']);
  });

  it('reports a clean directory as having nothing foreign', () => {
    const { belonging, foreign } = partitionArtifactsByVersion(
      ['ChargeWatch-Setup-0.2.0.exe', 'latest.yml'],
      '0.2.0',
    );
    assert.deepEqual(foreign, []);
    assert.deepEqual(belonging, ['ChargeWatch-Setup-0.2.0.exe']);
  });

  it('treats a name with no version as unversioned rather than foreign', () => {
    const { foreign, unversioned } = partitionArtifactsByVersion(['latest.yml'], '0.2.0');
    assert.deepEqual(foreign, []);
    assert.deepEqual(unversioned, ['latest.yml']);
  });
});

describe('the message a person actually reads', () => {
  it('names the offending files, the version and the remedy', () => {
    const message = foreignArtifactFailure(
      ['ChargeWatch-Setup-0.1.0.exe'],
      '0.2.0',
      'C:\\repo\\release',
    );

    assert.match(message, /ChargeWatch-Setup-0\.1\.0\.exe/, 'the file must be named');
    assert.match(message, /0\.2\.0/, 'the version being prepared must be named');
    assert.match(message, /Remove-Item/, 'a person should not have to work out the fix');
  });

  it('says it is refusing rather than guessing', () => {
    // The old message implied the build was misnamed. This one has to say that
    // the directory is ambiguous, because that is the actual situation.
    const message = foreignArtifactFailure(['old.exe'], '0.2.0', 'release');
    assert.match(message, /refused rather than/);
  });
});
