# Testing

What each suite covers, what none of them cover, and how to run them.

The organising idea: the parts of ChargeWatch that must not be wrong — the
metric contract, the SQL schema, the scheduler budget, the source parser, the
update verifier and the display formatters — are testable **with nothing
installed**. That was not a convenience; it is why 380 specs exist for a project
whose dependency tree has never been resolved.

---

## The suites

| Suite | Command | Needs | Status |
| --- | --- | --- | --- |
| No-dependency specs | `npm run test:nodeps` | Node 22.12+ | **380 passing** |
| Same specs under Vitest | `npm test` | the dependency tree | never run |
| Integration specs | `npm test` | the dependency tree | **directory is empty** |
| UI specs | `npm run test:e2e` | Playwright, a built renderer | **never run** |
| Installed-build check | `.\scripts\windows\test-installed.ps1` | Windows, a packaged build | never run |
| Upgrade check | `.\scripts\windows\test-update.ps1` | Windows, two installers | never run |

### `npm run test:nodeps` — 380 specs

Runs on Node's built-in test runner using `--experimental-strip-types` and
`node:sqlite`. No install, no network, no mock database: the schema under test
is the same `001_initial.sql` that ships.

```powershell
npm run test:nodeps
npm run test:nodeps -- --filter metrics    # one file
```

| Area | Specs | What it establishes |
| --- | --- | --- |
| Domain and metrics | 77 | Half-open intervals, bounded carry-forward, port-minute weighting, all five §15 acceptance examples, Phoenix-local attribution independent of machine timezone |
| Database | 25 | Idempotent ingestion, migration refusal on checksum mismatch and newer schema, savepoint transactions, close/reopen with history intact, unclean-exit recovery |
| View models | 28 | Every screen's data built from one shared window |
| Collector | 51 | Token-bucket budget, jittered backoff capped at 6h, `Retry-After` honoured and never shortened, circuit breaker, source pause vs retry, ChargePoint extraction, URL safety |
| Security, paths, contracts | 72 | CSP, navigation and permission denial, sender identity, diagnostic redaction, data-path placement, the IPC registry, the hand-written validator |
| Update authenticity | 35 | Signature, claim, sequence, schema, artifact digest and traversal checks |
| CSV | 31 | Formula-injection neutralisation on untrusted text only, missing values exported empty, strict instant parsing |
| Display formatting | 31 | `null` never becomes a number; a measured zero stays distinguishable from an absent measurement |
| Episodes and visits | 26 | Censoring, continuity breaks, refused proration, undefined ratios |

### `npm test` — Vitest

Runs the same no-dependency specs **plus** anything under
`tests/integration/`. Running them under both runners is deliberate: a change
that breaks them under one but not the other is caught rather than hidden.

`tests/integration/` is empty. `passWithNoTests` is deliberately off, because a
green run over zero tests is the most misleading result a suite can produce — so
until integration specs exist, that project fails, which is the honest state.

What belongs there: anything needing `better-sqlite3` under the Electron ABI,
`electron-updater`, or the real Playwright browser API. Those are precisely the
modules `docs/VERIFICATION_REPORT.md` lists as written-but-never-executed.

### `npm run test:e2e` — UI specs

Loads the **built** renderer bundle in Chromium with a stub preload bridge that
answers from `tests/ui/fixtures.ts`. No Electron, no database, no network.

This is the only automated check on the last step of the honesty chain: a
missing measurement can survive every domain and database guarantee and still be
printed as `0%`.

```powershell
npm run build
npm run test:e2e
npm run test:e2e:ui    # interactive
```

**These specs have never been executed.** Their selectors were written against
the source rather than against a running page, so expect corrections on first
run. Correct the selector, not the assertion.

Two properties of the harness are worth preserving if you extend it:

- **An operation with no fixture is rejected**, with the operation name in the
  error. A stub that answered `{}` would let a test pass because the renderer
  tolerated a response nobody wrote.
- **Every invocation is recorded**, so a test can assert what the renderer asked
  for — including that it did *not* ask for something.

Every value in `tests/ui/fixtures.ts` is synthetic and labelled as such in the
file header. `scripts/verify-package.mjs` fails a package that contains anything
from `tests/`.

### The Windows scripts

These test the **installed** build, which is the only place several claims can
honestly be established.

`test-installed.ps1` installs the package, runs the installed executable with
`--self-check` against a throwaway data directory, and uninstalls. The
`--self-check` mode runs the genuine startup sequence — open and migrate the
database, start the bundled browser, run the onboarding health checks — with no
window, no tray, no collection loop and no updater, then writes a JSON report
and exits nonzero if the installation is broken.

The report separates two things on purpose:

- **integrity** — writable data folder, database, bundled browser. These must
  pass. A failure means the package is broken.
- **readiness** — an eligible source, a loaded station catalog. These are
  reported but do not fail the run, because they are expected to be unmet in a
  fresh install today. Failing on them would mean a correct package could never
  pass.

`test-update.ps1` installs version A, fingerprints its database, installs
version B, and checks that the same file was migrated rather than replaced —
using the file's creation timestamp, which survives an in-place upgrade and does
not survive a recreation. It also checks that every migration A applied is still
recorded, that no row counts went down, and that `PRAGMA integrity_check` still
returns `ok`.

It states its own limit plainly: it seeds no synthetic observations, so the
survival of observations specifically is untested. Writing a fabricated
observation row — even in a sandbox, even for a test — is exactly what this
project refuses to do. Re-run with `-ExistingHistory` against a genuinely
populated file to close that gap.

---

## What nothing tests

Stated here so it is not discovered by a user.

- **Whether the interface is usable.** The UI specs check honesty rules, not
  whether anyone can find anything.
- **Whether collection works against a real provider.** No source has been
  cleared, so no end-to-end collection has ever happened. The parser is tested
  as a pure function over structured page readings; the browser wiring around it
  is not.
- **Anything over a long run.** No soak test has run. Backoff behaviour under
  sustained failure, database growth, and memory over days are all unmeasured.
- **Accessibility.** No automated or manual audit has been done. The components
  carry roles and labels, and colour is never the only signal — but that is a
  design property, not a tested one.
- **The updater end to end.** Signature and claim checks are heavily tested.
  Discovery, download and install against a real GitHub release are not.

---

## Adding a spec

Put it in `tests/nodeps/` if it can run without dependencies. That is worth some
effort: a spec that needs the dependency tree cannot run in the situation this
project has spent most of its life in.

A spec earns its place by describing a way the software could mislead someone,
not by covering a line. The formatter specs are the clearest example — each one
names the specific wrong impression it prevents, and several assert a **pair**
(`pct(0)` and `pct(null)` must differ) rather than a single value, because the
failure being guarded against is the two becoming indistinguishable.

Coverage thresholds in `vitest.config.ts` are set to what the specs actually
achieve, over the correctness-critical modules only. Raise them when coverage
rises. Never lower them to make a run pass.
