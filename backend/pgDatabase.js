/**
 * Postgres data layer (hosted-service database foundation).
 *
 * STATUS: this is the Postgres path's foundation, not yet the app runtime.
 * server.js still runs on backend/database.js (SQLite) during the transition
 * (see docs/architecture.md → "Database backend"). This module:
 *   - owns the async `pg` connection (pool) from backend/config.js,
 *   - applies backend/pg/schema.sql idempotently,
 *   - implements the CORE durable-entity helpers (users, orgs/projects/members,
 *     analysis objects, jobs + state machine, artifacts + immutability) that the
 *     Postgres contract test exercises, proving the schema + invariants hold on
 *     real Postgres.
 *
 * It deliberately mirrors the SQLite security invariants:
 *   - identity is server-generated (org_/proj_/ds_/ao_/job_/art_ ids),
 *   - ownership/role/status/storage are server-set, never client-supplied,
 *   - the job state machine is the SAME allow-list as database.js,
 *   - public projections strip claim_token / worker internals / storage_uri.
 *
 * The remaining owner-scoped CRUD surface (provenance/figures/cache reads,
 * dataset upload, lineage traversal, worker claim/lease) is intentionally NOT
 * duplicated here yet; porting it is the next branch (see docs). `pg` is
 * lazy-required inside connect() so importing this module never throws when the
 * dependency or a live database is absent (the contract test skips cleanly).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const passwords = require('./passwords');

const SCHEMA_PATH = path.join(__dirname, 'pg', 'schema.sql');

let pool = null;

// ── Job state machine (mirror of backend/database.js) ───────────────────────
const JOB_STATUSES = new Set([
  'created', 'queued', 'running', 'waiting_for_user', 'completed', 'failed', 'canceled'
]);
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'canceled']);
const JOB_TRANSITIONS = {
  created: new Set(['queued', 'canceled']),
  queued: new Set(['running', 'canceled']),
  running: new Set(['completed', 'failed', 'waiting_for_user', 'canceled', 'queued']),
  waiting_for_user: new Set(['queued', 'running', 'canceled']),
  completed: new Set(),
  failed: new Set(),
  canceled: new Set()
};
const INITIAL_JOB_STATUS = 'queued';

const ALLOWED_OBJECT_TYPES = new Set([
  'seurat', 'sce', 'anndata', 'matrix', 'assay', 'reduction', 'generic'
]);
const PROJECT_ROLES = new Set(['owner', 'admin', 'analyst', 'viewer']);

function validateJobTransition(fromStatus, toStatus) {
  if (!JOB_STATUSES.has(fromStatus) || !JOB_STATUSES.has(toStatus)) return false;
  return JOB_TRANSITIONS[fromStatus].has(toStatus);
}

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ── Server-generated ids (never client-supplied) ────────────────────────────
function genId(prefix, bytes = 12) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;
}

// ── Connection lifecycle ────────────────────────────────────────────────────
function isConfigured() {
  return config.hasPostgresConnection();
}

async function connect() {
  if (pool) return pool;
  // Lazy require so a missing `pg` module or missing database never breaks
  // importing this file (or the SQLite backend test run).
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
  pool = new Pool(config.postgresConfig());
  return pool;
}

async function query(text, params = []) {
  const p = await connect();
  return p.query(text, params);
}

async function initSchema() {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  await query(sql);
}

// TEST-ONLY: drop the app tables so a contract run starts from a clean schema.
// Guarded so it can never run against a production database.
async function resetSchemaForTests() {
  if (config.isProduction()) {
    throw new Error('resetSchemaForTests must not run in production.');
  }
  await query(`
    DROP TABLE IF EXISTS
      analysis_object_edges, job_artifacts, jobs, analysis_objects,
      datasets, project_members, projects, organization_members,
      organizations, figure_collection, results_cache, provenance, users
    CASCADE;
  `);
  await initSchema();
}

async function close() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

// ── Users / auth ────────────────────────────────────────────────────────────
async function createUser(email, password, displayName) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const salt = passwords.newSalt();
  const passwordHash = passwords.hashPassword(password, salt);
  try {
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, salt, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, display_name, created_at`,
      [normalizedEmail, passwordHash, salt, String(displayName || '').trim()]
    );
    const u = rows[0];
    // node-postgres returns BIGINT as a string to avoid precision loss; user ids
    // are small and the app treats them as numbers (matching the SQLite layer).
    return { id: Number(u.id), email: u.email, displayName: u.display_name, createdAt: u.created_at };
  } catch (err) {
    if (err && err.code === '23505') {
      return { error: 'An account with this email already exists.' };
    }
    throw err;
  }
}

async function getUserByEmail(email) {
  const { rows } = await query(
    'SELECT id, email, display_name, created_at FROM users WHERE email = $1',
    [String(email || '').trim().toLowerCase()]
  );
  if (!rows[0]) return null;
  return { id: Number(rows[0].id), email: rows[0].email, displayName: rows[0].display_name, createdAt: rows[0].created_at };
}

async function verifyUser(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
  const user = rows[0];
  const ok = passwords.verifyPassword(password, user ? user.password_hash : null);
  if (!user || !ok) return { error: passwords.GENERIC_CREDENTIAL_ERROR };
  return { id: Number(user.id), email: user.email, displayName: user.display_name, createdAt: user.created_at };
}

// ── Organizations / projects / membership ───────────────────────────────────
async function createOrganization(name, ownerUserId) {
  const owner = Number(ownerUserId);
  if (!Number.isInteger(owner) || owner <= 0) {
    throw codedError('INVALID_OWNER', 'A valid authenticated user is required.');
  }
  const id = genId('org');
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO organizations (id, name, owner_user_id) VALUES ($1, $2, $3)',
      [id, String(name || '').trim(), owner]
    );
    await client.query(
      'INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)',
      [id, owner, 'owner']
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getOrganization(id);
}

async function getOrganization(id) {
  const { rows } = await query('SELECT * FROM organizations WHERE id = $1', [String(id)]);
  return rows[0] || null;
}

async function createProject(organizationId, name, createdByUserId) {
  const creator = Number(createdByUserId);
  if (!Number.isInteger(creator) || creator <= 0) {
    throw codedError('INVALID_OWNER', 'A valid authenticated user is required.');
  }
  const id = genId('proj');
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO projects (id, organization_id, name, created_by_user_id) VALUES ($1, $2, $3, $4)',
      [id, String(organizationId), String(name || '').trim(), creator]
    );
    await client.query(
      'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
      [id, creator, 'owner']
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getProject(id);
}

async function getProject(id) {
  const { rows } = await query('SELECT * FROM projects WHERE id = $1', [String(id)]);
  return rows[0] || null;
}

async function addProjectMember(projectId, userId, role) {
  if (!PROJECT_ROLES.has(role)) {
    throw codedError('INVALID_ROLE', `Invalid role. Allowed: ${[...PROJECT_ROLES].join(', ')}.`);
  }
  await query(
    `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
    [String(projectId), Number(userId), role]
  );
}

async function getProjectRole(projectId, userId) {
  const { rows } = await query(
    'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
    [String(projectId), Number(userId)]
  );
  return rows[0] ? rows[0].role : null;
}

// ── Analysis objects ────────────────────────────────────────────────────────
async function createAnalysisObject(ownerUserId, input = {}) {
  const owner = Number(ownerUserId);
  if (!Number.isInteger(owner) || owner <= 0) {
    throw codedError('INVALID_OWNER', 'A valid authenticated user is required.');
  }
  const objectType = typeof input.objectType === 'string' ? input.objectType.trim() : '';
  if (!ALLOWED_OBJECT_TYPES.has(objectType)) {
    throw codedError('INVALID_OBJECT_TYPE', `Invalid objectType. Allowed: ${[...ALLOWED_OBJECT_TYPES].join(', ')}.`);
  }
  const metadata = input.metadata === undefined ? {} : input.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw codedError('INVALID_METADATA', 'metadata must be a plain JSON object.');
  }
  const id = genId('ao');
  const { rows } = await query(
    `INSERT INTO analysis_objects
       (id, owner_user_id, project_id, dataset_id, object_type, display_name, metadata_json, lineage_root_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $1)
     RETURNING *`,
    [
      id, owner,
      input.projectId != null ? String(input.projectId) : null,
      input.datasetId != null ? String(input.datasetId) : null,
      objectType,
      input.displayName != null ? String(input.displayName) : null,
      JSON.stringify(metadata)
    ]
  );
  return rowToAnalysisObject(rows[0]);
}

function rowToAnalysisObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: Number(row.owner_user_id),
    projectId: row.project_id,
    datasetId: row.dataset_id,
    parentObjectId: row.parent_object_id,
    lineageRootId: row.lineage_root_id,
    objectType: row.object_type,
    displayName: row.display_name,
    metadata: JSON.parse(row.metadata_json || '{}'),
    createdAt: row.created_at
  };
}

async function getAnalysisObjectForUser(id, ownerUserId) {
  const { rows } = await query(
    'SELECT * FROM analysis_objects WHERE id = $1 AND owner_user_id = $2',
    [String(id), Number(ownerUserId)]
  );
  return rowToAnalysisObject(rows[0]);
}

// ── Jobs ────────────────────────────────────────────────────────────────────
async function createJob(ownerUserId, input = {}) {
  const owner = Number(ownerUserId);
  if (!Number.isInteger(owner) || owner <= 0) {
    throw codedError('INVALID_OWNER', 'A valid authenticated user is required.');
  }
  const jobType = typeof input.jobType === 'string' ? input.jobType.trim() : '';
  if (!jobType) throw codedError('INVALID_JOB_TYPE', 'A job type is required.');
  const id = genId('job');
  const { rows } = await query(
    `INSERT INTO jobs
       (id, owner_user_id, project_id, analysis_object_id, dataset_id, job_type, status, parameters_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id, owner,
      input.projectId != null ? String(input.projectId) : null,
      input.analysisObjectId != null ? String(input.analysisObjectId) : null,
      input.datasetId != null ? String(input.datasetId) : null,
      jobType,
      INITIAL_JOB_STATUS,
      JSON.stringify(input.parameters || {})
    ]
  );
  return rowToJob(rows[0]);
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: Number(row.owner_user_id),
    projectId: row.project_id,
    analysisObjectId: row.analysis_object_id,
    resultAnalysisObjectId: row.result_analysis_object_id,
    datasetId: row.dataset_id,
    jobType: row.job_type,
    status: row.status,
    parameters: JSON.parse(row.parameters_json || '{}'),
    logs: JSON.parse(row.logs_json || '[]'),
    error: row.error_json ? JSON.parse(row.error_json) : null,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    priority: row.priority,
    // Worker-coordination columns are intentionally read but NOT projected here;
    // claim_token / worker_id / lease are server-tier internal (see toPublicJob).
    workerId: row.worker_id,
    claimToken: row.claim_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Public projection: strip the worker-coordination bearer capability + internals
// so a claim token / worker id can never reach an API consumer (mirror of
// database.js rowToJob's omission).
function toPublicJob(job) {
  if (!job) return null;
  const { claimToken, workerId, ...rest } = job; // eslint-disable-line no-unused-vars
  return rest;
}

async function getJobForUser(id, ownerUserId) {
  const { rows } = await query(
    'SELECT * FROM jobs WHERE id = $1 AND owner_user_id = $2',
    [String(id), Number(ownerUserId)]
  );
  return rowToJob(rows[0]);
}

/**
 * Server-tier job status transition. Rejects any edge not in the allow-list
 * (INVALID_TRANSITION) and treats terminal jobs as immutable. Ownership is
 * enforced by the caller (route/worker layer); this is the state-machine guard.
 */
