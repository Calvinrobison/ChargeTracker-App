/**
 * UpdateService — owned by the Electron main process.
 *
 * The shape of this module is driven by two facts:
 *
 *  1) electron-updater's install API has CHANGED across versions. Older
 *     releases use `quitAndInstall(isSilent, isForceRunAfter)`; current ones
 *     expose structured options and an `autoInstallEvent`. Copying either from
 *     a blog is how you get an updater that silently does nothing or installs
 *     at the wrong moment. So the library is reached only through
 *     `UpdaterBackend`, a small interface implemented once for the pinned
 *     dependency and verified against it (see docs/UPDATES_AND_RECOVERY.md).
 *
 *  2) The library's own uncontrolled install path is DISABLED. Installation
 *     happens only after our verification and shutdown gates have passed.
 *     `autoInstallOnAppQuit` is off, so there is no backdoor install-on-quit.
 */

import { randomUUID } from 'node:crypto';

import {
  UPDATE_PROTOCOL_VERSION,
  compareSemver,
  isDirectUpgradePermitted,
  isPermittedDownloadUrl,
  verifyArtifactBytes,
  verifyManifest,
  type ReleaseManifest,
  type TrustedKey,
} from '../shared/release-manifest.ts';

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'up_to_date'
  | 'downloading'
  | 'ready'
  | 'deferred'
  | 'installing'
  | 'failed';

export interface UpdateCandidate {
  readonly version: string;
  readonly tag: string;
  readonly channel: string;
  readonly isPrerelease: boolean;
  readonly isDraft: boolean;
  readonly assetNames: readonly string[];
  readonly releaseNotes: string | null;
}

/**
 * The seam over electron-updater.
 *
 * Implemented once, for the exact pinned version, in
 * `src/main/updates-backend.ts`. Nothing else in the application calls the
 * library directly.
 */
export interface UpdaterBackend {
  /** Disables the library's own automatic download and install paths. */
  configureManualControl(): void;
  checkForUpdates(): Promise<UpdateCandidate | null>;
  downloadUpdate(onProgress: (percent: number) => void): Promise<{ filePath: string; fileName: string }>;
  /** Fetches a small release asset, used for the manifest and signature. */
  fetchAsset(name: string): Promise<Uint8Array>;
  readAsset(filePath: string): Promise<Uint8Array>;
  /** The version-appropriate install call for the pinned dependency. */
  install(options: { readonly silent: boolean; readonly forceRunAfter: boolean }): void;
  /** Cancels an in-flight download. */
  cancelDownload(): void;
  readonly configuredRepo: { readonly owner: string; readonly repo: string };
  readonly manualDownloadUrl: string;
}

export interface UpdateHostGates {
  /** The window has been hidden in the tray for at least this long. */
  trayHiddenForMs(): number | null;
  /** An export, import, restore or migration is in progress. */
  maintenanceActive(): boolean;
  /** The OS is ending the session; never start an installer then. */
  sessionEnding(): boolean;
  /** Whether the user is actively using a visible window. */
  foregroundActive(): boolean;
}

