# Troubleshooting

Symptoms, what they mean, and what to do. Ordered roughly by how often they are
likely to come up.

For anything involving a number that looks wrong, read `docs/METRICS.md` first —
most of those turn out to be a window or coverage question rather than a fault.

---

## Nothing is being collected

**"No source is enabled" in the banner or on the startup checks.**

This is the expected state today. No charger network has been cleared for
automated collection, so ChargeWatch cannot record observations. It is not a
fault in your installation and there is no setting that changes it.

`docs/SOURCES.md` explains the current status and `docs/SOURCE_VERIFICATION.md`
covers what has to be established before a source can be enabled. The banner
offers "View details" rather than "Try again" because retrying would mean making
a request that has not been established as permissible.

**"Station catalog is loaded: fail".**

No station catalog is bundled. A maintainer needs to run `npm run catalog:refresh`
and ship the result. Inventing station rows was not an option, so the check
fails honestly rather than showing you locations that do not exist.

**Collection is paused and you did not pause it.**

Check the source health panel. A source pauses — rather than retrying — when it
hits a sign-in wall, an access block, or a page whose layout changed. Retrying
into any of those would be hammering a provider that has already said no. The
panel names which one and what a maintainer needs to do.

**The status says "Catching up" or shows a longer interval than you set.**

You are monitoring more locations than the rate limit allows within the target
interval. ChargeWatch reports the interval it can actually achieve instead of
pretending to hit the target. Monitor fewer locations, or accept the longer
cadence — the history stays correct either way, just coarser.

---

## The application will not start, or starts wrong

**Windows SmartScreen blocks the installer.**

The installer is not code-signed. Choose **More info → Run anyway** if you trust
where you got it. This is separate from ChargeWatch's own update signature
check, which is unaffected. See `docs/UPDATES_AND_RECOVERY.md`.

**It starts and immediately says it could not open its history file.**

Two distinct cases, and the dialog says which:

*"This history file was written by a newer version."* Install that newer
version. The file is fine; this copy is too old to read it, and it refuses to
downgrade rather than losing data.

*"ChargeWatch could not upgrade its history file."* A migration failed. Your
data is left at the last successfully applied version, intact, and a
pre-migration backup was taken before the attempt. Restore that backup from
Settings → Data and backups, or export diagnostics and report it.

**It starts but nothing works, and the log mentions the browser or the
database.**

Run the installed executable directly to get a full report:

```powershell
& "$env:LOCALAPPDATA\Programs\chargewatch\ChargeWatch.exe" --self-check="$env:TEMP\cw.json"
Get-Content "$env:TEMP\cw.json"
```

The `integrity` section names the failing check and its recovery action. A
failure there generally means the installation is damaged; reinstalling is the
fix. The `readiness` section is expected to be unmet and is not a fault.

**Two copies seem to be running.**

They cannot be. ChargeWatch holds a single-instance lock; a second launch
activates the existing window. If you see two tray icons, one is stale — hover
over each to find the live one.

**It disappeared when I closed the window.**

It did not. It is in the tray, still collecting. Quit from the tray menu if you
want it stopped.

---

## Numbers look wrong

Work through these in order. The first three explain most cases.

**1. Check the window.** "Last 30 days" clipped by a study start eleven days ago
is an eleven-day window. The summary says "30 days requested · 11 collected"
when that happens.

**2. Check the coverage.** The same occupancy figure over 62% coverage and over
98% coverage are different measurements. Coverage is shown beside the figures.

**3. Check the scope.** If the source reports a subgroup of a location's ports
rather than all of them, the station's scope note says which ports the numbers
cover.

**4. Export the raw observations** for that window and station. That is the
evidence; everything on screen is derived from it. If the observations look
right and the summary does not, that is a real bug.

### Specific confusions

**A location shows `—` instead of a number.** ChargeWatch does not know, and is
saying so. A genuine zero shows as `0%`.

**A location shows "No current status" but has history.** The source answered
and gave no usable port counts this time. The history is still valid.

**The trend line has breaks in it.** Those are gaps — periods nobody observed.
They are not drawn through, because a line through a gap would assert something
nobody measured.

**A location is missing from the rankings.** It is probably provisional: under
7 days of history, or under 90% coverage for the selected window. Provisional
locations are shown separately with their reasons rather than hidden or ranked.

**Occupancy looks low for a site that is obviously busy.** Check operational
coverage. Ports that are out of service are not available to be occupied; a site
with eight of ten ports broken can show modest occupancy while the working two
are saturated. Both numbers are shown for exactly this reason.

**A charging session count looks wrong.** There are no charging session counts.
What you are looking at is inferred occupancy episodes, labelled as such in the
activity panel. No public source reports sessions.

---

## Import and export

**The visit import rejected my file.**

The preview lists each rejected row with its reason. The common ones:

*Period mismatch.* ChargeWatch will not prorate. A calendar month cannot be
stretched to fit a 23-day window; the overlap is used, or the comparison is not
made.

*Overlapping dataset.* Another dataset already covers that site and period.
Remove or replace it rather than having two answers to the same question.

*Different count definition.* "Property entries" and "unique visitors" are
different measurements. Averaging them produces a number meaning nothing.

*Unparseable timestamp.* Timestamps need an explicit UTC offset. A bare local
time is ambiguous and is rejected rather than guessed at.

**A station name in my CSV starts with an apostrophe.**

That is deliberate. Text from a source that begins with `=`, `+`, `-` or `@` is
prefixed so a spreadsheet treats it as text rather than running it as a formula.
Numeric measurements are never altered.

**Export refused my chosen folder.**

ChargeWatch will not write inside its own database, browser profile or
update-cache directories. Pick somewhere else, such as Documents.

---

## Updates

**An update was refused.**

The reason names the specific check. `docs/UPDATES_AND_RECOVERY.md` has the
table. A refused update is a working safety mechanism — do not install it
manually to get around it, particularly if the reason was a signature failure.

**An update is ready but has not installed.**

Installation waits for the window to have been hidden for a while, no
maintenance operation to be running, and the OS not to be shutting down. Use
**Restart to update** from the tray menu to install it now.

---

## Getting help

Export diagnostics from **Settings → Diagnostics**. The file is redacted before
it is written — tokens, cookies, authorization headers and your home path are
removed, and it never contains your database or any credential. Read it before
attaching it to a public issue anyway.

Then:

- a number that misrepresents what was measured → the **Data accuracy concern**
  issue template;
- anything else broken → the **Bug report** template;
- a security issue → privately, per `SECURITY.md`, not as a public issue.

To inspect a history file yourself, from a clone of the repository:

```powershell
npm run db:probe -- --file "$env:LOCALAPPDATA\ChargeWatch\database\chargewatch.sqlite"
```

Read-only. It prints schema version, applied migrations, row counts, the
observation time range and `PRAGMA integrity_check`. It cannot modify or migrate
anything.
