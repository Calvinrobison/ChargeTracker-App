# Data model

This document describes the SQLite schema ChargeWatch stores its history in:
what the 28 tables are for, which columns exist specifically to make dishonest
reporting impossible, how ingestion stays idempotent, how migrations and
backups are handled, and how to inspect a history file without opening the
application. It is written for someone adding a column, writing a query, or
auditing whether a number the interface shows could have been invented. The
canonical schema is `src/database/migrations/001_initial.sql`; everything below
is verified against that file and the code that reads and writes it. Where a
table exists but nothing writes to it, that is stated at the table, not only in
a footnote.

Three conventions hold throughout, and the migration file states them at the
top:

- Every instant is an `INTEGER` of UTC milliseconds, range-checked.
- Unknown is `NULL` or an explicit `'unknown'` enum value. **Zero is never
  overloaded to mean "we do not know."**
- Raw observations are append-only apart from explicit user deletion, and
  source identifiers are stored separately from local identifiers.

Schema version is 1 (`TARGET_SCHEMA_VERSION` in `src/database/migrator.ts`).
The file contains 28 tables and 39 explicit indexes, 12 of them unique. (Note:
`IMPLEMENTATION_STATUS.md` and `VERIFICATION_REPORT.md` both say 54 indexes;
that figure does not match the file and appears to include SQLite's implicit
primary-key and unique-constraint indexes.)

## The table groups

### Catalog and identity

`sites` is the local record of a physical charging location, keyed by a local
`id` that is never a provider's identifier. `registry_station_id` holds the
external catalog's id separately, which is what lets a catalog refresh
re-identify a row without the two namespaces colliding. `latitude` and
`longitude` are range-checked; `distance_miles` is nullable because a distance
that has not been computed is not zero miles. `access_condition` and
`catalog_level` both default to `'unknown'` rather than to a plausible guess.

`user_corrected`, `user_corrections_json` and `saved` record what the user has
changed or marked. `catalog_imports` carries the provenance of every catalog
load: `source_name`, `source_url`, `retrieved_at_ms`, `imported_at_ms`,
`license`, `attribution`, `file_sha256`, `field_mapping_json`, the radius bounds
the import was filtered to, and an `outcome` of `succeeded` / `partial` /
`failed`. `ux_catalog_imports_hash` on `(source_name, file_sha256)` makes
re-importing the identical file a no-op rather than a duplicate.

`site_conflicts` is the honesty mechanism for refreshes. When a catalog import
disagrees with a field the user corrected, the disagreement is *recorded* —
`field`, `existing_value`, `incoming_value`, `resolution` defaulting to
`'pending'` — instead of the import silently overwriting the user's edit. The
comment above the table says exactly that.

### Sources and bindings

`sources` is one row per adapter, describing what that source can and cannot
tell us. The honesty-critical columns are the capability declarations:
`observation_granularity` (`port` / `station_aggregate` / `charger_subgroup`),
`identity_reliability` (`durable` / `unstable` / `none`),
`distinguishes_charging` (whether the source separates "actively charging" from
merely "occupied"), `state_meanings_json`, and `source_freshness_limit_ms`.
These are what stop a station-aggregate source from being read as per-port data
and stop an occupied count from being described as charging.

Eligibility is separate from verification and both default to the cautious
value: `eligibility_state` defaults to `'needs_review'` and
`verification_state` to `'unverified'`. The comment above them states the rule
they encode: *visible public content alone is never recorded as affirmative
permission.* `terms_urls_json`, `terms_reviewed_at_ms`, `terms_review_scope`
and `eligibility_basis` exist so that enabling a source requires a recorded
reason, not a checkbox. `min_interval_ms` and `min_navigation_interval_ms` are
both `CHECK (>= 1000)`.

`source_bindings` binds one source to one site for one physical extent.
`scope_key` is the stable key for that extent, and it is the join key for
almost every time-series table in the schema — capacity, monitoring,
observations, gaps, episodes and metrics all key on `scope_key` rather than on
`site_id`, because a site can have several independently observed scopes.
`effective_from_ms` / `effective_to_ms` make bindings effective-dated, with a
table-level `CHECK (effective_to_ms IS NULL OR effective_to_ms >
effective_from_ms)`.

