# ChargeWatch

A Windows desktop app that watches public EV charger status around Mesa,
Arizona over time, and tells you which locations are actually busy — with the
gaps in its own data shown honestly rather than filled in.

It answers questions like: which monitored locations are occupied most often,
how that compares once you account for how many ports each site has, which
hours and days look busiest, and which observations are recent, stale or
missing.

---

## ⚠️ Current status: not installable yet

**There is no installer to download.** This repository holds a verified core
and a documented plan for the rest. Please read this section before anything
else.

| Part | State |
| --- | --- |
| Metric engine, time handling, ranking rules | **Working, 329 tests passing** |
| SQLite schema, migrations, backup/restore logic | **Working, tested against real SQLite** |
| Collector scheduling, rate limits, backoff | **Working, tested** |
| ChargePoint page parsing | **Working against synthetic fixtures** |
| Signed-update verification | **Working, tested** |
| Live collection from ChargePoint | **Blocked** — see [docs/SOURCE_VERIFICATION.md](docs/SOURCE_VERIFICATION.md) |
| Station catalog | **Blocked** — no network route to AFDC at build time |
| The app window (Overview, Map, drawer) | **Not built yet** |
| Windows installer and auto-update | **Not built yet** |

Everything above is stated in detail, per item, in
[docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) and
[docs/VERIFICATION_REPORT.md](docs/VERIFICATION_REPORT.md). Nothing in this
README claims a check that was not actually run.

### What you can run today

The correctness-critical parts run with **no installation and no network** —
you need only Node 22.6 or newer:

```powershell
git clone https://github.com/Calvinrobison/ChargeTracker-App.git
cd ChargeTracker-App
npm run test:nodeps
```

That executes 329 specs against Node's built-in test runner and its built-in
SQLite: the metric contract (including every worked example from the spec), the
real database schema and migrations, the scheduler's rate limits, the source
parser, the IPC contract, the security policy and the update verifier.

No `npm install` is required for that command, and it is the honest measure of
what currently works.

---

## How it will work once packaged

This is the intended experience, kept here as the target. It is **not yet
available.**

