#!/usr/bin/env node
/**
 * One-time maintainer key bootstrap.
 *
 * Generates an Ed25519 key pair, writes the PRIVATE key to a protected
 * location OUTSIDE the repository, and installs only the PUBLIC key into
 * `resources/update-keys/keys.json`, which ships inside the application.
 *
 * Rules this script enforces rather than documents:
 *  - the private key is never written inside the repository;
 *  - it is never printed to the console or a log;
 *  - an existing key is never overwritten without `--force`;
 *  - a new key is never generated per release. Generating one each time would
 *    mean installed copies could not verify the next update.
 *
 * Usage:
 *   node scripts/keys-bootstrap.mjs --key-id cw-2026-09
 *   node scripts/keys-bootstrap.mjs --key-id cw-2027-03 --rotate
 *   node scripts/keys-bootstrap.mjs --show
 */

import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const publicKeyFile = join(root, 'resources', 'update-keys', 'keys.json');
/** Deliberately outside the repository, under the maintainer's profile. */
const privateKeyDir = join(homedir(), '.chargewatch-release-keys');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}
const flag = (name) => process.argv.includes(`--${name}`);

function readKeyring() {
  if (!existsSync(publicKeyFile)) return { formatVersion: 1, keys: [] };
  try {
    const parsed = JSON.parse(readFileSync(publicKeyFile, 'utf8'));
    return {
      formatVersion: parsed.formatVersion ?? 1,
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
    };
  } catch (error) {
    console.error(`${publicKeyFile} is not valid JSON: ${error.message}`);
    process.exit(1);
  }
}

if (flag('show')) {
  const keyring = readKeyring();
  if (keyring.keys.length === 0) {
    console.log('No update keys are installed. Nothing can verify an update yet.');
    console.log('Run: node scripts/keys-bootstrap.mjs --key-id cw-<year>-<month>');
    process.exit(0);
  }
  console.log(`Installed public keys in ${publicKeyFile}:\n`);
  for (const key of keyring.keys) {
    console.log(`  ${key.keyId}${key.retired ? '  (retired)' : ''}`);
    console.log(`    created ${key.createdAt ?? 'unknown'}`);
    console.log(`    private key expected at ${join(privateKeyDir, `${key.keyId}.private.pem`)}`);
    console.log(
      `    present on this machine: ${existsSync(join(privateKeyDir, `${key.keyId}.private.pem`)) ? 'yes' : 'no'}`,
    );
  }
  process.exit(0);
}

const keyId = arg('key-id');
if (!keyId) {
  console.error(
    'A key id is required, for example:\n' +
      '  node scripts/keys-bootstrap.mjs --key-id cw-2026-09\n\n' +
      'Use a dated id so rotation is traceable. Run with --show to list installed keys.',
  );
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{4,64}$/.test(keyId)) {
  console.error('A key id must be 4-64 characters of letters, digits, hyphen or underscore.');
  process.exit(1);
}

const keyring = readKeyring();
const existing = keyring.keys.find((key) => key.keyId === keyId);
const privateKeyPath = join(privateKeyDir, `${keyId}.private.pem`);

if (existing && !flag('force')) {
  console.error(
    `Key ${keyId} is already installed. Generating it again would make every already-installed\n` +
      'copy of ChargeWatch unable to verify the next update.\n\n' +
      'To rotate, pick a NEW key id and pass --rotate:\n' +
      '  node scripts/keys-bootstrap.mjs --key-id cw-2027-03 --rotate\n\n' +
      'Rotation requires shipping the new public key in a release signed by the CURRENT key\n' +
      'BEFORE the new key is used. See docs/UPDATES_AND_RECOVERY.md.',
  );
  process.exit(1);
}

if (existsSync(privateKeyPath) && !flag('force')) {
  console.error(
    `A private key already exists at ${privateKeyPath}. Refusing to overwrite it.\n` +
      'If you are certain, pass --force, but understand that the old key is then unrecoverable.',
  );
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

mkdirSync(privateKeyDir, { recursive: true, mode: 0o700 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
writeFileSync(privateKeyPath, privatePem, { encoding: 'utf8', mode: 0o600 });
try {
  chmodSync(privateKeyDir, 0o700);
  chmodSync(privateKeyPath, 0o600);
} catch {
  // Windows ignores POSIX modes; the directory is under the user profile.
}

const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

mkdirSync(dirname(publicKeyFile), { recursive: true });
const nextKeys = keyring.keys.filter((key) => key.keyId !== keyId);

// On rotation the previous keys stay TRUSTED for verification, marked retired
// only once the replacement has actually shipped. A key removed too early makes
// released updates unverifiable.
if (flag('rotate')) {
  for (const key of nextKeys) key.rotationPending = true;
}

nextKeys.push({
  keyId,
  publicKeyPem: publicPem,
  retired: false,
  createdAt: new Date().toISOString(),
});

writeFileSync(
  publicKeyFile,
  `${JSON.stringify({ formatVersion: 1, keys: nextKeys }, null, 2)}\n`,
  'utf8',
);

console.log(`Generated Ed25519 key pair "${keyId}".\n`);
console.log(`  Private key  ${privateKeyPath}`);
console.log('               (outside the repository, user-only permissions, NOT printed here)');
console.log(`  Public key   ${publicKeyFile}  — commit this\n`);

console.log('Next steps:\n');
console.log('  1. Back up the private key somewhere you will still have in a year.');
console.log('     Losing it means a manually installed recovery release; see');
console.log('     docs/UPDATES_AND_RECOVERY.md.');
console.log('  2. Add the private key as a GitHub Actions secret named');
console.log('     CHARGEWATCH_RELEASE_PRIVATE_KEY on the release repository only:');
console.log(`       gh secret set CHARGEWATCH_RELEASE_PRIVATE_KEY < "${privateKeyPath}"`);
console.log('  3. Commit resources/update-keys/keys.json.');
if (flag('rotate')) {
  console.log('\n  Rotation: ship a release signed by the PREVIOUS key that contains this new');
  console.log('  public key, and only then start signing with the new key. A new public key');
  console.log('  arriving in an update signed by itself proves nothing and must never be trusted.');
}
console.log('\nThe private key was not printed. Do not paste it into a terminal or a chat.');