Two unique indexes do real work here. `ux_bindings_source_station` on
`(source_id, source_station_id, scope_key)` (partial, `WHERE source_station_id
IS NOT NULL`) prevents the same provider station being bound twice for one
scope. `ux_bindings_primary_scope` on `(scope_key, effective_from_ms)`
(partial, `WHERE is_primary = 1`) enforces at most one primary stream per
physical scope per start instant — the comment above it says two providers must
never both be primary for one scope and period, because that would double-count
the same physical bays.

Matching is recorded rather than assumed: `match_basis` (an enum from
`durable_provider_id` down to `coordinates_only`, `manual` and `none`),
`match_confidence` bounded to 0–1, and `match_disposition` defaulting to
`'proposed'` rather than `'confirmed'`. Proximity alone never auto-merges.

`binding_merge_history` is intended to record create / merge / split / rebind /
correct / reject actions with an `actor` of `'user'` or `'automatic'`.
**Nothing in `src/` inserts into this table.** The audit trail it would provide
does not currently exist.

### Capacity and ports

`capacity_history` is effective-dated installed capacity per scope:
`capacity_ports` (bounded 0–10000), `level`, and — importantly — `basis`, which
is one of `ports_simultaneous`, `connectors`, `reported_total` or `unknown`.
That column exists because a "number of chargers" figure can mean three
different things, and averaging across them would be meaningless.
`src/domain/intervals.ts` cuts observation intervals at capacity boundaries
(`capacityBoundaries()`), so a capacity change never retroactively rescales
earlier coverage. `ux_capacity_scope_from` on `(scope_key,
effective_from_ms)` keeps the history single-valued.

`ports` is per-port identity, and its comment states the constraint: ports
exist *only* where the source genuinely provides durable identity.
`ux_ports_scope_source` on `(scope_key, source_port_id)` is the identity.
`connectors` records plug types separately, with the comment "a connector is a
plug type; two plugs on one unit may not be two spaces" — which is the
`connectors` vs `ports_simultaneous` distinction again, at row level.

**Nothing in `src/` inserts into `ports` or `connectors`**, and that creates a
latent fault. `port_observations.port_id` references `ports(id)`, and
`CONNECTION_PRAGMAS` in `src/database/driver.ts` sets `foreign_keys = ON`. The
`port_observations` insert in `src/database/repositories.ts` uses a `port_id`
constructed in `CollectorService.envelope()` as
`` `${binding.scopeKey}:${port.sourcePortId}` ``, with no matching `ports` row.
Against the real schema this raises `FOREIGN KEY constraint failed`, which would
abort the whole `ingestRun` transaction. The path is unreachable today only
because the single shipped adapter declares `identityReliability: 'none'`, so
`envelope()` always emits `ports: []`. It would fire the first time a
durable-identity source was enabled, and no test covers it.

### Monitoring and gaps

This pair is the heart of the "missing data is not zero" guarantee.

`monitoring_intervals` records the periods during which a scope was
*intentionally* being monitored: `scope_key`, `binding_id`, `started_ms`,
`ended_ms` (nullable = still monitored) and `interval_ms`, the scheduled
interval in force. `interval_ms` is what bounds what can be claimed: it is
persisted alongside the window, so a period monitored at fifteen-minute
cadence cannot later be read as though it had been sampled every minute.
`ux_monitoring_scope_start` on `(scope_key, started_ms)` keeps windows
single-valued per start instant, and the repository's insert uses
`ON CONFLICT ... DO NOTHING` so a restart cannot fragment one window into two.

`collection_gaps` makes missing coverage a first-class row rather than an
absence to be interpolated — its comment says precisely that. `scope_key` is
nullable, and `NULL` means the gap applies to every scope (used for
application-wide interruptions like sleep or an update install). `reason` is a
closed enum: `not_enabled`, `user_paused`, `app_not_running`,
`computer_asleep`, `offline`, `source_paused`, `browser_failure`,
`update_install`, `migration`, `unclean_exit`. A table-level `CHECK (ended_ms >
started_ms)` makes a zero-length gap unrepresentable, and
`DatabaseWorker.recordGap` returns early rather than writing one.

