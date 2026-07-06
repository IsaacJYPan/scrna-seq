-- ============================================================================
-- Postgres schema for the scRNA-seq Workbench (hosted-service database path).
--
-- This is the Postgres translation of the durable schema currently created by
-- backend/database.js (SQLite). It preserves the SAME table set, server-owned
-- identity, role/scope columns, the job state-machine columns, worker
-- coordination columns, artifact immutability semantics, and lineage DAG model.
--
-- Differences vs the SQLite DDL, all semantics-preserving:
--   * users.id uses GENERATED ALWAYS AS IDENTITY (was INTEGER AUTOINCREMENT).
--   * timestamps are TIMESTAMPTZ DEFAULT now() (was TEXT datetime('now')).
--   * JSON payload columns stay TEXT (JSON stored as a string) to mirror the
--     SQLite helpers exactly; JSONB is a documented future optimization.
--   * one-result-checkpoint-per-job immutability is enforced by a PARTIAL UNIQUE
--     INDEX (SQLite enforces this in the helper layer / CHECKPOINT_EXISTS).
--
-- Applied idempotently by scripts/init-postgres.js (CREATE TABLE IF NOT EXISTS /
-- CREATE INDEX IF NOT EXISTS). Server-generated ids (org_/proj_/ds_/ao_/job_/
-- art_/aoe_...) are chosen by the application, never by the client.
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

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

-- Pipeline definitions and user-project active selection. Manifests are
-- declarative module/tab definitions only; code, paths, endpoints, and R state
-- stay outside the manifest contract. Selection is scoped by BOTH project and
-- user so collaborators do not overwrite each other's active workflow.
CREATE TABLE IF NOT EXISTS pipeline_definitions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id),
  owner_user_id BIGINT NOT NULL REFERENCES users(id),
  visibility    TEXT NOT NULL DEFAULT 'user',
  name          TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pipeline_def_project ON pipeline_definitions(project_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_def_owner ON pipeline_definitions(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_def_visibility ON pipeline_definitions(visibility);

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

-- ── Jobs (durable, ownership-scoped; state machine + worker coordination) ────
CREATE TABLE IF NOT EXISTS jobs (
  id                        TEXT PRIMARY KEY,
  owner_user_id             BIGINT NOT NULL REFERENCES users(id),
  project_id                TEXT,
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
-- Artifact immutability: at most ONE result checkpoint per job. In SQLite this
-- invariant is enforced in the helper layer (CHECKPOINT_EXISTS); Postgres makes
-- it a hard partial-unique constraint so two racing workers cannot both write a
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
