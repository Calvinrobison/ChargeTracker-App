/**
 * Deciding which files in `release/` belong to the release being prepared.
 *
 * `release-prepare.mjs` used to take every file matching an artifact pattern
 * and sign all of them into the manifest, then check the version against
 * whichever installer `readdirSync` happened to return first. With both
 * `ChargeWatch-Setup-0.1.0.exe` and `ChargeWatch-Setup-0.2.0.exe` in the
 * directory, alphabetical order meant it inspected the old one and refused the
 * release with "the installer is named 0.1.0, which does not contain 0.2.0" —
 * confusing, because the 0.2.0 installer was sitting right there.
 *
 * The misleading message was the smaller half. Had the check passed, a signed
 * manifest would have listed an installer from a different release, and the
 * manifest is the document that tells an installed copy which bytes to trust.
 *
 * So a foreign artifact is not filtered out quietly. A release directory
 * holding two versions is ambiguous, and the person preparing the release is
 * the one who should decide which to keep.
 */

/** A version-like run of digits in an artifact file name. */
const VERSION_IN_NAME = /\d+\.\d+\.\d+/;

/**
 * @param {string[]} fileNames Every file name in the release directory.
 * @param {string} version The version being prepared, e.g. "0.2.0".
 * @returns {{ belonging: string[], foreign: string[], unversioned: string[] }}
 *   `belonging` names this version; `unversioned` (latest.yml) belongs to
 *   whichever release is being made; `foreign` names a different version.
 */
export function partitionArtifactsByVersion(fileNames, version) {
  const belonging = [];
  const foreign = [];
  const unversioned = [];

  for (const name of fileNames) {
    const found = VERSION_IN_NAME.exec(name);
    if (!found) {
      unversioned.push(name);
    } else if (found[0] === version) {
      belonging.push(name);
    } else {
      foreign.push(name);
    }
  }

  return { belonging, foreign, unversioned };
}

/**
 * The message shown when a release directory holds more than one version.
 *
 * It names the files and the remedy, because "does not contain 0.2.0" sent a
 * reader looking at a correctly named installer wondering what was wrong with
 * it.
 *
 * @param {string[]} foreign
 * @param {string} version
 * @param {string} releaseDir
 */
export function foreignArtifactFailure(foreign, version, releaseDir) {
  return (
    `${releaseDir} also contains artifacts from another version: ${foreign.join(', ')}.\n` +
    `    A manifest must describe exactly the files in the release it names, so this is ` +
    `refused rather than\n    guessed at. Remove them and prepare ${version} again:\n` +
    `      Remove-Item ${releaseDir}\\* -Include *.exe,*.blockmap -Exclude *${version}*`
  );
}
