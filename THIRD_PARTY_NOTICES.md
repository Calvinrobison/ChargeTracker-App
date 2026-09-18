# Third-party notices

ChargeWatch bundles and depends on the components below. This file ships inside
the application (`resources/THIRD_PARTY_NOTICES.md`) and
`scripts/verify-package.mjs` fails a package that does not contain it.

> **This list is not yet complete or verified.** No dependency tree has been
> resolved in this repository — there is no `package-lock.json` — so the full
> transitive set and its exact licences are not yet known. What follows covers
> the direct dependencies and the bundled binaries. Before the first release,
> generate the complete list from the resolved tree and replace this section.
> Publishing with an incomplete notices file would be a licence-compliance
> failure, not a documentation gap.

---

## Bundled binaries

### Chromium (via Playwright)

A Chromium build is bundled and shipped as `resources/browser/`. It is used to
read public charger status pages, and nothing else — it is not a general
browsing feature and it is not exposed to the user as one.

Chromium is distributed under the BSD 3-Clause licence, and incorporates
components under a range of licences including Apache-2.0, LGPL and MPL. The
complete set is in the `LICENSE` and `LICENSES.chromium.html` files that ship
inside `resources/browser/`. Nothing in this file supersedes them.

The build is fetched by `scripts/setup-browser.mjs` at build time rather than
committed. The exact revision is determined by the resolved `playwright-core`
version and is recorded in `build-info.json` in each release.

### SQLite

SQLite is used through Node's built-in `node:sqlite`, in both the shipped
application and the test suite. ChargeWatch bundles no SQLite binary of its own;
it uses the copy inside the Node that Electron ships.

SQLite itself is in the **public domain**.

---

## Direct dependencies

Licences below are as declared by each package. They have not been verified
against a resolved tree; see the notice at the top.

### Runtime

| Package            | Purpose                                                                  | Declared licence |
| ------------------ | ------------------------------------------------------------------------ | ---------------- |
| `electron-updater` | Update discovery and installation, behind ChargeWatch's own verification | MIT              |
| `playwright-core`  | Driving the bundled Chromium                                             | Apache-2.0       |

### Bundled into the renderer

| Package              | Purpose            | Declared licence |
| -------------------- | ------------------ | ---------------- |
| `react`, `react-dom` | The user interface | MIT              |
| `leaflet`            | The map            | BSD-2-Clause     |
| `recharts`           | Charts             | MIT              |

### Build and development only

Not shipped: `electron`, `electron-builder`, `electron-vite`, `vite`,
`typescript`, `eslint` and its plugins, `prettier`, `vitest`, `playwright`,
`@playwright/test`, and the `@types/*` packages. These are
MIT, Apache-2.0 or BSD-licensed as declared by each.

Electron is MIT-licensed and incorporates Chromium and Node.js; the Electron
distribution's own `LICENSES.chromium.html` ships inside the packaged
application.

---

## Map tiles and station data

### OpenStreetMap

The map uses raster tiles from `tile.openstreetmap.org`.

Map data is © OpenStreetMap contributors, available under the
**Open Database License (ODbL)**. Tiles are served under the OpenStreetMap
Foundation's tile usage policy. The attribution is displayed in the map
workspace, and the tile origin is the only non-source, non-GitHub network
destination the application contacts.

If ChargeWatch's tile usage were ever to grow beyond what that policy permits,
the correct response is to move to a tile provider with a suitable agreement —
not to keep going quietly.

### Alternative Fuels Data Center

The intended station catalog source is the **AFDC** alternative fuel station
dataset, published by the U.S. Department of Energy's Office of Energy
Efficiency and Renewable Energy.

**No catalog data is currently bundled.** `resources/catalog/` contains a README
and nothing else — see `docs/SOURCES.md`. When a catalog is imported, record its
retrieval date and terms alongside it; `catalog_imports` carries that provenance
per import.

### Charger network status pages

ChargeWatch reads publicly accessible status pages. It stores the observed
status counts, the time of observation, and the provenance of the reading. It
does not store, redistribute or republish provider page content.

No source is currently cleared for collection. `docs/SOURCE_VERIFICATION.md`
covers what must be established first, including the terms review that precedes
any code.

---

## Regenerating this file

Once `package-lock.json` exists:

```powershell
npx license-checker --production --summary
```

Cross-check the result against this file, replace the direct-dependency tables
with the complete transitive set, and remove the notice at the top. Keep the
bundled-binaries and map-data sections — a tool that reads `package.json` will
not know about the Chromium payload, the OpenStreetMap tiles or the station
catalog, and those are the parts a user is most likely to ask about.
