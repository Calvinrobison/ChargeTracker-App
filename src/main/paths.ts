/**
 * Where ChargeWatch keeps its data.
 *
 * Requirements this module exists to satisfy (§23):
 *  - History lives OUTSIDE the replaceable installation directory, so an
 *    update or reinstall cannot delete it.
 *  - It lives in the user's LOCAL application data, not a cloud-roaming
 *    folder: a SQLite database in OneDrive or a roaming profile is a
 *    corruption risk and a sync bandwidth problem.
 *  - Collection data, browser profiles, backups, logs and the update cache are
 *    separate subdirectories.
 *  - Paths come from supported OS/runtime facilities, not string guesses.
 *  - A branding change must not strand the user's data.
 */

import { join } from 'node:path';

/**
 * The directory name used under local app data.
 *
 * This is deliberately a CONSTANT, not the product name: renaming the app
 * must not orphan an existing database. If the brand changes, this stays.
 */
export const DATA_DIRECTORY_NAME = 'ChargeWatch';

/** Subdirectories, kept separate so backups never sweep up a browser profile. */
export const SUBDIRECTORIES = {
  database: 'db',
  browserProfiles: 'browser-profiles',
  backups: 'backups',
  logs: 'logs',
  diagnostics: 'diagnostics',
  updateCache: 'update-cache',
  staging: 'staging',
  exports: 'exports',
} as const;

export const DATABASE_FILE_NAME = 'history.sqlite';

export interface ResolvedPaths {
  readonly root: string;
  readonly databaseFile: string;
  readonly databaseDir: string;
  readonly browserProfilesDir: string;
  readonly backupsDir: string;
  readonly logsDir: string;
  readonly diagnosticsDir: string;
  readonly updateCacheDir: string;
  readonly stagingDir: string;
  readonly exportsDir: string;
}

export interface PathInputs {
  /**
   * The OS local application data directory, from Electron's
   * `app.getPath('appData')` on non-Windows or the `LOCALAPPDATA` value that
   * Electron's `app.getPath('userData')` is derived from on Windows. The
   * caller passes it in so this module stays testable and platform-agnostic.
   */
  readonly localAppDataDir: string;
  /** The installation directory, used only to assert we are not inside it. */
  readonly installDir: string | null;
  readonly platform: NodeJS.Platform;
  /** Directories known to be cloud-roaming, for the safety check. */
  readonly roamingHints?: readonly string[];
}

const DEFAULT_ROAMING_HINTS: readonly string[] = [
  'onedrive',
  'dropbox',
  'google drive',
  'googledrive',
  'icloud',
  'box sync',
  'nextcloud',
  'appdata\\roaming',
  'appdata/roaming',
];

export type PathWarningCode = 'inside_install_dir' | 'cloud_roaming_directory' | 'not_absolute';

export interface PathResolution {
  readonly paths: ResolvedPaths;
  readonly warnings: readonly { readonly code: PathWarningCode; readonly detail: string }[];
}

function isAbsolutePath(value: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
  }
  return value.startsWith('/');
}

function normalizeForComparison(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

/**
 * Resolves the data directory tree and reports anything that looks wrong.
 *
 * Warnings are returned rather than thrown: the app should still open and tell
 * the user what is unusual, not refuse to start.
 */
export function resolveDataPaths(inputs: PathInputs): PathResolution {
  const warnings: Array<{ code: PathWarningCode; detail: string }> = [];
  const root = join(inputs.localAppDataDir, DATA_DIRECTORY_NAME);

  if (!isAbsolutePath(inputs.localAppDataDir, inputs.platform)) {
    warnings.push({
      code: 'not_absolute',
      detail: `the application data directory "${inputs.localAppDataDir}" is not an absolute path`,
    });
  }

  if (inputs.installDir) {
    const normalizedRoot = normalizeForComparison(root);
    const normalizedInstall = normalizeForComparison(inputs.installDir);
    if (
      normalizedRoot === normalizedInstall ||
      normalizedRoot.startsWith(`${normalizedInstall}/`)
    ) {
      warnings.push({
        code: 'inside_install_dir',
        detail:
          `the data directory "${root}" is inside the installation directory, where an update or ` +
          'uninstall would remove it',
      });
    }
  }

  const hints = inputs.roamingHints ?? DEFAULT_ROAMING_HINTS;
  const normalizedRootForHints = normalizeForComparison(root);
  for (const hint of hints) {
    if (normalizedRootForHints.includes(normalizeForComparison(hint))) {
      warnings.push({
        code: 'cloud_roaming_directory',
        detail:
          `the data directory "${root}" looks like a synced or roaming folder; a live SQLite ` +
          'database there can be corrupted by the sync client',
      });
      break;
    }
  }

  const paths: ResolvedPaths = {
    root,
    databaseDir: join(root, SUBDIRECTORIES.database),
    databaseFile: join(root, SUBDIRECTORIES.database, DATABASE_FILE_NAME),
    browserProfilesDir: join(root, SUBDIRECTORIES.browserProfiles),
    backupsDir: join(root, SUBDIRECTORIES.backups),
    logsDir: join(root, SUBDIRECTORIES.logs),
    diagnosticsDir: join(root, SUBDIRECTORIES.diagnostics),
    updateCacheDir: join(root, SUBDIRECTORIES.updateCache),
    stagingDir: join(root, SUBDIRECTORIES.staging),
    exportsDir: join(root, SUBDIRECTORIES.exports),
  };

  return { paths, warnings };
}

/**
 * Directories a diagnostics bundle may include.
 *
 * Browser profiles and the update cache are excluded: a profile can contain
 * cookies and account data, and the update cache is large and useless.
 */
export const DIAGNOSTIC_INCLUDED_DIRS: readonly (keyof ResolvedPaths)[] = [
  'logsDir',
  'diagnosticsDir',
];

export const DIAGNOSTIC_EXCLUDED_DIRS: readonly (keyof ResolvedPaths)[] = [
  'browserProfilesDir',
  'updateCacheDir',
  'databaseDir',
  'backupsDir',
];

/**
 * Checks that a user-chosen destination is somewhere we are willing to write.
 *
 * Export and backup destinations come from a Save As dialog, so they are
 * user-intended, but they must still not be allowed to target the application
 * data directory or the install directory, where they could overwrite a live
 * database or a binary.
 */
export function isPermittedWriteDestination(
  destination: string,
  paths: ResolvedPaths,
  installDir: string | null,
): { permitted: boolean; reason: string | null } {
  const normalized = normalizeForComparison(destination);
  if (normalized.length === 0) return { permitted: false, reason: 'the destination is empty' };

  const forbidden: Array<[string, string]> = [
    [normalizeForComparison(paths.databaseDir), 'the live history directory'],
    [normalizeForComparison(paths.updateCacheDir), 'the update cache'],
    [normalizeForComparison(paths.browserProfilesDir), 'the browser profile directory'],
  ];
  if (installDir)
    forbidden.push([normalizeForComparison(installDir), 'the installation directory']);

  for (const [prefix, label] of forbidden) {
    if (prefix.length > 0 && (normalized === prefix || normalized.startsWith(`${prefix}/`))) {
      return { permitted: false, reason: `ChargeWatch will not write into ${label}` };
    }
  }
  return { permitted: true, reason: null };
}
