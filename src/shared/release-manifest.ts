/**
 * The signed release manifest (§25).
 *
 * Free, unsigned Windows distribution means Windows itself will not vouch for
 * our installer. That is a separate problem from the one this module solves.
 * What this gives us is APPLICATION-LEVEL authenticity: an Ed25519 signature
 * over the exact manifest bytes, verified against a public key embedded in the
 * installed application.
 *
 * What it does NOT do, stated plainly because it is easy to overclaim:
 *  - It does not make Windows treat an unsigned binary as Authenticode-signed.
 *  - It does not remove SmartScreen prompts.
 *  - The standard updater's own checksums provide integrity, not authenticity;
 *    they are not a substitute for a trusted signing key.
 *
 * Signing rule that matters most: we sign the EXACT UTF-8 bytes written to
 * disk, and we verify those same bytes before parsing the payload. There is no
 * JSON canonicalisation scheme to get subtly wrong.
 */

import {
  createHash,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { type Infer, v } from './validate.ts';

export const MANIFEST_FORMAT_VERSION = 1;
export const MANIFEST_FILE_NAME = 'release-manifest.json';
export const SIGNATURE_FILE_NAME = 'release-manifest.json.sig';

/** The detached signature encoding. Stated so both ends agree. */
export const SIGNATURE_ENCODING = 'base64' as const;

/** The update protocol this build speaks. */
export const UPDATE_PROTOCOL_VERSION = 1;

export const artifactSchema = v.object({
  fileName: v
    .string({ min: 1, max: 255 })
    // No path separators, no traversal, no drive letters: an artifact name is
    // a bare file name that must match a release asset exactly.
    .refine((name) => !/[\\/]/.test(name), 'an artifact file name may not contain a path separator')
    .refine((name) => !name.includes('..'), 'an artifact file name may not contain ".."')
    .refine((name) => !/^[a-zA-Z]:/.test(name), 'an artifact file name may not be drive-qualified'),
  byteSize: v.integer({ min: 1, max: 8 * 1024 * 1024 * 1024 }),
  sha256: v.string({ pattern: /^[0-9a-f]{64}$/ }),
  sha512: v.string({ pattern: /^[0-9a-f]{128}$/ }),
  kind: v.enumOf(['installer', 'portable_zip', 'blockmap', 'updater_metadata'] as const),
});

export const manifestSchema = v.object({
  manifestFormatVersion: v.integer({ min: 1, max: 100 }),
  keyId: v.string({ min: 4, max: 64, pattern: /^[A-Za-z0-9_-]+$/ }),
  applicationId: v.string({ min: 1, max: 128 }),
  releaseVersion: v.string({ min: 1, max: 64, pattern: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/ }),
  tag: v.string({ min: 1, max: 128 }),
  channel: v.enumOf(['stable', 'beta', 'alpha'] as const),
  platform: v.enumOf(['win32', 'darwin', 'linux'] as const),
  arch: v.enumOf(['x64', 'arm64', 'ia32'] as const),
  /** Monotonically increasing; a lower value than we have seen is a replay. */
  releaseSequence: v.integer({ min: 1, max: 1_000_000_000 }),
  minimumSupportedAppVersion: v.string({ pattern: /^\d+\.\d+\.\d+$/ }),
  minimumUpdateProtocolVersion: v.integer({ min: 1, max: 1000 }),
  readableDbSchemaMin: v.integer({ min: 1, max: 100_000 }),
  readableDbSchemaMax: v.integer({ min: 1, max: 100_000 }),
  writableDbSchema: v.integer({ min: 1, max: 100_000 }),
  /** Set when a direct upgrade from an older version is unsafe. */
  requiredIntermediateVersion: v.string({ pattern: /^\d+\.\d+\.\d+$/ }).nullable(),
  artifacts: v.array(artifactSchema, { min: 1, max: 32 }),
  /** Digest of the updater's own metadata file, e.g. latest.yml. */
  updaterMetadataSha256: v.string({ pattern: /^[0-9a-f]{64}$/ }),
  updaterMetadataFileName: v.string({ min: 1, max: 255 }),
  buildCommit: v.string({ min: 7, max: 64, pattern: /^[0-9a-f]+$/ }),
  buildTimeMs: v.instant(),
});

export type ReleaseManifest = Infer<typeof manifestSchema>;

export interface TrustedKey {
  readonly keyId: string;
  /** SPKI PEM. Only PUBLIC keys are ever embedded in the application. */
  readonly publicKeyPem: string;
  /** Superseded keys stay trusted for verification until rotation completes. */
  readonly retired: boolean;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha512Hex(data: Uint8Array | string): string {
  return createHash('sha512').update(data).digest('hex');
}

/** Signs the exact bytes given. Callers pass the bytes they wrote to disk. */
export function signManifestBytes(manifestBytes: Uint8Array, privateKey: KeyObject): string {
  // Ed25519 signs the message directly; there is no separate digest algorithm.
  return cryptoSign(null, manifestBytes, privateKey).toString(SIGNATURE_ENCODING);
}

export type VerificationFailureCode =
  | 'unknown_key_id'
  | 'retired_key'
  | 'bad_signature'
  | 'malformed_manifest'
  | 'malformed_signature'
  | 'unsupported_manifest_format'
  | 'unsupported_update_protocol'
  | 'wrong_application'
  | 'wrong_platform'
  | 'wrong_arch'
  | 'wrong_channel'
  | 'version_mismatch'
  | 'tag_mismatch'
  | 'replayed_sequence'
  | 'schema_unsupported'
  | 'unexpected_artifact'
  | 'artifact_missing';

export interface VerificationContext {
  readonly trustedKeys: readonly TrustedKey[];
  readonly applicationId: string;
  readonly platform: 'win32' | 'darwin' | 'linux';
  readonly arch: 'x64' | 'arm64' | 'ia32';
  readonly acceptedChannels: readonly ('stable' | 'beta' | 'alpha')[];
  readonly updateProtocolVersion: number;
  /** The highest sequence this installation has ever accepted. */
  readonly highestAcceptedSequence: number;
  /** Schema version this build can write. */
  readonly writableDbSchema: number;
  /** Version and tag the updater independently believes it found. */
  readonly candidateVersion: string | null;
  readonly candidateTag: string | null;
  /** Artifact names the release actually contains. */
  readonly availableArtifactNames: readonly string[];
}

export type VerificationResult =
  | { readonly ok: true; readonly manifest: ReleaseManifest; readonly keyId: string }
  | { readonly ok: false; readonly code: VerificationFailureCode; readonly detail: string };

/**
 * Verifies a manifest.
 *
 * Order is deliberate: the signature over the raw bytes is checked FIRST, so
 * nothing in an unauthenticated payload can influence a decision. Only then is
 * the payload parsed and its claims checked against this installation.
 */
export function verifyManifest(
  manifestBytes: Uint8Array,
  signatureBase64: string,
  context: VerificationContext,
): VerificationResult {
  if (typeof signatureBase64 !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(signatureBase64)) {
    return { ok: false, code: 'malformed_signature', detail: 'the signature is not base64' };
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64.trim(), SIGNATURE_ENCODING);
  } catch {
    return { ok: false, code: 'malformed_signature', detail: 'the signature could not be decoded' };
  }
  if (signature.length !== 64) {
    return {
      ok: false,
      code: 'malformed_signature',
      detail: `an Ed25519 signature is 64 bytes; received ${signature.length}`,
    };
  }

  // The key id is read from the payload only to SELECT a candidate key. It
  // grants nothing: the signature must still verify under that key.
  let declaredKeyId: string | null = null;
  try {
    const peek = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as { keyId?: unknown };
    if (typeof peek.keyId === 'string') declaredKeyId = peek.keyId;
  } catch {
    return { ok: false, code: 'malformed_manifest', detail: 'the manifest is not valid JSON' };
  }

  const candidates = declaredKeyId
    ? context.trustedKeys.filter((key) => key.keyId === declaredKeyId)
    : [];
  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'unknown_key_id',
      detail: `no embedded key matches key id ${String(declaredKeyId)}`,
    };
  }
  if (candidates.every((key) => key.retired)) {
    return {
      ok: false,
      code: 'retired_key',
      detail: `key ${String(declaredKeyId)} has been retired`,
    };
  }

  let verifiedKeyId: string | null = null;
  for (const key of candidates) {
    if (key.retired) continue;
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey(key.publicKeyPem);
    } catch {
      continue;
    }
    if (cryptoVerify(null, manifestBytes, publicKey, signature)) {
      verifiedKeyId = key.keyId;
      break;
    }
  }
  if (!verifiedKeyId) {
    return {
      ok: false,
      code: 'bad_signature',
      detail: 'the signature does not verify against any trusted key',
    };
  }

  // Only now is the payload trusted enough to parse and act on.
  const parsed = manifestSchema.safeParse(
    JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as unknown,
  );
  if (!parsed.ok) {
    return {
      ok: false,
      code: 'malformed_manifest',
      detail: parsed.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    };
  }
  const manifest = parsed.value;

  if (manifest.manifestFormatVersion !== MANIFEST_FORMAT_VERSION) {
    return {
      ok: false,
      code: 'unsupported_manifest_format',
      detail: `manifest format ${manifest.manifestFormatVersion} is not supported by this build`,
    };
  }
  if (manifest.minimumUpdateProtocolVersion > context.updateProtocolVersion) {
    return {
      ok: false,
      code: 'unsupported_update_protocol',
      detail: `this release needs update protocol ${manifest.minimumUpdateProtocolVersion}; this build speaks ${context.updateProtocolVersion}`,
    };
  }
  if (manifest.applicationId !== context.applicationId) {
    return {
      ok: false,
      code: 'wrong_application',
      detail: `manifest is for ${manifest.applicationId}, not ${context.applicationId}`,
    };
  }
  if (manifest.platform !== context.platform) {
    return {
      ok: false,
      code: 'wrong_platform',
      detail: `manifest targets ${manifest.platform}, not ${context.platform}`,
    };
  }
  if (manifest.arch !== context.arch) {
    return {
      ok: false,
      code: 'wrong_arch',
      detail: `manifest targets ${manifest.arch}, not ${context.arch}`,
    };
  }
  if (!context.acceptedChannels.includes(manifest.channel)) {
    return {
      ok: false,
      code: 'wrong_channel',
      detail: `channel ${manifest.channel} is not accepted by this installation`,
    };
  }
  if (context.candidateVersion !== null && manifest.releaseVersion !== context.candidateVersion) {
    return {
      ok: false,
      code: 'version_mismatch',
      detail: `manifest says ${manifest.releaseVersion} but the updater found ${context.candidateVersion}`,
    };
  }
  if (context.candidateTag !== null && manifest.tag !== context.candidateTag) {
    return {
      ok: false,
      code: 'tag_mismatch',
      detail: `manifest says tag ${manifest.tag} but the updater found ${context.candidateTag}`,
    };
  }
  // A downgrade is refused. Fixing a bad release means publishing a HIGHER
  // version, never silently reinstalling an older one.
  if (manifest.releaseSequence <= context.highestAcceptedSequence) {
    return {
      ok: false,
      code: 'replayed_sequence',
      detail: `release sequence ${manifest.releaseSequence} is not newer than the highest accepted (${context.highestAcceptedSequence})`,
    };
  }
  if (
    context.writableDbSchema < manifest.readableDbSchemaMin ||
    context.writableDbSchema > manifest.readableDbSchemaMax
  ) {
    return {
      ok: false,
      code: 'schema_unsupported',
      detail:
        `this installation writes schema ${context.writableDbSchema}, outside the release's readable range ` +
        `${manifest.readableDbSchemaMin}-${manifest.readableDbSchemaMax}`,
    };
  }

  // Every artifact the manifest names must exist in the release, and the
  // release must not be missing one we intend to download.
  const available = new Set(context.availableArtifactNames);
  for (const artifact of manifest.artifacts) {
    if (!available.has(artifact.fileName)) {
      return {
        ok: false,
        code: 'artifact_missing',
        detail: `the release does not contain ${artifact.fileName}`,
      };
    }
  }
  if (!available.has(manifest.updaterMetadataFileName)) {
    return {
      ok: false,
      code: 'artifact_missing',
      detail: `the release does not contain ${manifest.updaterMetadataFileName}`,
    };
  }

  return { ok: true, manifest, keyId: verifiedKeyId };
}

