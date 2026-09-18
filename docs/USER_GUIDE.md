# User guide

How to use ChargeWatch once it is installed, and how to read what it shows you.

> ChargeWatch is not yet installable — no release has been published. This guide
> describes the application as built. See the README for the current status.

---

## First run

ChargeWatch opens with a short setup that does three things: shows you the study
area it will watch, runs its startup checks, and asks two questions.

**The startup checks** are real, not decorative. Each one either passes or tells
you exactly what to do:

| Check                              | What it means                                  |
| ---------------------------------- | ---------------------------------------------- |
| Data folder is writable            | Where your history will live                   |
| History file is ready              | The database opened and migrated               |
| Bundled browser starts             | The browser that reads status pages works      |
| A charger status source is enabled | Whether anything can be collected              |
| Station catalog is loaded          | Whether ChargeWatch knows which stations exist |

**Today, the source check fails.** No charger network has been cleared for
automated collection yet, so ChargeWatch cannot record observations. It says so
rather than showing you an empty screen and letting you conclude the chargers
are all idle. `docs/SOURCES.md` explains why.

**The two questions** are whether to start with Windows, and whether to begin
collecting now. Both can be changed later in Settings.

## The window, and the tray

Closing the window does **not** stop collection. ChargeWatch keeps running in
the system tray, which is the point — a history with holes in it every time you
closed a window would not be much of a history. The first time you close it, it
says so once.

Right-click the tray icon to open the window, pause or resume collection, check
for updates, or quit. **Quit is the only thing that stops collection.**

## The two workspaces

**Map** shows the study area with each location coloured by the metric you pick
— occupancy, current status, coverage, or visits if you have imported any. The
station rail on the left lists the same locations; selecting one anywhere opens
its detail drawer.

**Overview** ranks locations and shows a weekday-by-hour heatmap and a trend
line over the selected window.

Filters, the date range, search and selection are **shared** between the two.
Changing a filter on Overview changes what the Map shows. This is deliberate:
two workspaces showing differently-filtered views of the same question is how
people come away with contradictory numbers.

## Reading the display

This is the part worth spending two minutes on. Most "that number looks wrong"
questions are answered here.

**An em dash (—) means no measurement, not zero.** If a location shows `—` for
occupancy, ChargeWatch does not know, and is saying so. A genuine zero shows as
`0%`.

**"No current status"** means the source answered but gave no usable port
counts. It is different from **"Not monitored"**, which means the location is in
the catalog but nothing is watching it.

**A gap in the trend line is a gap**, not a drop to zero. Time nobody observed
is not time with no usage.

**The heatmap has a "No data" swatch** in its key, distinct from the lowest
occupancy colour. An hour nobody watched and an hour that was watched and found
empty look different, because they are different.

**"Provisional"** means there is history, but not enough to rank this location
against others — fewer than 7 days, or under 90% coverage for the window you
selected. The reasons are listed on the station. Provisional locations are shown
rather than hidden.

**"Stale source"** and **"Source freshness unknown"** are different statements.
The first means the source's own data was already old when read. The second
means the source did not say how fresh its data was.

**Colour is never the only signal.** Every status dot has a text label beside
it.

## Windows and coverage

Every metric is over a window, and the summary tells you the window it actually
used. If you ask for 30 days but collection started 11 days ago, you get 11 days
and the summary says "30 days requested · 11 collected".

Coverage is shown next to the figures. A number over 62% coverage is a different
measurement from the same number over 98% coverage, and the interface does not
let you confuse them.

`docs/METRICS.md` explains how each number is computed and what it does not
mean.

## Station details

Selecting a station opens a drawer with its current status, data quality, trend,
heatmap, activity, any visit comparison, and the source it came from.

**Activity is not charging sessions.** Where the source reports per-port state,
ChargeWatch infers occupancy episodes and says so in the panel itself. No public
charger status page reports sessions, energy delivered, or who was charging —
so nothing here can, and it does not pretend to. Episodes that were already
running when observation began, or still running when it ended, are marked as
such, because their length is unknown.

## Choosing what to monitor

The station rail's monitoring filter shows what is being watched and what is
catalog-only. Turning monitoring on for a location adds it to the collection
schedule; the achievable interval is shown, and it may be longer than the target
if you monitor more locations than the rate limit allows in one cycle.

If ChargeWatch cannot match a catalog entry to a source page automatically, you
can link it by hand from the station's detail panel. It will not auto-merge on
proximity alone — two chargers 40 metres apart in the same garage are routinely
different operators.

## Importing visit data

If you have visitor or footfall counts, **Settings → Visit data → Import**
takes a CSV. Download the template from the same panel; it has the required
headers and one example row.

ChargeWatch compares your counts against charger usage **over the same period**
and refuses to do so otherwise. It will not stretch a calendar month to fit a
23-day observation window. It rejects overlapping datasets for the same site and
period, and datasets whose count definitions differ — "property entries" and
"unique visitors" are not the same measurement.

Zero visits produces an undefined ratio, not zero and not infinity.

The import previews before it commits, showing what will be accepted and what
will be rejected with the reason.

## Exporting

**Export current view** writes the figures for what you are looking at.
**Export raw observations** writes the underlying evidence — every observation
with its time, source, parser version and provenance.

If a number ever looks wrong, the raw export is the thing to look at. Everything
on screen is derived from it.

Two things about the CSV files:

**Text from a source is neutralised against formula injection.** A station name
beginning with `=`, `+`, `-` or `@` is prefixed so a spreadsheet treats it as
text rather than running it. This affects only untrusted text — **numeric
measurements are never altered**, because changing a measurement to make it safe
would introduce a data error in the name of security.

**A missing value exports as an empty cell, never `0`.** The same rule as the
screen.

ChargeWatch will refuse to write an export inside its own database, browser
profile or update-cache directories.

## Settings

| Panel            | What is there                                                         |
| ---------------- | --------------------------------------------------------------------- |
| Collection       | Target interval, pause and resume, per-source health                  |
| Study area       | Centre, radius and label                                              |
| Data and backups | Data folder, back up now, restore, delete a date range                |
| Visit data       | Template, import, imported datasets                                   |
| Updates          | Automatic checking, downloading and installing, and the current state |
| Diagnostics      | Log folder, export diagnostics                                        |
| About            | Version, schema version, third-party notices                          |

## Getting help

**A number looks wrong** — check the window and the coverage first, then
`docs/METRICS.md`, then export the raw observations for that window. If it still
looks wrong, the **Data accuracy concern** issue template asks for exactly what
is needed to investigate.

**Something is broken** — `docs/TROUBLESHOOTING.md`, then the bug report
template.

**Exporting diagnostics** — Settings → Diagnostics. The file is redacted before
it is written (tokens, cookies, authorization headers and your home path are
removed) and never contains your database or any credential. Read it before
attaching it to a public issue anyway.
