#!/usr/bin/env node
/**
 * Verifies a prepared release exactly the way an installed ChargeWatch will.
 *
 * It uses the SAME verification code the application uses
 * (`src/shared/release-manifest.ts`), against the PUBLIC keys that ship in the
 * application. If this passes, an installed copy will accept the release; if it
 * fails, the release would be rejected on users' machines, which is far better
 * to discover here.
 *
 * Runs under Node's TypeScript type-stripping so it can import the real
 * verifier rather than a reimplementation of it.
 *
 * Usage: node --experimental-strip-types scripts/release-verify.mjs --dir release
 *        (or: npm run release:verify -- --dir release)
 *
 * --installed-version  the version to test the upgrade path from. Defaults to
 *                      the manifest's own minimumSupportedAppVersion, which
 *                      asks the question that matters: can the oldest copy
 *                      this release claims to support actually take it?
 * --highest-sequence   the highest release sequence a copy has already
 *                      accepted, for the downgrade check (default 0).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// pathToFileURL, not the bare path: Node's ESM loader takes a URL, and on
// Windows `join` produces `C:\\...`, which it reads as the scheme "c:" and
// rejects with ERR_UNSUPPORTED_ESM_URL_SCHEME. This script could therefore
// never run on the only platform the application ships on, which also meant
// release:publish could never verify a release, because it runs this first.
const { verifyArtifactBytes, verifyManifest, isDirectUpgradePermitted, UPDATE_PROTOCOL_VERSION } =
  await import(pathToFileURL(join(root, 'src', 'shared', 'release-manifest.ts')).href);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const releaseDir = resolve(root, arg('dir', 'release'));
const installedVersionArg = arg('installed-version', null);
const highestAcceptedSequence = Number(arg('highest-sequence', '0'));

if (!existsSync(releaseDir)) {
  console.error(`No release directory at ${releaseDir}.`);
  process.exit(1);
}

const manifestPath = join(releaseDir, 'release-manifest.json');
const signaturePath = join(releaseDir, 'release-manifest.json.sig');

for (const path of [manifestPath, signaturePath]) {
  if (!existsSync(path)) {
    console.error(
      `${path} is missing. Run: npm run release:prepare -- --version <version>\n` +
        'A release without a signed manifest cannot be installed by any ChargeWatch build.',
    );
    process.exit(1);
  }
}

// The exact bytes on disk, not a re-serialised object.
const manifestBytes = readFileSync(manifestPath);
const signature = readFileSync(signaturePath, 'utf8').trim();

const keyringPath = join(root, 'resources', 'update-keys', 'keys.json');
if (!existsSync(keyringPath)) {
  console.error('resources/update-keys/keys.json is missing; nothing could verify this release.');
  process.exit(1);
}
const keyring = JSON.parse(readFileSync(keyringPath, 'utf8'));
const trustedKeys = (keyring.keys ?? []).map((key) => ({
  keyId: key.keyId,
  publicKeyPem: key.publicKeyPem,
  retired: key.retired ?? false,
}));

if (trustedKeys.length === 0) {
  console.error(
    'No public keys are embedded in the application, so no release can be verified or installed.\n' +
      'Run: npm run keys:bootstrap',
  );
  process.exit(1);
}

const availableArtifactNames = readdirSync(releaseDir).filter((name) =>
  statSync(join(releaseDir, name)).isFile(),
);

// Read the version and tag the way the updater would: from the release itself.
let candidateVersion = null;
let candidateTag = null;
try {
  const peek = JSON.parse(manifestBytes.toString('utf8'));
  candidateVersion = peek.releaseVersion ?? null;
  candidateTag = peek.tag ?? null;
} catch {
  // A malformed manifest is caught by the verifier below.
}

const result = verifyManifest(manifestBytes, signature, {
  trustedKeys,
  applicationId: 'com.formicaria.chargewatch',
  platform: 'win32',
  arch: 'x64',
  acceptedChannels: ['stable'],
  updateProtocolVersion: UPDATE_PROTOCOL_VERSION,
  highestAcceptedSequence,
  writableDbSchema: 1,
  candidateVersion,
  candidateTag,
  availableArtifactNames,
});

console.log(`\nVerifying ${releaseDir} as an installed ChargeWatch would\n`);

if (!result.ok) {
  console.error(`  FAIL  manifest signature and claims: ${result.code}`);
  console.error(`        ${result.detail}`);
  console.error(
    '\nThis release would be REJECTED by installed copies. Do not publish it.\n' +
      'An unverified executable must never reach an install path.',
  );
  process.exit(1);
}

console.log(`  PASS  manifest signature verified with key ${result.keyId}`);
console.log(
  `  PASS  release ${result.manifest.releaseVersion} (${result.manifest.tag}), sequence ${result.manifest.releaseSequence}`,
);

let failed = false;
for (const artifact of result.manifest.artifacts) {
  const path = join(releaseDir, artifact.fileName);
  if (!existsSync(path)) {
    console.error(`  FAIL  ${artifact.fileName}: named in the manifest but not present`);
    failed = true;
    continue;
  }
  const bytes = readFileSync(path);
  const check = verifyArtifactBytes(artifact.fileName, bytes, result.manifest);
  if (check.ok) {
    console.log(
      `  PASS  ${artifact.fileName} (${(artifact.byteSize / (1024 * 1024)).toFixed(1)} MB, ${artifact.kind})`,
    );
  } else {
    console.error(`  FAIL  ${artifact.fileName}: ${check.code} — ${check.detail}`);
    failed = true;
  }
}

// The updater metadata digest is recorded in the manifest so the metadata
// cannot be swapped independently of the installer.
const metadataPath = join(releaseDir, result.manifest.updaterMetadataFileName);
if (!existsSync(metadataPath)) {
  console.error(`  FAIL  ${result.manifest.updaterMetadataFileName} is missing`);
  failed = true;
} else {
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(readFileSync(metadataPath)).digest('hex');
  if (digest === result.manifest.updaterMetadataSha256) {
    console.log(`  PASS  ${result.manifest.updaterMetadataFileName} digest matches the manifest`);
  } else {
    console.error(
      `  FAIL  ${result.manifest.updaterMetadataFileName} digest does not match the manifest`,
    );
    failed = true;
  }
}

// Nothing dangerous in the upload set.
const forbidden = availableArtifactNames.filter(
  (name) => /(\.pem$|private|secret|\.env$|\.sqlite$)/i.test(name) && !/\.pub\.pem$/i.test(name),
);
if (forbidden.length > 0) {
  console.error(
    `  FAIL  the release directory contains files that must not be uploaded: ${forbidden.join(', ')}`,
  );
  failed = true;
} else {
  console.log('  PASS  no keys, credentials or databases in the upload set');
}

// The upgrade-path check the installed updater runs on exactly this manifest
// (src/main/updates.ts). Without it this script accepted --installed-version and
// ignored it, so a release that an installed copy would reject as skipping a
// required migration still passed the gate this script is supposed to be.
//
// Defaulting to the manifest's own floor rather than a fixed old version: with
// a literal default of 0.0.1 and release-prepare's default floor of 0.1.0, the
// check asked whether a version below the supported floor could install, which
// is false by construction. Every release would have failed its own gate. The
// question worth asking is whether the oldest SUPPORTED copy can take it.
const installedVersion = installedVersionArg ?? result.manifest.minimumSupportedAppVersion;
const upgrade = isDirectUpgradePermitted(result.manifest, installedVersion);
if (upgrade.permitted) {
  console.log(`  PASS  a copy running ${installedVersion} may install this release directly`);
} else {
  console.error(`  FAIL  upgrade path from ${installedVersion}: ${upgrade.reason}`);
  failed = true;
}

console.log(
  `\n  Installed copies older than ${result.manifest.minimumSupportedAppVersion} will refuse this release.`,
);
if (result.manifest.requiredIntermediateVersion) {
  console.log(
    `  Copies older than ${result.manifest.requiredIntermediateVersion} must install that version first.`,
  );
}
console.log(
  `  A copy that has already accepted sequence ${result.manifest.releaseSequence} or higher will refuse it as a downgrade.`,
);

if (failed) {
  console.error('\nDo not publish this release.');
  process.exit(1);
}

console.log('\nThis release would be accepted by an installed ChargeWatch.');
console.log(
  'Remaining step:  npm run release:publish -- --tag ' + result.manifest.tag + ' --dry-run',
);
console.log(
  '\nNote: this proves the release is internally consistent and correctly signed. It does NOT\n' +
    'prove GitHub permissions or asset availability — only an actual publish and a real client\n' +
    'discovering it can prove that.',
);