export type ArtifactCheckFailure =
  'not_in_manifest' | 'size_mismatch' | 'sha256_mismatch' | 'sha512_mismatch';

export interface ArtifactCheckResult {
  readonly ok: boolean;
  readonly code?: ArtifactCheckFailure;
  readonly detail?: string;
}

/**
 * Verifies the FINAL downloaded bytes against the signed manifest.
 *
 * This is checked after download and AGAIN before installing a file that has
 * been sitting in the cache, because a verified-then-cached artifact can be
 * replaced on disk between the two moments.
 */
export function verifyArtifactBytes(
  fileName: string,
  bytes: Uint8Array,
  manifest: ReleaseManifest,
): ArtifactCheckResult {
  const artifact = manifest.artifacts.find((entry) => entry.fileName === fileName);
  if (!artifact) {
    return {
      ok: false,
      code: 'not_in_manifest',
      detail: `${fileName} is not named in the manifest`,
    };
  }
  if (bytes.byteLength !== artifact.byteSize) {
    return {
      ok: false,
      code: 'size_mismatch',
      detail: `${fileName} is ${bytes.byteLength} bytes; the manifest says ${artifact.byteSize}`,
    };
  }
  if (sha256Hex(bytes) !== artifact.sha256) {
    return { ok: false, code: 'sha256_mismatch', detail: `${fileName} failed its SHA-256 check` };
  }
  if (sha512Hex(bytes) !== artifact.sha512) {
    return { ok: false, code: 'sha512_mismatch', detail: `${fileName} failed its SHA-512 check` };
  }
  return { ok: true };
}

