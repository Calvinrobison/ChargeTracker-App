# Releasing ChargeWatch

Publishing a release is the moment every installed copy starts offering an
update. This document describes how that is gated, and which steps stay manual
on purpose.

**No release has ever been published.** The pipeline below has been exercised
end to end against placeholder artifacts with a throwaway key pair, and it
correctly rejected a tampered installer, a tampered manifest and a replayed
sequence. It has never run against a real Windows build.

---

## The signing key

Once, ever:

```powershell
npm run keys:bootstrap
```

This generates an Ed25519 key pair. The **private** half is written to
`~/.chargewatch-release-keys/<keyId>.private.pem` with restrictive permissions,
**outside the repository**. The **public** half is written into
`resources/update-keys/keys.json`, which ships inside the application and is
what an installed copy uses to verify an update.

Three things follow from this that are worth being blunt about:

**Lose the private key and you cannot ship an update that existing installs will
accept.** They will refuse anything signed by a key they do not trust, which is
the whole point. Recovery means asking users to download and install manually.

**Never commit the private key and never put it in a package.**
`scripts/verify-package.mjs` fails a package containing any `.pem` that is not a
`.pub.pem`, and `scripts/release-publish.mjs` refuses to upload one. Those are
backstops, not permission to be careless.

**Rotating a key is additive.** Add the new public key to `keys.json` and mark
the old one `retired: true` rather than removing it. Retired keys are rejected
for new releases but the entry documents what was once trusted. Ship at least
one release signed by the old key that also contains the new public key, before
signing anything with the new key — otherwise installed copies will not have the
new key when the new release arrives.

To see what is currently embedded:

```powershell
npm run keys:show
```

---

## Per release

### 1. Prepare the version

Bump `package.json`, write the `CHANGELOG.md` entry, commit, and make sure the
working tree is clean. `release:prepare` refuses all three failures — a version
mismatch, a missing changelog entry, and uncommitted changes — because a release
built from a dirty tree cannot be reproduced.

### 2. Build and check the package

```powershell
npm run package:win
npm run verify:package
.\scripts\windows\test-installed.ps1
```

If you have the previous release's installer, also:

```powershell
.\scripts\windows\test-update.ps1 -OldInstaller .\release\ChargeWatch-Setup-<prev>.exe `
                                  -NewInstaller .\release\ChargeWatch-Setup-<new>.exe
```

That proves the upgrade migrates the existing history file **in place** rather
than replacing it. Note what it does not prove: it writes no synthetic
observations, so observation survival specifically is untested until you run it
with `-ExistingHistory` pointing at a genuinely populated file.

### 3. Sign

```powershell
npm run release:prepare -- --version 0.1.0
```

This hashes the **final on-disk bytes** of every artifact, so it must run after
packaging and after any code signing. It writes `build-info.json`,
`release-manifest.json`, `release-manifest.json.sig` and `SHA256SUMS.txt`.

The signature is over the exact bytes of the manifest file, not over a
re-serialised object. That means a whitespace change to the manifest invalidates
the signature, which is correct: the thing verified must be the thing read.

The release sequence is derived from the version
(`major×1,000,000 + minor×1,000 + patch`), so it increases monotonically without
a separate counter to keep in sync. A downgrade is refused by the verifier,
which means **fixing a bad release means publishing a higher version**, never
re-publishing the same one.

### 4. Verify as an installed copy would

```powershell
npm run release:verify
```

This runs the **same verification code the application runs**
(`src/shared/release-manifest.ts`), against the **public keys the application
ships**. If it passes, an installed copy will accept the release. If it fails,
the release would be rejected on users' machines.

It also checks every artifact's size and both digests, confirms the updater
metadata digest recorded in the manifest matches the metadata file on disk, and
refuses an upload set containing a key, a credential or a database.

It now also runs `isDirectUpgradePermitted` — the same upgrade-path check an
installed copy performs — against `--installed-version` (default `0.0.1`). The
script previously accepted that flag and ignored it, so the one check that
decides whether an existing install will take this release was not part of the
gate. It is now.

What it does **not** prove: GitHub permissions, asset availability, or that a
real client can reach the release. Only an actual publish and a real client
discovering it can establish those.

### 5. Stage a draft

```powershell
npm run release:publish -- --tag v0.1.0 --dry-run
```

Prints exactly what would be uploaded and the `gh` command it would run. When
you are satisfied:

```powershell
npm run release:publish -- --tag v0.1.0 --confirm
```

This re-runs verification first and refuses to publish if it fails. It creates a
**draft** release with the complete artifact set and generated notes.

### 6. Check the draft, then publish it

Before promoting:

1. Open the draft on GitHub and confirm every asset uploaded completely.
2. Install the artifact on a clean Windows profile and confirm it runs.
3. Confirm an existing installed copy discovers and accepts the update.

Only then:

```powershell
gh release edit v0.1.0 --repo Calvinrobison/ChargeTracker-App --draft=false
```

Publishing is deliberately separate from uploading. Uploading is reversible;
publishing is the moment the update becomes real for everyone.

---

## Doing it from CI

`.github/workflows/release.yml` runs on a `v*.*.*` tag push. Its structure
matters more than its convenience:

**`build-and-package` never sees the signing key.** It runs the project's own
build, which executes thousands of lines of third-party postinstall and bundler
code. A compromised transitive dependency with a postinstall script is the
ordinary way a release key gets exfiltrated.

**`sign-and-stage` has the key and runs no project build steps.** It downloads
the already-built artifacts, signs the manifest computed over their bytes, and
verifies the result with the shipped public keys.

**It refuses to sign without a key** rather than falling back to an unsigned
manifest. An unsigned release would be rejected by every installed copy anyway;
staging one would only suggest otherwise.

**It stages a draft and stops.** Promotion stays manual.

Two things must be set up before that workflow is trustworthy:

- A GitHub environment named `release` with a required reviewer, so signing
  cannot happen on a tag push alone. The workflow names it; without it the job
  runs unattended.
- Every action pinned to an immutable commit SHA. They are currently referenced
  by major tag with a `TODO`. A tag is mutable, and this is the workflow that
  holds the key.

---

## If a published release turns out to be bad

Do not delete it and re-publish the same version. Installed copies that already
accepted it record its release sequence and will refuse anything at or below it
as a downgrade — so a re-published `0.1.0` would be invisible to exactly the
users who need it.

Publish a **higher** version. If the bad release is actively harmful, delete the
GitHub release as well so new downloads stop, but the fix is still a version
bump.

`docs/UPDATES_AND_RECOVERY.md` covers what a user can do in the meantime.
