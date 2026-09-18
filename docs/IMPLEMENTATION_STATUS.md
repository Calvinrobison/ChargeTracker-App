# Implementation status

Last updated: 2026-09-17.

This is the resume point. It records what is done with evidence, what is
blocked with the reason, and what is next with the exact command.

**Repository**: `Calvinrobison/ChargeTracker-App`
**Base commit**: none — the repository was empty (`git ls-remote` returned no
refs), so this is an initial implementation. No unrelated changes existed to
preserve.
**Branch**: `chargewatch-v1` (local; not yet pushed — see _Blocked_ below)
**Schema version**: 1
**Test count**: 413 specs / 113 suites, all passing, via `npm run test:nodeps` —
on Linux with Node 22.22.2, and (at 380) on Windows 11 x64 with Node 24.19.0.
The same 413 specs now also pass under Vitest via `npm test`. The Windows
run found one real defect in a spec that had only ever run on Linux; it is fixed
and recorded in `VERIFICATION_REPORT.md`.

---

## The environment this was built in, and why it shaped the outcome

Four hard constraints, all verified rather than assumed:

1. **npm registry unreachable.**
   `curl https://registry.npmjs.org/electron` → `403 x-deny-reason: host_not_allowed`.
   Only `github.com` hosts were routable. No dependency could be installed, so
   nothing requiring Electron, React, Vite, Playwright, better-sqlite3 or
   electron-builder could be built, typechecked or run.
2. **No Windows host.** The build ran on Linux. NSIS packaging, the bundled
   Chromium payload, the native SQLite rebuild for the Electron ABI and the
   A→B installed update test all require Windows.
3. **`afdc.energy.gov` and `driver.chargepoint.com` unreachable** (same egress
   policy), so the station catalog could not be downloaded and the ChargePoint
   terms review and live verification could not be performed.
4. **No GitHub write access.** `git push` → _"Calvinrobison/ChargeTracker-App
   is not in this session's authorized repository set."_ Read-only clone
   worked.

The response to these was to find what _could_ be verified rather than to
produce unverifiable volume. Node 22 can execute TypeScript directly
(`--experimental-strip-types`) and ships `node:sqlite` (SQLite 3.51.2). That
made the highest-risk areas — the metric contract, the real SQL schema, the
scheduler budget, the source parser, the IPC contract, the security policy, the
update verifier and the display formatters — genuinely testable with zero
dependencies.

---

## Done, with evidence

Every item in this section is covered by specs that run via
`npm run test:nodeps`.

### Domain and metrics — 77 specs

- Half-open intervals, carry-forward bounded by the freshness policy persisted
  _with each observation_, so changing a setting cannot rewrite history.
- All five §15 acceptance examples (A–E) pass, including the ten-port outage
  case where occupancy is 50%, known coverage 100% and operational coverage 20%.
- Gaps are never bridged; missing time is never zero usage.
- Port-minute weighted aggregation, so averaging site percentages cannot happen.
- Phoenix-local weekday/hour attribution, proven independent of machine
  timezone by running the same input under `TZ=UTC` and `TZ=Pacific/Kiritimati`.
- Ranking eligibility (7 days, 90% coverage, known capacity, supported
  occupancy), with provisional locations kept visible.
- Episode inference with left/right censoring, continuity breaks and uncertain
  short flips retained rather than debounced away.
- Visit alignment refusing proration, overlapping datasets and mismatched
  definitions; zero visits yields an undefined ratio, not zero or infinity.
- Radius geography and catalog matching where proximity alone never auto-merges.

Files: `src/domain/`, `tests/nodeps/{metrics,episodes,ranking-visits-geo}.test.ts`.

### Database — 25 specs + 28 view-model specs

- 28 tables, 54 indexes, `STRICT` typing, range-checked millisecond instants,
  CHECK constraints rejecting negative and impossible counts.
- Idempotent ingestion: retrying one attempt cannot double-write, while the
  same status at a new scheduled time is kept as new evidence.
- Migrations are canonical `.sql` files embedded at build time (no path
  resolution inside `app.asar`). A changed historical migration or a
  newer-than-supported schema is refused without touching the database.
- Re-entrant savepoint transactions, so composed writes are one atomic unit.
- History survives close and reopen; a rolled-back batch leaves committed rows.
- Catalog refresh records conflicts instead of overwriting user corrections,
  and never erases observations.
- Unclean exit detected via heartbeat and recorded as a gap.
- Backups go through SQLite's online backup API and are verified before being
  published; a driver that cannot do that is refused rather than copying a live
  WAL file. Restore validates, stages, re-verifies and preserves the previous
  database.
