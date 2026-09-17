# ADR-0001: Electron/TypeScript stack, and why versions are ranges rather than a lockfile

- Status: accepted, with a known gap
- Date: 2026-09-17

## Context

The handoff specifies Electron, TypeScript, React + Vite, SQLite via
better-sqlite3, Playwright's bundled Chromium, Leaflet, a local chart library,
electron-builder and electron-updater, with **exact compatible versions
resolved from current official documentation and locked**, and a committed
`package-lock.json`.

The build environment for this implementation had no route to the npm registry:

```
$ curl -sS -D - -o /dev/null https://registry.npmjs.org/electron
HTTP/2 403
x-deny-reason: host_not_allowed
```

Only `github.com` hosts were reachable. That makes it impossible to resolve real
version metadata, install anything, or generate a lockfile.

## Decision

Adopt the specified stack. Declare dependencies as caret ranges chosen to be
plausible for September 2026, and treat **version resolution and lockfile
generation as an explicit outstanding task** rather than pretending it is done.

One version is evidence-based rather than guessed: the Claude desktop app
running on the target machine reported Electron `44.2.0`, so Electron 44 is
known to exist and to be a current line. Everything else is a considered
estimate.

## Consequences

- `package-lock.json` is **not committed**, because no honest one can be
  produced here. `docs/IMPLEMENTATION_STATUS.md` records this as a blocker and
  `docs/BUILDING.md` gives the exact commands to resolve and lock.
- The first `npm install` on a networked machine is a real step with a real
  chance of version conflicts, particularly:
  - `better-sqlite3` prebuilds versus the pinned Electron ABI
    (`electron-builder install-app-deps` / `@electron/rebuild` must succeed),
  - `electron-updater`'s install API, which has changed across versions —
    `src/main/updates/` deliberately wraps it (see ADR-0005),
  - `playwright-core` versus the bundled Chromium revision.
- CI must never rely on floating `latest`. Once a lockfile exists, `npm ci` is
  the only install command in CI and release workflows.
- No release may be published from an unlocked tree.

## Alternatives considered

**Fabricate a lockfile.** Rejected: a lockfile contains integrity hashes. Ones
we invented would be wrong, and `npm ci` would fail in a way that looks like
corruption rather than like a missing step.

**Vendor dependencies from GitHub tarballs.** Rejected: transitive resolution
would be unreliable, and the Chromium and native SQLite payloads are not
available that way.

**Switch to a smaller stack with fewer native dependencies.** Rejected. The
handoff explicitly forbids swapping to a Rust/Python sidecar to reduce size, and
the registry is blocked for every stack equally, so the change would buy
nothing.
