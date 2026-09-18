# Handoff

Everything you need to pick ChargeWatch up from where it was left, in the order
you will need it.

Read this with `IMPLEMENTATION_STATUS.md` (what is done and blocked) and
`VERIFICATION_REPORT.md` (what was actually tested). This document is the
mechanics: how to get the code to GitHub, what to run first, and what to expect
to break.

---

## 1. Get the branch onto GitHub

The work is on a local branch `chargewatch-v1`. It was never pushed, because the
build environment's git proxy refused the repository:

```
Calvinrobison/ChargeTracker-App is not in this session's authorized repository set.
```

That is an environment restriction, not a repository problem. From your own
machine:

```powershell
git clone https://github.com/Calvinrobison/ChargeTracker-App.git
cd ChargeTracker-App

# Apply the branch. If you received it as a bundle or an archive, unpack it
# here first; otherwise add the working copy as a remote and fetch from it.
git checkout -b chargewatch-v1
git push -u origin chargewatch-v1
```

Then open a pull request. The pull request template will prompt you through the
data-honesty checklist; it applies to this change like any other.

**Do not merge to `main` before running the checks in section 2.** The two open
failures in section 1a are unresolved: the installer built from this branch
still crashes on install.

---

## 1a. Read this before anything else: the two open failures

The application **runs**. `release\win-unpacked\ChargeWatch.exe` launches. What
is not resolved is packaging it and installing it, and two attempts to explain
the packaging failure were wrong before the third one was accepted as unknown.
The honest state:

### Open A - the installer crashes on install (`I0`)

`ChargeWatch-Setup-0.1.0.exe` built once, at 328 MB, passed
`npm run verify:package` 10/10, and then exited **-1073740940**
(`STATUS_HEAP_CORRUPTION`) on a silent install. Nothing was installed.

**Cause not established.** It has been wrongly attributed twice: to
differential packaging, and to a 32-bit 7-Zip. Neither survives its own
evidence, and both retractions are recorded in `VERIFICATION_REPORT.md`
criterion 14. The single most useful next step is an **interactive** run - `/S`
suppressed whatever the installer wanted to say - and the faulting module from
the Windows Application log. `docs/TROUBLESHOOTING.md` has the sequence.

### Open B - packaging fails to compress (`I0b`)

With `differentialPackage: false`, 7-Zip dies on `Can't allocate required
memory!`. Observed at `-mx=9` and `-mx=5`, with the bundled 32-bit compressor
and with a 64-bit 7-Zip 26.03, on a machine with 12 logical processors, 15.8 GB
RAM and 5.9 GB free. **A 16 MB dictionary failing with 5.9 GB free is not
explained by any theory offered so far.**

`differentialPackage` is now `true`, which pins the dictionary to 1 MB and is
the only configuration that has ever produced an installer here. That is a
workaround standing on one observation, not a fix.
`scripts\windows\diagnose-7z.ps1` measures the question properly - commit
limit, page file, then a ladder of settings run directly against
`release\win-unpacked` - and changes nothing.

### The thing under both of them (`I0c`)

432 MB of the 814 MiB payload is a complete second Chromium, shipped beside the
one already inside Electron, for a collector that **cannot currently run** -
no source is cleared for collection (`docs/SOURCES.md`). It is most of the
installer's size and the reason there is so much to compress. Whether to keep
bundling it, drive collection through Electron's own browser, or fetch it on
first use is a product decision nobody has made. It is written down rather than
quietly carried.

### A caution about this repository's checks

The browser-path defect is worth understanding before trusting any green
result here. The application shipped a 432 MB browser and could not find it:
the resolver looked at `resources/browser/chrome-win/chrome.exe`, the payload
was at `resources/browser/chromium-1243/chrome-win64/chrome.exe`. Both
build-time checks passed, because both searched the tree recursively for a
file named `chrome.exe` instead of asking whether it was where the application
looks. `verify:package` reported "Package looks releasable" on a package whose
first line of output was `the bundled browser was not found`.

Both checks now use `scripts/lib/browser-layout.mjs`, the same candidate list
the app walks, and a spec asserts the two agree. Apply the same suspicion to
the rest: a check that cannot fail the way the product fails is decoration.

---

## 2. The first hour

Run these in order. Each one is expected to find something.

### 2.1 Confirm the specs still pass on your machine

```powershell
npm run test:nodeps
```

Expect `# pass 413`, `# fail 0`. This needs Node 22.12+ and nothing else — no
install, no network. If it fails here, something is wrong with your Node
version before anything else is worth investigating.

### 2.2 Resolve the dependency tree

```powershell
npm ci
```

`package-lock.json` is committed, so use `npm ci` rather than `npm install`:
`npm ci` installs exactly what the lockfile pins, where `npm install` may
resolve something newer and rewrite it.

The versions in the lockfile are the ones the code was written against. If you
deliberately bump Electron, better-sqlite3 or playwright-core, read
`docs/adr/0001-stack-and-version-pinning.md` first — those three are the ones
that can change behaviour rather than just surface.

### 2.3 Typecheck

```powershell
npm run typecheck
```

**This now runs clean**, on Linux with Node 22.22.2. So do `npm run lint` and
`npm run format` — `eslint.config.js` was renamed to `eslint.config.mjs` and
given a globals configuration (it had been producing 416 bogus `no-undef`
errors), and the tree was run through prettier for the first time.
`src/workers/*.ts` were in neither tsconfig project, so nothing typechecked them
and eslint could not parse them; they are in `tsconfig.node.json` now.

A clean typecheck is not a clean bill of health for one module in particular:

