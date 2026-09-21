# Clearing a source for collection

A source goes from `needs_review` to `enabled` only after a person has
established that reading it is permitted and that the adapter reads it
correctly. This document is that process, and the record of each time it has
been applied.

It is written down because the failure mode is quiet: an adapter that works is
indistinguishable, from the code, from an adapter that works _and should not be
running_. Nothing in the test suite can tell you whether you are allowed to make
a request.

---

## Status

**ChargePoint is enabled**, as of 2026-09-21. The review is in the record
below; the capability record in
`src/collector/adapters/chargepoint/index.ts` carries the same basis in its
`termsReviewScope` and `eligibilityBasis` fields, and
`tests/nodeps/source-url-safety.test.ts` fails if an adapter is ever flipped to
`enabled` without those fields filled in.

Until 2026-09-21 the adapter shipped `needs_review` / `blocked` because the
build environment had no route to `driver.chargepoint.com` or to the terms
pages, so neither question below could be answered
(`docs/IMPLEMENTATION_STATUS.md`, former blocker B2). That was the honest state
of a source nobody had checked.

---

## Step 1 — Establish that observing it is permitted

Do this **before** writing or enabling any code. Record what you find; the
record is the deliverable, not the conclusion.

**Read the terms of service and acceptable use policy.** Look specifically for
automated access, scraping, rate limits, and whether public status information
is treated differently from account data. Note the URL and the date you read it:
terms change, and a decision made against a version nobody wrote down cannot be
re-examined later.

**Read `robots.txt`.** It is not a legal instrument, but it is a clear statement
of intent from the operator and ignoring it is a choice you should make
deliberately rather than by omission.

**Check for a documented API or data feed.** If one exists, use it. A published
API is an invitation; reading a page built for humans is not. An API also
usually gives better data with less load on the provider.

**Establish the rate limit.** If the terms or the API documentation state one,
that is the limit. If they do not, the defaults in
`src/domain/thresholds.ts` — a 30-second minimum between navigations per source,
enforced by a token bucket — are a floor, not a licence.

**Write down what you decided and why**, in this file, in the table below. A
future maintainer needs to know not just that a source is enabled but on what
basis, so they can tell when the basis has expired.

If the answer is that observing it is not permitted: record that, leave
`eligibilityState: 'disabled'` with a note, and say so in `docs/SOURCES.md`. A
source we may not read is a real finding and a perfectly good outcome for this
process. It is not a problem to engineer around.

## Step 2 — Verify the adapter reads it correctly

Only after step 1.

**Capture real page readings as fixtures.** Save the structured readings the
adapter produces, not raw HTML dumps, and label them with where and when they
came from. `tests/fixtures/chargepoint/README.md` shows the labelling.

**Cover the states that matter**, not just the happy one:

- every status word the source uses, mapped to a `PortState`;
- a status word you do not recognise — it must become `unknown`, never
  `available`;
- an aggregate-only summary, where per-port state is absent;
- connector counts that differ from port counts;
- a "last used" or similar timestamp — it must never be counted as occupancy;
- a sign-in wall, a rate-limit response, and a changed layout, each mapping to
  its own outcome so the scheduler can pause rather than hammer.

**Do one bounded live read.** One. Compare what the adapter extracted against
what the page actually showed, by eye. This is the step that catches a parser
which is self-consistently wrong.

**Confirm the identity check works.** Point the adapter at a station and confirm
it rejects a page whose identity does not match, rather than silently attributing
one station's readings to another. That failure is worse than no data, because it
is invisible in the output.

## Step 3 — Enable it

Change the capability record:

```ts
eligibilityState: 'enabled',
verificationState: 'verified',
```

and in the same commit:

- add the row to the table below, with the date and the basis;
- fill `termsReviewedAtMs`, `termsReviewScope` and `eligibilityBasis` in the
  capability record — the spec refuses `enabled` without them;
- update `docs/SOURCES.md` with what the source can and cannot report;
- bump `PARSER_VERSION` if extraction changed.

Then watch the first day of collection. The source health panel shows backoff,
circuit-breaker state and pause reasons. A source that starts pausing
immediately is telling you something about step 1 that step 2 did not.

---

## The record

