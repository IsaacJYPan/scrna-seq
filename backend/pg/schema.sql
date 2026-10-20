-- ============================================================================
-- Postgres schema for the scRNA-seq Workbench runtime.
--
-- This preserves the app's server-owned identity, role/scope columns, job
-- state-machine columns, worker coordination columns, artifact immutability
-- semantics, provenance/figure/cache tables, and lineage DAG model.
--
-- Notes:
--   * users.id uses GENERATED ALWAYS AS IDENTITY.
--   * timestamps are TIMESTAMPTZ DEFAULT now().
--   * Existing JSON payloads use TEXT. Workflow definitions and state use JSONB.
--   * one-result-checkpoint-per-job immutability is enforced by a PARTIAL UNIQUE
--     INDEX.
--
-- Applied idempotently by scripts/init-postgres.js (CREATE TABLE IF NOT EXISTS /
-- CREATE INDEX IF NOT EXISTS). Server-generated ids (org_/proj_/ds_/ao_/job_/
-- art_/aoe_...) are chosen by the application, never by the client.
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_schema_contract (
  schema_key     TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  applied_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app_schema_contract (schema_key, schema_version, applied_at)
VALUES ('traceomics.runtime', 20261020, now())
ON CONFLICT (schema_key) DO UPDATE SET
  schema_version = EXCLUDED.schema_version,
  applied_at = EXCLUDED.applied_at;

CREATE TABLE IF NOT EXISTS users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  session_version BIGINT NOT NULL DEFAULT 1,
  is_demo_guest BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo_guest BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_demo_expiry
  ON users(expires_at) WHERE is_demo_guest = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Append-only operator actions that do not have an authenticated browser actor.
-- Account and platform-capability CLIs write here in the same transaction as
-- their mutation. There is intentionally no public mutation or read endpoint.
CREATE TABLE IF NOT EXISTS operator_audit_events (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type     TEXT NOT NULL,
  target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  target_email   TEXT NOT NULL,
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_operator_audit_created ON operator_audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_operator_audit_target ON operator_audit_events(target_user_id);

CREATE OR REPLACE FUNCTION reject_operator_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operator audit events are append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS trg_operator_audit_no_update ON operator_audit_events;
CREATE TRIGGER trg_operator_audit_no_update
  BEFORE UPDATE ON operator_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_operator_audit_mutation();
DROP TRIGGER IF EXISTS trg_operator_audit_no_delete ON operator_audit_events;
CREATE TRIGGER trg_operator_audit_no_delete
  BEFORE DELETE ON operator_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_operator_audit_mutation();

-- Append-only events for authenticated account-security actions. This is kept
-- separate from operator_audit_events because the actor is a browser-authenticated
-- user, not an out-of-band deployment operator.
CREATE TABLE IF NOT EXISTS account_security_events (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type      TEXT NOT NULL,
  actor_user_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  subject_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  subject_email   TEXT NOT NULL,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_security_created ON account_security_events(created_at);
CREATE INDEX IF NOT EXISTS idx_account_security_subject ON account_security_events(subject_user_id);

CREATE OR REPLACE FUNCTION reject_account_security_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'account security events are append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS trg_account_security_no_update ON account_security_events;
CREATE TRIGGER trg_account_security_no_update
  BEFORE UPDATE ON account_security_events
  FOR EACH ROW EXECUTE FUNCTION reject_account_security_event_mutation();
DROP TRIGGER IF EXISTS trg_account_security_no_delete ON account_security_events;
CREATE TRIGGER trg_account_security_no_delete
  BEFORE DELETE ON account_security_events
  FOR EACH ROW EXECUTE FUNCTION reject_account_security_event_mutation();

-- Platform capabilities are assigned out of band by a trusted operator. They
-- are intentionally separate from organization/project roles and have no
-- user-facing mutation endpoint.
CREATE TABLE IF NOT EXISTS platform_capabilities (
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability   TEXT NOT NULL,
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, capability)
);
CREATE INDEX IF NOT EXISTS idx_platform_capability_name ON platform_capabilities(capability);

-- ── Provenance (owner-scoped, optionally project-associated; append-only) ────
CREATE TABLE IF NOT EXISTS provenance (
  id                        TEXT PRIMARY KEY,
  user_email                TEXT NOT NULL DEFAULT '',
  project_id                TEXT,
  created_by_user_id        BIGINT,
  dataset_id                TEXT,
  analysis_object_id        TEXT,
  job_id                    TEXT,
  result_analysis_object_id TEXT,
  timestamp                 TEXT NOT NULL,
  language                  TEXT NOT NULL,
  language_version          TEXT,
  packages                  TEXT DEFAULT '[]',
  script                    TEXT NOT NULL,
  parameters                TEXT DEFAULT '{}',
  parent_ids                TEXT DEFAULT '[]',
  operation                 TEXT DEFAULT 'unknown',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prov_timestamp ON provenance(timestamp);
CREATE INDEX IF NOT EXISTS idx_prov_user ON provenance(user_email);
CREATE INDEX IF NOT EXISTS idx_prov_project ON provenance(project_id);

CREATE TABLE IF NOT EXISTS results_cache (
  cache_key     TEXT PRIMARY KEY,
  user_email    TEXT NOT NULL DEFAULT '',
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  result_data   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cache_prov ON results_cache(provenance_id);
CREATE INDEX IF NOT EXISTS idx_cache_user ON results_cache(user_email);

-- ── Figures (owner-scoped, optionally project-associated) ────────────────────
CREATE TABLE IF NOT EXISTS figure_collection (
  id                 TEXT PRIMARY KEY,
  user_email         TEXT NOT NULL,
  project_id         TEXT,
  created_by_user_id BIGINT,
  analysis_object_id TEXT,
  job_id             TEXT,
  provenance_id      TEXT,
  dataset_id         TEXT,
  object_id          TEXT,
  plot_type          TEXT NOT NULL,
  title              TEXT DEFAULT '',
  params_json        TEXT NOT NULL DEFAULT '{}',
  file_path          TEXT DEFAULT '',
  file_format        TEXT DEFAULT 'png',
  thumbnail_b64      TEXT DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_figures_user ON figure_collection(user_email);
CREATE INDEX IF NOT EXISTS idx_figures_project ON figure_collection(project_id);

-- ── Organizations & Projects (membership + authorization foundation) ─────────
CREATE TABLE IF NOT EXISTS organizations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_user_id BIGINT NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orgs_owner ON organizations(owner_user_id);

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id         BIGINT NOT NULL REFERENCES users(id),
  role            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);

CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY,
  organization_id    TEXT NOT NULL REFERENCES organizations(id),
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  created_by_user_id BIGINT NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organization_id);
CREATE INDEX IF NOT EXISTS idx_projects_creator ON projects(created_by_user_id);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id    BIGINT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

-- ── Datasets (project-scoped durable resource; server-owned identity/storage) ─
CREATE TABLE IF NOT EXISTS datasets (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id),
  owner_user_id        BIGINT NOT NULL REFERENCES users(id),
  created_by_user_id   BIGINT NOT NULL REFERENCES users(id),
  original_filename    TEXT,
  internal_storage_key TEXT,
  storage_uri          TEXT,
  file_type            TEXT NOT NULL,
  file_size_bytes      BIGINT,
  sha256               TEXT,
  upload_status        TEXT NOT NULL,
  validation_status    TEXT NOT NULL,
  validation_errors    TEXT,
  metadata             TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_datasets_project ON datasets(project_id);
CREATE INDEX IF NOT EXISTS idx_datasets_owner ON datasets(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_datasets_creator ON datasets(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_datasets_file_type ON datasets(file_type);
CREATE INDEX IF NOT EXISTS idx_datasets_upload_status ON datasets(upload_status);
CREATE INDEX IF NOT EXISTS idx_datasets_validation_status ON datasets(validation_status);
CREATE INDEX IF NOT EXISTS idx_datasets_created ON datasets(created_at);
CREATE INDEX IF NOT EXISTS idx_datasets_sha256 ON datasets(sha256);

-- Creator-private files explicitly imported for Expert R. These are not
-- datasets or public job artifacts: only the owning approved researcher may
-- list or select them, and workers resolve storage coordinates server-side.
CREATE TABLE IF NOT EXISTS expert_r_private_inputs (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_filename    TEXT NOT NULL,
  internal_storage_key TEXT NOT NULL UNIQUE,
  mime_type            TEXT NOT NULL,
  file_size_bytes      BIGINT NOT NULL,
  sha256               TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT expert_r_private_input_size CHECK (file_size_bytes >= 0),
  CONSTRAINT expert_r_private_input_sha CHECK (sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_expert_r_private_inputs_owner
  ON expert_r_private_inputs(project_id, owner_user_id, created_at DESC);

-- Pipeline definitions and user-project active selection. Trusted platform
-- definitions use project_id NULL + visibility 'platform'; older project/user
-- rows remain stored but are quarantined from selection. Manifests are
-- declarative module/tab definitions only; code, paths, endpoints, and R state
-- stay outside the manifest contract. Selection is scoped by BOTH project and
-- user so collaborators do not overwrite each other's active workflow.
CREATE TABLE IF NOT EXISTS pipeline_definitions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id),
  owner_user_id BIGINT NOT NULL REFERENCES users(id),
  visibility    TEXT NOT NULL DEFAULT 'user',
  manifest_id   TEXT,
  name          TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Additive upgrade for databases created before the trusted platform registry.
ALTER TABLE pipeline_definitions ADD COLUMN IF NOT EXISTS manifest_id TEXT;
CREATE INDEX IF NOT EXISTS idx_pipeline_def_project ON pipeline_definitions(project_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_def_owner ON pipeline_definitions(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_def_visibility ON pipeline_definitions(visibility);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_platform_manifest_id
  ON pipeline_definitions(manifest_id)
  WHERE project_id IS NULL AND visibility = 'platform' AND manifest_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_pipeline_selections (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  user_id     BIGINT NOT NULL REFERENCES users(id),
  pipeline_id TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_selection_user ON project_pipeline_selections(user_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_selection_pipeline ON project_pipeline_selections(pipeline_id);

-- ── Analysis objects (server-owned identity; optional project association) ───
CREATE TABLE IF NOT EXISTS analysis_objects (
  id                      TEXT PRIMARY KEY,
  owner_user_id           BIGINT NOT NULL REFERENCES users(id),
  project_id              TEXT,
  dataset_id              TEXT,
  parent_object_id        TEXT REFERENCES analysis_objects(id),
  lineage_root_id         TEXT,
  object_type             TEXT NOT NULL,
  display_name            TEXT,
  storage_uri             TEXT,
  object_hash             TEXT,
  metadata_json           TEXT NOT NULL DEFAULT '{}',
  created_by_provenance_id TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ao_owner ON analysis_objects(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_ao_project ON analysis_objects(project_id);
CREATE INDEX IF NOT EXISTS idx_ao_dataset ON analysis_objects(dataset_id);
CREATE INDEX IF NOT EXISTS idx_ao_parent ON analysis_objects(parent_object_id);
CREATE INDEX IF NOT EXISTS idx_ao_lineage_root ON analysis_objects(lineage_root_id);
CREATE INDEX IF NOT EXISTS idx_ao_project_dataset ON analysis_objects(project_id, dataset_id);
CREATE INDEX IF NOT EXISTS idx_ao_project_parent ON analysis_objects(project_id, parent_object_id);
CREATE INDEX IF NOT EXISTS idx_ao_project_lineage_root ON analysis_objects(project_id, lineage_root_id);
CREATE INDEX IF NOT EXISTS idx_ao_project_owner ON analysis_objects(project_id, owner_user_id);

-- Successful live R responses recorded at the server trust boundary. Source and
-- execution order cannot be supplied through browser provenance endpoints.
CREATE TABLE IF NOT EXISTS live_execution_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  analysis_object_id TEXT NOT NULL REFERENCES analysis_objects(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  kernel_generation TEXT NOT NULL CHECK (kernel_generation ~ '^[a-f0-9]{64}$'),
  kernel_order BIGINT NOT NULL CHECK (kernel_order > 0),
  live_revision BIGINT CHECK (live_revision >= 0),
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  record_json JSONB NOT NULL CHECK (octet_length(record_json::text) <= 69632),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, owner_user_id, kernel_generation, kernel_order)
);
CREATE INDEX IF NOT EXISTS idx_live_execution_project_owner
  ON live_execution_records(project_id, owner_user_id, created_at DESC, id DESC);

-- Explicit experimental-design metadata. Nothing is inferred from filenames or
-- client-provided R state. Spatial identity fields are modeled for future use;
-- this does not claim spatial compute support.
CREATE TABLE IF NOT EXISTS study_conditions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by_user_id BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_study_conditions_project_name
  ON study_conditions(project_id, lower(name));

CREATE TABLE IF NOT EXISTS biological_samples (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  dataset_id TEXT REFERENCES datasets(id),
  condition_id TEXT NOT NULL REFERENCES study_conditions(id),
  name TEXT NOT NULL,
  donor_code TEXT,
  batch TEXT,
  replicate_label TEXT,
  modality TEXT NOT NULL DEFAULT 'scrna' CHECK (modality IN ('scrna', 'spatial')),
  organism TEXT,
  tissue TEXT,
  platform TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by_user_id BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_biological_samples_project_name
  ON biological_samples(project_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_biological_samples_condition ON biological_samples(condition_id);
CREATE INDEX IF NOT EXISTS idx_biological_samples_dataset ON biological_samples(dataset_id);

CREATE TABLE IF NOT EXISTS analysis_object_sample_bindings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  analysis_object_id TEXT NOT NULL REFERENCES analysis_objects(id),
  sample_id TEXT NOT NULL REFERENCES biological_samples(id),
  cell_metadata_column TEXT NOT NULL,
  cell_metadata_value TEXT NOT NULL,
  created_by_user_id BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (analysis_object_id, sample_id),
  UNIQUE (analysis_object_id, cell_metadata_column, cell_metadata_value)
);
CREATE INDEX IF NOT EXISTS idx_sample_bindings_object ON analysis_object_sample_bindings(analysis_object_id);
CREATE INDEX IF NOT EXISTS idx_sample_bindings_sample ON analysis_object_sample_bindings(sample_id);

-- A contrast snapshots its eligible sample set at creation so later sample
-- registration cannot silently change an already-reviewed design.
CREATE TABLE IF NOT EXISTS condition_contrasts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  analysis_object_id TEXT NOT NULL REFERENCES analysis_objects(id),
  name TEXT NOT NULL,
  numerator_condition_id TEXT NOT NULL REFERENCES study_conditions(id),
  denominator_condition_id TEXT NOT NULL REFERENCES study_conditions(id),
  unit_of_replication TEXT NOT NULL CHECK (unit_of_replication IN ('sample', 'donor')),
  paired BOOLEAN NOT NULL DEFAULT FALSE,
  cell_type_column TEXT NOT NULL DEFAULT 'seurat_clusters',
  blocking_factor TEXT,
  covariates_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('valid', 'warning', 'invalid')),
  validation_json TEXT NOT NULL DEFAULT '{}',
  created_by_user_id BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (numerator_condition_id <> denominator_condition_id)
);
ALTER TABLE condition_contrasts
  ADD COLUMN IF NOT EXISTS cell_type_column TEXT NOT NULL DEFAULT 'seurat_clusters';
CREATE UNIQUE INDEX IF NOT EXISTS idx_condition_contrasts_project_name
  ON condition_contrasts(project_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_condition_contrasts_object ON condition_contrasts(analysis_object_id);

CREATE TABLE IF NOT EXISTS condition_contrast_samples (
  contrast_id TEXT NOT NULL REFERENCES condition_contrasts(id) ON DELETE CASCADE,
  sample_id TEXT NOT NULL REFERENCES biological_samples(id),
  condition_id TEXT NOT NULL REFERENCES study_conditions(id),
  donor_code TEXT,
  cell_metadata_column TEXT NOT NULL,
  cell_metadata_value TEXT NOT NULL,
  PRIMARY KEY (contrast_id, sample_id)
);
ALTER TABLE condition_contrast_samples ADD COLUMN IF NOT EXISTS cell_metadata_column TEXT;
ALTER TABLE condition_contrast_samples ADD COLUMN IF NOT EXISTS cell_metadata_value TEXT;
CREATE INDEX IF NOT EXISTS idx_contrast_samples_condition
  ON condition_contrast_samples(contrast_id, condition_id);

-- ── Jobs (durable, ownership-scoped; state machine + worker coordination) ────
CREATE TABLE IF NOT EXISTS jobs (
  id                        TEXT PRIMARY KEY,
  owner_user_id             BIGINT NOT NULL REFERENCES users(id),
  project_id                TEXT,
  retry_of_job_id           TEXT REFERENCES jobs(id),
  analysis_object_id        TEXT REFERENCES analysis_objects(id),
  result_analysis_object_id TEXT REFERENCES analysis_objects(id),
  dataset_id                TEXT,
  job_type                  TEXT NOT NULL,
  status                    TEXT NOT NULL,
  parameters_json           TEXT NOT NULL DEFAULT '{}',
  logs_json                 TEXT NOT NULL DEFAULT '[]',
  error_json                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at                TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  canceled_at               TIMESTAMPTZ,
  worker_id                 TEXT,
  claim_token               TEXT,
  lease_expires_at          TIMESTAMPTZ,
  heartbeat_at              TIMESTAMPTZ,
  locked_at                 TIMESTAMPTZ,
  attempts                  INTEGER NOT NULL DEFAULT 0,
  max_attempts              INTEGER NOT NULL DEFAULT 1,
  priority                  INTEGER NOT NULL DEFAULT 0,
  last_worker_error         TEXT
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS retry_of_job_id TEXT REFERENCES jobs(id);
CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_jobs_analysis_object ON jobs(analysis_object_id);
CREATE INDEX IF NOT EXISTS idx_jobs_result_object ON jobs(result_analysis_object_id);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(job_type);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_claimable ON jobs(status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_jobs_worker ON jobs(worker_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_project_status ON jobs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_project_analysis_object ON jobs(project_id, analysis_object_id);
CREATE INDEX IF NOT EXISTS idx_jobs_project_result_object ON jobs(project_id, result_analysis_object_id);
CREATE INDEX IF NOT EXISTS idx_jobs_project_dataset ON jobs(project_id, dataset_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_retry_of_job
  ON jobs(retry_of_job_id) WHERE retry_of_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS service_execution_identity (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  service_id TEXT NOT NULL UNIQUE CHECK(service_id ~ '^svc_[a-f0-9]{32}$')
);
CREATE TABLE IF NOT EXISTS project_job_submissions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, owner_user_id, request_id)
);
CREATE TABLE IF NOT EXISTS job_execution_receipts (
  dispatch_order BIGINT GENERATED ALWAYS AS IDENTITY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL CHECK(dispatch_id ~ '^[a-f0-9]{64}$'),
  attempt INTEGER NOT NULL CHECK(attempt >= 1),
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK(operation ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  target_json JSONB NOT NULL CHECK(octet_length(target_json::text) <= 4096),
  environment_json JSONB NOT NULL CHECK(octet_length(environment_json::text) <= 8192),
  dispatch_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(job_id, dispatch_id)
);
ALTER TABLE job_execution_receipts ADD COLUMN IF NOT EXISTS dispatch_order BIGINT GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_receipts_dispatch_order ON job_execution_receipts(dispatch_order);
CREATE INDEX IF NOT EXISTS idx_execution_receipts_scope ON job_execution_receipts(project_id,owner_user_id,job_id);
CREATE OR REPLACE FUNCTION reject_execution_receipt_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'execution receipts are immutable' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS trg_execution_receipt_no_update ON job_execution_receipts;
CREATE TRIGGER trg_execution_receipt_no_update BEFORE UPDATE ON job_execution_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_execution_receipt_update();
DROP TRIGGER IF EXISTS trg_service_identity_no_update ON service_execution_identity;
CREATE TRIGGER trg_service_identity_no_update BEFORE UPDATE ON service_execution_identity
  FOR EACH ROW EXECUTE FUNCTION reject_execution_receipt_update();

DROP TRIGGER IF EXISTS trg_project_submission_no_update ON project_job_submissions;
CREATE TRIGGER trg_project_submission_no_update BEFORE UPDATE ON project_job_submissions
  FOR EACH ROW EXECUTE FUNCTION reject_execution_receipt_update();

-- Expert R source is needed only while a request can still execute. Once the
-- job reaches a terminal state, retain the selected profile and source hash for
-- provenance but remove the source itself from durable job metadata. Keeping
-- this invariant in Postgres covers completion, cancellation, failure, lease
-- exhaustion, and operator/access-revocation paths uniformly.
CREATE OR REPLACE FUNCTION redact_terminal_expert_r_parameters()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  params JSONB;
BEGIN
  IF NEW.job_type = 'expert.r.v1'
     AND NEW.status IN ('completed', 'failed', 'canceled') THEN
    BEGIN
      params := COALESCE(NULLIF(NEW.parameters_json, ''), '{}')::jsonb;
    EXCEPTION WHEN OTHERS THEN
      params := '{}'::jsonb;
    END;
    NEW.parameters_json := jsonb_strip_nulls(jsonb_build_object(
      'profileId', params ->> 'profileId',
      'inputIds', COALESCE(params -> 'inputIds', '[]'::jsonb),
      'scriptSha256', params ->> 'scriptSha256',
      'environment', params -> 'environment'
    ))::text;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_jobs_redact_terminal_expert_r_parameters ON jobs;
CREATE TRIGGER trg_jobs_redact_terminal_expert_r_parameters
  BEFORE INSERT OR UPDATE OF status, parameters_json ON jobs
  FOR EACH ROW EXECUTE FUNCTION redact_terminal_expert_r_parameters();

-- Apply the policy to terminal rows created before this trigger existed.
UPDATE jobs
   SET parameters_json = parameters_json
 WHERE job_type = 'expert.r.v1'
   AND status IN ('completed', 'failed', 'canceled')
   AND parameters_json LIKE '%"script"%';

-- Singleton heartbeat published only by the standalone worker. It lets the web
-- process present a truthful compute state without proxying the worker health
-- port or exposing worker identity, topology, paths, or R credentials.
CREATE TABLE IF NOT EXISTS worker_runtime_status (
  singleton   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  state       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-slot heartbeats for the bounded isolated compute pool. The legacy
-- singleton row is retained for additive upgrades, but current workers publish
-- here so one draining slot cannot hide another healthy slot.
CREATE TABLE IF NOT EXISTS worker_pool_runtime_status (
  slot        SMALLINT PRIMARY KEY CHECK (slot BETWEEN 1 AND 8),
  state       TEXT NOT NULL,
  capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE worker_pool_runtime_status
  ADD COLUMN IF NOT EXISTS capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── Job artifacts / checkpoints (metadata-first; server-owned) ───────────────
-- Creator-private immutable source versions survive terminal-job transport
-- cleanup, including failed runs. They are not committed compute outputs.
CREATE TABLE IF NOT EXISTS execution_source_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK (language = 'R'),
  source_code TEXT NOT NULL CHECK (octet_length(source_code) BETWEEN 1 AND 32768),
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_execution_source_project_owner
  ON execution_source_versions(project_id, owner_user_id, job_id);
CREATE OR REPLACE FUNCTION reject_execution_source_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'execution source versions are immutable' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS trg_execution_source_no_update ON execution_source_versions;
CREATE TRIGGER trg_execution_source_no_update
  BEFORE UPDATE ON execution_source_versions
  FOR EACH ROW EXECUTE FUNCTION reject_execution_source_update();

CREATE TABLE IF NOT EXISTS job_artifacts (
  id                        TEXT PRIMARY KEY,
  project_id                TEXT,
  job_id                    TEXT NOT NULL REFERENCES jobs(id),
  dataset_id                TEXT,
  analysis_object_id        TEXT REFERENCES analysis_objects(id),
  result_analysis_object_id TEXT REFERENCES analysis_objects(id),
  provenance_id             TEXT,
  figure_id                 TEXT,
  created_by_user_id        BIGINT NOT NULL REFERENCES users(id),
  artifact_type             TEXT NOT NULL,
  name                      TEXT,
  description               TEXT,
  mime_type                 TEXT,
  storage_kind              TEXT NOT NULL DEFAULT 'metadata_only',
  storage_uri               TEXT,
  checksum_sha256           TEXT,
  size_bytes                BIGINT,
  status                    TEXT NOT NULL DEFAULT 'available',
  metadata_json             TEXT NOT NULL DEFAULT '{}',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_project ON job_artifacts(project_id);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_job ON job_artifacts(job_id);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_dataset ON job_artifacts(dataset_id);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_analysis_object ON job_artifacts(analysis_object_id);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_result_object ON job_artifacts(result_analysis_object_id);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_provenance ON job_artifacts(provenance_id);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_figure ON job_artifacts(figure_id);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_type ON job_artifacts(artifact_type);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_status ON job_artifacts(status);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_project_job ON job_artifacts(project_id, job_id);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_created ON job_artifacts(created_at);
-- Artifact immutability: at most ONE result checkpoint per job. This hard
-- partial-unique constraint prevents two racing workers from both writing a
-- result checkpoint for the same job.
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_artifacts_one_checkpoint
  ON job_artifacts(job_id)
  WHERE artifact_type = 'result_checkpoint';

-- Managed file versions are immutable; replacing a file appends a new row.
CREATE TABLE IF NOT EXISTS managed_artifact_versions (
  id                  TEXT PRIMARY KEY,
  artifact_id         TEXT NOT NULL,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  version_number      INTEGER NOT NULL CHECK (version_number > 0),
  previous_version_id TEXT REFERENCES managed_artifact_versions(id),
  artifact_type       TEXT NOT NULL,
  format_json         JSONB NOT NULL,
  mime_type           TEXT NOT NULL,
  checksum_sha256     TEXT NOT NULL,
  size_bytes          BIGINT NOT NULL CHECK (size_bytes >= 0),
  storage_key         TEXT NOT NULL UNIQUE,
  source_job_id       TEXT REFERENCES jobs(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (artifact_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_managed_artifact_versions_project_owner
  ON managed_artifact_versions(project_id, owner_user_id, created_at DESC, id DESC);

-- ── Analysis object lineage edges (DAG-ready parent→child model) ─────────────
CREATE TABLE IF NOT EXISTS analysis_object_edges (
  id                        TEXT PRIMARY KEY,
  project_id                TEXT,
  parent_analysis_object_id TEXT NOT NULL REFERENCES analysis_objects(id),
  child_analysis_object_id  TEXT NOT NULL REFERENCES analysis_objects(id),
  job_id                    TEXT REFERENCES jobs(id),
  edge_type                 TEXT NOT NULL,
  parent_role               TEXT NOT NULL DEFAULT 'primary',
  metadata_json             TEXT NOT NULL DEFAULT '{}',
  created_by_user_id        BIGINT NOT NULL REFERENCES users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (parent_analysis_object_id <> child_analysis_object_id)
);
CREATE INDEX IF NOT EXISTS idx_aoe_project ON analysis_object_edges(project_id);
CREATE INDEX IF NOT EXISTS idx_aoe_parent ON analysis_object_edges(parent_analysis_object_id);
CREATE INDEX IF NOT EXISTS idx_aoe_child ON analysis_object_edges(child_analysis_object_id);
CREATE INDEX IF NOT EXISTS idx_aoe_project_parent ON analysis_object_edges(project_id, parent_analysis_object_id);
CREATE INDEX IF NOT EXISTS idx_aoe_project_child ON analysis_object_edges(project_id, child_analysis_object_id);
CREATE INDEX IF NOT EXISTS idx_aoe_project_job ON analysis_object_edges(project_id, job_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_aoe_unique ON analysis_object_edges(
  parent_analysis_object_id, child_analysis_object_id, COALESCE(job_id, ''), parent_role, edge_type
);

-- Git-like project work references. Analysis objects and checkpoints remain
-- immutable; a branch is only a named, optimistic-lock-protected pointer to one
-- owned object in that immutable lineage. Private branches are visible only to
-- their owner until explicitly shared for review.
CREATE TABLE IF NOT EXISTS analysis_branches (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id),
  owner_user_id           BIGINT NOT NULL REFERENCES users(id),
  name                    TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  visibility              TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'project')),
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  base_analysis_object_id TEXT NOT NULL REFERENCES analysis_objects(id),
  head_analysis_object_id TEXT NOT NULL REFERENCES analysis_objects(id),
  version                 INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_user_id      BIGINT NOT NULL REFERENCES users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analysis_branches_project ON analysis_branches(project_id);
CREATE INDEX IF NOT EXISTS idx_analysis_branches_owner ON analysis_branches(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_analysis_branches_head ON analysis_branches(head_analysis_object_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_branches_owner_name
  ON analysis_branches(project_id, owner_user_id, lower(name));

CREATE TABLE IF NOT EXISTS analysis_branch_events (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id),
  branch_id               TEXT NOT NULL REFERENCES analysis_branches(id),
  actor_user_id           BIGINT NOT NULL REFERENCES users(id),
  event_type              TEXT NOT NULL,
  from_analysis_object_id TEXT REFERENCES analysis_objects(id),
  to_analysis_object_id   TEXT REFERENCES analysis_objects(id),
  metadata_json           TEXT NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_branch_events_branch ON analysis_branch_events(branch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_branch_events_project ON analysis_branch_events(project_id, created_at);

CREATE TABLE IF NOT EXISTS analysis_branch_reviews (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id),
  branch_id               TEXT NOT NULL REFERENCES analysis_branches(id),
  head_analysis_object_id TEXT NOT NULL REFERENCES analysis_objects(id),
  requested_by_user_id    BIGINT NOT NULL REFERENCES users(id),
  title                   TEXT NOT NULL,
  summary                 TEXT NOT NULL DEFAULT '',
  status                  TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'approved', 'changes_requested', 'closed')),
  decided_by_user_id      BIGINT REFERENCES users(id),
  decision_note           TEXT,
  decided_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_branch_reviews_project ON analysis_branch_reviews(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_branch_reviews_branch ON analysis_branch_reviews(branch_id, created_at);

CREATE TABLE IF NOT EXISTS analysis_branch_review_comments (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  review_id       TEXT NOT NULL REFERENCES analysis_branch_reviews(id),
  author_user_id  BIGINT NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_branch_review_comments
  ON analysis_branch_review_comments(review_id, created_at, id);

CREATE TABLE IF NOT EXISTS project_canonical_analyses (
  project_id              TEXT PRIMARY KEY REFERENCES projects(id),
  analysis_object_id      TEXT NOT NULL REFERENCES analysis_objects(id),
  source_branch_id        TEXT NOT NULL REFERENCES analysis_branches(id),
  source_review_id        TEXT NOT NULL REFERENCES analysis_branch_reviews(id),
  promoted_by_user_id     BIGINT NOT NULL REFERENCES users(id),
  version                 INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  promoted_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_canonical_object ON project_canonical_analyses(analysis_object_id);

-- Append-only, project-scoped security and collaboration audit stream. Public
-- responses use a bounded projection and never include storage locations,
-- scripts, request bodies, credentials, or R state identifiers.
CREATE TABLE IF NOT EXISTS project_audit_events (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  actor_user_id   BIGINT NOT NULL REFERENCES users(id),
  action          TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  target_id       TEXT,
  details_json    TEXT NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_audit_project_created
  ON project_audit_events(project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_project_audit_actor
  ON project_audit_events(project_id, actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_project_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.demo_cleanup', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'project audit events are append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS trg_project_audit_no_update ON project_audit_events;
CREATE TRIGGER trg_project_audit_no_update
  BEFORE UPDATE ON project_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_project_audit_mutation();
DROP TRIGGER IF EXISTS trg_project_audit_no_delete ON project_audit_events;
CREATE TRIGGER trg_project_audit_no_delete
  BEFORE DELETE ON project_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_project_audit_mutation();

CREATE TABLE IF NOT EXISTS workflow_instances (
  id TEXT PRIMARY KEY,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  analysis_object_id TEXT NOT NULL REFERENCES analysis_objects(id) ON DELETE CASCADE,
  package_digest TEXT NOT NULL,
  package_json JSONB NOT NULL,
  state_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id, project_id, analysis_object_id, package_digest)
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  instance_id TEXT REFERENCES workflow_instances(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  output_names_json JSONB NOT NULL DEFAULT '[]',
  UNIQUE(instance_id, request_id)
);
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS output_names_json JSONB NOT NULL DEFAULT '[]';
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS request_hash TEXT CHECK(request_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS request_json JSONB CHECK(octet_length(request_json::text) <= 65536);
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS original_instance_id TEXT;
DROP TRIGGER IF EXISTS trg_workflow_submission_no_update ON workflow_runs;
UPDATE workflow_runs SET original_instance_id=instance_id WHERE original_instance_id IS NULL AND instance_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_original_submission ON workflow_runs(original_instance_id,request_id)
  WHERE original_instance_id IS NOT NULL;
CREATE OR REPLACE FUNCTION protect_workflow_submission_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.request_id,NEW.job_id,NEW.step_id,NEW.request_hash,NEW.request_json,NEW.original_instance_id)
     IS DISTINCT FROM (OLD.request_id,OLD.job_id,OLD.step_id,OLD.request_hash,OLD.request_json,OLD.original_instance_id) THEN
    RAISE EXCEPTION 'workflow submission receipts are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_workflow_submission_no_update ON workflow_runs;
CREATE TRIGGER trg_workflow_submission_no_update BEFORE UPDATE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION protect_workflow_submission_identity();
CREATE TABLE IF NOT EXISTS workflow_artifacts (
  id TEXT PRIMARY KEY,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  descriptor_json JSONB NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workflow_snapshots (
  id TEXT PRIMARY KEY,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  analysis_object_id TEXT NOT NULL REFERENCES analysis_objects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  package_json JSONB NOT NULL,
  state_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_owner ON workflow_artifacts(owner_user_id, project_id);
CREATE INDEX IF NOT EXISTS idx_workflow_snapshots_owner ON workflow_snapshots(owner_user_id, project_id);

-- Private persistent R sessions and immutable command evidence.
CREATE TABLE IF NOT EXISTS private_r_kernels (
  id TEXT PRIMARY KEY CHECK (id ~ '^pk_[a-f0-9]{24}$'),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL CHECK (octet_length(workspace_id) BETWEEN 1 AND 120),
  analysis_object_id TEXT REFERENCES analysis_objects(id) ON DELETE SET NULL,
  request_id UUID NOT NULL,
  start_sha256 TEXT NOT NULL CHECK (start_sha256 ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('starting','ready','running','unknown','stopping','stopped','failed')),
  runtime_generation TEXT CHECK (runtime_generation ~ '^[a-f0-9]{64}$'),
  environment_json JSONB NOT NULL CHECK (octet_length(environment_json::text) <= 4096),
  environment_manifest_json JSONB NOT NULL CHECK (octet_length(environment_manifest_json::text) <= 278528),
  inputs_json JSONB NOT NULL CHECK (octet_length(inputs_json::text) <= 69632),
  resources_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(resources_json::text) <= 4096),
  target_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(target_json::text) <= 4096),
  next_order BIGINT NOT NULL DEFAULT 0 CHECK (next_order >= 0 AND next_order <= 500),
  active_execution_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id,owner_user_id,request_id)
);
CREATE INDEX IF NOT EXISTS idx_private_kernel_owner_project
  ON private_r_kernels(project_id,owner_user_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_private_kernel_workspace_active
  ON private_r_kernels(project_id,owner_user_id,workspace_id)
  WHERE status IN ('starting','ready','running','unknown','stopping');

ALTER TABLE private_r_kernels ADD COLUMN IF NOT EXISTS restarted_from_kernel_id TEXT;
ALTER TABLE private_r_kernels ADD COLUMN IF NOT EXISTS active_control_id UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='private_r_kernel_restart_parent_fk') THEN
    ALTER TABLE private_r_kernels ADD CONSTRAINT private_r_kernel_restart_parent_fk
      FOREIGN KEY(restarted_from_kernel_id) REFERENCES private_r_kernels(id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_private_kernel_restart_parent
  ON private_r_kernels(restarted_from_kernel_id) WHERE restarted_from_kernel_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS private_r_kernel_restarts (
  id TEXT PRIMARY KEY CHECK (id ~ '^prst_[a-f0-9]{24}$'),
  kernel_id TEXT NOT NULL UNIQUE REFERENCES private_r_kernels(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  kernel_generation TEXT NOT NULL CHECK (kernel_generation ~ '^[a-f0-9]{64}$'),
  replacement_kernel_id TEXT NOT NULL UNIQUE CHECK (replacement_kernel_id ~ '^pk_[a-f0-9]{24}$'),
  status TEXT NOT NULL CHECK (status IN ('stopping','starting','completed','failed','unknown')),
  failure_code TEXT CHECK (failure_code ~ '^[A-Z0-9_]{1,80}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id,owner_user_id,request_id)
);
CREATE INDEX IF NOT EXISTS idx_private_kernel_restart_owner ON private_r_kernel_restarts(project_id,owner_user_id,created_at DESC,id DESC);
CREATE OR REPLACE FUNCTION reject_private_kernel_restart_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.kernel_id,NEW.project_id,NEW.owner_user_id,NEW.request_id,NEW.request_sha256,NEW.kernel_generation,NEW.replacement_kernel_id,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.kernel_id,OLD.project_id,OLD.owner_user_id,OLD.request_id,OLD.request_sha256,OLD.kernel_generation,OLD.replacement_kernel_id,OLD.created_at)
  THEN RAISE EXCEPTION 'private kernel restart identity is immutable' USING ERRCODE='55000'; END IF;
  IF OLD.status IN ('completed','failed') AND ROW(NEW.status,NEW.failure_code,NEW.completed_at)
     IS DISTINCT FROM ROW(OLD.status,OLD.failure_code,OLD.completed_at)
  THEN RAISE EXCEPTION 'completed private kernel restart receipt is immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_private_kernel_restart_no_update ON private_r_kernel_restarts;
CREATE TRIGGER trg_private_kernel_restart_no_update BEFORE UPDATE ON private_r_kernel_restarts
  FOR EACH ROW EXECUTE FUNCTION reject_private_kernel_restart_update();

CREATE TABLE IF NOT EXISTS private_r_executions (
  id TEXT PRIMARY KEY CHECK (id ~ '^pex_[a-f0-9]{24}$'),
  kernel_id TEXT NOT NULL REFERENCES private_r_kernels(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  kernel_generation TEXT NOT NULL CHECK (kernel_generation ~ '^[a-f0-9]{64}$'),
  execution_order BIGINT NOT NULL CHECK (execution_order BETWEEN 1 AND 500),
  status TEXT NOT NULL CHECK (status IN ('reserved','running','completed','failed','unknown')),
  source_code TEXT NOT NULL CHECK (octet_length(source_code) BETWEEN 1 AND 32768),
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  result_json JSONB CHECK (octet_length(result_json::text) <= 1114112),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(kernel_id,request_id),
  UNIQUE(kernel_id,execution_order)
);
CREATE INDEX IF NOT EXISTS idx_private_execution_kernel_order
  ON private_r_executions(kernel_id,execution_order DESC);
CREATE INDEX IF NOT EXISTS idx_private_execution_project_owner
  ON private_r_executions(project_id,owner_user_id,created_at DESC,id DESC);

CREATE OR REPLACE FUNCTION reject_private_execution_identity_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.kernel_id,NEW.project_id,NEW.owner_user_id,NEW.request_id,
         NEW.kernel_generation,NEW.execution_order,NEW.source_code,NEW.source_sha256,NEW.created_at)
    IS DISTINCT FROM
     ROW(OLD.id,OLD.kernel_id,OLD.project_id,OLD.owner_user_id,OLD.request_id,
         OLD.kernel_generation,OLD.execution_order,OLD.source_code,OLD.source_sha256,OLD.created_at)
  THEN RAISE EXCEPTION 'private execution identity and source are immutable' USING ERRCODE='55000'; END IF;
  IF OLD.status IN ('completed','failed') AND ROW(NEW.status,NEW.result_json,NEW.completed_at)
     IS DISTINCT FROM ROW(OLD.status,OLD.result_json,OLD.completed_at)
  THEN RAISE EXCEPTION 'completed private execution evidence is immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_private_execution_identity_no_update ON private_r_executions;
CREATE TRIGGER trg_private_execution_identity_no_update
  BEFORE UPDATE ON private_r_executions
  FOR EACH ROW EXECUTE FUNCTION reject_private_execution_identity_update();

CREATE OR REPLACE FUNCTION reject_private_kernel_identity_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.project_id,NEW.owner_user_id,NEW.workspace_id,NEW.request_id,NEW.start_sha256,
         NEW.environment_json,NEW.environment_manifest_json,NEW.inputs_json,NEW.created_at,NEW.restarted_from_kernel_id)
    IS DISTINCT FROM
     ROW(OLD.id,OLD.project_id,OLD.owner_user_id,OLD.workspace_id,OLD.request_id,OLD.start_sha256,
         OLD.environment_json,OLD.environment_manifest_json,OLD.inputs_json,OLD.created_at,OLD.restarted_from_kernel_id)
    OR (OLD.runtime_generation IS NOT NULL AND NEW.runtime_generation IS DISTINCT FROM OLD.runtime_generation)
  THEN RAISE EXCEPTION 'private kernel identity and inputs are immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_private_kernel_identity_no_update ON private_r_kernels;
CREATE TRIGGER trg_private_kernel_identity_no_update
  BEFORE UPDATE ON private_r_kernels
  FOR EACH ROW EXECUTE FUNCTION reject_private_kernel_identity_update();
-- Durable console publication identities and receipts. Storage keys are private.
CREATE TABLE IF NOT EXISTS private_r_publications (
  id TEXT PRIMARY KEY CHECK (id ~ '^pub_[a-f0-9]{24}$'),
  kernel_id TEXT NOT NULL REFERENCES private_r_kernels(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('reserved','running','completed','failed','unknown')),
  publication_type TEXT NOT NULL CHECK (publication_type IN ('object','table','figure')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  binding_name TEXT CHECK (octet_length(binding_name) BETWEEN 1 AND 256),
  source_execution_id TEXT NOT NULL REFERENCES private_r_executions(id),
  kernel_generation TEXT NOT NULL CHECK (kernel_generation ~ '^[a-f0-9]{64}$'),
  kernel_order INTEGER NOT NULL CHECK (kernel_order BETWEEN 1 AND 500),
  figure_index INTEGER CHECK (figure_index BETWEEN 0 AND 3),
  artifact_id TEXT NOT NULL CHECK (artifact_id ~ '^af_[a-f0-9]{24}$'),
  version_id TEXT NOT NULL UNIQUE CHECK (version_id ~ '^av_[a-f0-9]{24}$'),
  previous_version_id TEXT REFERENCES managed_artifact_versions(id) DEFERRABLE INITIALLY DEFERRED,
  storage_key TEXT NOT NULL CHECK (length(storage_key) BETWEEN 1 AND 2048),
  reserved_bytes BIGINT NOT NULL CHECK (reserved_bytes BETWEEN 1 AND 68719476736),
  checksum_sha256 TEXT CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes BIGINT CHECK (size_bytes BETWEEN 1 AND 68719476736 AND size_bytes <= reserved_bytes),
  lineage_json JSONB NOT NULL CHECK (octet_length(lineage_json::text) <= 196608),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(kernel_id,request_id),
  CHECK ((publication_type='figure' AND binding_name IS NULL AND figure_index IS NOT NULL) OR
         (publication_type IN ('object','table') AND binding_name IS NOT NULL AND figure_index IS NULL)),
  CHECK (status <> 'completed' OR (checksum_sha256 IS NOT NULL AND size_bytes IS NOT NULL AND completed_at IS NOT NULL))
);
-- Upgrade the original 20 MiB limits while retaining every immutable admission
-- reservation. A completed file must fit the exact reservation, even if the
-- operator changes the limits before its receipt is recovered.
ALTER TABLE private_r_publications DROP CONSTRAINT IF EXISTS private_r_publications_reserved_bytes_check;
ALTER TABLE private_r_publications ADD CONSTRAINT private_r_publications_reserved_bytes_check
  CHECK (reserved_bytes BETWEEN 1 AND 68719476736);
ALTER TABLE private_r_publications DROP CONSTRAINT IF EXISTS private_r_publications_size_bytes_check;
ALTER TABLE private_r_publications ADD CONSTRAINT private_r_publications_size_bytes_check
  CHECK (size_bytes BETWEEN 1 AND 68719476736 AND size_bytes <= reserved_bytes);
CREATE INDEX IF NOT EXISTS idx_private_publications_owner
  ON private_r_publications(project_id,owner_user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_private_publications_pending
  ON private_r_publications(kernel_id,status) WHERE status IN ('reserved','running','unknown');
ALTER TABLE managed_artifact_versions ADD COLUMN IF NOT EXISTS provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE managed_artifact_versions ADD COLUMN IF NOT EXISTS source_publication_id TEXT REFERENCES private_r_publications(id);
ALTER TABLE managed_artifact_versions DROP CONSTRAINT IF EXISTS managed_artifact_provenance_bound;
ALTER TABLE managed_artifact_versions ADD CONSTRAINT managed_artifact_provenance_bound CHECK (octet_length(provenance_json::text) <= 196608);
CREATE OR REPLACE FUNCTION enforce_private_publication_identity() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW.id,NEW.kernel_id,NEW.project_id,NEW.owner_user_id,NEW.request_id,NEW.request_sha256,
         NEW.publication_type,NEW.name,NEW.binding_name,NEW.source_execution_id,NEW.kernel_generation,
         NEW.kernel_order,NEW.figure_index,NEW.artifact_id,NEW.version_id,NEW.previous_version_id,
         NEW.storage_key,NEW.reserved_bytes,NEW.lineage_json,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.kernel_id,OLD.project_id,OLD.owner_user_id,OLD.request_id,OLD.request_sha256,
         OLD.publication_type,OLD.name,OLD.binding_name,OLD.source_execution_id,OLD.kernel_generation,
         OLD.kernel_order,OLD.figure_index,OLD.artifact_id,OLD.version_id,OLD.previous_version_id,
         OLD.storage_key,OLD.reserved_bytes,OLD.lineage_json,OLD.created_at) THEN
    RAISE EXCEPTION 'Private publication identity is immutable';
  END IF;
  IF OLD.status IN ('completed','failed') AND
     ROW(NEW.status,NEW.checksum_sha256,NEW.size_bytes,NEW.completed_at)
     IS DISTINCT FROM ROW(OLD.status,OLD.checksum_sha256,OLD.size_bytes,OLD.completed_at) THEN
    RAISE EXCEPTION 'Terminal private publication evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_private_publication_identity ON private_r_publications;
CREATE TRIGGER trg_private_publication_identity BEFORE UPDATE ON private_r_publications
  FOR EACH ROW EXECUTE FUNCTION enforce_private_publication_identity();
CREATE OR REPLACE FUNCTION enforce_managed_artifact_version_immutable() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'Managed artifact versions are immutable'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_managed_artifact_version_immutable ON managed_artifact_versions;
CREATE TRIGGER trg_managed_artifact_version_immutable BEFORE UPDATE ON managed_artifact_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_managed_artifact_version_immutable();

-- Server-side snapshots retain admission and identity independently of the
-- connection that requested them. No process resumes an old mutable source.
CREATE TABLE IF NOT EXISTS server_data_imports (
  id TEXT PRIMARY KEY CHECK (id ~ '^sdi_[a-f0-9]{24}$'),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('reserved','running','completed','failed','unknown')),
  root_id TEXT NOT NULL CHECK (root_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  relative_path TEXT NOT NULL CHECK (length(relative_path) BETWEEN 1 AND 1024),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('auto','sample-sheet')),
  previous_version_id TEXT REFERENCES managed_artifact_versions(id),
  version_id TEXT NOT NULL UNIQUE CHECK (version_id ~ '^av_[a-f0-9]{24}$'),
  artifact_id TEXT NOT NULL CHECK (artifact_id ~ '^af_[a-f0-9]{24}$'),
  storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 1 AND 2048),
  source_identity_json JSONB NOT NULL CHECK (octet_length(source_identity_json::text) <= 4096),
  source_metadata_json JSONB NOT NULL CHECK (octet_length(source_metadata_json::text) <= 4096),
  reserved_bytes BIGINT NOT NULL CHECK (reserved_bytes BETWEEN 1 AND 68719476736),
  bytes_copied BIGINT NOT NULL DEFAULT 0 CHECK (bytes_copied BETWEEN 0 AND reserved_bytes),
  process_id TEXT NOT NULL CHECK (process_id ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  error_code TEXT CHECK (error_code ~ '^[A-Z0-9_]{1,80}$'),
  error_message TEXT CHECK (length(error_message) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(project_id,owner_user_id,request_id),
  CHECK (expires_at > created_at),
  CHECK (status <> 'completed' OR (bytes_copied = reserved_bytes AND completed_at IS NOT NULL)),
  CHECK (status <> 'failed' OR (error_code IS NOT NULL AND error_message IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_server_data_import_owner
  ON server_data_imports(project_id,owner_user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_server_data_import_active
  ON server_data_imports(status,expires_at) WHERE status IN ('reserved','running','unknown');
CREATE OR REPLACE FUNCTION enforce_server_data_import_identity() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW.id,NEW.project_id,NEW.owner_user_id,NEW.request_id,NEW.request_sha256,
         NEW.root_id,NEW.relative_path,NEW.name,NEW.artifact_type,NEW.previous_version_id,
         NEW.version_id,NEW.artifact_id,NEW.storage_key,NEW.source_identity_json,
         NEW.source_metadata_json,NEW.reserved_bytes,NEW.process_id,NEW.expires_at,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.project_id,OLD.owner_user_id,OLD.request_id,OLD.request_sha256,
         OLD.root_id,OLD.relative_path,OLD.name,OLD.artifact_type,OLD.previous_version_id,
         OLD.version_id,OLD.artifact_id,OLD.storage_key,OLD.source_identity_json,
         OLD.source_metadata_json,OLD.reserved_bytes,OLD.process_id,OLD.expires_at,OLD.created_at)
  THEN RAISE EXCEPTION 'Server data import identity is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.bytes_copied < OLD.bytes_copied
  THEN RAISE EXCEPTION 'Server data import progress cannot decrease' USING ERRCODE='55000'; END IF;
  IF OLD.status IN ('completed','failed') AND
     ROW(NEW.status,NEW.bytes_copied,NEW.error_code,NEW.error_message,NEW.completed_at)
     IS DISTINCT FROM ROW(OLD.status,OLD.bytes_copied,OLD.error_code,OLD.error_message,OLD.completed_at)
  THEN RAISE EXCEPTION 'Terminal server data import evidence is immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_server_data_import_identity ON server_data_imports;
CREATE TRIGGER trg_server_data_import_identity BEFORE UPDATE ON server_data_imports
  FOR EACH ROW EXECUTE FUNCTION enforce_server_data_import_identity();


-- Research analyses are editable project documents, separate from live R objects
-- and immutable scientific artifact versions. Every saved draft has a retained
-- revision. Source references store identities/checksums, never source bytes.
CREATE TABLE IF NOT EXISTS research_analyses (
  id TEXT PRIMARY KEY CHECK(id ~ '^ra_[a-f0-9]{24}$'),
  project_id TEXT NOT NULL REFERENCES projects(id),
  created_by_user_id BIGINT NOT NULL REFERENCES users(id),
  request_id UUID NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  name TEXT NOT NULL CHECK(char_length(name) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '' CHECK(char_length(description) <= 8000),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  references_json JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK(jsonb_typeof(references_json)='array' AND jsonb_array_length(references_json)<=50 AND octet_length(references_json::text)<=65536),
  study_design_ref_json JSONB CHECK(study_design_ref_json IS NULL OR
    (jsonb_typeof(study_design_ref_json)='object' AND octet_length(study_design_ref_json::text)<=4096)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id,created_by_user_id,request_id),
  UNIQUE(id,project_id)
);
CREATE INDEX IF NOT EXISTS idx_research_analysis_project_created ON research_analyses(project_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_research_analysis_project_status ON research_analyses(project_id,status,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS research_analysis_revisions (
  analysis_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL CHECK(version > 0),
  actor_user_id BIGINT NOT NULL REFERENCES users(id),
  snapshot_json JSONB NOT NULL CHECK(jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=98304),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(analysis_id,version),
  FOREIGN KEY(analysis_id,project_id) REFERENCES research_analyses(id,project_id)
);
CREATE INDEX IF NOT EXISTS idx_research_analysis_revision_project ON research_analysis_revisions(project_id,analysis_id,version);

CREATE OR REPLACE FUNCTION enforce_research_analysis_identity() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW.id,NEW.project_id,NEW.created_by_user_id,NEW.request_id,NEW.request_sha256,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.created_by_user_id,OLD.request_id,OLD.request_sha256,OLD.created_at)
  THEN RAISE EXCEPTION 'Research analysis identity is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.version <> OLD.version+1
  THEN RAISE EXCEPTION 'Research analysis updates require a new draft version' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_research_analysis_identity ON research_analyses;
CREATE TRIGGER trg_research_analysis_identity BEFORE UPDATE ON research_analyses
  FOR EACH ROW EXECUTE FUNCTION enforce_research_analysis_identity();

CREATE OR REPLACE FUNCTION enforce_research_analysis_revision_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='DELETE' AND current_setting('app.demo_cleanup',true)='on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Research analysis revisions are append-only' USING ERRCODE='55000';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_research_analysis_revision_immutable ON research_analysis_revisions;
CREATE TRIGGER trg_research_analysis_revision_immutable BEFORE UPDATE OR DELETE ON research_analysis_revisions
  FOR EACH ROW EXECUTE FUNCTION enforce_research_analysis_revision_immutable();

-- Authored notebooks are explicitly shared project documents. Source remains
-- separate from private execution records; saving never executes code.
CREATE TABLE IF NOT EXISTS research_documents (
  id TEXT PRIMARY KEY CHECK(id ~ '^doc_[a-f0-9]{24}$'),
  project_id TEXT NOT NULL REFERENCES projects(id),
  analysis_id TEXT NOT NULL,
  created_by_user_id BIGINT NOT NULL REFERENCES users(id),
  updated_by_user_id BIGINT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL CHECK(char_length(title) BETWEEN 1 AND 160),
  version INTEGER NOT NULL CHECK(version > 0),
  head_version_id TEXT NOT NULL CHECK(head_version_id ~ '^dv_[a-f0-9]{24}$'),
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  content_bytes INTEGER NOT NULL CHECK(content_bytes BETWEEN 0 AND 1048576),
  cell_count INTEGER NOT NULL CHECK(cell_count BETWEEN 0 AND 2000),
  code_cell_count INTEGER NOT NULL CHECK(code_cell_count BETWEEN 0 AND cell_count),
  default_language TEXT NOT NULL CHECK(default_language IN ('R','python')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id,project_id,analysis_id),
  FOREIGN KEY(analysis_id,project_id) REFERENCES research_analyses(id,project_id)
);
CREATE INDEX IF NOT EXISTS idx_research_document_analysis_created ON research_documents(project_id,analysis_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS research_document_revisions (
  id TEXT PRIMARY KEY CHECK(id ~ '^dv_[a-f0-9]{24}$'),
  document_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  analysis_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  title TEXT NOT NULL CHECK(char_length(title) BETWEEN 1 AND 160),
  content_json JSONB NOT NULL CHECK(jsonb_typeof(content_json)='object' AND octet_length(content_json::text)<=2097152),
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  content_bytes INTEGER NOT NULL CHECK(content_bytes BETWEEN 0 AND 1048576),
  actor_user_id BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(document_id,version),
  UNIQUE(document_id,id),
  UNIQUE(document_id,id,version),
  FOREIGN KEY(document_id,project_id,analysis_id) REFERENCES research_documents(id,project_id,analysis_id)
);
CREATE INDEX IF NOT EXISTS idx_research_document_revision_project ON research_document_revisions(project_id,analysis_id,document_id,version);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_research_document_head' AND conrelid='research_documents'::regclass) THEN
    ALTER TABLE research_documents ADD CONSTRAINT fk_research_document_head
      FOREIGN KEY(id,head_version_id,version) REFERENCES research_document_revisions(document_id,id,version)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS research_document_submissions (
  project_id TEXT NOT NULL REFERENCES projects(id),
  analysis_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  actor_user_id BIGINT NOT NULL REFERENCES users(id),
  request_id UUID NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create','save')),
  request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  expected_version INTEGER,
  version_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,analysis_id,actor_user_id,request_id),
  FOREIGN KEY(document_id,project_id,analysis_id) REFERENCES research_documents(id,project_id,analysis_id),
  FOREIGN KEY(document_id,version_id) REFERENCES research_document_revisions(document_id,id),
  CHECK((action='create' AND expected_version IS NULL) OR (action='save' AND expected_version > 0))
);

CREATE OR REPLACE FUNCTION enforce_research_document_identity() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW.id,NEW.project_id,NEW.analysis_id,NEW.created_by_user_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.analysis_id,OLD.created_by_user_id,OLD.created_at)
  THEN RAISE EXCEPTION 'Notebook identity is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.version<>OLD.version+1 OR NEW.head_version_id=OLD.head_version_id
  THEN RAISE EXCEPTION 'Notebook updates require a new exact saved version' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_research_document_identity ON research_documents;
CREATE TRIGGER trg_research_document_identity BEFORE UPDATE ON research_documents
  FOR EACH ROW EXECUTE FUNCTION enforce_research_document_identity();

CREATE OR REPLACE FUNCTION enforce_research_document_evidence_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='DELETE' AND current_setting('app.demo_cleanup',true)='on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Notebook versions and save receipts are append-only' USING ERRCODE='55000';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_research_document_revision_immutable ON research_document_revisions;
CREATE TRIGGER trg_research_document_revision_immutable BEFORE UPDATE OR DELETE ON research_document_revisions
  FOR EACH ROW EXECUTE FUNCTION enforce_research_document_evidence_immutable();
DROP TRIGGER IF EXISTS trg_research_document_submission_immutable ON research_document_submissions;
CREATE TRIGGER trg_research_document_submission_immutable BEFORE UPDATE OR DELETE ON research_document_submissions
  FOR EACH ROW EXECUTE FUNCTION enforce_research_document_evidence_immutable();
