/**
 * Signed release manifest verification (§25, §32 update checks).
 *
 * These are the specs that decide whether an unverified executable can ever
 * reach an install path. Run:
 *   node --experimental-strip-types --test tests/nodeps/release-manifest.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import {
  MANIFEST_FORMAT_VERSION,
  UPDATE_PROTOCOL_VERSION,
  compareSemver,
  isDirectUpgradePermitted,
  isPermittedDownloadUrl,
  sha256Hex,
  sha512Hex,
  signManifestBytes,
  verifyArtifactBytes,
  verifyManifest,
  type ReleaseManifest,
  type VerificationContext,
} from '../../src/shared/release-manifest.ts';

const realKey = generateKeyPairSync('ed25519');
const attackerKey = generateKeyPairSync('ed25519');

const INSTALLER_BYTES = Buffer.from('a pretend NSIS installer payload');
const INSTALLER_NAME = 'ChargeWatch-Setup-0.1.1.exe';
const METADATA_NAME = 'latest.yml';

function baseManifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    manifestFormatVersion: MANIFEST_FORMAT_VERSION,
    keyId: 'cw-2026-09',
    applicationId: 'com.formicaria.chargewatch',
    releaseVersion: '0.1.1',
    tag: 'v0.1.1',
    channel: 'stable',
    platform: 'win32',
    arch: 'x64',
    releaseSequence: 2,
    minimumSupportedAppVersion: '0.1.0',
    minimumUpdateProtocolVersion: UPDATE_PROTOCOL_VERSION,
    readableDbSchemaMin: 1,
    readableDbSchemaMax: 1,
    writableDbSchema: 1,
    requiredIntermediateVersion: null,
    artifacts: [
      {
        fileName: INSTALLER_NAME,
        byteSize: INSTALLER_BYTES.byteLength,
        sha256: sha256Hex(INSTALLER_BYTES),
        sha512: sha512Hex(INSTALLER_BYTES),
        kind: 'installer',
      },
    ],
    updaterMetadataSha256: sha256Hex('version: 0.1.1\n'),
    updaterMetadataFileName: METADATA_NAME,
    buildCommit: 'deadbeefcafe123',
    buildTimeMs: Date.UTC(2026, 8, 17, 6, 0, 0),
    ...overrides,
  };
}

/** Writes the manifest exactly as the release pipeline would, then signs it. */
function sign(manifest: ReleaseManifest, key = realKey.privateKey) {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { bytes, signature: signManifestBytes(bytes, key) };
}

function context(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    trustedKeys: [
      {
        keyId: 'cw-2026-09',
        publicKeyPem: realKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        retired: false,
      },
    ],
    applicationId: 'com.formicaria.chargewatch',
    platform: 'win32',
    arch: 'x64',
    acceptedChannels: ['stable'],
    updateProtocolVersion: UPDATE_PROTOCOL_VERSION,
    highestAcceptedSequence: 1,
    writableDbSchema: 1,
    candidateVersion: '0.1.1',
    candidateTag: 'v0.1.1',
    availableArtifactNames: [INSTALLER_NAME, METADATA_NAME],
    ...overrides,
  };
}