- CSV export neutralises formula injection in untrusted text while leaving
  numeric measurements untouched; a missing value exports empty, never zero.

Files: `src/database/`, `tests/nodeps/{database,csv-backup,csv-read,queries}.test.ts`.

### Collector — 51 specs

- Scheduler with a source token bucket enforcing the 30-second minimum
  navigation interval; manual refresh spends the same budget.
- Jittered exponential backoff capped at six hours, `Retry-After` honoured and
  never shortened, circuit breaker, and source _pause_ (not retry) for sign-in
  walls, access blocks and layout changes.
- Overdue work spread after sleep rather than stampeding the provider; the
  achievable cadence is reported when the enabled set cannot fit the target.
- ChargePoint extraction as a pure function over a structured page reading:
  status vocabulary, unknown-not-available, aggregate-only summaries,
  connector-vs-port capacity, "last used" never counted, identity mismatch
  rejected, every failure condition mapped to its own outcome.
- URL safety: only `https` ChargePoint origins; `file:`, `javascript:`, `data:`,
  localhost, link-local and look-alike hosts all refused.

Files: `src/collector/`, `tests/nodeps/{scheduler,chargepoint-parse,source-url-safety}.test.ts`.

### Security, paths and contracts — 72 specs

- CSP with no remote scripts, fonts or stylesheets in production; development
  exceptions kept strictly separate.
- Navigation denied except the app's own document; permissions all denied; IPC
  senders validated by window identity, main frame and document origin.
- Diagnostic redaction of tokens, cookies, authorization headers and the user's
  home path.
- Data paths under local app data, outside the install directory, warning on
  cloud-roaming folders, with export destinations refused inside the live
  database, profile or update-cache directories.
- Versioned IPC contract where every operation is named with a schema, timeout,
  and mutating/cancellable flags, and destructive operations refuse an
  unconfirmed request in the schema itself.
- Hand-written runtime validator keeping null and undefined distinct, stripping
  unknown keys, rejecting fractional integers and out-of-range instants, and
  resisting prototype pollution (ADR-0002).

Files: `src/main/{security,paths,router}.ts`, `src/shared/`,
`tests/nodeps/{security-paths,ipc-contract,validate}.test.ts`.

### Update authenticity — 35 specs

- Ed25519 over the exact bytes written to disk, verified before parsing.
- Rejects attacker signatures, tampered payloads, unknown and retired keys,
  wrong application/platform/arch/channel, unsupported manifest format or
  protocol, version or tag disagreement with the updater, replayed or equal
  release sequences, unsupported schema ranges, missing artifacts and
  path-traversing artifact names.
- Artifact bytes checked against size, SHA-256 and SHA-512; downloads
  restricted to the configured release source.
- The pipeline was run end to end with a real key pair and correctly rejected a
  tampered installer, a tampered manifest and a replayed sequence. The key pair
  and every artifact were then deleted.

Files: `src/shared/release-manifest.ts`, `tests/nodeps/release-manifest.test.ts`.

### Display formatting — 31 specs

The last place a missing measurement can become a number.

- `null` never renders as `0`, and a measured zero is always distinguishable
  from an absent measurement — asserted as an explicit pair, not implied.
- `NaN` and `Infinity` are refused as well as `null`, because a ratio over a
  zero denominator arrives as one of those.
- "Stale source" and "source freshness unknown" stay separate statements.
- An unwatched heatmap hour gets its own ramp step; an observed zero does not.
- Every status dot has words beside it, so colour is never the only signal.
- An unknown offline count is not reported as a fault.

Files: `src/renderer/src/format.ts`, `tests/nodeps/format.test.ts`.

### Written but NOT executed

These are complete and reviewable, but nothing has run them, because running
them needs Electron, or Windows, or a cleared source — none of which this
environment has. They are **not** claimed as working.

