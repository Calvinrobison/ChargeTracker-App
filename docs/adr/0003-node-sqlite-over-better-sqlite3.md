# ADR-0003: Use Node's built-in `node:sqlite` rather than better-sqlite3

Date: 2026-09-17
Status: Accepted
Supersedes: the driver choice implied by ADR-0001

## Context

ChargeWatch originally used `better-sqlite3` in the packaged application and
Node's built-in `node:sqlite` in the dependency-free specs. That arrangement was
chosen when nothing could be installed in the build environment: `node:sqlite`
made the schema and the repositories testable with zero dependencies, while
`better-sqlite3` was assumed to be the production driver because it is the
mature, well-known choice.

The first real `npm install` on Windows falsified the assumption underneath
that. No prebuilt `better-sqlite3` binary existed for Electron 44.4.1, so
`electron-builder install-app-deps` fell back to compiling from source, which
needs Python and the Visual Studio C++ build tools. It failed:

```
- preparing  moduleName=better-sqlite3 arch=x64
  Attempting to build a module with a space in the path
Error: Could not find any Python installation to use
```

Two things made it worse than a missing dependency. `node-gyp` cannot reliably
compile from a path containing a space, and `C:\Users\First Last\...` is where
most people keep their work. And `docs/BUILDING.md` had stated that no Visual
Studio installation was ever needed — an untested claim sitting in a
requirements table as though established.

There was also a quieter problem that had been present from the start: **the
specs did not test the driver that shipped.** Every database spec ran against
`node:sqlite` while the application ran against `better-sqlite3`. The suite's
strongest evidence — idempotent ingestion, migration refusal, WAL behaviour,
history surviving a reopen — was evidence about code that was not the code being
released.

## Decision

Use `node:sqlite` everywhere. Remove `better-sqlite3`, `@types/better-sqlite3`
and `@electron/rebuild` from the dependency tree, and remove the `postinstall`
hook that existed only to rebuild the native module.

SQLite ships inside Node, and Electron ships Node, so the application needs no
SQLite dependency of its own.

## Consequences

**The application has no native module.** No ABI rebuild per Electron version,
no `asarUnpack` configuration, no compiler toolchain on a build machine, and no
"builds fine, cannot load when packaged" gap. `electron-builder` now runs with
no native step at all.

**The specs test the shipping driver.** This is the more important consequence.
The database specs were always good; they are now also _about the right thing_.

**Online backup is tested for the first time.** `node:sqlite` exposes SQLite's
online backup API as a module-level `backup()` function. That was verified
directly — a 5,000-row WAL-mode database backed up and restored with
`integrity_check` returning `ok` — before this decision was made, not after.
`tests/nodeps/online-backup.test.ts` now covers the success path, the WAL
capture, the database record, and both refusal paths. Previously the backup path
had exactly one piece of evidence: a manual smoke run showing that a driver
_without_ the capability was refused.

**The capability is detected, not assumed.** `ONLINE_BACKUP_AVAILABLE` in the
driver is computed by inspecting the module, because `backup()` arrived in a
specific Node version and Electron picks its own. If it is ever absent,
`supportsOnlineBackup` is false and `createBackup` refuses. That refusal is
correct behaviour: copying a live WAL database file produces an archive that
opens cleanly and is missing every transaction still in the log, and a backup
nobody can restore is worse than an honest refusal to make one.

**The package check inverted.** `verify-package.mjs` and `after-pack.mjs`
previously _required_ `better_sqlite3.node` to be present and unpacked. They now
_fail the build if any `.node` binary appears at all_, because a native module
reappearing means a dependency has quietly reintroduced the ABI rebuild this
decision removed — and it would only break on someone else's machine.

**`node:sqlite` is marked experimental.** It emits an `ExperimentalWarning` and
its API may change. This is the real cost of the decision. Three things make it
acceptable:

- The application uses a small, stable surface: `DatabaseSync`, `prepare`,
  `exec`, `run`/`get`/`all`, pragmas and `backup`. The driver interface in
  `src/database/driver.ts` is deliberately narrow, so a breaking change is
  contained in one adapter file.
- 393 specs run against it on every commit, including the full schema, the
  migrations and the backup path. A behavioural change would be caught.
- The worker asserts availability at startup and fails with one clear sentence
  rather than dying during module loading.

**The escape route is short.** If `node:sqlite` becomes untenable, restoring a
native driver means writing one file implementing `SqliteDriver` and changing
one line in `src/workers/database.ts`. That seam is why this change was three
small edits rather than a rewrite, and it should be kept.

## Alternatives considered

**Pin Electron to a version with a `better-sqlite3` prebuild.** Cheapest
immediate fix, but it makes the Electron version hostage to another project's
release schedule, and every future Electron upgrade re-opens the same question.
It also leaves the specs testing a different driver from the one shipped.

**Install the compiler toolchain on build machines.** Several GB and around
twenty minutes per machine, it does not fix the space-in-path problem, and it
pushes the cost onto every future contributor and onto CI. It solves the symptom
and keeps the cause.

**Keep both drivers, choosing at runtime.** Doubles the surface that must be
tested and guarantees that one of the two paths is under-exercised — which is
exactly the situation this ADR exists to end.
