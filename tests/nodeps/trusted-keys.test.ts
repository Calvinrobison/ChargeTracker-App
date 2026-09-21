/**
 * Two people's signing keys were both embedded as `cw-2026-09`.
 *
 * One shipped in the v0.1.0 release on GitHub, the other sat in a working
 * tree. Verification collects every embedded key matching the id a manifest
 * declares and accepts a signature from any of them, so the collision meant
 * two different private keys could each produce an update this application
 * installs — under one name, logged identically either way.
 *
 * Nothing caught it because the collision was in data, not in code. The 35
 * release-manifest specs all passed throughout: they construct their trusted
 * keys inline, and never looked at the file that ships.
 *
 * So these specs do two things. They pin `parseTrustedKeys`, which refuses a
 * file that would make a signature ambiguous, and they read
 * `resources/update-keys/keys.json` itself — the artifact, not a fixture.
 */

import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { parseTrustedKeys } from '../../src/shared/release-manifest.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PUBLIC_A =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA+cdbjmiiwhnRasIbaNSyzRpoMhfGZyNfe8b4+FasPVk=\n-----END PUBLIC KEY-----\n';
const PUBLIC_B =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA4JcdCyYhj8QEjQHgP2kC2LHWwxt7vHrTL/mUnr3Ma9g=\n-----END PUBLIC KEY-----\n';

describe('a key file that would make a signature ambiguous is refused', () => {
  it('refuses two keys sharing one id, naming both positions', () => {
    const result = parseTrustedKeys({
      keys: [
        { keyId: 'cw-2026-09', publicKeyPem: PUBLIC_A, retired: false },
        { keyId: 'cw-2026-09', publicKeyPem: PUBLIC_B, retired: false },
      ],
    });

    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0] as string, /cw-2026-09/);
    assert.match(result.problems[0] as string, /0 and 1/);
  });

  it('refuses a duplicate even when the key material is identical', () => {
    // Still ambiguous to a reader, and still a sign that two processes wrote
    // the same file without knowing about each other.
    const result = parseTrustedKeys({
      keys: [
        { keyId: 'same', publicKeyPem: PUBLIC_A, retired: false },
        { keyId: 'same', publicKeyPem: PUBLIC_A, retired: false },
      ],
    });
    assert.equal(result.problems.length, 1);
  });

  it('refuses a PRIVATE key, which must never ship inside the application', () => {
    const result = parseTrustedKeys({
      keys: [
        {
          keyId: 'leaked',
          publicKeyPem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
          retired: false,
        },
      ],
    });
    assert.equal(result.keys.length, 0);
    assert.match(result.problems[0] as string, /PRIVATE/);
  });

  it('refuses entries with no id, no key, or the wrong shape', () => {
    const result = parseTrustedKeys({
      keys: [
        { keyId: '', publicKeyPem: PUBLIC_A },
        { keyId: 'no-key', publicKeyPem: 'not a pem' },
        'a string',
        null,
      ],
    });
    assert.equal(result.keys.length, 0);
    assert.equal(result.problems.length, 4);
  });

  it('refuses a file that is not an object or has no keys array', () => {
    assert.equal(parseTrustedKeys(null).problems.length, 1);
    assert.equal(parseTrustedKeys('keys').problems.length, 1);
    assert.equal(parseTrustedKeys({}).problems.length, 1);
  });
});

describe('a well-formed key file parses', () => {
  it('accepts distinct ids and carries retired through, defaulting to false', () => {
    const result = parseTrustedKeys({
      keys: [
        { keyId: 'a', publicKeyPem: PUBLIC_A, retired: true },
        { keyId: 'b', publicKeyPem: PUBLIC_B },
      ],
    });

    assert.deepEqual(result.problems, []);
    assert.equal(result.keys.length, 2);
    assert.equal(result.keys[0]?.retired, true);
    assert.equal(result.keys[1]?.retired, false, 'an absent flag means not retired');
  });

  it('treats a non-boolean retired value as not retired rather than truthy', () => {
    const result = parseTrustedKeys({
      keys: [{ keyId: 'a', publicKeyPem: PUBLIC_A, retired: 'yes' }],
    });
    assert.equal(result.keys[0]?.retired, false, 'only true retires a key');
  });
});

describe('the key file that actually ships', () => {
  const shipped: unknown = JSON.parse(
    readFileSync(join(repoRoot, 'resources', 'update-keys', 'keys.json'), 'utf8'),
  );
  const result = parseTrustedKeys(shipped);

  it('parses with no problems', () => {
    assert.deepEqual(result.problems, [], 'this file is embedded in every build');
  });

  it('embeds at least one key, or no update could ever be installed', () => {
    assert.ok(result.keys.length > 0);
  });

  it('has a usable, non-retired key so a release can actually be verified', () => {
    assert.ok(
      result.keys.some((key) => !key.retired),
      'every key retired means updates are refused for a reason nobody intended',
    );
  });

  it('carries only real Ed25519 PUBLIC keys', () => {
    for (const key of result.keys) {
      const parsedKey = createPublicKey(key.publicKeyPem);
      assert.equal(parsedKey.type, 'public', `${key.keyId} is not a public key`);
      assert.equal(parsedKey.asymmetricKeyType, 'ed25519', `${key.keyId} is not Ed25519`);
    }
  });

  it('contains no private key material anywhere in the file', () => {
    const text = readFileSync(join(repoRoot, 'resources', 'update-keys', 'keys.json'), 'utf8');
    assert.ok(!text.includes('PRIVATE KEY'), 'a private key in a shipped file is a disclosure');
  });
});