1. Download `ChargeWatch-Setup-x.y.z.exe` from the
   [Releases page](https://github.com/Calvinrobison/ChargeTracker-App/releases).
2. Run it. It installs for your user only and needs no administrator rights.
3. Open ChargeWatch, accept the Mesa defaults, and click **Start collecting**.

Supported target: **Windows 11, 64-bit (x64)**. No other Windows version or CPU
architecture will be claimed as supported until it has been tested.

Because the installer will not be code-signed at first, Windows SmartScreen may
warn you the first time you run it. That is a consequence of free distribution,
not a sign of a problem — and ChargeWatch verifies its own updates with its own
signing key regardless (see below).

### Things worth knowing up front

- **Observations only accumulate while your PC is awake and ChargeWatch is
  running.** Sleep, shutdown, losing your connection, or quitting the app all
  create gaps. ChargeWatch records those gaps and shows them as missing
  coverage. It never fills them in with zeros or estimates.
- **Closing the window keeps it collecting** in the system tray. **Quit** from
  the tray menu really stops it.
- **Start with Windows** is a toggle you'll see during setup, off by default.
- Some charging networks don't publish usable status. Those locations appear in
  the catalog as "catalog only" and are shown grey — present on the map, but
  with no history, because there is nothing to observe.

---

## What the numbers mean

Full definitions with worked examples are in
[docs/METRICS.md](docs/METRICS.md). The short version:

- **Observed occupancy** is occupied port-minutes divided by observed
  operational port-minutes, over the period you selected. It is a *historical*
  figure. It is not current availability, and the two never share a colour.
- **Occupied port-hours** is total observed activity. A big site at 40% can
  easily beat a small site at 80%, so both figures are shown and you can sort
  by either.
- **Coverage** is how much of the period we actually have known states for. A
  location needs seven days and 90% coverage to enter the main ranking;
  anything less is shown and labelled **Provisional** rather than quietly mixed
  in.
- **Map colours**: green under 30%, amber 30–60%, red 60% and above, grey when
  there isn't enough history. Red means *historically busy during the period
  you picked* — not broken, not unsafe, not full right now.
- **"In use" is not "charging."** Unless a source explicitly distinguishes the
  two, ChargeWatch says "reported in use" and does not claim electricity was
  flowing.
- **Detected occupancy starts** are estimates from observed state changes. They
  are not session counts. Two cars can swap between checks with no visible
  change at all, so ChargeWatch will never present them as exact sessions.
- **Visits** are only ever numbers you or a site owner import. ChargeWatch has
  no source of property visitor counts and will not invent one. Google
  popular-times percentages, parking-space counts and road traffic are not
  visitor counts and cannot be imported as such.

---

## Your data and your privacy

- Everything stays on your PC. There is no account, no analytics, no crash
  reporting and no upload of your history.
- History lives in `%LOCALAPPDATA%\ChargeWatch\`, outside the install folder,
  so updating or reinstalling never deletes it. The About screen will show the
  exact path with an **Open data folder** button.
- Normal outbound connections are: the charger status sources you enable, map
  tiles for the basemap, and GitHub for update checks. That's the complete
  list, and it's enforced by a content security policy — see
  [PRIVACY.md](PRIVACY.md).
- Backups, export and restore are built in. Backups on the same disk protect
  you from mistakes and bad upgrades, not from disk failure, so there's an
  **Export backup** action for somewhere else.
- Diagnostics are exported by you, previewable first, with tokens, cookies and
  your home folder path stripped out.

## How updates will behave

ChargeWatch checks GitHub for updates, downloads them quietly in the
background, and installs only at a safe moment — when the window has been in
the tray for a few minutes and nothing is mid-export or mid-migration.
Otherwise it waits for the next safe launch or for you to click **Restart to
update**. It never interrupts you mid-session.

Every update must pass an Ed25519 signature check against a key embedded in
your installed copy before it can be installed. An update that fails
verification is discarded and your installation is left exactly as it was.
This is ChargeWatch's own authenticity check — it is separate from Windows code
signing and does not remove SmartScreen prompts.
[docs/UPDATES_AND_RECOVERY.md](docs/UPDATES_AND_RECOVERY.md) has the details,
including what to do if an update goes wrong.

---

## Troubleshooting

[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) covers the common cases:
collection paused, a source that changed, an empty map, missing history and how
to export sanitized diagnostics.

---

## For developers

Prerequisites: Node 22 LTS (22.12 or newer) and npm. End users need none of
this.

```powershell
git clone https://github.com/Calvinrobison/ChargeTracker-App.git
cd ChargeTracker-App

npm run test:nodeps      # 329 specs, no install and no network needed
npm ci                   # see the note below first
npm run verify           # migrations check, specs, format, lint, typecheck
```

> **Read [docs/BUILDING.md](docs/BUILDING.md) before `npm ci`.** There is no
> committed `package-lock.json`: the environment this was written in had no
> route to the npm registry, so no honest lockfile could be produced.
> BUILDING.md has the exact steps to resolve and pin versions, and
> [docs/adr/0001-stack-and-version-pinning.md](docs/adr/0001-stack-and-version-pinning.md)
> explains why a fabricated lockfile would have been worse than none.

Where things live: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
How to work on it: [AGENTS.md](AGENTS.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).
What's next: [docs/ROADMAP.md](docs/ROADMAP.md) and
[docs/HANDOFF.md](docs/HANDOFF.md).

## Data sources and attribution

The station catalog comes from the U.S. Department of Energy's
[Alternative Fuels Data Center](https://afdc.energy.gov/data_download), which
permits reuse with attribution. A catalog listing a station says nothing about
whether it is occupied right now — that is a separate, live observation.

Map tiles come from [OpenStreetMap](https://www.openstreetmap.org/copyright).
© OpenStreetMap contributors. Tiles are used within the
[published tile usage policy](https://operations.osmfoundation.org/policies/tiles/);
they are not guaranteed free infrastructure for unlimited redistribution.

Which networks ChargeWatch can actually observe is recorded in
[docs/SOURCES.md](docs/SOURCES.md), with the eligibility basis for each. A
network appearing in the catalog is **not** a claim that ChargeWatch supports
it.

## License

The license for this project has not been decided yet; see
[docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md). The package is
marked private and is not published to npm. Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) regardless of that decision.
