# Verification report

Date: 2026-09-17
Repository: `Calvinrobison/ChargeTracker-App`
Commit: see `git log -1` on branch `chargewatch-v1`

## Environment

| | |
| --- | --- |
| Build host | Linux x86-64 (cloud container), **not Windows** |
| Node | 22.22.2 |
| SQLite | 3.51.2, via Node's built-in `node:sqlite` |
| npm registry | **unreachable** — `403 x-deny-reason: host_not_allowed` |
| Network | `github.com` hosts only |
| Windows host | none available |
| Electron / Playwright / better-sqlite3 | **never installed, never run** |

Every "pass" below was produced by a command that actually ran on this host.
Every "not tested" says why.

## Commands run

```
$ node scripts/test-nodeps.mjs
Running 13 spec file(s) on Node 22.22.2
# tests 329
# suites 55
# pass 329
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

```
$ node scripts/generate-migrations.mjs --check
Migrations module is up to date (1 migrations).
```

Smoke runs (manual, not part of the suite):

- `DatabaseWorker.open()` against a real file-backed SQLite database:
  `{"status":"ready","schemaVersion":1,"journalMode":"wal"}`
- CSV export produced a file with provenance comments and the documented
  headers; `createBackupNow()` correctly **refused** on a driver without
  online-backup support rather than copying a live WAL file.

## Commands NOT run, and why

| Command | Why not |
| --- | --- |
| `npm ci` | npm registry blocked (`403 host_not_allowed`) |
| `npm run lint` | needs eslint, which could not be installed |
| `npm run typecheck` | needs typescript, which could not be installed |
| `npm run test` / `test:integration` | needs vitest |
| `npm run test:e2e` | needs Playwright and a built renderer |
| `npm run build` / `package:win` | needs electron-vite, electron-builder, Windows |
| `npm run test:installed` / `test:update` | needs a Windows host and a built installer |
| live source verification | no route to `driver.chargepoint.com` or its terms pages |
| catalog download | no route to `afdc.energy.gov` |

**The TypeScript in this repository has never been typechecked.** The
dependency-free specs execute it through Node's type-stripping, which runs code
but does not check types. Expect `npm run typecheck` to surface real errors on
first run, most likely in the modules listed as "written but not executed" in
`IMPLEMENTATION_STATUS.md`.

---

## Definition of done

`P` = passed here · `NT` = not tested · `B` = blocked · `F` = failed

| # | Criterion | Result | Evidence or blocker |
| --- | --- | --- | --- |
| 1 | Repo audited; unrelated changes preserved; base/branch/commit recorded | **P** | Repository was empty (`git ls-remote` returned no refs); nothing to preserve. Branch `chargewatch-v1`. |
| 2 | Clean-clone build and documented development commands work | **NT** | `npm run test:nodeps` works from a clean clone with no install. `npm ci` and `build` untested — B1. |
| 3 | Licensed Mesa-area catalog bundled and distance-filtered | **B** | No route to AFDC. Radius filter itself is implemented and tested (5 geo specs). **No catalog data shipped** — fabricating rows was not an option. |
| 4 | A real eligible browser adapter collects actual source observations | **B** | Adapter ships `needs_review` / `blocked`. See `SOURCE_VERIFICATION.md`. |
| 5 | Source scope, eligibility, capabilities and verification documented | **P** | `SOURCES.md`, `SOURCE_VERIFICATION.md`, and the capability record in `src/collector/adapters/chargepoint/index.ts`; 5 specs assert the not-enabled state. |
| 6 | SQLite persists history across restart and handles interrupted collection | **P** | 25 database specs, including close/reopen with history intact, unclean-exit recovery recorded as a gap, and a rolled-back batch leaving committed rows. |
| 7 | Occupancy, coverage, counts and colours obey the metric contract | **P** | 77 domain specs; all five §15 acceptance examples; band thresholds asserted at boundaries. |
| 8 | No exact-session claim based only on periodic snapshots | **P** | 14 episode specs: left/right censoring, continuity breaks, and "four identical observations produce zero inferred arrivals". |
| 9 | Footfall import works; unsupported visitor counts remain unknown | **P (logic)** / **NT (UI)** | 12 visit specs: proration refused, overlaps rejected, zero visits undefined. The import UI and CSV reader are not built. |
| 10 | Overview, Map, details, filters and onboarding complete and usable | **NT** | View models and their specs exist (28). **The renderer is not built** — I2. |
| 11 | Tray, pause/resume, single-instance, sleep/wake, Quit | **NT** | Pause/resume and sleep/wake are implemented in the collector service; the tray and single-instance lock are I1. |
| 12 | Exports match the selected data and sanitize untrusted text | **P** | 17 CSV specs including formula-injection payloads, plus a real export smoke run. |
| 13 | Backup/restore and migration recovery implemented and verified | **P (logic)** / **NT (with better-sqlite3)** | Restore validation and archive-path safety covered by specs; the online backup path requires better-sqlite3 and was correctly refused here. |
| 14 | Full Windows installer with working browser, native SQLite and assets | **NT** | No Windows host — B4. |
| 15 | A nondeveloper can use it without a terminal or paid credentials | **NT** | No installer yet. The design contains no API key, account or paid dependency. |
| 16 | Update artifacts authenticated; failed verification cannot install | **P** | 35 release-manifest specs: attacker signatures, tampered payloads, retired keys, replays, traversal names and digest mismatches all rejected. |
| 17 | Version A → B installed update preserves marked history and settings | **NT** | Needs Windows and two built installers — B5. |
| 18 | Foreground activity not interrupted; tray update resumes appropriately | **NT** | Gate logic implemented in `UpdateService`; never executed. |
| 19 | CI, release preparation, signing and artifact verification implemented | **NT** | Manifest signing and verification are implemented and tested. Workflows and release scripts are I3/I6. |
| 20 | GitHub publication/discovery verified, or remaining setup reported | **P (reported)** | Push is blocked — B6. Exact pending commands are in `HANDOFF.md`. No release is claimed. |
| 21 | Required docs, real screenshots, source notices and roadmap current | **Partial** | Docs written and current. **No screenshots**, because there is no UI to screenshot — none were faked. |
| 22 | Relevant tests and bounded soak ran; failures/skips explicitly reported | **Partial** | 329 specs ran and passed. **No soak ran**: a soak needs a live source, which is blocked. |
| 23 | No production fake data, private credentials, test trust keys or paid core | **P** | No catalog data, no keys, no credentials in the tree. Fixtures are labelled synthetic in `tests/fixtures/chargepoint/README.md` and are test-only. |

**Totals: 9 pass, 0 fail, 14 not-tested / blocked / partial.**

## Things a reviewer should check first

1. `npm run typecheck` — never run. This is the most likely source of real
   errors.
2. `src/main/updates.ts` — the `UpdaterBackend` seam is deliberate, but the
   concrete implementation for the pinned electron-updater is not written yet;
   its install API differs across versions.
3. `src/database/worker.ts` — exercised against `node:sqlite`, not
   better-sqlite3. The two differ around `backup()` and `pragma()`.
4. The catalog seed path has never processed a real AFDC file. The field mapping
   in `CatalogImportRecord` is a declared shape, not a verified one.

## What would make this report substantially greener

In order of value:

1. `npm install` on a networked machine, commit the lockfile, run
   `npm run typecheck` and fix what it finds. (Unblocks 2, 7-adjacent, 19.)
2. Write `src/main/index.ts` and the renderer. (Unblocks 10, 11, 15.)
3. `npm run package:win` on Windows 11 x64. (Unblocks 14.)
4. Review ChargePoint's terms and attempt one bounded live read. (Unblocks 4
   and the soak in 22 — or records honestly that the source is ineligible.)
5. The two-version update harness. (Unblocks 17, 18.)
