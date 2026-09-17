# Changelog

All notable changes to ChargeWatch are recorded here. This file is the source
the release notes are generated from, so an entry must exist before a version
can be released.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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

### Known limitations

No release has been published. Live collection, the bundled station catalog and
the Windows installer are **blocked** rather than done; `docs/VERIFICATION_REPORT.md`
records, per item, what was actually tested and what was not.
