# Bundled station catalog

This directory holds the attributed regional station snapshot the app seeds its
catalog from, together with its provenance record: retrieval date, origin,
field mapping, licence, attribution and file hash.

**It is empty.** The build environment had no network route to
`afdc.energy.gov`, so no snapshot could be obtained, and inventing station rows
was not an option — a fabricated catalog would put imaginary chargers on a map
that is supposed to be a record of real observation.

## Obtaining it

```powershell
npm run catalog:refresh
```

That downloads the current AFDC public EV station data, filters it to a
50-mile straight-line radius of 33.4152, -111.8315, and writes the snapshot and
its provenance record here.

## Attribution

Station data comes from the U.S. Department of Energy's
[Alternative Fuels Data Center](https://afdc.energy.gov/data_download), which
permits reuse with attribution. Attribution is stored with the import and shown
in the app.

A station appearing in this catalog says **nothing** about whether it is
occupied right now, and nothing about whether ChargeWatch can observe it. Those
are separate facts, recorded separately.
