# Clearing a source for collection

A source goes from `needs_review` to `enabled` only after a person has
established that reading it is permitted and that the adapter reads it
correctly. This document is that process.

It is written down because the failure mode is quiet: an adapter that works is
indistinguishable, from the code, from an adapter that works *and should not be
running*. Nothing in the test suite can tell you whether you are allowed to make
a request.

---

## Why nothing is enabled today

`docs/IMPLEMENTATION_STATUS.md` blocker B2. The build environment had no route
to `driver.chargepoint.com` or to the terms pages that govern it, so neither
question — *may we read this?* and *do we read it correctly?* — could be
answered. The adapter therefore ships declaring both unanswered:

```ts
eligibilityState: 'needs_review',
verificationState: 'blocked',
```

and the application surfaces that rather than hiding it. That is the honest
state of a source nobody has checked, and it is preferable to an adapter that
defaults to enabled and starts making requests.

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
came from. `tests/fixtures/chargepoint/README.md` shows the labelling; the
existing fixtures there are marked **SYNTHETIC** because no real page was ever
reachable.

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
- update `docs/SOURCES.md` with what the source can and cannot report;
- bump `PARSER_VERSION` if extraction changed.

Then watch the first day of collection. The source health panel shows backoff,
circuit-breaker state and pause reasons. A source that starts pausing
immediately is telling you something about step 1 that step 2 did not.

---

## The record

| Source | Reviewed on | Reviewed by | Terms URL | Rate limit basis | Outcome |
| --- | --- | --- | --- | --- | --- |
| ChargePoint | — | — | — | — | **Not reviewed.** No route to the provider or its terms from the build environment. Ships `needs_review` / `blocked`. |

Add a row per review, including re-reviews. Do not edit an old row when terms
change — add a new one, so the history of what was believed and when stays
readable.

---

## Things that are not a substitute for this process

**"It's public data."** Public and permitted are different questions. Whether
the answer differs here is exactly what step 1 establishes.

**"The request succeeded."** A provider that has not blocked you has not thereby
agreed to anything.

**"We'll be gentle about it."** Rate limiting is a condition of responsible
collection, not a replacement for permission. The token bucket, the jittered
backoff capped at six hours, the circuit breaker and the honoured `Retry-After`
all exist to be a good citizen *of a source we are allowed to read*.

**A green test suite.** Nothing in `npm run test:nodeps` can tell you whether a
request should be made. The specs prove the parser handles what it is given.
