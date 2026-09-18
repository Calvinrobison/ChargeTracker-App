# Changelog

All notable changes to ChargeWatch are recorded here. This file is the source
the release notes are generated from, so an entry must exist before a version
can be released.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

Nothing yet.

## 0.1.0 — 2026-09-18

First release. Packaged, installed and started on Windows 11; ships a catalog
of 1083 charging locations within 50 miles of Mesa. Collection is **not**
enabled: no source has been cleared for automated observation, so the map shows
where the chargers are and nothing about how busy they are.

The installer is unsigned, so Windows will warn on first run.

### Added

- **Domain and metric engine.** Half-open interval arithmetic, carry-forward
  bounded by the freshness policy persisted with each observation, occupancy
  and coverage metrics, port-minute weighted aggregation, Phoenix-local
  weekday/hour attribution, ranking eligibility, censored episode inference,
  visit alignment and ratios, study-radius geography and catalog matching.
- **SQLite layer.** 28 tables with `STRICT` typing and range-checked
  millisecond instants, checksummed migrations embedded at build time,
  idempotent ingestion, re-entrant savepoint transactions, online-backup-API
  backups verified before publication, and a staged restore that preserves the
  previous database.
- **Collector.** Adapter contract, scheduler with a source token bucket,
  jittered backoff capped at six hours, `Retry-After`, a circuit breaker,
  source pause for sign-in walls and access blocks, overdue-work spreading
  after sleep, and a ChargePoint extractor tested against labelled synthetic
  fixtures.
- **Desktop shell.** Electron main process with a single-instance lock, session
  level CSP, navigation and permission denial, validated IPC routing,
  close-to-tray with collection continuing, and supervised utility-process
  workers for the database and the collector.
- **Renderer.** Overview and Map workspaces, station rail with collapse modes,
  404px detail drawer, Leaflet map with metric modes and a
  basemap-unavailable state, onboarding and a settings drawer — built to the
  UI handoff.
- **Update authenticity.** Ed25519 signed release manifest verified against a
  key embedded in the application, with replay, downgrade, wrong-target and
  tampered-artifact all rejected.
- **Tooling.** Catalog refresh, browser bundling, key bootstrap, package
  verification and a release pipeline whose verify step uses the same code the
  application uses.
- **`--self-check` startup mode.** Runs the real startup sequence with no
  window, tray, collection loop or updater, writes a machine-readable report and
  exits nonzero if the installation is broken. It separates integrity (writable
  data folder, database, bundled browser) from readiness (an eligible source, a
  loaded catalog), so a correct package is not failed for things it is not yet
  able to do.
- **Windows test harness.** `test-installed.ps1` installs a package, runs the
  self-check against a throwaway data directory and uninstalls.
  `test-update.ps1` proves an upgrade migrates the existing history file in
  place rather than replacing it. `db-probe.mjs` reads a history file read-only
  and prints a fingerprint.
- **Continuous integration.** Four-job CI with the no-install specs first, and a
  release workflow that keeps the signing key out of the job that runs the
  project build, refuses to sign without a key rather than falling back to an
  unsigned manifest, and stages a draft rather than publishing.
- **Display-layer specs.** 31 specs over the renderer's formatters — the last
  place a missing measurement could become a number.
- **Issue and pull request templates**, including a data-accuracy template and a
  data-honesty checklist that applies to every change.

### Fixed

- **The lockfile.** `package-lock.json` is committed. Every check beyond
  `test:nodeps` was blocked on a dependency tree that had never been resolved.
- **`npm test` collected nothing.** The specs under `tests/nodeps` register with
  `node:test`, which Vitest cannot see, so all 19 files failed with "No test
  suite found" while `vitest.config.ts` described itself as covering them.
  `node:test` is now aliased to a shim re-exporting the same names from Vitest,
  and 413 specs pass under both runners.
- **The worker entry points were typechecked by nothing.**
  `src/workers/database.ts` and `src/workers/collector.ts` belonged to no
  tsconfig project, so two modules that ship in the packaged app were invisible
  to `tsc` and unparseable by eslint. Both are in `tsconfig.node.json` now.
- **`release-verify.mjs` accepted `--installed-version` and ignored it.** The
  upgrade-path check the installed updater performs — `isDirectUpgradePermitted`,
  which refuses a release that would skip a required data migration — was
  therefore not part of the release gate. It is now.
- **The lint configuration reported 930 problems that were not in the code.** No
  globals were declared, so every `process`, `console` and `window` was an
  undefined variable, and `node:test`'s `describe`/`it` were 514 dropped
  promises. Renamed to `eslint.config.mjs`, because `"type": "module"` would
  make Node read the packaged CJS main bundle as ESM.
- **The UI specs had never been executed.** All 42 now pass against the built
  renderer in Chromium. Three corrections were needed, all in the specs: a
  locator matching a hidden `<option>`, an assertion that basemap tiles are not
  requested on the opening view when the map is the tab the app opens on, and a
  second `installBridge` call redefining the frozen bridge. The application was
  correct in each case.
- **Formatting.** `prettier --check` had never passed; 105 files did not match
  the project's own configuration.
- **The packaged Windows app could not start.** `WindowManager.appOrigins` built
  the trusted renderer prefix as `'file://' + path`, which is correct on POSIX
  and yields `file://C:/...` — two slashes — on Windows, where Electron reports
  three. Origins are matched by string prefix, so every IPC message from the
  application's own window was rejected and the first call the renderer made
  failed, showing "ChargeWatch could not start". Construction moved to
  `security.ts`, which imports nothing and can therefore be reached by the
  dependency-free specs; five specs now cover it. Only reachable in a packaged
  build — in development the renderer is served over http.
- **The history file was written to the roaming profile.** The data root came
  from `app.getPath('userData')`, which on Windows derives from `%APPDATA%`.
  The application raised `cloud_roaming_directory` against its own data
  directory on every start, and a live WAL database in a OneDrive-synced folder
  can be corrupted by the sync client. Windows now reads `%LOCALAPPDATA%`,
  which is what the documentation already promised.
- **`--self-check` hung instead of failing.** Each RPC had a timeout, but they
  run in sequence and the collector's default is 120 s, so an unresponsive
  worker produced roughly ten silent minutes and no report. The run now has a
  90 s ceiling and exits non-zero when it expires.

- **A bundled station catalog.** 1083 charging locations within 50 miles of
  Mesa, built from the AFDC Arizona export and shipped in `resources/catalog`
  with a `provenance.json` recording the retrieval date, origin, licence,
  attribution, file hash and field mapping. The first run of that mapping
  against a genuine AFDC file accepted 1083 of 1652 rows with zero bad
  coordinates and zero duplicates.

### Known limitations

No release has been published. Live collection, the bundled station catalog and
the Windows installer are **blocked** rather than done; `docs/VERIFICATION_REPORT.md`
records, per item, what was actually tested and what was not.