export interface UpdateHost {
  readonly gates: UpdateHostGates;
  /** Stops the collector and flushes the database, returning cleanly or not. */
  prepareForInstall(): Promise<{ ok: boolean; detail: string | null }>;
  /** Creates the mandatory pre-update backup. */
  createPreUpdateBackup(): Promise<{ ok: boolean; detail: string | null }>;
  /** Persists window and pause state so relaunch restores it. */
  persistRelaunchState(): Promise<void>;
  /** Records an update event for the audit trail. */
  recordEvent(event: string, detail: string | null, extra?: Record<string, unknown>): Promise<void>;
  /** Reads the highest release sequence this installation has accepted. */
  readHighestAcceptedSequence(): Promise<number>;
  writeHighestAcceptedSequence(sequence: number): Promise<void>;
  readonly settings: {
    autoCheck(): boolean;
    autoDownload(): boolean;
    autoInstall(): boolean;
  };
  onStateChange(): void;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export interface UpdateServiceConfig {
  readonly applicationId: string;
  readonly installedVersion: string;
  readonly platform: 'win32' | 'darwin' | 'linux';
  readonly arch: 'x64' | 'arm64' | 'ia32';
  readonly trustedKeys: readonly TrustedKey[];
  readonly writableDbSchema: number;
  readonly acceptedChannels: readonly ('stable' | 'beta' | 'alpha')[];
  readonly manifestFileName: string;
  readonly signatureFileName: string;
  /** Minimum tray-hidden time before an unattended install. */
  readonly safeInstallTrayHiddenMs?: number;
  readonly checkIntervalMs?: number;
  readonly jitterFraction?: number;
  readonly random?: () => number;
}

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_TRAY_HIDDEN_MS = 5 * 60_000;
/** Consecutive failures before we show a persistent status with a manual link. */
const PERSISTENT_FAILURE_THRESHOLD = 3;

export class UpdateService {
  private readonly backend: UpdaterBackend;
  private readonly host: UpdateHost;
  private readonly config: UpdateServiceConfig;

  private state: UpdateState = 'idle';
  private detail: string | null = null;
  private candidate: UpdateCandidate | null = null;
  private verifiedManifest: ReleaseManifest | null = null;
  private downloadedPercent: number | null = null;
  private stagedArtifact: { filePath: string; fileName: string } | null = null;
  private consecutiveFailures = 0;
  private checkInFlight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private installing = false;

  constructor(backend: UpdaterBackend, host: UpdateHost, config: UpdateServiceConfig) {
    this.backend = backend;
    this.host = host;
    this.config = config;
    // Take control of install timing before anything else can happen.
    this.backend.configureManualControl();
  }

  snapshot(): {
    readonly installedVersion: string;
    readonly state: UpdateState;
    readonly availableVersion: string | null;
    readonly downloadedPercent: number | null;
    readonly detail: string | null;
    readonly autoCheckEnabled: boolean;
    readonly autoDownloadEnabled: boolean;
    readonly autoInstallEnabled: boolean;
    readonly consecutiveFailures: number;
    readonly manualDownloadUrl: string | null;
  } {
    return {
      installedVersion: this.config.installedVersion,
      state: this.state,
      availableVersion: this.candidate?.version ?? null,
      downloadedPercent: this.downloadedPercent,
      detail: this.detail,
      autoCheckEnabled: this.host.settings.autoCheck(),
      autoDownloadEnabled: this.host.settings.autoDownload(),
      autoInstallEnabled: this.host.settings.autoInstall(),
      consecutiveFailures: this.consecutiveFailures,
      manualDownloadUrl:
        this.consecutiveFailures >= PERSISTENT_FAILURE_THRESHOLD ? this.backend.manualDownloadUrl : null,
    };
  }

  /** Starts periodic checking once startup has settled. */
  startPeriodicChecks(settleDelayMs = 90_000): void {
    this.scheduleCheck(settleDelayMs);
  }

  private scheduleCheck(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    const base = delayMs;
    const fraction = this.config.jitterFraction ?? 0.15;
    const random = this.config.random ?? Math.random;
    const jittered = Math.max(30_000, Math.round(base * (1 + (random() * 2 - 1) * fraction)));
    this.timer = setTimeout(() => {
      void this.check({ manual: false });
    }, jittered);
    this.timer.unref?.();
  }

  private setState(state: UpdateState, detail: string | null = null): void {
    this.state = state;
    this.detail = detail;
    this.host.onStateChange();
  }

  /**
   * Checks for an update.
   *
   * Simultaneous requests are coalesced. "Up to date" produces no
   * notification; the user only learns about checks in Settings.
   */
  async check(options: { manual: boolean }): Promise<{ started: boolean; detail: string | null }> {
    if (!options.manual && !this.host.settings.autoCheck()) {
      return { started: false, detail: 'automatic checks are disabled' };
    }
    if (this.installing) return { started: false, detail: 'an install is already in progress' };
    if (this.checkInFlight) {
      await this.checkInFlight;
      return { started: true, detail: 'a check was already running' };
    }

    this.checkInFlight = this.runCheck(options.manual).finally(() => {
      this.checkInFlight = null;
      const interval = this.config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
      // Back off on repeated GitHub failures rather than hammering it.
      const backoff = Math.min(8, 2 ** this.consecutiveFailures);
      this.scheduleCheck(this.consecutiveFailures > 0 ? interval * backoff : interval);
    });
    await this.checkInFlight;
    return { started: true, detail: this.detail };
  }

