# ChargePoint adapter fixtures

Two files, two kinds of evidence. Read the label before trusting a fixture.

## `captured.ts` — CAPTURED (2026-09-21)

These are the exact objects the adapter's own extraction script returned when
it was run against the live station page in a browser on 2026-09-21, one per
station, with the read instant from the same run. They are **structured
readings** — status words, provider status codes, kW, plug lines, outlet
numbers — not raw page content, which is what `docs/SOURCE_VERIFICATION.md`
step 2 asks for and why they can be committed.

| Fixture                       | Station                              | What it shows                                                           |
| ----------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| `baywood1OneInUse`            | 11502161 BANNER HEALTH / BAYWOOD 1   | 2 × L2 J1772; one Available, one In Use; "Last Used 2 days ago"         |
| `chapmanFordBothOutOfService` | 17560121 CHAPMAN FORD / POWER LINK S | 2 × 120 kW CCS1; both "Out of Service" with code `maintenance_required` |
| `scdRtechFault`               | 1804411 CHARGEPOINT / SCD RTECH DC 1 | 1 × 62.5 kW, plug line "(DC Fast)", code `fault` → "Out of Service"     |
| `unknownStationError`         | 999999999 (no such station)          | "Failed to load station details" and no port blocks                     |

What they establish: the extraction script finds the port blocks on the real
page, and the parser turns them into the counts a person reading the page
would write down (`tests/nodeps/chargepoint-captured.test.ts`).

What they do not establish: that the page still has this shape today. The
selectors are the page's own `data-qa-id` test hooks — the only stable thing
on it — and a change that removes them surfaces as a `layout_changed` outcome
in the source health panel, never as a wrong number.

## `readings.ts` — SYNTHETIC

Hand-written page _shapes_ from before any live page could be reached
(2026-09-17). They still model conditions the captured set does not cover —
an aggregate-only summary, an update-time phrase, a sign-in wall, a challenge,
an identity mismatch — and the parser specs in
`tests/nodeps/chargepoint-parse.test.ts` run against them for exactly those
paths. They are not evidence about the live page and never were.

Two of their assumptions turned out wrong on the real page, which is worth
knowing when reading them: the page has **no** "N of M available" summary and
**no** "updated N minutes ago" text for status, and its port rows **do** carry
a durable identifier (the outlet number). The synthetic fixtures are kept as
written because the parser must still handle those shapes if the page ever
grows them.

## Raw content

Raw page content is kept out of this repository. The captured readings above
carry nothing personal — the tips section, usernames and photos on the page
are not read — and the evidence string the parser stores is passed through
`sanitizeEvidence` first.