The consumer is `buildScopeIntervals()` in `src/domain/intervals.ts`, which
computes monitored time as the monitoring union *minus* the gap union
(`monitoredMinusGaps`) and then clips every observation's carry-forward to the
containing monitored span. An observation that falls outside monitored time is
excluded with reason `outside_monitoring` rather than being stretched to cover
the hole. Gaps are never bridged.

Unclean exits are detected rather than guessed. `app_sessions` keeps a
heartbeat (`last_heartbeat_ms`, `state` in `running` / `stopped` / `crashed` /
`recovered`), and `recordRecoveryGaps()` in `src/database/worker.ts` turns each
session that never recorded an end into an `unclean_exit` gap spanning its last
heartbeat to now — but only `if (session.collectionRunning)`, because a crash
while paused left no coverage to lose.

### Runs, attempts and observations

`collection_runs` is one row per adapter cycle: `outcome` from a closed enum
that includes `in_progress` as well as every failure mode, plus
`bindings_attempted`, `bindings_succeeded`, `effective_interval_ms`,
`cycle_duration_ms` and `warnings_json`.

`collection_attempts` is the per-binding outcome, and its comment carries the
rule: *a failure lives here and never becomes a zero-usage observation.* Its
`outcome` enum is the same set minus `in_progress`. This is the table that
makes "we tried and could not read it" a recorded fact distinct from both "we
read it and nothing was in use" and "we never looked."

`observations` is the raw evidence table, and most of its columns exist for
honesty rather than for display.

**Unknown counts are stored separately from occupied.** The five count columns
are `available_count`, `occupied_count`, `reserved_count`,
`out_of_service_count` and `unknown_count`, each independently nullable and
each bounded 0–10000. `reported_total` is the provider's own total, stored
separately again. The comment above them is the whole rule: *NULL means the
source did not report the dimension; 0 means it reported 0.* There is no single
"status" column that would force a reading into one bucket.

**A residual is never assigned to occupied.** This is enforced in
`reconcileCounts()` in `src/domain/reconcile.ts`, whose header states the
central rule: knowing `available` and a scope `total` does **not** let us
compute `occupied = total - available`, because the remainder can be reserved,
out of service or genuinely unknown. A residual is computed only when the
source actually gave a total, and it is added to `unknown`, with
`hasResidualUnknown` set to flag that it happened:

```
const residual = total - explicitAllSum;
if (residual > 0) { unknown = explicitUnknown + residual; hasResidualUnknown = true; }
```

`knownStateCount` sums only the dimensions the source explicitly named and is
`null` when it named none — so it is never a zero that looks like full
knowledge. `supportsOccupancy` is true only when *both* `available` and
`occupied` were explicitly reported, and `computeScopeMetrics()` in
`src/domain/metrics.ts` admits an interval to the occupancy numerator and
denominator only under that flag. An "available only" source therefore reports
`observedOccupancyPct: null`, not an inferred percentage. A contradiction —
explicit states summing above the reported total — is rejected as
`explicit_exceeds_total` rather than reconciled by trimming a dimension.

**The freshness policy is persisted per observation.** Three columns carry the
policy that was in force at the moment of the reading:
`scheduled_interval_ms`, `max_carry_forward_cap_ms` and
`source_freshness_limit_ms`. The comment above them states why: *so a later
settings change cannot rewrite historical assumptions.* `carryForwardBudgetMs()`
in `src/domain/types.ts` derives the budget as the minimum of twice the
scheduled interval, the product cap, and the provider limit where one exists —
and it reads those values from the observation row, not from current settings.
Changing the collection interval today therefore cannot retroactively widen or
narrow how far a two-year-old reading is allowed to carry forward.

Provenance columns: `source_url`, `parser_version`, `evidence_fingerprint`,
`sanitized_source_text` (nullable), `method` and `granularity`. `completeness`
is `'complete'` or `'partial'`, so a reading that did not fully describe its
declared scope is marked rather than treated as a full census.
`distinguishes_charging` is copied onto each row from the source capability, so
a historical reading is interpretable even if the adapter's capabilities later
change. `source_updated_at_ms` is nullable, and that nullability is meaningful:
`classifySourceFreshness()` returns `'unknown_source_clock'` — not `'stale'` and
not `'fresh'` — when the page exposed no "as of" time, because not knowing the
sensor's vintage is a different fact from knowing it is old.