| Area                                                                | Files                                                                                                                                                                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application entry, window, tray, worker supervision, update service | `src/main/{index,window,tray,workers,updates,updates-backend,logger}.ts`                                                                                                                           |
| The `--self-check` startup mode and its integrity/readiness report  | `src/main/index.ts`                                                                                                                                                                                |
| Preload bridge                                                      | `src/preload/index.ts` — the UI specs use a stub bridge, not this one                                                                                                                              |
| Worker entry points                                                 | `src/workers/{database,collector}.ts` — they now build and typecheck, but nothing has forked them                                                                                                  |
| Browser runtime and the Playwright wiring around the tested parser  | `src/collector/{browser,service}.ts`, `src/collector/adapters/chargepoint/index.ts`                                                                                                                |
| Packaging configuration                                             | `electron-builder.yml`, `scripts/{after-pack,setup-browser}.mjs`                                                                                                                                   |
| Package and release tooling                                         | `scripts/{verify-package,catalog-refresh,keys-bootstrap,release-prepare,release-verify,release-publish}.mjs` — the release trio was exercised against placeholder artifacts, the others not at all |
| Windows test harness                                                | `scripts/windows/{test-installed,test-update}.ps1`, `scripts/windows/db-probe.mjs`                                                                                                                 |
| CI and release workflows                                            | `.github/workflows/{ci,release}.yml`                                                                                                                                                               |

`src/database/worker.ts` is a partial exception: it was smoke-run successfully
against `node:sqlite` (opens, migrates with WAL, seeds settings, exports CSV,
correctly refuses a backup on a driver without online-backup support), but never
under Electron with better-sqlite3.

`src/renderer/` and `tests/ui/` have come off this list. `npm run build`
succeeds (main, preload, renderer and both worker bundles) and the 42 UI specs
pass against the built renderer in Chromium. That is Chromium with a stub
bridge and synthetic fixtures — **not** Electron, no database, no collection.

---

## Blocked, with the precise reason

| #      | Item                                   | Blocker                                                                                                                                          | What unblocks it                                                                                             |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| ~~B1~~ | ~~`package-lock.json`~~                | **Resolved.** The lockfile exists and is committed; `npm ci` installs from it (`docs/BUILDING.md`)                                               | —                                                                                                            |
| B2     | Live ChargePoint collection            | No route to `driver.chargepoint.com` **or** to its terms pages. The adapter ships `eligibilityState: needs_review`, `verificationState: blocked` | A terms review with recorded scope, then a bounded live read (`docs/SOURCE_VERIFICATION.md`)                 |
| B3     | Bundled Mesa station catalog           | No route to `afdc.energy.gov`. **No catalog data is shipped** — inventing station rows was not an option                                         | `npm run catalog:refresh` on a networked machine                                                             |
| B4     | Windows installer and bundled Chromium | No Windows host                                                                                                                                  | `npm run package:win` on Windows 11 x64. The native SQLite rebuild is no longer part of this — see ADR-0003. |
| B5     | A→B installed update proof             | Same as B4, plus two built installers                                                                                                            | `npm run test:update`                                                                                        |
| B6     | Push to GitHub                         | Git proxy: repository not in the session's authorized set                                                                                        | Push from your own machine — commands in `docs/HANDOFF.md`                                                   |
| B7     | License decision                       | Owner decision, not a technical blocker                                                                                                          | Choose a license; `package.json` currently says `UNLICENSED` and is marked private                           |
| B8     | GitHub Action SHA pinning              | No route to the GitHub API from here, and inventing a SHA produces either a broken workflow or a reference to a commit nobody checked            | `gh api repos/actions/checkout/commits/v4 --jq .sha` for each action, once                                   |

**Nothing above was worked around.** No station data was fabricated, no
collector was faked, no lockfile was invented, and no check is reported as
passing that did not run.

---

## Outstanding implementation

Ordered by what unblocks the most.

