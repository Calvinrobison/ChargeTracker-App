# ChargePoint adapter fixtures — SYNTHETIC

**Everything in this directory is synthetic.** These fixtures are written by
hand to model page *shapes* the adapter must handle. They are **not** captured
provider content, and they are **not** evidence that the adapter works against
the live source.

## Why they are synthetic

Two separate reasons, both recorded honestly:

1. Raw provider content is kept out of this repository unless redistribution is
   permitted. It is not, so captured pages are never committed here.
2. At the time these were written the build environment had **no network route
   to `driver.chargepoint.com`** (the sandbox egress policy denied the host), so
   no live page could be captured at all. See `docs/SOURCE_VERIFICATION.md`.

## What they do and do not establish

They establish that `parsePageReading` behaves correctly for the modelled
shapes: status vocabulary, missing dimensions, ambiguous identity, aggregate-only
summaries, layout changes, identity mismatch, sign-in walls and challenges.

They establish **nothing** about:

- whether the live page still has that shape,
- whether automated collection from the source is permitted,
- regional coverage,
- whether a real observation can be recorded.

Those require the live verification recorded in `docs/SOURCE_VERIFICATION.md`,
which is currently `blocked`.

## The one real-world detail these are modelled on

The handoff brief records a prior research spot check (September 2026) that read
public status text for `BANNER HEALTH / BAYWOOD 2`, 6644 E Baywood Ave, Mesa,
showing two displayed J1772 port entries. The `twoPortJ1772` fixture models that
shape. That spot check is second-hand information in this repository: it was not
reproduced here, and it is not treated as verification.