`port_observations` is the per-port series, `UNIQUE (observation_id, port_id)`,
with `state` from the five-value `PortState` enum in which `unknown` is a
first-class value. See the foreign-key caveat above.

### Quality

`observation_quality` is a one-row-per-observation sidecar (the observation id
is its primary key). `quality` is `reliable` / `provisional` / `stale_source` /
`ambiguous_scope` / `invalid`; `source_freshness` is `fresh` / `stale` /
`unknown_source_clock`. `buildScopeIntervals()` excludes `invalid` and
`ambiguous_scope` from metrics by default (`DEFAULT_EXCLUDED_QUALITIES`) and
excludes stale readings unless `includeStaleSourceReadings` is set — and in
every case the exclusion is *recorded* in the returned `excluded` array with a
reason, rather than the observation vanishing.

`corrected`, `superseded_by`, `correction_note` and `corrected_at_ms` let a
reading be superseded without deleting the original. The raw row stays;
the correction is an annotation.

### Inferred episodes

`inferred_episodes` is where "how many cars arrived" would live, and its shape
is an argument against overclaiming. There is no single start instant: the
start is bracketed by `start_lower_ms` and `start_upper_ms` and the end by
`end_lower_ms` and `end_upper_ms`, all nullable. `left_censored` and
`right_censored` mark episodes that were already running at the first sample or
still running at the last — neither is a completed session. `interrupted` marks
a continuity break, and `uncertain_short_flip` retains a brief state change
rather than debouncing it away. `supporting_observation_ids_json` keeps the
evidence, and `inference_version` (with `ux_episodes_identity` on `(scope_key,
source_port_id, start_upper_ms, inference_version)`) means changing the
inference produces a new row rather than mutating an old conclusion.

`src/domain/episodes.ts` keeps three outputs permanently distinct, and its
header is worth quoting in effect: "recorded charging sessions" come only from
an authorized transaction dataset with distinct session records, and *this
module does not synthesise them and there is no code path that can*; "detected
occupancy starts" are estimates from reliable per-port transitions with
censoring preserved; "observed increases in occupied ports" is an aggregate
count-change metric that is never described as arrivals.

**Nothing in `src/` inserts into `inferred_episodes`.** The inference is
computed and tested but never persisted.

### Metrics cache

`hourly_metrics` is a cache of time-weighted aggregates per `(scope_key,
local_date, local_hour)`, and its comment states its status: *never the sole
raw record; always recomputable.* It stores port-minutes rather than
percentages — `occupied_port_minutes`, `operational_port_minutes`,
`known_state_port_minutes`, `out_of_service_port_minutes` and a nullable
`expected_installed_port_minutes` — which is what allows correct aggregation
across sites. Averaging site-level percentages would weight a two-port site the
same as a twenty-port one; summing port-minutes and dividing at the end does
not. `expected_installed_port_minutes` is nullable because coverage against an
unknown denominator is reported as unknown, not as a number:
`expectedPortMinutes()` in `src/domain/intervals.ts` returns `null` if *any*
monitored moment lacks a known capacity.

`local_date`, `local_hour`, `local_weekday` and `timezone` are stored together
so attribution to a Phoenix-local hour is a stored fact rather than a
re-derivation that could drift with the machine's timezone.
`algorithm_version` participates in `ux_hourly_scope_hour`, so a metric
definition change creates new rows instead of quietly restating old ones, and
`stale` (with the partial index `ix_hourly_stale ... WHERE stale = 1`) marks
rows invalidated by late data.

**Nothing in `src/` inserts into `hourly_metrics`.**
`metricsCacheRepository` only ever runs `UPDATE hourly_metrics SET stale = 1`
and a stale count; metrics are computed live from `observations` on every read.
The invalidation call inside `ingestRun` is therefore currently invalidating an
empty table. This is not a correctness problem — an unpopulated cache is merely
unused — but the cache is not doing any work.

