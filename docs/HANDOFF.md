# Handoff

Everything you need to pick ChargeWatch up from where it was left, in the order
you will need it.

Read this with `IMPLEMENTATION_STATUS.md` (what is done and blocked) and
`VERIFICATION_REPORT.md` (what was actually tested). This document is the
mechanics: how to get the code to GitHub, what to run first, and what to expect
to break.

---

## 1. Get the branch onto GitHub

The work is on `fix/toolchain-green`, pushed to the fork
`the-x1x1/ChargeTracker-App` and open upstream as pull request #8.

```powershell
git clone https://github.com/the-x1x1/ChargeTracker-App.git
cd ChargeTracker-App
git checkout fix/toolchain-green
```

The maintainer account cannot push to `Calvinrobison/ChargeTracker-App`, which
is why the fork exists and why releases are cut from it. See
`build: publish releases from the-x1x1 fork` — that commit is fork-specific and
should not be merged upstream.

The pull request template will prompt you through the data-honesty checklist;
it applies to this change like any other.

**Run the checks in section 2 before merging.** The blockers in section 1a have
moved a long way, but nothing here has been seen working with real data.

---

## 1a. Read this before anything else: where the blockers actually stand

The application **runs, installs and starts**. On 2026-09-18 a full build was
made and installed on Windows 11 (build 26200) with Node 24.19.0,
electron-builder 26.15.3 and Electron 44.4.2. What is still missing is data and
distribution, not a working package.

Three defects were found and fixed in that session. All three were
Windows-only, and none of them could have been caught on Linux.

### Fixed - the packaged app could not start (`I1`)

Every IPC message from the application's own window was rejected:

```
WARN rejected an IPC message: the sender document is not the application:
file:///C:/Users/.../app.asar/out/renderer/index.html
```

`WindowManager.appOrigins` built the trusted prefix as `'file://' + path`. On
POSIX the path starts with `/`, giving `file:///opt/...`. On Windows it starts
with a drive letter, giving `file://C:/...` with two slashes, while Electron
reports three. Origins are compared by string prefix, so the match could never
succeed and the first call the renderer made failed. The window showed
"ChargeWatch could not start".

It survived because the specs asserted against a hand-written `APP_ORIGINS`
constant already in the correct form - the consumer was covered, the producer
was not - and because `window.ts` imports Electron and cannot be loaded by the
dependency-free runner. Construction now lives in `security.ts`, which imports
nothing, with five specs over it.

### Fixed - the history file was written to the roaming profile (`I2`)

The data root was derived from `app.getPath('userData')`, which on Windows
comes from `%APPDATA%` - the **roaming** profile. The application raised
`cloud_roaming_directory` against its own data directory on every start, and
`README.md` documented `%LOCALAPPDATA%`, a location it never used. On a machine
with OneDrive this is a corruption risk to a live WAL database. Windows now
reads `%LOCALAPPDATA%` directly.

### Fixed - `--self-check` hung instead of failing (`I3`)

Each RPC had a timeout but they run in sequence, and the collector's default is
120 s, so an unresponsive worker made the check sit through one timeout after
another - about ten minutes, silent, no report. There is now a 90 s ceiling on
the whole run.

### Not reproduced - the installer crash (`I0`) and the compressor failure (`I0b`)

`I0` did not reproduce. The installer built and exited **0** on a silent
install, and the app launched. `I0b` did not reproduce either: electron-builder
downloaded `7zip-win-x64.tar.gz` and compressed without complaint, which also
retires the 32-bit-compressor theory by observation rather than argument.

**Do not record these as fixed.** Nothing was changed that targeted them, and
the artifact differs from the one that failed: 247 MB now against the 328 MB
recorded before. That 81 MB is unexplained and is the most likely reason the
symptom vanished. If `I0` returns, the payload size is the first thing to
compare. Two confident explanations for this crash have already been retracted;
a third should not be offered without evidence.

### Still open - the thing under all of it (`I0c`)

432 MB of the payload is a complete second Chromium, shipped beside the one
already inside Electron, for a collector that **cannot currently run** because
no source is cleared for collection (`docs/SOURCES.md`). It is most of the
installer's size. Whether to keep bundling it, drive collection through
Electron's own browser, or fetch it on first use is a product decision nobody
has made.

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

Expect `# pass 418`, `# fail 0`. This needs Node 22.12+ and nothing else — no
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

**This now runs clean**, on Linux with Node 22.22.2 and on Windows 11 with
Node 24.19.0. So do `npm run lint` and
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
