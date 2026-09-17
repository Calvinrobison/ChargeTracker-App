# Sources

Which charger networks ChargeWatch can observe, on what basis, and what each one
can and cannot tell you.

**A network appearing in the station catalog is not a claim that ChargeWatch can
observe it.** The catalog says a location exists. A *source* is a page
ChargeWatch is permitted and able to read. The two are separate, and the
interface keeps them separate: a catalog-only location shows "Catalog only, not
monitored" rather than an empty set of numbers.

---

## Current status

| Source | Eligibility | Verification | Observations recorded |
| --- | --- | --- | --- |
| ChargePoint | `needs_review` | `blocked` | **none** |

**No source is currently cleared for automated collection, so ChargeWatch is
not recording any observations.** This is shown on the onboarding screen, in a
banner in the main window, and in the source health panel. It is not hidden
behind a setting.

The reason is specific and is recorded in
`docs/IMPLEMENTATION_STATUS.md` as blocker B2: the build environment had no
route to `driver.chargepoint.com` **or** to the terms pages that would establish
whether reading it is permitted. Neither question could be answered, so the
adapter ships declaring both unanswered rather than assuming an answer.

`docs/SOURCE_VERIFICATION.md` is the process for changing that.

---

## What a source declaration contains

Every adapter declares a `SourceCapabilities` record
(`src/collector/contract.ts`). It is not documentation — the application reads
it and changes behaviour accordingly.

**`eligibilityState`** — `enabled`, `disabled`, or `needs_review`. Whether
observing this source is *permitted*. Only `enabled` allows the scheduler to
dispatch work to it. A source that is not enabled is not retried, because
retrying would mean making a request that has not been established as
permissible; the interface offers "View details" instead of "Try again".

**`verificationState`** — `verified`, `unverified`, or `blocked`. Whether the
adapter has been shown to read this source correctly. A source can be permitted
but unverified (nobody has confirmed the parser works), or verified but not
permitted (it reads correctly, but we have no basis for reading it).

**Granularity** — what the source actually reports:

- `port` — per-connector state. Supports episode inference and the most precise
  occupancy.
- `station_aggregate` — counts only ("3 of 8 available"). Occupancy is
  computable; per-port episodes are not.
- `charger_subgroup` — a subset of a location's ports, with the rest unknown.
  Metrics are scoped to the subgroup and labelled.

**Identity reliability** — `durable`, `unstable`, or `none`. Whether the
source's own identifier for a station can be trusted across reads. An `unstable`
identity means a binding has to be re-confirmed rather than assumed, and a
mismatch is treated as a failure rather than silently re-pointed at a different
station.

**Whether it distinguishes charging from occupancy.** Most do not. When a
source does not, the interface says "occupied", never "charging", and the
station detail says so explicitly.

---

## What no source provides

This is the same list in `README.md`, repeated here because it is the question
that comes up when someone proposes adding a network.

No public charger status page exposes:

- **charging sessions** — who plugged in, when, for how long;
- **energy delivered** — kWh, power drawn, charge curves;
- **driver or vehicle identity** — anything about the person or the car;
- **revenue** — what anyone paid.

ChargeWatch sees counts of ports in each state, at the moments it looked. From a
per-port source it can *infer* occupancy episodes, with explicit uncertainty at
both ends where the episode extends past the observation window. Those are
labelled as inferred everywhere they appear, and the station detail carries the
explanation in `NO_SESSION_RECORDS_EXPLANATION`.

A feature request that needs any of the four items above is a request to
fabricate data. `.github/ISSUE_TEMPLATE/feature_request.yml` says so up front so
nobody spends time writing one.

---

## The station catalog

The intended source is the **Alternative Fuels Data Center** station dataset
(`afdc.energy.gov`), filtered to a 50-mile radius of 33.4152, −111.8315.

**No catalog data is bundled.** `resources/catalog/` contains a README and
nothing else. AFDC was unreachable from the build environment, and writing
plausible-looking station rows would have put fabricated locations in front of
someone with no way to tell they were invented.

To populate it:

```powershell
npm run catalog:refresh
```

Review what it produces before committing. The field mapping in
`CatalogImportRecord` is a declared shape that has never processed a real AFDC
file. The script rejects malformed coordinates explicitly — including the empty
string, because `Number('')` is `0` and `0,0` is a real place in the Gulf of
Guinea — but a mapping error would be subtler than that.

A refresh **records conflicts rather than overwriting user corrections**, and
never erases observations. If AFDC later reports a different port count for a
location you have already corrected by hand, you get a conflict to resolve, not
a silent overwrite of your correction and the history attached to it.

---

## How a station gets linked to a source

A catalog entry and a source page are matched by
`src/domain/matching.ts`. Two rules shape it:

**Proximity alone never auto-merges.** Two chargers 40 metres apart in the same
parking structure are routinely different operators. A proposal based only on
distance scores below the automatic-confirmation threshold and is surfaced for a
human to decide.

**The proposal threshold is lower than the auto-confirm threshold.** Surfacing a
weak match for review is safe; acting on one is not. Only a proposal above
`AUTO_CONFIRM_CONFIDENCE` can bind without a person.

You can also link a station manually from its detail panel, which is the
intended path when the catalog and the provider disagree about names.

---

## Adding a source

The short version: establish that it is permitted **before** writing code.
`docs/SOURCE_VERIFICATION.md` has the process. A pull request adding an adapter
without a recorded eligibility basis will be asked for one before anything else
is reviewed.

Technically, an adapter implements four methods (`src/collector/contract.ts`)
and must keep its extraction logic in a **pure function** over a structured page
reading, the way `src/collector/adapters/chargepoint/parse.ts` does. That
separation is what allows 23 specs to cover the extraction without a browser,
and it is why the parser is the best-tested part of the collector while the
wiring around it is the least-tested.

Ship a `PARSER_VERSION` and bump it when extraction changes. It is stored with
every observation, so a future reader can tell which parser produced a reading
and re-derive metrics if one turns out to have been wrong.