### Visits

`visit_datasets` and `visit_observations` hold externally supplied footfall
data, and the dataset table is almost entirely metadata whose purpose is to
prevent incomparable numbers being compared. `method` is `measured` /
`estimated_by_source` / `partial`; `count_definition` is `property_entries` /
`unique_visitors` / `transactions` / `vehicle_entries` / `other`;
`geographic_scope` is `whole_property` / `single_tenant` / `parking_area` /
`other`. `authoritative` defaults to 0. `src/domain/visits.ts` refuses
proration, refuses overlapping datasets and refuses mismatched definitions, and
zero visits yields an undefined ratio rather than zero or infinity.
`ux_visits_dataset_site_period` on `(dataset_id, site_id, period_start_ms,
period_end_ms)` prevents double-counting a period, and `CHECK (period_end_ms >
period_start_ms)` prevents a zero-length period.

### Imports

`imports` records every import attempt of any kind (`visits`, `sessions`,
`catalog`, `bindings`) with `row_count`, `accepted_count`, `rejected_count`,
`duplicate_handling` (defaulting to `'rejected'`), `validation_json`,
`rollback_id` and an `outcome` that includes `rolled_back`. An import's
rejections are as durable as its acceptances.

### Operational state

`source_health` is one row per source: `state` (`healthy` / `degraded` /
`paused` / `blocked` / `circuit_open` / `unverified`), `consecutive_failures`,
`backoff_until_ms`, `current_backoff_ms`, `retry_after_ms`,
`user_action_required`, and the `last_attempt_ms` / `last_success_ms` /
`last_navigation_ms` triple. Keeping attempt and success separate is what lets
the interface say "last successfully read 40 minutes ago" while also saying
"tried two minutes ago" — rather than conflating the two into a single
reassuring timestamp.

`schedule_queue` persists the scheduler so due times survive a restart:
`next_due_ms`, `interval_ms`, `consecutive_failures`, `backoff_ms`, `paused`,
indexed by `ix_queue_due` on `(paused, next_due_ms)`. Without it, every restart
would reset backoff and the app would hammer a source that had asked it to wait.

`app_sessions` is the heartbeat described under *Monitoring and gaps*.
`backups` records each backup with `file_sha256`, `byte_size`, `verified` and a
`manifest_json`. `app_settings` is a key/value store of JSON values with an
`updated_at_ms`.

`update_events` is an append-only audit log over a closed enum of 19 event
names, from `check_started` through `manifest_rejected` and
`artifact_rejected` to `installed` and `rolled_forward`; the comment notes it
never stores credentials or keys. `update_state` is a single-row table
(`CHECK (id = 1)`) holding `installed_version`, `last_healthy_version`,
`pending_version`, `pending_verified`, `migration_state`, and
`highest_accepted_sequence` — the last of which is what makes a replayed or
equal release sequence rejectable rather than installable.

## Idempotency

The index that matters is:

```sql
CREATE UNIQUE INDEX ux_observations_run_binding_scope
  ON observations (run_id, binding_id, scope_key);
```

Its comment states both halves of the requirement: *idempotent ingestion —
retrying the same attempt cannot double-write, while a repeated identical
status at a NEW scheduled time is still a new observation.*

The key is `(run_id, binding_id, scope_key)`, and `run_id` is freshly generated
per cycle by `randomUUID()` in `CollectorService.collectFromSource`. So:

- **Retrying one attempt is safe.** If `ingestRun` is delivered twice for the
  same run — a worker restart mid-acknowledgement, a duplicated notification —
  the second insert hits the index and the repository's
  `ON CONFLICT (run_id, binding_id, scope_key) DO NOTHING` discards it. The
  return value distinguishes `written` from `deduplicated`, so the caller is
  not told a write happened when it did not.
- **A genuinely new reading at a new scheduled time is kept.** The next cycle
  has a different `run_id`, so an identical set of counts fifteen minutes later
  inserts normally. This is deliberate and load-bearing: four identical
  observations are four pieces of evidence that the state did not change, and
  discarding three of them would make coverage look worse than it was. The
  `evidence_fingerprint` exists for provenance and diagnostics and is
  explicitly *not* used for deduplication — the comment on `fingerprint()` in
  `src/collector/service.ts` says so.

