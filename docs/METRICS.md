# Metrics

How every number ChargeWatch shows is computed, and — more usefully — what each
one does not mean.

If you are here because a figure looks wrong, start with the two questions that
explain most of them: **what window is this number over**, and **what was the
coverage for that window**. Both are shown next to the number.

---

## The unit: port-minutes

Everything is built from port-minutes, not from percentages.

An eight-port location observed for one hour contributes 480 port-minutes. If
five ports were occupied for that hour, 300 of them were occupied port-minutes.
Occupancy is `occupied ÷ known`, computed once at the end over the summed
minutes.

This matters because the obvious alternative is wrong. Averaging each location's
occupancy percentage gives a two-port location the same weight as a forty-port
one, so a single quiet pair of chargers can drag a city-wide figure down by
several points. `src/domain/metrics.ts` has no code path that produces a mean of
percentages, and the domain specs assert the difference on a case constructed to
make the two answers diverge.

The same rule applies across time. An hour with five observations and an hour
with one do not get equal weight; each observation covers the interval it is
responsible for, and those intervals are what is summed.

## Intervals are half-open

Every interval is `[start, end)`. An observation at 10:00 and the next at 10:05
means the first covers 10:00:00 through 10:04:59.999 — not through 10:05:00.

Without this, an observation at exactly midnight would be counted in two days,
two adjacent intervals would double-count their shared boundary, and totals
would not add up. `src/domain/time.ts` enforces it in `intersect`, `subtract`
and `splitByLocalHour`.

## Carry-forward, and its limit

A reading is carried forward until the next one, because a charger observed
occupied at 10:00 was probably still occupied at 10:01. But "probably" runs out,
and the question is when.

Carry-forward ends at the **earliest** of:

- the next observation;
- the end of the monitored span;
- a capacity change at that location;
- the end of the requested window;
- the **freshness budget**.

The budget is computed by `carryForwardBudgetMs` in `src/domain/types.ts`: the
smaller of twice the scheduled interval and a hard cap, and smaller still if the
source itself declares a freshness limit. Past it, the time is `unknown` — not
occupied, not available.

The part worth understanding: **the freshness policy in force at the time is
stored with each observation.** Changing the collection interval or the cap
later does not retroactively change what was known in the past. History cannot
be rewritten by adjusting a setting, which is the only way carry-forward can be
made safe.

## The residual is unknown, never occupied

If a source reports 3 available out of 8 total and says nothing else, you know
three things: 3 available, 8 installed, and **5 unaccounted for**. Those five
are not occupied. They might be occupied, out of service, or in a state the
source did not name.

`reconcileCounts` in `src/domain/reconcile.ts` assigns every residual to
`unknown`. It never infers occupancy from the gap between available and total,
because that inference is wrong precisely when it matters most — during an
outage, when ports are offline rather than in use.

## Coverage: two different numbers

Both are shown, because they answer different questions.

**Known-state coverage** is the share of port-minutes where the state was known
at all. It tells you how much of the window ChargeWatch actually observed.

**Operational coverage** is the share of port-minutes where the port was
in service. It tells you how much capacity existed to be used.

The acceptance case that pins the distinction: a ten-port location where eight
ports are out of service all week and the remaining two are occupied half the
time. Occupancy is 50%, known-state coverage is 100%, operational coverage is
20%. Reporting only the first would make a broken site look ordinary; reporting
only occupancy against installed ports would make it look empty.

## Gaps

Time ChargeWatch did not observe is recorded as a gap with a reason — the app
was closed, the computer was asleep, the source was paused, collection was
stopped by the user. Gaps are never bridged and never counted as zero usage.

On screen a gap is a break in the trend line, not a dip to zero. On the heatmap
it is a dedicated colour step, distinct from the lowest occupancy step. In an
export the cell is empty, not `0`.

An unclean exit is detected on the next start via a heartbeat row and recorded
as a gap covering the period between the last heartbeat and the restart. That
period genuinely was unobserved, and pretending otherwise would be the easiest
dishonest shortcut in the whole application.

## Ranking eligibility

A location is ranked only when it has:

