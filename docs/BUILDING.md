# Building ChargeWatch

What you need, what each command does, and what to do when one fails.

## Requirements

| | |
| --- | --- |
| OS | Windows 11 x64 for packaging. Linux and macOS can run the specs and the renderer build, but not produce an installer. |
| Node | 22.12 or newer. The specs need 22.6+ for `--experimental-strip-types` and `node:sqlite`; the build is pinned to 22.12 in CI. |
| Disk | ~1 GB free — the bundled Chromium payload is around 200 MB before packaging and again inside the installer. |
| Network | The npm registry and the Playwright CDN, once. After that the build is offline. |

No Visual Studio installation is needed: `better-sqlite3` ships prebuilt
binaries for the Electron ABI and `electron-builder install-app-deps` (run
automatically by `postinstall`) fetches the right one.

## The commands that need nothing installed

These are the two you can run on a clean clone with no network at all.

```powershell
npm run test:nodeps
npm run check:migrations
```

`test:nodeps` runs 380 specs on Node's built-in test runner. It executes the
TypeScript directly through type-stripping and opens real SQLite databases
through `node:sqlite`. This is not a mock layer — the schema under test is the
same `001_initial.sql` that ships.

`check:migrations` confirms that `src/database/migrations/index.ts`, which is
generated and committed, still matches the `.sql` files beside it. Migrations
are embedded at build time rather than read from disk, because path resolution
inside `app.asar` is a reliable way to ship an application that opens an empty
database. If this check fails, run `npm run generate:migrations` and commit the
result.

## The one-command path

```powershell
.\scripts\windows\build-all.ps1
```

Runs everything below in order, stops at the first real failure, and explains
what the failure means. It is safe to re-run: steps already done are skipped
unless you pass `-Force`. `-StopAfter build` stops before packaging;
`-SkipTypecheck` gets you to a build while you work through the first
typecheck.

Expect the typecheck step to fail the first time. That is not a broken setup —
see below.

## The full sequence

```powershell
npm install
npm run typecheck
npm run verify
npm run setup:browser
npm run build
npm run package:win
npm run verify:package
.\scripts\windows\test-installed.ps1
```

### `npm install`

Writes `package-lock.json`. **The lockfile is not in the repository yet** — see
`docs/IMPLEMENTATION_STATUS.md` blocker B1 — so the first person to run this
creates it and should commit it on its own.

A release must be built from a locked tree. `scripts/release-prepare.mjs`
refuses to prepare a release without the lockfile, and the CI `checks` job runs
`npm ci`, which requires one.

Three dependencies deserve attention when npm resolves something newer than
`package.json` declares:

- **`electron`** changes the Chromium and Node versions inside the application,
  so it can change renderer behaviour and can require rebuilding native modules.
- **`better-sqlite3`** is a native module. A bump has to be proven to load from
  inside a packaged NSIS install, not just from `node_modules`.
- **`playwright-core`** determines the bundled browser revision, so a bump
  changes a ~200 MB payload and can break `setup:browser`.

`.github/dependabot.yml` keeps those three out of every update group for the
same reason, and ignores their majors outright.

### `npm run typecheck`

Two projects: `tsconfig.node.json` (main, preload, workers, collector, database,
domain, shared, tests, configs) and `tsconfig.web.json` (renderer, UI tests).

**This has never been run.** Expect errors the first time, concentrated in the
renderer — no spec imports a `.tsx` file, so type-stripping has never parsed
those modules.

One constraint worth knowing about: `tsconfig.base.json` sets
`erasableSyntaxOnly`. That bans TypeScript syntax which cannot be removed by
type-stripping alone — parameter properties and `enum`, chiefly — because the
no-dependency spec runner relies on stripping. An eslint
`no-restricted-syntax` rule enforces the same thing so the failure arrives as a
lint error rather than a confusing runtime one.

### `npm run verify`

`check:migrations` → `test:nodeps` → `format` → `lint` → `typecheck`. This is
the gate to run before opening a pull request.

### `npm run make:icons`

Generates `resources/icons/icon.ico` and two PNGs from `scripts/make-icons.mjs`.

The icon is generated rather than committed as a binary because
`electron-builder.yml` and the main process both resolve `icon.ico` by path: if
it is absent, packaging fails, and if it is present but malformed, packaging
succeeds and the installed application has a blank icon in the taskbar, the
Start menu and the tray — which looks like a corrupted install. Generating it
keeps the source of truth readable and the output reproducible.

`npm run check:icons` verifies the file exists and parses as an ICO, and
`package:win` runs it before electron-builder so a missing icon fails in two
seconds rather than deep inside packaging.

The design is deliberately plain. It is a real, working icon and an honest
placeholder — not a claim that anyone has done brand design.

### `npm run setup:browser`

Downloads and stages the Chromium payload into `.playwright-cache/chromium`.
That directory is gitignored — it is a large binary artifact, reproducibly
fetched rather than committed.