The same pattern is applied at every level of the run so the whole thing is
replayable: `collection_runs` uses `ON CONFLICT (id) DO UPDATE` to refresh
`finished_ms`, `outcome` and `bindings_succeeded`; `collection_attempts` uses
`ON CONFLICT (run_id, binding_id, scope_key) DO UPDATE` via
`ux_attempts_run_binding`; and `observation_quality` and `port_observations`
use `DO NOTHING` on their own unique keys. All of it runs inside a single
`transact()`, together with cache invalidation, so a reader can never observe
new raw data beside stale aggregates.

`ingestRun` also throws if `restoreOrMigrationActive` is set, so collection
cannot write into a database that is being migrated or replaced.

## Why `STRICT`, the CHECK constraints, and the instant range check

Every table is declared `STRICT`. Without it, SQLite's dynamic typing will
accept the string `'12'` into an INTEGER column and the string `'unknown'` into
a numeric count. In a schema whose entire premise is that `NULL`, `0` and a
real measurement are three different things, a silently coerced value is worse
than an error: it survives, it aggregates, and it is indistinguishable from
data later. `STRICT` turns that class of bug into an immediate failure at the
write.

The CHECK constraints do three jobs. They pin every enum to a closed
vocabulary at the storage layer, so an adapter cannot introduce a sixth port
state that the metric code has no branch for. They reject impossible counts —
every count column is `>= 0` and `<= 10000`, so a negative occupancy and an
absurd port count both fail rather than propagating into a percentage. And they
enforce interval sanity at table level: `effective_to_ms > effective_from_ms`
on bindings and capacity, `ended_ms > started_ms` on monitoring intervals and
gaps, `period_end_ms > period_start_ms` on visits, `finished_ms >= started_ms`
on runs.

The millisecond-instant range check is `BETWEEN 0 AND 4102444800000` (the upper
bound is 2100-01-01T00:00:00Z) and it appears on every instant column in the
schema. Its purpose is stated in the migration header: a seconds/milliseconds
mix-up fails at the boundary *instead of silently shifting history by five
decades*. A Unix timestamp in seconds — say `1_760_000_000` — is a perfectly
valid integer, and stored in a milliseconds column it places a 2025 reading in
1970. Nothing downstream would flag it; it would just quietly poison every
window query and coverage figure. The same bound is enforced at the IPC
boundary by `v.instant()` in `src/shared/validate.ts`, and in the domain layer
`FAR_FUTURE` in `src/domain/intervals.ts` uses the identical constant, so the
three layers agree.

## Migrations

Migrations are ordered, checksummed and transactional (`src/database/migrator.ts`).
The rules the module enforces:

- Each migration applies in its own transaction, so a failure leaves the
  database at the last successfully applied version with its data intact.
- Versions must be contiguous from 1; a gap is a `failed` outcome.
- Every applied migration's checksum is stored in `schema_migrations`
  (itself a `STRICT` table with the same instant range check). A changed
  historical migration is a hard error, not a silent re-apply.
- A database whose schema is newer than the build understands is **refused and
  left untouched**. Downgrading an executable is not a data rollback.
- After applying, `checkIntegrity()` runs, and a failure is reported as
  `failed`.

`checksumOf()` is SHA-256 over the SQL with `\r\n` normalised to `\n`, so a
line-ending change is not treated as a schema change.

Two outcomes refuse without touching the database, and both matter:

`checksum_mismatch` means migration *N* no longer matches the checksum recorded
when it was applied. The detail explicitly states "the database has not been
modified." This is a provenance failure: if the text of a historical migration
has changed, we no longer know what shape the existing data is actually in, and
re-running it or assuming it is equivalent could silently reinterpret stored
rows.

`refused_newer_schema` means the file was written by a newer build. The detail
tells the user to install the newer version. The alternative — letting an older
build open and write a newer schema — would either fail on unknown columns or,
worse, succeed while ignoring columns it does not know about, producing a
history that the newer build can no longer trust.

