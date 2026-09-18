#!/usr/bin/env node
/**
 * Publishes a verified release to GitHub.
 *
 * Defaults to `--dry-run`, and refuses to publish unless
 * `npm run release:verify` would pass on the same directory. A published
 * stable update that points at a missing installer or an unverifiable manifest
 * is worse than no release, so the gate is here rather than in a checklist.
 *
 * Creates a DRAFT release and uploads the complete artifact set. Promoting the
 * draft to published is a separate, deliberate step, because that is the moment
 * every installed copy starts offering the update.
 *
 * Usage:
 *   node scripts/release-publish.mjs --tag v0.1.1 --dry-run
 *   node scripts/release-publish.mjs --tag v0.1.1 --confirm
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}
const flag = (name) => process.argv.includes(`--${name}`);

const tag = arg('tag');
const releaseDir = resolve(root, arg('dir', 'release'));
const dryRun = flag('dry-run') || !flag('confirm');
const repo = arg('repo', 'the-x1x1/ChargeTracker-App');

if (!tag) {
  console.error('A tag is required: node scripts/release-publish.mjs --tag v0.1.1 --dry-run');
  process.exit(1);
}
if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error(`"${tag}" is not a valid version tag (expected vMAJOR.MINOR.PATCH).`);
  process.exit(1);
}

// ------------------------------------------------------------ the verify gate

console.log('Running release verification first…\n');
const verify = spawnSync(
  process.execPath,
  [
    '--experimental-strip-types',
    '--no-warnings',
    join(here, 'release-verify.mjs'),
    '--dir',
    releaseDir,
  ],
  { cwd: root, stdio: 'inherit' },
);
if (verify.status !== 0) {
  console.error('\nVerification failed, so nothing will be published.');
  process.exit(1);
}

// -------------------------------------------------------------- the artifacts

const manifest = JSON.parse(readFileSync(join(releaseDir, 'release-manifest.json'), 'utf8'));
if (manifest.tag !== tag) {
  console.error(
    `\nThe manifest is for ${manifest.tag} but ${tag} was requested. They must match, or an installed ` +
      'copy will reject the release as a tag mismatch.',
  );
  process.exit(1);
}

const REQUIRED = [
  'release-manifest.json',
  'release-manifest.json.sig',
  'SHA256SUMS.txt',
  'build-info.json',
];
const uploadable = readdirSync(releaseDir).filter((name) => {
  const path = join(releaseDir, name);
  if (!statSync(path).isFile()) return false;
  // Never upload a key, a credential or a database, whatever it is called.
  if (/(private|secret|\.env$|\.sqlite$)/i.test(name)) return false;
  if (/\.pem$/i.test(name) && !/\.pub\.pem$/i.test(name)) return false;
  return true;
});

const missing = REQUIRED.filter((name) => !uploadable.includes(name));
if (missing.length > 0) {
  console.error(`\nThe release is missing required assets: ${missing.join(', ')}`);
  process.exit(1);
}

// ------------------------------------------------------------- release notes

const notesPath = join(tmpdir(), `chargewatch-release-notes-${tag}.md`);
const changelog = existsSync(join(root, 'CHANGELOG.md'))
  ? readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  : '';
const version = tag.slice(1);
const section = extractChangelogSection(changelog, version);

// A real multiline file, not shell-escaped pseudo-newlines.
const notes = `## ChargeWatch ${version}

${section ?? '_No changelog entry was found for this version._'}

### Supported data sources

See \`docs/SOURCES.md\` in this release for the current source list and the
eligibility basis for each. A network appearing in the station catalog is not a
claim that ChargeWatch can observe it.

### Compatibility

- Windows 11 x64. No other Windows version or architecture is claimed.
- History schema: ${manifest.readableDbSchemaMin}–${manifest.readableDbSchemaMax} readable, ${manifest.writableDbSchema} written.
- Requires ChargeWatch ${manifest.minimumSupportedAppVersion} or newer to update in place.${
  manifest.requiredIntermediateVersion
    ? `\n- Copies older than ${manifest.requiredIntermediateVersion} must install that version first: upgrading directly would skip a required data migration.`
    : ''
}

### Updating and recovery

Updates are verified against an Ed25519 key embedded in your installed copy
before they can be installed. A failed verification leaves your installation and
your history unchanged. \`docs/UPDATES_AND_RECOVERY.md\` covers recovery.

This installer is **not** code-signed, so Windows SmartScreen may warn on first
run. That is a consequence of free distribution and is separate from
ChargeWatch's own signature check.

### Verifying this download by hand

\`\`\`powershell
Get-FileHash .\\${manifest.artifacts.find((a) => a.kind === 'installer')?.fileName ?? 'ChargeWatch-Setup.exe'} -Algorithm SHA256
\`\`\`

Compare with \`SHA256SUMS.txt\`.

### Known limitations

Read \`docs/VERIFICATION_REPORT.md\` in this release. It lists, per item, what
was actually tested and what was not.

---

Build commit: \`${manifest.buildCommit}\`
Release sequence: ${manifest.releaseSequence}
`;

writeFileSync(notesPath, notes, 'utf8');

// -------------------------------------------------------------------- report

console.log(`\nRelease ${tag} → ${repo}\n`);
console.log(`  assets (${uploadable.length}):`);
for (const name of uploadable) {
  const bytes = statSync(join(releaseDir, name)).size;
  console.log(`    ${name.padEnd(42)} ${(bytes / (1024 * 1024)).toFixed(2).padStart(8)} MB`);
}
console.log(`\n  notes: ${notesPath}`);

const ghArgs = [
  'release',
  'create',
  tag,
  '--repo',
  repo,
  '--title',
  `ChargeWatch ${version}`,
  '--notes-file',
  notesPath,
  // A DRAFT. Promoting it is a separate action, because publishing is the
  // moment every installed copy starts offering this update.
  '--draft',
  ...uploadable.map((name) => join(releaseDir, name)),
];

if (dryRun) {
  console.log('\n--- DRY RUN: nothing was published ---\n');
  console.log('The command that would run:\n');
  console.log(
    `  gh ${ghArgs.map((part) => (part.includes(' ') ? `"${part}"` : part)).join(' ')}\n`,
  );
  console.log('To create the draft release for real, re-run with --confirm.');
  console.log('After that, inspect the uploaded assets on GitHub and then publish the draft:');
  console.log(`  gh release edit ${tag} --repo ${repo} --draft=false\n`);
  console.log(
    'Publishing is deliberately a separate step. Once the draft is published, every installed\n' +
      'copy will discover and offer this update.',
  );
  process.exit(0);
}

try {
  execFileSync('gh', ['--version'], { stdio: 'ignore' });
} catch {
  console.error(
    '\nThe GitHub CLI (gh) is not available, so the release cannot be created from here.',
  );
  console.error('Install it, or create the release manually with the assets listed above.');
  process.exit(1);
}

console.log('\nCreating the draft release…');
const result = spawnSync('gh', ghArgs, { cwd: root, stdio: 'inherit' });
if (result.status !== 0) {
  console.error('\nThe release was not created. Nothing was published.');
  process.exit(result.status ?? 1);
}

console.log(`\nDraft release ${tag} created with ${uploadable.length} asset(s).`);
console.log('\nBefore publishing:');
console.log('  1. Open the draft on GitHub and check every asset uploaded completely.');
console.log('  2. Install the artifact on a clean Windows profile and confirm it runs.');
console.log('  3. Then publish:');
console.log(`       gh release edit ${tag} --repo ${repo} --draft=false`);
console.log('  4. Confirm an existing installed client discovers it.');

/** Pulls the section for `version` out of a Keep a Changelog style file. */
function extractChangelogSection(text, wanted) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^##\s/.test(line) && line.includes(wanted));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}
