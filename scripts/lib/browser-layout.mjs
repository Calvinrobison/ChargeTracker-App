/**
 * The paths a bundled Chromium payload may occupy, in the order the
 * application tries them.
 *
 * This MIRRORS `chromiumCandidates` in src/collector/browser.ts and exists so
 * the build-time checks ask the same question the application asks at startup.
 *
 * They previously did not. `after-pack.mjs` and `verify-package.mjs` both
 * searched the package recursively for any file named chrome.exe and reported
 * a pass; the application looked at two hard-coded paths and found nothing.
 * The package was reported good and the first thing it printed on launch was
 * "the bundled browser was not found". A check that cannot fail the way the
 * product fails is not a check.
 *
 * A spec keeps the two lists in agreement: tests/nodeps/browser-layout.test.ts.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} root Directory holding the payload (`resources/browser` in a
 *   package, the setup cache in development).
 * @param {NodeJS.Platform} platform
 * @returns {string[]} Absolute candidate paths, most likely first.
 */
export function chromiumCandidates(root, platform) {
  const executable = platform === 'win32' ? 'chrome.exe' : 'chrome';
  const subdirectories =
    platform === 'darwin'
      ? [join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS'), 'chrome-mac']
      : platform === 'win32'
        ? ['chrome-win64', 'chrome-win']
        : ['chrome-linux64', 'chrome-linux'];

  const direct = [
    ...subdirectories.map((sub) => join(root, sub, executable)),
    join(root, executable),
  ];

  let revisions = [];
  try {
    revisions = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    revisions = [];
  }

  const nested = revisions.flatMap((revision) => [
    ...subdirectories.map((sub) => join(root, revision, sub, executable)),
    join(root, revision, executable),
  ]);

  return [...direct, ...nested];
}