### Why migrations are embedded, not read from disk

The `.sql` files under `src/database/migrations/` are the canonical, reviewable
schema, but they are not what ships. `scripts/generate-migrations.mjs` embeds
them into `src/database/migrations/index.ts` as a generated module, and
`npm run check:migrations` fails the build if that module is stale.

The reason is stated in both the generator and the config: *embedding avoids
resolving file paths inside `app.asar` at runtime, which is a common packaging
failure.* Inside a packaged Electron app the migrations directory is not a
directory on disk — it is a region of an archive. `readdirSync` against it
either fails or returns nothing depending on how the path was resolved, and the
failure appears only in the packaged build, at first launch, on a user's
machine, at the exact moment the application is trying to create their
database. Embedding turns a runtime packaging failure into a build-time check.
It also means the checksums travel with the code that applies them.

## Readable versus writable schema bounds

`src/database/migrator.ts` exposes two different bounds:

```ts
export function canRead(schemaVersion: number): boolean  { return schemaVersion <= TARGET_SCHEMA_VERSION; }
export function canWrite(schemaVersion: number): boolean { return schemaVersion === TARGET_SCHEMA_VERSION; }
```

Reading is backward-compatible; writing is exact. An older file is migrated up
to the target before it is written to, so at steady state the live database is
always at exactly `TARGET_SCHEMA_VERSION`. The asymmetry shows up in two
places. `validateRestoreCandidate()` in `src/database/backup.ts` uses
`canRead()`, so a restore from an older backup is accepted (it will be migrated
on open) while a backup from a newer build is rejected as
`unsupported_future_schema` with the note that the existing database has not
been touched.

The relevance to updates is that the bound is part of what an update is
verified against. `src/main/index.ts` passes `writableDbSchema:
TARGET_SCHEMA_VERSION` into the `UpdateService` config, and
`verifyManifest()` checks the candidate release's declared schema range against
it. An update that would move the database to a schema this build could not
write is rejected at manifest verification — before anything is downloaded,
let alone installed. Combined with `refused_newer_schema` on the way in, the
result is that neither direction can strand a user with a history file their
installed executable cannot open: a too-new file refuses to be modified, and a
too-far-ahead update refuses to be installed.

## Backups and restore

The rule that shapes `src/database/backup.ts` is in its header: copying only
the main database file while WAL writes are active is **not** a valid backup.
The `-wal` sidecar holds committed transactions that have not yet been
checkpointed into the main file, so a plain file copy can produce a database
missing its most recent history — or an internally inconsistent one.

So every backup goes through SQLite's online backup API, and a driver that
cannot do it is **refused rather than falling back to a copy**:

```ts
if (!driver.supportsOnlineBackup || typeof driver.backupTo !== 'function') {
  throw new Error('This SQLite driver cannot perform an online backup. ...');
}
```

`SqliteDriver` in `src/database/driver.ts` declares `supportsOnlineBackup` and
an optional `backupTo`, and the `node:sqlite` driver used by the test suite
reports false — which is why the smoke run recorded in
`VERIFICATION_REPORT.md` shows `createBackupNow()` correctly refusing instead
of producing a bad backup.

**Verification happens before publication.** `createBackup()` writes to
`<name>.partial`, then opens that staged file, applies the connection pragmas,
runs `checkIntegrity()`, and compares both the observation count and the schema
version against the live database. Only if all three agree does it `rename()`
the file to its final name and insert the `backups` row with `verified = 1`. A
failure removes the partial file and throws, stating that the live database was
not touched. A backup that has not been proven readable is never presented to
the user as a backup.

**Restore stages, re-verifies, and preserves.** `performRestore()` runs in a
fixed order for a reason:

1. `validateRestoreCandidate()` on the source file — which the function's
   comment notes does not touch the live database at all. It checks size
   against an 8 GiB bound, optional SHA-256 against a manifest, that the file
   opens as a database, `PRAGMA integrity_check`, and `canRead()` on its
   schema.
2. Copy to `stagingDir`, then **validate the staged copy again**, not just the
   source — a copy can fail.
