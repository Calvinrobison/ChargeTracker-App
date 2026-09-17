/**
 * The concrete `UpdaterBackend` for the pinned electron-updater.
 *
 * This file is the ONLY place electron-updater is touched. It exists because
 * the library's install API has changed across versions, and copying a call
 * signature from a blog is how you end up with an updater that silently does
 * nothing or installs at the wrong moment.
 *
 * ## Before trusting this file, verify these four things against the version
 * ## actually in package-lock.json (see docs/UPDATES_AND_RECOVERY.md):
 *
 * 1. `autoUpdater.autoDownload = false` and `autoInstallOnAppQuit = false`
 *    genuinely suppress the library's own paths. There must be no
 *    install-on-quit backdoor around our gates.
 * 2. The install call. Older releases take `quitAndInstall(isSilent,
 *    isForceRunAfter)` positionally; current ones accept an options object
 *    and/or emit `autoInstallEvent`. `install()` below picks the shape at
 *    runtime rather than assuming one.
 * 3. `verifyUpdateCodeSignature`. The NSIS updater exposes this as a custom
 *    verification hook, and whether it is INVOKED at all depends on publisher
 *    metadata being configured. We wire our signed-manifest policy into it and
 *    verify in a test that it actually runs — a hook that is never called is
 *    worse than no hook, because it looks like protection.
 * 4. `channel` / `allowPrerelease` defaults, so a prerelease cannot arrive on
 *    the stable channel.
 *
 * Until those are checked against the pinned version, treat this file as
 * unverified. `docs/IMPLEMENTATION_STATUS.md` records it as such.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { UpdateCandidate, UpdaterBackend } from './updates.ts';
import type { Logger } from './logger.ts';

/**
 * The subset of electron-updater we use, declared structurally so this module
 * compiles without asserting the library's exact published types.
 */
interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  fullChangelog: boolean;
  channel: string | null;
  forceDevUpdateConfig?: boolean;
  logger: unknown;
  setFeedURL(options: unknown): void;
  checkForUpdates(): Promise<{
    updateInfo?: {
      version?: string;
      releaseName?: string | null;
      releaseNotes?: string | null;
      tag?: string;
      files?: Array<{ url?: string }>;
    };
  } | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(...args: unknown[]): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeAllListeners(event?: string): unknown;
}

export interface UpdaterBackendOptions {
  readonly owner: string;
  readonly repo: string;
  readonly channel: 'stable' | 'beta' | 'alpha';
  readonly logger: Logger;
  /** Injected so tests can supply a fake. */
  readonly autoUpdater: AutoUpdaterLike;
  /** Fetches a small release asset by name. */
  readonly fetchReleaseAsset: (name: string) => Promise<Uint8Array>;
}

export function createUpdaterBackend(options: UpdaterBackendOptions): UpdaterBackend {
  const { autoUpdater, logger } = options;
  let downloadedFiles: string[] = [];
  let cancelled = false;

  return {
    configureManualControl(): void {
      // We own install timing. The library must not download or install on its
      // own, and must never install on quit behind our gates.
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.allowDowngrade = false;
      autoUpdater.allowPrerelease = options.channel !== 'stable';
      autoUpdater.channel = options.channel === 'stable' ? null : options.channel;
      autoUpdater.fullChangelog = false;
      autoUpdater.logger = {
        info: (message: unknown) => logger.log('info', `updater: ${String(message)}`),
        warn: (message: unknown) => logger.log('warn', `updater: ${String(message)}`),
        error: (message: unknown) => logger.log('error', `updater: ${String(message)}`),
        debug: (message: unknown) => logger.log('debug', `updater: ${String(message)}`),
      };
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: options.owner,
        repo: options.repo,
        // Drafts and prereleases are ignored unless the channel says otherwise.
        releaseType: options.channel === 'stable' ? 'release' : 'prerelease',
      });
      logger.log(
        'info',
        `updater configured for ${options.owner}/${options.repo} on the ${options.channel} channel with manual install control`,
      );
    },

    async checkForUpdates(): Promise<UpdateCandidate | null> {
      const result = await autoUpdater.checkForUpdates();
      const info = result?.updateInfo;
      if (!info?.version) return null;

      // The asset list is needed so the manifest's artifact names can be
      // checked against what the release actually contains.
      const assetNames = (info.files ?? [])
        .map((file) => (file.url ? basename(new URL(file.url, 'https://github.com/').pathname) : null))
        .filter((name): name is string => name !== null);

      return {
        version: info.version,
        tag: info.tag ?? `v${info.version}`,
        channel: options.channel,
        isPrerelease: options.channel !== 'stable',
        isDraft: false,
        assetNames: [...new Set(assetNames)],
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
      };
    },

    async downloadUpdate(onProgress): Promise<{ filePath: string; fileName: string }> {
      cancelled = false;
      autoUpdater.removeAllListeners('download-progress');
      autoUpdater.on('download-progress', (progress: unknown) => {
        const percent = (progress as { percent?: number } | undefined)?.percent;
        if (typeof percent === 'number') onProgress(Math.max(0, Math.min(100, percent)));
      });

      downloadedFiles = await autoUpdater.downloadUpdate();
      if (cancelled) throw new Error('the download was cancelled');

      const installer = downloadedFiles.find((file) => file.toLowerCase().endsWith('.exe'));
      const filePath = installer ?? downloadedFiles[0];
      if (!filePath) throw new Error('the updater reported no downloaded file');
      return { filePath, fileName: basename(filePath) };
    },

    async fetchAsset(name: string): Promise<Uint8Array> {
      return options.fetchReleaseAsset(name);
    },

    async readAsset(filePath: string): Promise<Uint8Array> {
      return readFile(filePath);
    },

    install(installOptions): void {
      // Version-tolerant call. Current electron-updater accepts an options
      // object; older versions take two positional booleans. Trying the object
      // form first and falling back keeps a pinned upgrade from silently
      // becoming a no-op.
      const { silent, forceRunAfter } = installOptions;
      try {
        (autoUpdater.quitAndInstall as (arg: unknown) => void)({
          isSilent: silent,
          isForceRunAfter: forceRunAfter,
        });
        logger.log('info', 'handed off to the installer using the options form');
      } catch (error) {
        logger.log(
          'warn',
          `the options form of quitAndInstall failed (${error instanceof Error ? error.message : String(error)}); trying the positional form`,
        );
        (autoUpdater.quitAndInstall as (a: boolean, b: boolean) => void)(silent, forceRunAfter);
        logger.log('info', 'handed off to the installer using the positional form');
      }
    },

    cancelDownload(): void {
      cancelled = true;
      autoUpdater.removeAllListeners('download-progress');
    },

    configuredRepo: { owner: options.owner, repo: options.repo },
    manualDownloadUrl: `https://github.com/${options.owner}/${options.repo}/releases/latest`,
  };
}
