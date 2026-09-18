# Building ChargeWatch

What you need, what each command does, and what to do when one fails.

## Requirements

|         |                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| OS      | Windows 11 x64 for packaging. Linux and macOS can run the specs and the renderer build, but not produce an installer.        |
| Node    | 22.12 or newer. The specs need 22.6+ for `--experimental-strip-types` and `node:sqlite`; the build is pinned to 22.12 in CI. |
| Disk    | ~1 GB free — the bundled Chromium payload is around 200 MB before packaging and again inside the installer.                  |
| Network | The npm registry and the Playwright CDN, once. After that the build is offline.                                              |
| 7-Zip   | Optional but preferred: `winget install --id 7zip.7zip -e`. See below.                                                       |

### Packaging is compressed at level 5, not 9

electron-builder invokes 7-Zip with `-mx=9` and no other tuning. At that level
7-Zip picks a 64 MB LZMA2 dictionary _and_ compresses blocks in parallel across
every logical processor, each thread holding its own encoder state of roughly
10.5× the dictionary — about 675 MB each. On a many-core machine that is well
past 8 GB for one archive, and it fails:

```
ERROR: Can't allocate required memory!
```

`scripts/windows/build-all.ps1` sets `ELECTRON_BUILDER_COMPRESSION_LEVEL=5`,
a 16 MB dictionary and roughly 170 MB per thread. The installer is larger than
it would be at level 9. It also prints the machine's core count and free memory
at the packaging step, so a future failure here arrives with its own evidence.

To package by hand:

```powershell
$env:ELECTRON_BUILDER_COMPRESSION_LEVEL = '5'
npm run package:win
```

**The bundled 7-Zip is 32-bit**, which caps it at 2 GB across all threads, so
the script also points `ELECTRON_BUILDER_7ZIP_PATH` at a system 7-Zip when one
is installed. That is a precaution, not the fix: a 64-bit 7-Zip 26.03 failed at
`-mx=9` in exactly the same place. Note that `USE_SYSTEM_7ZA` was removed in
electron-builder 26 and is now ignored silently; the replacement takes an
absolute path to an executable rather than a name on `PATH`
(`app-builder-lib/out/toolsets/7zip.js`).

**This is a symptom.** The payload is 814 MiB, of which 432 MB is a complete
second Chromium shipped beside the one already inside Electron. Nothing else in
the build is remotely that size. Lowering the compression level makes the build
complete; it does not make that reasonable.

### There is no native module

ChargeWatch uses **`node:sqlite`**, which ships inside Node and therefore inside
Electron. There is nothing to rebuild for the Electron ABI, nothing to unpack
from the asar, and no compiler toolchain needed on a build machine. `npm install`
has no `postinstall` step.

This was not the original design. The project used `better-sqlite3` until the
first real Windows build failed: no prebuilt binary existed for Electron 44.4.1,
so it fell back to compiling from source, which needs Python and the Visual
Studio C++ build tools — and `node-gyp` cannot reliably compile from a path with
a space in it, which `C:\Users\First Last\...` always has.

An earlier version of this document claimed no Visual Studio installation was
ever needed. That claim was wrong, and is recorded as such in
`docs/VERIFICATION_REPORT.md`.

`docs/adr/0003-node-sqlite-over-better-sqlite3.md` has the full reasoning,
including the cost: `node:sqlite` is marked experimental.

`verify-package.mjs` and the `afterPack` hook now **fail the build if any
`.node` binary appears in the package**. A native module reappearing means some
dependency has quietly reintroduced the ABI rebuild, and that would only break
on someone else's machine.

## npm 10 and npm 12 do not install the same tree

npm 12 blocks package install scripts by default. On a fresh `npm ci` it prints:

```
npm warn install-scripts 3 packages had install scripts blocked because they are not covered by allowScripts:
npm warn install-scripts   electron-winstaller@5.4.0 (install: node ./script/select-7z-arch.js)
npm warn install-scripts   esbuild@0.25.12 (postinstall: node install.js)
npm warn install-scripts   esbuild@0.28.2 (postinstall: node install.js)
```

This is a warning, not an error, and the install "succeeds". But esbuild's
postinstall is what downloads its platform binary, and electron-vite builds
through esbuild, so `npm run build` fails afterwards for a reason that does not
mention npm at all. Approve them once:

```powershell
npm install-scripts approve esbuild
npm install-scripts approve electron-winstaller
npm ci
```

Separately, and on both npm versions seen so far, Electron's own postinstall can
complete without producing a binary. The symptom is `Error: Electron uninstall`
from electron-vite. Check and repair it directly:

```powershell
Test-Path node_modules\electron\dist      # False means the binary is missing
node node_modules\electron\install.js     # downloads ~100 MB
```

Both of these cost an afternoon on 2026-09-18 and neither is obvious from the
error it eventually produces.

## The commands that need nothing installed

These are the two you can run on a clean clone with no network at all.

```powershell
npm run test:nodeps
npm run check:migrations
```

`test:nodeps` runs 413 specs on Node's built-in test runner. It executes the
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

## The full sequence

```powershell
npm ci
npm run typecheck
npm run verify
npm run setup:browser
npm run build
npm run package:win
npm run verify:package
.\scripts\windows\test-installed.ps1
```

### `npm ci`

Installs exactly what `package-lock.json` pins. **The lockfile is in the
repository**, so use `npm ci` rather than `npm install`: `npm install` is free
to resolve something newer and silently rewrite the lockfile, which is the one
thing a reproducible build must not do.

A release must be built from a locked tree. `scripts/release-prepare.mjs`
refuses to prepare a release without the lockfile, and the CI `checks` job runs
`npm ci`, which requires one.

Three dependencies deserve attention when npm resolves something newer than
`package.json` declares:

- **`electron`** changes the Chromium and Node versions inside the application,
  so it can change renderer behaviour and can require rebuilding native modules.
- **`playwright-core`** determines the bundled browser revision, so a bump
  changes a ~200 MB payload and can break `setup:browser`.

`.github/dependabot.yml` keeps those three out of every update group for the
same reason, and ignores their majors outright.

### `npm run typecheck`

Two projects: `tsconfig.node.json` (main, preload, workers, collector, database,
domain, shared, tests, configs) and `tsconfig.web.json` (renderer, UI tests).

**This now runs clean** on Linux with Node 22.22.2. `src/workers/*.ts` were
previously in neither project, so they were never typechecked and eslint could
not parse them; they are in `tsconfig.node.json` now and are clean too.

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

`playwright-core` and `electron-updater` are external. They depend on binaries
on disk; bundling them produces a build that fails at runtime rather than at
build time, which is the worse failure. There is no SQLite entry here, because
there is no SQLite dependency.

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
break on a user's machine: a missing bundled Chromium, a native `.node` binary
that should not be there at all, missing worker bundles, missing icons or
notices, a private key or a database or test fixtures in the package, and an
update configuration
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
pass `-AllowElevated`, and then reports that particular claim as _not proven_
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

**`npm ci` fails while compiling a native module.** It should not: there
are no native dependencies. If one has appeared, something in the tree pulled it
in. Find it with `npm ls --all | findstr /i gyp` and deal with the cause rather
than installing a compiler — `verify-package.mjs` will fail the build anyway if
a `.node` binary reaches the package.

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
