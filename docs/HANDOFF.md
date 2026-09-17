# Handoff

Everything you need to pick ChargeWatch up from where it was left, in the order
you will need it.

Read this with `IMPLEMENTATION_STATUS.md` (what is done and blocked) and
`VERIFICATION_REPORT.md` (what was actually tested). This document is the
mechanics: how to get the code to GitHub, what to run first, and what to expect
to break.

---

## 1. Get the branch onto GitHub

The work is on a local branch `chargewatch-v1`. It was never pushed, because the
build environment's git proxy refused the repository:

```
Calvinrobison/ChargeTracker-App is not in this session's authorized repository set.
```

That is an environment restriction, not a repository problem. From your own
machine:

```powershell
git clone https://github.com/Calvinrobison/ChargeTracker-App.git
cd ChargeTracker-App

# Apply the branch. If you received it as a bundle or an archive, unpack it
# here first; otherwise add the working copy as a remote and fetch from it.
git checkout -b chargewatch-v1
git push -u origin chargewatch-v1
```

Then open a pull request. The pull request template will prompt you through the
data-honesty checklist; it applies to this change like any other.

**Do not merge to `main` before running the checks in section 2.** Nothing in
this branch has been typechecked or built.

---

## 2. The first hour

Run these in order. Each one is expected to find something.

### 2.1 Confirm the specs still pass on your machine

```powershell
npm run test:nodeps
```

Expect `# pass 380`, `# fail 0`. This needs Node 22.12+ and nothing else — no
install, no network. If it fails here, something is wrong with your Node
version before anything else is worth investigating.

### 2.2 Resolve the dependency tree

```powershell
npm install
```

This writes `package-lock.json`, which does not exist yet and which every other
step depends on. Commit it on its own:

```powershell
git add package-lock.json
git commit -m "chore: pin dependency versions"
```

The versions in `package.json` are the ones the code was written against. If npm
resolves something materially newer for Electron, better-sqlite3 or
playwright-core, read `docs/adr/0001-stack-and-version-pinning.md` before
accepting it — those three are the ones that can change behaviour rather than
just surface.

### 2.3 Typecheck

```powershell
npm run typecheck
```

**This has never been run.** It is the highest-yield check available and it is
expected to report real errors. The two most exposed areas:

- **The renderer.** No spec imports a `.tsx` file, so type-stripping has never
  even parsed those modules. Errors here are likely and mostly mechanical.
- **`src/main/updates-backend.ts`.** Written against electron-updater's
  documented API rather than against a running copy of it. Its install surface
  differs across versions; the `UpdaterBackend` interface in
  `src/main/updates.ts` is the seam to adjust, and the `UpdateService` above it
  should not need to change.

Fix what it finds, re-run `npm run test:nodeps`, and commit.

### 2.4 Build and see the interface for the first time

```powershell
npm run build
npm run test:e2e
```

The UI specs in `tests/ui/honesty.spec.ts` have never been executed. Their
selectors were written against the source rather than against a running page, so
expect some of them to need correcting. **Correct the selector, not the
assertion** — the assertions are the point, and each one guards a specific way
the interface could mislead someone.

If you want to look at it rather than test it:

```powershell
npm run dev
```

### 2.5 Package, and prove the package works

```powershell
npm run setup:browser     # ~200 MB Chromium payload
npm run package:win
npm run verify:package
```

Then, in a **normal, non-elevated** PowerShell window:

```powershell
.\scripts\windows\test-installed.ps1
```

This is the first moment anyone learns whether the native SQLite module loads
under the Electron ABI and whether the bundled browser starts from
`process.resourcesPath`. Both are the kind of thing that looks fine until a user
runs it.

The script installs the build, runs it with `--self-check` against a throwaway
data directory, reads the JSON report, and uninstalls. It separates *integrity*
(data folder, database, bundled browser — must pass) from *readiness* (an
eligible source, a loaded catalog — expected to be unmet today, reported rather
than failed).

---

## 3. Things that are deliberately incomplete

