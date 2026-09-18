#!/usr/bin/env node
/**
 * Prepares a release: consistency checks, build-info, the signed manifest.
 *
 * Run this AFTER `npm run package:win` and `npm run verify:package`, against
 * the artifacts that will actually be uploaded. It hashes the final files, so
 * it must not run before packaging or before any code signing.
 *
 * The private key is read from the `CHARGEWATCH_RELEASE_PRIVATE_KEY`
 * environment variable or from the maintainer key directory. It is never
 * written into the release, echoed, or logged.
 *
 * Usage:
 *   node scripts/release-prepare.mjs --version 0.1.1
 *   node scripts/release-prepare.mjs --version 0.1.1 --dir release --key-id cw-2026-09
 */

import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const version = arg('version');
const releaseDir = resolve(root, arg('dir', 'release'));
const channel = arg('channel', 'stable');

if (!version) {
  console.error('A version is required: node scripts/release-prepare.mjs --version 0.1.1');
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`"${version}" is not a valid semantic version.`);
  process.exit(1);
}

const failures = [];
const notes = [];

// ---------------------------------------------------------------- consistency

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.version !== version) {
  failures.push(
    `package.json says version ${pkg.version} but ${version} was requested. Bump it first so the ` +
      'installer, the manifest and the tag cannot disagree.',
  );
}

if (!existsSync(join(root, 'package-lock.json'))) {
  failures.push(
    'package-lock.json is missing. A release must be built from a locked dependency tree; see ' +
      'docs/BUILDING.md and docs/adr/0001-stack-and-version-pinning.md.',
  );
}

const changelogPath = join(root, 'CHANGELOG.md');
if (!existsSync(changelogPath)) {
  failures.push('CHANGELOG.md is missing.');
} else if (!readFileSync(changelogPath, 'utf8').includes(version)) {
  failures.push(`CHANGELOG.md has no entry for ${version}. Write it before releasing.`);
}

// Git state. A release built from a dirty tree cannot be reproduced.
let commit = 'unknown';
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (status.length > 0) {
    failures.push(
      `The working tree has uncommitted changes, so this build could not be reproduced:\n      ${status.split('\n').slice(0, 5).join('\n      ')}`,
    );
  }
} catch {
  notes.push('git state could not be read; the build commit is recorded as "unknown".');
}

// ------------------------------------------------------------------ artifacts

if (!existsSync(releaseDir)) {
  failures.push(`No release directory at ${releaseDir}. Run: npm run package:win`);
}

const ARTIFACT_KINDS = [
  { pattern: /Setup.*\.exe$/i, kind: 'installer', required: true },
  { pattern: /\.exe\.blockmap$/i, kind: 'blockmap', required: false },
  { pattern: /^latest\.yml$/i, kind: 'updater_metadata', required: true },
  { pattern: /\.zip$/i, kind: 'portable_zip', required: false },
];

const artifacts = [];
let updaterMetadataFileName = null;

if (existsSync(releaseDir)) {
  for (const name of readdirSync(releaseDir)) {
    const path = join(releaseDir, name);
    if (!statSync(path).isFile()) continue;
    const match = ARTIFACT_KINDS.find((candidate) => candidate.pattern.test(name));
    if (!match) continue;

    const bytes = readFileSync(path);
    const entry = {
      fileName: name,
      byteSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sha512: createHash('sha512').update(bytes).digest('hex'),
      kind: match.kind,
    };
    if (match.kind === 'updater_metadata') updaterMetadataFileName = name;
    artifacts.push(entry);
  }

  for (const required of ARTIFACT_KINDS.filter((candidate) => candidate.required)) {
    if (!artifacts.some((artifact) => required.pattern.test(artifact.fileName))) {
      failures.push(
        `No artifact matching ${required.pattern} in ${releaseDir}. A published update pointing at a ` +
          'missing installer or incomplete metadata is worse than no release.',
      );
    }
  }

  // The installer's name must contain the version, so a user can tell what
  // they downloaded and the manifest cannot be paired with the wrong file.
  const installer = artifacts.find((artifact) => artifact.kind === 'installer');
  if (installer && !installer.fileName.includes(version)) {
    failures.push(
      `The installer is named ${installer.fileName}, which does not contain ${version}.`,
    );
  }
}

// ------------------------------------------------------------------- the key

const keyId = arg('key-id');
const keyringPath = join(root, 'resources', 'update-keys', 'keys.json');
let resolvedKeyId = keyId;

if (!existsSync(keyringPath)) {
  failures.push('resources/update-keys/keys.json is missing. Run: npm run keys:bootstrap');
} else {
  const keyring = JSON.parse(readFileSync(keyringPath, 'utf8'));
  const active = (keyring.keys ?? []).filter((key) => !key.retired);
  if (active.length === 0) {
    failures.push(
      'No active public key is embedded, so nothing could verify this release. Run: npm run keys:bootstrap',
    );
  } else if (!resolvedKeyId) {
    if (active.length > 1) {
      failures.push(
        `Several active keys are embedded (${active.map((key) => key.keyId).join(', ')}). Pass --key-id to say which one signs.`,
      );
    } else {
      resolvedKeyId = active[0].keyId;
    }
  } else if (!active.some((key) => key.keyId === resolvedKeyId)) {
    failures.push(
      `Key ${resolvedKeyId} is not an active embedded key, so installed copies could not verify a release signed with it.`,
    );
  }
}