/**
 * Restricts downloads to the configured release source and its legitimate
 * asset redirects. Signature and digest checks remain authoritative, so this
 * is defence in depth rather than the security boundary.
 */
export function isPermittedDownloadUrl(
  rawUrl: string,
  configured: { readonly owner: string; readonly repo: string },
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;

  const releasePrefix = `/${configured.owner}/${configured.repo}/releases/`;
  if (url.host === 'github.com') return url.pathname.startsWith(releasePrefix);
  if (url.host === 'api.github.com') {
    return url.pathname.startsWith(`/repos/${configured.owner}/${configured.repo}/releases`);
  }
  // GitHub redirects release asset downloads to its object storage.
  if (
    url.host === 'objects.githubusercontent.com' ||
    url.host === 'release-assets.githubusercontent.com'
  ) {
    return true;
  }
  return false;
}

/**
 * Whether a manifest's upgrade path is safe to take directly.
 *
 * When a release declares a required intermediate version, jumping straight to
 * it would skip a migration that must not be skipped.
 */
export function isDirectUpgradePermitted(
  manifest: ReleaseManifest,
  installedVersion: string,
): { permitted: boolean; reason: string | null } {
  if (compareSemver(installedVersion, manifest.minimumSupportedAppVersion) < 0) {
    return {
      permitted: false,
      reason:
        `This release requires ChargeWatch ${manifest.minimumSupportedAppVersion} or newer; ` +
        `this installation is ${installedVersion}.`,
    };
  }
  if (manifest.requiredIntermediateVersion !== null) {
    if (compareSemver(installedVersion, manifest.requiredIntermediateVersion) < 0) {
      return {
        permitted: false,
        reason:
          `Install ChargeWatch ${manifest.requiredIntermediateVersion} first: upgrading directly from ` +
          `${installedVersion} would skip a required data migration.`,
      };
    }
  }
  return { permitted: true, reason: null };
}

/** Compares two `major.minor.patch[-prerelease]` versions. */
export function compareSemver(a: string, b: string): number {
  const parse = (value: string): number[] => {
    const core = value.split('-')[0] ?? '0.0.0';
    return core.split('.').map((part) => Number.parseInt(part, 10) || 0);
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  const preA = a.includes('-') ? (a.split('-')[1] ?? '') : '';
  const preB = b.includes('-') ? (b.split('-')[1] ?? '') : '';
  if (preA === preB) return 0;
  // A release without a prerelease tag outranks one with it.
  if (preA === '') return 1;
  if (preB === '') return -1;
  return preA < preB ? -1 : 1;
}