async function transitionJobStatus(id, ownerUserId, toStatus) {
  const job = await getJobForUser(id, ownerUserId);
  if (!job) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!validateJobTransition(job.status, toStatus)) {
    throw codedError('INVALID_TRANSITION', `Cannot transition job from '${job.status}' to '${toStatus}'.`);
  }
  const { rows } = await query(
    'UPDATE jobs SET status = $1, updated_at = now() WHERE id = $2 AND owner_user_id = $3 RETURNING *',
    [toStatus, String(id), Number(ownerUserId)]
  );
  return rowToJob(rows[0]);
}

// ── Job artifacts (metadata-first; result-checkpoint immutability) ───────────
async function createArtifact(job, input = {}) {
  const id = genId('art');
  const { rows } = await query(
    `INSERT INTO job_artifacts
       (id, project_id, job_id, created_by_user_id, artifact_type, name, storage_kind,
        storage_uri, checksum_sha256, size_bytes, status, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      id,
      job.projectId != null ? String(job.projectId) : null,
      String(job.id),
      Number(job.ownerUserId),
      String(input.artifactType || 'metadata'),
      input.name != null ? String(input.name) : null,
      String(input.storageKind || 'metadata_only'),
      input.storageUri != null ? String(input.storageUri) : null,
      input.checksumSha256 != null ? String(input.checksumSha256) : null,
      input.sizeBytes != null ? Number(input.sizeBytes) : null,
      String(input.status || 'available'),
      JSON.stringify(input.metadata || {})
    ]
  );
  return rowToJobArtifact(rows[0]);
}

/**
 * Create the single immutable result checkpoint for a job. The partial unique
 * index (artifact_type='result_checkpoint') makes a second attempt fail with a
 * 23505, surfaced as CHECKPOINT_EXISTS — the Postgres enforcement of the
 * exactly-one-checkpoint immutability invariant.
 */
async function createResultCheckpoint(job, input = {}) {
  try {
    return await createArtifact(job, { ...input, artifactType: 'result_checkpoint' });
  } catch (err) {
    if (err && err.code === '23505') {
      throw codedError('CHECKPOINT_EXISTS', 'A result checkpoint already exists for this job.');
    }
    throw err;
  }
}

function rowToJobArtifact(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    createdByUserId: Number(row.created_by_user_id),
    artifactType: row.artifact_type,
    name: row.name,
    storageKind: row.storage_kind,
    storageUri: row.storage_uri,
    checksumSha256: row.checksum_sha256,
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    status: row.status,
    metadata: JSON.parse(row.metadata_json || '{}'),
    createdAt: row.created_at
  };
}

// Public projection: OMIT storage_uri so an internal/local path or key can never
// leak (there is no artifact download surface) — mirror of database.js.
function toPublicJobArtifact(artifact) {
  if (!artifact) return null;
  const { storageUri, ...rest } = artifact; // eslint-disable-line no-unused-vars
  return rest;
}

module.exports = {
  // lifecycle
  isConfigured,
  connect,
  query,
  initSchema,
  resetSchemaForTests,
  close,
  // constants / state machine
  JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  INITIAL_JOB_STATUS,
  PROJECT_ROLES,
  ALLOWED_OBJECT_TYPES,
  validateJobTransition,
  genId,
  // users
  createUser,
  getUserByEmail,
  verifyUser,
  // orgs / projects / members
  createOrganization,
  getOrganization,
  createProject,
  getProject,
  addProjectMember,
  getProjectRole,
  // analysis objects
  createAnalysisObject,
  getAnalysisObjectForUser,
  rowToAnalysisObject,
  // jobs
  createJob,
  getJobForUser,
  transitionJobStatus,
  rowToJob,
  toPublicJob,
  // artifacts
  createArtifact,
  createResultCheckpoint,
  rowToJobArtifact,
  toPublicJobArtifact
};
