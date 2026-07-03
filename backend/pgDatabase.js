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
 * The remaining provenance/figures/cache and worker claim/lease surface is
 * intentionally NOT duplicated here yet; porting it is a later branch (see
 * docs). `pg` is lazy-required inside connect() so importing this module never
 * throws when the dependency or a live database is absent (the contract test
 * skips cleanly).
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
const DATASET_WRITE_ROLES = ['owner', 'admin', 'analyst'];
const DATASET_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const ANALYSIS_WRITE_ROLES = ['owner', 'admin', 'analyst'];
const ANALYSIS_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const PROJECT_JOB_WRITE_ROLES = ['owner', 'admin', 'analyst'];
const PROJECT_JOB_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const ARTIFACT_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const LINEAGE_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];

const ALLOWED_JOB_TYPES = new Set([
  'generic',
  'checkpoint.noop',
  'r.runtime.check',
  'r.object.inspect',
  'pbmc.pipeline.v1',
  'checkpoint.load.v1',
  'deg.find_markers.v1'
]);
const ALLOWED_DATASET_FILE_TYPES = new Set([
  'tenx_zip', 'tenx_h5', 'seurat_rds', 'h5seurat', 'h5ad',
  'count_matrix_csv', 'count_matrix_tsv', 'metadata_csv', 'metadata_tsv'
]);
const DATASET_UPLOAD_STATUSES = new Set(['pending', 'uploaded', 'failed']);
const DATASET_VALIDATION_STATUSES = new Set(['pending', 'valid', 'invalid', 'skipped']);
const ALLOWED_ARTIFACT_TYPES = new Set([
  'checkpoint', 'metrics', 'log', 'figure', 'script_fragment', 'other_metadata',
  'r_runtime_check', 'r_object_inspection', 'pipeline_summary', 'checkpoint_load',
  'deg_markers', 'deg_summary', 'result_checkpoint'
]);
const ALLOWED_ARTIFACT_STORAGE_KINDS = new Set(['metadata_only', 'local_internal']);
const ALLOWED_ARTIFACT_STATUSES = new Set(['available', 'pending', 'error']);
const ALLOWED_EDGE_TYPES = new Set([
  'derived_from', 'checkpoint', 'branch', 'integration_input', 'comparison_input', 'manual_link'
]);
const ALLOWED_PARENT_ROLES = new Set([
  'primary', 'secondary', 'reference', 'query', 'control', 'case', 'input'
]);
const LINEAGE_MAX_NODES = 500;
const LINEAGE_MAX_DEPTH = 64;
const AO_ID_RE = /^ao_[0-9a-f]+$/;
const JOB_ID_RE = /^job_[0-9a-f]+$/;

function validateJobTransition(fromStatus, toStatus) {
  if (!JOB_STATUSES.has(fromStatus) || !JOB_STATUSES.has(toStatus)) return false;
  return JOB_TRANSITIONS[fromStatus].has(toStatus);
}

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function assertPlainObject(value, code, message) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw codedError(code, message);
  }
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  return JSON.parse(value);
}

function sanitizeDatasetFilename(name) {
  if (typeof name !== 'string') return null;
  const base = name.split(/[\\/]+/).pop().trim();
  if (!base || base === '.' || base === '..') return null;
  return base.slice(0, 255);
}

function normalizeValidationErrors(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) return JSON.stringify(value);
  throw codedError('INVALID_VALIDATION_ERRORS', 'validation_errors must be a JSON array or object.');
}