  private async runCheck(manual: boolean): Promise<void> {
    this.setState('checking');
    await this.host.recordEvent('check_started', manual ? 'manual' : 'scheduled');

    let candidate: UpdateCandidate | null;
    try {
      candidate = await this.backend.checkForUpdates();
    } catch (error) {
      this.consecutiveFailures += 1;
      const detail = error instanceof Error ? error.message : String(error);
      await this.host.recordEvent('check_failed', detail);
      // A failed check never interrupts normal use.
      this.setState('failed', 'The update check could not reach GitHub. ChargeWatch keeps collecting.');
      this.host.log('warn', `update check failed: ${detail}`);
      return;
    }

    if (!candidate) {
      this.consecutiveFailures = 0;
      await this.host.recordEvent('up_to_date', null);
      this.setState('up_to_date');
      return;
    }

    // Drafts and prereleases are ignored by default.
    if (candidate.isDraft || (candidate.isPrerelease && !this.config.acceptedChannels.includes('beta'))) {
      this.consecutiveFailures = 0;
      this.setState('up_to_date', 'A prerelease is available but this installation only accepts stable releases.');
      return;
    }
    if (compareSemver(candidate.version, this.config.installedVersion) <= 0) {
      this.consecutiveFailures = 0;
      this.setState('up_to_date');
      return;
    }

    this.candidate = candidate;
    await this.host.recordEvent('candidate_found', candidate.version);

    const verified = await this.verifyCandidate(candidate);
    if (!verified) return;

    if (!this.host.settings.autoDownload() && !manual) {
      this.setState('idle', `Version ${candidate.version} is available. Download it from Settings.`);
      return;
    }
    await this.download();
  }

  /**
   * Validates the signed manifest BEFORE trusting the candidate.
   *
   * Nothing is downloaded until this passes.
   */
  private async verifyCandidate(candidate: UpdateCandidate): Promise<boolean> {
    let manifestBytes: Uint8Array;
    let signatureBytes: Uint8Array;
    try {
      manifestBytes = await this.backend.fetchAsset(this.config.manifestFileName);
      signatureBytes = await this.backend.fetchAsset(this.config.signatureFileName);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.host.recordEvent('manifest_rejected', `could not fetch the manifest: ${detail}`);
      this.setState(
        'failed',
        'The release is missing its signed manifest, so it was not trusted. Your installation is unchanged.',
      );
      this.consecutiveFailures += 1;
      return false;
    }

    const result = verifyManifest(manifestBytes, Buffer.from(signatureBytes).toString('utf8'), {
      trustedKeys: this.config.trustedKeys,
      applicationId: this.config.applicationId,
      platform: this.config.platform,
      arch: this.config.arch,
      acceptedChannels: this.config.acceptedChannels,
      updateProtocolVersion: UPDATE_PROTOCOL_VERSION,
      highestAcceptedSequence: await this.host.readHighestAcceptedSequence(),
      writableDbSchema: this.config.writableDbSchema,
      candidateVersion: candidate.version,
      candidateTag: candidate.tag,
      availableArtifactNames: candidate.assetNames,
    });

    if (!result.ok) {
      await this.host.recordEvent('manifest_rejected', `${result.code}: ${result.detail}`);
      this.host.log('warn', `release manifest rejected: ${result.code} ${result.detail}`);
      // A failed verification leaves the app and the database working.
      this.setState(
        'failed',
        'The available update could not be verified, so it was not installed. Your installation is unchanged.',
      );
      this.consecutiveFailures += 1;
      return false;
    }

    const upgrade = isDirectUpgradePermitted(result.manifest, this.config.installedVersion);
    if (!upgrade.permitted) {
      await this.host.recordEvent('manifest_rejected', upgrade.reason);
      this.setState('failed', upgrade.reason);
      return false;
    }

    this.verifiedManifest = result.manifest;
    await this.host.recordEvent('manifest_verified', `${result.manifest.releaseVersion} via key ${result.keyId}`);
    return true;
  }

