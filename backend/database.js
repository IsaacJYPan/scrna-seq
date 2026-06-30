/**
 * SQLite Database Module (loaded by the Express server in server.js)
 *
 * Stores users, provenance records, cached results, and figure metadata
 * persistently. Uses better-sqlite3 for synchronous, fast SQLite access.
 *
 * All read/write helpers that touch user-owned data take a `userEmail`
 * argument and scope their SQL with `AND user_email = ?`. See
 * backend/security.test.js for the per-user isolation contract.
 */

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

let db;

/**
 * Initialize the database. Creates tables if they don't exist.
 * @param {string} dbPath - Path to the SQLite file
 */
function initDatabase(dbPath) {
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  // busy_timeout: when a write lock is briefly held (e.g. the job worker claiming
  // while a request writes), block-and-retry for up to 5s instead of throwing
  // SQLITE_BUSY immediately. A small, safe hardening for the single-process worker
  // shipped on this branch; true multi-process contention hardening is a follow-up.
  db.pragma('busy_timeout = 5000');

  db.exec(`
    -- Provenance records. Historically user-scoped (keyed by user_email). This
    -- branch adds an OPTIONAL project association so provenance created through a
    -- project workflow can be read by project members by role. project_id +
    -- created_by_user_id and the same-project reference columns
    -- (dataset_id / analysis_object_id / job_id / result_analysis_object_id) are
    -- NULL on legacy/owner-scoped rows. Project-scoped provenance is written with
    -- user_email = '' so it is fully decoupled from the owner-scoped user_email
    -- CRUD surface (list/get/delete all scope by a real, non-empty user_email),
    -- which also keeps it append-only — there is no project provenance
    -- delete/update route. R execution/state is untouched. See docs/architecture.md.
    CREATE TABLE IF NOT EXISTS provenance (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL DEFAULT '',
      project_id TEXT,
      created_by_user_id INTEGER,
      dataset_id TEXT,
      analysis_object_id TEXT,
      job_id TEXT,
      result_analysis_object_id TEXT,
      timestamp TEXT NOT NULL,
      language TEXT NOT NULL,
      language_version TEXT,
      packages TEXT DEFAULT '[]',
      script TEXT NOT NULL,
      parameters TEXT DEFAULT '{}',
      parent_ids TEXT DEFAULT '[]',
      operation TEXT DEFAULT 'unknown',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS results_cache (
      cache_key TEXT PRIMARY KEY,
      user_email TEXT NOT NULL DEFAULT '',
      provenance_id TEXT NOT NULL,
      result_data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (provenance_id) REFERENCES provenance(id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_prov_timestamp ON provenance(timestamp);
    CREATE INDEX IF NOT EXISTS idx_cache_prov ON results_cache(provenance_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

    -- Figure metadata. Historically user-scoped (keyed by user_email). This branch
    -- adds an OPTIONAL project association (project_id + created_by_user_id and the
    -- same-project reference columns analysis_object_id / job_id / provenance_id /
    -- dataset_id), NULL on legacy/owner-scoped rows. Project-scoped figures are
    -- written with user_email = '' (decoupled from the owner-scoped CRUD surface)
    -- and ALWAYS file_path = '' — a client never supplies a file path on the
    -- project route, and the project serializer never returns file_path. There is
    -- intentionally no figure file access/download surface in this branch.
    CREATE TABLE IF NOT EXISTS figure_collection (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      project_id TEXT,
      created_by_user_id INTEGER,
      analysis_object_id TEXT,
      job_id TEXT,
      provenance_id TEXT,
      dataset_id TEXT,
      object_id TEXT,
      plot_type TEXT NOT NULL,
      title TEXT DEFAULT '',
      params_json TEXT NOT NULL DEFAULT '{}',
      file_path TEXT DEFAULT '',
      file_format TEXT DEFAULT 'png',
      thumbnail_b64 TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_figures_user ON figure_collection(user_email);

    -- ── Analysis Objects & Lineage ────────────────────────────────
    -- A durable, ownership-scoped record for each analysis object (Seurat
    -- object, SCE, matrix, etc.). The R proxy verifies that a client-supplied
    -- object id maps to a real row owned by the authenticated user *before*
    -- deriving an R state key, so object ids can no longer be a client-
    -- controlled path into another user's R session state.
    --
    -- project_id (nullable) associates the object's *metadata/history* with a
    -- project so project members can list/read it by role; it does NOT change R
    -- state keying (still user/object-keyed) and does NOT remove creator
    -- ownership (owner_user_id). Legacy rows keep a NULL project_id; the new
    -- project-scoped creation path always sets it. See docs/architecture.md.
    CREATE TABLE IF NOT EXISTS analysis_objects (
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      project_id TEXT,
      dataset_id TEXT,
      parent_object_id TEXT,
      lineage_root_id TEXT,
      object_type TEXT NOT NULL,
      display_name TEXT,
      storage_uri TEXT,
      object_hash TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_by_provenance_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (owner_user_id) REFERENCES users(id),
      FOREIGN KEY (parent_object_id) REFERENCES analysis_objects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ao_owner ON analysis_objects(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_ao_dataset ON analysis_objects(dataset_id);
    CREATE INDEX IF NOT EXISTS idx_ao_parent ON analysis_objects(parent_object_id);
    CREATE INDEX IF NOT EXISTS idx_ao_lineage_root ON analysis_objects(lineage_root_id);
    CREATE INDEX IF NOT EXISTS idx_ao_prov ON analysis_objects(created_by_provenance_id);

    -- ── Jobs / Task Execution ─────────────────────────────────────
    -- A durable, ownership-scoped record for a unit of long-running analysis
    -- work (normalize, cluster, etc.). This is the foundation for moving
    -- long R/Seurat computation off the browser request/response path: a job
    -- has an owner, an optional target analysis object, an explicit status,
    -- the parameters it was created with, an append-only log, an optional
    -- structured error, and an optional result analysis object. Ownership is
    -- always taken from the authenticated session by the route layer; the id
    -- is server-generated. project_id (nullable) associates the job's metadata/
    -- history with a project for project-member visibility by role; it does NOT
    -- make R execution project-shared and does NOT remove creator ownership.
    -- NOTE: this branch adds the durable record + project metadata/API only —
    -- there is no worker/queue draining jobs yet (see docs/architecture.md).
    --
    -- The worker_id / claim_token / *_at lease columns + attempts / max_attempts /
    -- priority are the durable, versioned job-worker COORDINATION CONTRACT: they
    -- let a FUTURE worker safely claim, lease, heartbeat, release, and fail a job
    -- (see "Worker coordination" helpers below and
    -- docs/project-r-execution-design.md §3/§7). They are coordination metadata
    -- only — NO worker drains the queue in this branch, nothing sets status past
    -- 'queued' on its own, R execution is unchanged and still synchronous, and
    -- R active state remains user/object-keyed. claim_token is a bearer capability
    -- and is NEVER returned by the owner/project read APIs (rowToJob omits it).
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      project_id TEXT,
      analysis_object_id TEXT,
      result_analysis_object_id TEXT,
      dataset_id TEXT,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL,
      parameters_json TEXT NOT NULL DEFAULT '{}',
      logs_json TEXT NOT NULL DEFAULT '[]',
      error_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      canceled_at TEXT,
      -- Worker coordination (claim / lease / heartbeat). All nullable / defaulted
      -- so they are additive over legacy rows; see the idempotent migration below.
      worker_id TEXT,                         -- which worker currently holds the claim (NULL = unclaimed)
      claim_token TEXT,                       -- per-claim secret; heartbeat/complete/fail/release require a match
      lease_expires_at TEXT,                  -- claim is valid until this instant; past it the job is recoverable
      heartbeat_at TEXT,                      -- last heartbeat from the owning worker
      locked_at TEXT,                         -- when the current claim was acquired
      attempts INTEGER NOT NULL DEFAULT 0,    -- number of times this job has been claimed
      max_attempts INTEGER NOT NULL DEFAULT 1,-- claim budget; default 1 = at-most-once (no silent retry on crash)
      priority INTEGER NOT NULL DEFAULT 0,    -- higher is claimed first; default 0
      last_worker_error TEXT,                 -- JSON: most recent worker-level diagnostic (lease loss, crash, etc.)
      FOREIGN KEY (owner_user_id) REFERENCES users(id),
      FOREIGN KEY (analysis_object_id) REFERENCES analysis_objects(id),
      FOREIGN KEY (result_analysis_object_id) REFERENCES analysis_objects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_analysis_object ON jobs(analysis_object_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_result_object ON jobs(result_analysis_object_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(job_type);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);

    -- ── Organizations & Projects (membership + authorization foundation) ──
    -- The first durable org/project authorization model. This branch adds the
    -- membership tables + authorization helpers only; it does NOT migrate any
    -- existing user-scoped resource (analysis objects, jobs, provenance, cache,
    -- figures) into project ownership, and it does NOT touch R state keying.
    -- See docs/architecture.md. Org/project ids are server-generated
    -- (org_... / proj_...); clients never supply ids, owner, or role fields.
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (owner_user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_orgs_owner ON organizations(owner_user_id);

    -- One row per (organization, user) granting a role. The org creator gets an
    -- 'owner' row here at creation time; membership — not the organizations row —
    -- is the source of truth for "can this user see this org".
    CREATE TABLE IF NOT EXISTS organization_members (
      organization_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (organization_id, user_id),
      FOREIGN KEY (organization_id) REFERENCES organizations(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_by_user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organizations(id),
      FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organization_id);
    CREATE INDEX IF NOT EXISTS idx_projects_creator ON projects(created_by_user_id);

    -- One row per (project, user) granting a role. The project creator gets an
    -- 'owner' row at creation time. Project membership is independent of org
    -- membership in this branch (a project member need not be an org member);
    -- this is intentional for the narrow foundation and is documented in
    -- docs/architecture.md.
    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, user_id),
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

    -- ── Datasets (project-scoped durable dataset records) ──────────────
    -- The first durable, project-scoped resource. Each row is an uploaded or
    -- registered dataset belonging to exactly one project; access is governed by
    -- the caller's project_members role (see verifyDatasetProjectAccess). Identity
    -- is server-owned: ids are server-generated (ds_...), and the internal storage
    -- key / storage uri / sha256 / size are chosen/computed by the server, never
    -- supplied by the client. file_type / upload_status / validation_status are
    -- constrained to explicit allow-lists in the DB helpers. NOTE: this branch adds
    -- the durable dataset model + project-scoped API + datasetId verification only;
    -- analysis objects, jobs, and R state remain user-scoped (see
    -- docs/architecture.md).
    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL,
      created_by_user_id INTEGER NOT NULL,
      original_filename TEXT,
      internal_storage_key TEXT,
      storage_uri TEXT,
      file_type TEXT NOT NULL,
      file_size_bytes INTEGER,
      sha256 TEXT,
      upload_status TEXT NOT NULL,
      validation_status TEXT NOT NULL,
      validation_errors TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (owner_user_id) REFERENCES users(id),
      FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_datasets_project ON datasets(project_id);
    CREATE INDEX IF NOT EXISTS idx_datasets_owner ON datasets(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_datasets_creator ON datasets(created_by_user_id);
    CREATE INDEX IF NOT EXISTS idx_datasets_file_type ON datasets(file_type);
    CREATE INDEX IF NOT EXISTS idx_datasets_upload_status ON datasets(upload_status);
    CREATE INDEX IF NOT EXISTS idx_datasets_validation_status ON datasets(validation_status);
    CREATE INDEX IF NOT EXISTS idx_datasets_created ON datasets(created_at);
    CREATE INDEX IF NOT EXISTS idx_datasets_sha256 ON datasets(sha256);

    -- ── Job Artifacts & Checkpoints (durable output metadata) ──────────
    -- The durable, metadata-FIRST record of what a (future real) job handler
    -- produced: a checkpoint, a metrics blob, a log, a figure reference, a script
    -- fragment, or other metadata. This branch wires the model + a placeholder
    -- (checkpoint.noop) worker handler ONLY; there is NO raw artifact download,
    -- NO object storage, NO reproducibility bundle, NO generated-R-script export,
    -- and NO real R/Seurat pipeline writing here. R state remains user/object-keyed.
    --
    -- Identity & scope are server-owned: ids are server-generated (art_...),
    -- project_id + created_by_user_id are derived from the SOURCE JOB (never the
    -- client), and storage_uri / checksum / size / status are set by the trusted
    -- server/worker tier, never accepted from a request body. There is no public
    -- create route in this branch — artifact creation is worker/helper-driven.
    --
    -- project_id is NULL for an artifact produced by a legacy owner-scoped job, and
    -- a real project id for an artifact produced by a project-scoped job; the
    -- project read routes always pin a real project_id, so legacy NULL-project rows
    -- never leak into them. storage_uri is NEVER returned by the read APIs (the
    -- public projection omits it) so an internal/local path can never escape.
    CREATE TABLE IF NOT EXISTS job_artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      job_id TEXT NOT NULL,
      dataset_id TEXT,
      analysis_object_id TEXT,
      result_analysis_object_id TEXT,
      provenance_id TEXT,
      figure_id TEXT,
      created_by_user_id INTEGER NOT NULL,
      artifact_type TEXT NOT NULL,
      name TEXT,
      description TEXT,
      mime_type TEXT,
      storage_kind TEXT NOT NULL DEFAULT 'metadata_only',
      storage_uri TEXT,
      checksum_sha256 TEXT,
      size_bytes INTEGER,
      status TEXT NOT NULL DEFAULT 'available',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES jobs(id),
      FOREIGN KEY (created_by_user_id) REFERENCES users(id),
      FOREIGN KEY (analysis_object_id) REFERENCES analysis_objects(id),
      FOREIGN KEY (result_analysis_object_id) REFERENCES analysis_objects(id)
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

    -- ── Analysis object lineage edges (DAG-ready parent→child model) ───────
    -- The forward-looking, durable source of truth for analysis-object lineage as
    -- a DAG. analysis_objects.parent_object_id / lineage_root_id remain as
    -- COMPATIBILITY / fast-path fields for the common single-parent case; this
    -- edge table is what graph traversal (parents/children/lineage reads) uses and
    -- is what lets a FUTURE multi-parent operation (integration / comparison /
    -- merge) record several parents WITHOUT encoding them in metadata. This branch
    -- only writes single-parent 'checkpoint' edges (from the checkpoint helper) and
    -- backfills existing parent links as 'derived_from'; it does NOT add named
    -- branches, merge/integration semantics, or any mutating R/Seurat pipeline.
    --
    -- Identity & scope are server-owned: ids are server-generated (aoe_...),
    -- project_id is DERIVED from the parent/child objects (never client input), and
    -- created_by_user_id is the server-set actor. project_id is NULL for an edge
    -- between legacy owner-scoped (NULL-project) objects and a real project id for a
    -- project-scoped edge; the project lineage read routes always pin a real
    -- project_id, so legacy NULL-project edges never leak into them (same pattern as
    -- job_artifacts). An edge always stays WITHIN one scope: the helper refuses to
    -- link a parent and child whose project scopes differ. There is intentionally
    -- NO public edge-create route in this branch (edge creation is helper/worker-
    -- driven); the read routes are metadata-only.
    --
    -- The expression unique index treats a NULL job_id as '' so a (parent, child,
    -- job, parent_role, edge_type) tuple is unique even for the job-less backfill
    -- rows; that makes both the backfill (INSERT OR IGNORE) and re-running init
    -- idempotent — no duplicate edge on repeated startup/migration.
    CREATE TABLE IF NOT EXISTS analysis_object_edges (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_analysis_object_id TEXT NOT NULL,
      child_analysis_object_id TEXT NOT NULL,
      job_id TEXT,
      edge_type TEXT NOT NULL,
      parent_role TEXT NOT NULL DEFAULT 'primary',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_by_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (parent_analysis_object_id <> child_analysis_object_id),
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (parent_analysis_object_id) REFERENCES analysis_objects(id),
      FOREIGN KEY (child_analysis_object_id) REFERENCES analysis_objects(id),
      FOREIGN KEY (job_id) REFERENCES jobs(id),
      FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_aoe_project ON analysis_object_edges(project_id);
    CREATE INDEX IF NOT EXISTS idx_aoe_parent ON analysis_object_edges(parent_analysis_object_id);
    CREATE INDEX IF NOT EXISTS idx_aoe_child ON analysis_object_edges(child_analysis_object_id);
    CREATE INDEX IF NOT EXISTS idx_aoe_job ON analysis_object_edges(job_id);
    CREATE INDEX IF NOT EXISTS idx_aoe_type ON analysis_object_edges(edge_type);
    CREATE INDEX IF NOT EXISTS idx_aoe_project_parent ON analysis_object_edges(project_id, parent_analysis_object_id);
    CREATE INDEX IF NOT EXISTS idx_aoe_project_child ON analysis_object_edges(project_id, child_analysis_object_id);
    CREATE INDEX IF NOT EXISTS idx_aoe_project_job ON analysis_object_edges(project_id, job_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_aoe_unique ON analysis_object_edges(
      parent_analysis_object_id, child_analysis_object_id, COALESCE(job_id, ''), parent_role, edge_type
    );
  `);

  // ── Schema migration: add 'operation' column if missing (for pre-existing DBs) ──
  const cols = db.prepare("PRAGMA table_info(provenance)").all().map(c => c.name);
  if (!cols.includes('operation')) {
    db.exec("ALTER TABLE provenance ADD COLUMN operation TEXT DEFAULT 'unknown'");
    console.log('[DB] Migrated: added operation column to provenance table');
  }
  if (!cols.includes('user_email')) {
    db.exec("ALTER TABLE provenance ADD COLUMN user_email TEXT NOT NULL DEFAULT ''");
    console.log('[DB] Migrated: added user_email column to provenance table');
  }

  const cacheCols = db.prepare("PRAGMA table_info(results_cache)").all().map(c => c.name);
  if (!cacheCols.includes('user_email')) {
    db.exec("ALTER TABLE results_cache ADD COLUMN user_email TEXT NOT NULL DEFAULT ''");
    console.log('[DB] Migrated: added user_email column to results_cache table');
  }

  // Add jobs.dataset_id for pre-existing DBs (the column is part of the CREATE
  // above for fresh DBs; this branch lets a job reference a verified dataset).
  const jobCols = db.prepare("PRAGMA table_info(jobs)").all().map(c => c.name);
  if (!jobCols.includes('dataset_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN dataset_id TEXT');
    console.log('[DB] Migrated: added dataset_id column to jobs table');
  }
  // Created here (not in the CREATE block above) so it runs only after the column
  // is guaranteed to exist on a pre-existing jobs table.
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_dataset ON jobs(dataset_id)');

  // Add project_id to analysis_objects/jobs for pre-existing DBs (the column is
  // part of the CREATE above for fresh DBs). Project scope is additive metadata:
  // existing rows keep a NULL project_id (legacy user-scoped records that remain
  // readable only through the owner-scoped routes), while the new project-scoped
  // creation paths always set it. Idempotent — only ALTER when the column is
  // absent. This does NOT touch R state keying or creator ownership.
  const aoProjCols = db.prepare("PRAGMA table_info(analysis_objects)").all().map(c => c.name);
  if (!aoProjCols.includes('project_id')) {
    db.exec('ALTER TABLE analysis_objects ADD COLUMN project_id TEXT');
    console.log('[DB] Migrated: added project_id column to analysis_objects table');
  }
  const jobProjCols = db.prepare("PRAGMA table_info(jobs)").all().map(c => c.name);
  if (!jobProjCols.includes('project_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN project_id TEXT');
    console.log('[DB] Migrated: added project_id column to jobs table');
  }
  // Created here (not in the CREATE block above) so the project_id composite
  // indexes run only after the column is guaranteed to exist on a pre-existing
  // analysis_objects / jobs table.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ao_project ON analysis_objects(project_id);
    CREATE INDEX IF NOT EXISTS idx_ao_project_dataset ON analysis_objects(project_id, dataset_id);
    CREATE INDEX IF NOT EXISTS idx_ao_project_parent ON analysis_objects(project_id, parent_object_id);
    CREATE INDEX IF NOT EXISTS idx_ao_project_lineage_root ON analysis_objects(project_id, lineage_root_id);
    CREATE INDEX IF NOT EXISTS idx_ao_project_owner ON analysis_objects(project_id, owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_project_status ON jobs(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_jobs_project_analysis_object ON jobs(project_id, analysis_object_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_project_result_object ON jobs(project_id, result_analysis_object_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_project_dataset ON jobs(project_id, dataset_id);
  `);

  // ── Worker coordination columns on jobs (durable claim/lease/heartbeat) ──────
  // Part of the CREATE block above for fresh DBs; this migrates pre-existing DBs.
  // Every column is nullable or NOT NULL with a DEFAULT, so the ALTERs are purely
  // ADDITIVE: legacy job rows are left untouched and simply inherit the defaults
  // (worker_id/claim_token/lease NULL, attempts 0, max_attempts 1, priority 0) —
  // no old job is backfilled into 'running' or otherwise re-statused, and existing
  // job IDs are unchanged. Idempotent: each column is only ALTERed when absent, so
  // re-running initDatabase (and a fresh DB, where the column already exists) is a
  // no-op. This does NOT add a worker, drain the queue, or change R execution.
  const jobWorkerCols = db.prepare("PRAGMA table_info(jobs)").all().map(c => c.name);
  for (const [col, ddl] of [
    ['worker_id', 'ALTER TABLE jobs ADD COLUMN worker_id TEXT'],
    ['claim_token', 'ALTER TABLE jobs ADD COLUMN claim_token TEXT'],
    ['lease_expires_at', 'ALTER TABLE jobs ADD COLUMN lease_expires_at TEXT'],
    ['heartbeat_at', 'ALTER TABLE jobs ADD COLUMN heartbeat_at TEXT'],
    ['locked_at', 'ALTER TABLE jobs ADD COLUMN locked_at TEXT'],
    ['attempts', 'ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0'],
    ['max_attempts', 'ALTER TABLE jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 1'],
    ['priority', 'ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0'],
    ['last_worker_error', 'ALTER TABLE jobs ADD COLUMN last_worker_error TEXT']
  ]) {
    if (!jobWorkerCols.includes(col)) {
      db.exec(ddl);
      console.log(`[DB] Migrated: added ${col} column to jobs table (worker coordination)`);
    }
  }
  // Created here (not in the CREATE block above) so the worker-coordination indexes
  // run only after the columns are guaranteed to exist on a pre-existing jobs table.
  // idx_jobs_claimable backs the claim ordering (queued first, then priority desc,
  // then oldest); idx_jobs_lease backs expired-lease recovery sweeps; idx_jobs_worker
  // backs lookups of a given worker's jobs.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_jobs_claimable ON jobs(status, priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_worker ON jobs(worker_id);
  `);

  // Add the optional project-association columns to provenance / figure_collection
  // for pre-existing DBs (part of the CREATE blocks above for fresh DBs). Project
  // scope is additive metadata: legacy rows keep NULL project_id and stay reachable
  // only through the owner-scoped routes; the project-scoped creation paths set it.
  // Idempotent — only ALTER when a column is absent. Does NOT touch R state keying,
  // creator ownership, or the figure file-path validation.
  const provCols2 = db.prepare("PRAGMA table_info(provenance)").all().map(c => c.name);
  for (const [col, ddl] of [
    ['project_id', 'ALTER TABLE provenance ADD COLUMN project_id TEXT'],
    ['created_by_user_id', 'ALTER TABLE provenance ADD COLUMN created_by_user_id INTEGER'],
    ['dataset_id', 'ALTER TABLE provenance ADD COLUMN dataset_id TEXT'],
    ['analysis_object_id', 'ALTER TABLE provenance ADD COLUMN analysis_object_id TEXT'],
    ['job_id', 'ALTER TABLE provenance ADD COLUMN job_id TEXT'],
    ['result_analysis_object_id', 'ALTER TABLE provenance ADD COLUMN result_analysis_object_id TEXT']
  ]) {
    if (!provCols2.includes(col)) {
      db.exec(ddl);
      console.log(`[DB] Migrated: added ${col} column to provenance table`);
    }
  }
  const figCols = db.prepare("PRAGMA table_info(figure_collection)").all().map(c => c.name);
  for (const [col, ddl] of [
    ['project_id', 'ALTER TABLE figure_collection ADD COLUMN project_id TEXT'],
    ['created_by_user_id', 'ALTER TABLE figure_collection ADD COLUMN created_by_user_id INTEGER'],
    ['analysis_object_id', 'ALTER TABLE figure_collection ADD COLUMN analysis_object_id TEXT'],
    ['job_id', 'ALTER TABLE figure_collection ADD COLUMN job_id TEXT'],
    ['provenance_id', 'ALTER TABLE figure_collection ADD COLUMN provenance_id TEXT'],
    ['dataset_id', 'ALTER TABLE figure_collection ADD COLUMN dataset_id TEXT']
  ]) {
    if (!figCols.includes(col)) {
      db.exec(ddl);
      console.log(`[DB] Migrated: added ${col} column to figure_collection table`);
    }
  }
  // Created here (not in the CREATE blocks above) so the project_id composite
  // indexes run only after the columns are guaranteed to exist on pre-existing
  // provenance / figure_collection tables.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_prov_project ON provenance(project_id);
    CREATE INDEX IF NOT EXISTS idx_prov_project_dataset ON provenance(project_id, dataset_id);
    CREATE INDEX IF NOT EXISTS idx_prov_project_analysis_object ON provenance(project_id, analysis_object_id);
    CREATE INDEX IF NOT EXISTS idx_prov_project_job ON provenance(project_id, job_id);
    CREATE INDEX IF NOT EXISTS idx_figures_project ON figure_collection(project_id);
    CREATE INDEX IF NOT EXISTS idx_figures_project_analysis_object ON figure_collection(project_id, analysis_object_id);
    CREATE INDEX IF NOT EXISTS idx_figures_project_job ON figure_collection(project_id, job_id);
    CREATE INDEX IF NOT EXISTS idx_figures_project_provenance ON figure_collection(project_id, provenance_id);
    CREATE INDEX IF NOT EXISTS idx_figures_project_dataset ON figure_collection(project_id, dataset_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_prov_user ON provenance(user_email);
    CREATE INDEX IF NOT EXISTS idx_cache_user ON results_cache(user_email);
  `);

  // ── Backfill lineage edges from existing single-parent links ────────────────
  // Every analysis object that already has a parent_object_id gets a durable
  // `derived_from` edge so the edge table is the complete graph source even for
  // pre-existing data. This is pure SQL and idempotent:
  //   - INSERT OR IGNORE + the expression unique index (parent, child,
  //     COALESCE(job_id,''), parent_role, edge_type) means a second run inserts
  //     nothing, so repeated startup/migration never duplicates a backfilled edge.
  //   - The JOIN to the parent row means a child whose parent_object_id points at a
  //     missing/bad historical row is simply skipped (no crash, no orphan edge).
  //   - `parent.project_id IS child.project_id` confines the edge to ONE scope:
  //     legacy NULL↔NULL pairs match (legacy edges stay NULL-project) and a real
  //     project pair matches, but a cross-project parent link (different/NULL vs
  //     real project) is intentionally NOT backfilled, so a bad legacy cross-project
  //     link never leaks into a project's lineage graph.
  // created_by_user_id / created_at are taken from the CHILD row (the object whose
  // lineage this records); job_id is NULL because legacy links predate the job that
  // produced them. This does NOT touch parent_object_id / lineage_root_id, which
  // remain the compatibility/fast-path fields.
  db.exec(`
    INSERT OR IGNORE INTO analysis_object_edges
      (id, project_id, parent_analysis_object_id, child_analysis_object_id, job_id,
       edge_type, parent_role, metadata_json, created_by_user_id, created_at)
    SELECT
      'aoe_' || lower(hex(randomblob(12))),
      child.project_id,
      child.parent_object_id,
      child.id,
      NULL,
      'derived_from',
      'primary',
      '{}',
      child.owner_user_id,
      child.created_at
    FROM analysis_objects child
    JOIN analysis_objects parent ON parent.id = child.parent_object_id
    WHERE child.parent_object_id IS NOT NULL
      AND parent.project_id IS child.project_id
      AND NOT EXISTS (
        SELECT 1 FROM analysis_object_edges e
        WHERE e.parent_analysis_object_id = child.parent_object_id
          AND e.child_analysis_object_id = child.id
      );
  `);

  console.log('[DB] Database initialized at', dbPath);
  return db;
}

// ── Provenance CRUD ──────────────────────────────────────────────

const _insertProv = () => db.prepare(`
  INSERT OR REPLACE INTO provenance
    (id, user_email, timestamp, language, language_version, packages, script, parameters, parent_ids, operation)
  VALUES
    (@id, @userEmail, @timestamp, @language, @languageVersion, @packages, @script, @parameters, @parentIds, @operation)
`);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// User-owned helpers must never be called without an owner: a missing owner
// previously meant "match every row" (e.g. getAllProvenance() returning every
// user's provenance), which is a cross-user data-leak footgun. Every read/write
// helper that scopes by user_email funnels its owner argument through here so an
// absent owner fails loudly instead of silently widening the query. If an
// admin-wide query is ever genuinely needed, add an explicitly named
// admin-only helper rather than relaxing this.
function requireOwnerEmail(userEmail) {
  const normalized = normalizeEmail(userEmail);
  if (!normalized) {
    throw new Error('An owner email is required for this user-scoped operation.');
  }
  return normalized;
}

function saveProvenance(envelope) {
  const prov = envelope.provenance;
  // Owner-scoped write: require an owner email like every other user-scoped
  // helper (see requireOwnerEmail). A missing owner would persist a provenance
  // row no user can ever read (reads are owner-scoped), an orphaning footgun.
  const owner = requireOwnerEmail(envelope.userEmail || prov.userEmail);
  const id = String(prov.id || '');
  // `_insertProv` is INSERT OR REPLACE, which keys on the primary key (id) alone.
  // Without this guard the owner-scoped route could overwrite a row owned by a
  // different user — or a project-scoped row (user_email = '') — and re-home it
  // onto the caller's owner-scoped surface (mirror of saveFigure's ownership
  // guard). Reject any pre-existing row that is not the caller's own, surfaced as
  // a generic not-found so a cross-user/project row's existence is not revealed.
  const existing = db.prepare('SELECT user_email FROM provenance WHERE id = ?').get(id);
  if (existing && normalizeEmail(existing.user_email) !== owner) {
    throw codedError('PROVENANCE_NOT_FOUND', 'Provenance record not found.');
  }
  _insertProv().run({
    id,
    userEmail: owner,
    timestamp: String(prov.timestamp || ''),
    language: String(prov.language || ''),
    languageVersion: String(prov.languageVersion || ''),
    packages: JSON.stringify(prov.packages || []),
    script: String(prov.script || ''),
    parameters: JSON.stringify(prov.parameters || {}),
    parentIds: JSON.stringify(prov.parentIds || []),
    operation: String(prov.operation || 'unknown')
  });
  return prov.id;
}

function getProvenance(id, userEmail) {
  const owner = requireOwnerEmail(userEmail);
  const row = db.prepare('SELECT * FROM provenance WHERE id = ? AND user_email = ?').get(id, owner);
  if (!row) return null;
  return rowToProvenance(row);
}

function getAllProvenance(userEmail) {
  const owner = requireOwnerEmail(userEmail);
  const rows = db.prepare('SELECT * FROM provenance WHERE user_email = ? ORDER BY created_at DESC').all(owner);
  return rows.map(rowToProvenance);
}

function rowToProvenance(row) {
  return {
    id: row.id,
    userEmail: row.user_email,
    timestamp: row.timestamp,
    language: row.language,
    languageVersion: row.language_version,
    packages: JSON.parse(row.packages),
    script: row.script,
    parameters: JSON.parse(row.parameters),
    parentIds: JSON.parse(row.parent_ids),
    operation: row.operation || 'unknown'
  };
}

// ── DAG Traversal ────────────────────────────────────────────────

/**
 * Walk the provenance DAG backwards from a given ID.
 * Returns all ancestor provenance records in topological order
 * (dependencies first), with shared ancestors deduplicated.
 */
function getProvenanceChain(id, userEmail) {
  requireOwnerEmail(userEmail);
  const visited = new Set();
  const ordered = [];

  function walk(currentId) {
    if (visited.has(currentId)) return;
    visited.add(currentId);

    const prov = getProvenance(currentId, userEmail);
    if (!prov) return;

    // Walk parents first (depth-first, dependencies before dependents)
    for (const parentId of prov.parentIds) {
      walk(parentId);
    }
    ordered.push(prov);
  }

  walk(id);
  return ordered;
}

/**
 * Delete a single provenance record by ID.
 */
function deleteProvenance(id, userEmail) {
  const owner = requireOwnerEmail(userEmail);
  const result = db.prepare('DELETE FROM provenance WHERE id = ? AND user_email = ?').run(id, owner);
  // Also clean up any cache entries referencing this provenance (owner-scoped).
  db.prepare('DELETE FROM results_cache WHERE provenance_id = ? AND user_email = ?').run(id, owner);
  return result.changes > 0;
}

// NOTE: Cross-user cascade-delete helpers (formerly `deleteProvenanceAfter`
// and `deleteDownstreamProvenance`) were removed in the production-hardening
// pass. They issued unscoped `DELETE ... WHERE created_at > ?` / `WHERE
// operation IN (...)` statements with no `user_email` predicate, so wiring
// them into any route would have let one user wipe another user's provenance.
// They were never routed. If cascade invalidation is reintroduced, it must be
// user-scoped (take `userEmail`, add `AND user_email = ?`) and covered by an
// isolation test in backend/security.test.js, mirroring `deleteProvenance`.

// ── Results Cache ────────────────────────────────────────────────

/**
 * Generate a cache key from operation name + parameters + data version + parent dependencies.
 */
function makeCacheKey(operation, params, dataVersion, parentIds = [], userEmail = '') {
  const payload = JSON.stringify({ operation, params, dataVersion, parentIds, userEmail: normalizeEmail(userEmail) });
  return crypto.createHash('sha256').update(payload).digest('hex').substring(0, 16);
}

function getCachedResult(cacheKey, userEmail) {
  const owner = requireOwnerEmail(userEmail);
  const row = db.prepare('SELECT * FROM results_cache WHERE cache_key = ? AND user_email = ?').get(cacheKey, owner);
  if (!row) return null;
  return {
    cacheKey: row.cache_key,
    provenanceId: row.provenance_id,
    result: JSON.parse(row.result_data)
  };
}

function setCachedResult(cacheKey, provenanceId, resultData, userEmail) {
  const owner = requireOwnerEmail(userEmail);
  const provOwner = db.prepare('SELECT id FROM provenance WHERE id = ? AND user_email = ?').get(provenanceId, owner);
  if (!provOwner) throw new Error('Cannot cache result for provenance owned by another user.');
  db.prepare(`
    INSERT OR REPLACE INTO results_cache (cache_key, user_email, provenance_id, result_data)
    VALUES (?, ?, ?, ?)
  `).run(cacheKey, owner, provenanceId, JSON.stringify(resultData));
}

function clearCache(userEmail) {
  const owner = requireOwnerEmail(userEmail);
  db.prepare('DELETE FROM results_cache WHERE user_email = ?').run(owner);
}

// ── User Authentication ─────────────────────────────────────────

const PBKDF2_ITERATIONS = 600000;
// Fixed salt used only to spend an equivalent amount of PBKDF2 work on the
// "user not found" branch of verifyUser(). It never protects a real secret; its
// sole purpose is to remove a user-enumeration timing oracle.
const DUMMY_PBKDF2_SALT = '00000000000000000000000000000000';

function hashPassword(password, salt) {
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512').toString('hex');
  return `$pbkdf2-sha512$i=${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

// Constant-time comparison for two hex-encoded hashes of the same expected
// length. Returns false (without an exception) on a length mismatch; the hashes
// compared here are fixed-length, so a length difference reveals nothing useful.
function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function createUser(email, password, displayName) {
  const normalizedEmail = email.trim().toLowerCase();

  // Check if user already exists
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) {
    return { error: 'An account with this email already exists.' };
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);

  const result = db.prepare(`
    INSERT INTO users (email, password_hash, salt, display_name)
    VALUES (?, ?, ?, ?)
  `).run(normalizedEmail, passwordHash, salt, displayName.trim());

  return {
    id: result.lastInsertRowid,
    email: normalizedEmail,
    displayName: displayName.trim()
  };
}

// A single generic credential-failure message for BOTH "no such user" and
// "wrong password". The caller (the /api/auth/login route) returns a generic
// 401 regardless, but keeping the message identical here avoids leaking which
// branch failed to any internal consumer.
const GENERIC_CREDENTIAL_ERROR = 'Invalid email or password.';

function verifyUser(email, password) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);

  if (!user) {
    // Defense-in-depth: spend roughly the same PBKDF2 work as a real
    // verification so the not-found branch is not measurably faster, removing a
    // user-enumeration timing oracle. The result is discarded.
    crypto.pbkdf2Sync(String(password), DUMMY_PBKDF2_SALT, PBKDF2_ITERATIONS, 64, 'sha512');
    return { error: GENERIC_CREDENTIAL_ERROR };
  }

  // Parse the stored hash to see if it uses the new format or fallback to old format
  const storedHash = user.password_hash;
  let isMatch = false;

  if (storedHash.startsWith('$pbkdf2-sha512$')) {
    const parts = storedHash.split('$');
    const iters = parseInt(parts[2].split('=')[1], 10);
    const salt = parts[3];
    const hashData = parts[4];
    const attemptHash = crypto.pbkdf2Sync(password, salt, iters, 64, 'sha512').toString('hex');
    isMatch = timingSafeEqualHex(attemptHash, hashData);
  } else {
    // Old legacy hash format
    const attemptHash = crypto.pbkdf2Sync(password, user.salt, 100000, 64, 'sha512').toString('hex');
    isMatch = timingSafeEqualHex(attemptHash, storedHash);
  }

  if (!isMatch) {
    return { error: GENERIC_CREDENTIAL_ERROR };
  }

  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    createdAt: user.created_at
  };
}

function getUserByEmail(email) {
  const row = db.prepare('SELECT id, email, display_name, created_at FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!row) return null;
  return { id: row.id, email: row.email, displayName: row.display_name, createdAt: row.created_at };
}

// ── Figure Collection ───────────────────────────────────────────

// Reject obviously unsafe figure file paths. `file_path` is stored verbatim as
// a reference to a server-written export; it must never carry path-traversal
// segments or NUL bytes. There is intentionally no download route, so this is
// purely a stored-value hygiene guard against traversal-like input being
// persisted (and later trusted by some future consumer). Both relative and
// absolute paths are allowed (R legitimately returns an absolute export path);
// only traversal / NUL / non-string values are rejected.
function assertSafeFigureFilePath(filePath) {
  if (filePath === undefined || filePath === null || filePath === '') return '';
  if (typeof filePath !== 'string') {
    throw new Error('Figure file path must be a string.');
  }
  if (filePath.includes('\0')) {
    throw new Error('Figure file path is invalid.');
  }
  const segments = filePath.split(/[\\/]+/);
  if (segments.includes('..')) {
    throw new Error('Figure file path must not contain path traversal segments.');
  }
  return filePath;
}

function saveFigure(record) {
  const userEmail = normalizeEmail(record.userEmail);
  if (!userEmail) throw new Error('Figure user email is required.');

  const safeFilePath = assertSafeFigureFilePath(record.filePath);

  const existing = db.prepare('SELECT user_email FROM figure_collection WHERE id = ?').get(record.id);
  if (existing && normalizeEmail(existing.user_email) !== userEmail) {
    throw new Error('Cannot replace a figure owned by another user.');
  }

  db.prepare(`
    INSERT OR REPLACE INTO figure_collection
      (id, user_email, object_id, plot_type, title, params_json, file_path, file_format, thumbnail_b64)
    VALUES
      (@id, @userEmail, @objectId, @plotType, @title, @paramsJson, @filePath, @fileFormat, @thumbnailB64)
  `).run({
    id: record.id,
    userEmail,
    objectId: record.objectId || '',
    plotType: record.plotType || 'Unknown',
    title: record.title || '',
    paramsJson: JSON.stringify(record.params || {}),
    filePath: safeFilePath || '',
    fileFormat: record.fileFormat || 'png',
    thumbnailB64: record.thumbnailB64 || ''
  });
  return record.id;
}

function getFiguresByUser(email) {
  const rows = db.prepare(
    'SELECT * FROM figure_collection WHERE user_email = ? ORDER BY created_at DESC'
  ).all(normalizeEmail(email));
  return rows.map(r => ({
    id: r.id,
    userEmail: r.user_email,
    objectId: r.object_id,
    plotType: r.plot_type,
    title: r.title,
    params: JSON.parse(r.params_json || '{}'),
    filePath: r.file_path,
    fileFormat: r.file_format,
    thumbnailB64: r.thumbnail_b64,
    createdAt: r.created_at
  }));
}

function deleteFigure(id, userEmail) {
  const owner = requireOwnerEmail(userEmail);
  const result = db.prepare('DELETE FROM figure_collection WHERE id = ? AND user_email = ?').run(id, owner);
  return result.changes > 0;
}

// ── Analysis Objects & Lineage ───────────────────────────────────
//
// Object identity is server-owned. Callers never choose object ids and
// never assert ownership: `owner_user_id` is always taken from the
// authenticated identity by the route layer and passed in here. Every read
// helper is owner-scoped so a row owned by another user is indistinguishable
// from a row that does not exist.

const ALLOWED_OBJECT_TYPES = new Set([
  'seurat', 'sce', 'anndata', 'matrix', 'assay', 'reduction', 'generic'
]);

function isValidObjectType(objectType) {
  return ALLOWED_OBJECT_TYPES.has(objectType);
}

function generateAnalysisObjectId() {
  // Server-generated, R-header-safe by construction: `ao_` + lowercase hex.
  return `ao_${crypto.randomBytes(12).toString('hex')}`;
}

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function rowToAnalysisObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    projectId: row.project_id,
    datasetId: row.dataset_id,
    parentObjectId: row.parent_object_id,
    lineageRootId: row.lineage_root_id,
    objectType: row.object_type,
    displayName: row.display_name,
    storageUri: row.storage_uri,
    objectHash: row.object_hash,
    metadata: JSON.parse(row.metadata_json || '{}'),
    createdByProvenanceId: row.created_by_provenance_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getAnalysisObjectForUser(id, ownerUserId) {
  const row = db.prepare(
    'SELECT * FROM analysis_objects WHERE id = ? AND owner_user_id = ?'
  ).get(String(id), Number(ownerUserId));
  return rowToAnalysisObject(row);
}

/**
 * Returns true only if `objectId` is a real persisted analysis object owned by
 * `ownerUserId`. This is the gate the R proxy calls before deriving a state key.
 */
function verifyAnalysisObjectOwner(ownerUserId, objectId) {
  if (typeof objectId !== 'string' || objectId === '') return false;
  const row = db.prepare(
    'SELECT 1 FROM analysis_objects WHERE id = ? AND owner_user_id = ?'
  ).get(objectId, Number(ownerUserId));
  return !!row;
}

function listAnalysisObjectsForUser(ownerUserId, filters = {}) {
  const clauses = ['owner_user_id = ?'];
  const params = [Number(ownerUserId)];

  if (filters.datasetId) { clauses.push('dataset_id = ?'); params.push(String(filters.datasetId)); }
  if (filters.parentObjectId) { clauses.push('parent_object_id = ?'); params.push(String(filters.parentObjectId)); }
  if (filters.lineageRootId) { clauses.push('lineage_root_id = ?'); params.push(String(filters.lineageRootId)); }
  if (filters.objectType) { clauses.push('object_type = ?'); params.push(String(filters.objectType)); }

  const rows = db.prepare(
    `SELECT * FROM analysis_objects WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`
  ).all(...params);
  return rows.map(rowToAnalysisObject);
}

/**
 * Create an analysis object owned by `ownerUserId`.
 *
 * The id is always server-generated. Parent ownership is enforced here as a
 * second line of defense even though the route also validates it. Throws a
 * coded Error (`INVALID_OBJECT_TYPE`, `INVALID_METADATA`, `INVALID_OWNER`,
 * `PARENT_NOT_FOUND`) so the route can map to the right HTTP status.
 */
function createAnalysisObjectForUser(ownerUserId, input = {}) {
  const owner = Number(ownerUserId);
  if (!Number.isInteger(owner) || owner <= 0) {
    throw codedError('INVALID_OWNER', 'A valid authenticated user is required.');
  }

  const objectType = typeof input.objectType === 'string' ? input.objectType.trim() : '';
  if (!isValidObjectType(objectType)) {
    throw codedError('INVALID_OBJECT_TYPE',
      `Invalid objectType. Allowed: ${[...ALLOWED_OBJECT_TYPES].join(', ')}.`);
  }

  const metadata = input.metadata === undefined ? {} : input.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw codedError('INVALID_METADATA', 'metadata must be a plain JSON object.');
  }

  // A supplied datasetId must reference a real dataset whose project the caller
  // can write to (owner/admin/analyst). Defense-in-depth: the route also checks
  // id format (400) before calling this. Unknown/inaccessible → DATASET_NOT_FOUND
  // (404, no cross-project/cross-user existence leak); viewer → FORBIDDEN (403).
  if (input.datasetId !== undefined && input.datasetId !== null) {
    verifyDatasetProjectAccess(owner, String(input.datasetId), DATASET_WRITE_ROLES);
  }

  const parentObjectId = input.parentObjectId ? String(input.parentObjectId) : null;
  let lineageRootId = null;
  if (parentObjectId) {
    const parent = getAnalysisObjectForUser(parentObjectId, owner);
    if (!parent) {
      throw codedError('PARENT_NOT_FOUND', 'Parent analysis object not found.');
    }
    // Inherit the parent's lineage root, or adopt the parent itself as root.
    lineageRootId = parent.lineageRootId || parent.id;
  }

  const id = generateAnalysisObjectId();
  db.prepare(`
    INSERT INTO analysis_objects
      (id, owner_user_id, dataset_id, parent_object_id, lineage_root_id, object_type,
       display_name, storage_uri, object_hash, metadata_json, created_by_provenance_id)
    VALUES
      (@id, @owner, @datasetId, @parentObjectId, @lineageRootId, @objectType,
       @displayName, @storageUri, @objectHash, @metadataJson, @createdByProvenanceId)
  `).run({
    id,
    owner,
    datasetId: input.datasetId ? String(input.datasetId) : null,
    parentObjectId,
    lineageRootId,
    objectType,
    displayName: input.displayName != null ? String(input.displayName) : null,
    storageUri: input.storageUri != null ? String(input.storageUri) : null,
    objectHash: input.objectHash != null ? String(input.objectHash) : null,
    metadataJson: JSON.stringify(metadata),
    createdByProvenanceId: input.createdByProvenanceId ? String(input.createdByProvenanceId) : null
  });

  // A root object with no parent is its own lineage root. Done as a second
  // step because the id is only known after insert.
  if (!parentObjectId) {
    db.prepare('UPDATE analysis_objects SET lineage_root_id = id WHERE id = ?').run(id);
  }

  return getAnalysisObjectForUser(id, owner);
}

// ── Jobs / Task Execution ────────────────────────────────────────
//
// Durable, ownership-scoped records for long-running analysis work. Like
// analysis objects, job identity is server-owned: callers never choose a job
// id and never assert ownership — `owner_user_id` is always supplied by the
// route layer from the authenticated identity. Every read/write helper is
// owner-scoped so a job owned by another user is indistinguishable from one
// that does not exist. Status is server-managed and only ever changes through
// `validateJobTransition`; clients cannot set an arbitrary status.

const ALLOWED_JOB_TYPES = new Set([
  'normalize', 'qc_filter', 'pca', 'cluster', 'umap', 'find_markers', 'integrate', 'generic',
  // Test-safe placeholder type that exercises the artifact/checkpoint wiring WITHOUT
  // running any R/Seurat pipeline. Handled by the worker's `checkpoint.noop` handler
  // (jobWorker.js); produces metadata-only artifacts + an immutable checkpoint object
  // clearly labeled placeholder. NOT a real scientific output. See docs/architecture.md.
  'checkpoint.noop',
  // Minimal worker-to-R bridge type: the ONLY job type that invokes the R backend.
  // It runs exactly one allowlisted, read-only, metadata-only operation (an R runtime
  // health/version check via the existing /health endpoint) through server-controlled
  // code — NO arbitrary R, NO analysis-object access, NO mutation, NO checkpoint. The
  // worker's `r.runtime.check` handler (jobWorker.js) drives backend/rWorkerBridge.js
  // and records a metadata-only `r_runtime_check` artifact. NOT a scientific output.
  'r.runtime.check',
  // Read-only worker-to-R object inspection: the ONLY job type that reads a live
  // analysis object. It inspects ONE existing object (addressed by a server-derived
  // R state key) in a read-only way via the allowlisted `r.object.inspect` bridge
  // operation and records a metadata-only `r_object_inspection` artifact (sanitized
  // object summary). The worker handler verifies the job creator OWNS the live object
  // before any R contact (project membership alone does NOT grant access). It mutates
  // NOTHING, creates NO checkpoint/result object, and is NOT a scientific output.
  'r.object.inspect',
  // First production-integrated scientific pipeline: the existing PBMC/Seurat
  // preprocessing path (normalize → variable features → scale → PCA → neighbors →
  // clusters → UMAP) wrapped as ONE allowlisted worker job. It runs on a COPY of the
  // job's input analysis object (the parent is never mutated), persists a durable
  // checkpoint RDS to a server-allocated internal vault key on the R backend, and
  // records a result analysis object + lineage edge + summary/checkpoint artifacts +
  // logs. Parameters are validated against a fixed server-side allowlist BEFORE any R
  // contact (backend/pbmcPipeline.js); there is NO arbitrary R code/path/operation.
  // DEG / pathway enrichment / CellChat are intentionally NOT part of this type (see
  // docs/analysis-pipeline-integration.md). Driven by the `pbmc.pipeline.v1` worker
  // handler (jobWorker.js) + the allowlisted `r.pbmc.pipeline.v1` bridge operation.
  'pbmc.pipeline.v1'
]);

const JOB_STATUSES = new Set([
  'created', 'queued', 'running', 'waiting_for_user', 'completed', 'failed', 'canceled'
]);

// completed / failed / canceled are terminal: no outgoing transitions.
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'canceled']);

// Explicit allow-list of state-machine edges. Anything not listed is rejected.
// `running → queued` is the worker re-queue / lease-recovery edge: a worker that
// voluntarily releases a claim, and the expired-lease reaper when attempts remain,
// return a job to the queue for another claim (see "Worker coordination" helpers).
// Clients still cannot drive this edge — the client surface is only create
// (→ queued) and cancel (→ canceled); every other edge goes through a server-tier
// helper. Terminal statuses remain terminal (no outgoing edges).
const JOB_TRANSITIONS = {
  created: new Set(['queued', 'canceled']),
  queued: new Set(['running', 'canceled']),
  running: new Set(['completed', 'failed', 'waiting_for_user', 'canceled', 'queued']),
  waiting_for_user: new Set(['queued', 'running', 'canceled']),
  completed: new Set(),
  failed: new Set(),
  canceled: new Set()
};

// Jobs are created already queued: the record is durable and "ready to run",
// even though no worker drains the queue yet (see docs/architecture.md).
const INITIAL_JOB_STATUS = 'queued';

function isValidJobType(jobType) {
  return ALLOWED_JOB_TYPES.has(jobType);
}

function isValidJobStatus(status) {
  return JOB_STATUSES.has(status);
}

function validateJobTransition(fromStatus, toStatus) {
  if (!JOB_STATUSES.has(fromStatus) || !JOB_STATUSES.has(toStatus)) return false;
  return JOB_TRANSITIONS[fromStatus].has(toStatus);
}

function generateJobId() {
  // Server-generated, header-safe by construction: `job_` + lowercase hex.
  return `job_${crypto.randomBytes(12).toString('hex')}`;
}

function normalizeJobLogEntry(entry) {
  const ts = new Date().toISOString();
  if (typeof entry === 'string') return { ts, level: 'info', message: entry };
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    return {
      ts,
      level: typeof entry.level === 'string' ? entry.level : 'info',
      message: entry.message !== undefined ? String(entry.message) : ''
    };
  }
  return { ts, level: 'info', message: String(entry == null ? '' : entry) };
}

function normalizeJobError(error) {
  if (error === null || error === undefined) return null;
  if (typeof error === 'string') return { message: error };
  if (typeof error === 'object' && !Array.isArray(error)) {
    const normalized = { message: error.message !== undefined ? String(error.message) : '' };
    if (error.code !== undefined) normalized.code = String(error.code);
    if (error.details !== undefined) normalized.details = error.details;
    return normalized;
  }
  return { message: String(error) };
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    projectId: row.project_id,
    analysisObjectId: row.analysis_object_id,
    resultAnalysisObjectId: row.result_analysis_object_id,
    datasetId: row.dataset_id,
    jobType: row.job_type,
    status: row.status,
    parameters: JSON.parse(row.parameters_json || '{}'),
    logs: JSON.parse(row.logs_json || '[]'),
    error: row.error_json ? JSON.parse(row.error_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    canceledAt: row.canceled_at
  };
}

function getJobForUser(id, ownerUserId) {
  const row = db.prepare(
    'SELECT * FROM jobs WHERE id = ? AND owner_user_id = ?'
  ).get(String(id), Number(ownerUserId));
  return rowToJob(row);
}

/**
 * Returns true only if `jobId` is a real persisted job owned by `ownerUserId`.
 * Mirrors `verifyAnalysisObjectOwner` so a job id can never be a client-
 * controlled path into another user's work.
 */
function verifyJobOwner(ownerUserId, jobId) {
  if (typeof jobId !== 'string' || jobId === '') return false;
  const row = db.prepare(
    'SELECT 1 FROM jobs WHERE id = ? AND owner_user_id = ?'
  ).get(jobId, Number(ownerUserId));
  return !!row;
}

function listJobsForUser(ownerUserId, filters = {}) {
  const clauses = ['owner_user_id = ?'];
  const params = [Number(ownerUserId)];

  if (filters.status) { clauses.push('status = ?'); params.push(String(filters.status)); }
  if (filters.jobType) { clauses.push('job_type = ?'); params.push(String(filters.jobType)); }
  if (filters.analysisObjectId) { clauses.push('analysis_object_id = ?'); params.push(String(filters.analysisObjectId)); }
  if (filters.resultAnalysisObjectId) { clauses.push('result_analysis_object_id = ?'); params.push(String(filters.resultAnalysisObjectId)); }
  if (filters.datasetId) { clauses.push('dataset_id = ?'); params.push(String(filters.datasetId)); }

  const rows = db.prepare(
    `SELECT * FROM jobs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`
  ).all(...params);
  return rows.map(rowToJob);
}

/**
 * Create a job owned by `ownerUserId`.
 *
 * The id is always server-generated and the job starts in INITIAL_JOB_STATUS.
 * A supplied `analysisObjectId` must be a real object owned by the same user.
 * Throws a coded Error (`INVALID_OWNER`, `INVALID_JOB_TYPE`,
 * `INVALID_PARAMETERS`, `ANALYSIS_OBJECT_NOT_FOUND`) so the route can map to the
 * right HTTP status.
 */
function createJobForUser(ownerUserId, input = {}) {
  const owner = Number(ownerUserId);
  if (!Number.isInteger(owner) || owner <= 0) {
    throw codedError('INVALID_OWNER', 'A valid authenticated user is required.');
  }

  const jobType = typeof input.jobType === 'string' ? input.jobType.trim() : '';
  if (!isValidJobType(jobType)) {
    throw codedError('INVALID_JOB_TYPE',
      `Invalid jobType. Allowed: ${[...ALLOWED_JOB_TYPES].join(', ')}.`);
  }

  const parameters = input.parameters === undefined ? {} : input.parameters;
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw codedError('INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
  }

  let analysisObjectId = null;
  if (input.analysisObjectId !== undefined && input.analysisObjectId !== null) {
    if (typeof input.analysisObjectId !== 'string' ||
        !getAnalysisObjectForUser(input.analysisObjectId, owner)) {
      // 404-style coded error: never reveal that another user's object exists.
      throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    }
    analysisObjectId = input.analysisObjectId;
  }

  // A supplied datasetId must reference a real dataset whose project the caller
  // can write to (owner/admin/analyst). The route validates id format (400)
  // first. Unknown/inaccessible → DATASET_NOT_FOUND (404); viewer → FORBIDDEN.
  let datasetId = null;
  if (input.datasetId !== undefined && input.datasetId !== null) {
    verifyDatasetProjectAccess(owner, String(input.datasetId), DATASET_WRITE_ROLES);
    datasetId = String(input.datasetId);
  }

  const id = generateJobId();
  db.prepare(`
    INSERT INTO jobs
      (id, owner_user_id, analysis_object_id, dataset_id, job_type, status, parameters_json)
    VALUES
      (@id, @owner, @analysisObjectId, @datasetId, @jobType, @status, @parametersJson)
  `).run({
    id,
    owner,
    analysisObjectId,
    datasetId,
    jobType,
    status: INITIAL_JOB_STATUS,
    parametersJson: JSON.stringify(parameters)
  });

  return getJobForUser(id, owner);
}

/**
 * Move an owned job to `nextStatus`, enforcing the transition allow-list and
 * stamping the matching timestamp. Optionally attaches a structured error,
 * links a result analysis object (ownership-verified), and/or appends a log
 * entry — all in one atomic update. Throws coded errors (`JOB_NOT_FOUND`,
 * `INVALID_STATUS`, `INVALID_TRANSITION`, `RESULT_OBJECT_NOT_FOUND`).
 *
 * This is the only path that mutates job status, so the client can never set an
 * arbitrary status: routes call cancel (below); a future worker calls this.
 */
function updateJobStatusForUser(ownerUserId, jobId, nextStatus, opts = {}) {
  const owner = Number(ownerUserId);
  const job = getJobForUser(jobId, owner);
  if (!job) throw codedError('JOB_NOT_FOUND', 'Job not found.');

  if (!isValidJobStatus(nextStatus)) {
    throw codedError('INVALID_STATUS', `Invalid job status: ${nextStatus}.`);
  }
  if (!validateJobTransition(job.status, nextStatus)) {
    throw codedError('INVALID_TRANSITION',
      `Cannot transition job from '${job.status}' to '${nextStatus}'.`);
  }

  let resultId = job.resultAnalysisObjectId;
  if (opts.resultAnalysisObjectId !== undefined && opts.resultAnalysisObjectId !== null) {
    if (typeof opts.resultAnalysisObjectId !== 'string' ||
        !getAnalysisObjectForUser(opts.resultAnalysisObjectId, owner)) {
      throw codedError('RESULT_OBJECT_NOT_FOUND', 'Result analysis object not found.');
    }
    resultId = opts.resultAnalysisObjectId;
  }

  const logs = opts.log !== undefined ? [...job.logs, normalizeJobLogEntry(opts.log)] : job.logs;
  const errorJson = opts.error !== undefined
    ? (opts.error === null ? null : JSON.stringify(normalizeJobError(opts.error)))
    : (job.error === null ? null : JSON.stringify(job.error));

  // All timestamp columns are stamped by SQLite so their format matches the
  // created_at default. started_at is set once (first entry into 'running');
  // completed_at covers both completed and failed; canceled_at covers cancel.
  // Reaching a terminal status voids any live worker claim: the claim_token
  // (a bearer capability) and lease_expires_at are cleared so a worker that was
  // mid-flight on this job fails its next heartbeat/complete/fail deterministically
  // (CLAIM_LOST) instead of acting on a now-terminal job. worker_id is retained as
  // an audit trail of which worker last held it. This is how a user/owner cancel
  // makes future worker behavior safe — see the "Worker coordination" helpers.
  db.prepare(`
    UPDATE jobs SET
      status = @status,
      result_analysis_object_id = @resultId,
      logs_json = @logsJson,
      error_json = @errorJson,
      updated_at = datetime('now'),
      started_at = CASE WHEN @status = 'running' AND started_at IS NULL THEN datetime('now') ELSE started_at END,
      completed_at = CASE WHEN @status IN ('completed', 'failed') THEN datetime('now') ELSE completed_at END,
      canceled_at = CASE WHEN @status = 'canceled' THEN datetime('now') ELSE canceled_at END,
      claim_token = CASE WHEN @status IN ('completed', 'failed', 'canceled') THEN NULL ELSE claim_token END,
      lease_expires_at = CASE WHEN @status IN ('completed', 'failed', 'canceled') THEN NULL ELSE lease_expires_at END
    WHERE id = @id AND owner_user_id = @owner
  `).run({
    id: jobId,
    owner,
    status: nextStatus,
    resultId,
    logsJson: JSON.stringify(logs),
    errorJson
  });

  return getJobForUser(jobId, owner);
}

/**
 * Cancel an owned, non-terminal job. Throws `JOB_NOT_FOUND` (unknown/not-owned)
 * or `JOB_NOT_CANCELABLE` (already completed/failed/canceled) so the route can
 * return 404 / 409 respectively. Does NOT touch any R process — there is no
 * execution abstraction to interrupt in this branch.
 */
function cancelJobForUser(ownerUserId, jobId) {
  const owner = Number(ownerUserId);
  const job = getJobForUser(jobId, owner);
  if (!job) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (TERMINAL_JOB_STATUSES.has(job.status)) {
    throw codedError('JOB_NOT_CANCELABLE', `Job is already ${job.status}.`);
  }
  return updateJobStatusForUser(owner, jobId, 'canceled', {
    log: { level: 'info', message: 'Job canceled by owner.' }
  });
}

/** Append a single log entry to an owned job without changing its status. */
function appendJobLogForUser(ownerUserId, jobId, entry) {
  const owner = Number(ownerUserId);
  const job = getJobForUser(jobId, owner);
  if (!job) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  const logs = [...job.logs, normalizeJobLogEntry(entry)];
  db.prepare(
    "UPDATE jobs SET logs_json = ?, updated_at = datetime('now') WHERE id = ? AND owner_user_id = ?"
  ).run(JSON.stringify(logs), jobId, owner);
  return getJobForUser(jobId, owner);
}

// ── Worker coordination (claim / lease / heartbeat / release / fail) ─────────
//
// The durable, versioned contract a FUTURE worker will use to safely claim, lease,
// heartbeat, release, complete, and fail jobs. This branch ships the contract +
// schema + helpers ONLY: it does NOT add a worker loop, does NOT drain the queue,
// does NOT call R, and does NOT make any execution asynchronous. Nothing in the
// running server invokes these helpers yet — they exist for the worker branch that
// comes next (`worker-queue-drain-minimal`), and for the tests that pin the
// contract. R active state stays user/object-keyed and owner-verified; these
// helpers never touch R, never read a client-supplied path, and never widen
// ownership (claim is authorized by a server-issued worker id + claim token, which
// is exactly how the trusted server tier already talks to R).
//
// Authorization model: worker operations are NOT user-scoped. A worker authorizes
// by holding the job's current `claim_token` (a server-issued bearer capability)
// together with its own `worker_id`. heartbeat/complete/fail/release succeed only
// while the row still matches (worker_id, claim_token) AND status='running' AND the
// lease has not expired. claim_token is rotated on every (re)claim and cleared when
// a job reaches a terminal status or is canceled, so a stale worker can never act
// on a job that was reclaimed, completed, failed, or canceled out from under it.
//
// Lease & recovery contract (documented + tested in jobs-worker-contract.test.js):
//   - Claimable = status 'queued' AND attempts < max_attempts. claim picks one,
//     ordered by priority DESC, then created_at ASC, then id ASC, and is a single
//     winner (a guarded conditional UPDATE inside an IMMEDIATE transaction).
//   - A claim sets status 'running', a fresh worker_id + claim_token, locked_at,
//     heartbeat_at, lease_expires_at, and increments attempts.
//   - A running job with an UNEXPIRED lease is owned: no other worker can claim it
//     and only the holder can heartbeat/complete/fail/release it.
//   - A running job with an EXPIRED lease is recovered by reapExpiredJobs(): if
//     attempts < max_attempts it returns to 'queued' (running → queued) for another
//     claim; if attempts >= max_attempts it is moved to 'failed' with a durable
//     error, so an exhausted job is never reclaimed forever and never left stuck
//     'running'.
//   - max_attempts defaults to 1 (at-most-once: a crash is NOT silently retried).
//     A voluntary releaseJob() refunds the attempt it relinquishes, so a graceful
//     hand-back does not consume the budget.
//   - now/leaseSeconds are injectable on every helper so lease timing is fully
//     deterministic in tests; production callers omit them and use the DB clock.

const DEFAULT_LEASE_SECONDS = 30;
// Worker ids are server-issued by the future worker process and must be header-safe
// (a server-controlled X-Worker-ID is part of the documented future contract).
const WORKER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const SQLITE_TS_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Per-claim bearer capability; `wct_` + hex so it is header-safe by construction. */
function generateClaimToken() {
  return `wct_${crypto.randomBytes(18).toString('hex')}`;
}

/** Current time in SQLite's canonical 'YYYY-MM-DD HH:MM:SS' UTC format. Using the
 * DB clock keeps lease math and stored timestamps in one comparable format. */
function dbNow() {
  return db.prepare("SELECT datetime('now') AS t").get().t;
}

function isSqliteTimestamp(v) {
  return typeof v === 'string' && SQLITE_TS_PATTERN.test(v);
}

// Worker helpers accept an optional opts.now (same canonical format) so tests can
// drive lease expiry deterministically without sleeping; production omits it.
function normalizeWorkerNow(opts) {
  if (opts && opts.now !== undefined) {
    if (!isSqliteTimestamp(opts.now)) {
      throw codedError('INVALID_NOW', "opts.now must be a 'YYYY-MM-DD HH:MM:SS' UTC timestamp.");
    }
    return String(opts.now);
  }
  return dbNow();
}

function normalizeLeaseSeconds(v) {
  if (v === undefined) return DEFAULT_LEASE_SECONDS;
  if (!Number.isInteger(v) || v < 1) {
    throw codedError('INVALID_LEASE', 'leaseSeconds must be a positive integer.');
  }
  return v;
}

function requireWorkerId(workerId) {
  if (typeof workerId !== 'string' || !WORKER_ID_PATTERN.test(workerId)) {
    throw codedError('INVALID_WORKER', 'A valid worker id (1–128 chars of [A-Za-z0-9_.:-]) is required.');
  }
  return workerId;
}

function requireClaimToken(token) {
  if (typeof token !== 'string' || token === '') {
    throw codedError('INVALID_CLAIM_TOKEN', 'A claim token is required.');
  }
  return token;
}

/** Raw job row by id (no owner/project scoping). Worker helpers authorize by
 * (worker_id, claim_token), not by user ownership, so they look up by id alone. */
function getJobRowById(id) {
  if (typeof id !== 'string' || id === '') return null;
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) || null;
}

/**
 * Worker-facing job view. Includes the coordination fields AND the claim_token,
 * so it is only ever returned to the worker that holds the claim. The owner/project
 * read APIs use rowToJob (above), which deliberately omits claim_token — the bearer
 * capability must never leak through a normal user-facing job response.
 */
function rowToWorkerJob(row) {
  if (!row) return null;
  return {
    ...rowToJob(row),
    workerId: row.worker_id,
    claimToken: row.claim_token,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    lockedAt: row.locked_at,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    priority: row.priority,
    lastWorkerError: row.last_worker_error ? JSON.parse(row.last_worker_error) : null
  };
}

/** Server-tier-internal re-read of the worker-view of a job by id (includes the
 * coordination fields + claim_token). Never wired to a client route — exactly like
 * the claim/heartbeat return values, this is for the trusted worker/tests only. */
function getWorkerJob(jobId) {
  return rowToWorkerJob(getJobRowById(jobId));
}

/** True only if `row` is a running job whose live claim is held by exactly this
 * (workerId, claimToken) and whose lease has not expired as of `now`. */
function workerHoldsClaim(row, workerId, claimToken, now) {
  return !!row
    && row.status === 'running'
    && row.worker_id === workerId
    && typeof row.claim_token === 'string' && row.claim_token !== '' && row.claim_token === claimToken
    && typeof row.lease_expires_at === 'string' && row.lease_expires_at > now;
}

/**
 * Atomically claim one eligible queued job for `workerId`. Single winner: the
 * candidate is selected and then updated with a guard repeating the eligibility
 * predicate, inside an IMMEDIATE transaction, so two racing workers cannot both
 * claim the same row (the loser sees 0 changed rows). Returns the claimed
 * worker-job (including its fresh claim_token) or null if nothing is claimable.
 * Throws `INVALID_WORKER` / `INVALID_NOW` / `INVALID_LEASE` on bad input.
 */
function claimNextJob(workerId, opts = {}) {
  const wid = requireWorkerId(workerId);
  const now = normalizeWorkerNow(opts);
  const leaseSeconds = normalizeLeaseSeconds(opts.leaseSeconds);
  const claimToken = generateClaimToken();

  const claim = db.transaction(() => {
    const candidate = db.prepare(`
      SELECT id FROM jobs
      WHERE status = 'queued' AND attempts < max_attempts
      ORDER BY priority DESC, created_at ASC, id ASC
      LIMIT 1
    `).get();
    if (!candidate) return null;
    const info = db.prepare(`
      UPDATE jobs SET
        status = 'running',
        worker_id = @wid,
        claim_token = @claimToken,
        attempts = attempts + 1,
        locked_at = @now,
        heartbeat_at = @now,
        lease_expires_at = datetime(@now, '+' || @leaseSeconds || ' seconds'),
        started_at = CASE WHEN started_at IS NULL THEN @now ELSE started_at END,
        updated_at = @now
      WHERE id = @id AND status = 'queued' AND attempts < max_attempts
    `).run({ id: candidate.id, wid, claimToken, now, leaseSeconds });
    return info.changes === 1 ? candidate.id : null;
  });

  const claimedId = claim.immediate();
  return claimedId ? rowToWorkerJob(getJobRowById(claimedId)) : null;
}

/**
 * Extend the lease and stamp heartbeat_at for the worker that holds the claim.
 * Succeeds only while (worker_id, claim_token) match, status is 'running', and the
 * lease has not already expired — a worker that let its lease lapse has lost the
 * claim (CLAIM_LOST) and must stop. Throws `JOB_NOT_FOUND` / `CLAIM_LOST`.
 */
function heartbeatJob(jobId, workerId, claimToken, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const leaseSeconds = normalizeLeaseSeconds(opts.leaseSeconds);
  if (!getJobRowById(jobId)) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  const info = db.prepare(`
    UPDATE jobs SET
      heartbeat_at = @now,
      lease_expires_at = datetime(@now, '+' || @leaseSeconds || ' seconds'),
      updated_at = @now
    WHERE id = @id AND worker_id = @wid AND claim_token = @token
      AND status = 'running' AND lease_expires_at > @now
  `).run({ id: String(jobId), wid, token, now, leaseSeconds });
  if (info.changes !== 1) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  return rowToWorkerJob(getJobRowById(jobId));
}

/**
 * Complete a job the worker currently holds (running → completed), optionally
 * linking a result analysis object (verified against the job's owner, mirroring
 * updateJobStatusForUser) and appending a log. Clears the claim_token + lease on
 * the now-terminal row. Throws `JOB_NOT_FOUND` / `CLAIM_LOST` / `INVALID_TRANSITION`
 * / `RESULT_OBJECT_NOT_FOUND`.
 */
function completeJobByWorker(jobId, workerId, claimToken, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  // The worker path honors the same transition allow-list as updateJobStatusForUser.
  if (!validateJobTransition(row.status, 'completed')) {
    throw codedError('INVALID_TRANSITION', `Cannot complete a job in status '${row.status}'.`);
  }
  let resultId = row.result_analysis_object_id;
  if (opts.resultAnalysisObjectId !== undefined && opts.resultAnalysisObjectId !== null) {
    if (typeof opts.resultAnalysisObjectId !== 'string' ||
        !getAnalysisObjectForUser(opts.resultAnalysisObjectId, row.owner_user_id)) {
      throw codedError('RESULT_OBJECT_NOT_FOUND', 'Result analysis object not found.');
    }
    resultId = opts.resultAnalysisObjectId;
  }
  const logs = opts.log !== undefined
    ? [...JSON.parse(row.logs_json || '[]'), normalizeJobLogEntry(opts.log)]
    : JSON.parse(row.logs_json || '[]');
  const info = db.prepare(`
    UPDATE jobs SET
      status = 'completed',
      result_analysis_object_id = @resultId,
      logs_json = @logsJson,
      completed_at = @now,
      heartbeat_at = @now,
      updated_at = @now,
      claim_token = NULL,
      lease_expires_at = NULL
    WHERE id = @id AND worker_id = @wid AND claim_token = @token
      AND status = 'running' AND lease_expires_at > @now
  `).run({ id: String(jobId), wid, token, resultId: resultId == null ? null : String(resultId), logsJson: JSON.stringify(logs), now });
  if (info.changes !== 1) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  return rowToWorkerJob(getJobRowById(jobId));
}

/**
 * Fail a job the worker currently holds (running → failed), recording durable error
 * information in both error_json (the user-facing error) and last_worker_error (the
 * worker diagnostic), and clearing the claim_token + lease. Throws `JOB_NOT_FOUND`
 * / `CLAIM_LOST` / `INVALID_TRANSITION`.
 */
function failJobByWorker(jobId, workerId, claimToken, error, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  if (!validateJobTransition(row.status, 'failed')) {
    throw codedError('INVALID_TRANSITION', `Cannot fail a job in status '${row.status}'.`);
  }
  // A failure must always carry durable error detail; default if none supplied.
  const errObj = normalizeJobError(error === undefined || error === null ? { message: 'Job failed.' } : error);
  const errJson = JSON.stringify(errObj);
  const logs = opts.log !== undefined
    ? [...JSON.parse(row.logs_json || '[]'), normalizeJobLogEntry(opts.log)]
    : JSON.parse(row.logs_json || '[]');
  const info = db.prepare(`
    UPDATE jobs SET
      status = 'failed',
      error_json = @errJson,
      last_worker_error = @errJson,
      logs_json = @logsJson,
      completed_at = @now,
      heartbeat_at = @now,
      updated_at = @now,
      claim_token = NULL,
      lease_expires_at = NULL
    WHERE id = @id AND worker_id = @wid AND claim_token = @token
      AND status = 'running' AND lease_expires_at > @now
  `).run({ id: String(jobId), wid, token, errJson, logsJson: JSON.stringify(logs), now });
  if (info.changes !== 1) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  return rowToWorkerJob(getJobRowById(jobId));
}

/**
 * Voluntarily relinquish a held claim (running → queued) so the job can be claimed
 * again. Clears worker_id/claim_token/locked_at/lease and REFUNDS the attempt it is
 * giving back (a graceful release neither ran to completion nor failed, so it does
 * not consume the claim budget). Only the holding worker may release. Throws
 * `JOB_NOT_FOUND` / `CLAIM_LOST` / `INVALID_TRANSITION`.
 */
function releaseJob(jobId, workerId, claimToken, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  if (!validateJobTransition(row.status, 'queued')) {
    throw codedError('INVALID_TRANSITION', `Cannot release a job in status '${row.status}'.`);
  }
  const logs = opts.log !== undefined
    ? [...JSON.parse(row.logs_json || '[]'), normalizeJobLogEntry(opts.log)]
    : JSON.parse(row.logs_json || '[]');
  const info = db.prepare(`
    UPDATE jobs SET
      status = 'queued',
      worker_id = NULL,
      claim_token = NULL,
      locked_at = NULL,
      lease_expires_at = NULL,
      heartbeat_at = @now,
      attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
      logs_json = @logsJson,
      updated_at = @now
    WHERE id = @id AND worker_id = @wid AND claim_token = @token
      AND status = 'running' AND lease_expires_at > @now
  `).run({ id: String(jobId), wid, token, logsJson: JSON.stringify(logs), now });
  if (info.changes !== 1) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  return rowToWorkerJob(getJobRowById(jobId));
}

/**
 * Append a durable log entry to a running job the worker currently holds, WITHOUT
 * changing its status. Guarded exactly like heartbeat/complete/fail: succeeds only
 * while (worker_id, claim_token) match, status is 'running', and the lease is still
 * live. This is the worker-side counterpart to appendJobLogForUser (which is owner-
 * scoped); it lets the drain loop record "claimed" / "handler started" progress logs
 * that are authorized by the claim rather than by user ownership. Throws
 * `JOB_NOT_FOUND` / `CLAIM_LOST` so a worker that has lost its claim cannot keep
 * writing to a job that was canceled/reaped out from under it.
 */
function appendJobLogByWorker(jobId, workerId, claimToken, entry, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  const logs = [...JSON.parse(row.logs_json || '[]'), normalizeJobLogEntry(entry)];
  const info = db.prepare(`
    UPDATE jobs SET logs_json = @logsJson, updated_at = @now
    WHERE id = @id AND worker_id = @wid AND claim_token = @token
      AND status = 'running' AND lease_expires_at > @now
  `).run({ id: String(jobId), wid, token, logsJson: JSON.stringify(logs), now });
  if (info.changes !== 1) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  return rowToWorkerJob(getJobRowById(jobId));
}

/**
 * Recover running jobs whose lease has expired (a crashed/stalled worker). For each:
 *   - attempts <  max_attempts → return to 'queued' (running → queued) for re-claim;
 *   - attempts >= max_attempts → move to 'failed' with a durable LEASE_EXPIRED error.
 * Each transition is a guarded conditional UPDATE, so a concurrent reaper/worker
 * cannot double-process a row. Returns { requeued: [ids], failed: [ids] }. This is
 * a helper for a future supervisor/worker; nothing calls it automatically here.
 */
function reapExpiredJobs(opts = {}) {
  const now = normalizeWorkerNow(opts);
  const expired = db.prepare(`
    SELECT id, attempts, max_attempts FROM jobs
    WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= @now
  `).all({ now });
  const requeued = [];
  const failed = [];
  for (const row of expired) {
    if (row.attempts < row.max_attempts) {
      const lastErr = JSON.stringify(normalizeJobError({
        code: 'LEASE_EXPIRED',
        message: 'Worker lease expired; job re-queued for another claim.'
      }));
      // Clear the claim fields consistently with releaseJob's running→queued path:
      // a requeued job holds no claim, so worker_id/claim_token/locked_at/lease are
      // all cleared and heartbeat_at is stamped as the "last touched" marker. (Prior
      // versions left locked_at/heartbeat_at stale on the requeued row.)
      const info = db.prepare(`
        UPDATE jobs SET
          status = 'queued',
          worker_id = NULL,
          claim_token = NULL,
          locked_at = NULL,
          lease_expires_at = NULL,
          heartbeat_at = @now,
          last_worker_error = @lastErr,
          updated_at = @now
        WHERE id = @id AND status = 'running'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= @now
      `).run({ id: row.id, now, lastErr });
      if (info.changes === 1) requeued.push(row.id);
    } else {
      const errJson = JSON.stringify(normalizeJobError({
        code: 'LEASE_EXPIRED',
        message: 'Worker lease expired and the claim budget (max_attempts) is exhausted; job failed.'
      }));
      // Clear the live claim consistently with the worker terminal paths
      // (completeJobByWorker/failJobByWorker): claim_token + lease cleared, heartbeat_at
      // stamped, completed_at stamped. worker_id and locked_at are retained as
      // diagnostics on the terminal row (same convention as failJobByWorker).
      const info = db.prepare(`
        UPDATE jobs SET
          status = 'failed',
          error_json = @errJson,
          last_worker_error = @errJson,
          completed_at = @now,
          heartbeat_at = @now,
          claim_token = NULL,
          lease_expires_at = NULL,
          updated_at = @now
        WHERE id = @id AND status = 'running'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= @now
      `).run({ id: row.id, now, errJson });
      if (info.changes === 1) failed.push(row.id);
    }
  }
  return { requeued, failed };
}

/**
 * Server-tier scheduling/backfill helper: set a job's queue priority, claim budget
 * (max_attempts), and/or re-stamp its enqueue time (created_at, which drives claim
 * ordering among equal priorities). Not exposed to clients — priority/max_attempts
 * are coordination fields, never accepted from a request body. Does not change
 * status. Throws `JOB_NOT_FOUND` and the relevant `INVALID_*` on bad input.
 */
function setJobScheduling(jobId, opts = {}) {
  const id = String(jobId);
  const row = getJobRowById(id);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  const sets = [];
  const params = { id };
  if (opts.priority !== undefined) {
    if (!Number.isInteger(opts.priority)) throw codedError('INVALID_PRIORITY', 'priority must be an integer.');
    sets.push('priority = @priority'); params.priority = opts.priority;
  }
  if (opts.maxAttempts !== undefined) {
    if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) {
      throw codedError('INVALID_MAX_ATTEMPTS', 'maxAttempts must be a positive integer.');
    }
    sets.push('max_attempts = @maxAttempts'); params.maxAttempts = opts.maxAttempts;
  }
  if (opts.createdAt !== undefined) {
    if (!isSqliteTimestamp(opts.createdAt)) {
      throw codedError('INVALID_CREATED_AT', "createdAt must be a 'YYYY-MM-DD HH:MM:SS' timestamp.");
    }
    sets.push('created_at = @createdAt'); params.createdAt = String(opts.createdAt);
  }
  if (sets.length === 0) return rowToWorkerJob(row);
  db.prepare(`UPDATE jobs SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id`).run(params);
  return rowToWorkerJob(getJobRowById(id));
}

// ── Organizations & Projects (membership + authorization) ────────
//
// The first durable org/project authorization layer. Identity is server-owned:
// org/project ids are server-generated and clients never assert ownership or
// role. Read helpers are membership-scoped so an org/project the caller cannot
// access is indistinguishable from one that does not exist (the route layer
// returns 404, reserving 403 for a known member who lacks the required role).
//
// SCOPE: this layer ONLY models membership + authorization. It deliberately does
// not touch analysis objects, jobs, provenance, cache, figures, or R state —
// those remain user-scoped (see docs/architecture.md).

// The four roles, in descending privilege. Stored verbatim in the *_members
// `role` column; any value outside this set is rejected before it is persisted.
const ORG_PROJECT_ROLES = new Set(['owner', 'admin', 'analyst', 'viewer']);

function isValidRole(role) {
  return typeof role === 'string' && ORG_PROJECT_ROLES.has(role);
}

function generateOrganizationId() {
  return `org_${crypto.randomBytes(12).toString('hex')}`;
}

function generateProjectId() {
  return `proj_${crypto.randomBytes(12).toString('hex')}`;
}

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;

function normalizeName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// ── Organizations ────────────────────────────────────────────────

/**
 * Create an organization owned by `ownerUserId` and grant the creator an
 * 'owner' membership row in the same transaction. The id is server-generated.
 * Throws coded errors (`INVALID_OWNER`, `INVALID_NAME`) the route maps to 400.
 */
function createOrganizationForUser(ownerUserId, input = {}) {
  const owner = Number(ownerUserId);
  if (!Number.isInteger(owner) || owner <= 0) {
    throw codedError('INVALID_OWNER', 'A valid authenticated user is required.');
  }
  const name = normalizeName(input.name);
  if (!name) throw codedError('INVALID_NAME', 'Organization name is required.');
  if (name.length > MAX_NAME_LENGTH) {
    throw codedError('INVALID_NAME', `Organization name must be at most ${MAX_NAME_LENGTH} characters.`);
  }

  const id = generateOrganizationId();
  db.transaction(() => {
    db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(id, name, owner);
    db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'owner')").run(id, owner);
  })();

  return getOrganizationForUser(id, owner);
}

/**
 * Return an organization only if `userId` is a member; otherwise null. The
 * caller's own role is included so the route never needs a second query.
 */
function getOrganizationForUser(organizationId, userId) {
  if (typeof organizationId !== 'string' || organizationId === '') return null;
  const row = db.prepare(`
    SELECT o.id, o.name, o.owner_user_id, o.created_at, o.updated_at, m.role AS role
    FROM organizations o
    JOIN organization_members m ON m.organization_id = o.id
    WHERE o.id = ? AND m.user_id = ?
  `).get(organizationId, Number(userId));
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** List every organization `userId` belongs to, with their role in each. */
function listOrganizationsForUser(userId) {
  const rows = db.prepare(`
    SELECT o.id, o.name, o.owner_user_id, o.created_at, o.updated_at, m.role AS role
    FROM organizations o
    JOIN organization_members m ON m.organization_id = o.id
    WHERE m.user_id = ?
    ORDER BY o.created_at DESC, o.id DESC
  `).all(Number(userId));
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

/**
 * Return the caller's membership ({ organizationId, userId, role }) or null.
 * This is the existence/access gate: a non-member is indistinguishable from a
 * nonexistent org.
 */
function verifyOrganizationMember(userId, organizationId) {
  if (typeof organizationId !== 'string' || organizationId === '') return null;
  const row = db.prepare(
    'SELECT organization_id, user_id, role FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(organizationId, Number(userId));
  if (!row) return null;
  return { organizationId: row.organization_id, userId: row.user_id, role: row.role };
}

/**
 * Assert `userId` is a member of `organizationId` AND holds one of
 * `allowedRoles`. Throws `NOT_FOUND` (not a member → 404, no existence leak) or
 * `FORBIDDEN` (member but wrong role → 403). Returns the membership on success.
 */
function requireOrganizationRole(userId, organizationId, allowedRoles) {
  const membership = verifyOrganizationMember(userId, organizationId);
  if (!membership) throw codedError('NOT_FOUND', 'Organization not found.');
  const allowed = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  if (!allowed.includes(membership.role)) {
    throw codedError('FORBIDDEN', 'You do not have permission to perform this action.');
  }
  return membership;
}

/**
 * Add an existing user to an organization with `role`. Validates the role and
 * rejects duplicate membership. Throws `INVALID_ROLE`, `INVALID_OWNER` (bad user
 * id), or `ALREADY_MEMBER`. There is no org-member management *route* in this
 * branch — this is the building block a future route (and the test suite) uses;
 * `createOrganizationForUser` seeds the creator's 'owner' row inline.
 */
function addOrganizationMember(organizationId, userId, role) {
  if (!isValidRole(role)) throw codedError('INVALID_ROLE', 'Invalid role.');
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) {
    throw codedError('INVALID_OWNER', 'A valid user id is required.');
  }
  if (verifyOrganizationMember(uid, organizationId)) {
    throw codedError('ALREADY_MEMBER', 'User is already a member of this organization.');
  }
  db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(String(organizationId), uid, role);
  return { organizationId: String(organizationId), userId: uid, role };
}

// ── Projects ─────────────────────────────────────────────────────

function rowToProjectWithRole(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    createdByUserId: row.created_by_user_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Create a project in `organizationId` and grant the creator an 'owner'
 * project membership in the same transaction. The caller must already be an
 * owner/admin of the parent org (enforced here via requireOrganizationRole, so
 * the DB layer is safe even if a future route forgets to check). The id is
 * server-generated. Throws coded errors: `INVALID_OWNER`, `INVALID_ORG`,
 * `NOT_FOUND`/`FORBIDDEN` (org access), `INVALID_NAME`, `INVALID_DESCRIPTION`.
 */
function createProjectForUser(userId, input = {}) {
  const creator = Number(userId);
  if (!Number.isInteger(creator) || creator <= 0) {
    throw codedError('INVALID_OWNER', 'A valid authenticated user is required.');
  }
  const organizationId = typeof input.organizationId === 'string' ? input.organizationId : '';
  if (!organizationId) throw codedError('INVALID_ORG', 'organizationId is required.');

  // Only org owners/admins may create projects. Not-a-member → NOT_FOUND (404).
  requireOrganizationRole(creator, organizationId, ['owner', 'admin']);

  const name = normalizeName(input.name);
  if (!name) throw codedError('INVALID_NAME', 'Project name is required.');
  if (name.length > MAX_NAME_LENGTH) {
    throw codedError('INVALID_NAME', `Project name must be at most ${MAX_NAME_LENGTH} characters.`);
  }
  const description = input.description == null ? '' : String(input.description);
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw codedError('INVALID_DESCRIPTION', `Project description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`);
  }

  const id = generateProjectId();
  db.transaction(() => {
    db.prepare(
      'INSERT INTO projects (id, organization_id, name, description, created_by_user_id) VALUES (?, ?, ?, ?, ?)'
    ).run(id, organizationId, name, description, creator);
    db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')").run(id, creator);
  })();

  return getProjectForUser(id, creator);
}

/** Return a project only if `userId` is a project member; otherwise null. */
function getProjectForUser(projectId, userId) {
  if (typeof projectId !== 'string' || projectId === '') return null;
  const row = db.prepare(`
    SELECT p.id, p.organization_id, p.name, p.description, p.created_by_user_id,
           p.created_at, p.updated_at, m.role AS role
    FROM projects p
    JOIN project_members m ON m.project_id = p.id
    WHERE p.id = ? AND m.user_id = ?
  `).get(projectId, Number(userId));
  if (!row) return null;
  return rowToProjectWithRole(row);
}

/** List every project `userId` is a member of, with their role in each. */
function listProjectsForUser(userId) {
  const rows = db.prepare(`
    SELECT p.id, p.organization_id, p.name, p.description, p.created_by_user_id,
           p.created_at, p.updated_at, m.role AS role
    FROM projects p
    JOIN project_members m ON m.project_id = p.id
    WHERE m.user_id = ?
    ORDER BY p.created_at DESC, p.id DESC
  `).all(Number(userId));
  return rows.map(rowToProjectWithRole);
}

/** Return the caller's project membership ({ projectId, userId, role }) or null. */
function verifyProjectMember(userId, projectId) {
  if (typeof projectId !== 'string' || projectId === '') return null;
  const row = db.prepare(
    'SELECT project_id, user_id, role FROM project_members WHERE project_id = ? AND user_id = ?'
  ).get(projectId, Number(userId));
  if (!row) return null;
  return { projectId: row.project_id, userId: row.user_id, role: row.role };
}

/**
 * Assert `userId` is a project member AND holds one of `allowedRoles`. Throws
 * `NOT_FOUND` (not a member → 404) or `FORBIDDEN` (member, wrong role → 403).
 * Returns the membership on success.
 */
function requireProjectRole(userId, projectId, allowedRoles) {
  const membership = verifyProjectMember(userId, projectId);
  if (!membership) throw codedError('NOT_FOUND', 'Project not found.');
  const allowed = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  if (!allowed.includes(membership.role)) {
    throw codedError('FORBIDDEN', 'You do not have permission to perform this action.');
  }
  return membership;
}

/**
 * List a project's members (joined with the users table for email/displayName).
 * The route restricts this to project members; co-members seeing each other is
 * not user enumeration (there is no broad user-search endpoint).
 */
function listProjectMembers(projectId) {
  const rows = db.prepare(`
    SELECT pm.user_id, pm.role, pm.created_at, pm.updated_at, u.email, u.display_name
    FROM project_members pm
    JOIN users u ON u.id = pm.user_id
    WHERE pm.project_id = ?
    ORDER BY pm.created_at ASC, pm.user_id ASC
  `).all(String(projectId));
  return rows.map(r => ({
    userId: r.user_id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

/**
 * Update a project's mutable fields (name and/or description). Server-controlled
 * columns (id, organization_id, created_by_user_id, role) are never touched.
 * Throws `INVALID_NAME`, `INVALID_DESCRIPTION`, or `NO_FIELDS`. The caller is
 * responsible for authorization (requireProjectRole) before calling this.
 */
function updateProject(projectId, input = {}) {
  const sets = [];
  const params = { id: String(projectId) };

  if (input.name !== undefined) {
    const name = normalizeName(input.name);
    if (!name) throw codedError('INVALID_NAME', 'Project name is required.');
    if (name.length > MAX_NAME_LENGTH) {
      throw codedError('INVALID_NAME', `Project name must be at most ${MAX_NAME_LENGTH} characters.`);
    }
    sets.push('name = @name');
    params.name = name;
  }
  if (input.description !== undefined) {
    const description = input.description == null ? '' : String(input.description);
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw codedError('INVALID_DESCRIPTION', `Project description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`);
    }
    sets.push('description = @description');
    params.description = description;
  }
  if (sets.length === 0) throw codedError('NO_FIELDS', 'No updatable fields provided.');

  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

// ── Project membership management ─────────────────────────────────

function getProjectMember(projectId, userId) {
  const row = db.prepare(
    'SELECT project_id, user_id, role FROM project_members WHERE project_id = ? AND user_id = ?'
  ).get(String(projectId), Number(userId));
  if (!row) return null;
  return { projectId: row.project_id, userId: row.user_id, role: row.role };
}

function countProjectOwners(projectId) {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = 'owner'"
  ).get(String(projectId));
  return row.n;
}

/**
 * Add an existing user (looked up by exact, normalized email) to a project with
 * `role`. There is no invitation flow and no broad user search in this branch;
 * the target must already have an account. `actorRole` is the acting caller's
 * project role: only an `owner` may grant the `owner` role, so any non-owner
 * actor attempting to add an `owner` is rejected with `FORBIDDEN` (the helper
 * fails closed — a missing/unknown `actorRole` is treated as non-owner). Throws
 * `INVALID_ROLE`, `FORBIDDEN`, `INVALID_EMAIL`, `USER_NOT_FOUND`, or
 * `ALREADY_MEMBER`. The caller is responsible for membership authorization
 * (requireProjectRole) before calling this.
 */
function addProjectMemberByEmail(projectId, email, role, actorRole) {
  if (!isValidRole(role)) throw codedError('INVALID_ROLE', 'Invalid role.');
  if (role === 'owner' && actorRole !== 'owner') {
    throw codedError('FORBIDDEN', 'Only an owner can grant the owner role.');
  }
  if (typeof email !== 'string' || !email.trim()) {
    throw codedError('INVALID_EMAIL', 'A member email is required.');
  }
  const user = getUserByEmail(email);
  if (!user) throw codedError('USER_NOT_FOUND', 'No user found with that email.');
  if (getProjectMember(projectId, user.id)) {
    throw codedError('ALREADY_MEMBER', 'User is already a member of this project.');
  }
  db.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)')
    .run(String(projectId), user.id, role);
  return { userId: user.id, email: user.email, displayName: user.displayName, role };
}

/**
 * Change an existing project member's role. Owner-role operations are owner-only:
 * `actorRole` must be `owner` both to grant the `owner` role (promote) and to
 * demote an existing `owner`; a non-owner actor attempting either is rejected
 * with `FORBIDDEN` (the helper fails closed — a missing/unknown `actorRole` is
 * treated as non-owner). Refuses to demote the last owner (would orphan the
 * project). Throws `INVALID_ROLE`, `MEMBER_NOT_FOUND`, `FORBIDDEN`, or
 * `LAST_OWNER`. Membership authorization is the caller's responsibility.
 */
function updateProjectMemberRole(projectId, targetUserId, role, actorRole) {
  if (!isValidRole(role)) throw codedError('INVALID_ROLE', 'Invalid role.');
  const member = getProjectMember(projectId, targetUserId);
  if (!member) throw codedError('MEMBER_NOT_FOUND', 'Project member not found.');
  // Only an owner may grant the owner role (promote a non-owner to owner).
  if (role === 'owner' && member.role !== 'owner' && actorRole !== 'owner') {
    throw codedError('FORBIDDEN', 'Only an owner can grant the owner role.');
  }
  // Only an owner may demote an existing owner. Checked before the last-owner
  // guard so an admin demoting an owner always sees 403, never 409.
  if (member.role === 'owner' && role !== 'owner' && actorRole !== 'owner') {
    throw codedError('FORBIDDEN', 'Only an owner can demote an owner.');
  }
  if (member.role === 'owner' && role !== 'owner' && countProjectOwners(projectId) <= 1) {
    throw codedError('LAST_OWNER', 'Cannot demote the last owner of the project.');
  }
  db.prepare("UPDATE project_members SET role = ?, updated_at = datetime('now') WHERE project_id = ? AND user_id = ?")
    .run(role, String(projectId), Number(targetUserId));
  return getProjectMember(projectId, targetUserId);
}

/**
 * Remove a member from a project. Removing an existing `owner` is owner-only:
 * `actorRole` must be `owner`, else `FORBIDDEN` (the helper fails closed — a
 * missing/unknown `actorRole` is treated as non-owner). Refuses to remove the
 * last owner. The owner-only check runs before the last-owner guard so an admin
 * removing an owner always sees 403, never 409. Throws `MEMBER_NOT_FOUND`,
 * `FORBIDDEN`, or `LAST_OWNER`. Membership authorization is the caller's
 * responsibility.
 */
function removeProjectMember(projectId, targetUserId, actorRole) {
  const member = getProjectMember(projectId, targetUserId);
  if (!member) throw codedError('MEMBER_NOT_FOUND', 'Project member not found.');
  if (member.role === 'owner' && actorRole !== 'owner') {
    throw codedError('FORBIDDEN', 'Only an owner can remove an owner.');
  }
  if (member.role === 'owner' && countProjectOwners(projectId) <= 1) {
    throw codedError('LAST_OWNER', 'Cannot remove the last owner of the project.');
  }
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?')
    .run(String(projectId), Number(targetUserId));
  return true;
}

// ── Datasets (project-scoped) ────────────────────────────────────
//
// The first durable, project-scoped resource. A dataset belongs to exactly one
// project; every read/write helper authorizes through the project_members role
// (requireProjectRole / verifyProjectMember), so a dataset in a project the
// caller cannot access is indistinguishable from one that does not exist (the
// route returns 404; 403 is reserved for a known member lacking the role).
// Identity is server-owned: ids are server-generated and the internal storage
// key / storage uri / sha256 / size are set by the server (via the upload flow),
// never accepted from the client. file_type / upload_status / validation_status
// are constrained to the allow-lists below.

const ALLOWED_DATASET_FILE_TYPES = new Set([
  'tenx_zip', 'tenx_h5', 'seurat_rds', 'h5seurat', 'h5ad',
  'count_matrix_csv', 'count_matrix_tsv', 'metadata_csv', 'metadata_tsv'
]);

const DATASET_UPLOAD_STATUSES = new Set(['pending', 'uploaded', 'failed']);
const DATASET_VALIDATION_STATUSES = new Set(['pending', 'valid', 'invalid', 'skipped']);

// Roles permitted to create/register/update a dataset. viewer is read-only.
const DATASET_WRITE_ROLES = ['owner', 'admin', 'analyst'];
const DATASET_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];

function isValidDatasetFileType(fileType) {
  return typeof fileType === 'string' && ALLOWED_DATASET_FILE_TYPES.has(fileType);
}
function isValidDatasetUploadStatus(status) {
  return typeof status === 'string' && DATASET_UPLOAD_STATUSES.has(status);
}
function isValidDatasetValidationStatus(status) {
  return typeof status === 'string' && DATASET_VALIDATION_STATUSES.has(status);
}

function generateDatasetId() {
  // Server-generated, header/path-safe by construction: `ds_` + lowercase hex.
  return `ds_${crypto.randomBytes(12).toString('hex')}`;
}

// Strip any path components and keep a conservative, display-only filename. The
// result is metadata ONLY — it is never used to derive a storage path (the
// server chooses the storage key independently). Returns null for unusable input.
function sanitizeDatasetFilename(name) {
  if (typeof name !== 'string') return null;
  const base = name.split(/[\\/]+/).pop().trim();
  if (!base || base === '.' || base === '..') return null;
  return base.slice(0, 255);
}

// A dataset must never look "valid" unless its bytes actually landed. This
// guards the requirement that a pending/failed upload cannot be represented as
// a valid dataset.
function assertDatasetStatusCombo(uploadStatus, validationStatus) {
  if (validationStatus === 'valid' && uploadStatus !== 'uploaded') {
    throw codedError('INVALID_STATUS_COMBO',
      'A dataset cannot have validation_status "valid" unless upload_status is "uploaded".');
  }
}

function normalizeValidationErrors(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) || (typeof value === 'object')) return JSON.stringify(value);
  throw codedError('INVALID_VALIDATION_ERRORS', 'validation_errors must be a JSON array or object.');
}

// Full internal row mapping (includes the server-only internal_storage_key).
function rowToDataset(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    createdByUserId: row.created_by_user_id,
    originalFilename: row.original_filename,
    internalStorageKey: row.internal_storage_key,
    storageUri: row.storage_uri,
    fileType: row.file_type,
    fileSizeBytes: row.file_size_bytes,
    sha256: row.sha256,
    uploadStatus: row.upload_status,
    validationStatus: row.validation_status,
    validationErrors: row.validation_errors ? JSON.parse(row.validation_errors) : null,
    metadata: JSON.parse(row.metadata || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Client-facing projection. Deliberately omits internal_storage_key so the
// server's filesystem/storage layout is never leaked to API consumers (there are
// no dataset download routes in this branch).
function toPublicDataset(dataset) {
  if (!dataset) return null;
  const { internalStorageKey, ...rest } = dataset; // eslint-disable-line no-unused-vars
  return rest;
}

/**
 * Create (register) a dataset in `projectId`. Requires the caller to be an
 * owner/admin/analyst project member (enforced here as defense-in-depth — the
 * route checks too). The id is server-generated; the storage key / sha256 / size
 * are NOT accepted here (they are filled by the upload flow). Throws coded errors
 * the route maps to HTTP statuses: `NOT_FOUND` (404), `FORBIDDEN` (403),
 * `INVALID_FILE_TYPE` / `INVALID_UPLOAD_STATUS` / `INVALID_VALIDATION_STATUS` /
 * `INVALID_STATUS_COMBO` / `INVALID_METADATA` / `INVALID_VALIDATION_ERRORS` (400).
 */
function createDatasetForProject(userId, projectId, input = {}) {
  const membership = requireProjectRole(userId, projectId, DATASET_WRITE_ROLES);
  const owner = membership.userId;

  if (!isValidDatasetFileType(input.fileType)) {
    throw codedError('INVALID_FILE_TYPE',
      `Invalid file_type. Allowed: ${[...ALLOWED_DATASET_FILE_TYPES].join(', ')}.`);
  }

  const uploadStatus = input.uploadStatus === undefined ? 'pending' : input.uploadStatus;
  if (!isValidDatasetUploadStatus(uploadStatus)) {
    throw codedError('INVALID_UPLOAD_STATUS',
      `Invalid upload_status. Allowed: ${[...DATASET_UPLOAD_STATUSES].join(', ')}.`);
  }
  const validationStatus = input.validationStatus === undefined ? 'pending' : input.validationStatus;
  if (!isValidDatasetValidationStatus(validationStatus)) {
    throw codedError('INVALID_VALIDATION_STATUS',
      `Invalid validation_status. Allowed: ${[...DATASET_VALIDATION_STATUSES].join(', ')}.`);
  }
  assertDatasetStatusCombo(uploadStatus, validationStatus);

  const metadata = input.metadata === undefined ? {} : input.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw codedError('INVALID_METADATA', 'metadata must be a plain JSON object.');
  }
  const validationErrors = normalizeValidationErrors(input.validationErrors);

  const id = generateDatasetId();
  db.prepare(`
    INSERT INTO datasets
      (id, project_id, owner_user_id, created_by_user_id, original_filename,
       file_type, upload_status, validation_status, validation_errors, metadata)
    VALUES
      (@id, @projectId, @owner, @owner, @originalFilename,
       @fileType, @uploadStatus, @validationStatus, @validationErrors, @metadata)
  `).run({
    id,
    projectId: String(projectId),
    owner,
    originalFilename: sanitizeDatasetFilename(input.originalFilename),
    fileType: input.fileType,
    uploadStatus,
    validationStatus,
    validationErrors,
    metadata: JSON.stringify(metadata)
  });

  return getDatasetRow(id, projectId);
}

// Low-level project-scoped row fetch (no auth — callers above have already
// authorized via requireProjectRole / verifyProjectMember).
function getDatasetRow(datasetId, projectId) {
  const row = db.prepare('SELECT * FROM datasets WHERE id = ? AND project_id = ?')
    .get(String(datasetId), String(projectId));
  return rowToDataset(row);
}

/** List a project's datasets (membership-scoped to any role). Filters are all
 * project-scoped, so a filter can never widen the query beyond the project. */
function listDatasetsForProject(userId, projectId, filters = {}) {
  requireProjectRole(userId, projectId, DATASET_READ_ROLES);

  const clauses = ['project_id = ?'];
  const params = [String(projectId)];
  if (filters.fileType !== undefined) {
    if (!isValidDatasetFileType(filters.fileType)) throw codedError('INVALID_FILE_TYPE', 'Invalid file_type filter.');
    clauses.push('file_type = ?'); params.push(filters.fileType);
  }
  if (filters.uploadStatus !== undefined) {
    if (!isValidDatasetUploadStatus(filters.uploadStatus)) throw codedError('INVALID_UPLOAD_STATUS', 'Invalid upload_status filter.');
    clauses.push('upload_status = ?'); params.push(filters.uploadStatus);
  }
  if (filters.validationStatus !== undefined) {
    if (!isValidDatasetValidationStatus(filters.validationStatus)) throw codedError('INVALID_VALIDATION_STATUS', 'Invalid validation_status filter.');
    clauses.push('validation_status = ?'); params.push(filters.validationStatus);
  }

  const rows = db.prepare(
    `SELECT * FROM datasets WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`
  ).all(...params);
  return rows.map(rowToDataset);
}

/** Return a dataset only if the caller is a project member and the dataset
 * belongs to that project; otherwise null (route → 404). Any role may read. */
function getDatasetForProject(userId, projectId, datasetId) {
  requireProjectRole(userId, projectId, DATASET_READ_ROLES);
  return getDatasetRow(datasetId, projectId);
}

/**
 * Resolve a dataset by id (no project id in the path) and authorize the caller
 * against the dataset's OWN project. This is the gate analysis-object / job
 * creation calls when a `datasetId` is supplied. Throws `DATASET_NOT_FOUND`
 * (404 — also for a non-member, so cross-project/cross-user references never
 * reveal existence) or `FORBIDDEN` (403 — a member lacking the role). Returns the
 * dataset on success.
 */
function verifyDatasetProjectAccess(userId, datasetId, allowedRoles = DATASET_READ_ROLES) {
  if (typeof datasetId !== 'string' || datasetId === '') {
    throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
  }
  const row = db.prepare('SELECT * FROM datasets WHERE id = ?').get(datasetId);
  if (!row) throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');

  const membership = verifyProjectMember(userId, row.project_id);
  // Non-member of the dataset's project → 404 (no existence leak), never 403.
  if (!membership) throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');

  const allowed = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  if (!allowed.includes(membership.role)) {
    throw codedError('FORBIDDEN', 'You do not have permission to use this dataset.');
  }
  return rowToDataset(row);
}

/**
 * Update a dataset's mutable, client-safe fields (validation_status,
 * validation_errors, upload_status, metadata, original_filename). Requires an
 * owner/admin/analyst project member. Server-only columns (storage key, sha256,
 * size, ids, owner) are never touched here. Throws `NOT_FOUND` (404, also when
 * the dataset is not in the project), `FORBIDDEN` (403), the same INVALID_*
 * codes as create, or `NO_FIELDS`.
 */
function updateDatasetForProject(userId, projectId, datasetId, input = {}) {
  requireProjectRole(userId, projectId, DATASET_WRITE_ROLES);
  const existing = getDatasetRow(datasetId, projectId);
  if (!existing) throw codedError('NOT_FOUND', 'Dataset not found.');

  const sets = [];
  const params = { id: String(datasetId), projectId: String(projectId) };

  let nextUpload = existing.uploadStatus;
  let nextValidation = existing.validationStatus;

  if (input.uploadStatus !== undefined) {
    if (!isValidDatasetUploadStatus(input.uploadStatus)) {
      throw codedError('INVALID_UPLOAD_STATUS', 'Invalid upload_status.');
    }
    nextUpload = input.uploadStatus;
    sets.push('upload_status = @uploadStatus'); params.uploadStatus = input.uploadStatus;
  }
  if (input.validationStatus !== undefined) {
    if (!isValidDatasetValidationStatus(input.validationStatus)) {
      throw codedError('INVALID_VALIDATION_STATUS', 'Invalid validation_status.');
    }
    nextValidation = input.validationStatus;
    sets.push('validation_status = @validationStatus'); params.validationStatus = input.validationStatus;
  }
  // Re-check the combo against the resulting (possibly mixed old/new) state.
  assertDatasetStatusCombo(nextUpload, nextValidation);

  if (input.validationErrors !== undefined) {
    sets.push('validation_errors = @validationErrors');
    params.validationErrors = normalizeValidationErrors(input.validationErrors);
  }
  if (input.metadata !== undefined) {
    if (input.metadata === null || typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
      throw codedError('INVALID_METADATA', 'metadata must be a plain JSON object.');
    }
    sets.push('metadata = @metadata'); params.metadata = JSON.stringify(input.metadata);
  }
  if (input.originalFilename !== undefined) {
    sets.push('original_filename = @originalFilename');
    params.originalFilename = sanitizeDatasetFilename(input.originalFilename);
  }

  if (sets.length === 0) throw codedError('NO_FIELDS', 'No updatable fields provided.');
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE datasets SET ${sets.join(', ')} WHERE id = @id AND project_id = @projectId`).run(params);
  return getDatasetRow(datasetId, projectId);
}

/**
 * Record the result of a successful server-side file store: marks the dataset
 * `uploaded` and fills the server-chosen storage key + computed sha256/size.
 * Server-internal (the route has already authorized the create); not reachable
 * from client input. validation_status is left untouched (stays `pending` —
 * deep format validation is not performed in this branch).
 */
function markDatasetUploaded(projectId, datasetId, { internalStorageKey, storageUri = null, sha256, fileSizeBytes }) {
  db.prepare(`
    UPDATE datasets
       SET upload_status = 'uploaded', internal_storage_key = @internalStorageKey,
           storage_uri = @storageUri, sha256 = @sha256, file_size_bytes = @fileSizeBytes,
           updated_at = datetime('now')
     WHERE id = @id AND project_id = @projectId
  `).run({
    id: String(datasetId), projectId: String(projectId),
    internalStorageKey: internalStorageKey != null ? String(internalStorageKey) : null,
    storageUri: storageUri != null ? String(storageUri) : null,
    sha256: sha256 != null ? String(sha256) : null,
    fileSizeBytes: Number.isFinite(fileSizeBytes) ? fileSizeBytes : null
  });
  return getDatasetRow(datasetId, projectId);
}

/** Mark a dataset's upload as failed (storage did not complete). Server-internal.
 * A failed upload must never look valid, so validation_status is forced back to
 * a non-valid state. */
function markDatasetUploadFailed(projectId, datasetId) {
  db.prepare(`
    UPDATE datasets
       SET upload_status = 'failed',
           validation_status = CASE WHEN validation_status = 'valid' THEN 'invalid' ELSE validation_status END,
           updated_at = datetime('now')
     WHERE id = @id AND project_id = @projectId
  `).run({ id: String(datasetId), projectId: String(projectId) });
  return getDatasetRow(datasetId, projectId);
}

// ── Project-scoped analysis objects & jobs ───────────────────────
//
// These helpers add a project_id association + project-member metadata
// visibility on top of the existing user-scoped analysis_objects / jobs
// records. They authorize through the caller's project_members role
// (requireProjectRole), exactly like the datasets layer, so:
//   - unknown / inaccessible project → NOT_FOUND (404; no existence leak),
//   - known member lacking the role  → FORBIDDEN (403).
// Create requires owner/admin/analyst; list/read metadata is allowed for any
// member (incl. viewer). project_id is taken from the authorized route project,
// never from client input, and every cross-resource reference (dataset, parent
// object, lineage root, linked analysis objects) is confined to the SAME project
// so lineage/links can never cross a project boundary.
//
// IMPORTANT (constraint of this branch): this is project-scoped *metadata/
// history* only. It does NOT touch R execution/state, which stays user/object-
// keyed (see verifyAnalysisObjectOwner / deriveRStateKey in server.js). A
// project member seeing an object's metadata does NOT gain access to another
// user's live R session. Creator ownership (owner_user_id) is retained.

const ANALYSIS_WRITE_ROLES = ['owner', 'admin', 'analyst'];
const ANALYSIS_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const PROJECT_JOB_WRITE_ROLES = ['owner', 'admin', 'analyst'];
const PROJECT_JOB_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];

// Low-level project-scoped row fetches (no auth — callers above have already
// authorized via requireProjectRole). A row in another project is invisible.
function getProjectAnalysisObjectRow(objectId, projectId) {
  if (typeof objectId !== 'string' || objectId === '') return null;
  const row = db.prepare('SELECT * FROM analysis_objects WHERE id = ? AND project_id = ?')
    .get(objectId, String(projectId));
  return rowToAnalysisObject(row);
}

function getProjectJobRow(jobId, projectId) {
  if (typeof jobId !== 'string' || jobId === '') return null;
  const row = db.prepare('SELECT * FROM jobs WHERE id = ? AND project_id = ?')
    .get(jobId, String(projectId));
  return rowToJob(row);
}

/**
 * Create a project-scoped analysis object. Requires the caller to be an
 * owner/admin/analyst of `projectId`. project_id is set from the route project,
 * never the body. A supplied datasetId / parentObjectId must belong to the SAME
 * project (else 404, no cross-project lineage or references). Lineage root is
 * inherited from the parent within the project. Throws coded errors
 * (`NOT_FOUND`, `FORBIDDEN`, `INVALID_OBJECT_TYPE`, `INVALID_METADATA`,
 * `DATASET_NOT_FOUND`, `PARENT_NOT_FOUND`).
 */
function createProjectAnalysisObject(userId, projectId, input = {}) {
  const membership = requireProjectRole(userId, projectId, ANALYSIS_WRITE_ROLES);
  const owner = membership.userId;
  const pid = String(projectId);

  const objectType = typeof input.objectType === 'string' ? input.objectType.trim() : '';
  if (!isValidObjectType(objectType)) {
    throw codedError('INVALID_OBJECT_TYPE',
      `Invalid objectType. Allowed: ${[...ALLOWED_OBJECT_TYPES].join(', ')}.`);
  }

  const metadata = input.metadata === undefined ? {} : input.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw codedError('INVALID_METADATA', 'metadata must be a plain JSON object.');
  }

  // A supplied datasetId must reference a dataset in THIS project. Looking it up
  // by (id, project_id) enforces same-project: a dataset in another project (or
  // unknown) is invisible → 404. The caller is already an authorized write-member
  // of this project, so no separate dataset role check is needed.
  let datasetId = null;
  if (input.datasetId !== undefined && input.datasetId !== null) {
    if (typeof input.datasetId !== 'string' || !getDatasetRow(input.datasetId, pid)) {
      throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
    }
    datasetId = input.datasetId;
  }

  // A supplied parentObjectId must be an analysis object in THIS project (created
  // by any project member). Lineage root is inherited only within the project.
  const parentObjectId = input.parentObjectId ? String(input.parentObjectId) : null;
  let lineageRootId = null;
  if (parentObjectId) {
    const parent = getProjectAnalysisObjectRow(parentObjectId, pid);
    if (!parent) {
      throw codedError('PARENT_NOT_FOUND', 'Parent analysis object not found.');
    }
    lineageRootId = parent.lineageRootId || parent.id;
  }

  const id = generateAnalysisObjectId();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO analysis_objects
        (id, owner_user_id, project_id, dataset_id, parent_object_id, lineage_root_id, object_type,
         display_name, storage_uri, object_hash, metadata_json, created_by_provenance_id)
      VALUES
        (@id, @owner, @projectId, @datasetId, @parentObjectId, @lineageRootId, @objectType,
         @displayName, @storageUri, @objectHash, @metadataJson, @createdByProvenanceId)
    `).run({
      id,
      owner,
      projectId: pid,
      datasetId,
      parentObjectId,
      lineageRootId,
      objectType,
      displayName: input.displayName != null ? String(input.displayName) : null,
      storageUri: input.storageUri != null ? String(input.storageUri) : null,
      objectHash: input.objectHash != null ? String(input.objectHash) : null,
      metadataJson: JSON.stringify(metadata),
      createdByProvenanceId: input.createdByProvenanceId ? String(input.createdByProvenanceId) : null
    });

    if (!parentObjectId) {
      db.prepare('UPDATE analysis_objects SET lineage_root_id = id WHERE id = ?').run(id);
    } else {
      // Atomically record the DAG edge so the edge table is the complete graph
      // source for live reads (not only after an init-time backfill). Single-parent
      // `derived_from`, primary role, no job; project_id is the (already same-project)
      // parent's project. The child is brand-new, so no cycle is possible. The
      // parent_object_id / lineage_root_id columns above remain the compatibility/
      // fast-path fields.
      _insertLineageEdgeRow({
        projectId: pid,
        parentObjectId,
        childObjectId: id,
        jobId: null,
        edgeType: 'derived_from',
        parentRole: 'primary',
        metadata: {},
        createdByUserId: owner,
        now: dbNow()
      });
    }
  }).immediate();

  return getProjectAnalysisObjectRow(id, pid);
}

/** List a project's analysis objects (any member may read). Filters are all
 * project-scoped, so a filter can never widen the query beyond the project. */
function listProjectAnalysisObjects(userId, projectId, filters = {}) {
  requireProjectRole(userId, projectId, ANALYSIS_READ_ROLES);
  const clauses = ['project_id = ?'];
  const params = [String(projectId)];
  if (filters.datasetId) { clauses.push('dataset_id = ?'); params.push(String(filters.datasetId)); }
  if (filters.parentObjectId) { clauses.push('parent_object_id = ?'); params.push(String(filters.parentObjectId)); }
  if (filters.lineageRootId) { clauses.push('lineage_root_id = ?'); params.push(String(filters.lineageRootId)); }
  if (filters.objectType) { clauses.push('object_type = ?'); params.push(String(filters.objectType)); }
  const rows = db.prepare(
    `SELECT * FROM analysis_objects WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`
  ).all(...params);
  return rows.map(rowToAnalysisObject);
}

/** Return a project analysis object only if the caller is a member and the
 * object belongs to that project; otherwise null (route → 404). Any role reads. */
function getProjectAnalysisObject(userId, projectId, objectId) {
  requireProjectRole(userId, projectId, ANALYSIS_READ_ROLES);
  return getProjectAnalysisObjectRow(objectId, projectId);
}

/**
 * Create a project-scoped job. Requires owner/admin/analyst of `projectId`.
 * project_id and owner_user_id are server-set; status starts at INITIAL_JOB_STATUS
 * (clients cannot choose a status). A supplied analysisObjectId /
 * resultAnalysisObjectId / datasetId must belong to the SAME project (else 404).
 * Throws coded errors (`NOT_FOUND`, `FORBIDDEN`, `INVALID_JOB_TYPE`,
 * `INVALID_PARAMETERS`, `ANALYSIS_OBJECT_NOT_FOUND`, `RESULT_OBJECT_NOT_FOUND`,
 * `DATASET_NOT_FOUND`).
 */
function createProjectJob(userId, projectId, input = {}) {
  const membership = requireProjectRole(userId, projectId, PROJECT_JOB_WRITE_ROLES);
  const owner = membership.userId;
  const pid = String(projectId);

  const jobType = typeof input.jobType === 'string' ? input.jobType.trim() : '';
  if (!isValidJobType(jobType)) {
    throw codedError('INVALID_JOB_TYPE',
      `Invalid jobType. Allowed: ${[...ALLOWED_JOB_TYPES].join(', ')}.`);
  }

  const parameters = input.parameters === undefined ? {} : input.parameters;
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw codedError('INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
  }

  let analysisObjectId = null;
  if (input.analysisObjectId !== undefined && input.analysisObjectId !== null) {
    if (typeof input.analysisObjectId !== 'string' || !getProjectAnalysisObjectRow(input.analysisObjectId, pid)) {
      throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    }
    analysisObjectId = input.analysisObjectId;
  }

  // An optional resultAnalysisObjectId pre-links a job to an already-existing
  // result object in the SAME project (the status machine is the usual writer of
  // this field; here it is metadata only). Cross-project / unknown → 404.
  let resultAnalysisObjectId = null;
  if (input.resultAnalysisObjectId !== undefined && input.resultAnalysisObjectId !== null) {
    if (typeof input.resultAnalysisObjectId !== 'string' || !getProjectAnalysisObjectRow(input.resultAnalysisObjectId, pid)) {
      throw codedError('RESULT_OBJECT_NOT_FOUND', 'Result analysis object not found.');
    }
    resultAnalysisObjectId = input.resultAnalysisObjectId;
  }

  let datasetId = null;
  if (input.datasetId !== undefined && input.datasetId !== null) {
    if (typeof input.datasetId !== 'string' || !getDatasetRow(input.datasetId, pid)) {
      throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
    }
    datasetId = input.datasetId;
  }

  const id = generateJobId();
  db.prepare(`
    INSERT INTO jobs
      (id, owner_user_id, project_id, analysis_object_id, result_analysis_object_id, dataset_id,
       job_type, status, parameters_json)
    VALUES
      (@id, @owner, @projectId, @analysisObjectId, @resultAnalysisObjectId, @datasetId,
       @jobType, @status, @parametersJson)
  `).run({
    id,
    owner,
    projectId: pid,
    analysisObjectId,
    resultAnalysisObjectId,
    datasetId,
    jobType,
    status: INITIAL_JOB_STATUS,
    parametersJson: JSON.stringify(parameters)
  });

  return getProjectJobRow(id, pid);
}

/** List a project's jobs (any member may read). Filters are project-scoped. */
function listProjectJobs(userId, projectId, filters = {}) {
  requireProjectRole(userId, projectId, PROJECT_JOB_READ_ROLES);
  const clauses = ['project_id = ?'];
  const params = [String(projectId)];
  if (filters.status) { clauses.push('status = ?'); params.push(String(filters.status)); }
  if (filters.jobType) { clauses.push('job_type = ?'); params.push(String(filters.jobType)); }
  if (filters.analysisObjectId) { clauses.push('analysis_object_id = ?'); params.push(String(filters.analysisObjectId)); }
  if (filters.resultAnalysisObjectId) { clauses.push('result_analysis_object_id = ?'); params.push(String(filters.resultAnalysisObjectId)); }
  if (filters.datasetId) { clauses.push('dataset_id = ?'); params.push(String(filters.datasetId)); }
  const rows = db.prepare(
    `SELECT * FROM jobs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`
  ).all(...params);
  return rows.map(rowToJob);
}

/** Return a project job only if the caller is a member and the job belongs to
 * that project; otherwise null (route → 404). Any role reads metadata/logs. */
function getProjectJob(userId, projectId, jobId) {
  requireProjectRole(userId, projectId, PROJECT_JOB_READ_ROLES);
  return getProjectJobRow(jobId, projectId);
}

/**
 * Cancel a cancelable project job. Authorization:
 *   - owner/admin may cancel any cancelable job in the project,
 *   - analyst may cancel only their OWN cancelable jobs (else 403),
 *   - viewer may not cancel (403; FORBIDDEN from requireProjectRole),
 *   - non-member → 404 (NOT_FOUND from requireProjectRole).
 * An unknown / cross-project job → `JOB_NOT_FOUND` (404). An already-terminal job
 * → `JOB_NOT_CANCELABLE` (409). Does NOT touch any R process — there is no
 * execution abstraction to interrupt in this branch.
 */
function cancelProjectJob(userId, projectId, jobId) {
  const membership = requireProjectRole(userId, projectId, PROJECT_JOB_WRITE_ROLES);
  const pid = String(projectId);
  const job = getProjectJobRow(jobId, pid);
  if (!job) throw codedError('JOB_NOT_FOUND', 'Job not found.');

  // An analyst may only cancel jobs they created. Checked before the terminal
  // guard so an analyst acting on someone else's job always sees 403, not 409.
  if (membership.role === 'analyst' && job.ownerUserId !== membership.userId) {
    throw codedError('FORBIDDEN', 'Analysts can only cancel their own jobs.');
  }
  if (TERMINAL_JOB_STATUSES.has(job.status)) {
    throw codedError('JOB_NOT_CANCELABLE', `Job is already ${job.status}.`);
  }

  // Project-scoped status mutation: keyed by (id, project_id) — NOT owner — so an
  // owner/admin can cancel a job another member created. Only non-terminal →
  // canceled reaches here, which is always a valid transition. Canceling voids any
  // live worker claim (clear claim_token + lease_expires_at) exactly like the
  // owner-scoped path, so a worker mid-flight on this job fails its next
  // heartbeat/complete/fail deterministically (CLAIM_LOST); worker_id is retained
  // for audit. No R process is touched — there is no executor to interrupt.
  const logs = [...job.logs, normalizeJobLogEntry({ level: 'info', message: 'Job canceled.' })];
  db.prepare(`
    UPDATE jobs SET
      status = 'canceled',
      logs_json = @logsJson,
      updated_at = datetime('now'),
      canceled_at = datetime('now'),
      claim_token = NULL,
      lease_expires_at = NULL
    WHERE id = @id AND project_id = @projectId
  `).run({ id: String(jobId), projectId: pid, logsJson: JSON.stringify(logs) });

  return getProjectJobRow(jobId, pid);
}

// ── Project-scoped provenance & figure metadata ──────────────────
//
// These helpers add a project_id association + project-member metadata
// visibility on top of provenance / figure_collection, exactly like the
// project-scoped analysis-objects/jobs layer above. They authorize through the
// caller's project_members role (requireProjectRole):
//   - unknown / inaccessible project → NOT_FOUND (404; no existence leak),
//   - known member lacking the role  → FORBIDDEN (403).
// Create requires owner/admin/analyst; list/read metadata is allowed for any
// member (incl. viewer). project_id is taken from the authorized route project,
// never from client input; the responsible actor is created_by_user_id (from the
// session), and every cross-resource reference (dataset, analysis object, job,
// result object, parent/linked provenance) is confined to the SAME project so an
// association can never cross a project boundary.
//
// Project-scoped rows are written with user_email = '' so they never intersect
// the owner-scoped user_email CRUD surface (list/get/delete all scope by a real,
// non-empty user_email). That also keeps them append-only — there is no project
// provenance/figure delete or update route in this branch. This is project
// metadata/history ONLY: it does NOT touch R execution/state (still user/object-
// keyed) and, for figures, NEVER stores or returns a file path — there is no
// figure file access/download surface here.

const PROVENANCE_WRITE_ROLES = ['owner', 'admin', 'analyst'];
const PROVENANCE_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const FIGURE_WRITE_ROLES = ['owner', 'admin', 'analyst'];
const FIGURE_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];

function generateProvenanceId() {
  // Server-generated, header-safe by construction: `prov_` + lowercase hex.
  return `prov_${crypto.randomBytes(12).toString('hex')}`;
}

function generateFigureId() {
  // Server-generated, header/path-safe by construction: `fig_` + lowercase hex.
  return `fig_${crypto.randomBytes(12).toString('hex')}`;
}

// Low-level project-scoped row fetches (no auth — callers above have already
// authorized via requireProjectRole). A row in another project — or a legacy row
// with NULL project_id — is invisible (project_id here is always a real id).
function getProjectProvenanceRow(provenanceId, projectId) {
  if (typeof provenanceId !== 'string' || provenanceId === '') return null;
  const row = db.prepare('SELECT * FROM provenance WHERE id = ? AND project_id = ?')
    .get(provenanceId, String(projectId));
  return rowToProjectProvenance(row);
}

function getProjectFigureRow(figureId, projectId) {
  if (typeof figureId !== 'string' || figureId === '') return null;
  const row = db.prepare('SELECT * FROM figure_collection WHERE id = ? AND project_id = ?')
    .get(figureId, String(projectId));
  return rowToProjectFigure(row);
}

function rowToProjectProvenance(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    createdByUserId: row.created_by_user_id,
    datasetId: row.dataset_id,
    analysisObjectId: row.analysis_object_id,
    jobId: row.job_id,
    resultAnalysisObjectId: row.result_analysis_object_id,
    timestamp: row.timestamp,
    language: row.language,
    languageVersion: row.language_version,
    packages: JSON.parse(row.packages || '[]'),
    script: row.script,
    parameters: JSON.parse(row.parameters || '{}'),
    parentIds: JSON.parse(row.parent_ids || '[]'),
    operation: row.operation || 'unknown',
    createdAt: row.created_at
  };
}

// The project figure serializer NEVER exposes file_path (or any raw storage
// path): project figures are metadata only and there is no file-serving route.
function rowToProjectFigure(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    createdByUserId: row.created_by_user_id,
    analysisObjectId: row.analysis_object_id,
    jobId: row.job_id,
    provenanceId: row.provenance_id,
    datasetId: row.dataset_id,
    plotType: row.plot_type,
    title: row.title,
    params: JSON.parse(row.params_json || '{}'),
    fileFormat: row.file_format,
    thumbnailB64: row.thumbnail_b64,
    createdAt: row.created_at
  };
}

// Validate that every optional reference on a project provenance/figure resolves
// WITHIN the route's project. A reference to another project (or unknown) throws
// the resource's NOT_FOUND code → 404, so an association can never cross a project
// boundary (and a two-project member cannot link project A metadata to a project B
// resource). Returns the normalized subset of references that were supplied.
function resolveSameProjectRefs(pid, input, { allowResult = false, allowProvenanceRef = false, allowParents = false } = {}) {
  const out = {};

  if (input.datasetId !== undefined && input.datasetId !== null) {
    if (typeof input.datasetId !== 'string' || !getDatasetRow(input.datasetId, pid)) {
      throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
    }
    out.datasetId = input.datasetId;
  }
  if (input.analysisObjectId !== undefined && input.analysisObjectId !== null) {
    if (typeof input.analysisObjectId !== 'string' || !getProjectAnalysisObjectRow(input.analysisObjectId, pid)) {
      throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    }
    out.analysisObjectId = input.analysisObjectId;
  }
  if (input.jobId !== undefined && input.jobId !== null) {
    if (typeof input.jobId !== 'string' || !getProjectJobRow(input.jobId, pid)) {
      throw codedError('JOB_NOT_FOUND', 'Job not found.');
    }
    out.jobId = input.jobId;
  }
  if (allowResult && input.resultAnalysisObjectId !== undefined && input.resultAnalysisObjectId !== null) {
    if (typeof input.resultAnalysisObjectId !== 'string' || !getProjectAnalysisObjectRow(input.resultAnalysisObjectId, pid)) {
      throw codedError('RESULT_OBJECT_NOT_FOUND', 'Result analysis object not found.');
    }
    out.resultAnalysisObjectId = input.resultAnalysisObjectId;
  }
  if (allowProvenanceRef && input.provenanceId !== undefined && input.provenanceId !== null) {
    if (typeof input.provenanceId !== 'string' || !getProjectProvenanceRow(input.provenanceId, pid)) {
      throw codedError('PROVENANCE_NOT_FOUND', 'Provenance record not found.');
    }
    out.provenanceId = input.provenanceId;
  }
  if (allowParents && input.parentIds !== undefined && input.parentIds !== null) {
    if (!Array.isArray(input.parentIds)) {
      throw codedError('INVALID_PARENT_IDS', 'parentIds must be an array.');
    }
    for (const parentId of input.parentIds) {
      if (typeof parentId !== 'string' || !getProjectProvenanceRow(parentId, pid)) {
        throw codedError('PARENT_NOT_FOUND', 'Parent provenance record not found.');
      }
    }
    out.parentIds = input.parentIds.map(String);
  }
  return out;
}

/**
 * Create a project-scoped provenance record. Requires owner/admin/analyst of
 * `projectId`. project_id is set from the route, the actor from the session.
 * Optional dataset/analysisObject/job/result/parent references must all resolve
 * within the SAME project (else 404). Append-only — there is no project provenance
 * update/delete route. Throws coded errors (`NOT_FOUND`, `FORBIDDEN`,
 * `INVALID_PARAMETERS`, `INVALID_PACKAGES`, `INVALID_PARENT_IDS`,
 * `DATASET_NOT_FOUND`, `ANALYSIS_OBJECT_NOT_FOUND`, `JOB_NOT_FOUND`,
 * `RESULT_OBJECT_NOT_FOUND`, `PARENT_NOT_FOUND`).
 */
function createProjectProvenance(userId, projectId, input = {}) {
  const membership = requireProjectRole(userId, projectId, PROVENANCE_WRITE_ROLES);
  const actor = membership.userId;
  const pid = String(projectId);

  const parameters = input.parameters === undefined ? {} : input.parameters;
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw codedError('INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
  }
  const packages = input.packages === undefined ? [] : input.packages;
  if (!Array.isArray(packages)) {
    throw codedError('INVALID_PACKAGES', 'packages must be an array.');
  }

  const refs = resolveSameProjectRefs(pid, input, { allowResult: true, allowParents: true });

  const id = generateProvenanceId();
  db.prepare(`
    INSERT INTO provenance
      (id, user_email, project_id, created_by_user_id, dataset_id, analysis_object_id, job_id,
       result_analysis_object_id, timestamp, language, language_version, packages, script,
       parameters, parent_ids, operation)
    VALUES
      (@id, '', @projectId, @actor, @datasetId, @analysisObjectId, @jobId,
       @resultAnalysisObjectId, @timestamp, @language, @languageVersion, @packages, @script,
       @parameters, @parentIds, @operation)
  `).run({
    id,
    projectId: pid,
    actor,
    datasetId: refs.datasetId || null,
    analysisObjectId: refs.analysisObjectId || null,
    jobId: refs.jobId || null,
    resultAnalysisObjectId: refs.resultAnalysisObjectId || null,
    timestamp: input.timestamp != null ? String(input.timestamp) : new Date().toISOString(),
    language: input.language != null ? String(input.language) : '',
    languageVersion: input.languageVersion != null ? String(input.languageVersion) : '',
    packages: JSON.stringify(packages),
    script: input.script != null ? String(input.script) : '',
    parameters: JSON.stringify(parameters),
    parentIds: JSON.stringify(refs.parentIds || []),
    operation: input.operation != null ? String(input.operation) : 'unknown'
  });

  return getProjectProvenanceRow(id, pid);
}

/** List a project's provenance (any member may read). Filters are project-scoped,
 * so a filter can never widen the query beyond the project. Legacy NULL-project_id
 * rows never appear (the WHERE always pins a real project_id). */
function listProjectProvenance(userId, projectId, filters = {}) {
  requireProjectRole(userId, projectId, PROVENANCE_READ_ROLES);
  const clauses = ['project_id = ?'];
  const params = [String(projectId)];
  if (filters.datasetId) { clauses.push('dataset_id = ?'); params.push(String(filters.datasetId)); }
  if (filters.analysisObjectId) { clauses.push('analysis_object_id = ?'); params.push(String(filters.analysisObjectId)); }
  if (filters.jobId) { clauses.push('job_id = ?'); params.push(String(filters.jobId)); }
  if (filters.operation) { clauses.push('operation = ?'); params.push(String(filters.operation)); }
  const rows = db.prepare(
    `SELECT * FROM provenance WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`
  ).all(...params);
  return rows.map(rowToProjectProvenance);
}

/** Return a project provenance record only if the caller is a member and the row
 * belongs to that project; otherwise null (route → 404). Any role reads. */
function getProjectProvenance(userId, projectId, provenanceId) {
  requireProjectRole(userId, projectId, PROVENANCE_READ_ROLES);
  return getProjectProvenanceRow(provenanceId, projectId);
}

/**
 * Create a project-scoped figure metadata record. Requires owner/admin/analyst of
 * `projectId`. project_id is set from the route, the actor from the session.
 * Optional analysisObject/job/provenance/dataset references must resolve within
 * the SAME project (else 404). file_path is ALWAYS '' here — a client never
 * supplies one (the route rejects filePath/storage* fields) and none is returned.
 * Throws coded errors (`NOT_FOUND`, `FORBIDDEN`, `INVALID_PARAMETERS`,
 * `INVALID_PLOT_TYPE`, `ANALYSIS_OBJECT_NOT_FOUND`, `JOB_NOT_FOUND`,
 * `PROVENANCE_NOT_FOUND`, `DATASET_NOT_FOUND`).
 */
function createProjectFigure(userId, projectId, input = {}) {
  const membership = requireProjectRole(userId, projectId, FIGURE_WRITE_ROLES);
  const actor = membership.userId;
  const pid = String(projectId);

  const params = input.params === undefined ? {} : input.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw codedError('INVALID_PARAMETERS', 'params must be a plain JSON object.');
  }
  const plotType = input.plotType === undefined || input.plotType === null ? 'Unknown' : input.plotType;
  if (typeof plotType !== 'string' || plotType === '') {
    throw codedError('INVALID_PLOT_TYPE', 'plotType must be a non-empty string.');
  }

  const refs = resolveSameProjectRefs(pid, input, { allowProvenanceRef: true });

  const id = generateFigureId();
  // file_path is ALWAYS '' on the project route: a client never supplies a path
  // (the route rejects filePath/file_path/storage* fields) and the server stores
  // none — there is intentionally no figure file access/download surface.
  db.prepare(`
    INSERT INTO figure_collection
      (id, user_email, project_id, created_by_user_id, analysis_object_id, job_id, provenance_id,
       dataset_id, plot_type, title, params_json, file_path, file_format, thumbnail_b64)
    VALUES
      (@id, '', @projectId, @actor, @analysisObjectId, @jobId, @provenanceId,
       @datasetId, @plotType, @title, @paramsJson, '', @fileFormat, @thumbnailB64)
  `).run({
    id,
    projectId: pid,
    actor,
    analysisObjectId: refs.analysisObjectId || null,
    jobId: refs.jobId || null,
    provenanceId: refs.provenanceId || null,
    datasetId: refs.datasetId || null,
    plotType,
    title: input.title != null ? String(input.title) : '',
    paramsJson: JSON.stringify(params),
    fileFormat: input.fileFormat != null ? String(input.fileFormat) : 'png',
    thumbnailB64: input.thumbnailB64 != null ? String(input.thumbnailB64) : ''
  });

  return getProjectFigureRow(id, pid);
}

/** List a project's figure metadata (any member may read). Filters are
 * project-scoped; legacy NULL-project_id rows never appear. */
function listProjectFigures(userId, projectId, filters = {}) {
  requireProjectRole(userId, projectId, FIGURE_READ_ROLES);
  const clauses = ['project_id = ?'];
  const params = [String(projectId)];
  if (filters.analysisObjectId) { clauses.push('analysis_object_id = ?'); params.push(String(filters.analysisObjectId)); }
  if (filters.jobId) { clauses.push('job_id = ?'); params.push(String(filters.jobId)); }
  if (filters.provenanceId) { clauses.push('provenance_id = ?'); params.push(String(filters.provenanceId)); }
  if (filters.datasetId) { clauses.push('dataset_id = ?'); params.push(String(filters.datasetId)); }
  if (filters.plotType) { clauses.push('plot_type = ?'); params.push(String(filters.plotType)); }
  const rows = db.prepare(
    `SELECT * FROM figure_collection WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`
  ).all(...params);
  return rows.map(rowToProjectFigure);
}

/** Return a project figure record only if the caller is a member and the row
 * belongs to that project; otherwise null (route → 404). Any role reads. */
function getProjectFigure(userId, projectId, figureId) {
  requireProjectRole(userId, projectId, FIGURE_READ_ROLES);
  return getProjectFigureRow(figureId, projectId);
}

// ── Job artifacts & checkpoints (durable output metadata) ────────
//
// The durable, metadata-FIRST record of a job's output. This branch wires the
// model + a placeholder (`checkpoint.noop`) worker handler ONLY: there is NO raw
// artifact download, NO object storage, NO reproducibility bundle, NO generated-R-
// script export, and NO real R/Seurat pipeline writing here. Artifact creation is
// worker/helper-driven (there is no public create route); identity and scope are
// server-owned and derived from the SOURCE JOB:
//   - id is server-generated (`art_...`),
//   - project_id + created_by_user_id come from the job (project_id/owner_user_id),
//     never from client input,
//   - storage_uri / checksum / size / status are server/worker-set, never accepted
//     from a request body, and storage_uri is NEVER returned by the read APIs.
// Every optional reference (dataset / analysis object / result object / provenance
// / figure) is confined to the job's OWN scope: same project for a project job,
// same owner for a legacy owner-scoped job. A reference that does not resolve in
// that scope is a 404, so an artifact can never cross a project (or user) boundary.

const ALLOWED_ARTIFACT_TYPES = new Set([
  'checkpoint', 'metrics', 'log', 'figure', 'script_fragment', 'other_metadata',
  // Operational/inspection metadata recorded by the minimal worker-to-R bridge
  // (backend/rWorkerBridge.js + the `r.runtime.check` worker handler). Metadata-only,
  // not a scientific result: it captures sanitized R runtime status, never object data.
  'r_runtime_check',
  // Read-only object-inspection metadata recorded by the `r.object.inspect` worker
  // handler. Metadata-only (storage_kind metadata_only), not a scientific result: a
  // sanitized object summary (class/dimensions/assay+reduction+metadata-field names,
  // runtime versions) — never expression/cell/gene data, embeddings, paths, or the
  // R state key. read_only: true, scientific_output: false.
  'r_object_inspection',
  // Scientific result summary recorded by the `pbmc.pipeline.v1` worker handler: a
  // sanitized, bounded summary of a PBMC/Seurat preprocessing run (cell/feature/
  // variable-feature/PC/cluster counts, reduction NAMES, resolved parameters, R/
  // package versions). Metadata-only (storage_kind metadata_only); the durable
  // object/file itself is recorded separately as a `checkpoint` artifact. Never
  // contains expression matrices, per-cell/gene tables, embeddings, paths, or the R
  // state key. scientific_output: true.
  'pipeline_summary'
]);

// metadata_only is the only kind the placeholder handler writes in this branch.
// local_internal is reserved for a future local-store branch; object_storage is
// intentionally NOT accepted yet (there is no object storage). Either way the
// public projection omits storage_uri, so an internal/local path never escapes.
const ALLOWED_ARTIFACT_STORAGE_KINDS = new Set(['metadata_only', 'local_internal']);

const ALLOWED_ARTIFACT_STATUSES = new Set(['available', 'pending', 'error']);

function isValidArtifactType(t) { return ALLOWED_ARTIFACT_TYPES.has(t); }
function isValidArtifactStorageKind(k) { return ALLOWED_ARTIFACT_STORAGE_KINDS.has(k); }
function isValidArtifactStatus(s) { return ALLOWED_ARTIFACT_STATUSES.has(s); }

function generateJobArtifactId() {
  // Server-generated, header/path-safe by construction: `art_` + lowercase hex.
  return `art_${crypto.randomBytes(12).toString('hex')}`;
}

const ARTIFACT_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];

// Full internal row mapping (includes storage_uri / internal fields). Server-tier
// only — never returned directly to a client (routes use toPublicJobArtifact).
function rowToJobArtifact(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    datasetId: row.dataset_id,
    analysisObjectId: row.analysis_object_id,
    resultAnalysisObjectId: row.result_analysis_object_id,
    provenanceId: row.provenance_id,
    figureId: row.figure_id,
    createdByUserId: row.created_by_user_id,
    artifactType: row.artifact_type,
    name: row.name,
    description: row.description,
    mimeType: row.mime_type,
    storageKind: row.storage_kind,
    storageUri: row.storage_uri,
    checksumSha256: row.checksum_sha256,
    sizeBytes: row.size_bytes,
    status: row.status,
    metadata: JSON.parse(row.metadata_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Client-facing projection. Deliberately OMITS storage_uri so an internal/local
// storage path or key can never leak to an API consumer (there is no artifact
// download route in this branch). Checksum/size/storageKind are safe descriptive
// metadata and are kept; storage_uri is the only field stripped.
function toPublicJobArtifact(artifact) {
  if (!artifact) return null;
  const { storageUri, ...rest } = artifact; // eslint-disable-line no-unused-vars
  return rest;
}

function getJobArtifactRowById(id) {
  if (typeof id !== 'string' || id === '') return null;
  const row = db.prepare('SELECT * FROM job_artifacts WHERE id = ?').get(id);
  return rowToJobArtifact(row);
}

/** Server-tier-internal: all artifacts for a job id, regardless of project scope
 * (incl. legacy NULL-project / owner-scoped jobs). Like getWorkerJob this is NOT
 * wired to any client route — the public surface is the role-checked project
 * artifact routes. Used by the worker/tests to verify exactly-once artifact writes. */
function getJobArtifactsByJobId(jobId) {
  if (typeof jobId !== 'string' || jobId === '') return [];
  return db.prepare('SELECT * FROM job_artifacts WHERE job_id = ? ORDER BY created_at ASC, id ASC')
    .all(String(jobId))
    .map(rowToJobArtifact);
}

// Resolve a job artifact's optional references against the job's OWN scope. For a
// project job every reference must resolve within the job's project (else 404 via
// the resource's NOT_FOUND code); for a legacy owner-scoped job, object references
// must be owned by the same user and project-only resources (dataset/provenance/
// figure) are rejected (there is no owner-scoped same-scope check for them). Each
// reference defaults to the job's corresponding column when not supplied, so an
// artifact is auto-associated with the job's own (already same-scope) references.
function resolveArtifactRefs(job, input) {
  const pid = job.project_id || null;
  const owner = job.owner_user_id;
  const out = {
    datasetId: job.dataset_id || null,
    analysisObjectId: job.analysis_object_id || null,
    resultAnalysisObjectId: job.result_analysis_object_id || null,
    provenanceId: null,
    figureId: null
  };

  const resolveAo = (id, code, label) => {
    if (typeof id !== 'string') throw codedError(code, `${label} not found.`);
    const ok = pid ? !!getProjectAnalysisObjectRow(id, pid) : !!getAnalysisObjectForUser(id, owner);
    if (!ok) throw codedError(code, `${label} not found.`);
    return id;
  };

  if (input.analysisObjectId !== undefined && input.analysisObjectId !== null) {
    out.analysisObjectId = resolveAo(input.analysisObjectId, 'ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object');
  }
  if (input.resultAnalysisObjectId !== undefined && input.resultAnalysisObjectId !== null) {
    out.resultAnalysisObjectId = resolveAo(input.resultAnalysisObjectId, 'RESULT_OBJECT_NOT_FOUND', 'Result analysis object');
  }
  if (input.datasetId !== undefined && input.datasetId !== null) {
    if (!pid || typeof input.datasetId !== 'string' || !getDatasetRow(input.datasetId, pid)) {
      throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
    }
    out.datasetId = input.datasetId;
  }
  if (input.provenanceId !== undefined && input.provenanceId !== null) {
    if (!pid || typeof input.provenanceId !== 'string' || !getProjectProvenanceRow(input.provenanceId, pid)) {
      throw codedError('PROVENANCE_NOT_FOUND', 'Provenance record not found.');
    }
    out.provenanceId = input.provenanceId;
  }
  if (input.figureId !== undefined && input.figureId !== null) {
    if (!pid || typeof input.figureId !== 'string' || !getProjectFigureRow(input.figureId, pid)) {
      throw codedError('FIGURE_NOT_FOUND', 'Figure not found.');
    }
    out.figureId = input.figureId;
  }
  return out;
}

// Shared validation + insert for a job artifact. The actor and project scope are
// taken from `job`, never from `input`; client-supplied id/projectId/createdByUserId/
// storageUri/checksum/size are intentionally ignored (the signature never reads
// them). storageKind defaults to 'metadata_only' and status to 'available'.
function insertJobArtifact(job, input = {}) {
  const artifactType = typeof input.artifactType === 'string' ? input.artifactType.trim() : '';
  if (!isValidArtifactType(artifactType)) {
    throw codedError('INVALID_ARTIFACT_TYPE',
      `Invalid artifactType. Allowed: ${[...ALLOWED_ARTIFACT_TYPES].join(', ')}.`);
  }
  const storageKind = input.storageKind === undefined || input.storageKind === null
    ? 'metadata_only' : String(input.storageKind);
  if (!isValidArtifactStorageKind(storageKind)) {
    throw codedError('INVALID_STORAGE_KIND',
      `Invalid storageKind. Allowed: ${[...ALLOWED_ARTIFACT_STORAGE_KINDS].join(', ')}.`);
  }
  const status = input.status === undefined || input.status === null
    ? 'available' : String(input.status);
  if (!isValidArtifactStatus(status)) {
    throw codedError('INVALID_ARTIFACT_STATUS',
      `Invalid status. Allowed: ${[...ALLOWED_ARTIFACT_STATUSES].join(', ')}.`);
  }
  const metadata = input.metadata === undefined ? {} : input.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw codedError('INVALID_METADATA', 'metadata must be a plain JSON object.');
  }

  const refs = resolveArtifactRefs(job, input);

  const id = generateJobArtifactId();
  db.prepare(`
    INSERT INTO job_artifacts
      (id, project_id, job_id, dataset_id, analysis_object_id, result_analysis_object_id,
       provenance_id, figure_id, created_by_user_id, artifact_type, name, description,
       mime_type, storage_kind, storage_uri, checksum_sha256, size_bytes, status, metadata_json)
    VALUES
      (@id, @projectId, @jobId, @datasetId, @analysisObjectId, @resultAnalysisObjectId,
       @provenanceId, @figureId, @createdBy, @artifactType, @name, @description,
       @mimeType, @storageKind, NULL, NULL, NULL, @status, @metadataJson)
  `).run({
    id,
    projectId: job.project_id || null,
    jobId: job.id,
    datasetId: refs.datasetId,
    analysisObjectId: refs.analysisObjectId,
    resultAnalysisObjectId: refs.resultAnalysisObjectId,
    provenanceId: refs.provenanceId,
    figureId: refs.figureId,
    createdBy: job.owner_user_id,
    artifactType,
    name: input.name != null ? String(input.name) : null,
    description: input.description != null ? String(input.description) : null,
    mimeType: input.mimeType != null ? String(input.mimeType) : null,
    storageKind,
    status,
    metadataJson: JSON.stringify(metadata)
  });
  return getJobArtifactRowById(id);
}

/**
 * Worker-facing: create a metadata-only artifact for a job the worker currently
 * holds. Guarded exactly like heartbeat/complete (succeeds only while
 * (worker_id, claim_token) match, status is 'running', and the lease is live), so
 * a stale/reaped worker can never write artifacts to a job it has lost. project_id
 * and created_by_user_id are derived from the job; storage_uri/checksum/size are
 * never set here (metadata-only). Returns the full internal artifact. Throws
 * `JOB_NOT_FOUND` / `CLAIM_LOST` / the artifact `INVALID_*` / reference `*_NOT_FOUND`.
 */
function createJobArtifactByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  return insertJobArtifact(row, input);
}

// ── Durable internal checkpoint-artifact storage (worker/server-tier only) ────
//
// A SEPARATE, explicit helper from createJobArtifactByWorker: the generic helper
// deliberately IGNORES any client-supplied storage_uri/checksum/size (a regression
// guard), so the only way to record a real internal checkpoint file's coordinates is
// through this narrow, server-tier path. It is reachable ONLY from the trusted worker
// handler (there is no public artifact-create route), and the storage fields it
// accepts are computed by the SERVER from R's response + a SERVER-allocated key —
// never from job parameters or any client input.
//
// Invariants preserved:
//   - storage_uri holds the SERVER-allocated INTERNAL vault key (a relative,
//     traversal-free path the R backend confines to its vault). It is NEVER returned
//     by the public projection (toPublicJobArtifact strips it) — there is still no
//     download route. checksum/size/storageKind are safe public descriptors.
//   - identity/scope (id/project/owner/refs) are derived from the job, exactly like
//     insertJobArtifact, so a checkpoint artifact can never cross a project/owner.
//   - storageKind is fixed to 'local_internal' here (the whole point of this helper);
//     metadata-only artifacts must use createJobArtifactByWorker.

// A safe, relative, traversal-free internal storage key. Defense-in-depth: even
// though Node generates it from server-controlled ids, re-validate here so a bug can
// never persist an absolute path, a parent-dir escape, or an unbounded blob.
const _CHECKPOINT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
function isSafeInternalStorageKey(key) {
  if (typeof key !== 'string' || key === '') return false;
  if (/^([/\\]|[A-Za-z]:[/\\]|\\\\)/.test(key)) return false;       // no absolute paths
  if (/(^|[/\\])\.\.([/\\]|$)/.test(key)) return false;             // no `..` traversal
  if (key.includes('\\') || key.includes('\0')) return false;       // no backslashes / NUL
  return _CHECKPOINT_KEY_RE.test(key);
}

function normalizeChecksumSha256(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : undefined; // undefined → caller rejects
}

function normalizeArtifactSizeBytes(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  if (n < 0 || n > 1e15) return undefined;
  return n;
}

function createCheckpointArtifactForJobByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }

  const artifactType = typeof input.artifactType === 'string' ? input.artifactType.trim() : 'checkpoint';
  if (!isValidArtifactType(artifactType)) {
    throw codedError('INVALID_ARTIFACT_TYPE',
      `Invalid artifactType. Allowed: ${[...ALLOWED_ARTIFACT_TYPES].join(', ')}.`);
  }
  // This helper exists specifically to persist durable internal storage coordinates.
  const storageKind = input.storageKind === undefined || input.storageKind === null
    ? 'local_internal' : String(input.storageKind);
  if (storageKind !== 'local_internal') {
    throw codedError('INVALID_STORAGE_KIND',
      'createCheckpointArtifactForJobByWorker only records local_internal storage; use createJobArtifactByWorker for metadata-only artifacts.');
  }
  if (!isSafeInternalStorageKey(input.internalStorageKey)) {
    throw codedError('INVALID_STORAGE_KEY', 'internalStorageKey must be a safe, relative, server-allocated key.');
  }
  const checksum = normalizeChecksumSha256(input.checksumSha256);
  if (checksum === undefined) throw codedError('INVALID_CHECKSUM', 'checksumSha256 must be a 64-char hex string.');
  const sizeBytes = normalizeArtifactSizeBytes(input.sizeBytes);
  if (sizeBytes === undefined) throw codedError('INVALID_SIZE', 'sizeBytes must be a non-negative integer.');

  const status = input.status === undefined || input.status === null ? 'available' : String(input.status);
  if (!isValidArtifactStatus(status)) {
    throw codedError('INVALID_ARTIFACT_STATUS', `Invalid status. Allowed: ${[...ALLOWED_ARTIFACT_STATUSES].join(', ')}.`);
  }
  const metadata = input.metadata === undefined ? {} : input.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw codedError('INVALID_METADATA', 'metadata must be a plain JSON object.');
  }

  const refs = resolveArtifactRefs(row, input);
  const id = generateJobArtifactId();
  db.prepare(`
    INSERT INTO job_artifacts
      (id, project_id, job_id, dataset_id, analysis_object_id, result_analysis_object_id,
       provenance_id, figure_id, created_by_user_id, artifact_type, name, description,
       mime_type, storage_kind, storage_uri, checksum_sha256, size_bytes, status, metadata_json)
    VALUES
      (@id, @projectId, @jobId, @datasetId, @analysisObjectId, @resultAnalysisObjectId,
       @provenanceId, @figureId, @createdBy, @artifactType, @name, @description,
       @mimeType, @storageKind, @storageUri, @checksum, @sizeBytes, @status, @metadataJson)
  `).run({
    id,
    projectId: row.project_id || null,
    jobId: row.id,
    datasetId: refs.datasetId,
    analysisObjectId: refs.analysisObjectId,
    resultAnalysisObjectId: refs.resultAnalysisObjectId,
    provenanceId: refs.provenanceId,
    figureId: refs.figureId,
    createdBy: row.owner_user_id,
    artifactType,
    name: input.name != null ? String(input.name) : null,
    description: input.description != null ? String(input.description) : null,
    mimeType: input.mimeType != null ? String(input.mimeType) : null,
    storageKind,
    storageUri: input.internalStorageKey, // INTERNAL key — stripped by toPublicJobArtifact
    checksum,
    sizeBytes,
    status,
    metadataJson: JSON.stringify(metadata)
  });
  return getJobArtifactRowById(id);
}

// ── Analysis object lineage edges (DAG-ready graph model) ─────────────────────
//
// The durable, forward-looking source of truth for analysis-object lineage as a
// DAG. analysis_objects.parent_object_id / lineage_root_id stay as compatibility/
// fast-path fields for single-parent lineage; these edge helpers are what graph
// traversal uses and what lets a FUTURE multi-parent operation record several
// parents as multiple edge rows instead of encoding them in metadata.
//
// Server-owned identity & scope: edge ids are server-generated (aoe_...),
// project_id is DERIVED from the parent/child objects (never client input), and
// created_by_user_id is the server-set actor. An edge always stays within ONE
// scope (the parent and child must share the same project, NULL↔NULL for legacy
// owner-scoped objects). There is NO public edge-create route in this branch.

const ALLOWED_EDGE_TYPES = new Set([
  'derived_from',     // generic "child is derived from parent" (used by the backfill)
  'checkpoint',       // child is a checkpoint produced by a job from the parent input object
  'branch',           // child is an explicit branch point off the parent
  'integration_input',// parent is one input to a future integration/merge child
  'comparison_input', // parent is one input to a future comparison child
  'manual_link'       // explicit manual link (no public create route exposes this yet)
]);
const ALLOWED_PARENT_ROLES = new Set([
  'primary', 'secondary', 'reference', 'query', 'control', 'case', 'input'
]);
function isValidEdgeType(t) { return ALLOWED_EDGE_TYPES.has(t); }
function isValidParentRole(r) { return ALLOWED_PARENT_ROLES.has(r); }

// Server-generated, R-header-irrelevant edge id (aoe_ + lowercase hex).
function generateAnalysisObjectEdgeId() {
  return `aoe_${crypto.randomBytes(12).toString('hex')}`;
}

// Local id-shape guards (mirror server.js ANALYSIS_OBJECT_ID_PATTERN / JOB_ID_PATTERN)
// so the DB-tier helpers can reject a MALFORMED id with a 400-mapped code before any
// lookup, distinct from a well-formed-but-unknown id (404).
const _AO_ID_RE = /^ao_[0-9a-f]+$/;
const _JOB_ID_RE = /^job_[0-9a-f]+$/;

// Traversal bounds: keep lineage reads/cycle checks cheap and DoS-safe even if a DAG
// grows large or historical data is malformed. A traversal that hits these limits is
// reported as truncated rather than walked unbounded.
const LINEAGE_MAX_NODES = 500;
const LINEAGE_MAX_DEPTH = 64;

// Public-safe edge projection. Exposes only graph/metadata fields — never a storage
// path, R state key, claim token, or other internal. (The edge row has none of those
// columns, but the projection makes the safe contract explicit.)
function rowToAnalysisObjectEdge(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    parentAnalysisObjectId: row.parent_analysis_object_id,
    childAnalysisObjectId: row.child_analysis_object_id,
    jobId: row.job_id,
    edgeType: row.edge_type,
    parentRole: row.parent_role,
    metadata: JSON.parse(row.metadata_json || '{}'),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at
  };
}

// Low-level INSERT of a single edge row. No validation / cycle check — callers that
// use this (e.g. the checkpoint transaction) have already validated scope and the
// child is brand-new (cannot form a cycle). Server-generated id; created_by/project
// are passed by the trusted caller, never the client. Returns the row id.
function _insertLineageEdgeRow({ projectId, parentObjectId, childObjectId, jobId,
  edgeType, parentRole, metadata, createdByUserId, now }) {
  const id = generateAnalysisObjectEdgeId();
  db.prepare(`
    INSERT INTO analysis_object_edges
      (id, project_id, parent_analysis_object_id, child_analysis_object_id, job_id,
       edge_type, parent_role, metadata_json, created_by_user_id, created_at)
    VALUES
      (@id, @projectId, @parentObjectId, @childObjectId, @jobId,
       @edgeType, @parentRole, @metadataJson, @createdByUserId, @createdAt)
  `).run({
    id,
    projectId: projectId || null,
    parentObjectId,
    childObjectId,
    jobId: jobId || null,
    edgeType,
    parentRole,
    metadataJson: JSON.stringify(metadata || {}),
    createdByUserId,
    createdAt: isSqliteTimestamp(now) ? now : dbNow()
  });
  return id;
}

// Raw edge-row fetches (no auth; project-scoped read wrappers authorize above).
function getLineageEdgesByParent(parentObjectId, projectScope) {
  // projectScope: { projectId } pins a project (legacy NULL-project edges excluded);
  // omitted → owner/global scope (used by internal helpers & legacy reads).
  if (projectScope && projectScope.projectId !== undefined) {
    return db.prepare(
      'SELECT * FROM analysis_object_edges WHERE parent_analysis_object_id = ? AND project_id = ? ORDER BY created_at ASC, id ASC'
    ).all(String(parentObjectId), String(projectScope.projectId));
  }
  return db.prepare(
    'SELECT * FROM analysis_object_edges WHERE parent_analysis_object_id = ? ORDER BY created_at ASC, id ASC'
  ).all(String(parentObjectId));
}
function getLineageEdgesByChild(childObjectId, projectScope) {
  if (projectScope && projectScope.projectId !== undefined) {
    return db.prepare(
      'SELECT * FROM analysis_object_edges WHERE child_analysis_object_id = ? AND project_id = ? ORDER BY created_at ASC, id ASC'
    ).all(String(childObjectId), String(projectScope.projectId));
  }
  return db.prepare(
    'SELECT * FROM analysis_object_edges WHERE child_analysis_object_id = ? ORDER BY created_at ASC, id ASC'
  ).all(String(childObjectId));
}

/**
 * Bounded cycle check for a PROPOSED parent→child edge. Adding parent→child closes a
 * cycle iff `parentObjectId` is already reachable from `childObjectId` by walking
 * existing parent→child edges downward (i.e. child is already an ancestor of parent).
 * We walk the descendants of `childObjectId`; if we ever reach `parentObjectId` it is
 * a cycle. Bounded by LINEAGE_MAX_NODES so malformed/huge data fails safely. Scope is
 * the proposed edge's derived project scope so the walk cannot cross projects.
 */
function lineageEdgeWouldCreateCycle(parentObjectId, childObjectId, projectScope) {
  if (parentObjectId === childObjectId) return true;
  const seen = new Set([String(childObjectId)]);
  let frontier = [String(childObjectId)];
  let visited = 0;
  while (frontier.length > 0) {
    const next = [];
    for (const node of frontier) {
      if (++visited > LINEAGE_MAX_NODES) return true; // fail safe: treat as cycle
      const children = getLineageEdgesByParent(node, projectScope);
      for (const e of children) {
        const c = e.child_analysis_object_id;
        if (c === String(parentObjectId)) return true; // reaches the proposed parent
        if (!seen.has(c)) { seen.add(c); next.push(c); }
      }
    }
    frontier = next;
  }
  return false;
}

/**
 * Internal: create ONE validated lineage edge. Used by future multi-parent
 * operations and the test suite; there is NO public create route. All identity/scope
 * fields are server-owned — `actorUserId` becomes created_by_user_id and project_id
 * is DERIVED from the objects, so neither can be set from client input.
 *
 * Validates: malformed parent/child/job ids → INVALID_* (400); self-parent →
 * SELF_PARENT (400); bad edgeType/parentRole/metadata → INVALID_* (400); unknown or
 * cross-scope parent/child → PARENT_NOT_FOUND / CHILD_NOT_FOUND (404); job that does
 * not exist or is in another scope → JOB_NOT_FOUND (404); a proposed edge that would
 * create a cycle → CYCLE (409); an exact duplicate edge → DUPLICATE_EDGE (409).
 * Returns the public edge projection.
 */
function createLineageEdge(actorUserId, input = {}) {
  const parentObjectId = typeof input.parentObjectId === 'string' ? input.parentObjectId : '';
  const childObjectId = typeof input.childObjectId === 'string' ? input.childObjectId : '';
  if (!_AO_ID_RE.test(parentObjectId)) throw codedError('INVALID_PARENT_ID', 'Malformed parent analysis object ID.');
  if (!_AO_ID_RE.test(childObjectId)) throw codedError('INVALID_CHILD_ID', 'Malformed child analysis object ID.');
  if (parentObjectId === childObjectId) throw codedError('SELF_PARENT', 'An analysis object cannot be its own parent.');

  const edgeType = input.edgeType === undefined || input.edgeType === null ? 'derived_from' : String(input.edgeType);
  if (!isValidEdgeType(edgeType)) {
    throw codedError('INVALID_EDGE_TYPE', `Invalid edgeType. Allowed: ${[...ALLOWED_EDGE_TYPES].join(', ')}.`);
  }
  const parentRole = input.parentRole === undefined || input.parentRole === null ? 'primary' : String(input.parentRole);
  if (!isValidParentRole(parentRole)) {
    throw codedError('INVALID_PARENT_ROLE', `Invalid parentRole. Allowed: ${[...ALLOWED_PARENT_ROLES].join(', ')}.`);
  }
  const metadata = input.metadata === undefined ? {} : input.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw codedError('INVALID_METADATA', 'metadata must be a plain JSON object.');
  }
  let jobId = null;
  if (input.jobId !== undefined && input.jobId !== null) {
    if (!_JOB_ID_RE.test(String(input.jobId))) throw codedError('INVALID_JOB_ID', 'Malformed job ID.');
    jobId = String(input.jobId);
  }

  // Parent/child must both exist and share ONE scope. project_id is derived from the
  // objects: a parent and child in different projects (or one legacy NULL-project and
  // one real project) are treated as cross-scope → 404, so an edge can never straddle
  // a project boundary.
  const parent = db.prepare('SELECT id, project_id FROM analysis_objects WHERE id = ?').get(parentObjectId);
  if (!parent) throw codedError('PARENT_NOT_FOUND', 'Parent analysis object not found.');
  const child = db.prepare('SELECT id, project_id FROM analysis_objects WHERE id = ?').get(childObjectId);
  if (!child) throw codedError('CHILD_NOT_FOUND', 'Child analysis object not found.');
  const sameScope = parent.project_id === child.project_id
    || (parent.project_id == null && child.project_id == null);
  if (!sameScope) throw codedError('CHILD_NOT_FOUND', 'Child analysis object not found.');
  const projectId = parent.project_id || null;

  if (jobId) {
    const job = db.prepare('SELECT id, project_id FROM jobs WHERE id = ?').get(jobId);
    const jobSameScope = job && (job.project_id === projectId || (job.project_id == null && projectId == null));
    if (!job || !jobSameScope) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  }

  const scope = { projectId };
  if (lineageEdgeWouldCreateCycle(parentObjectId, childObjectId, scope)) {
    throw codedError('CYCLE', 'This edge would create a cycle in the lineage graph.');
  }

  let id;
  try {
    id = _insertLineageEdgeRow({
      projectId, parentObjectId, childObjectId, jobId,
      edgeType, parentRole, metadata, createdByUserId: actorUserId, now: dbNow()
    });
  } catch (e) {
    if (e && /UNIQUE constraint failed/i.test(String(e.message))) {
      throw codedError('DUPLICATE_EDGE', 'An identical lineage edge already exists.');
    }
    throw e;
  }
  return rowToAnalysisObjectEdge(
    db.prepare('SELECT * FROM analysis_object_edges WHERE id = ?').get(id)
  );
}

/**
 * Internal: create MANY edges for a single child with several parents (the shape a
 * FUTURE integration/comparison/merge child will use). Each parent is its own edge
 * row, validated and cycle-checked individually by createLineageEdge, all inside one
 * transaction so a multi-parent child is recorded atomically (any failure rolls back
 * every edge). `parents` is an array of { parentObjectId, edgeType?, parentRole?,
 * jobId?, metadata? }. Returns the created edge projections.
 */
function createLineageEdgesForChild(actorUserId, childObjectId, parents = []) {
  if (!Array.isArray(parents) || parents.length === 0) {
    throw codedError('INVALID_PARENTS', 'parents must be a non-empty array.');
  }
  return db.transaction(() =>
    parents.map(p => createLineageEdge(actorUserId, { ...p, childObjectId }))
  ).immediate();
}

/** Internal: parent edges of an object (edges where the object is the CHILD). */
function listLineageParents(objectId, projectScope) {
  return getLineageEdgesByChild(objectId, projectScope).map(rowToAnalysisObjectEdge);
}
/** Internal: child edges of an object (edges where the object is the PARENT). */
function listLineageChildren(objectId, projectScope) {
  return getLineageEdgesByParent(objectId, projectScope).map(rowToAnalysisObjectEdge);
}

/**
 * Bounded lineage graph around an object: walks both ancestors (up) and descendants
 * (down) via edges, returning deterministic, de-duplicated { nodes, edges }. Walk is
 * capped by LINEAGE_MAX_NODES / LINEAGE_MAX_DEPTH; if a cap is hit (or historical data
 * somehow contains a cycle) the result is marked `truncated: true` rather than walked
 * forever. Nodes carry only public-safe object fields (id, label, status-ish object
 * type, lineageRootId) — never a storage path, R state key, or claim token. Scope is
 * the given projectScope so the graph cannot cross a project boundary.
 */
function buildLineageGraph(objectId, projectScope, nodeFetcher) {
  const start = String(objectId);
  const edgeById = new Map();
  const nodeIds = new Set([start]);
  let truncated = false;

  // Walk in one direction collecting edges + neighbor ids.
  function walk(direction) {
    const seen = new Set([start]);
    let frontier = [start];
    let depth = 0;
    while (frontier.length > 0) {
      if (++depth > LINEAGE_MAX_DEPTH) { truncated = true; break; }
      const next = [];
      for (const node of frontier) {
        const edges = direction === 'down'
          ? getLineageEdgesByParent(node, projectScope)
          : getLineageEdgesByChild(node, projectScope);
        for (const e of edges) {
          if (!edgeById.has(e.id)) edgeById.set(e.id, e);
          const neighbor = direction === 'down'
            ? e.child_analysis_object_id : e.parent_analysis_object_id;
          if (nodeIds.size < LINEAGE_MAX_NODES) nodeIds.add(neighbor);
          else { truncated = true; }
          if (!seen.has(neighbor) && nodeIds.has(neighbor)) { seen.add(neighbor); next.push(neighbor); }
        }
      }
      frontier = next;
    }
  }
  walk('down');
  walk('up');

  const nodes = [...nodeIds].sort().map(id => nodeFetcher(id)).filter(Boolean);
  const edges = [...edgeById.values()]
    .map(rowToAnalysisObjectEdge)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1
      : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  return { objectId: start, nodes, edges, truncated };
}

// ── Project-scoped lineage reads (role-checked; metadata only) ────────────────
//
// Read-only, role-checked lineage metadata for project members. Like the other
// project-scoped read helpers these authorize through requireProjectRole (any
// member, incl. viewer, may read), so an inaccessible project/object is 404 and a
// known member lacking the read role is 403. They always pin a real project_id, so a
// legacy NULL-project object/edge never appears, and they return public projections.
// There is intentionally NO project edge CREATE/mutate route.

const LINEAGE_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];

// Minimal public-safe node label for a lineage graph: only fields the existing
// object read policy already exposes to members (id, displayName, objectType,
// lineageRootId). NO storage uri / hash / owner-private fields.
function lineageNodeForObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.display_name || null,
    objectType: row.object_type,
    lineageRootId: row.lineage_root_id
  };
}

/** Parents of an object within a project (any member may read). The object must
 * belong to the project (else 404); edges are pinned to the project so legacy
 * NULL-project edges never appear. Returns public edge projections. */
function listProjectAnalysisObjectParents(userId, projectId, objectId) {
  requireProjectRole(userId, projectId, LINEAGE_READ_ROLES);
  const pid = String(projectId);
  if (!getProjectAnalysisObjectRow(objectId, pid)) {
    throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  return listLineageParents(objectId, { projectId: pid });
}

/** Children of an object within a project (any member may read). */
function listProjectAnalysisObjectChildren(userId, projectId, objectId) {
  requireProjectRole(userId, projectId, LINEAGE_READ_ROLES);
  const pid = String(projectId);
  if (!getProjectAnalysisObjectRow(objectId, pid)) {
    throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  return listLineageChildren(objectId, { projectId: pid });
}

/** Bounded lineage graph around a project object (any member may read). The object
 * must belong to the project (else 404). Nodes/edges are project-pinned and public-
 * safe; the graph is deterministic and bounded (LINEAGE_MAX_NODES / _DEPTH). */
function getProjectAnalysisObjectLineage(userId, projectId, objectId) {
  requireProjectRole(userId, projectId, LINEAGE_READ_ROLES);
  const pid = String(projectId);
  const root = getProjectAnalysisObjectRow(objectId, pid);
  if (!root) throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  const graph = buildLineageGraph(objectId, { projectId: pid },
    (id) => lineageNodeForObject(
      db.prepare('SELECT id, display_name, object_type, lineage_root_id FROM analysis_objects WHERE id = ? AND project_id = ?').get(id, pid)
    ));
  return { ...graph, projectId: pid, rootObjectId: root.lineageRootId || root.id };
}

/**
 * Worker-facing: create a NEW immutable result analysis object (a checkpoint) for a
 * successful mutating job, and atomically link it back as the job's
 * result_analysis_object_id — WITHOUT mutating the parent object. Guarded by the
 * live claim; refuses if the job already has a result object (so two workers can
 * never create duplicate result objects for the same job). The result object is
 * server-generated (`ao_...`), inherits the job's project/owner, and its parent /
 * dataset / lineage root stay within the job's scope (default to the job's own
 * analysis object / dataset). Clients cannot choose its id/owner/project/lineage —
 * none of those are read from `input`. Throws `JOB_NOT_FOUND` / `CLAIM_LOST` /
 * `CHECKPOINT_EXISTS` / `INVALID_OBJECT_TYPE` / `INVALID_METADATA` / `PARENT_NOT_FOUND`
 * / `DATASET_NOT_FOUND`.
 */
function createCheckpointForJobByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  if (row.result_analysis_object_id) {
    throw codedError('CHECKPOINT_EXISTS', 'Job already has a result checkpoint object.');
  }

  const owner = row.owner_user_id;
  const pid = row.project_id || null;

  const objectType = input.objectType === undefined || input.objectType === null
    ? 'generic' : String(input.objectType).trim();
  if (!isValidObjectType(objectType)) {
    throw codedError('INVALID_OBJECT_TYPE',
      `Invalid objectType. Allowed: ${[...ALLOWED_OBJECT_TYPES].join(', ')}.`);
  }
  const metadata = input.metadata === undefined ? {} : input.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw codedError('INVALID_METADATA', 'metadata must be a plain JSON object.');
  }

  // Parent defaults to the job's own input object (a checkpoint is a CHILD of it,
  // never a mutation of it). A client-supplied parent must resolve in the job's
  // scope. Lineage root is inherited within that scope.
  const parentObjectId = input.parentObjectId !== undefined && input.parentObjectId !== null
    ? String(input.parentObjectId)
    : (row.analysis_object_id || null);
  let lineageRootId = null;
  if (parentObjectId) {
    const parent = pid ? getProjectAnalysisObjectRow(parentObjectId, pid)
                       : getAnalysisObjectForUser(parentObjectId, owner);
    if (!parent) throw codedError('PARENT_NOT_FOUND', 'Parent analysis object not found.');
    lineageRootId = parent.lineageRootId || parent.id;
  }

  // Dataset defaults to the job's dataset; a client-supplied one must resolve in the
  // job's project (datasets are project-scoped, so legacy jobs cannot set one).
  let datasetId = row.dataset_id || null;
  if (input.datasetId !== undefined && input.datasetId !== null) {
    if (!pid || typeof input.datasetId !== 'string' || !getDatasetRow(input.datasetId, pid)) {
      throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
    }
    datasetId = input.datasetId;
  }

  const id = generateAnalysisObjectId();
  const linked = db.transaction(() => {
    db.prepare(`
      INSERT INTO analysis_objects
        (id, owner_user_id, project_id, dataset_id, parent_object_id, lineage_root_id, object_type,
         display_name, storage_uri, object_hash, metadata_json, created_by_provenance_id)
      VALUES
        (@id, @owner, @projectId, @datasetId, @parentObjectId, @lineageRootId, @objectType,
         @displayName, NULL, NULL, @metadataJson, NULL)
    `).run({
      id,
      owner,
      projectId: pid,
      datasetId,
      parentObjectId,
      lineageRootId,
      objectType,
      displayName: input.displayName != null ? String(input.displayName) : null,
      metadataJson: JSON.stringify(metadata)
    });
    if (!parentObjectId) {
      db.prepare('UPDATE analysis_objects SET lineage_root_id = id WHERE id = ?').run(id);
    }
    // Link the new checkpoint back to the job, re-checking the claim AND that no
    // result object was set in the meantime — so a racing worker/claim cannot
    // double-link. If the guard fails, the whole transaction (incl. the AO insert)
    // rolls back and the caller sees CLAIM_LOST.
    const info = db.prepare(`
      UPDATE jobs SET result_analysis_object_id = @aoId, updated_at = @now
      WHERE id = @jobId AND worker_id = @wid AND claim_token = @token
        AND status = 'running' AND lease_expires_at > @now
        AND result_analysis_object_id IS NULL
    `).run({ aoId: id, jobId: String(jobId), wid, token, now });
    const ok = info.changes === 1;
    // Atomically record the DAG edge for this checkpoint in the SAME transaction:
    // parent = the job's input object, child = the new checkpoint, edge_type =
    // 'checkpoint', parent_role = 'primary'. Only when the link succeeded (so a
    // claim-lost completion leaves no successful edge) AND there is an input object
    // (a checkpoint with no input object is a lineage root → no edge). The new child
    // has no other edges yet, so this can never form a cycle; project_id is derived
    // from the job's scope (pid, possibly NULL for a legacy owner-scoped job — that
    // edge simply never appears in the project lineage routes).
    if (ok && parentObjectId) {
      _insertLineageEdgeRow({
        projectId: pid,
        parentObjectId,
        childObjectId: id,
        jobId: String(jobId),
        edgeType: 'checkpoint',
        parentRole: 'primary',
        metadata: {},
        createdByUserId: owner,
        now
      });
    }
    return ok;
  }).immediate();

  if (!linked) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  return pid ? getProjectAnalysisObjectRow(id, pid) : getAnalysisObjectForUser(id, owner);
}

// ── Atomic PBMC pipeline completion (result + edge + both artifacts) ──────────
//
// SINGLE-transaction completion for the `pbmc.pipeline.v1` worker handler. The earlier
// design created the result object + job link + lineage edge in one transaction, then
// inserted the checkpoint and summary artifacts in two separate statements afterward —
// so a failure (claim-loss window / DB error) AFTER the first transaction could leave a
// FAILED job still linked to a result object + edge with the required artifacts missing.
//
// This helper folds ALL FIVE durable records into ONE `db.transaction(...).immediate()`
// so they are created together or not at all:
//   1. result analysis object (a CHILD checkpoint of the job's input object)
//   2. job.result_analysis_object_id link (claim/lease/result-IS-NULL guarded)
//   3. parent→result lineage edge ('checkpoint'/'primary')
//   4. local_internal checkpoint artifact (server key + checksum/size; key stripped publicly)
//   5. metadata_only pipeline_summary artifact
// If ANY step throws, the whole transaction rolls back: no result object remains linked,
// no edge, no partial artifact. The claim guard prevents two workers from racing this in,
// and the result-IS-NULL guard prevents a duplicate result/edge/artifacts.
//
// NOTE (orphan file lifecycle, documented follow-up): the R checkpoint RDS is written by
// the R backend BEFORE this DB transaction runs. A DB rollback therefore can leave an
// orphaned internal file on the R vault. That is acceptable for this branch — there is no
// public download route and Node may not share the R vault filesystem — and is recorded
// as a storage-lifecycle follow-up. The invariant that MUST hold (and does) is that DB
// state never partially commits a successful-looking result without its required artifacts.
function completePbmcPipelineResultByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  if (row.result_analysis_object_id) {
    throw codedError('CHECKPOINT_EXISTS', 'Job already has a result checkpoint object.');
  }

  const owner = row.owner_user_id;
  const pid = row.project_id || null;

  // ── Validate the result object spec (fail-fast, BEFORE any insert) ──
  const result = input.result && typeof input.result === 'object' ? input.result : {};
  const objectType = result.objectType === undefined || result.objectType === null
    ? 'generic' : String(result.objectType).trim();
  if (!isValidObjectType(objectType)) {
    throw codedError('INVALID_OBJECT_TYPE', `Invalid objectType. Allowed: ${[...ALLOWED_OBJECT_TYPES].join(', ')}.`);
  }
  const resultMetadata = result.metadata === undefined ? {} : result.metadata;
  if (resultMetadata === null || typeof resultMetadata !== 'object' || Array.isArray(resultMetadata)) {
    throw codedError('INVALID_METADATA', 'metadata must be a plain JSON object.');
  }

  // ── Validate the checkpoint artifact spec (local_internal; integrity required) ──
  const cp = input.checkpointArtifact && typeof input.checkpointArtifact === 'object' ? input.checkpointArtifact : {};
  const cpType = typeof cp.artifactType === 'string' ? cp.artifactType.trim() : 'checkpoint';
  if (!isValidArtifactType(cpType)) {
    throw codedError('INVALID_ARTIFACT_TYPE', `Invalid artifactType. Allowed: ${[...ALLOWED_ARTIFACT_TYPES].join(', ')}.`);
  }
  const cpStorageKind = cp.storageKind === undefined || cp.storageKind === null ? 'local_internal' : String(cp.storageKind);
  if (cpStorageKind !== 'local_internal') {
    throw codedError('INVALID_STORAGE_KIND',
      'completePbmcPipelineResultByWorker records a local_internal checkpoint artifact.');
  }
  if (!isSafeInternalStorageKey(cp.internalStorageKey)) {
    throw codedError('INVALID_STORAGE_KEY', 'internalStorageKey must be a safe, relative, server-allocated key.');
  }
  const cpChecksum = normalizeChecksumSha256(cp.checksumSha256);
  if (cpChecksum === undefined || cpChecksum === null) {
    throw codedError('INVALID_CHECKSUM', 'checksumSha256 must be a 64-char hex string.');
  }
  const cpSize = normalizeArtifactSizeBytes(cp.sizeBytes);
  if (cpSize === undefined || cpSize === null) throw codedError('INVALID_SIZE', 'sizeBytes must be a non-negative integer.');
  const cpStatus = cp.status === undefined || cp.status === null ? 'available' : String(cp.status);
  if (!isValidArtifactStatus(cpStatus)) {
    throw codedError('INVALID_ARTIFACT_STATUS', `Invalid status. Allowed: ${[...ALLOWED_ARTIFACT_STATUSES].join(', ')}.`);
  }
  const cpMetadata = cp.metadata === undefined ? {} : cp.metadata;
  if (cpMetadata === null || typeof cpMetadata !== 'object' || Array.isArray(cpMetadata)) {
    throw codedError('INVALID_METADATA', 'metadata must be a plain JSON object.');
  }

  // ── Validate the summary artifact spec (metadata-only) ──
  const sm = input.summaryArtifact && typeof input.summaryArtifact === 'object' ? input.summaryArtifact : {};
  const smType = typeof sm.artifactType === 'string' ? sm.artifactType.trim() : '';
  if (!isValidArtifactType(smType)) {
    throw codedError('INVALID_ARTIFACT_TYPE', `Invalid artifactType. Allowed: ${[...ALLOWED_ARTIFACT_TYPES].join(', ')}.`);
  }
  const smStorageKind = sm.storageKind === undefined || sm.storageKind === null ? 'metadata_only' : String(sm.storageKind);
  if (!isValidArtifactStorageKind(smStorageKind)) {
    throw codedError('INVALID_STORAGE_KIND', `Invalid storageKind. Allowed: ${[...ALLOWED_ARTIFACT_STORAGE_KINDS].join(', ')}.`);
  }
  const smStatus = sm.status === undefined || sm.status === null ? 'available' : String(sm.status);
  if (!isValidArtifactStatus(smStatus)) {
    throw codedError('INVALID_ARTIFACT_STATUS', `Invalid status. Allowed: ${[...ALLOWED_ARTIFACT_STATUSES].join(', ')}.`);
  }
  const smMetadata = sm.metadata === undefined ? {} : sm.metadata;
  if (smMetadata === null || typeof smMetadata !== 'object' || Array.isArray(smMetadata)) {
    throw codedError('INVALID_METADATA', 'metadata must be a plain JSON object.');
  }

  // Parent defaults to the job's input object; lineage root inherited within scope.
  const parentObjectId = result.parentObjectId !== undefined && result.parentObjectId !== null
    ? String(result.parentObjectId)
    : (row.analysis_object_id || null);
  let lineageRootId = null;
  if (parentObjectId) {
    const parent = pid ? getProjectAnalysisObjectRow(parentObjectId, pid) : getAnalysisObjectForUser(parentObjectId, owner);
    if (!parent) throw codedError('PARENT_NOT_FOUND', 'Parent analysis object not found.');
    lineageRootId = parent.lineageRootId || parent.id;
  }
  const datasetId = row.dataset_id || null;

  const resultId = generateAnalysisObjectId();
  const checkpointArtifactId = generateJobArtifactId();
  const summaryArtifactId = generateJobArtifactId();

  // Everything below is ONE atomic unit. Any throw (incl. JSON.stringify of a bad
  // metadata object) rolls the whole thing back — no orphaned DB result/edge/artifact.
  db.transaction(() => {
    db.prepare(`
      INSERT INTO analysis_objects
        (id, owner_user_id, project_id, dataset_id, parent_object_id, lineage_root_id, object_type,
         display_name, storage_uri, object_hash, metadata_json, created_by_provenance_id)
      VALUES
        (@id, @owner, @projectId, @datasetId, @parentObjectId, @lineageRootId, @objectType,
         @displayName, NULL, NULL, @metadataJson, NULL)
    `).run({
      id: resultId,
      owner,
      projectId: pid,
      datasetId,
      parentObjectId,
      lineageRootId,
      objectType,
      displayName: result.displayName != null ? String(result.displayName) : null,
      metadataJson: JSON.stringify(resultMetadata)
    });
    if (!parentObjectId) {
      db.prepare('UPDATE analysis_objects SET lineage_root_id = id WHERE id = ?').run(resultId);
    }

    // Link back to the job, re-checking the claim AND result-IS-NULL so a racing
    // worker/claim cannot double-link. A guard miss throws → the whole txn rolls back.
    const linkInfo = db.prepare(`
      UPDATE jobs SET result_analysis_object_id = @aoId, updated_at = @now
      WHERE id = @jobId AND worker_id = @wid AND claim_token = @token
        AND status = 'running' AND lease_expires_at > @now
        AND result_analysis_object_id IS NULL
    `).run({ aoId: resultId, jobId: String(jobId), wid, token, now });
    if (linkInfo.changes !== 1) {
      throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    }

    if (parentObjectId) {
      _insertLineageEdgeRow({
        projectId: pid,
        parentObjectId,
        childObjectId: resultId,
        jobId: String(jobId),
        edgeType: 'checkpoint',
        parentRole: 'primary',
        metadata: {},
        createdByUserId: owner,
        now
      });
    }

    // Checkpoint artifact (local_internal): storage_uri holds the SERVER key (stripped
    // by toPublicJobArtifact); checksum/size are safe public descriptors.
    db.prepare(`
      INSERT INTO job_artifacts
        (id, project_id, job_id, dataset_id, analysis_object_id, result_analysis_object_id,
         provenance_id, figure_id, created_by_user_id, artifact_type, name, description,
         mime_type, storage_kind, storage_uri, checksum_sha256, size_bytes, status, metadata_json)
      VALUES
        (@id, @projectId, @jobId, @datasetId, @analysisObjectId, @resultAnalysisObjectId,
         NULL, NULL, @createdBy, @artifactType, @name, @description,
         NULL, @storageKind, @storageUri, @checksum, @sizeBytes, @status, @metadataJson)
    `).run({
      id: checkpointArtifactId,
      projectId: pid,
      jobId: row.id,
      datasetId,
      analysisObjectId: parentObjectId,
      resultAnalysisObjectId: resultId,
      createdBy: owner,
      artifactType: cpType,
      name: cp.name != null ? String(cp.name) : null,
      description: cp.description != null ? String(cp.description) : null,
      storageKind: cpStorageKind,
      storageUri: cp.internalStorageKey,
      checksum: cpChecksum,
      sizeBytes: cpSize,
      status: cpStatus,
      metadataJson: JSON.stringify(cpMetadata)
    });

    // Pipeline summary artifact (metadata-only): no storage_uri/checksum/size.
    db.prepare(`
      INSERT INTO job_artifacts
        (id, project_id, job_id, dataset_id, analysis_object_id, result_analysis_object_id,
         provenance_id, figure_id, created_by_user_id, artifact_type, name, description,
         mime_type, storage_kind, storage_uri, checksum_sha256, size_bytes, status, metadata_json)
      VALUES
        (@id, @projectId, @jobId, @datasetId, @analysisObjectId, @resultAnalysisObjectId,
         NULL, NULL, @createdBy, @artifactType, @name, @description,
         NULL, @storageKind, NULL, NULL, NULL, @status, @metadataJson)
    `).run({
      id: summaryArtifactId,
      projectId: pid,
      jobId: row.id,
      datasetId,
      analysisObjectId: parentObjectId,
      resultAnalysisObjectId: resultId,
      createdBy: owner,
      artifactType: smType,
      name: sm.name != null ? String(sm.name) : null,
      description: sm.description != null ? String(sm.description) : null,
      storageKind: smStorageKind,
      status: smStatus,
      metadataJson: JSON.stringify(smMetadata)
    });
  }).immediate();

  return {
    resultObject: pid ? getProjectAnalysisObjectRow(resultId, pid) : getAnalysisObjectForUser(resultId, owner),
    checkpointArtifact: getJobArtifactRowById(checkpointArtifactId),
    summaryArtifact: getJobArtifactRowById(summaryArtifactId)
  };
}

// ── Project-scoped artifact reads (metadata only; no download) ────
//
// Read-only, role-checked artifact metadata for project members. Like the other
// project-scoped read helpers these authorize through requireProjectRole (any
// member, incl. viewer, may read), so an inaccessible project/artifact is 404 and
// a known member lacking the role is 403. They always pin a real project_id, so a
// legacy NULL-project artifact never appears, and they return the PUBLIC projection
// (storage_uri stripped). There is intentionally no project artifact CREATE/mutate
// route — artifact creation is worker/helper-driven.

function getProjectJobArtifactRow(artifactId, projectId) {
  if (typeof artifactId !== 'string' || artifactId === '') return null;
  const row = db.prepare('SELECT * FROM job_artifacts WHERE id = ? AND project_id = ?')
    .get(artifactId, String(projectId));
  return rowToJobArtifact(row);
}

function artifactFilterClauses(filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.jobId) { clauses.push('job_id = ?'); params.push(String(filters.jobId)); }
  if (filters.artifactType) { clauses.push('artifact_type = ?'); params.push(String(filters.artifactType)); }
  if (filters.status) { clauses.push('status = ?'); params.push(String(filters.status)); }
  if (filters.analysisObjectId) { clauses.push('analysis_object_id = ?'); params.push(String(filters.analysisObjectId)); }
  if (filters.resultAnalysisObjectId) { clauses.push('result_analysis_object_id = ?'); params.push(String(filters.resultAnalysisObjectId)); }
  if (filters.datasetId) { clauses.push('dataset_id = ?'); params.push(String(filters.datasetId)); }
  if (filters.provenanceId) { clauses.push('provenance_id = ?'); params.push(String(filters.provenanceId)); }
  if (filters.figureId) { clauses.push('figure_id = ?'); params.push(String(filters.figureId)); }
  return { clauses, params };
}

/** List a project's artifact metadata (any member may read). Filters are
 * project-scoped; legacy NULL-project rows never appear. Public projection. */
function listProjectArtifacts(userId, projectId, filters = {}) {
  requireProjectRole(userId, projectId, ARTIFACT_READ_ROLES);
  const { clauses, params } = artifactFilterClauses(filters);
  const where = ['project_id = ?', ...clauses];
  const rows = db.prepare(
    `SELECT * FROM job_artifacts WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC`
  ).all(String(projectId), ...params);
  return rows.map(r => toPublicJobArtifact(rowToJobArtifact(r)));
}

/** List a single project job's artifact metadata (any member may read). The job
 * must belong to the project (else 404), so a cross-project job id cannot be used
 * to read artifacts. Public projection. */
function listProjectJobArtifacts(userId, projectId, jobId, filters = {}) {
  requireProjectRole(userId, projectId, ARTIFACT_READ_ROLES);
  if (!getProjectJobRow(jobId, projectId)) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  return listProjectArtifacts(userId, projectId, { ...filters, jobId });
}

/** Return a single project artifact's metadata only if the caller is a member and
 * the artifact belongs to that project; otherwise null (route → 404). Any role
 * reads. Public projection (storage_uri stripped). */
function getProjectArtifact(userId, projectId, artifactId) {
  requireProjectRole(userId, projectId, ARTIFACT_READ_ROLES);
  return toPublicJobArtifact(getProjectJobArtifactRow(artifactId, projectId));
}

// ── Cleanup ──────────────────────────────────────────────────────

function closeDatabase() {
  if (db) {
    db.close();
    console.log('[DB] Database closed');
  }
}

/** Read a SQLite PRAGMA value (simple form). Read-only; exposed so tests can assert
 *  init-time hardening such as busy_timeout. Returns undefined when no DB is open. */
function getPragma(name) {
  if (!db) return undefined;
  return db.pragma(name, { simple: true });
}

/** Reflect a table's column names (read-only; for schema/migration tests). Returns
 *  [] when no DB is open or the table does not exist. */
function getTableColumns(table) {
  if (!db) return [];
  return db.prepare(`PRAGMA table_info(${JSON.stringify(String(table))})`).all().map(c => c.name);
}

/** Reflect a table's index names (read-only; for schema/migration tests). Returns
 *  [] when no DB is open or the table does not exist. */
function getTableIndexes(table) {
  if (!db) return [];
  return db.prepare(`PRAGMA index_list(${JSON.stringify(String(table))})`).all().map(i => i.name);
}

module.exports = {
  initDatabase,
  closeDatabase,
  getPragma,
  getTableColumns,
  getTableIndexes,
  saveProvenance,
  getProvenance,
  getAllProvenance,
  getProvenanceChain,
  deleteProvenance,
  makeCacheKey,
  getCachedResult,
  setCachedResult,
  clearCache,
  createUser,
  verifyUser,
  getUserByEmail,
  saveFigure,
  assertSafeFigureFilePath,
  getFiguresByUser,
  deleteFigure,
  // Analysis objects & lineage
  isValidObjectType,
  generateAnalysisObjectId,
  createAnalysisObjectForUser,
  listAnalysisObjectsForUser,
  getAnalysisObjectForUser,
  verifyAnalysisObjectOwner,
  // Jobs / task execution
  isValidJobType,
  isValidJobStatus,
  validateJobTransition,
  generateJobId,
  createJobForUser,
  listJobsForUser,
  getJobForUser,
  verifyJobOwner,
  updateJobStatusForUser,
  cancelJobForUser,
  appendJobLogForUser,
  // Worker coordination (durable claim/lease/heartbeat contract; no worker runs
  // these yet — see "Worker coordination" above and docs/project-r-execution-design.md)
  generateClaimToken,
  getWorkerJob,
  claimNextJob,
  heartbeatJob,
  completeJobByWorker,
  failJobByWorker,
  releaseJob,
  appendJobLogByWorker,
  reapExpiredJobs,
  setJobScheduling,
  // Organizations & projects (membership + authorization)
  isValidRole,
  generateOrganizationId,
  generateProjectId,
  createOrganizationForUser,
  getOrganizationForUser,
  listOrganizationsForUser,
  verifyOrganizationMember,
  requireOrganizationRole,
  addOrganizationMember,
  createProjectForUser,
  getProjectForUser,
  listProjectsForUser,
  verifyProjectMember,
  requireProjectRole,
  listProjectMembers,
  updateProject,
  getProjectMember,
  countProjectOwners,
  addProjectMemberByEmail,
  updateProjectMemberRole,
  removeProjectMember,
  // Datasets (project-scoped)
  isValidDatasetFileType,
  isValidDatasetUploadStatus,
  isValidDatasetValidationStatus,
  generateDatasetId,
  sanitizeDatasetFilename,
  toPublicDataset,
  createDatasetForProject,
  listDatasetsForProject,
  getDatasetForProject,
  updateDatasetForProject,
  verifyDatasetProjectAccess,
  markDatasetUploaded,
  markDatasetUploadFailed,
  // Project-scoped analysis objects & jobs (project metadata/history + roles;
  // R execution/state remains user/object-keyed — see notes above)
  createProjectAnalysisObject,
  listProjectAnalysisObjects,
  getProjectAnalysisObject,
  createProjectJob,
  listProjectJobs,
  getProjectJob,
  cancelProjectJob,
  // Project-scoped provenance & figure metadata (project metadata/history + roles;
  // append-only, no file access; R execution/state remains user/object-keyed)
  generateProvenanceId,
  createProjectProvenance,
  listProjectProvenance,
  getProjectProvenance,
  generateFigureId,
  createProjectFigure,
  listProjectFigures,
  getProjectFigure,
  // Job artifacts & checkpoints (durable output metadata; metadata-only in this
  // branch — no download, no object storage, no real R/Seurat outputs)
  isValidArtifactType,
  isValidArtifactStorageKind,
  isValidArtifactStatus,
  generateJobArtifactId,
  toPublicJobArtifact,
  createJobArtifactByWorker,
  createCheckpointArtifactForJobByWorker,
  isSafeInternalStorageKey,
  createCheckpointForJobByWorker,
  completePbmcPipelineResultByWorker,
  getJobArtifactsByJobId,
  listProjectArtifacts,
  listProjectJobArtifacts,
  getProjectArtifact,
  // Analysis object lineage edges (DAG-ready graph model; edge table is the
  // forward-looking lineage source, single-parent fields remain compatibility/
  // fast-path. No public edge-create route; reads are role-checked + metadata-only)
  isValidEdgeType,
  isValidParentRole,
  generateAnalysisObjectEdgeId,
  rowToAnalysisObjectEdge,
  createLineageEdge,
  createLineageEdgesForChild,
  listLineageParents,
  listLineageChildren,
  lineageEdgeWouldCreateCycle,
  buildLineageGraph,
  listProjectAnalysisObjectParents,
  listProjectAnalysisObjectChildren,
  getProjectAnalysisObjectLineage
};

