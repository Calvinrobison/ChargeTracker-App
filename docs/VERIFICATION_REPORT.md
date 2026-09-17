# Verification report

Date: 2026-09-17
Repository: `Calvinrobison/ChargeTracker-App`
Branch: `chargewatch-v1` — see `git log -1` for the exact commit.

This report exists so that nobody has to guess what has actually been checked.
Every **P** below was produced by a command that ran on this host and whose
output is quoted or reproducible. Every **NT** says why it was not run. Nothing
is marked green because it looks right in the source.

## Environment

| | |
| --- | --- |
| Build host | Linux x86-64 (cloud container), **not Windows** |
| Node | 22.22.2 |
| SQLite | 3.51.2, via Node's built-in `node:sqlite` |
| npm registry | **unreachable** — `403 x-deny-reason: host_not_allowed` |
| Network | `github.com` hosts only |
| Windows host | none available |
| Electron / Playwright / better-sqlite3 / TypeScript | **never installed, never run** |

## Commands that ran

```
$ node scripts/test-nodeps.mjs
Running 16 spec file(s) on Node 22.22.2
# tests 380
# suites 103
# pass 380
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

```
$ node scripts/generate-migrations.mjs --check
Migrations module is up to date (1 migrations).
```

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

| Command | Why not |
| --- | --- |
| `npm ci` | npm registry blocked (`403 host_not_allowed`) |
| `npm run lint` | needs eslint |
| `npm run format` | needs prettier |
| `npm run typecheck` | needs typescript |
| `npm run test` / `test:coverage` | needs vitest |
| `npm run test:e2e` | needs Playwright and a built renderer |
| `npm run build` / `package:win` | needs electron-vite and electron-builder; packaging needs Windows |
| `npm run test:installed` / `test:update` | needs a Windows host and a built installer |
| live source verification | no route to `driver.chargepoint.com` or its terms pages |
| catalog download | no route to `afdc.energy.gov` |

### Two things a reader should not skip

**The TypeScript in this repository has never been typechecked.** The
dependency-free specs execute it through Node's type-stripping, which runs code
but does not check types. `npm run typecheck` is expected to surface real
errors on first run — most likely in the modules listed as written-but-never-executed
in `IMPLEMENTATION_STATUS.md`, and in the renderer, which type-stripping never
touches because no spec imports a `.tsx` file.

**The UI specs under `tests/ui/` have never been executed.** They are committed
because they encode the right assertions, not because they are known to pass.
The selectors in `tests/ui/honesty.spec.ts` were written against the source
rather than against a running page, so the first `npm run test:e2e` is expected
to need corrections. A green CI `ui-smoke` job is the first real evidence about
them; this file is not.

---

## Definition of done

`P` = passed here · `NT` = not tested · `B` = blocked · `F` = failed

| # | Criterion | Result | Evidence or blocker |
| --- | --- | --- | --- |
| 1 | Repo audited; unrelated changes preserved; base/branch/commit recorded | **P** | Repository was empty (`git ls-remote` returned no refs); nothing to preserve. Branch `chargewatch-v1`. |
| 2 | Clean-clone build and documented development commands work | **Partial** | `npm run test:nodeps` and `npm run check:migrations` work from a clean clone with no install, and are the two commands `docs/BUILDING.md` leads with. `npm ci` and `npm run build` untested — B1. |
| 3 | Licensed Mesa-area catalog bundled and distance-filtered | **B** | No route to AFDC. The radius filter is implemented and covered by 5 geo specs. **No catalog data is shipped**; inventing station rows was not an option. `scripts/catalog-refresh.mjs` is written and rejects malformed coordinates, but has never processed a real AFDC file. |
| 4 | A real eligible browser adapter collects actual source observations | **B** | The ChargePoint adapter ships `eligibilityState: needs_review`, `verificationState: blocked`. Its parser is a pure function with 23 specs over structured page readings; the Playwright wiring around it has never run. See `SOURCE_VERIFICATION.md`. |
| 5 | Source scope, eligibility, capabilities and verification documented | **P** | `SOURCES.md`, `SOURCE_VERIFICATION.md`, and the capability record in `src/collector/adapters/chargepoint/index.ts`; 5 specs assert the not-enabled state is surfaced rather than hidden. |
| 6 | SQLite persists history across restart and handles interrupted collection | **P** | 25 database specs, including close/reopen with history intact, unclean-exit recovery recorded as a gap, and a rolled-back batch leaving committed rows. |
| 7 | Occupancy, coverage, counts and colours obey the metric contract | **P** | 77 domain specs, all five §15 acceptance examples, band thresholds asserted at their boundaries, and Phoenix-local attribution proven independent of machine timezone by re-running under `TZ=UTC` and `TZ=Pacific/Kiritimati`. |
| 8 | No exact-session claim based only on periodic snapshots | **P** | 14 episode specs: left/right censoring, continuity breaks, and "four identical observations produce zero inferred arrivals". |
| 9 | Footfall import works; unsupported visitor counts remain unknown | **P (logic)** / **NT (UI)** | 12 visit specs: proration refused, overlapping datasets rejected, zero visits yields an undefined ratio rather than zero or infinity. The CSV reader has 14 specs. The import UI is built but never rendered. |
| 10 | Overview, Map, details, filters and onboarding complete and usable | **Partial** | The renderer is now written: Overview and Map workspaces, station rail and drawer, heatmap, trend, onboarding and settings, built to the UI handoff. 28 view-model specs and 31 formatter specs pass. **Nothing has rendered it** — no build, no browser. Usability is therefore unestablished. |
| 11 | Tray, pause/resume, single-instance, sleep/wake, Quit | **NT** | All implemented in `src/main/index.ts` and `src/main/tray.ts`, including the power-monitor wiring and the graceful-quit path. None of it has been executed: it requires Electron. |
| 12 | Exports match the selected data and sanitize untrusted text | **P** | 17 CSV specs including formula-injection payloads, plus a real export smoke run. Numeric measurements are deliberately left untouched. |
| 13 | Backup/restore and migration recovery implemented and verified | **P (logic)** / **NT (with better-sqlite3)** | Restore validation and archive-path safety are covered by specs; the online backup path requires better-sqlite3 and was correctly refused on the `node:sqlite` driver here. |
| 14 | Full Windows installer with working browser, native SQLite and assets | **NT** | No Windows host — B4. `scripts/verify-package.mjs` and `scripts/windows/test-installed.ps1` are written and will perform these checks; neither has run. |
| 15 | A nondeveloper can use it without a terminal or paid credentials | **NT** | No installer exists yet. The design contains no API key, no account and no paid dependency; the installer is per-user and needs no administrator rights, but that claim is itself untested (see item 14). |
| 16 | Update artifacts authenticated; failed verification cannot install | **P** | 35 release-manifest specs — attacker signatures, tampered payloads, unknown and retired keys, wrong application/platform/arch/channel, replayed sequences, traversal artifact names and digest mismatches all rejected — plus the end-to-end pipeline run quoted above. |
| 17 | Version A → B installed update preserves marked history and settings | **NT** | `scripts/windows/test-update.ps1` is written and proves in-place migration via the database file's creation time. It needs Windows and two installers — B5. Note its own stated limit: it does not prove observation survival, because it will not write a synthetic observation to do so. |
| 18 | Foreground activity not interrupted; tray update resumes appropriately | **NT** | Gate logic implemented in `UpdateService` with a seam for the updater backend; never executed. |
| 19 | CI, release preparation, signing and artifact verification implemented | **P (written)** / **NT (never run)** | `ci.yml` and `release.yml` are written; the release workflow keeps the signing key out of the job that runs the project build and stages a draft rather than publishing. Manifest signing and verification are implemented and tested. No workflow has ever executed — GitHub Actions cannot run from here. |
| 20 | GitHub publication/discovery verified, or remaining setup reported | **P (reported)** | Push is blocked — B6. The exact pending commands are in `HANDOFF.md`. No release is claimed to exist. |
| 21 | Required docs, real screenshots, source notices and roadmap current | **Partial** | Docs are written and current as of this commit. **No screenshots**, because nothing has rendered the UI; none were faked or mocked up. |
| 22 | Relevant tests and bounded soak ran; failures/skips explicitly reported | **Partial** | 380 specs ran and passed. **No soak ran**: a soak needs a live source, which is blocked at item 4. |
| 23 | No production fake data, private credentials, test trust keys or paid core | **P** | No catalog data, no keys and no credentials in the tree. Test fixtures are labelled synthetic in `tests/fixtures/chargepoint/README.md` and in the header of `tests/ui/fixtures.ts`, and `scripts/verify-package.mjs` fails a package that contains anything from `tests/`. The Ed25519 key pair used for the pipeline run was deleted. |

**Totals: 10 pass, 0 fail, 13 not-tested / blocked / partial.**

The one change since the previous report is item 19, which moved from
not-tested to written-but-never-run. Items 10 and 11 gained implementations
without gaining evidence, which is why they did not move.

## What a reviewer should check first

1. **`npm run typecheck`.** Never run, and the highest-yield check available.
   The renderer is the most exposed part: no spec imports a `.tsx` file, so
   type-stripping has never even parsed those modules.
2. **`src/main/updates-backend.ts`.** The `UpdaterBackend` seam is deliberate,
   but the concrete implementation is written against electron-updater's
   documented API rather than against a running copy of it; its install surface
   differs across versions.
3. **`src/database/worker.ts`.** Exercised against `node:sqlite`, not
   better-sqlite3. The two differ around `backup()` and `pragma()`.
4. **The catalog seed path.** `scripts/catalog-refresh.mjs` has never processed
   a real AFDC file. The field mapping in `CatalogImportRecord` is a declared
   shape, not a verified one.
5. **`tests/ui/honesty.spec.ts`.** Expect selector failures on first run; they
   are cheap to fix and the assertions behind them are the point.

## What would make this report substantially greener

In order of value:

1. `npm install` on a networked machine, commit the lockfile, run
   `npm run typecheck`, fix what it finds. This unblocks items 2 and 19 and is
   a precondition for everything below.
2. `npm run build`, then `npm run test:e2e`. First evidence that the renderer
   renders and that the honesty rules hold on screen. Unblocks item 10.
3. `npm run package:win` on Windows 11 x64, then
   `scripts/windows/test-installed.ps1` on a **non-elevated** account.
   Unblocks items 14, 11 and most of 15.
4. Review ChargePoint's terms and attempt one bounded live read. Unblocks item
   4 and the soak in item 22 — or records honestly that the source is
   ineligible, which is also a real outcome.
5. Two installers plus `scripts/windows/test-update.ps1`. Unblocks items 17
   and 18.