function assertDatasetStatusCombo(uploadStatus, validationStatus) {
  if (validationStatus === 'valid' && uploadStatus !== 'uploaded') {
    throw codedError('INVALID_STATUS_COMBO',
      'A dataset cannot have validation_status "valid" unless upload_status is "uploaded".');
  }
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

function filterClauses(filters, allowed) {
  const clauses = [];
  const params = [];
  for (const [field, column] of Object.entries(allowed)) {
    if (filters[field] !== undefined && filters[field] !== null && filters[field] !== '') {
      clauses.push(`${column} = $${params.length + 1}`);
      params.push(String(filters[field]));
    }
  }
  return { clauses, params };
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

function rowToProjectWithRole(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description || '',
    createdByUserId: Number(row.created_by_user_id),
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
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

async function verifyProjectMember(userId, projectId) {
  if (typeof projectId !== 'string' || projectId === '') return null;
  const { rows } = await query(
    'SELECT project_id, user_id, role FROM project_members WHERE project_id = $1 AND user_id = $2',
    [String(projectId), Number(userId)]
  );
  if (!rows[0]) return null;
  return { projectId: rows[0].project_id, userId: Number(rows[0].user_id), role: rows[0].role };
}

async function requireProjectRole(userId, projectId, allowedRoles) {
  const membership = await verifyProjectMember(userId, projectId);
  if (!membership) throw codedError('NOT_FOUND', 'Project not found.');
  const allowed = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  if (!allowed.includes(membership.role)) {
    throw codedError('FORBIDDEN', 'You do not have permission to perform this action.');
  }
  return membership;
}

async function getProjectForUser(projectId, userId) {
  const { rows } = await query(
    `SELECT p.*, pm.role
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
      WHERE p.id = $1 AND pm.user_id = $2`,
    [String(projectId), Number(userId)]
  );
  return rowToProjectWithRole(rows[0]);
}

async function listProjectsForUser(userId) {
  const { rows } = await query(
    `SELECT p.*, pm.role
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
      WHERE pm.user_id = $1
      ORDER BY p.created_at DESC, p.id DESC`,
    [Number(userId)]
  );
  return rows.map(rowToProjectWithRole);
}

async function listProjectMembers(projectId) {
  const { rows } = await query(
    `SELECT pm.user_id, pm.role, pm.created_at, pm.updated_at, u.email, u.display_name
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = $1
      ORDER BY pm.created_at ASC, pm.user_id ASC`,
    [String(projectId)]
  );
  return rows.map(r => ({
    userId: Number(r.user_id),
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

// -- Datasets ----------------------------------------------------------------
function rowToDataset(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    ownerUserId: Number(row.owner_user_id),
    createdByUserId: Number(row.created_by_user_id),
    originalFilename: row.original_filename,
    internalStorageKey: row.internal_storage_key,
    storageUri: row.storage_uri,
    fileType: row.file_type,
    fileSizeBytes: row.file_size_bytes == null ? null : Number(row.file_size_bytes),
    sha256: row.sha256,
    uploadStatus: row.upload_status,
    validationStatus: row.validation_status,
    validationErrors: row.validation_errors ? JSON.parse(row.validation_errors) : null,
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toPublicDataset(dataset) {
  if (!dataset) return null;
  const { internalStorageKey, storageUri, ...rest } = dataset; // eslint-disable-line no-unused-vars
  return rest;
}

async function getDatasetRow(datasetId, projectId) {
  const { rows } = await query(
    'SELECT * FROM datasets WHERE id = $1 AND project_id = $2',
    [String(datasetId), String(projectId)]
  );
  return rowToDataset(rows[0]);
}

async function createDatasetForProject(userId, projectId, input = {}) {
  const membership = await requireProjectRole(userId, projectId, DATASET_WRITE_ROLES);
  if (!ALLOWED_DATASET_FILE_TYPES.has(input.fileType)) {
    throw codedError('INVALID_FILE_TYPE',
      `Invalid file_type. Allowed: ${[...ALLOWED_DATASET_FILE_TYPES].join(', ')}.`);
  }
  const uploadStatus = input.uploadStatus === undefined ? 'pending' : input.uploadStatus;
  if (!DATASET_UPLOAD_STATUSES.has(uploadStatus)) {
    throw codedError('INVALID_UPLOAD_STATUS',
      `Invalid upload_status. Allowed: ${[...DATASET_UPLOAD_STATUSES].join(', ')}.`);
  }
  const validationStatus = input.validationStatus === undefined ? 'pending' : input.validationStatus;
  if (!DATASET_VALIDATION_STATUSES.has(validationStatus)) {
    throw codedError('INVALID_VALIDATION_STATUS',
      `Invalid validation_status. Allowed: ${[...DATASET_VALIDATION_STATUSES].join(', ')}.`);
  }
  assertDatasetStatusCombo(uploadStatus, validationStatus);
  const metadata = input.metadata === undefined ? {} : input.metadata;
  assertPlainObject(metadata, 'INVALID_METADATA', 'metadata must be a plain JSON object.');
  const id = genId('ds');
  const { rows } = await query(
    `INSERT INTO datasets
       (id, project_id, owner_user_id, created_by_user_id, original_filename,
        file_type, upload_status, validation_status, validation_errors, metadata)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      id,
      String(projectId),
      Number(membership.userId),
      sanitizeDatasetFilename(input.originalFilename),
      input.fileType,
      uploadStatus,
      validationStatus,
      normalizeValidationErrors(input.validationErrors),
      JSON.stringify(metadata)
    ]
  );
  return rowToDataset(rows[0]);
}

async function listDatasetsForProject(userId, projectId, filters = {}) {
  await requireProjectRole(userId, projectId, DATASET_READ_ROLES);
  const clauses = ['project_id = $1'];
  const params = [String(projectId)];
  if (filters.fileType !== undefined) {
    if (!ALLOWED_DATASET_FILE_TYPES.has(filters.fileType)) throw codedError('INVALID_FILE_TYPE', 'Invalid file_type filter.');
    params.push(filters.fileType); clauses.push(`file_type = $${params.length}`);
  }
  if (filters.uploadStatus !== undefined) {
    if (!DATASET_UPLOAD_STATUSES.has(filters.uploadStatus)) throw codedError('INVALID_UPLOAD_STATUS', 'Invalid upload_status filter.');
    params.push(filters.uploadStatus); clauses.push(`upload_status = $${params.length}`);
  }
  if (filters.validationStatus !== undefined) {
    if (!DATASET_VALIDATION_STATUSES.has(filters.validationStatus)) throw codedError('INVALID_VALIDATION_STATUS', 'Invalid validation_status filter.');
    params.push(filters.validationStatus); clauses.push(`validation_status = $${params.length}`);
  }
  const { rows } = await query(
    `SELECT * FROM datasets WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`,
    params
  );
  return rows.map(rowToDataset);
}

async function getDatasetForProject(userId, projectId, datasetId) {
  await requireProjectRole(userId, projectId, DATASET_READ_ROLES);
  return getDatasetRow(datasetId, projectId);
}

async function verifyDatasetProjectAccess(userId, datasetId, allowedRoles = DATASET_READ_ROLES) {
  if (typeof datasetId !== 'string' || datasetId === '') {
    throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
  }
  const { rows } = await query('SELECT * FROM datasets WHERE id = $1', [datasetId]);
  if (!rows[0]) throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
  const membership = await verifyProjectMember(userId, rows[0].project_id);
  if (!membership) throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
  const allowed = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  if (!allowed.includes(membership.role)) {
    throw codedError('FORBIDDEN', 'You do not have permission to use this dataset.');
  }
  return rowToDataset(rows[0]);
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
  assertPlainObject(metadata, 'INVALID_METADATA', 'metadata must be a plain JSON object.');
  let datasetId = null;
  if (input.datasetId !== undefined && input.datasetId !== null) {
    await verifyDatasetProjectAccess(owner, String(input.datasetId), DATASET_WRITE_ROLES);
    datasetId = String(input.datasetId);
  }
  const parentObjectId = input.parentObjectId ? String(input.parentObjectId) : null;
  let lineageRootId = null;
  if (parentObjectId) {
    const parent = await getAnalysisObjectForUser(parentObjectId, owner);
    if (!parent) throw codedError('PARENT_NOT_FOUND', 'Parent analysis object not found.');
    lineageRootId = parent.lineageRootId || parent.id;
  }
  const id = genId('ao');
  const { rows } = await query(
    `INSERT INTO analysis_objects
       (id, owner_user_id, project_id, dataset_id, parent_object_id, lineage_root_id,
        object_type, display_name, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      id, owner,
      input.projectId != null ? String(input.projectId) : null,
      datasetId,
      parentObjectId,
      lineageRootId || id,
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
    storageUri: row.storage_uri,
    objectHash: row.object_hash,
    metadata: JSON.parse(row.metadata_json || '{}'),
    createdByProvenanceId: row.created_by_provenance_id,
    createdAt: row.created_at
  };
}

function toPublicAnalysisObject(object) {
  if (!object) return null;
  const { storageUri, objectHash, ...rest } = object; // eslint-disable-line no-unused-vars
  return rest;
}

async function getAnalysisObjectForUser(id, ownerUserId) {
  const { rows } = await query(
    'SELECT * FROM analysis_objects WHERE id = $1 AND owner_user_id = $2',
    [String(id), Number(ownerUserId)]
  );
  return rowToAnalysisObject(rows[0]);
}

async function listAnalysisObjectsForUser(ownerUserId, filters = {}) {
  const { clauses, params } = filterClauses(filters, {
    datasetId: 'dataset_id',
    parentObjectId: 'parent_object_id',
    lineageRootId: 'lineage_root_id',
    objectType: 'object_type'
  });
  const allParams = [Number(ownerUserId), ...params];
  const where = ['owner_user_id = $1', ...clauses.map((c, i) => c.replace(`$${i + 1}`, `$${i + 2}`))];
  const { rows } = await query(
    `SELECT * FROM analysis_objects WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC`,
    allParams
  );
  return rows.map(rowToAnalysisObject);
}

async function getProjectAnalysisObjectRow(objectId, projectId) {
  if (typeof objectId !== 'string' || objectId === '') return null;
  const { rows } = await query(
    'SELECT * FROM analysis_objects WHERE id = $1 AND project_id = $2',
    [objectId, String(projectId)]
  );
  return rowToAnalysisObject(rows[0]);
}

async function createProjectAnalysisObject(userId, projectId, input = {}) {
  const membership = await requireProjectRole(userId, projectId, ANALYSIS_WRITE_ROLES);
  const owner = membership.userId;
  const pid = String(projectId);
  const objectType = typeof input.objectType === 'string' ? input.objectType.trim() : '';
  if (!ALLOWED_OBJECT_TYPES.has(objectType)) {
    throw codedError('INVALID_OBJECT_TYPE', `Invalid objectType. Allowed: ${[...ALLOWED_OBJECT_TYPES].join(', ')}.`);
  }
  const metadata = input.metadata === undefined ? {} : input.metadata;
  assertPlainObject(metadata, 'INVALID_METADATA', 'metadata must be a plain JSON object.');
  let datasetId = null;
  if (input.datasetId !== undefined && input.datasetId !== null) {
    if (typeof input.datasetId !== 'string' || !(await getDatasetRow(input.datasetId, pid))) {
      throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
    }
    datasetId = input.datasetId;
  }
  const parentObjectId = input.parentObjectId ? String(input.parentObjectId) : null;
  let lineageRootId = null;
  if (parentObjectId) {
    const parent = await getProjectAnalysisObjectRow(parentObjectId, pid);
    if (!parent) throw codedError('PARENT_NOT_FOUND', 'Parent analysis object not found.');
    lineageRootId = parent.lineageRootId || parent.id;
  }
  const id = genId('ao');
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO analysis_objects
         (id, owner_user_id, project_id, dataset_id, parent_object_id, lineage_root_id,
          object_type, display_name, metadata_json, created_by_provenance_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        id, Number(owner), pid, datasetId, parentObjectId, lineageRootId || id,
        objectType, input.displayName != null ? String(input.displayName) : null,
        JSON.stringify(metadata),
        input.createdByProvenanceId ? String(input.createdByProvenanceId) : null
      ]
    );
    if (parentObjectId) {
      await insertLineageEdgeRow(client, {
        projectId: pid,
        parentObjectId,
        childObjectId: id,
        jobId: null,
        edgeType: 'derived_from',
        parentRole: 'primary',
        metadata: {},
        createdByUserId: owner
      });
    }
    await client.query('COMMIT');
    return rowToAnalysisObject(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listProjectAnalysisObjects(userId, projectId, filters = {}) {
  await requireProjectRole(userId, projectId, ANALYSIS_READ_ROLES);
  const clauses = ['project_id = $1'];
  const params = [String(projectId)];
  const allowed = {
    datasetId: 'dataset_id',
    parentObjectId: 'parent_object_id',
    lineageRootId: 'lineage_root_id',
    objectType: 'object_type'
  };
  for (const [field, column] of Object.entries(allowed)) {
    if (filters[field]) { params.push(String(filters[field])); clauses.push(`${column} = $${params.length}`); }
  }
  const { rows } = await query(
    `SELECT * FROM analysis_objects WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`,
    params
  );
  return rows.map(rowToAnalysisObject);
}

async function getProjectAnalysisObject(userId, projectId, objectId) {
  await requireProjectRole(userId, projectId, ANALYSIS_READ_ROLES);
  return getProjectAnalysisObjectRow(objectId, projectId);
}

// ── Jobs ────────────────────────────────────────────────────────────────────
async function createJob(ownerUserId, input = {}) {
  const owner = Number(ownerUserId);
  if (!Number.isInteger(owner) || owner <= 0) {
    throw codedError('INVALID_OWNER', 'A valid authenticated user is required.');
  }
  const jobType = typeof input.jobType === 'string' ? input.jobType.trim() : '';
  if (!ALLOWED_JOB_TYPES.has(jobType)) {
    throw codedError('INVALID_JOB_TYPE',
      `Invalid jobType. Allowed: ${[...ALLOWED_JOB_TYPES].join(', ')}.`);
  }
  const parameters = input.parameters === undefined ? {} : input.parameters;
  assertPlainObject(parameters, 'INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
  let analysisObjectId = null;
  if (input.analysisObjectId !== undefined && input.analysisObjectId !== null) {
    if (typeof input.analysisObjectId !== 'string' ||
        !(await getAnalysisObjectForUser(input.analysisObjectId, owner))) {
      throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    }
    analysisObjectId = input.analysisObjectId;
  }
  let datasetId = null;
  if (input.datasetId !== undefined && input.datasetId !== null) {
    await verifyDatasetProjectAccess(owner, String(input.datasetId), DATASET_WRITE_ROLES);
    datasetId = String(input.datasetId);
  }
  const id = genId('job');
  const { rows } = await query(
    `INSERT INTO jobs
       (id, owner_user_id, project_id, analysis_object_id, dataset_id, job_type, status, parameters_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id, owner,
      input.projectId != null ? String(input.projectId) : null,
      analysisObjectId,
      datasetId,
      jobType,
      INITIAL_JOB_STATUS,
      JSON.stringify(parameters)
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
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    canceledAt: row.canceled_at
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

async function listJobsForUser(ownerUserId, filters = {}) {
  const clauses = ['owner_user_id = $1'];
  const params = [Number(ownerUserId)];
  const allowed = {
    status: 'status',
    jobType: 'job_type',
    analysisObjectId: 'analysis_object_id',
    resultAnalysisObjectId: 'result_analysis_object_id',
    datasetId: 'dataset_id'
  };
  for (const [field, column] of Object.entries(allowed)) {
    if (filters[field]) { params.push(String(filters[field])); clauses.push(`${column} = $${params.length}`); }
  }
  const { rows } = await query(
    `SELECT * FROM jobs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`,
    params
  );
  return rows.map(rowToJob);
}

async function getProjectJobRow(jobId, projectId) {
  if (typeof jobId !== 'string' || jobId === '') return null;
  const { rows } = await query(
    'SELECT * FROM jobs WHERE id = $1 AND project_id = $2',
    [String(jobId), String(projectId)]
  );
  return rowToJob(rows[0]);
}

async function createProjectJob(userId, projectId, input = {}) {
  const membership = await requireProjectRole(userId, projectId, PROJECT_JOB_WRITE_ROLES);
  const owner = membership.userId;
  const pid = String(projectId);
  const jobType = typeof input.jobType === 'string' ? input.jobType.trim() : '';
  if (!ALLOWED_JOB_TYPES.has(jobType)) {
    throw codedError('INVALID_JOB_TYPE',
      `Invalid jobType. Allowed: ${[...ALLOWED_JOB_TYPES].join(', ')}.`);
  }
  const parameters = input.parameters === undefined ? {} : input.parameters;
  assertPlainObject(parameters, 'INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
  let analysisObjectId = null;
  if (input.analysisObjectId !== undefined && input.analysisObjectId !== null) {
    if (typeof input.analysisObjectId !== 'string' || !(await getProjectAnalysisObjectRow(input.analysisObjectId, pid))) {
      throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    }
    analysisObjectId = input.analysisObjectId;
  }
  let resultAnalysisObjectId = null;
  if (input.resultAnalysisObjectId !== undefined && input.resultAnalysisObjectId !== null) {
    if (typeof input.resultAnalysisObjectId !== 'string' || !(await getProjectAnalysisObjectRow(input.resultAnalysisObjectId, pid))) {
      throw codedError('RESULT_OBJECT_NOT_FOUND', 'Result analysis object not found.');
    }
    resultAnalysisObjectId = input.resultAnalysisObjectId;
  }
  let datasetId = null;
  if (input.datasetId !== undefined && input.datasetId !== null) {
    if (typeof input.datasetId !== 'string' || !(await getDatasetRow(input.datasetId, pid))) {
      throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
    }
    datasetId = input.datasetId;
  }
  const id = genId('job');
  const { rows } = await query(
    `INSERT INTO jobs
       (id, owner_user_id, project_id, analysis_object_id, result_analysis_object_id,
        dataset_id, job_type, status, parameters_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [id, Number(owner), pid, analysisObjectId, resultAnalysisObjectId, datasetId,
      jobType, INITIAL_JOB_STATUS, JSON.stringify(parameters)]
  );
  return rowToJob(rows[0]);
}

async function listProjectJobs(userId, projectId, filters = {}) {
  await requireProjectRole(userId, projectId, PROJECT_JOB_READ_ROLES);
  const clauses = ['project_id = $1'];
  const params = [String(projectId)];
  const allowed = {
    status: 'status',
    jobType: 'job_type',
    analysisObjectId: 'analysis_object_id',
    resultAnalysisObjectId: 'result_analysis_object_id',
    datasetId: 'dataset_id'
  };
  for (const [field, column] of Object.entries(allowed)) {
    if (filters[field]) { params.push(String(filters[field])); clauses.push(`${column} = $${params.length}`); }
  }
  const { rows } = await query(
    `SELECT * FROM jobs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`,
    params
  );
  return rows.map(rowToJob);
}

async function getProjectJob(userId, projectId, jobId) {
  await requireProjectRole(userId, projectId, PROJECT_JOB_READ_ROLES);
  return getProjectJobRow(jobId, projectId);
}

/**
 * Server-tier job status transition. Rejects any edge not in the allow-list
 * (INVALID_TRANSITION) and treats terminal jobs as immutable. Ownership is
 * enforced by the caller (route/worker layer); this is the state-machine guard.
 */
async function transitionJobStatus(id, ownerUserId, toStatus) {
  const job = await getJobForUser(id, ownerUserId);
  if (!job) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!JOB_STATUSES.has(toStatus)) {
    throw codedError('INVALID_STATUS', `Invalid job status: ${toStatus}.`);
  }
  if (!validateJobTransition(job.status, toStatus)) {
    throw codedError('INVALID_TRANSITION', `Cannot transition job from '${job.status}' to '${toStatus}'.`);
  }
  const { rows } = await query(
    `UPDATE jobs SET
       status = $1,
       updated_at = now(),
       started_at = CASE WHEN $1 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
       completed_at = CASE WHEN $1 IN ('completed', 'failed') THEN now() ELSE completed_at END,
       canceled_at = CASE WHEN $1 = 'canceled' THEN now() ELSE canceled_at END,
       claim_token = CASE WHEN $1 IN ('completed', 'failed', 'canceled') THEN NULL ELSE claim_token END,
       lease_expires_at = CASE WHEN $1 IN ('completed', 'failed', 'canceled') THEN NULL ELSE lease_expires_at END
     WHERE id = $2 AND owner_user_id = $3
     RETURNING *`,
    [toStatus, String(id), Number(ownerUserId)]
  );
  return rowToJob(rows[0]);
}

async function updateJobStatusForUser(ownerUserId, jobId, nextStatus, opts = {}) {
  const owner = Number(ownerUserId);
  const job = await getJobForUser(jobId, owner);
  if (!job) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!JOB_STATUSES.has(nextStatus)) throw codedError('INVALID_STATUS', `Invalid job status: ${nextStatus}.`);
  if (!validateJobTransition(job.status, nextStatus)) {
    throw codedError('INVALID_TRANSITION', `Cannot transition job from '${job.status}' to '${nextStatus}'.`);
  }
  let resultId = job.resultAnalysisObjectId;
  if (opts.resultAnalysisObjectId !== undefined && opts.resultAnalysisObjectId !== null) {
    const resultObject = typeof opts.resultAnalysisObjectId === 'string'
      ? await getAnalysisObjectForUser(opts.resultAnalysisObjectId, owner)
      : null;
    if (!resultObject) {
      throw codedError('RESULT_OBJECT_NOT_FOUND', 'Result analysis object not found.');
    }
    const jobProjectId = job.projectId || null;
    const resultProjectId = resultObject.projectId || null;
    if (jobProjectId !== resultProjectId) {
      throw codedError('RESULT_OBJECT_NOT_FOUND', 'Result analysis object not found.');
    }
    resultId = opts.resultAnalysisObjectId;
  }
  const logs = opts.log !== undefined ? [...job.logs, normalizeJobLogEntry(opts.log)] : job.logs;
  const errorJson = opts.error !== undefined
    ? (opts.error === null ? null : JSON.stringify(normalizeJobError(opts.error)))
    : (job.error === null ? null : JSON.stringify(job.error));
  const { rows } = await query(
    `UPDATE jobs SET
       status = $1,
       result_analysis_object_id = $2,
       logs_json = $3,
       error_json = $4,
       updated_at = now(),
       started_at = CASE WHEN $1 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
       completed_at = CASE WHEN $1 IN ('completed', 'failed') THEN now() ELSE completed_at END,
       canceled_at = CASE WHEN $1 = 'canceled' THEN now() ELSE canceled_at END,
       claim_token = CASE WHEN $1 IN ('completed', 'failed', 'canceled') THEN NULL ELSE claim_token END,
       lease_expires_at = CASE WHEN $1 IN ('completed', 'failed', 'canceled') THEN NULL ELSE lease_expires_at END
     WHERE id = $5 AND owner_user_id = $6
     RETURNING *`,
    [nextStatus, resultId, JSON.stringify(logs), errorJson, String(jobId), owner]
  );
  return rowToJob(rows[0]);
}

async function appendJobLogForUser(ownerUserId, jobId, entry) {
  const owner = Number(ownerUserId);
  const job = await getJobForUser(jobId, owner);
  if (!job) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  const logs = [...job.logs, normalizeJobLogEntry(entry)];
  const { rows } = await query(
    'UPDATE jobs SET logs_json = $1, updated_at = now() WHERE id = $2 AND owner_user_id = $3 RETURNING *',
    [JSON.stringify(logs), String(jobId), owner]
  );
  return rowToJob(rows[0]);
}

// ── Job artifacts (metadata-first; result-checkpoint immutability) ───────────
async function createArtifact(job, input = {}) {
  const artifactType = typeof input.artifactType === 'string' ? input.artifactType.trim() : 'other_metadata';
  if (!ALLOWED_ARTIFACT_TYPES.has(artifactType)) {
    throw codedError('INVALID_ARTIFACT_TYPE',
      `Invalid artifactType. Allowed: ${[...ALLOWED_ARTIFACT_TYPES].join(', ')}.`);
  }
  const storageKind = input.storageKind === undefined || input.storageKind === null
    ? 'metadata_only' : String(input.storageKind);
  if (!ALLOWED_ARTIFACT_STORAGE_KINDS.has(storageKind)) {
    throw codedError('INVALID_STORAGE_KIND',
      `Invalid storageKind. Allowed: ${[...ALLOWED_ARTIFACT_STORAGE_KINDS].join(', ')}.`);
  }
  const status = input.status === undefined || input.status === null ? 'available' : String(input.status);
  if (!ALLOWED_ARTIFACT_STATUSES.has(status)) {
    throw codedError('INVALID_ARTIFACT_STATUS',
      `Invalid status. Allowed: ${[...ALLOWED_ARTIFACT_STATUSES].join(', ')}.`);
  }
  const metadata = input.metadata === undefined ? {} : input.metadata;
  assertPlainObject(metadata, 'INVALID_METADATA', 'metadata must be a plain JSON object.');
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
      artifactType,
      input.name != null ? String(input.name) : null,
      storageKind,
      input.storageUri != null ? String(input.storageUri) : null,
      input.checksumSha256 != null ? String(input.checksumSha256) : null,
      input.sizeBytes != null ? Number(input.sizeBytes) : null,
      status,
      JSON.stringify(metadata)
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
    datasetId: row.dataset_id,
    analysisObjectId: row.analysis_object_id,
    resultAnalysisObjectId: row.result_analysis_object_id,
    provenanceId: row.provenance_id,
    figureId: row.figure_id,
    createdByUserId: Number(row.created_by_user_id),
    artifactType: row.artifact_type,
    name: row.name,
    description: row.description,
    mimeType: row.mime_type,
    storageKind: row.storage_kind,
    storageUri: row.storage_uri,
    checksumSha256: row.checksum_sha256,
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    status: row.status,
    metadata: JSON.parse(row.metadata_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Public projection: OMIT storage_uri so an internal/local path or key can never
// leak (there is no artifact download surface) — mirror of database.js.
function toPublicJobArtifact(artifact) {
  if (!artifact) return null;
  const { storageUri, ...rest } = artifact; // eslint-disable-line no-unused-vars
  return rest;
}

async function getJobArtifactsByJobId(jobId) {
  if (typeof jobId !== 'string' || jobId === '') return [];
  const { rows } = await query(
    'SELECT * FROM job_artifacts WHERE job_id = $1 ORDER BY created_at ASC, id ASC',
    [String(jobId)]
  );
  return rows.map(rowToJobArtifact);
}

async function listProjectArtifacts(userId, projectId, filters = {}) {
  await requireProjectRole(userId, projectId, ARTIFACT_READ_ROLES);
  const clauses = ['project_id = $1'];
  const params = [String(projectId)];
  const allowed = {
    jobId: 'job_id',
    artifactType: 'artifact_type',
    status: 'status',
    analysisObjectId: 'analysis_object_id',
    resultAnalysisObjectId: 'result_analysis_object_id',
    datasetId: 'dataset_id',
    provenanceId: 'provenance_id',
    figureId: 'figure_id'
  };
  for (const [field, column] of Object.entries(allowed)) {
    if (filters[field]) { params.push(String(filters[field])); clauses.push(`${column} = $${params.length}`); }
  }
  const { rows } = await query(
    `SELECT * FROM job_artifacts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`,
    params
  );
  return rows.map(rowToJobArtifact).map(toPublicJobArtifact);
}

async function listProjectJobArtifacts(userId, projectId, jobId, filters = {}) {
  await requireProjectRole(userId, projectId, ARTIFACT_READ_ROLES);
  if (!(await getProjectJobRow(jobId, projectId))) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  return listProjectArtifacts(userId, projectId, { ...filters, jobId });
}

async function getProjectArtifact(userId, projectId, artifactId) {
  await requireProjectRole(userId, projectId, ARTIFACT_READ_ROLES);
  if (typeof artifactId !== 'string' || artifactId === '') return null;
  const { rows } = await query(
    'SELECT * FROM job_artifacts WHERE id = $1 AND project_id = $2',
    [String(artifactId), String(projectId)]
  );
  return toPublicJobArtifact(rowToJobArtifact(rows[0]));
}

// -- Lineage -----------------------------------------------------------------
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
    createdByUserId: Number(row.created_by_user_id),
    createdAt: row.created_at
  };
}

async function insertLineageEdgeRow(client, {
  projectId, parentObjectId, childObjectId, jobId, edgeType, parentRole, metadata, createdByUserId
}) {
  const id = genId('aoe');
  await client.query(
    `INSERT INTO analysis_object_edges
       (id, project_id, parent_analysis_object_id, child_analysis_object_id, job_id,
        edge_type, parent_role, metadata_json, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      projectId || null,
      String(parentObjectId),
      String(childObjectId),
      jobId || null,
      edgeType,
      parentRole,
      JSON.stringify(metadata || {}),
      Number(createdByUserId)
    ]
  );
  return id;
}

async function getLineageEdgesByParent(parentObjectId, projectScope) {
  const params = [String(parentObjectId)];
  let where = 'parent_analysis_object_id = $1';
  if (projectScope && projectScope.projectId !== undefined) {
    if (projectScope.projectId === null) {
      where += ' AND project_id IS NULL';
    } else {
      params.push(String(projectScope.projectId));
      where += ` AND project_id = $${params.length}`;
    }
  }
  const { rows } = await query(
    `SELECT * FROM analysis_object_edges WHERE ${where} ORDER BY created_at ASC, id ASC`,
    params
  );
  return rows;
}

async function getLineageEdgesByChild(childObjectId, projectScope) {
  const params = [String(childObjectId)];
  let where = 'child_analysis_object_id = $1';
  if (projectScope && projectScope.projectId !== undefined) {
    if (projectScope.projectId === null) {
      where += ' AND project_id IS NULL';
    } else {
      params.push(String(projectScope.projectId));
      where += ` AND project_id = $${params.length}`;
    }
  }
  const { rows } = await query(
    `SELECT * FROM analysis_object_edges WHERE ${where} ORDER BY created_at ASC, id ASC`,
    params
  );
  return rows;
}

async function lineageEdgeWouldCreateCycle(parentObjectId, childObjectId, projectScope) {
  if (parentObjectId === childObjectId) return true;
  const seen = new Set([String(childObjectId)]);
  let frontier = [String(childObjectId)];
  let visited = 0;
  while (frontier.length > 0) {
    const next = [];
    for (const node of frontier) {
      if (++visited > LINEAGE_MAX_NODES) return true;
      const children = await getLineageEdgesByParent(node, projectScope);
      for (const edge of children) {
        const child = edge.child_analysis_object_id;
        if (child === String(parentObjectId)) return true;
        if (!seen.has(child)) {
          seen.add(child);
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  return false;
}

async function createLineageEdge(actorUserId, input = {}) {
  const parentObjectId = typeof input.parentObjectId === 'string' ? input.parentObjectId : '';
  const childObjectId = typeof input.childObjectId === 'string' ? input.childObjectId : '';
  if (!AO_ID_RE.test(parentObjectId)) throw codedError('INVALID_PARENT_ID', 'Malformed parent analysis object ID.');
  if (!AO_ID_RE.test(childObjectId)) throw codedError('INVALID_CHILD_ID', 'Malformed child analysis object ID.');
  if (parentObjectId === childObjectId) throw codedError('SELF_PARENT', 'An analysis object cannot be its own parent.');
  const edgeType = input.edgeType === undefined || input.edgeType === null ? 'derived_from' : String(input.edgeType);
  if (!ALLOWED_EDGE_TYPES.has(edgeType)) {
    throw codedError('INVALID_EDGE_TYPE', `Invalid edgeType. Allowed: ${[...ALLOWED_EDGE_TYPES].join(', ')}.`);
  }
  const parentRole = input.parentRole === undefined || input.parentRole === null ? 'primary' : String(input.parentRole);
  if (!ALLOWED_PARENT_ROLES.has(parentRole)) {
    throw codedError('INVALID_PARENT_ROLE', `Invalid parentRole. Allowed: ${[...ALLOWED_PARENT_ROLES].join(', ')}.`);
  }
  const metadata = input.metadata === undefined ? {} : input.metadata;
  assertPlainObject(metadata, 'INVALID_METADATA', 'metadata must be a plain JSON object.');
  let jobId = null;
  if (input.jobId !== undefined && input.jobId !== null) {
    if (!JOB_ID_RE.test(String(input.jobId))) throw codedError('INVALID_JOB_ID', 'Malformed job ID.');
    jobId = String(input.jobId);
  }
  const { rows: objectRows } = await query(
    `SELECT id, project_id FROM analysis_objects WHERE id IN ($1, $2)`,
    [parentObjectId, childObjectId]
  );
  const byId = new Map(objectRows.map(r => [r.id, r]));
  const parent = byId.get(parentObjectId);
  const child = byId.get(childObjectId);
  if (!parent) throw codedError('PARENT_NOT_FOUND', 'Parent analysis object not found.');
  if (!child) throw codedError('CHILD_NOT_FOUND', 'Child analysis object not found.');
  const sameScope = parent.project_id === child.project_id ||
    (parent.project_id == null && child.project_id == null);
  if (!sameScope) throw codedError('CHILD_NOT_FOUND', 'Child analysis object not found.');
  const projectId = parent.project_id || null;
  if (jobId) {
    const { rows } = await query('SELECT id, project_id FROM jobs WHERE id = $1', [jobId]);
    const job = rows[0];
    const jobSameScope = job && (job.project_id === projectId || (job.project_id == null && projectId == null));
    if (!jobSameScope) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  }
  const scope = { projectId };
  if (await lineageEdgeWouldCreateCycle(parentObjectId, childObjectId, scope)) {
    throw codedError('CYCLE', 'This edge would create a cycle in the lineage graph.');
  }
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const id = await insertLineageEdgeRow(client, {
      projectId, parentObjectId, childObjectId, jobId, edgeType, parentRole,
      metadata, createdByUserId: actorUserId
    });
    await client.query('COMMIT');
    const { rows } = await query('SELECT * FROM analysis_object_edges WHERE id = $1', [id]);
    return rowToAnalysisObjectEdge(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err && err.code === '23505') throw codedError('DUPLICATE_EDGE', 'An identical lineage edge already exists.');
    throw err;
  } finally {
    client.release();
  }
}

async function listLineageParents(objectId, projectScope) {
  return (await getLineageEdgesByChild(objectId, projectScope)).map(rowToAnalysisObjectEdge);
}

async function listLineageChildren(objectId, projectScope) {
  return (await getLineageEdgesByParent(objectId, projectScope)).map(rowToAnalysisObjectEdge);
}

async function buildLineageGraph(objectId, projectScope, nodeFetcher) {
  const start = String(objectId);
  const edgeById = new Map();
  const nodeIds = new Set([start]);
  let truncated = false;
  async function walk(direction) {
    const seen = new Set([start]);
    let frontier = [start];
    let depth = 0;
    while (frontier.length > 0) {
      if (++depth > LINEAGE_MAX_DEPTH) { truncated = true; break; }
      const next = [];
      for (const node of frontier) {
        const edges = direction === 'down'
          ? await getLineageEdgesByParent(node, projectScope)
          : await getLineageEdgesByChild(node, projectScope);
        for (const edge of edges) {
          if (!edgeById.has(edge.id)) edgeById.set(edge.id, edge);
          const neighbor = direction === 'down'
            ? edge.child_analysis_object_id : edge.parent_analysis_object_id;
          if (nodeIds.size < LINEAGE_MAX_NODES) nodeIds.add(neighbor);
          else truncated = true;
          if (!seen.has(neighbor) && nodeIds.has(neighbor)) {
            seen.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }
  }
  await walk('down');
  await walk('up');
  const nodes = [];
  for (const id of [...nodeIds].sort()) {
    const node = await nodeFetcher(id);
    if (node) nodes.push(node);
  }
  const edges = [...edgeById.values()]
    .map(rowToAnalysisObjectEdge)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1
      : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  return { objectId: start, nodes, edges, truncated };
}

function lineageNodeForObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.display_name || null,
    objectType: row.object_type,
    lineageRootId: row.lineage_root_id
  };
}

async function listProjectAnalysisObjectParents(userId, projectId, objectId) {
  await requireProjectRole(userId, projectId, LINEAGE_READ_ROLES);
  const pid = String(projectId);
  if (!(await getProjectAnalysisObjectRow(objectId, pid))) {
    throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  return listLineageParents(objectId, { projectId: pid });
}

async function listProjectAnalysisObjectChildren(userId, projectId, objectId) {
  await requireProjectRole(userId, projectId, LINEAGE_READ_ROLES);
  const pid = String(projectId);
  if (!(await getProjectAnalysisObjectRow(objectId, pid))) {
    throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  return listLineageChildren(objectId, { projectId: pid });
}

async function getProjectAnalysisObjectLineage(userId, projectId, objectId) {
  await requireProjectRole(userId, projectId, LINEAGE_READ_ROLES);
  const pid = String(projectId);
  const root = await getProjectAnalysisObjectRow(objectId, pid);
  if (!root) throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  const graph = await buildLineageGraph(objectId, { projectId: pid }, async (id) => {
    const { rows } = await query(
      'SELECT id, display_name, object_type, lineage_root_id FROM analysis_objects WHERE id = $1 AND project_id = $2',
      [id, pid]
    );
    return lineageNodeForObject(rows[0]);
  });
  return { ...graph, projectId: pid, rootObjectId: root.lineageRootId || root.id };
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
  ALLOWED_JOB_TYPES,
  ALLOWED_DATASET_FILE_TYPES,
  ALLOWED_ARTIFACT_TYPES,
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
  verifyProjectMember,
  requireProjectRole,
  getProjectForUser,
  listProjectsForUser,
  listProjectMembers,
  // datasets
  createDatasetForProject,
  listDatasetsForProject,
  getDatasetForProject,
  verifyDatasetProjectAccess,
  rowToDataset,
  toPublicDataset,
  // analysis objects
  createAnalysisObject,
  getAnalysisObjectForUser,
  listAnalysisObjectsForUser,
  createProjectAnalysisObject,
  listProjectAnalysisObjects,
  getProjectAnalysisObject,
  rowToAnalysisObject,
  toPublicAnalysisObject,
  // jobs
  createJob,
  getJobForUser,
  listJobsForUser,
  createProjectJob,
  listProjectJobs,
  getProjectJob,
  transitionJobStatus,
  updateJobStatusForUser,
  appendJobLogForUser,
  rowToJob,
  toPublicJob,
  // artifacts
  createArtifact,
  createResultCheckpoint,
  getJobArtifactsByJobId,
  listProjectArtifacts,
  listProjectJobArtifacts,
  getProjectArtifact,
  rowToJobArtifact,
  toPublicJobArtifact,
  // lineage
  createLineageEdge,
  lineageEdgeWouldCreateCycle,
  listLineageParents,
  listLineageChildren,
  listProjectAnalysisObjectParents,
  listProjectAnalysisObjectChildren,
  getProjectAnalysisObjectLineage,
  rowToAnalysisObjectEdge
};
