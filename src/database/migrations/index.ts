/**
 * GENERATED FILE — do not edit.
 *
 * Produced by scripts/generate-migrations.mjs from the .sql files in this
 * directory, which are the canonical schema. Run `npm run build` or
 * `node scripts/generate-migrations.mjs` after changing one.
 */

import type { Migration } from '../migrator.ts';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `-- ChargeWatch schema, migration 001.
--
-- Conventions enforced throughout:
--   * Every instant is an INTEGER of UTC milliseconds, range-checked so a
--     seconds/milliseconds mix-up fails at the boundary instead of silently
--     shifting history by five decades.
--   * Unknown is NULL or an explicit 'unknown' enum value. Zero is never
--     overloaded to mean "we do not know".
--   * Raw observations are append-only apart from explicit user deletion.
--   * Source identifiers are stored separately from local identifiers.

------------------------------------------------------------------------------
-- Settings
------------------------------------------------------------------------------

CREATE TABLE app_settings (
  key            TEXT    NOT NULL PRIMARY KEY,
  value_json     TEXT    NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  updated_at_ms  INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 4102444800000)
) STRICT;

------------------------------------------------------------------------------
-- Catalog provenance
------------------------------------------------------------------------------

CREATE TABLE catalog_imports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name         TEXT    NOT NULL,
  source_url          TEXT,
  retrieved_at_ms     INTEGER NOT NULL CHECK (retrieved_at_ms BETWEEN 0 AND 4102444800000),
  imported_at_ms      INTEGER NOT NULL CHECK (imported_at_ms BETWEEN 0 AND 4102444800000),
  license             TEXT    NOT NULL,
  attribution         TEXT    NOT NULL,
  file_sha256         TEXT    NOT NULL,
  field_mapping_json  TEXT    NOT NULL,
  bounds_center_lat   REAL    NOT NULL CHECK (bounds_center_lat BETWEEN -90 AND 90),
  bounds_center_lon   REAL    NOT NULL CHECK (bounds_center_lon BETWEEN -180 AND 180),
  bounds_radius_miles REAL    NOT NULL CHECK (bounds_radius_miles > 0),
  row_count           INTEGER NOT NULL CHECK (row_count >= 0),
  outcome             TEXT    NOT NULL CHECK (outcome IN ('succeeded','partial','failed')),
  notes               TEXT
) STRICT;

CREATE UNIQUE INDEX ux_catalog_imports_hash ON catalog_imports (source_name, file_sha256);

------------------------------------------------------------------------------
-- Sites
------------------------------------------------------------------------------

CREATE TABLE sites (
  id                    TEXT    NOT NULL PRIMARY KEY,
  catalog_import_id     INTEGER REFERENCES catalog_imports (id) ON DELETE SET NULL,
  registry_station_id   TEXT,
  name                  TEXT    NOT NULL,
  street_address        TEXT,
  city                  TEXT,
  state                 TEXT,
  postal_code           TEXT,
  normalized_address    TEXT,
  latitude              REAL    NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude             REAL    NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  distance_miles        REAL    CHECK (distance_miles IS NULL OR distance_miles >= 0),
  network               TEXT,
  access_condition      TEXT    NOT NULL DEFAULT 'unknown'
                                CHECK (access_condition IN ('public','restricted','private','unknown')),
  hours_text            TEXT,
  timezone              TEXT    NOT NULL DEFAULT 'America/Phoenix',
  catalog_port_count    INTEGER CHECK (catalog_port_count IS NULL OR catalog_port_count >= 0),
  catalog_level         TEXT    NOT NULL DEFAULT 'unknown'
                                CHECK (catalog_level IN ('level_1','level_2','dc_fast','mixed','unknown')),
  archived              INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  user_corrected        INTEGER NOT NULL DEFAULT 0 CHECK (user_corrected IN (0,1)),
  user_corrections_json TEXT,
  saved                 INTEGER NOT NULL DEFAULT 0 CHECK (saved IN (0,1)),
  created_at_ms         INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 4102444800000),
  updated_at_ms         INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 4102444800000)
) STRICT;

CREATE INDEX ix_sites_network ON sites (network);
CREATE INDEX ix_sites_level ON sites (catalog_level);
CREATE INDEX ix_sites_registry ON sites (registry_station_id);
CREATE INDEX ix_sites_location ON sites (latitude, longitude);

-- A catalog refresh proposes changes; conflicts against user corrections are
-- recorded rather than silently overwriting the user's edit.
CREATE TABLE site_conflicts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id           TEXT    NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  catalog_import_id INTEGER NOT NULL REFERENCES catalog_imports (id) ON DELETE CASCADE,
  field             TEXT    NOT NULL,
  existing_value    TEXT,
  incoming_value    TEXT,
  resolution        TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (resolution IN ('pending','kept_user','took_catalog')),
  detected_at_ms    INTEGER NOT NULL CHECK (detected_at_ms BETWEEN 0 AND 4102444800000)
) STRICT;

CREATE INDEX ix_site_conflicts_site ON site_conflicts (site_id, resolution);

------------------------------------------------------------------------------
-- Sources and bindings
------------------------------------------------------------------------------

CREATE TABLE sources (
  id                      TEXT    NOT NULL PRIMARY KEY,
  display_name            TEXT    NOT NULL,
  website_url             TEXT,
  adapter_version         TEXT    NOT NULL,
  capability_version      INTEGER NOT NULL CHECK (capability_version >= 1),
  supported_region        TEXT    NOT NULL,
  observation_granularity TEXT    NOT NULL
                                  CHECK (observation_granularity IN ('port','station_aggregate','charger_subgroup')),
  identity_reliability    TEXT    NOT NULL
                                  CHECK (identity_reliability IN ('durable','unstable','none')),
  access_requirements     TEXT    NOT NULL,
  collection_method       TEXT    NOT NULL
                                  CHECK (collection_method IN ('rendered_dom','local_ocr','manual','authorized_api')),
  min_interval_ms         INTEGER NOT NULL CHECK (min_interval_ms >= 1000),
  min_navigation_interval_ms INTEGER NOT NULL CHECK (min_navigation_interval_ms >= 1000),
  source_freshness_limit_ms  INTEGER CHECK (source_freshness_limit_ms IS NULL OR source_freshness_limit_ms > 0),
  distinguishes_charging   INTEGER NOT NULL DEFAULT 0 CHECK (distinguishes_charging IN (0,1)),
  state_meanings_json      TEXT    NOT NULL,
  terms_urls_json          TEXT    NOT NULL,
  terms_reviewed_at_ms     INTEGER CHECK (terms_reviewed_at_ms IS NULL OR terms_reviewed_at_ms BETWEEN 0 AND 4102444800000),
  terms_review_scope       TEXT,
  eligibility_basis        TEXT,
  -- Visible public content alone is never recorded as affirmative permission.
  eligibility_state        TEXT    NOT NULL DEFAULT 'needs_review'
                                   CHECK (eligibility_state IN ('enabled','disabled','needs_review')),
  verification_state       TEXT    NOT NULL DEFAULT 'unverified'
                                   CHECK (verification_state IN ('verified','unverified','blocked')),
  notes                    TEXT,
  updated_at_ms            INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 4102444800000)
) STRICT;

CREATE TABLE source_bindings (
  id                   TEXT    NOT NULL PRIMARY KEY,
  source_id            TEXT    NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  site_id              TEXT    NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  source_station_id    TEXT,
  canonical_url        TEXT    NOT NULL,
  -- Stable key for the physical extent this binding observes. Two providers
  -- must never both be primary for one scope and period.
  scope_key            TEXT    NOT NULL,
  physical_scope       TEXT    NOT NULL,
  granularity          TEXT    NOT NULL
                               CHECK (granularity IN ('port','station_aggregate','charger_subgroup')),
  identity_reliability TEXT    NOT NULL
                               CHECK (identity_reliability IN ('durable','unstable','none')),
  is_primary           INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0,1)),
  enabled              INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  capability_version   INTEGER NOT NULL CHECK (capability_version >= 1),
  match_basis          TEXT    NOT NULL DEFAULT 'none'
                               CHECK (match_basis IN ('durable_provider_id','address_and_network','coordinates_and_name','coordinates_only','manual','none')),
  match_confidence     REAL    CHECK (match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 1)),
  match_disposition    TEXT    NOT NULL DEFAULT 'proposed'
                               CHECK (match_disposition IN ('confirmed','proposed','rejected')),
  effective_from_ms    INTEGER NOT NULL CHECK (effective_from_ms BETWEEN 0 AND 4102444800000),
  effective_to_ms      INTEGER CHECK (effective_to_ms IS NULL OR effective_to_ms BETWEEN 0 AND 4102444800000),
  created_at_ms        INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 4102444800000),
  updated_at_ms        INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 4102444800000),
  CHECK (effective_to_ms IS NULL OR effective_to_ms > effective_from_ms)
) STRICT;

CREATE UNIQUE INDEX ux_bindings_source_station
  ON source_bindings (source_id, source_station_id, scope_key)
  WHERE source_station_id IS NOT NULL;
CREATE INDEX ix_bindings_site ON source_bindings (site_id, enabled);
CREATE INDEX ix_bindings_scope ON source_bindings (scope_key, effective_from_ms);
-- At most one primary stream per physical scope per start instant.
CREATE UNIQUE INDEX ux_bindings_primary_scope
  ON source_bindings (scope_key, effective_from_ms)
  WHERE is_primary = 1;

CREATE TABLE binding_merge_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  binding_id     TEXT    NOT NULL REFERENCES source_bindings (id) ON DELETE CASCADE,
  action         TEXT    NOT NULL CHECK (action IN ('created','merged','split','rebound','corrected','rejected')),
  previous_json  TEXT,
  next_json      TEXT,
  actor          TEXT    NOT NULL CHECK (actor IN ('user','automatic')),
  reason         TEXT,
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms BETWEEN 0 AND 4102444800000)
) STRICT;

------------------------------------------------------------------------------
-- Capacity, ports and connectors
------------------------------------------------------------------------------

CREATE TABLE capacity_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key         TEXT    NOT NULL,
  site_id           TEXT    NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  effective_from_ms INTEGER NOT NULL CHECK (effective_from_ms BETWEEN 0 AND 4102444800000),
  effective_to_ms   INTEGER CHECK (effective_to_ms IS NULL OR effective_to_ms BETWEEN 0 AND 4102444800000),
  capacity_ports    INTEGER NOT NULL CHECK (capacity_ports >= 0 AND capacity_ports <= 10000),
  level             TEXT    NOT NULL CHECK (level IN ('level_1','level_2','dc_fast','mixed','unknown')),
  basis             TEXT    NOT NULL CHECK (basis IN ('ports_simultaneous','connectors','reported_total','unknown')),
  reported_power_kw REAL    CHECK (reported_power_kw IS NULL OR reported_power_kw > 0),
  source            TEXT    NOT NULL CHECK (source IN ('catalog','source_observation','user')),
  recorded_at_ms    INTEGER NOT NULL CHECK (recorded_at_ms BETWEEN 0 AND 4102444800000),
  CHECK (effective_to_ms IS NULL OR effective_to_ms > effective_from_ms)
) STRICT;

CREATE UNIQUE INDEX ux_capacity_scope_from ON capacity_history (scope_key, effective_from_ms);
CREATE INDEX ix_capacity_scope_range ON capacity_history (scope_key, effective_from_ms, effective_to_ms);

-- Ports exist only where the source genuinely provides durable identity.
CREATE TABLE ports (
  id              TEXT    NOT NULL PRIMARY KEY,
  scope_key       TEXT    NOT NULL,
  site_id         TEXT    NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  source_port_id  TEXT    NOT NULL,
  level           TEXT    NOT NULL CHECK (level IN ('level_1','level_2','dc_fast','mixed','unknown')),
  reported_power_kw REAL  CHECK (reported_power_kw IS NULL OR reported_power_kw > 0),
  first_seen_ms   INTEGER NOT NULL CHECK (first_seen_ms BETWEEN 0 AND 4102444800000),
  last_seen_ms    INTEGER NOT NULL CHECK (last_seen_ms BETWEEN 0 AND 4102444800000),
  retired         INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0,1))
) STRICT;

CREATE UNIQUE INDEX ux_ports_scope_source ON ports (scope_key, source_port_id);

-- A connector is a plug type. Two plugs on one unit may not be two spaces.
CREATE TABLE connectors (
  id             TEXT    NOT NULL PRIMARY KEY,
  port_id        TEXT    REFERENCES ports (id) ON DELETE CASCADE,
  site_id        TEXT    NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  connector_type TEXT    NOT NULL,
  reported_power_kw REAL CHECK (reported_power_kw IS NULL OR reported_power_kw > 0),
  count          INTEGER NOT NULL DEFAULT 1 CHECK (count >= 0),
  source         TEXT    NOT NULL CHECK (source IN ('catalog','source_observation','user'))
) STRICT;

CREATE INDEX ix_connectors_site ON connectors (site_id);

------------------------------------------------------------------------------
-- Monitoring windows and recorded gaps
------------------------------------------------------------------------------

CREATE TABLE monitoring_intervals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key    TEXT    NOT NULL,
  binding_id   TEXT    NOT NULL REFERENCES source_bindings (id) ON DELETE CASCADE,
  started_ms   INTEGER NOT NULL CHECK (started_ms BETWEEN 0 AND 4102444800000),
  ended_ms     INTEGER CHECK (ended_ms IS NULL OR ended_ms BETWEEN 0 AND 4102444800000),
  interval_ms  INTEGER NOT NULL CHECK (interval_ms >= 1000),
  CHECK (ended_ms IS NULL OR ended_ms > started_ms)
) STRICT;

CREATE UNIQUE INDEX ux_monitoring_scope_start ON monitoring_intervals (scope_key, started_ms);
CREATE INDEX ix_monitoring_scope ON monitoring_intervals (scope_key, started_ms, ended_ms);

-- Missing coverage is a first-class record, not an absence to be interpolated.
CREATE TABLE collection_gaps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key  TEXT,
  started_ms INTEGER NOT NULL CHECK (started_ms BETWEEN 0 AND 4102444800000),
  ended_ms   INTEGER NOT NULL CHECK (ended_ms BETWEEN 0 AND 4102444800000),
  reason     TEXT    NOT NULL CHECK (reason IN (
               'not_enabled','user_paused','app_not_running','computer_asleep','offline',
               'source_paused','browser_failure','update_install','migration','unclean_exit')),
  detail     TEXT,
  CHECK (ended_ms > started_ms)
) STRICT;

CREATE INDEX ix_gaps_scope_time ON collection_gaps (scope_key, started_ms, ended_ms);

------------------------------------------------------------------------------
-- Collection attempts and observations
------------------------------------------------------------------------------

CREATE TABLE collection_runs (
  id                 TEXT    NOT NULL PRIMARY KEY,
  source_id          TEXT    NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  adapter_version    TEXT    NOT NULL,
  started_ms         INTEGER NOT NULL CHECK (started_ms BETWEEN 0 AND 4102444800000),
  finished_ms        INTEGER CHECK (finished_ms IS NULL OR finished_ms BETWEEN 0 AND 4102444800000),
  outcome            TEXT    NOT NULL CHECK (outcome IN (
                       'succeeded','partial','timeout','offline','login_required','source_blocked',
                       'rate_limited','layout_changed','invalid_data','cancelled','in_progress')),
  error_class        TEXT,
  error_detail       TEXT,
  bindings_attempted INTEGER NOT NULL DEFAULT 0 CHECK (bindings_attempted >= 0),
  bindings_succeeded INTEGER NOT NULL DEFAULT 0 CHECK (bindings_succeeded >= 0),
  effective_interval_ms INTEGER CHECK (effective_interval_ms IS NULL OR effective_interval_ms >= 0),
  cycle_duration_ms  INTEGER CHECK (cycle_duration_ms IS NULL OR cycle_duration_ms >= 0),
  warnings_json      TEXT,
  CHECK (finished_ms IS NULL OR finished_ms >= started_ms)
) STRICT;

CREATE INDEX ix_runs_source_time ON collection_runs (source_id, started_ms);
CREATE INDEX ix_runs_outcome ON collection_runs (outcome, started_ms);

-- Per-binding outcome of an attempt. A failure lives here and never becomes a
-- zero-usage observation.
CREATE TABLE collection_attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT    NOT NULL REFERENCES collection_runs (id) ON DELETE CASCADE,
  binding_id    TEXT    NOT NULL REFERENCES source_bindings (id) ON DELETE CASCADE,
  scope_key     TEXT    NOT NULL,
  started_ms    INTEGER NOT NULL CHECK (started_ms BETWEEN 0 AND 4102444800000),
  finished_ms   INTEGER CHECK (finished_ms IS NULL OR finished_ms BETWEEN 0 AND 4102444800000),
  outcome       TEXT    NOT NULL CHECK (outcome IN (
                  'succeeded','partial','timeout','offline','login_required','source_blocked',
                  'rate_limited','layout_changed','invalid_data','cancelled')),
  error_detail  TEXT,
  navigation_count INTEGER NOT NULL DEFAULT 0 CHECK (navigation_count >= 0)
) STRICT;

CREATE UNIQUE INDEX ux_attempts_run_binding ON collection_attempts (run_id, binding_id, scope_key);
CREATE INDEX ix_attempts_binding_time ON collection_attempts (binding_id, started_ms);

CREATE TABLE observations (
  id                       TEXT    NOT NULL PRIMARY KEY,
  run_id                   TEXT    NOT NULL REFERENCES collection_runs (id) ON DELETE CASCADE,
  binding_id               TEXT    NOT NULL REFERENCES source_bindings (id) ON DELETE CASCADE,
  site_id                  TEXT    NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  scope_key                TEXT    NOT NULL,
  observed_at_ms           INTEGER NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 4102444800000),
  source_updated_at_ms     INTEGER CHECK (source_updated_at_ms IS NULL OR source_updated_at_ms BETWEEN 0 AND 4102444800000),
  method                   TEXT    NOT NULL CHECK (method IN ('rendered_dom','local_ocr','manual','authorized_api')),
  granularity              TEXT    NOT NULL CHECK (granularity IN ('port','station_aggregate','charger_subgroup')),
  -- NULL means the source did not report the dimension. 0 means it reported 0.
  available_count          INTEGER CHECK (available_count IS NULL OR (available_count >= 0 AND available_count <= 10000)),
  occupied_count           INTEGER CHECK (occupied_count IS NULL OR (occupied_count >= 0 AND occupied_count <= 10000)),
  reserved_count           INTEGER CHECK (reserved_count IS NULL OR (reserved_count >= 0 AND reserved_count <= 10000)),
  out_of_service_count     INTEGER CHECK (out_of_service_count IS NULL OR (out_of_service_count >= 0 AND out_of_service_count <= 10000)),
  unknown_count            INTEGER CHECK (unknown_count IS NULL OR (unknown_count >= 0 AND unknown_count <= 10000)),
  reported_total           INTEGER CHECK (reported_total IS NULL OR (reported_total >= 0 AND reported_total <= 10000)),
  capacity_basis           TEXT    NOT NULL CHECK (capacity_basis IN ('ports_simultaneous','connectors','reported_total','unknown')),
  completeness             TEXT    NOT NULL CHECK (completeness IN ('complete','partial')),
  level                    TEXT    NOT NULL CHECK (level IN ('level_1','level_2','dc_fast','mixed','unknown')),
  distinguishes_charging   INTEGER NOT NULL DEFAULT 0 CHECK (distinguishes_charging IN (0,1)),
  -- The freshness policy in force when this row was written, so a later
  -- settings change cannot rewrite historical assumptions.
  scheduled_interval_ms    INTEGER NOT NULL CHECK (scheduled_interval_ms >= 1000),
  max_carry_forward_cap_ms INTEGER NOT NULL CHECK (max_carry_forward_cap_ms >= 0),
  source_freshness_limit_ms INTEGER CHECK (source_freshness_limit_ms IS NULL OR source_freshness_limit_ms > 0),
  source_url               TEXT    NOT NULL,
  parser_version           TEXT    NOT NULL,
  evidence_fingerprint     TEXT    NOT NULL,
  sanitized_source_text    TEXT,
  created_at_ms            INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 4102444800000)
) STRICT;

-- Idempotent ingestion: retrying the same attempt cannot double-write, while a
-- repeated identical status at a NEW scheduled time is still a new observation.
CREATE UNIQUE INDEX ux_observations_run_binding_scope
  ON observations (run_id, binding_id, scope_key);
CREATE INDEX ix_observations_binding_time ON observations (binding_id, observed_at_ms);
CREATE INDEX ix_observations_site_time ON observations (site_id, observed_at_ms);
CREATE INDEX ix_observations_scope_time ON observations (scope_key, observed_at_ms);

CREATE TABLE port_observations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id TEXT    NOT NULL REFERENCES observations (id) ON DELETE CASCADE,
  port_id        TEXT    NOT NULL REFERENCES ports (id) ON DELETE CASCADE,
  scope_key      TEXT    NOT NULL,
  source_port_id TEXT    NOT NULL,
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 4102444800000),
  state          TEXT    NOT NULL CHECK (state IN ('available','occupied','reserved','out_of_service','unknown')),
  level          TEXT    NOT NULL CHECK (level IN ('level_1','level_2','dc_fast','mixed','unknown'))
) STRICT;

CREATE UNIQUE INDEX ux_port_observations_obs_port ON port_observations (observation_id, port_id);
CREATE INDEX ix_port_observations_port_time ON port_observations (port_id, observed_at_ms);

CREATE TABLE observation_quality (
  observation_id      TEXT    NOT NULL PRIMARY KEY REFERENCES observations (id) ON DELETE CASCADE,
  quality             TEXT    NOT NULL CHECK (quality IN ('reliable','provisional','stale_source','ambiguous_scope','invalid')),
  source_freshness    TEXT    NOT NULL CHECK (source_freshness IN ('fresh','stale','unknown_source_clock')),
  validation_json     TEXT,
  ambiguous           INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous IN (0,1)),
  corrected           INTEGER NOT NULL DEFAULT 0 CHECK (corrected IN (0,1)),
  superseded_by       TEXT    REFERENCES observations (id) ON DELETE SET NULL,
  correction_note     TEXT,
  corrected_at_ms     INTEGER CHECK (corrected_at_ms IS NULL OR corrected_at_ms BETWEEN 0 AND 4102444800000)
) STRICT;

CREATE INDEX ix_quality_quality ON observation_quality (quality);

------------------------------------------------------------------------------
-- Derived data
------------------------------------------------------------------------------

CREATE TABLE inferred_episodes (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key           TEXT    NOT NULL,
  port_id             TEXT    REFERENCES ports (id) ON DELETE CASCADE,
  source_port_id      TEXT    NOT NULL,
  start_lower_ms      INTEGER CHECK (start_lower_ms IS NULL OR start_lower_ms BETWEEN 0 AND 4102444800000),
  start_upper_ms      INTEGER CHECK (start_upper_ms IS NULL OR start_upper_ms BETWEEN 0 AND 4102444800000),
  end_lower_ms        INTEGER CHECK (end_lower_ms IS NULL OR end_lower_ms BETWEEN 0 AND 4102444800000),
  end_upper_ms        INTEGER CHECK (end_upper_ms IS NULL OR end_upper_ms BETWEEN 0 AND 4102444800000),
  left_censored       INTEGER NOT NULL CHECK (left_censored IN (0,1)),
  right_censored      INTEGER NOT NULL CHECK (right_censored IN (0,1)),
  interrupted         INTEGER NOT NULL CHECK (interrupted IN (0,1)),
  uncertain_short_flip INTEGER NOT NULL DEFAULT 0 CHECK (uncertain_short_flip IN (0,1)),
  supporting_observation_ids_json TEXT NOT NULL,
  inference_version   INTEGER NOT NULL CHECK (inference_version >= 1),
  computed_at_ms      INTEGER NOT NULL CHECK (computed_at_ms BETWEEN 0 AND 4102444800000)
) STRICT;

CREATE INDEX ix_episodes_scope ON inferred_episodes (scope_key, start_upper_ms);
CREATE UNIQUE INDEX ux_episodes_identity
  ON inferred_episodes (scope_key, source_port_id, start_upper_ms, inference_version);

-- Cacheable aggregates. Never the sole raw record; always recomputable.
CREATE TABLE hourly_metrics (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key                   TEXT    NOT NULL,
  site_id                     TEXT    NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  local_date                  TEXT    NOT NULL,
  local_hour                  INTEGER NOT NULL CHECK (local_hour BETWEEN 0 AND 23),
  local_weekday               INTEGER NOT NULL CHECK (local_weekday BETWEEN 0 AND 6),
  timezone                    TEXT    NOT NULL,
  occupied_port_minutes       REAL    NOT NULL CHECK (occupied_port_minutes >= 0),
  operational_port_minutes    REAL    NOT NULL CHECK (operational_port_minutes >= 0),
  known_state_port_minutes    REAL    NOT NULL CHECK (known_state_port_minutes >= 0),
  out_of_service_port_minutes REAL    NOT NULL DEFAULT 0 CHECK (out_of_service_port_minutes >= 0),
  expected_installed_port_minutes REAL CHECK (expected_installed_port_minutes IS NULL OR expected_installed_port_minutes >= 0),
  observation_count           INTEGER NOT NULL CHECK (observation_count >= 0),
  algorithm_version           INTEGER NOT NULL CHECK (algorithm_version >= 1),
  computed_at_ms              INTEGER NOT NULL CHECK (computed_at_ms BETWEEN 0 AND 4102444800000),
  stale                       INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0,1))
) STRICT;

CREATE UNIQUE INDEX ux_hourly_scope_hour
  ON hourly_metrics (scope_key, local_date, local_hour, algorithm_version);
CREATE INDEX ix_hourly_site_date ON hourly_metrics (site_id, local_date);
CREATE INDEX ix_hourly_stale ON hourly_metrics (stale) WHERE stale = 1;

------------------------------------------------------------------------------
-- Visit datasets
------------------------------------------------------------------------------

CREATE TABLE visit_datasets (
  id               TEXT    NOT NULL PRIMARY KEY,
  name             TEXT    NOT NULL,
  source_name      TEXT    NOT NULL,
  source_reference TEXT,
  revision         TEXT,
  file_sha256      TEXT,
  imported_at_ms   INTEGER NOT NULL CHECK (imported_at_ms BETWEEN 0 AND 4102444800000),
  method           TEXT    NOT NULL CHECK (method IN ('measured','estimated_by_source','partial')),
  count_definition TEXT    NOT NULL CHECK (count_definition IN ('property_entries','unique_visitors','transactions','vehicle_entries','other')),
  geographic_scope TEXT    NOT NULL CHECK (geographic_scope IN ('whole_property','single_tenant','parking_area','other')),
  authoritative    INTEGER NOT NULL DEFAULT 0 CHECK (authoritative IN (0,1)),
  notes            TEXT
) STRICT;

CREATE TABLE visit_observations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id     TEXT    NOT NULL REFERENCES visit_datasets (id) ON DELETE CASCADE,
  site_id        TEXT    NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  period_start_ms INTEGER NOT NULL CHECK (period_start_ms BETWEEN 0 AND 4102444800000),
  period_end_ms   INTEGER NOT NULL CHECK (period_end_ms BETWEEN 0 AND 4102444800000),
  timezone       TEXT    NOT NULL,
  visit_count    INTEGER NOT NULL CHECK (visit_count >= 0),
  notes          TEXT,
  CHECK (period_end_ms > period_start_ms)
) STRICT;

CREATE UNIQUE INDEX ux_visits_dataset_site_period
  ON visit_observations (dataset_id, site_id, period_start_ms, period_end_ms);
CREATE INDEX ix_visits_site_period ON visit_observations (site_id, period_start_ms, period_end_ms);

------------------------------------------------------------------------------
-- Imports, health, maintenance
------------------------------------------------------------------------------

CREATE TABLE imports (
  id                 TEXT    NOT NULL PRIMARY KEY,
  kind               TEXT    NOT NULL CHECK (kind IN ('visits','sessions','catalog','bindings')),
  file_name          TEXT,
  file_sha256        TEXT,
  row_count          INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  accepted_count     INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  rejected_count     INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  duplicate_handling TEXT    NOT NULL DEFAULT 'rejected' CHECK (duplicate_handling IN ('rejected','skipped','replaced')),
  validation_json    TEXT,
  rollback_id        TEXT,
  outcome            TEXT    NOT NULL CHECK (outcome IN ('succeeded','partial','failed','rolled_back')),
  imported_at_ms     INTEGER NOT NULL CHECK (imported_at_ms BETWEEN 0 AND 4102444800000)
) STRICT;

CREATE TABLE source_health (
  source_id             TEXT    NOT NULL PRIMARY KEY REFERENCES sources (id) ON DELETE CASCADE,
  state                 TEXT    NOT NULL CHECK (state IN ('healthy','degraded','paused','blocked','circuit_open','unverified')),
  detail                TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  backoff_until_ms      INTEGER CHECK (backoff_until_ms IS NULL OR backoff_until_ms BETWEEN 0 AND 4102444800000),
  current_backoff_ms    INTEGER NOT NULL DEFAULT 0 CHECK (current_backoff_ms >= 0),
  last_attempt_ms       INTEGER CHECK (last_attempt_ms IS NULL OR last_attempt_ms BETWEEN 0 AND 4102444800000),
  last_success_ms       INTEGER CHECK (last_success_ms IS NULL OR last_success_ms BETWEEN 0 AND 4102444800000),
  last_navigation_ms    INTEGER CHECK (last_navigation_ms IS NULL OR last_navigation_ms BETWEEN 0 AND 4102444800000),
  retry_after_ms        INTEGER CHECK (retry_after_ms IS NULL OR retry_after_ms >= 0),
  user_action_required  TEXT,
  updated_at_ms         INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 4102444800000)
) STRICT;

-- Persistent scheduler queue so due times survive restart.
CREATE TABLE schedule_queue (
  binding_id       TEXT    NOT NULL PRIMARY KEY REFERENCES source_bindings (id) ON DELETE CASCADE,
  source_id        TEXT    NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  next_due_ms      INTEGER NOT NULL CHECK (next_due_ms BETWEEN 0 AND 4102444800000),
  interval_ms      INTEGER NOT NULL CHECK (interval_ms >= 1000),
  last_attempt_ms  INTEGER CHECK (last_attempt_ms IS NULL OR last_attempt_ms BETWEEN 0 AND 4102444800000),
  last_success_ms  INTEGER CHECK (last_success_ms IS NULL OR last_success_ms BETWEEN 0 AND 4102444800000),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  backoff_ms       INTEGER NOT NULL DEFAULT 0 CHECK (backoff_ms >= 0),
  paused           INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1))
) STRICT;

CREATE INDEX ix_queue_due ON schedule_queue (paused, next_due_ms);

-- Heartbeat: an unclean exit is identifiable because the row stays 'running'.
CREATE TABLE app_sessions (
  id                TEXT    NOT NULL PRIMARY KEY,
  app_version       TEXT    NOT NULL,
  schema_version    INTEGER NOT NULL,
  started_ms        INTEGER NOT NULL CHECK (started_ms BETWEEN 0 AND 4102444800000),
  last_heartbeat_ms INTEGER NOT NULL CHECK (last_heartbeat_ms BETWEEN 0 AND 4102444800000),
  ended_ms          INTEGER CHECK (ended_ms IS NULL OR ended_ms BETWEEN 0 AND 4102444800000),
  state             TEXT    NOT NULL CHECK (state IN ('running','stopped','crashed','recovered')),
  collection_running INTEGER NOT NULL DEFAULT 0 CHECK (collection_running IN (0,1)),
  user_paused       INTEGER NOT NULL DEFAULT 0 CHECK (user_paused IN (0,1))
) STRICT;

CREATE INDEX ix_sessions_state ON app_sessions (state, started_ms);

CREATE TABLE backups (
  id               TEXT    NOT NULL PRIMARY KEY,
  kind             TEXT    NOT NULL CHECK (kind IN ('daily','pre_migration','pre_restore','manual','pre_update')),
  file_path        TEXT    NOT NULL,
  file_sha256      TEXT    NOT NULL,
  byte_size        INTEGER NOT NULL CHECK (byte_size >= 0),
  app_version      TEXT    NOT NULL,
  schema_version   INTEGER NOT NULL,
  created_at_ms    INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 4102444800000),
  verified         INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  manifest_json    TEXT    NOT NULL
) STRICT;

CREATE INDEX ix_backups_kind_time ON backups (kind, created_at_ms);

-- Update bookkeeping. Never stores credentials or keys.
CREATE TABLE update_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event           TEXT    NOT NULL CHECK (event IN (
                    'check_started','check_failed','up_to_date','candidate_found','manifest_verified',
                    'manifest_rejected','download_started','download_progress','download_failed',
                    'artifact_verified','artifact_rejected','ready','install_deferred','install_started',
                    'install_failed','installed','migration_pending','migration_failed','rolled_forward')),
  from_version    TEXT,
  to_version      TEXT,
  release_sequence INTEGER CHECK (release_sequence IS NULL OR release_sequence >= 0),
  detail          TEXT,
  occurred_at_ms  INTEGER NOT NULL CHECK (occurred_at_ms BETWEEN 0 AND 4102444800000)
) STRICT;

CREATE INDEX ix_update_events_time ON update_events (occurred_at_ms);

-- Highest accepted release sequence, to reject replayed downgrades.
CREATE TABLE update_state (
  id                      INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  installed_version       TEXT    NOT NULL,
  last_healthy_version    TEXT,
  highest_accepted_sequence INTEGER NOT NULL DEFAULT 0 CHECK (highest_accepted_sequence >= 0),
  pending_version         TEXT,
  pending_artifact_path   TEXT,
  pending_verified        INTEGER NOT NULL DEFAULT 0 CHECK (pending_verified IN (0,1)),
  failed_attempts         INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  migration_state         TEXT    NOT NULL DEFAULT 'idle'
                                  CHECK (migration_state IN ('idle','pending','failed','completed')),
  updated_at_ms           INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 4102444800000)
) STRICT;
`,
  },
];

export const NEWEST_MIGRATION_VERSION = 1;
