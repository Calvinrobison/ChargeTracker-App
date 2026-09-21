# Changelog

All notable changes to ChargeWatch are recorded here. This file is the source
the release notes are generated from, so an entry must exist before a version
can be released.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-21

The first version that can record an observation. Until now the application
could show where chargers are and nothing about how busy they are, for three
separate reasons, all fixed here.

### Added

- **ChargePoint is cleared for collection.** The website terms, the driver
  terms (last updated 2026-03-25) and `robots.txt` on every relevant host were
  read in full and recorded in `docs/SOURCE_VERIFICATION.md`; neither document
  restricts automated reading of the public station page, and the page's host
  allows all crawling. A bounded live read of three stations matched by eye.
  The adapter ships `enabled` / `verified` with the review's date, scope and
  basis in its capability record, and `tests/nodeps/source-url-safety.test.ts`
  now refuses `enabled` without them.
- **Station discovery.** Settings → Locations and sources → "Find ChargePoint
  stations" reads the provider's station list for the study area once — the
  same list the driver map page loads, requested from inside that page in the
  bundled browser, paced and capped — and links each station to the catalog
  location with exactly the same name on the same network at the same
  coordinates. Linking, not collection: nothing is recorded, and new links
  start with monitoring off. On the first dry run it linked 674 of the 706
  stations the provider lists for the 50-mile area, every ChargePoint
  location the catalog has, with zero ambiguity and the port count agreeing
  in every case.
- **Monitoring controls.** The station drawer gains a Monitoring section: a
  switch for a linked location, and a paste-a-link box for one the discovery
  step did not link. Settings gains "Monitor all linked" and "Stop monitoring
  all". The IPC contract gains `sources.discover` and `sites.setMonitoredAll`,
  and `StationView` gains `linked` and `monitoringEnabled` so the interface
  can say which of the two is missing instead of "not monitored".
- **Captured page readings.** `tests/fixtures/chargepoint/captured.ts` holds
  the exact objects the extraction script returned on the live page for three
  stations and one bad id; `tests/nodeps/chargepoint-captured.test.ts` runs
  the parser over them (25 specs). The synthetic fixtures stay, relabelled.

### Changed

- **The adapter reads the real page.** The 0.1.0 extraction script was written
  blind against a page nobody had seen; none of its selectors match the live
  site, so it would have reported "layout changed" on every read. It now holds
  on to the page's own `data-qa-id` hooks (`#slideout_station_details`,
  `port_<outletNumber>`, `port_status_pill_<code>`) — the only stable thing on
  a styled-components page — and reports the provider's status code beside
  the visible words. `PARSER_VERSION` is `chargepoint-dom@0.2.0`,
  `ADAPTER_VERSION` 0.2.0, `CAPABILITY_VERSION` 2.
- **Status vocabulary from the provider itself.** The parser encodes
  ChargePoint's own pill definitions (`states.json`, version 1715755545):
  `available`; `in_use` / `in_use_by_driver` → occupied; `unavailable`,
  `maintenance_required`, `out_of_service`, `fault`, `out_of_order`, `closed`
  → out of service; `unreachable`, `unknown`, `out_of_network` → unknown. The
  visible text stays authoritative; a disagreement with the code is recorded
  as a warning. "Closed" is newly recognised as out of service.
- **Durable port identity.** `data-qa-id="port_N"` is the physical outlet
  number (the page interpolates `outletNumber` into it), so the capability
  record now declares `identityReliability: 'durable'` and granularity
  `port`, and per-port history and inferred episodes are on for ChargePoint.
  Bindings written by discovery and by the manual link take the adapter's
  values instead of a hard-coded `station_aggregate` / `none`.
- **Matching.** An exact provider name (after normalisation) on the same
  network within 150 m now auto-confirms at 0.97 (`EXACT_NAME_CONFIDENCE`).
  Token similarity alone cannot tell "BAYWOOD 1" from "BAYWOOD 2" — both
  score 1.0 because single-character tokens are ignored — so exactness is the
  rule, and the sibling bank stays a proposal.
- The manual-link result no longer says collection is disabled; it says to
  turn monitoring on.

### Fixed

- **`release:verify` could not run on Windows, and could not have passed if it
  had.** Two defects, both found by running the real release block on 2026-09-21
  and both fatal to publishing, since `release:publish` runs verification first.
  The script imported the verifier by filesystem path, and `join` on Windows
  produces `C:\...`, which Node's ESM loader reads as the scheme `c:` and
  rejects with `ERR_UNSUPPORTED_ESM_URL_SCHEME` — so the gate crashed before
  doing anything, on the only platform this application ships on. Wrapped in
  `pathToFileURL`. Separately, `--installed-version` defaulted to the literal
  `0.0.1` while `release:prepare` defaults the supported floor to `0.1.0`, so
  the upgrade check asked whether a version _below_ the release's own floor
  could install it — false by construction, failing every release at its own
  gate. It now defaults to the manifest's own `minimumSupportedAppVersion`,
  which asks whether the oldest copy the release claims to support can take it.
