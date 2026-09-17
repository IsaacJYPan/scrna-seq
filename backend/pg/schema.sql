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
VALUES ('traceomics.runtime', 20260915, now())
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
      'scriptSha256', params ->> 'scriptSha256'
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