`npm run setup:browser:verify` checks the staged payload without re-downloading
it, and `package:win` runs it, so packaging fails loudly rather than producing
an installer with no browser in it.

The payload ships as `resources/browser/` **outside `app.asar`** and is resolved
at runtime from `process.resourcesPath`. Nothing depends on the build machine's
Playwright home cache, which does not exist on a user's machine.

### `npm run build`

Three bundles plus two worker entries:

- `out/main/index.js` — the main process
- `out/preload/index.js` — the bridge, built as a single CJS file with no
  dynamic imports, because it runs in a sandboxed context
- `out/renderer/` — the React application
- `out/workers/database.js` and `out/workers/collector.js` — built by
  `scripts/build-workers.mjs` as separate entry points, because
  `utilityProcess.fork` needs a real file to run; a worker bundled into the main
  chunk cannot be forked

`better-sqlite3`, `playwright-core` and `electron-updater` are external. They are
native or depend on binaries on disk; bundling them produces a build that fails
at runtime rather than at build time, which is the worse failure.

### `npm run package:win`

Runs the build, verifies the browser payload, then electron-builder with
`--publish never`. Publication is a separate, authorised step — see
`docs/RELEASING.md`.

The output is `release\ChargeWatch-Setup-<version>.exe`: a **full** NSIS
installer, per-user, one-click, no administrator rights, with desktop and Start
Menu shortcuts. Not a web installer — the bundled browser must be present
offline, which is exactly what the product promises.

Uninstalling **keeps** the user's history. `deleteAppDataOnUninstall` is false
on purpose: removing someone's data should never be a side effect of removing a
program.

### `npm run verify:package`

Inspects the packaged build for the faults that look fine at build time and
break on a user's machine: a missing bundled Chromium, `better-sqlite3` left
inside `app.asar`, missing worker bundles, missing icons or notices, a private
key or a database or test fixtures in the package, and an update configuration
that points nowhere.

It reports a check it could not perform as **SKIP**, never as a pass, and prints
the manual command for each skip. One check is always skipped when the asar is
packed, because listing its contents needs the `asar` module:

```powershell
npx asar list release\win-unpacked\resources\app.asar | findstr out/workers
```

### `.\scripts\windows\test-installed.ps1`

Run this in a **normal, non-elevated** window. The per-user install is supposed
to need no administrator rights, and an install that succeeds while elevated
establishes nothing about that. The script refuses to run elevated unless you
pass `-AllowElevated`, and then reports that particular claim as *not proven*
rather than passing it. CI passes the flag, because a hosted runner's default
account is an administrator.

It installs, runs the installed executable with `--self-check` against a
throwaway data directory, reads the JSON report, and uninstalls. Your real
history is never touched.

## A note on the PowerShell scripts

They are pure ASCII, and a spec (`tests/nodeps/scripts-ascii.test.ts`) fails the
build if that stops being true.

Windows PowerShell 5.1 — still the default `powershell.exe` on Windows 11 —
reads a `.ps1` file as ANSI unless it carries a UTF-8 BOM. A UTF-8 file without
one has every multi-byte character mangled, and if the damage lands inside a
quoted string the parser loses the closing quote and the script fails before
running a single line. `build-all.ps1` did exactly that on its first real run,
over three box-drawing characters used as section rules.

A BOM would also solve it, but a BOM is easy to lose to an editor or a copy-paste
and impossible to notice by reading. ASCII is checkable, so ASCII is the rule:
`-` for an em dash, `->` for an arrow, `...` for an ellipsis.

`.gitattributes` also pins `*.ps1` to CRLF, so the scripts arrive with the line
endings Windows expects regardless of the platform they were committed from.

## When something fails

**`npm install` fails on `better-sqlite3`.** The `postinstall` script runs
`electron-builder install-app-deps`, which needs to reach GitHub for the
prebuilt binary. Behind a proxy, set `ELECTRON_BUILDER_BINARIES_MIRROR` rather
than disabling TLS verification.

**`setup:browser` cannot reach the CDN.** Set `PLAYWRIGHT_DOWNLOAD_HOST`. Do not
work around it by pointing the application at a system Chrome: the bundled
browser is the thing being tested, and a system browser is not what ships.

**`verify:package` says the native module is inside the asar.** Check the
`asarUnpack` list in `electron-builder.yml`. A native module cannot be loaded
from inside an archive, and this is the failure that produces an application
which starts and then cannot open its own database.

**`test-installed.ps1` says the installer is too small.** The bundled browser
payload is missing. Run `npm run setup:browser` and repackage. An installer
without it would download a browser at first run, which the product promises not
to do.

**The app starts and reports "History file is ready: fail".** Run the installed
executable directly to get the report:

```powershell
& "$env:LOCALAPPDATA\Programs\chargewatch\ChargeWatch.exe" --self-check="$env:TEMP\cw.json"
Get-Content "$env:TEMP\cw.json"
```

The `integrity` section names the failing check and its recovery action.
