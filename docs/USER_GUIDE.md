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

**The source check passes for ChargePoint** (cleared 2026-09-21;
`docs/SOURCES.md` explains on what basis). Passing it does not record anything
by itself: nothing is read until a location is linked to its station page and
monitoring is switched on, which is the next section.

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

## Filtering by how many stalls

Two filters sit above the list, and they answer different questions. Keeping
them apart is deliberate: one of them can speak for the whole map today and the
other cannot.

**Stalls at the location** is capacity — how many stalls the site has, whatever
state they are in right now. This is the one for "show me the big sites": type
`8` and `20` and you get locations with 8 to 20 stalls instead of the
two-charger sites that dominate the area by count. It works across the whole
catalog, because every catalogued location has a known stall count.

**Stalls free right now** is availability, taken from the most recent reading.
It can only answer for a location that is **monitored and has actually been
read**. Everything else is left out of the result rather than counted as zero
free, so the list never implies that a location nobody looked at had no free
stalls. Until you turn monitoring on for some locations, this filter returns
little or nothing, and the control says so underneath rather than looking
broken.

Leaving a box empty means "no bound", not zero. `8` with an empty maximum is
"8 or more"; an empty minimum with `2` is "up to 2". Typing the larger number
first is read as the range you meant. Typing `0` into the minimum is a real
filter, not an empty one — so it excludes locations whose count is unknown,
which is the point.

**Where the two capacity figures disagree, the location is marked in blue.**
ChargeWatch has two sources for how many stalls a site has: the figure the
provider's own page reported while the site was monitored, and the figure in the
bundled AFDC catalog. Usually they agree. When they do not, the row gets a blue
edge and a **"Stalls disputed"** badge with both numbers, the map marker gets a
blue ring, and the station drawer states both figures and which one is being
used. Filtering and sorting use the source figure, on the reasoning that it was
read from the provider today and the catalog entry may be years old — but that
is a default, not a verdict, which is why the disagreement is shown to you
instead of being quietly resolved. Neither figure has been verified on site.

As everywhere else, colour is not the only signal: the badge, the tooltip and
the drawer all say it in words.

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

Two steps, both deliberate.

**1. Link locations to their station pages.** Settings → Locations and sources
→ **Find ChargePoint stations** reads the provider's list for the study area
once (about a minute; a toast counts the pages) and links each station to the
catalog location with the same name at the same spot. It records nothing. The
result says how many were linked, how many were already linked, how many have
a near-namesake that was not trusted, and how many are not in the catalog at
all. A location it did not link can be linked by hand from its detail panel:
open the ChargePoint map, select the station, and paste the
`driver.chargepoint.com/stations/…` address into the **Monitoring** section.
ChargeWatch never auto-merges on proximity alone — two chargers 40 metres apart
in the same garage are routinely different operators.

**2. Switch monitoring on.** Each linked location has a switch in its detail
panel; **Monitor all linked** in Settings turns them all on at once. A newly
monitored location is read as soon as the source's rate allows and then every
15 minutes. The station rail's monitoring filter shows what is being watched
and what is catalog-only.

**About the rate.** The source allows one page load every 30 seconds, so 30
monitored locations fill the 15-minute cycle exactly; more than that and the
achievable interval, shown under Settings → Collection, grows in proportion —
674 locations would be read about once every 5½ hours each. Monitor the set
you want answers about. Turning monitoring off keeps the history and records
the gap.

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
