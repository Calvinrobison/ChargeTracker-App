# ChargeWatch

ChargeWatch watches public EV charger status pages within 50 miles of Mesa,
Arizona, records what they said and when they said it, and turns that history
into occupancy patterns you can look at over time.

It is a Windows desktop application. Everything stays on your machine: there is
no account, no server, no API key and nothing to pay for. It ships with its own
browser and its own database.

---

## ⚠ Current status: not installable yet

**There is no download.** No release has been published, and the installer has
never been built, because the work was done in an environment with no Windows
host and no access to the npm registry.

What exists today is the complete source, 380 passing specs that run with
nothing installed, and a build and release pipeline that has not yet been
executed on Windows.

| | |
| --- | --- |
| Specs passing | 380, via `npm run test:nodeps` — no install required |
| Typechecked | **No.** `npm run typecheck` has never run |
| Built | **No** |
| Packaged | **No** |
| Collecting data | **No** — no source has been cleared for automated collection |
| Station catalog | **Not bundled** — inventing station rows was not an option |

`docs/VERIFICATION_REPORT.md` has the item-by-item scorecard, including what was
tested, what was not, and why. `docs/IMPLEMENTATION_STATUS.md` is the resume
point with the exact next commands.

If you are here to get it running, skip to
[Building it yourself](#building-it-yourself).

---

## What it does

Every few minutes, ChargeWatch opens each monitored charger's public status page
in a bundled browser, reads the port counts, and stores one observation with the
time it was taken and where it came from. Over days and weeks that becomes a
history you can ask questions of: which locations are busiest, at what hours,
and how confident you can be in the answer.

**Two workspaces.** A map of the study area with stations coloured by the metric
you pick, and an overview with rankings, a weekday-by-hour heatmap and a trend
line. Selecting a station anywhere opens the same detail drawer.

**Your own visit data, if you have it.** You can import visitor or footfall
counts from a property manager or a counter and compare them against charger
usage over the same period. ChargeWatch will refuse to prorate a mismatched
period rather than quietly stretching your numbers to fit.

**It keeps collecting in the tray.** Closing the window does not stop it.
Quitting is a deliberate action from the tray menu.

## What it does not do, and will not

This is the part worth reading before you decide whether it is useful to you.

**It cannot report charging sessions.** No public status page says who plugged
in, for how long, or how much energy was delivered. ChargeWatch sees counts of
ports in each state, at the moments it looked. From that it can *infer*
occupancy episodes, and it labels them as inferred, with the uncertainty at both
ends. It will never describe an inferred episode as a recorded session.

**It never shows missing data as zero.** An hour nobody watched looks different
from an hour that was watched and found empty — different colour on the heatmap,
a break in the trend line rather than a dip, and an em dash rather than a
number. A metric computed over a partially covered window says so.

**It does not fill gaps.** If collection stopped, that period is recorded as a
gap with its reason, and it stays a gap.

**It does not carry a stale reading forward indefinitely.** Each observation
stores the freshness policy in force when it was taken, so changing a setting
later cannot retroactively rewrite what was known at the time.

**It reports what it could not do.** If a source refused access, if a page
changed shape, if the app was asleep — you are told, in plain language, on the
screen where the affected numbers are.

---

## Building it yourself

You need **Windows 11 x64**, **Node 22.12 or newer**, and about 1 GB of disk
for the bundled browser.

### The two commands that work right now

From a clean clone, with nothing installed:

```powershell
npm run test:nodeps      # 380 specs, no dependencies needed
npm run check:migrations # confirms the embedded schema matches the SQL files
```

These run on Node's built-in test runner using TypeScript type-stripping and
`node:sqlite`. They cover the metric contract, the real SQL schema, the
scheduler, the source parser, the IPC contract, the security policy, the update
verifier and the display formatters.

### The rest

```powershell
npm install              # writes package-lock.json; commit it
npm run typecheck        # NEVER RUN — expect real errors on first attempt
npm run verify           # migrations, specs, format, lint, types
npm run setup:browser    # downloads and stages the Chromium payload (~200 MB)
npm run build
npm run package:win      # produces release\ChargeWatch-Setup-<version>.exe
npm run verify:package   # checks the package for the faults that only show up on a user's machine
```

Then prove the package actually works. Run this in a **normal, non-elevated**
PowerShell window — the whole point of the per-user install is that it needs no
administrator rights, and testing it elevated would not establish that:

```powershell
.\scripts\windows\test-installed.ps1
```

It installs the build, runs it with `--self-check` against a throwaway data
folder (your real history is never touched), confirms the native SQLite module
loads and the bundled browser starts, then uninstalls.

`docs/BUILDING.md` covers this in full, including what to do when a step fails.

### Running it in development

```powershell
npm run dev
```

Updates are disabled in development builds, and the window opens with developer
tools available.

---

## Where your data lives

Everything is under your local application data folder — never inside the
install directory, so an update or an uninstall cannot take it with it.
Uninstalling **keeps** your history; removing it is a separate, explicit action.

| | |
| --- | --- |
| History | `%LOCALAPPDATA%\ChargeWatch\database\chargewatch.sqlite` |
| Backups | `%LOCALAPPDATA%\ChargeWatch\backups\` |
| Logs | `%LOCALAPPDATA%\ChargeWatch\logs\` |

Open the folder from **Settings → Data and backups → Open data folder**.

To look inside a history file without opening the app:

```powershell
npm run db:probe -- --file "$env:LOCALAPPDATA\ChargeWatch\database\chargewatch.sqlite"
```

That opens it read-only and prints a JSON summary. It cannot modify or migrate
anything.

---

## Updates

ChargeWatch updates itself from GitHub Releases. Every update is verified
against an Ed25519 public key embedded in your installed copy **before** it can
be installed: the manifest signature, the application and platform it claims to
be for, the release sequence (so a downgrade cannot be replayed at you), and the
size and SHA-256 and SHA-512 of the installer itself. A failed check leaves your
installation and your history exactly as they were.

The installer is not code-signed, so Windows SmartScreen may warn on first run.
That is a consequence of free distribution and is separate from ChargeWatch's
own signature check. `docs/UPDATES_AND_RECOVERY.md` explains both.

---

## Documentation

| | |
| --- | --- |
| [IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) | What is done, what is blocked, what is next |
| [VERIFICATION_REPORT.md](docs/VERIFICATION_REPORT.md) | What was actually tested, item by item |
| [HANDOFF.md](docs/HANDOFF.md) | Picking this up from here |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Processes, workers, IPC, security, build topology |
| [DATA_MODEL.md](docs/DATA_MODEL.md) | The schema, and which columns exist to make dishonesty impossible |
| [METRICS.md](docs/METRICS.md) | How every number is computed, and what each one does not mean |
| [SOURCES.md](docs/SOURCES.md) | Which sources exist and the eligibility basis for each |
| [SOURCE_VERIFICATION.md](docs/SOURCE_VERIFICATION.md) | The process for clearing a source for collection |
| [BUILDING.md](docs/BUILDING.md) | Full build instructions and failure modes |
| [TESTING.md](docs/TESTING.md) | What each suite covers and what none of them cover |
| [RELEASING.md](docs/RELEASING.md) | Signing, verification, and the manual steps that stay manual |
| [UPDATES_AND_RECOVERY.md](docs/UPDATES_AND_RECOVERY.md) | Update verification, backups, restore, recovery |
| [USER_GUIDE.md](docs/USER_GUIDE.md) | Using the application, and how to read what it shows |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptoms, causes, fixes |

---

## Licence

`UNLICENSED` and marked private, pending a decision by the owner. See
`THIRD_PARTY_NOTICES.md` for the licences of bundled components, including
Chromium and the OpenStreetMap tile data the map uses.