- at least **7 days** of history;
- at least **90%** known-state coverage over the window;
- a known installed capacity;
- a source whose granularity supports occupancy.

A location that misses any of these is still shown, as **provisional**, with the
specific reasons listed. It is not hidden and not ranked. Hiding it would make
the study area look smaller than it is; ranking it would put a three-day sample
next to a three-month one.

Note that the two thresholds are independent. A location can have 30 days of
history and still be provisional because coverage over the selected window is
62% — the window is what is ranked, not the location's lifetime.

## Occupancy bands

Below 30% is low, 30–60% is moderate, 60% and above is high
(`OCCUPANCY_BANDS` in `src/domain/thresholds.ts`). Boundaries fall in the lower
band, and the specs assert that at the exact values.

Unknown occupancy is its own band — `unsupported` — rendered in muted text, not
in the low-occupancy colour. A location with no data must not look like a quiet
one.

Colour is never the only signal. Every status dot has a text label beside it
(`statusDotLabel` in `src/renderer/src/format.ts`), and the heatmap key includes
an explicit "No data" swatch.

## Activity: episodes, not sessions

From a per-port source, ChargeWatch infers **occupancy episodes** — a port
became occupied around some time, and became free around some later time.

"Around" is the substance. The true start lies between the last observation
showing the port free and the first showing it occupied; both bounds are stored
(`start_lower_ms`, `start_upper_ms` and their end counterparts). An episode that
was already in progress when observation began is **left-censored**; one still
in progress at the end is **right-censored**. Both flags are stored and both are
surfaced, because an episode of unknown length must not be averaged in as if its
length were known.

Short flips are retained rather than debounced away. A port that reads occupied
for one observation and free for the next might be a real brief plug-in or an
artefact; discarding it would be a decision to believe one interpretation, so it
is kept and marked `uncertain_short_flip`.

None of this is a charging session. `NO_SESSION_RECORDS_EXPLANATION` in
`src/domain/episodes.ts` is the text shown wherever activity appears, and it
says so directly: no public source reports sessions, energy delivered, or who
was charging.

From an aggregate-only source, not even episodes are available — only observed
increases in the occupied count, which is a weaker signal still and is labelled
as such.

## Visit comparison

If you import visitor counts, ChargeWatch compares them against charger usage
over the **same period**, and refuses to do so otherwise.

It will not prorate. A visit dataset covering a calendar month cannot be
stretched to match a 23-day observation window; the overlap is computed and the
comparison is made over that, or it is not made. It rejects overlapping datasets
for the same site and period, and datasets whose count definitions differ —
"property entries" and "unique visitors" are not the same measurement and
averaging them produces a number meaning nothing.

Zero visits produces an **undefined** ratio, not zero and not infinity.

## Algorithm version

Every cached metric row stores `algorithm_version`
(`METRIC_ALGORITHM_VERSION`, currently 1). Cached values computed by an older
algorithm are recomputed rather than served.

Raw observations are never the derived values. Everything in `hourly_metrics` is
a cache and can be thrown away and rebuilt from the observations. That is what
makes it safe to fix a metric bug retroactively: the underlying evidence is
untouched, so the corrected number is what the data always said, not a new
guess.

## Time zone

All weekday and hour attribution is in **America/Phoenix**, the study area's
zone, regardless of the machine's setting. Arizona does not observe daylight
saving, which removes an entire class of ambiguity — but the code does not rely
on that, and the specs prove independence by running the same input under
`TZ=UTC` and `TZ=Pacific/Kiritimati` and requiring identical output.

---

## If a number still looks wrong

Check, in this order:

1. **The window.** "Last 30 days" clipped by a study start of 11 days ago is an
   11-day window, and the summary says so.
2. **Coverage.** A 62%-coverage window is a different measurement from a
   98%-coverage one, and the interface labels it.
3. **Which ports.** If the source reports a subgroup, the scope note on the
   station says which ports the numbers cover.
4. **Export the observations** for that window and station and look at them. The
   raw export is the evidence; everything above is derived from it.

If those do not explain it, it is a bug worth reporting — use the
**Data accuracy concern** issue template, which asks for exactly the above.