| Source      | Reviewed on | Reviewed by                                                      | Terms URL                                                                                                                                                                                                                                                                                              | Rate limit basis                                                                                                | Outcome                                                                                                                 |
| ----------- | ----------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| ChargePoint | 2026-09-17  | —                                                                | —                                                                                                                                                                                                                                                                                                      | —                                                                                                               | **Not reviewed.** No route to the provider or its terms from the build environment. Shipped `needs_review` / `blocked`. |
| ChargePoint | 2026-09-21  | the-x1x1 (via Claude, in a browser on the contributor's machine) | `https://www.chargepoint.com/terms-of-use`; `https://na.chargepoint.com/standard-driver-terms?country_id=233&instance=NA-US&locale=en` (last updated 2026-03-25); `https://driver.chargepoint.com/robots.txt`; `https://www.chargepoint.com/robots.txt`; `https://mc.chargepoint.com/robots.txt` (404) | None published. `src/domain/thresholds.ts` floor applies: 30 s between navigations, 15 min cadence per station. | **Enabled.** See below.                                                                                                 |

### 2026-09-21 review, in full

**Website Terms of Use** (`www.chargepoint.com/terms-of-use`, 17 sections,
undated beyond "© 2026"). Read in full. Contains no clause on automated
access, robots, spiders, scrapers, crawlers, data mining, harvesting or rate
limits. "Your use of our site" prohibits unlawful use and causing damage.
"Intellectual property & limited license" permits copying and downloading
materials for non-commercial use and prohibits reproduction, distribution or
derivative works of site content without permission.

**Terms of Service for ChargePoint Accounts** (`na.chargepoint.com/
standard-driver-terms`, last updated 2026-03-25, 23 sections). Read in full.
Contains no clause on automated access, robots, scraping, crawling, data
mining, harvesting or rate limits, and no restriction specific to station
status data. "Use of the Services" permits using the services "to obtain
information regarding ChargePoint Available Charging Station locations" and
disclaims accuracy. "Licenses" grants a limited, personal, non-commercial
licence and prohibits: reproducing, distributing or publicly displaying the
services or creating derivative works; modifying them; decompiling or reverse
engineering their source code; and interfering with or circumventing "any
feature of the Services, including any security or access control mechanism".
These terms govern _accounts_; ChargeWatch never creates or uses one.

**robots.txt.** `driver.chargepoint.com`: `User-agent: * / Disallow:` —
everything allowed. `mc.chargepoint.com`: none (404). `www.chargepoint.com`:
a stock Drupal file disallowing only CMS internals (`/admin/`, `/user/login`,
…); station content is not under any disallowed path.

**Documented API or feed.** None exists for public station status. ChargePoint
publishes an owner-facing web-services API for station operators, which
requires an operator account and does not apply.

**How ChargeWatch's behaviour meets the restrictions that do apply.**

- _Personal, non-commercial._ ChargeWatch is a local desktop tool; everything
  it records stays on the user's machine, nothing is redistributed, and the
  application is `UNLICENSED`, private and free.
- _No circumvention of access controls._ It reads the same public page a
  person would, without an account. A sign-in wall, a "verify you are human"
  challenge or an HTTP 401/403 **pauses** the source (`PAUSE_SOURCE_OUTCOMES`);
  they are never retried through, worked around or automated past.
- _No reproduction or derivative works of the service._ The application
  stores port counts and a sanitised one-line evidence string per reading,
  not page content, images, tips or usernames.
- _Load._ One page load per monitored station per 15 minutes, never closer
  than 30 seconds apart, backing off exponentially on any transient failure
  and honouring `Retry-After`. A station discovery run (linking, not
  collection) is one map page load plus paced list requests, on demand only.

**Judgement.** Nothing in either document restricts automated reading of the
public station page; the operator's own `robots.txt` on the page's host allows
all crawling; and the use is personal and non-commercial with no access
control involved. Enabled on that basis. If either document gains an
automated-access clause, this basis expires: add a new row, do not edit this
one.

**Step 2 — live verification, 2026-09-21.** Three stations read in a browser
and compared by eye against what the adapter's extraction script returned:
11502161 BANNER HEALTH / BAYWOOD 1 (two J1772 outlets, one Available, one In
Use), 17560121 CHAPMAN FORD / POWER LINK S (two 120 kW CCS1 outlets, both
"Out of Service", provider code `maintenance_required`) and 1804411
CHARGEPOINT / SCD RTECH DC 1 (one 62.5 kW outlet, "(DC Fast)" plug line,
provider code `fault`). All three matched. A non-existent station id renders
"Failed to load station details" with no port blocks and is reported as a
source error. The captured readings are `tests/fixtures/chargepoint/
captured.ts`; the specs are `tests/nodeps/chargepoint-captured.test.ts`; the
provider's complete pill vocabulary was taken from its own
`na.chargepoint.com/UI/images/pills/states/en-US/states.json` (version 1715755545) and is encoded in `parse.ts` with a spec that covers every entry.
The identity check is exercised by the same spec file (a reading for 11502161
is refused when 11502162 was expected).

**How the collector identifies itself, and what that cost.** The adapter set
`X-Requested-With: ChargeWatch/<version>` on the browser context so the
provider could see who was reading. A header set there is attached to every
cross-origin request the _page_ makes as well as to ours, and
`X-Requested-With` is not a CORS-safelisted request header, so those requests
needed a preflight the provider does not answer — including the one for the
`states.json` above. The page rendered "Unable to load page" and there was no
status to read; in the packaged application on 2026-09-21 this produced a
`timeout` on every attempt and an open circuit breaker, with zero observations
recorded. Isolated by holding everything else constant and changing one thing
at a time against station 11502161: with the header the page never renders,
without it the same headless browser renders port rows. The user agent and
`navigator.webdriver` are irrelevant — a page that fails with an ordinary
Chrome user agent and succeeds with the headless one only when the header is
gone settles it.

The identifier now rides on the User-Agent instead: safelisted, sent by the
page anyway, and appended to the browser's own string rather than replacing
it. `HeadlessChrome` stays in what we send. Identifying the reader is the
point; pretending to be an ordinary browser would be the opposite of it, and
the paragraph above about paced, bounded reading only means anything if the
operator can see who is doing it.

**Not verified.** The `reserved` state, a sign-in wall and a challenge page
were not seen on the live site and remain covered only by synthetic fixtures.
The adapter has run inside the packaged application against the live site as
of 2026-09-21 — that is how the header fault above was found — but a
successful observation recorded end to end from the installed build is still
outstanding; `docs/IMPLEMENTATION_STATUS.md` tracks it.

---

## Things that are not a substitute for this process

**"It's public data."** Public and permitted are different questions. Whether
the answer differs here is exactly what step 1 establishes.

**"The request succeeded."** A provider that has not blocked you has not thereby
agreed to anything.

**"We'll be gentle about it."** Rate limiting is a condition of responsible
collection, not a replacement for permission. The token bucket, the jittered
backoff capped at six hours, the circuit breaker and the honoured `Retry-After`
all exist to be a good citizen _of a source we are allowed to read_.

**A green test suite.** Nothing in `npm run test:nodeps` can tell you whether a
request should be made. The specs prove the parser handles what it is given.