let privateKey = null;
const envKey = process.env.CHARGEWATCH_RELEASE_PRIVATE_KEY;
const keyFilePath = resolvedKeyId
  ? join(homedir(), '.chargewatch-release-keys', `${resolvedKeyId}.private.pem`)
  : null;

if (envKey && envKey.includes('PRIVATE KEY')) {
  privateKey = envKey;
  notes.push('signing with the key from CHARGEWATCH_RELEASE_PRIVATE_KEY');
} else if (keyFilePath && existsSync(keyFilePath)) {
  privateKey = readFileSync(keyFilePath, 'utf8');
  notes.push(`signing with ${keyFilePath}`);
} else {
  failures.push(
    'No signing key is available. Set CHARGEWATCH_RELEASE_PRIVATE_KEY or place the key at\n' +
      `      ${keyFilePath ?? '<maintainer key directory>'}\n` +
      '      A missing production key blocks publication, not local development.',
  );
}

// ------------------------------------------------------------------- report

if (failures.length > 0) {
  console.error('\nThis release cannot be prepared:\n');
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

// ------------------------------------------------------- build-info and manifest

const buildInfo = {
  formatVersion: 1,
  applicationId: 'com.formicaria.chargewatch',
  version,
  channel,
  buildCommit: commit,
  buildTimeIso: new Date().toISOString(),
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  dependencies: {
    electron: pkg.devDependencies?.electron ?? null,
    electronBuilder: pkg.devDependencies?.['electron-builder'] ?? null,
    electronUpdater: pkg.dependencies?.['electron-updater'] ?? null,
    playwrightCore: pkg.dependencies?.['playwright-core'] ?? null,
  },
  note:
    'Recorded so a released build can be traced to its exact source and dependency set. ' +
    'See docs/BUILDING.md.',
};
writeFileSync(
  join(releaseDir, 'build-info.json'),
  `${JSON.stringify(buildInfo, null, 2)}\n`,
  'utf8',
);

const manifest = {
  manifestFormatVersion: 1,
  keyId: resolvedKeyId,
  applicationId: 'com.formicaria.chargewatch',
  releaseVersion: version,
  tag: `v${version}`,
  channel,
  platform: 'win32',
  arch: 'x64',
  // Derived from the version so it increases monotonically without a separate
  // counter to keep in sync.
  releaseSequence: sequenceFromVersion(version),
  minimumSupportedAppVersion: arg('min-app-version', '0.1.0'),
  minimumUpdateProtocolVersion: 1,
  readableDbSchemaMin: 1,
  readableDbSchemaMax: 1,
  writableDbSchema: 1,
  requiredIntermediateVersion: arg('required-intermediate', null),
  artifacts,
  updaterMetadataSha256: artifacts.find((a) => a.kind === 'updater_metadata')?.sha256 ?? '',
  updaterMetadataFileName: updaterMetadataFileName ?? 'latest.yml',
  buildCommit: commit === 'unknown' ? '0000000' : commit,
  buildTimeMs: Date.now(),
};

// The bytes written to disk are exactly the bytes signed and later verified.
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
const manifestPath = join(releaseDir, 'release-manifest.json');
writeFileSync(manifestPath, manifestBytes);

const signature = cryptoSign(null, manifestBytes, createPrivateKey(privateKey)).toString('base64');
writeFileSync(join(releaseDir, 'release-manifest.json.sig'), `${signature}\n`, 'utf8');

// Plain checksums, for anyone verifying a manual download by hand.
const checksums = artifacts
  .map((artifact) => `${artifact.sha256}  ${artifact.fileName}`)
  .join('\n');
writeFileSync(join(releaseDir, 'SHA256SUMS.txt'), `${checksums}\n`, 'utf8');

console.log(`\nRelease ${version} prepared in ${releaseDir}\n`);
for (const note of notes) console.log(`  note: ${note}`);
console.log(`\n  ${artifacts.length} artifact(s):`);
for (const artifact of artifacts) {
  console.log(
    `    ${artifact.fileName.padEnd(40)} ${(artifact.byteSize / (1024 * 1024)).toFixed(1).padStart(7)} MB  ${artifact.kind}`,
  );
}
console.log(
  '\n  wrote build-info.json, release-manifest.json, release-manifest.json.sig, SHA256SUMS.txt',
);
console.log(`  signed with key ${resolvedKeyId} (the private key was not logged)`);
console.log('\nNext:  npm run release:verify -- --dir release');

/**
 * A monotonically increasing sequence derived from the version.
 *
 * major*1_000_000 + minor*1_000 + patch. A downgrade is refused by the
 * verifier, so fixing a bad release means publishing a HIGHER version.
 */
function sequenceFromVersion(value) {
  const [major = 0, minor = 0, patch = 0] = value.split('-')[0].split('.').map(Number);
  return major * 1_000_000 + minor * 1_000 + patch;
}