3. Only then `closeLiveDatabase()`.
4. Rename the live database to `<path>.replaced-<nowMs>` rather than deleting
   it, so a bad restore is recoverable.
5. Remove the `-wal` and `-shm` sidecars, which belong to the replaced database
   and must not survive the swap — a stale WAL against a different main file is
   a corruption.
6. Rename the staged copy into place. If that fails, the original is renamed
   back before the error is returned.

The preserved path is returned to the caller as `preservedPreviousPath` and
surfaced through the `restore.perform` response. At the main-process level,
`src/main/index.ts` pauses the collector before calling `performRestore` and
holds `maintenanceActive` for the duration, which also blocks an update
install. A pre-migration backup is taken before any migration, and its failure
aborts the migration rather than proceeding without one.

`isSafeArchiveEntryPath()` rejects absolute paths, drive letters and any `..`
segment, so an archive cannot write outside its extraction directory.

## Retention and deletion

Backup retention is in `BACKUP_RETENTION` (`src/domain/thresholds.ts`): seven
`daily` copies and the most recent three `pre_migration` copies.
`pruneBackups()` enforces exactly those two kinds and leaves every other kind
— `manual`, `pre_restore`, `pre_update` — until the user removes it, on the
grounds that those were created for a specific reason the user knows about. It
also sweeps orphaned `.partial` files from interrupted backups.
`pruneBackups()` runs at the end of a successful `open()`.

Observation retention defaults to keeping everything: `seedDefaultSettings()`
sets `'retention.keepForever': true`. There is no automatic expiry of history.

Deletion is explicit and user-initiated. The `data.deleteRange` operation
requires `confirmed: true` in its schema, so an unconfirmed request cannot
reach the handler. `deleteObservationsBefore()` runs
`DELETE FROM observations WHERE observed_at_ms < ?` inside a transaction and
then `invalidateAll()` on the metrics cache. Because `ON DELETE CASCADE` is
declared on `port_observations.observation_id` and
`observation_quality.observation_id`, the dependent rows go with it and no
orphans are left.

Note what deletion does *not* remove: `collection_gaps`,
`monitoring_intervals` and `collection_attempts` survive. That is the right
behaviour for this product — after deleting old observations, the record that
those periods *were* monitored and where coverage was missing remains intact,
so the remaining history is not silently reinterpreted as though the deleted
period had never been watched.

Uninstalling does not delete data: `deleteAppDataOnUninstall: false` in
`electron-builder.yml`, with a comment stating that removing data is a separate
explicit action, never a side effect of uninstalling.

## How to inspect a history file

Use `scripts/windows/db-probe.mjs`. It opens the database **read-only**
(`new DatabaseSync(resolved, { readOnly: true })`) and runs nothing but
`SELECT`s and pragmas, so it cannot modify, migrate or lock the file it is
pointed at. It uses Node's built-in `node:sqlite` (Node 22.5 or newer), so it
needs nothing installed — which is what makes it usable on a user's machine
while investigating a support report.

```
node scripts/windows/db-probe.mjs --file "C:\path\to\chargewatch.sqlite"
node scripts/windows/db-probe.mjs --file ... --expect-schema 1
node scripts/windows/db-probe.mjs --file ... --expect-min-observations 100
```

It prints a JSON fingerprint: byte size, `createdAtIso` and `modifiedAtIso`,
journal mode, schema version, the full `schema_migrations` list with the app
version that applied each one, the table list and count, row counts for the
tables that matter (settings, sites, sources, bindings, observations, port
observations, monitoring intervals, collection gaps, collection runs, visit
observations, backups, update events), the first and last observation instants,
`PRAGMA integrity_check`, and the foreign-key violation count.

`createdAtIso` is the field the update test relies on: it is preserved by an
in-place upgrade and changes if the file was recreated, which is how
`test-update.ps1` distinguishes "migrated" from "replaced". The probe exits 1
if `integrity_check` is not `ok`, if there are foreign-key violations, or if an
`--expect` assertion fails, so it works as a gate as well as a report.

For anything the probe does not cover, open the file read-only yourself rather
than letting the application migrate it — a migration is not reversible, and a
support copy is evidence.
