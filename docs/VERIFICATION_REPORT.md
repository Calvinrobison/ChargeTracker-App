# Verification report

Date: 2026-09-17
Repository: `Calvinrobison/ChargeTracker-App`
Branch: `chargewatch-v1` — see `git log -1` for the exact commit.

This report exists so that nobody has to guess what has actually been checked.
Every **P** below was produced by a command that ran on this host and whose
output is quoted or reproducible. Every **NT** says why it was not run. Nothing
is marked green because it looks right in the source.

## Environment

|                         |                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Build host              | Linux x86-64 (cloud container), **not Windows**                                                                    |
| Node                    | 22.22.2 here; the suite has also been run on 24.19.0 on Windows 11 x64 — see below                                 |
| SQLite                  | 3.51.2, via Node's built-in `node:sqlite`                                                                          |
| npm registry            | was **unreachable** (`403 x-deny-reason: host_not_allowed`); reachable since, and `package-lock.json` is committed |
| Network                 | `github.com` hosts only                                                                                            |
| Windows host            | none available to the build environment; the owner has since run the specs on one                                  |
| Playwright / TypeScript | installed and run — see below                                                                                      |
| Electron                | **not run here.** The UI specs drive the built renderer in plain Chromium; the owner has run it on Windows         |

## Commands that ran