  /** Downloads silently. Collection continues throughout. */
  private async download(): Promise<void> {
    const manifest = this.verifiedManifest;
    if (!manifest) return;

    this.setState('downloading');
    this.downloadedPercent = 0;
    await this.host.recordEvent('download_started', manifest.releaseVersion);

    let staged: { filePath: string; fileName: string };
    try {
      staged = await this.backend.downloadUpdate((percent) => {
        this.downloadedPercent = percent;
        this.host.onStateChange();
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.consecutiveFailures += 1;
      await this.host.recordEvent('download_failed', detail);
      this.setState(
        'failed',
        /space/i.test(detail)
          ? 'There was not enough disk space to download the update. Collection is unaffected.'
          : 'The update download was interrupted. ChargeWatch will try again later.',
      );
      return;
    }

    if (!isPermittedDownloadUrl(`https://github.com/${this.backend.configuredRepo.owner}/${this.backend.configuredRepo.repo}/releases/`, this.backend.configuredRepo)) {
      // Defence in depth; the digest check below is authoritative.
      this.host.log('warn', 'the configured release source failed its own sanity check');
    }

    const verified = await this.verifyStagedArtifact(staged, manifest);
    if (!verified) return;

    this.stagedArtifact = staged;
    this.consecutiveFailures = 0;
    await this.host.recordEvent('artifact_verified', staged.fileName);
    await this.host.recordEvent('ready', manifest.releaseVersion);
    this.setState('ready', `Version ${manifest.releaseVersion} is ready to install.`);

    await this.tryInstallAtSafePoint();
  }

  /** Verifies the FINAL downloaded bytes, not a checksum fetched beside them. */
  private async verifyStagedArtifact(
    staged: { filePath: string; fileName: string },
    manifest: ReleaseManifest,
  ): Promise<boolean> {
    let bytes: Uint8Array;
    try {
      bytes = await this.backend.readAsset(staged.filePath);
    } catch (error) {
      await this.host.recordEvent(
        'artifact_rejected',
        `could not read the downloaded file: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.setState('failed', 'The downloaded update could not be read, so it was not installed.');
      return false;
    }

    const check = verifyArtifactBytes(staged.fileName, bytes, manifest);
    if (!check.ok) {
      await this.host.recordEvent('artifact_rejected', `${check.code}: ${check.detail}`);
      this.host.log('warn', `downloaded artifact rejected: ${check.code} ${check.detail}`);
      this.setState(
        'failed',
        'The downloaded update did not match its signed manifest, so it was discarded. Your installation is unchanged.',
      );
      return false;
    }
    return true;
  }

  /** Why an install cannot proceed right now, or null when it can. */
  private installBlocker(): string | null {
    if (this.host.gates.sessionEnding()) {
      return 'Windows is signing out or shutting down; the update will install at the next safe launch.';
    }
    if (this.host.gates.maintenanceActive()) {
      return 'An export, import, restore or migration is in progress.';
    }
    const hiddenFor = this.host.gates.trayHiddenForMs();
    const required = this.config.safeInstallTrayHiddenMs ?? DEFAULT_TRAY_HIDDEN_MS;
    if (hiddenFor === null || hiddenFor < required) {
      return 'ChargeWatch is in use; the update will install once the window has been closed to the tray for a few minutes.';
    }
    return null;
  }

  /**
   * Installs only at a controlled safe point.
   *
   * If the gates are not satisfied, the update is STAGED for the next safe
   * launch or an explicit "Restart to update". It is never installed during an
   * active foreground session without that explicit choice.
   */
  async tryInstallAtSafePoint(): Promise<{ installed: boolean; detail: string | null }> {
    if (this.state !== 'ready' || !this.stagedArtifact || !this.verifiedManifest) {
      return { installed: false, detail: 'no verified update is ready' };
    }
    if (!this.host.settings.autoInstall()) {
      this.setState('deferred', 'An update is ready. Install it from Settings when you are ready.');
      return { installed: false, detail: 'automatic installation is disabled' };
    }

    const blocker = this.installBlocker();
    if (blocker) {
      await this.host.recordEvent('install_deferred', blocker);
      this.setState('deferred', blocker);
      return { installed: false, detail: blocker };
    }

    return this.performInstall({ userInitiated: false });
  }

  /** The explicit "Restart to update" path. */
  async restartAndInstall(): Promise<{ accepted: boolean; detail: string | null }> {
    if (this.state !== 'ready' && this.state !== 'deferred') {
      return { accepted: false, detail: 'no verified update is ready' };
    }
    if (this.host.gates.sessionEnding()) {
      return {
        accepted: false,
        detail: 'Windows is shutting down. The update will install at the next safe launch.',
      };
    }
    if (this.host.gates.maintenanceActive()) {
      return {
        accepted: false,
        detail: 'ChargeWatch is busy with an export, import or restore. Try again in a moment.',
      };
    }
    const result = await this.performInstall({ userInitiated: true });
    return { accepted: result.installed, detail: result.detail };
  }

  /**
   * Runs the shutdown protocol and hands off to the installer.
   *
   * Order: revalidate the cached artifact, stop collection and flush, create
   * the mandatory backup, persist relaunch state, then install.
   */
  private async performInstall(options: { userInitiated: boolean }): Promise<{ installed: boolean; detail: string | null }> {
    const manifest = this.verifiedManifest;
    const staged = this.stagedArtifact;
    if (!manifest || !staged) return { installed: false, detail: 'no verified update is ready' };
    if (this.installing) return { installed: false, detail: 'an install is already in progress' };

    this.installing = true;
    this.setState('installing');
    const attemptId = randomUUID();

    try {
      // Re-verify before installing a file that has sat in the cache: bytes on
      // disk can change between verification and use.
      const stillValid = await this.verifyStagedArtifact(staged, manifest);
      if (!stillValid) {
        this.installing = false;
        return { installed: false, detail: 'the cached update failed re-verification and was discarded' };
      }

      const prepared = await this.host.prepareForInstall();
      if (!prepared.ok) {
        await this.host.recordEvent('install_failed', prepared.detail, { attemptId });
        this.installing = false;
        this.setState(
          'deferred',
          'ChargeWatch could not stop collection cleanly, so the update was postponed.',
        );
        return { installed: false, detail: prepared.detail };
      }

      const backup = await this.host.createPreUpdateBackup();
      if (!backup.ok) {
        await this.host.recordEvent('install_failed', `pre-update backup failed: ${backup.detail}`, {
          attemptId,
        });
        this.installing = false;
        this.setState(
          'deferred',
          'The required backup could not be created, so the update was postponed. Your history is intact.',
        );
        return { installed: false, detail: backup.detail };
      }

      await this.host.persistRelaunchState();
      await this.host.writeHighestAcceptedSequence(manifest.releaseSequence);
      await this.host.recordEvent('install_started', manifest.releaseVersion, { attemptId });

      // A tray-only update must not steal focus; a user-initiated one should
      // bring the app back afterwards.
      this.backend.install({ silent: true, forceRunAfter: options.userInitiated });
      return { installed: true, detail: null };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.host.recordEvent('install_failed', detail, { attemptId });
      this.installing = false;
      this.setState('failed', 'The update could not be installed. ChargeWatch is unchanged and still collecting.');
      return { installed: false, detail };
    }
  }

  /** Called when the window is hidden to the tray, to retry a deferred install. */
  async onWindowHidden(): Promise<void> {
    if (this.state === 'deferred' || this.state === 'ready') {
      // The gate checks the elapsed hidden time itself, so this is safe to
      // call immediately as well as on a timer.
      await this.tryInstallAtSafePoint();
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.backend.cancelDownload();
  }
}
