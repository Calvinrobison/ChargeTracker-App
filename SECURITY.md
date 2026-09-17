# Security policy

## Reporting a vulnerability

Report privately, not as a public issue:
<https://github.com/Calvinrobison/ChargeTracker-App/security/advisories/new>

Include what you did, what happened, and what you expected. A proof of concept
helps; a working exploit is not required.

**Do not** test against a live charger network provider. Nothing about this
project justifies sending traffic at a third party's infrastructure.

## What is treated as high severity

**Anything in the update verification path.** That path is the one place where a
failure lets someone else's code run on a user's machine. A way to get an
unsigned, tampered, replayed or wrongly-targeted release past
`src/shared/release-manifest.ts` is the most serious class of bug this project
can have.

**Anything that reaches the renderer's privileges.** The renderer is sandboxed,
has context isolation on, and can reach the rest of the application only through
the narrow preload bridge. A way to execute arbitrary code in it, escape it, or
invoke an IPC operation from an untrusted sender is serious.

**Anything that reads or writes outside the data directory.** Export
destinations, restore staging, backup archive entries and catalog imports all
handle paths that can come from outside. A traversal that escapes the data
directory matters.

**Credential or key exposure.** A release private key appearing in a package, a
credential surviving diagnostic redaction, or a browser profile being included
in an export.

## What is in scope

The application, its build and its release pipeline. That includes:

- the update manifest verification and artifact digest checks;
- the IPC contract and its runtime validation;
- the session hardening in `src/main/window.ts` and `src/main/security.ts`;
- path handling in `src/main/paths.ts`, `src/database/backup.ts` and the export
  routines;
- CSV import and export handling, including formula injection;
- the collector's URL allowlist and navigation restrictions;
- the packaging checks in `scripts/verify-package.mjs`.

## What is out of scope

**The absence of code signing.** The installer is not code-signed, and Windows
SmartScreen warns accordingly. This is known, documented in
`docs/UPDATES_AND_RECOVERY.md`, and a consequence of free distribution. It is
separate from ChargeWatch's own signature check, which is in scope.

**Third-party provider infrastructure.** If you find a vulnerability in a
charger network's website, report it to them.

**Denial of service against your own machine.** ChargeWatch is a local
application running with your privileges.

**Findings from a scanner with no demonstrated impact.** A dependency advisory
for a code path that is not reachable is worth mentioning, not worth filing as a
vulnerability.

## Design commitments

These are properties the project intends to keep. A change that breaks one is a
security regression whether or not anyone has demonstrated an exploit.

**No remote code.** Content Security Policy in production permits no remote
scripts, stylesheets or fonts. Everything the renderer needs is bundled. The
only outbound requests the application makes are to charger status pages
explicitly configured as sources, OpenStreetMap tile servers for the map, and
GitHub for updates.

**No arbitrary navigation.** The renderer may not navigate away from its own
document. External links open in the system browser, and only for an allowlisted
set of origins.

**Every permission denied.** Geolocation, camera, microphone, notifications and
the rest are refused at the session level rather than being left to a prompt.

**Every IPC request validated.** The channel is single, the operation registry
is versioned, each operation has a schema, and the sender is checked by window
identity, main frame and document origin. Destructive operations refuse an
unconfirmed request in the schema itself, so the confirmation cannot be
forgotten at a call site.

**Unknown keys are stripped, not passed through.** The hand-written validator
(`src/shared/validate.ts`, and ADR-0002 for why it is hand-written) keeps `null`
and `undefined` distinct, rejects fractional integers and out-of-range instants,
and resists prototype pollution.

**Private keys never enter the repository or a package.**
`scripts/keys-bootstrap.mjs` writes the private key to a directory outside the
repository with restrictive permissions. `scripts/verify-package.mjs` fails a
package containing any `.pem` that is not a `.pub.pem`, and
`scripts/release-publish.mjs` refuses to upload one.

**The signing key is not present in the job that builds.**
`.github/workflows/release.yml` separates building from signing, because a
compromised transitive dependency with a postinstall script is the ordinary way
a release key gets exfiltrated.

**Diagnostics are redacted before they are written.** Tokens, cookies,
authorization headers and the user's home path are removed. Databases, browser
profiles and credentials are never included.

**Untrusted text is neutralised in CSV exports**, and numeric measurements are
deliberately left alone — altering a measurement to make it safe would be a
data-integrity bug introduced by a security measure.

## Known gaps

Stated here rather than discovered.

- **GitHub Actions are pinned to major tags, not commit SHAs.** A tag is
  mutable. This is tracked as blocker B8 in `docs/IMPLEMENTATION_STATUS.md` and
  must be resolved before the release workflow ever holds a real signing key.
- **The `release` GitHub environment does not exist yet.** `release.yml` names
  it for its signing job, expecting a required reviewer. Until it is created
  with one, that job would run unattended.
- **No dependency tree has been resolved.** There is no `package-lock.json` yet,
  so no dependency has been audited. `npm audit` has never run.
- **Nothing has been penetration tested.** The properties above are enforced by
  specs — 72 of them across security, paths and contracts — but specs test what
  the author thought to test.