describe('the happy path', () => {
  test('a correctly signed manifest verifies', () => {
    const { bytes, signature } = sign(baseManifest());
    const result = verifyManifest(bytes, signature, context());
    assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.detail}`);
    if (!result.ok) return;
    assert.equal(result.manifest.releaseVersion, '0.1.1');
    assert.equal(result.keyId, 'cw-2026-09');
  });

  test('the exact bytes written to disk are what get signed and verified', () => {
    const manifest = baseManifest();
    const { bytes, signature } = sign(manifest);
    // Re-serialising with different whitespace must NOT verify: we sign bytes,
    // not a canonicalised object.
    const reserialised = Buffer.from(JSON.stringify(manifest), 'utf8');
    assert.equal(verifyManifest(bytes, signature, context()).ok, true);
    assert.equal(verifyManifest(reserialised, signature, context()).ok, false);
  });
});

describe('signature and key failures', () => {
  test('an attacker-signed manifest is rejected', () => {
    const { bytes, signature } = sign(baseManifest(), attackerKey.privateKey);
    const result = verifyManifest(bytes, signature, context());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'bad_signature');
  });

  test('a tampered payload invalidates the signature', () => {
    const { bytes, signature } = sign(baseManifest());
    const tampered = Buffer.from(
      bytes.toString('utf8').replace('"releaseSequence": 2', '"releaseSequence": 3'),
      'utf8',
    );
    const result = verifyManifest(tampered, signature, context());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'bad_signature');
  });

  test('an unknown key id is rejected, and a self-declared key grants nothing', () => {
    const { bytes, signature } = sign(
      baseManifest({ keyId: 'attacker-key' }),
      attackerKey.privateKey,
    );
    const result = verifyManifest(bytes, signature, context());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'unknown_key_id');
  });

  test('a retired key cannot authorise a new release', () => {
    const { bytes, signature } = sign(baseManifest());
    const result = verifyManifest(
      bytes,
      signature,
      context({
        trustedKeys: [
          {
            keyId: 'cw-2026-09',
            publicKeyPem: realKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
            retired: true,
          },
        ],
      }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'retired_key');
  });

  test('a malformed signature is rejected without parsing the payload', () => {
    const { bytes } = sign(baseManifest());
    for (const bad of ['', 'not base64 !!!', Buffer.alloc(10).toString('base64')]) {
      const result = verifyManifest(bytes, bad, context());
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.code, 'malformed_signature');
    }
  });

  test('a manifest that is not JSON is rejected', () => {
    const bytes = Buffer.from('this is not json', 'utf8');
    const result = verifyManifest(bytes, Buffer.alloc(64).toString('base64'), context());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'malformed_manifest');
  });

  test('a signed but structurally invalid manifest is rejected after signature checking', () => {
    const bad = {
      ...baseManifest(),
      releaseVersion: 'not-a-version',
    } as unknown as ReleaseManifest;
    const { bytes, signature } = sign(bad);
    const result = verifyManifest(bytes, signature, context());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'malformed_manifest');
  });
});

describe('target and protocol checks', () => {
  const cases: Array<[string, Partial<ReleaseManifest>, Partial<VerificationContext>, string]> = [
    ['a different application', { applicationId: 'com.someone.else' }, {}, 'wrong_application'],
    ['a different platform', { platform: 'darwin' }, {}, 'wrong_platform'],
    ['a different architecture', { arch: 'arm64' }, {}, 'wrong_arch'],
    ['an unaccepted channel', { channel: 'beta' }, {}, 'wrong_channel'],
    [
      'a newer manifest format',
      { manifestFormatVersion: MANIFEST_FORMAT_VERSION + 1 },
      {},
      'unsupported_manifest_format',
    ],
    [
      'a newer update protocol',
      { minimumUpdateProtocolVersion: UPDATE_PROTOCOL_VERSION + 1 },
      {},
      'unsupported_update_protocol',
    ],
    [
      'a schema range this build falls outside',
      { readableDbSchemaMin: 5, readableDbSchemaMax: 9 },
      {},
      'schema_unsupported',
    ],
  ];

  for (const [label, manifestOverride, contextOverride, expected] of cases) {
    test(`${label} is rejected (${expected})`, () => {
      const { bytes, signature } = sign(baseManifest(manifestOverride));
      const result = verifyManifest(bytes, signature, context(contextOverride));
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, expected);
    });
  }

  test('a version or tag disagreeing with the updater is rejected', () => {
    const { bytes, signature } = sign(baseManifest());
    const versionMismatch = verifyManifest(
      bytes,
      signature,
      context({ candidateVersion: '0.1.2' }),
    );
    assert.equal(versionMismatch.ok, false);
    if (!versionMismatch.ok) assert.equal(versionMismatch.code, 'version_mismatch');

    const tagMismatch = verifyManifest(bytes, signature, context({ candidateTag: 'v9.9.9' }));
    assert.equal(tagMismatch.ok, false);
    if (!tagMismatch.ok) assert.equal(tagMismatch.code, 'tag_mismatch');
  });
});

describe('replay and downgrade', () => {
  test('a replayed older release is refused', () => {
    const { bytes, signature } = sign(baseManifest({ releaseSequence: 2 }));
    const result = verifyManifest(bytes, signature, context({ highestAcceptedSequence: 7 }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'replayed_sequence');
  });

  test('re-offering the same sequence is refused', () => {
    const { bytes, signature } = sign(baseManifest({ releaseSequence: 5 }));
    const result = verifyManifest(bytes, signature, context({ highestAcceptedSequence: 5 }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'replayed_sequence');
  });

  test('a genuinely newer sequence is accepted', () => {
    const { bytes, signature } = sign(baseManifest({ releaseSequence: 9 }));
    assert.equal(
      verifyManifest(bytes, signature, context({ highestAcceptedSequence: 8 })).ok,
      true,
    );
  });
});

describe('artifact naming and completeness', () => {
  test('an artifact missing from the release is rejected', () => {
    const { bytes, signature } = sign(baseManifest());
    const result = verifyManifest(
      bytes,
      signature,
      context({ availableArtifactNames: [METADATA_NAME] }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'artifact_missing');
  });

  test('missing updater metadata is rejected', () => {
    const { bytes, signature } = sign(baseManifest());
    const result = verifyManifest(
      bytes,
      signature,
      context({ availableArtifactNames: [INSTALLER_NAME] }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'artifact_missing');
  });

  test('a path-traversing artifact name cannot be signed into a manifest', () => {
    for (const hostile of [
      '../../Windows/System32/evil.exe',
      'sub/dir/installer.exe',
      'C:\\Windows\\evil.exe',
      'a\\b.exe',
    ]) {
      const manifest = baseManifest({
        artifacts: [
          {
            fileName: hostile,
            byteSize: 10,
            sha256: sha256Hex('x'),
            sha512: sha512Hex('x'),
            kind: 'installer',
          },
        ],
      });
      const { bytes, signature } = sign(manifest);
      const result = verifyManifest(
        bytes,
        signature,
        context({ availableArtifactNames: [hostile, METADATA_NAME] }),
      );
      assert.equal(result.ok, false, `${hostile} must be refused`);
      if (result.ok) continue;
      assert.equal(result.code, 'malformed_manifest');
    }
  });
});

describe('artifact byte verification', () => {
  const manifest = baseManifest();

  test('the correct bytes pass', () => {
    assert.equal(verifyArtifactBytes(INSTALLER_NAME, INSTALLER_BYTES, manifest).ok, true);
  });

  test('a tampered installer fails its digest', () => {
    const tampered = Buffer.concat([
      INSTALLER_BYTES.subarray(0, INSTALLER_BYTES.length - 1),
      Buffer.from('X'),
    ]);
    const result = verifyArtifactBytes(INSTALLER_NAME, tampered, manifest);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'sha256_mismatch');
  });

  test('a size mismatch is caught before hashing succeeds by accident', () => {
    const result = verifyArtifactBytes(INSTALLER_NAME, Buffer.from('short'), manifest);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'size_mismatch');
  });

  test('an artifact not named in the manifest cannot be installed', () => {
    const result = verifyArtifactBytes('surprise.exe', INSTALLER_BYTES, manifest);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_in_manifest');
  });

  test('both SHA-256 and SHA-512 must match', () => {
    const wrong512 = baseManifest({
      artifacts: [
        {
          fileName: INSTALLER_NAME,
          byteSize: INSTALLER_BYTES.byteLength,
          sha256: sha256Hex(INSTALLER_BYTES),
          sha512: sha512Hex('something else entirely'),
          kind: 'installer',
        },
      ],
    });
    const result = verifyArtifactBytes(INSTALLER_NAME, INSTALLER_BYTES, wrong512);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'sha512_mismatch');
  });
});

describe('download source restriction', () => {
  const configured = { owner: 'Calvinrobison', repo: 'ChargeTracker-App' };

  test('the configured release source and its asset redirects are permitted', () => {
    for (const url of [
      'https://github.com/Calvinrobison/ChargeTracker-App/releases/download/v0.1.1/ChargeWatch-Setup-0.1.1.exe',
      'https://api.github.com/repos/Calvinrobison/ChargeTracker-App/releases/latest',
      'https://objects.githubusercontent.com/github-production-release-asset/abc',
    ]) {
      assert.equal(isPermittedDownloadUrl(url, configured), true, `${url} should be permitted`);
    }
  });

  test('another repository, host or scheme is refused', () => {
    for (const url of [
      'https://github.com/someone/else/releases/download/v1/evil.exe',
      'http://github.com/Calvinrobison/ChargeTracker-App/releases/download/v1/x.exe',
      'https://evil.example/ChargeWatch-Setup.exe',
      'https://github.com.evil.example/Calvinrobison/ChargeTracker-App/releases/',
      'file:///C:/evil.exe',
      'not a url',
    ]) {
      assert.equal(isPermittedDownloadUrl(url, configured), false, `${url} should be refused`);
    }
  });
});

describe('upgrade path safety', () => {
  test('a release requiring a newer minimum version refuses an old installation', () => {
    const manifest = baseManifest({ minimumSupportedAppVersion: '0.5.0' });
    const result = isDirectUpgradePermitted(manifest, '0.1.0');
    assert.equal(result.permitted, false);
    assert.match(result.reason ?? '', /0\.5\.0 or newer/);
  });

  test('a required intermediate version blocks a direct jump and says which to install', () => {
    const manifest = baseManifest({ requiredIntermediateVersion: '0.3.0' });
    const blocked = isDirectUpgradePermitted(manifest, '0.1.0');
    assert.equal(blocked.permitted, false);
    assert.match(blocked.reason ?? '', /Install ChargeWatch 0\.3\.0 first/);

    const allowed = isDirectUpgradePermitted(manifest, '0.3.0');
    assert.equal(allowed.permitted, true);
  });

  test('an ordinary upgrade is permitted', () => {
    assert.equal(isDirectUpgradePermitted(baseManifest(), '0.1.0').permitted, true);
  });
});

describe('version comparison', () => {
  test('ordering is by major, minor then patch', () => {
    assert.equal(compareSemver('1.0.0', '0.9.9'), 1);
    assert.equal(compareSemver('0.1.2', '0.1.10'), -1);
    assert.equal(compareSemver('0.1.1', '0.1.1'), 0);
  });

  test('a prerelease sorts below its release', () => {
    assert.equal(compareSemver('1.0.0', '1.0.0-beta.1'), 1);
    assert.equal(compareSemver('1.0.0-beta.1', '1.0.0'), -1);
    assert.equal(compareSemver('1.0.0-alpha', '1.0.0-beta'), -1);
  });
});