| #      | Work                                                                                                  | Depends on | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ----------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~I1~~ | ~~Commit `package-lock.json`~~                                                                        | —          | **Done.** The lockfile is committed; use `npm ci`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| I0     | **The installer builds and passes verify:package, then crashes on install**                           | —          | Exit `-1073740940` (`STATUS_HEAP_CORRUPTION`) during a silent install of the 328 MB package. **Cause still not established.** It was briefly claimed to be the 32-bit `7za.exe` (I0b); that was wrong — differential packaging had pinned the dictionary to 1 MB in that build, so the memory ceiling was never approached. `differentialPackage` off and ~120 MB of unused browser payload removed; both are correct independently. `test-installed.ps1` reads the Windows Application log and names the faulting module. **This blocks the release.**                                        |
| I0d    | ~~The app could not find the browser it ships~~                                                       | —          | **Fixed.** `resolveBundledChromium` looked at `resources/browser/chrome-win/chrome.exe`; Playwright writes `chromium-<rev>/chrome-win64/chrome.exe`. Both build checks passed because both searched recursively for any `chrome.exe`. `verify:package` said "releasable" for a package whose first log line was `the bundled browser was not found`. Resolver now enumerates the real layouts newest-revision-first; `after-pack.mjs` and `verify-package.mjs` share that list via `scripts/lib/browser-layout.mjs`; 9 specs build the directory shape on disk and assert the two lists agree. |
| I0b    | Packaging fails with `Can't allocate required memory!`                                                | —          | **Worked around, not understood.** Introduced by turning off `differentialPackage`, which had been pinning the 7z dictionary to 1 MB. Restored to `true`, which is the only configuration that has ever packaged successfully here. Three explanations were offered and disproved: a 32-bit compressor (a 64-bit 7-Zip 26.03 failed identically), differential packaging itself, and dictionary size (`-mx=5`, a 16 MB dictionary, failed with 5.9 GB free on 12 cores). Why that allocation fails is still unknown. `scripts/windows/diagnose-7z.ps1` measures it.                            |
| I0c    | The package ships a second Chromium                                                                   | —          | 432 MB of the 814 MiB payload is a full `chrome-win64` beside the Chromium already inside Electron. Most of the installer's size and the reason there is so much to compress. A design question — drive collection through Electron's own browser, or fetch the collector on first run — not a build-script one. Neither attempted.                                                                                                                                                                                                                                                            |
| I0a    | electron-builder runs signtool over the bundled Chromium binaries                                     | —          | With `signAndEditExecutable: true` and no certificate, electron-builder rewrites all eleven Chromium executables Google already signed. Pointless work on a large payload. Narrowing it needs a custom sign hook; not written blind against a build that currently succeeds.                                                                                                                                                                                                                                                                                                                   |
| I2a    | `partial_coverage` collection status is never emitted                                                 | —          | Declared in `CollectionStatusView` and handled by the renderer, but `QueryService.collectionStatus` has no coverage figure to derive it from. Found by typecheck as an unreachable branch; the branch was removed rather than left pretending the state is reachable.                                                                                                                                                                                                                                                                                                                          |
| ~~I2~~ | ~~Fix whatever `npm run typecheck` reports~~                                                          | —          | **Done.** Runs clean on Windows, and now on Linux with Node 22.22.2. Found a duplicate method that was silently discarding every update event. `npm run lint` and `npm run format` are clean too; `src/workers/*.ts` were in no tsconfig and are now in `tsconfig.node.json`.                                                                                                                                                                                                                                                                                                                  |
| I2b    | Run `npm run catalog:refresh` against a real AFDC export                                              | network    | The application shows nothing until a catalog exists. The script is now covered by 11 specs but has still never seen a genuine AFDC file.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ~~I3~~ | ~~First `npm run build`, then `npm run test:e2e`~~                                                    | —          | **Done on Linux.** The build produces main, preload, renderer and both worker bundles; all 42 UI specs pass in Chromium across three projects. Three selector/assertion fixes were needed in `tests/ui/honesty.spec.ts`; the app was right in each case. Still not Electron and still not Windows.                                                                                                                                                                                                                                                                                             |
| I4     | `npm run package:win` on Windows, then `scripts/windows/test-installed.ps1` on a non-elevated account | B4         | First evidence the native module loads and the bundled browser starts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| I5     | Pin every GitHub Action to a commit SHA                                                               | B8         | Do this before the release workflow ever holds a real signing key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| I6     | Configure the `release` GitHub environment with a required reviewer                                   | —          | `release.yml` names it; without it the signing job runs unattended.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| I7     | `npm run catalog:refresh` and review the result                                                       | B3         | The field mapping has never seen a real AFDC file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| I8     | ChargePoint terms review and one bounded live read                                                    | B2         | May conclude the source is ineligible. That is a real outcome, not a failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| I9     | Integration specs under `tests/integration/`                                                          | —          | `vitest.config.ts` includes the glob; no such specs are written yet. `npm test` itself now works — it runs the same 413 no-dependency specs through the `node:test` shim.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| I10    | Real screenshots for the docs                                                                         | —          | None exist. None were faked. The only rendering so far is headless Chromium over synthetic fixtures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## Next command

From a clean clone, with nothing installed:

```powershell
npm run test:nodeps
```

Then, with the lockfile that is already committed:

```powershell
npm ci                     # see docs/BUILDING.md first
npm run verify             # migrations, icons, 413 specs, format, lint, typecheck
npm run build              # then: npm run test:e2e
```

## Definition of done — honest scorecard

See [VERIFICATION_REPORT.md](VERIFICATION_REPORT.md) for the item-by-item table
with pass / fail / not-tested for each of the 23 criteria.
Summary: **10 pass, 0 fail, 13 not-tested or blocked**.