- **`src/main/updates-backend.ts`.** Written against electron-updater's
  documented API rather than against a running copy of it. Its install surface
  differs across versions; the `UpdaterBackend` interface in
  `src/main/updates.ts` is the seam to adjust, and the `UpdateService` above it
  should not need to change.

### 2.4 Build and see the interface

```powershell
npm run build
npm run test:e2e
```

`npm run build` succeeds on Linux: main, preload, renderer and both worker
bundles (`out/workers/database.js`, `out/workers/collector.js`). The 42 UI specs
in `tests/ui/honesty.spec.ts` now pass, across three Playwright projects, in
plain Chromium against the built renderer — **not** under Electron. The first
run needed three corrections, all in the specs rather than the application.
**Correct the selector, not the assertion** — the assertions are the point, and
each one guards a specific way the interface could mislead someone.

If you want to look at it rather than test it:

```powershell
npm run dev
```

### 2.5 Package, and prove the package works

```powershell
npm run setup:browser     # ~200 MB Chromium payload
npm run package:win
npm run verify:package
```

Then, in a **normal, non-elevated** PowerShell window:

```powershell
.\scripts\windows\test-installed.ps1
```

This is the first moment anyone learns whether the native SQLite module loads
under the Electron ABI and whether the bundled browser starts from
`process.resourcesPath`. Both are the kind of thing that looks fine until a user
runs it.

The script installs the build, runs it with `--self-check` against a throwaway
data directory, reads the JSON report, and uninstalls. It separates _integrity_
(data folder, database, bundled browser — must pass) from _readiness_ (an
eligible source, a loaded catalog — expected to be unmet today, reported rather
than failed).

---

## 3. Things that are deliberately incomplete

None of these are oversights. Each one was a decision to report a gap rather
than fill it with something invented.

### No station catalog is bundled

`resources/catalog/` contains a README and nothing else. The AFDC dataset was
unreachable from the build environment, and writing plausible-looking station
rows would have put fabricated locations in front of a user who had no way to
tell. Run `npm run catalog:refresh` on a networked machine and review what it
produces — the field mapping in `CatalogImportRecord` is a declared shape that
has never seen a real file.

### No source is cleared for collection

The ChargePoint adapter ships `eligibilityState: 'needs_review'` and
`verificationState: 'blocked'`, and the application surfaces that state on the
onboarding screen and in a banner rather than hiding it. Neither the provider's
terms nor its status pages were reachable, so nothing could be established.
`docs/SOURCE_VERIFICATION.md` is the process. It may conclude the source is
ineligible; that is a real outcome, and the honest thing is then to say so in
`docs/SOURCES.md` rather than collect anyway.

### GitHub Actions are pinned to tags, not commit SHAs

Both workflows reference actions by major tag with a `TODO`. A tag is mutable.
Before `release.yml` ever holds a real signing key, resolve each one:

```powershell
gh api repos/actions/checkout/commits/v4 --jq .sha
```

and replace `@v4` with `@<sha> # v4.2.2`. The SHAs were deliberately not filled
in from the build environment, because inventing one produces either a broken
workflow or a reference to a commit nobody checked.

### The `release` environment does not exist yet

`release.yml` names a GitHub environment called `release` for its signing job.
Create it in repository settings with a required reviewer. Without it, that job
runs unattended and the protection the workflow describes is not actually in
place.

### No screenshots

`docs/` has no images. The renderer has only ever been rendered headlessly by
the UI specs, against synthetic fixtures. Take real ones from a real run rather
than mocking any up.

---

## 4. Releasing

Full detail in `docs/RELEASING.md`. The short version:

```powershell
npm run keys:bootstrap    # once, ever — writes the private key OUTSIDE the repo
```

The private key goes to `~/.chargewatch-release-keys/` with restrictive
permissions. **It is never committed and never shipped.** Only the public half
goes into `resources/update-keys/keys.json`, which is what installed copies use
to verify an update. Lose the private key and you cannot ship an update that
existing installs will accept.

Then, per release:

```powershell
npm run package:win
npm run verify:package
npm run release:prepare -- --version 0.1.0
npm run release:verify
npm run release:publish -- --tag v0.1.0 --dry-run
```

`release:verify` runs the **same code the installed application runs**, against
the public keys the application ships. If it passes, an installed copy will
accept the release; if it fails, the release would be rejected on users'
machines — much better to find out here.

`release:publish` creates a **draft**. Promoting the draft is a separate,
deliberate act, because that is the moment every installed copy starts offering
the update.

---

## 5. Where to look when something is wrong

| Symptom                          | Start here                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------- |
| A number looks wrong             | `docs/METRICS.md`, then the coverage indicator for that window                |
| Collection is not happening      | The source health banner; `docs/SOURCES.md`                                   |
| The app will not start           | `%LOCALAPPDATA%\ChargeWatch\logs\`; run the installed exe with `--self-check` |
| A history file looks damaged     | `npm run db:probe -- --file <path>` — read-only, safe                         |
| An update was refused            | `docs/UPDATES_AND_RECOVERY.md`; the rejection code names the exact check      |
| Packaging produced something odd | `npm run verify:package` names the fault and the fix                          |

---

## 6. The one rule to keep

Every design decision in this repository comes back to the same constraint:
**ChargeWatch must never claim to know something it does not know.** Missing
data is not zero. An unperformed check is not a passed check. An inferred
episode is not a recorded session. A partially covered window is labelled as
one.

That constraint is what most of the schema, half the domain logic and all of the
formatter specs exist to enforce. If a future change makes one of those rules
inconvenient, the right move is an ADR explaining why the rule should change —
not a quiet exception. The pull request template's data-honesty checklist is
there to make that decision visible rather than accidental.