```
$ node scripts/test-nodeps.mjs
Running 19 spec file(s) on Node 22.22.2
# tests 413
# suites 113
# pass 413
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

```
$ npm run typecheck     # tsconfig.node.json and tsconfig.web.json, no errors
$ npm run lint          # eslint . --max-warnings=0, clean
$ npm run format        # prettier --check ., clean
$ npm test              # vitest run: the same 413 specs, all passing
$ npm run build         # main, preload, renderer, out/workers/{database,collector}.js
$ npm run test:e2e      # 42 passed (3 projects)
```

Four things about that block are worth stating rather than leaving to be
inferred:

- **`npm test` used to collect nothing.** The specs register with `node:test`,
  which Vitest cannot see, so the run failed over zero collected tests.
  `vitest.config.ts` aliases `node:test` to `tests/support/node-test-shim.ts`.
- **`src/workers/*.ts` were in no tsconfig project at all**, so they had never
  been typechecked and eslint could not parse them. They are in
  `tsconfig.node.json` now, and clean.
- **`eslint.config.js` was renamed to `eslint.config.mjs`** and given a globals
  configuration; it had been reporting 416 bogus `no-undef` errors. The tree was
  run through prettier for the first time in the same pass.
- **The UI specs ran for the first time.** Three corrections were needed, all in
  the specs: a locator matching a hidden `<select>` option, an assertion that
  basemap tiles are not requested on the opening view when the map is the
  default tab, and a second `installBridge` call attempting to redefine the
  frozen bridge. The application was correct in all three cases. This is
  Chromium against the built renderer bundle with a stub bridge — **not
  Electron**, no database, no network.

The build succeeded on **Linux only**, and a build is not a package. Packaging
remains where the Windows session left it: one installer produced, crashing on
install (criterion 14).

### And on Windows

The suite was also run by the repository owner on **Windows 11 x64 with Node
24.19.0** — the first time any of this code has executed on the target
platform, and on a Node major it was not written against.

That run reported **379 pass, 1 fail**. The failure was a genuine defect in a
spec, not in the code it covers:
`source-url-safety.test.ts` asserted that a resolved browser path began with the
literal `/repo/.playwright-cache/chromium`, but `resolveBundledChromium` builds
its paths with `node:path`'s `join`, which normalises separators to the host's.
The assertion therefore passed on Linux and failed on Windows — the one platform
this application ships on. The spec now builds its expected prefix with `join`
too, and additionally asserts that a development build does not fall back to a
browser elsewhere on the machine.

This is recorded rather than quietly fixed because it is the clearest available
evidence for a claim made throughout this report: **specs that have only ever run
on one platform are weaker evidence than their pass count suggests.** One
Windows run found one such defect immediately. The rest of the suite passed,
including every database spec against real SQLite files, which is meaningful
evidence that the schema and the domain logic are platform-independent.

Two other things that run established:

- The suite runs correctly on **Node 24**, not only the pinned 22.12. The
  `--experimental-strip-types` and `node:sqlite` features the runner depends on
  are present and behave the same.
- `package.json` declares `"node": ">=22.12.0 <25"`. Node 24 is inside that
  range; nothing has been tested on 25 or later.

```
$ node scripts/generate-migrations.mjs --check
Migrations module is up to date (1 migrations).
```

### The first real `npm install`, and a claim it falsified

The owner ran `scripts/windows/build-all.ps1` on Windows 11 with Node 24.19.0.
It got through the toolchain check, 387 specs, and the icon check, then failed
during `npm install`:

```
- preparing  moduleName=better-sqlite3 arch=x64
  Attempting to build a module with a space in the path
Error: Could not find any Python installation to use
node-gyp failed to rebuild '...\node_modules\better-sqlite3'
```

`docs/BUILDING.md` had stated: _"No Visual Studio installation is needed:
`better-sqlite3` ships prebuilt binaries for the Electron ABI."_ **That claim
was false** and has been corrected. No prebuilt binary existed for Electron
44.4.1, so `electron-builder install-app-deps` fell back to compiling from
source, which needs Python and the Visual Studio C++ build tools.

It is recorded here rather than quietly fixed because it is the same failure
mode this report warns about throughout: a statement that was plausible,
untested, and wrong. It had been written into the requirements table as though
it were established.

`build-all.ps1` now checks for Python, the C++ build tools, and a space in the
repository path **before** starting a 500 MB install.

The release pipeline was exercised end to end with a real Ed25519 key pair
generated for the purpose, then deleted along with every artifact it produced.
It behaved correctly in both directions:

```
PASS  manifest signature verified with key cw-pipeline-test
PASS  release 0.1.0 (v0.1.0), sequence 1000
PASS  ChargeWatch-Setup-0.1.0.exe (2.9 MB, installer)

FAIL  ChargeWatch-Setup-0.1.0.exe: size_mismatch          (installer tampered with)
FAIL  manifest signature and claims: bad_signature        (manifest tampered with)
FAIL  manifest signature and claims: replayed_sequence    (sequence replayed)
```

The installer in that run was a placeholder file, not a real build, so what was
proven is the **manifest and verification logic**, not that a genuine installer
passes. That distinction matters and is why item 16 below is a pass while item
14 is not.

Other manual smoke runs, not part of the suite:

- `DatabaseWorker.open()` against a real file-backed SQLite database returned
  `{"status":"ready","schemaVersion":1,"journalMode":"wal"}`.
- CSV export produced a file with provenance comments and the documented
  headers.
- `createBackupNow()` correctly **refused** on a driver without online-backup
  support rather than copying a live WAL file.

## Commands that did NOT run, and why

| Command                                  | Why not                                                          |
| ---------------------------------------- | ---------------------------------------------------------------- |
| ~~`npm ci`~~                             | **now run.** `package-lock.json` is committed                    |
| ~~`npm run lint`~~                       | **now run — clean** (after the eslint config fix below)          |
| ~~`npm run format`~~                     | **now run — clean** (the tree was reformatted first)             |
| ~~`npm run typecheck`~~                  | **now run on Windows and on Linux — clean.** Found two real bugs |
| ~~`npm run test`~~ / `test:coverage`     | `npm test` **now run — 413 passing.** Coverage not run           |
| ~~`npm run test:e2e`~~                   | **now run — 42 passing**, in Chromium, not Electron              |
| ~~`npm run build`~~ / `package:win`      | build **now run on Linux.** Packaging still needs a Windows host |
| `npm run test:installed` / `test:update` | needs a Windows host and a built installer                       |
| Electron, from this session              | not started here; the renderer ran in plain Chromium (see 1a)    |
| live source verification                 | no route to `driver.chargepoint.com` or its terms pages          |
| catalog download                         | no route to `afdc.energy.gov`                                    |

### Two things a reader should not skip

**UPDATE: it has now.** `npm run typecheck` was run on Windows and, after the
fixes recorded below, reports no errors. What follows described the state
before that and is kept because the reasoning still holds for the renderer:
type-stripping executes code without checking types.

**The TypeScript in this repository had never been typechecked.** The
dependency-free specs execute it through Node's type-stripping, which runs code
but does not check types. `npm run typecheck` is expected to surface real
errors on first run — most likely in the modules listed as written-but-never-executed
in `IMPLEMENTATION_STATUS.md`, and in the renderer, which type-stripping never
touches because no spec imports a `.tsx` file.

**UPDATE: the UI specs have now been executed.** All 42 pass against the built
renderer in Chromium, across three projects. As predicted, the selectors written
against the source rather than a running page needed corrections — three of
them, all in the specs, none in the application. What that run does **not**
establish is anything about Electron: the renderer was loaded as a bundle in a
plain browser with a stub bridge and synthetic fixtures.

---

## Definition of done

`P` = passed here · `NT` = not tested · `B` = blocked · `F` = failed

| #   | Criterion                                                                  | Result                               | Evidence or blocker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Repo audited; unrelated changes preserved; base/branch/commit recorded     | **P**                                | Repository was empty (`git ls-remote` returned no refs); nothing to preserve. Branch `chargewatch-v1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2   | Clean-clone build and documented development commands work                 | **Partial**                          | `npm run test:nodeps` and `npm run check:migrations` work from a clean clone with no install — **confirmed on Windows 11 x64 by the owner**, on a machine with only Node and git installed. `npm ci`, `npm run verify` and `npm run build` now all pass — on **Linux only**. Packaging is untested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 3   | Licensed Mesa-area catalog bundled and distance-filtered                   | **B**                                | No route to AFDC. The radius filter is implemented and covered by 5 geo specs. **No catalog data is shipped**; inventing station rows was not an option. `scripts/catalog-refresh.mjs` is written and rejects malformed coordinates, but has never processed a real AFDC file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4   | A real eligible browser adapter collects actual source observations        | **B**                                | The ChargePoint adapter ships `eligibilityState: needs_review`, `verificationState: blocked`. Its parser is a pure function with 23 specs over structured page readings; the Playwright wiring around it has never run. See `SOURCE_VERIFICATION.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 5   | Source scope, eligibility, capabilities and verification documented        | **P**                                | `SOURCES.md`, `SOURCE_VERIFICATION.md`, and the capability record in `src/collector/adapters/chargepoint/index.ts`; 5 specs assert the not-enabled state is surfaced rather than hidden.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | SQLite persists history across restart and handles interrupted collection  | **P**                                | 25 database specs, including close/reopen with history intact, unclean-exit recovery recorded as a gap, and a rolled-back batch leaving committed rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 7   | Occupancy, coverage, counts and colours obey the metric contract           | **P**                                | 77 domain specs, all five §15 acceptance examples, band thresholds asserted at their boundaries, and Phoenix-local attribution proven independent of machine timezone by re-running under `TZ=UTC` and `TZ=Pacific/Kiritimati`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 8   | No exact-session claim based only on periodic snapshots                    | **P**                                | 14 episode specs: left/right censoring, continuity breaks, and "four identical observations produce zero inferred arrivals".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 9   | Footfall import works; unsupported visitor counts remain unknown           | **P (logic)** / **NT (UI)**          | 12 visit specs: proration refused, overlapping datasets rejected, zero visits yields an undefined ratio rather than zero or infinity. The CSV reader has 14 specs. The import UI is built but never rendered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 10  | Overview, Map, details, filters and onboarding complete and usable         | **Partial**                          | The renderer is now written: Overview and Map workspaces, station rail and drawer, heatmap, trend, onboarding and settings, built to the UI handoff. 28 view-model specs and 31 formatter specs pass. It **now builds and renders**: 42 UI specs pass against `out/renderer/` in Chromium, with a stub bridge and synthetic fixtures — never under Electron, never against a database. Usability is still unestablished; the UI specs check honesty rules, not whether anyone can find anything.                                                                                                                                                                                                                                                                                                    |
| 11  | Tray, pause/resume, single-instance, sleep/wake, Quit                      | **NT**                               | All implemented in `src/main/index.ts` and `src/main/tray.ts`, including the power-monitor wiring and the graceful-quit path. None of it has been executed: it requires Electron.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 12  | Exports match the selected data and sanitize untrusted text                | **P**                                | 17 CSV specs including formula-injection payloads, plus a real export smoke run. Numeric measurements are deliberately left untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 13  | Backup/restore and migration recovery implemented and verified             | **P**                                | 6 online-backup specs now run against the **shipping** driver: a 250-site WAL database backed up, verified, digest-matched and restored; 810 rows captured including those still in the WAL; the database record written; and both refusal paths. Restore validation and archive-path safety are separately covered. See ADR-0003.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 14  | Full Windows installer with working browser, native SQLite and assets      | **F**                                | **The installer now BUILDS and passes `verify:package` 10/10 — and then fails to install.** `ChargeWatch-Setup-0.1.0.exe` (328 MB) exits with `-1073740940` (`STATUS_HEAP_CORRUPTION`) during a silent install; the NSIS process crashes rather than reporting an error. Cause **not** established. A subsequent build failed to package at all — `Can't allocate required memory!` from a 32-bit `7za.exe` — and this report briefly claimed that as the cause of both. That was wrong: differential packaging pins the 7z dictionary to 1 MB, so the build that produced the crashing installer never approached that memory ceiling. Two separate faults; the packaging one is fixed (`ELECTRON_BUILDER_7ZIP_PATH`), the crash is not diagnosed. No installer has been successfully built since. |
| 15  | A nondeveloper can use it without a terminal or paid credentials           | **NT**                               | No installer that installs (item 14). The design contains no API key, no account and no paid dependency; the installer is per-user and needs no administrator rights, but that claim is itself untested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 16  | Update artifacts authenticated; failed verification cannot install         | **P**                                | 35 release-manifest specs — attacker signatures, tampered payloads, unknown and retired keys, wrong application/platform/arch/channel, replayed sequences, traversal artifact names and digest mismatches all rejected — plus the end-to-end pipeline run quoted above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 17  | Version A → B installed update preserves marked history and settings       | **NT**                               | `scripts/windows/test-update.ps1` is written and proves in-place migration via the database file's creation time. It needs Windows and two installers — B5. Note its own stated limit: it does not prove observation survival, because it will not write a synthetic observation to do so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 18  | Foreground activity not interrupted; tray update resumes appropriately     | **NT**                               | Gate logic implemented in `UpdateService` with a seam for the updater backend; never executed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 19  | CI, release preparation, signing and artifact verification implemented     | **P (written)** / **NT (never run)** | `ci.yml` and `release.yml` are written; the release workflow keeps the signing key out of the job that runs the project build and stages a draft rather than publishing. Manifest signing and verification are implemented and tested. No workflow has ever executed — GitHub Actions cannot run from here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 20  | GitHub publication/discovery verified, or remaining setup reported         | **P (reported)**                     | Push is blocked — B6. The exact pending commands are in `HANDOFF.md`. No release is claimed to exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 21  | Required docs, real screenshots, source notices and roadmap current        | **Partial**                          | Docs are written and current as of this commit. **No screenshots**: the only rendering so far is headless Chromium over synthetic fixtures, so there is nothing real to photograph; none were faked or mocked up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 22  | Relevant tests and bounded soak ran; failures/skips explicitly reported    | **Partial**                          | 413 specs ran and passed, under both Node's runner and Vitest, plus 42 UI specs. **No soak ran**: a soak needs a live source, which is blocked at item 4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 23  | No production fake data, private credentials, test trust keys or paid core | **P**                                | No catalog data, no keys and no credentials in the tree. Test fixtures are labelled synthetic in `tests/fixtures/chargepoint/README.md` and in the header of `tests/ui/fixtures.ts`, and `scripts/verify-package.mjs` fails a package that contains anything from `tests/`. The Ed25519 key pair used for the pipeline run was deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**Totals: 10 pass, 0 fail, 13 not-tested / blocked / partial.**

The one change since the previous report is item 19, which moved from
not-tested to written-but-never-run. Items 10 and 11 gained implementations
without gaining evidence, which is why they did not move.

## What a reviewer should check first

1. ~~**`npm run typecheck`**~~ — done. It found ~200 errors, of which two were
   real bugs: a duplicate `recordUpdateEvent` that had been silently discarding
   every update event, and an unreachable `partial_coverage` branch revealing a
   status the renderer handles but nothing produces. The rest were a config gap
   and `noUncheckedIndexedAccess` strictness. It now reports no errors.
2. **`src/main/updates-backend.ts`.** The `UpdaterBackend` seam is deliberate,
   but the concrete implementation is written against electron-updater's
   documented API rather than against a running copy of it; its install surface
   differs across versions.
3. **`src/database/worker.ts`.** Exercised against `node:sqlite`, not
   better-sqlite3. The two differ around `backup()` and `pragma()`.
4. **The catalog seed path.** `scripts/catalog-refresh.mjs` has never processed
   a real AFDC file. The field mapping in `CatalogImportRecord` is a declared
   shape, not a verified one.
5. ~~**`tests/ui/honesty.spec.ts`**~~ — run. 42 pass. The three failures on the
   first run were all in the specs, not the application, and are described
   above. What they cover is the renderer bundle in a browser, not the app.

## What would make this report substantially greener

In order of value:

1. ~~Commit the lockfile, run `npm run typecheck`, fix what it finds.~~ Done.
2. ~~`npm run build`, then `npm run test:e2e`.~~ Done on Linux — the renderer
   renders and the honesty rules hold on screen, in a browser.
3. `npm run package:win` on Windows 11 x64, then
   `scripts/windows/test-installed.ps1` on a **non-elevated** account.
   Unblocks items 14, 11 and most of 15.
4. Review ChargePoint's terms and attempt one bounded live read. Unblocks item
   4 and the soak in item 22 — or records honestly that the source is
   ineligible, which is also a real outcome.
5. Two installers plus `scripts/windows/test-update.ps1`. Unblocks items 17
   and 18.
