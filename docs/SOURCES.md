# Sources

Which charger networks ChargeWatch can observe, on what basis, and what each one
can and cannot tell you.

**A network appearing in the station catalog is not a claim that ChargeWatch can
observe it.** The catalog says a location exists. A _source_ is a page
ChargeWatch is permitted and able to read. The two are separate, and the
interface keeps them separate: a catalog-only location shows "Catalog only, not
monitored" rather than an empty set of numbers.

---

## Current status

| Source      | Eligibility | Verification | Granularity | Port identity | Observations recorded                   |
| ----------- | ----------- | ------------ | ----------- | ------------- | --------------------------------------- |
| ChargePoint | `enabled`   | `verified`   | `port`      | `durable`     | once a location is linked and monitored |

**ChargePoint is cleared for automated collection as of 2026-09-21.** The
terms review and the live verification are recorded in
`docs/SOURCE_VERIFICATION.md`, and the capability record carries the same
basis. Nothing is recorded until a location is linked to a station page and
monitoring is switched on for it — from the station drawer, or for every linked
location at once from Settings.

### What ChargePoint reports

The public station page (`driver.chargepoint.com/stations/<id>`) lists each
outlet with one of the provider's own status words:

| Provider code                                                                    | Shown as       | Recorded as      |
| -------------------------------------------------------------------------------- | -------------- | ---------------- |
| `available`                                                                      | Available      | `available`      |
| `in_use`                                                                         | In Use         | `occupied`       |
| `in_use_by_driver` (the signed-in driver's own session; never seen here)         | Charging       | `occupied`       |
| `unavailable`, `maintenance_required`, `out_of_service`, `fault`, `out_of_order` | Out of Service | `out_of_service` |
| `closed` (outside the station's open hours)                                      | Closed         | `out_of_service` |
| `unreachable`, `unknown`, `out_of_network`                                       | Unknown        | `unknown`        |

"In Use" means the provider reports the port as in use. It does **not** mean
electricity was flowing, and ChargeWatch says "occupied", never "charging".

Each outlet block carries the physical outlet number, which is a durable
identifier, so per-port history and inferred occupancy episodes are supported.
The page shows no "as of" time for its status, so source freshness is recorded
as unknown rather than fresh. It shows "Last Used · N days ago" for the station;
that is kept as evidence and is never counted.

### How locations get linked

The catalog comes from the AFDC export, which carries no ChargePoint station
ids. **Settings → Locations and sources → "Find ChargePoint stations"** reads the
provider's station list for the study area once (the same list the driver map
page loads, requested from inside that page in the bundled browser) and links
each station to the catalog location with exactly the same name, on the same
network, at the same coordinates (`src/domain/matching.ts`,
`EXACT_NAME_CONFIDENCE`). On 2026-09-21 that linked 674 of the 706 stations the
provider lists for the 50-mile area — every ChargePoint location in the catalog —
with the port count agreeing in every case. The 32 left over are stations the
catalog does not have; a near-namesake ("SRPZOO-L2-#11" beside "#10") is
reported, never bound.

Discovery records nothing: it is linking, not collection. New links start with
monitoring off. A location the step did not link can be linked by pasting its
station page URL into the station drawer.

---

## What a source declaration contains

Every adapter declares a `SourceCapabilities` record
(`src/collector/contract.ts`). It is not documentation — the application reads
it and changes behaviour accordingly.

**`eligibilityState`** — `enabled`, `disabled`, or `needs_review`. Whether
observing this source is _permitted_. Only `enabled` allows the scheduler to
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
per-port source it can _infer_ occupancy episodes, with explicit uncertainty at
both ends where the episode extends past the observation window. Those are
labelled as inferred everywhere they appear, and the station detail carries the
explanation in `NO_SESSION_RECORDS_EXPLANATION`.

A feature request that needs any of the four items above is a request to
fabricate data. `.github/ISSUE_TEMPLATE/feature_request.yml` says so up front so
nobody spends time writing one.

---

## The station catalog

The catalog is the **Alternative Fuels Data Center** station dataset
(`afdc.energy.gov`), filtered to a 50-mile radius of 33.4152, −111.8315.
`resources/catalog/` holds 1083 locations from the Arizona export of
2026-09-18, with the source file's hash in `provenance.json`.

To refresh it, download the AFDC export and point the script at it:

```powershell
# 1. Get the CSV from https://afdc.energy.gov/data_download
# 2. Look at what it would produce, without writing anything:
npm run catalog:refresh -- --file .\alt_fuel_stations.csv --out .\catalog-preview --dry-run

# 3. Write it somewhere you can inspect:
npm run catalog:refresh -- --file .\alt_fuel_stations.csv --out .\catalog-preview

# 4. Once you are satisfied, write it for real and commit both files:
npm run catalog:refresh -- --file .\alt_fuel_stations.csv
```

No download URL is hardcoded on purpose: the endpoint moves, and the AFDC API
needs a developer key that must never ship inside the application.

`--out` exists so a trial run cannot overwrite the shipped catalog. That is not
a theoretical concern — while writing the specs for this script, a test run
wrote synthetic stations into `resources/catalog/` exactly where real ones
belong. `--out` was added in response.

A refresh **records conflicts rather than overwriting user corrections**, and
never erases observations. If AFDC later reports a different port count for a
location you have already corrected by hand, you get a conflict to resolve, not
a silent overwrite of your correction and the history attached to it.

---

## How a station gets linked to a source

A catalog entry and a source page are matched by
`src/domain/matching.ts`. Three rules shape it:

**A durable provider id, or an exact provider name at the same spot on the
same network, binds automatically.** The second rule exists because the AFDC
export lists each ChargePoint station under the provider's own name and
coordinates, so that combination is the provider's identity in everything but
the number. The name must be exactly equal after normalisation: "BAYWOOD 1"
and "BAYWOOD 2" share every multi-character token and would otherwise be
indistinguishable.

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
separation is what allows the parser to be covered without a browser, against
both synthetic shapes and readings captured from the live page.

Ship a `PARSER_VERSION` and bump it when extraction changes. It is stored with
every observation, so a future reader can tell which parser produced a reading
and re-derive metrics if one turns out to have been wrong.
