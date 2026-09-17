<!--
Delete the sections that do not apply. Do not delete the data-honesty
checklist: it is the one part that applies to every change, including
documentation, because a doc can overstate a capability just as code can.
-->

## What this changes

<!-- One paragraph. What is different after this merges, and why. -->

## How it was verified

<!--
State what you actually ran, and its result. "Should work" is not a
verification. If something could not be verified in this environment, say so
here rather than leaving it implied — an honest gap is fine, a silent one is
not.
-->

- [ ] `npm run test:nodeps` (no install required)
- [ ] `npm run verify` (format, lint, types, specs)
- [ ] Windows package built and launched
- [ ] Not verified: <!-- list anything you could not check, and why -->

## Data honesty

Every change is checked against the project's central constraint. Tick each
line only if you have confirmed it, not if it merely seems true.

- [ ] No code path can write an observation that was not actually obtained from a source.
- [ ] Missing measurements remain distinguishable from zero measurements, in storage and on screen.
- [ ] No check is reported as performed unless it ran.
- [ ] Inferred activity is not presented as a recorded charging session.
- [ ] Aggregation is weighted by port-minutes; no mean of percentages was introduced.
- [ ] Carry-forward of a stale reading stays bounded by the freshness policy recorded with that observation.
- [ ] Metrics computed over partial coverage are still labelled as such.
- [ ] No fixture, sample, or default value could be mistaken for a real observation.

If any box above is unticked because the change deliberately alters one of
these rules, explain here. A change to these rules needs an ADR.

## Schema and migrations

- [ ] No schema change.
- [ ] Schema changed, with a new numbered migration, and `npm run check:migrations` passes.
- [ ] Existing data survives the migration, and the migration was run against a populated database.
- [ ] Readable/writable schema bounds updated where a release must refuse an older or newer database.

## Sources

- [ ] No source change.
- [ ] A source was added or changed, and `docs/SOURCES.md` plus `docs/SOURCE_VERIFICATION.md` record its eligibility basis and verification state.
- [ ] No new request path bypasses the rate limiter, backoff, or circuit breaker.
- [ ] Fixtures added for this source are labelled synthetic where they are synthetic.

## Documentation

- [ ] `docs/IMPLEMENTATION_STATUS.md` updated if this completes or changes an item.
- [ ] `docs/VERIFICATION_REPORT.md` updated if this changes what has actually been tested.
- [ ] `CHANGELOG.md` entry added.
- [ ] The README still describes what the application can do today, not what it is intended to do.
