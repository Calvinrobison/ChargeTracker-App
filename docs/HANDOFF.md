# Handoff

Everything you need to pick ChargeWatch up from where it was left, in the order
you will need it.

Read this with `IMPLEMENTATION_STATUS.md` (what is done and blocked) and
`VERIFICATION_REPORT.md` (what was actually tested). This document is the
mechanics: how to get the code to GitHub, what to run first, and what to expect
to break.

---

## 1. Get the branch

Work happens on `chargewatch-v1`, which is the repository's default branch on
`Calvinrobison/ChargeTracker-App`.

```powershell
git clone https://github.com/Calvinrobison/ChargeTracker-App.git
cd ChargeTracker-App
```

Releases are published from this repository, and the updater downloads from it
(`publish.owner` in `electron-builder.yml`, `BRANDING.releaseOwner` in
`src/main/index.ts` — both must agree, or the updater refuses its own
download as an untrusted source).

A period of work was done from the fork `the-x1x1/ChargeTracker-App` and merged
as pull request #8. That fork's release configuration has been reverted; if you
are working from a clone made during that period, check `publish.owner` before
cutting anything.

The pull request template prompts through the data-honesty checklist; it
applies to every change here.

**Run the checks in section 2 before merging.**

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

### Fixed - the application could not find the browser it ships (`I4`)

The first line the installed application printed was that the bundled browser
was missing. It was not: `resolveBundledChromium` looked in
`resources/browser/chrome-win/chrome.exe`, and Playwright writes
`chromium-<revision>/chrome-win64/chrome.exe`, with the revision changing on
every upgrade.

Both build-time checks passed, because both searched the package recursively
for any file named `chrome.exe`, found one, and reported success.
`verify:package` said "Package looks releasable" 10/10 about that package. The
question that matters is not whether a browser is in there but whether it is
where the application looks; `scripts/lib/browser-layout.mjs` is now the one
candidate list, shared by the resolver and both checks, with specs asserting
they agree.

### Fixed - automatic updates had never worked (`I5`)

Every packaged build, including the `v0.1.0` release, logged this and carried
on:

```
WARN the updater could not be initialised: Cannot set properties of
undefined (setting 'autoDownload'). ChargeWatch keeps collecting.
```

`electron-updater` is CommonJS; `import()` from the bundled ESM main process
resolved its exports under `.default`, so `module.autoUpdater` was `undefined`
and the first assignment threw before anything was configured. An entire
subsystem - and every signature check it gates - was dead in every package ever
built, reported at WARN in a sentence ending on a reassurance.

The 35 update-authenticity specs passed throughout. They inject a well-formed
fake, so nothing ever exercised the line that decides whether the real library
is usable. `resolveAutoUpdater` now looks in both shapes and a module that
yields nothing usable is an ERROR naming the consequence.

### Fixed - two signing keys shared one id (`I6`)

Two different Ed25519 public keys, held by two different people, were both
embedded as `cw-2026-09` - one in the `v0.1.0` release, one in a working tree.
Verification collects every embedded key matching the id a manifest declares
and accepts a signature from any of them, so either private key could produce
an update this application installs, logged identically.

Nothing detected it because the collision was in data, not code; the
release-manifest specs build their keys inline and never read the shipped file.
The keys now carry distinct ids (`cw-2026-09-cr`, `cw-2026-09-x1`),
`parseTrustedKeys` refuses a file with duplicate ids, malformed entries or any
PRIVATE key material, and specs read `resources/update-keys/keys.json` itself.

**Anyone holding an installation from before this change cannot be updated to
after it** - those copies trust only `cw-2026-09`, and no release will ever
carry that id again. They need a fresh install. Since `v0.1.0` could not update
itself at all, this costs nothing that was not already lost.

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
already inside Electron. Since 2026-09-21 the collector can run — ChargePoint is
cleared (`docs/SOURCES.md`) — so this is now a size question. It is most of the
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

### The station catalog is bundled, and it is the only real data in the product

`resources/catalog/` holds 1083 public charging locations within 50 miles of
Mesa, built by `catalog:refresh` from the AFDC Arizona export
(`provenance.json` records the source URL, the file's SHA-256, the field
mapping and the counts: 1652 rows considered, 1083 accepted, 99 non-public, 470
outside the radius, 0 with bad coordinates).

Until 2026-09-21 no source was cleared for collection and this catalog was the
entire product; occupancy figures fill in once locations are linked and
monitored (`docs/SOURCES.md`, "How locations get linked"). `tests/nodeps/catalog-shipped.test.ts` covers the shipped file
rather than the refresh script - recomputing every distance with the
application's own `distanceMiles`, refusing any live-state field on a catalog
row, and reconciling the provenance counts - because a wrong row here is not
cosmetic.

### ChargePoint is cleared for collection (2026-09-21)

The adapter shipped `needs_review` / `blocked` until 2026-09-21 because neither
the provider's terms nor its pages were reachable from the build sandbox. Both
have now been read from a real machine, a bounded live read matched by eye,
and the adapter is `enabled` / `verified`; the review is
`docs/SOURCE_VERIFICATION.md`. The adapter was also rewritten against the
real page, because the original selectors matched nothing on it. What has not
yet happened is a collection cycle inside the packaged application.

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

Two keys are currently embedded, `cw-2026-09-cr` and `cw-2026-09-x1`, held by
Calvinrobison and the-x1x1 respectively. Either can sign a release that
installed copies accept. Sign with the id whose private half you hold:

```powershell
npm run release:prepare -- --version 0.2.0 --key-id cw-2026-09-cr
```

**Key ids must stay unique.** They were not once — both of these were
`cw-2026-09`, which meant a manifest naming that id could be signed by either
party and nothing in the log would say which. `parseTrustedKeys` now refuses a
file with a duplicate id and the build cannot embed one.

Then, per release:

```powershell
npm run package:win
npm run verify:package
npm run release:prepare -- --version 0.2.0 --key-id cw-2026-09-cr
npm run release:verify
npm run release:publish -- --tag v0.2.0 --dry-run
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