None of these are oversights. Each one was a decision to report a gap rather
than fill it with something invented.

### No station catalog is bundled

`resources/catalog/` contains a README and nothing else. The AFDC dataset was
unreachable from the build environment, and writing plausible-looking station
rows would have put fabricated locations in front of a user who had no way to
tell. Run `npm run catalog:refresh` on a networked machine and review what it
produces — the field mapping in `CatalogImportRecord` is a declared shape that
has never seen a real file.

### No source is cleared for collection

The ChargePoint adapter ships `eligibilityState: 'needs_review'` and
`verificationState: 'blocked'`, and the application surfaces that state on the
onboarding screen and in a banner rather than hiding it. Neither the provider's
terms nor its status pages were reachable, so nothing could be established.
`docs/SOURCE_VERIFICATION.md` is the process. It may conclude the source is
ineligible; that is a real outcome, and the honest thing is then to say so in
`docs/SOURCES.md` rather than collect anyway.

### GitHub Actions are pinned to tags, not commit SHAs

Both workflows reference actions by major tag with a `TODO`. A tag is mutable.
Before `release.yml` ever holds a real signing key, resolve each one:

```powershell
gh api repos/actions/checkout/commits/v4 --jq .sha
```

and replace `@v4` with `@<sha> # v4.2.2`. The SHAs were deliberately not filled
in from the build environment, because inventing one produces either a broken
workflow or a reference to a commit nobody checked.

### The `release` environment does not exist yet

`release.yml` names a GitHub environment called `release` for its signing job.
Create it in repository settings with a required reviewer. Without it, that job
runs unattended and the protection the workflow describes is not actually in
place.

### No screenshots

`docs/` has no images, because nothing has rendered the interface. Take real
ones after step 2.4 rather than mocking any up.

---

## 4. Releasing

Full detail in `docs/RELEASING.md`. The short version:

```powershell
npm run keys:bootstrap    # once, ever — writes the private key OUTSIDE the repo
```

The private key goes to `~/.chargewatch-release-keys/` with restrictive
permissions. **It is never committed and never shipped.** Only the public half
goes into `resources/update-keys/keys.json`, which is what installed copies use
to verify an update. Lose the private key and you cannot ship an update that
existing installs will accept.

Then, per release:

```powershell
npm run package:win
npm run verify:package
npm run release:prepare -- --version 0.1.0
npm run release:verify
npm run release:publish -- --tag v0.1.0 --dry-run
```

`release:verify` runs the **same code the installed application runs**, against
the public keys the application ships. If it passes, an installed copy will
accept the release; if it fails, the release would be rejected on users'
machines — much better to find out here.

`release:publish` creates a **draft**. Promoting the draft is a separate,
deliberate act, because that is the moment every installed copy starts offering
the update.

---

## 5. Where to look when something is wrong

| Symptom | Start here |
| --- | --- |
| A number looks wrong | `docs/METRICS.md`, then the coverage indicator for that window |
| Collection is not happening | The source health banner; `docs/SOURCES.md` |
| The app will not start | `%LOCALAPPDATA%\ChargeWatch\logs\`; run the installed exe with `--self-check` |
| A history file looks damaged | `npm run db:probe -- --file <path>` — read-only, safe |
| An update was refused | `docs/UPDATES_AND_RECOVERY.md`; the rejection code names the exact check |
| Packaging produced something odd | `npm run verify:package` names the fault and the fix |

---

## 6. The one rule to keep

Every design decision in this repository comes back to the same constraint:
**ChargeWatch must never claim to know something it does not know.** Missing
data is not zero. An unperformed check is not a passed check. An inferred
episode is not a recorded session. A partially covered window is labelled as
one.

That constraint is what most of the schema, half the domain logic and all of the
formatter specs exist to enforce. If a future change makes one of those rules
inconvenient, the right move is an ADR explaining why the rule should change —
not a quiet exception. The pull request template's data-honesty checklist is
there to make that decision visible rather than accidental.