- **The way the collector introduced itself broke every page it opened.**
  Found on the second live run, 2026-09-21, after the timer fix above: the
  application collected nothing, every read recorded `timeout`, and the
  circuit breaker opened. `X-Requested-With: ChargeWatch/<version>` was set on
  the browser context, and a header set there is attached to every
  cross-origin request the PAGE makes, not only to ours. `X-Requested-With`
  is not a CORS-safelisted request header, so each of those requests needed a
  preflight the provider does not answer — including the one for
  `states.json`, the file that defines the status pills — and the station page
  rendered "Unable to load page" instead of any status. Isolated by testing
  one variable at a time against the same page: with the header the page never
  renders, without it the same headless browser renders port rows; the user
  agent and `navigator.webdriver` make no difference either way. The
  identifier now rides on the User-Agent, which is safelisted and which the
  page sends anyway, appended to what the browser already says about itself —
  "HeadlessChrome" is left in place, because disguising the client would be a
  different thing entirely and is not something this application does.
  `tests/nodeps/browser-identity.test.ts` covers the appending and refuses a
  context-wide request header being set again.
- **Switching locations on while collecting did not start reading them.**
  Found on the first live run, 2026-09-21: with collection already started on
  an empty queue, turning on 674 locations loaded their due-now queue entries
  into the scheduler but never re-armed the cycle timer, which the preceding
  idle cycle had parked a full target interval away. Nothing was read until
  that timer happened to fire. `CollectorService.load` now spreads overdue
  work and re-arms the cycle immediately when collection is running, so a
  location switched on is read within seconds rather than up to fifteen
  minutes later. Covered by `tests/nodeps/collector-service.test.ts`, which
  drives the service with a controllable clock — the scheduler had specs, the
  service's timer around it had none.
- **The bundled catalog was never imported.** `resources/catalog/
mesa-stations.json` has shipped inside the installer since 0.2.0 and no code
  read it, so every installed copy started with an empty `sites` table and an
  empty map; the installed self-check reported "0 catalog locations" and the
  documentation described 1083. `startDatabase` now imports the file once per
  distinct hash (`importCatalogFile`), through the existing conflict-recording
  refresh path, on both the normal start and `--self-check`. Three specs run
  it against the real shipped file.
- `scripts/windows/test-installed.ps1` failed every build for two reasons that
  were not defects: it asserted a `better_sqlite3` native module that ADR-0003
  removed (the check now asserts the opposite, matching `verify:package`), and
  it read `.ExitCode` without touching the process handle first, so a passing
  self-check reported an empty exit code that "disagreed" with its report.
- `tests/nodeps/catalog-shipped.test.ts` did not typecheck under
  `noUncheckedIndexedAccess` (five `possibly undefined` arithmetic errors), so
  `npm run typecheck` on `main` was red since 2026-09-18. Each provenance
  count is now asserted to be a number before it is added.

### Not done, stated plainly

- No collection cycle has yet run inside the packaged application. The
  extraction script was executed in a desktop browser; Playwright in the
  bundled Chromium has not yet produced an observation. The first
  `npm run dev` after linking and monitoring is that test.
- `reserved`, a sign-in wall and a challenge page were not seen live and
  remain covered only by synthetic fixtures.
- Proposals (near-namesakes) are reported in the discovery result, not yet
  reviewable in the interface; the manual link box is the path for those.

## [0.2.0] - 2026-09-19

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

- **The application could not find the browser it ships.**
  `resolveBundledChromium` looked in `resources/browser/chrome-win/chrome.exe`;
  Playwright writes `chromium-<revision>/chrome-win64/chrome.exe`. The resolver
  now enumerates the real layouts newest-revision-first, and `after-pack.mjs`
  and `verify-package.mjs` share that candidate list via
  `scripts/lib/browser-layout.mjs` — previously both searched the tree for any
  file named `chrome.exe` and passed on a package the application could not
  start from.
- **Automatic updates had never worked in a packaged build.**
  `import('electron-updater')` resolves the CommonJS exports under `.default`,
  so `module.autoUpdater` was `undefined` and configuration threw before
  anything was set. Every package ever built, `v0.1.0` included, could neither
  check for nor install an update; it was reported at WARN and read as a note.
  `resolveAutoUpdater` handles both module shapes, and a module that yields
  nothing usable is now an error that names the consequence.
- **Two signing keys shared one id.** Two different Ed25519 public keys were
  both embedded as `cw-2026-09`, so either private key could sign an update the
  application accepts, under one name. They now carry distinct ids, and
  `parseTrustedKeys` refuses any key file with duplicate ids, malformed entries
  or PRIVATE key material.
- **Startup was silent for as long as it took.** The tray and window were
  created only after the database, collector and health checks — stages
  allowing 180 s, 120 s and 60 s — while bootstrap logged one line and then
  nothing. A slow stage was indistinguishable from a hang. The tray now comes
  up first and each stage logs its start, duration and failure.

### Changed

- **Releases publish from `Calvinrobison/ChargeTracker-App` again.** A period of
  work was done from a fork and pointed `publish.owner` and
  `BRANDING.releaseOwner` at it. Both are back to the owned repository; they
  must agree, or the updater refuses its own download as an untrusted source.

### Known limitations

**No source is cleared for collection**, so no observation is ever recorded and
every occupancy, coverage and activity figure is empty by design. The station
catalog is real; everything about how busy those stations are is not yet
collectable. `docs/SOURCE_VERIFICATION.md` sets out what a review must
establish.

The installer is **not code-signed**, so Windows SmartScreen warns on first
run. The package carries a second full Chromium (432 MB of an 814 MiB payload)
beside the one inside Electron, for a collector that cannot yet run.

`docs/VERIFICATION_REPORT.md` records, per item, what was actually tested and
what was not.
