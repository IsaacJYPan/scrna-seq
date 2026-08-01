/**
 * Postgres data layer for the app runtime.
 *
 * This module:
 *   - owns the async `pg` connection pool from backend/config.js,
 *   - applies backend/pg/schema.sql idempotently,
 *   - implements the durable metadata helpers used by Express and the worker.
 *
 * It preserves the app's security invariants:
 *   - identity is server-generated (org_/proj_/ds_/ao_/job_/art_ ids),
 *   - ownership/role/status/storage are server-set, never client-supplied,
 *   - the job state machine uses an explicit allow-list,
 *   - public projections strip claim_token / worker internals / storage_uri.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const storage = require('./storage');
const passwords = require('./passwords');
const {
  validateSeuratPipelineParams,
  assertSupportedSeuratPipelineDataset,
} = require('./seuratPipeline');
const { validateEnrichmentGseaParams } = require('./enrichmentGsea');
const {
  validateCellChatInferenceParams,
  MAX_CELLCHAT_RESULT_ROWS,
} = require('./cellChatInference');
const {
  DEFAULT_PIPELINE_ID,
  validatePipelineManifest,
  getDefaultPipelineManifest,
  isBuiltInPipelineId,
} = require('./pipelineManifests');

const SCHEMA_PATH = path.join(__dirname, 'pg', 'schema.sql');

let pool = null;

// The supported Branch 5 topology admits one live heavy job at a time. The
// session-scoped worker lock prevents two healthy standalone workers from
// starting together, while this distinct transaction-scoped gate fences the
// claim itself if that session lock is lost between a topology check and the
// database mutation.
const WORKER_CLAIM_GATE_LOCK = [0x5343524e, 501];
const WORKER_RUNTIME_STATES = new Set(['ready', 'draining', 'unavailable']);
const DEFAULT_WORKER_RUNTIME_STALE_AFTER_MS = 15000;

// ── Job state machine ───────────────────────────────────────────────────────
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
  // Analytical job types are creatable (queued) but have NO registered worker
  // handler in this branch, so the worker fails them terminally with
  // UNSUPPORTED_JOB_TYPE (see jobWorker.js DEFAULT_HANDLERS) rather than pretending
  // to run them. Dropping them from this set would reject the job at creation and
  // break the "created → worker-unsupported" contract the tests pin down.
  'normalize', 'qc_filter', 'pca', 'cluster', 'umap', 'find_markers', 'integrate',
  'generic',
  'checkpoint.noop',
  'r.runtime.check',
  'r.object.inspect',
  'pbmc.pipeline.v1',
  'seurat.pipeline.v1',
  'checkpoint.load.v1',
  'checkpoint.fork.v1',
  'deg.find_markers.v1',
  'enrichment.gsea.v1',
  'cellchat.infer.v1'
]);
const RETRYABLE_DURABLE_JOB_TYPES = new Set([
  'pbmc.pipeline.v1',
  'seurat.pipeline.v1',
  'checkpoint.load.v1',
  'checkpoint.fork.v1',
  'deg.find_markers.v1',
  'enrichment.gsea.v1',
  'cellchat.infer.v1',
]);

// An HTTP timeout does not prove the R operation stopped. Keep the original
// claim during a short bounded observation window, then grant exactly one
// recovery-only claim. These internal markers distinguish that lifecycle from
// an ordinary expired lease, which may otherwise rerun the handler.
const R_TIMEOUT_INDETERMINATE = 'R_TIMEOUT_INDETERMINATE';
const R_TIMEOUT_RECOVERY_PENDING = 'R_TIMEOUT_RECOVERY_PENDING';
const R_DISPATCH_STARTED = 'R_DISPATCH_STARTED';
const R_RETRY_RECOVERY_PENDING = 'R_RETRY_RECOVERY_PENDING';
const COMMITTED_OUTPUT_RECOVERY_PENDING = 'COMMITTED_OUTPUT_RECOVERY_PENDING';
const R_TIMEOUT_RECOVERY_MAX_GRACE_SECONDS = 300;
const RECOVERY_ONLY_PENDING_CODES = Object.freeze([
  R_TIMEOUT_RECOVERY_PENDING,
  R_RETRY_RECOVERY_PENDING,
  COMMITTED_OUTPUT_RECOVERY_PENDING,
]);

function maxAttemptsForJobType(jobType, projectId) {
  // Retry cleanup and output convergence are defined only for project-scoped
  // durable storage. Legacy projectless/vault jobs remain one-shot.
  return projectId && RETRYABLE_DURABLE_JOB_TYPES.has(jobType) ? 2 : 1;
}
const ALLOWED_DATASET_FILE_TYPES = new Set([
  'tenx_zip', 'tenx_h5', 'seurat_rds', 'h5seurat', 'h5ad',
  'count_matrix_csv', 'count_matrix_tsv', 'metadata_csv', 'metadata_tsv'
]);
const DATASET_UPLOAD_STATUSES = new Set(['pending', 'uploaded', 'failed']);
const DATASET_VALIDATION_STATUSES = new Set(['pending', 'valid', 'invalid', 'skipped']);
const ALLOWED_ARTIFACT_TYPES = new Set([
  'checkpoint', 'metrics', 'log', 'figure', 'script_fragment', 'other_metadata',
  'r_runtime_check', 'r_object_inspection', 'pipeline_summary', 'checkpoint_load',
  'checkpoint_fork', 'deg_markers', 'deg_summary', 'result_checkpoint',
  'enrichment_results', 'enrichment_summary',
  'cellchat_results', 'cellchat_summary'
]);
const ALLOWED_ARTIFACT_STORAGE_KINDS = new Set(['metadata_only', 'local_internal']);
const ALLOWED_ARTIFACT_STATUSES = new Set(['available', 'pending', 'error']);
const ALLOWED_EDGE_TYPES = new Set([
  'derived_from', 'checkpoint', 'checkpoint_fork', 'branch', 'integration_input',
  'comparison_input', 'manual_link'
]);
const ALLOWED_PARENT_ROLES = new Set([
  'primary', 'secondary', 'reference', 'query', 'control', 'case', 'input'
]);
const LINEAGE_MAX_NODES = 500;
const LINEAGE_MAX_DEPTH = 64;
const AO_ID_RE = /^ao_[0-9a-f]+$/;
const JOB_ID_RE = /^job_[0-9a-f]+$/;
const PIPELINE_ID_RE = /^pipe_[0-9a-f]+$/;
const WORKER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const DEFAULT_LEASE_SECONDS = 120;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const PIPELINE_DEFINITION_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const PIPELINE_SELECTION_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const PIPELINE_REGISTRY_PUBLISH_CAPABILITY = 'pipeline_registry.publish';
const PLATFORM_PIPELINE_VISIBILITY = 'platform';
const PLATFORM_PIPELINE_REGISTRY_LIMIT = 200;
const PROVENANCE_WRITE_ROLES = ['owner', 'admin', 'analyst'];
const PROVENANCE_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const FIGURE_WRITE_ROLES = ['owner', 'admin', 'analyst'];
const FIGURE_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const ALLOWED_ANALYSIS_SUMMARY_FIELDS = ['cells', 'features', 'density'];

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
  if (typeof value === 'object') return value;
  return JSON.parse(value);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function requireOwnerEmail(userEmail) {
  const normalized = normalizeEmail(userEmail);
  if (!normalized) {
    throw new Error('An owner email is required for this user-scoped operation.');
  }
  return normalized;
}

function normalizeName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTimestamp(value) {
  if (value instanceof Date) return value;
  // undefined / null / blank → default to "now" (lenient: an omitted clock).
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return new Date();
  }
  if (typeof value === 'string') {
    const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
    const d = new Date(normalized);
    if (!Number.isNaN(d.getTime())) return d;
  }
  // A caller supplied a concrete but unparseable timestamp — fail loudly rather than
  // silently substituting the wall clock (which would corrupt lease/heartbeat timing).
  throw codedError('INVALID_TIMESTAMP', 'Invalid timestamp.');
}

// Canonical wire format for every timestamp we hand back: 'YYYY-MM-DD HH:MM:SS' in
// UTC. Postgres returns TIMESTAMPTZ columns as JS Date objects; normalizing them here
// keeps the API contract identical to the original text-timestamp runtime (and round-
// trips the injected worker clock exactly). Returns null for null/empty columns.
function toCanonicalTs(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function normalizeWorkerNow(opts = {}) {
  return opts.now !== undefined ? normalizeTimestamp(opts.now) : new Date();
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
    throw codedError('INVALID_WORKER', 'A valid worker id is required.');
  }
  return workerId;
}

function requireClaimToken(token) {
  if (typeof token !== 'string' || token === '') {
    throw codedError('INVALID_CLAIM_TOKEN', 'A claim token is required.');
  }
  return token;
}

function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000);
}

function isValidObjectType(objectType) {
  return typeof objectType === 'string' && ALLOWED_OBJECT_TYPES.has(objectType);
}

function isValidJobType(jobType) {
  return typeof jobType === 'string' && ALLOWED_JOB_TYPES.has(jobType);
}

function isValidJobStatus(status) {
  return typeof status === 'string' && JOB_STATUSES.has(status);
}

function isValidRole(role) {
  return typeof role === 'string' && PROJECT_ROLES.has(role);
}

function isValidDatasetFileType(fileType) {
  return typeof fileType === 'string' && ALLOWED_DATASET_FILE_TYPES.has(fileType);
}

function isValidDatasetUploadStatus(status) {
  return typeof status === 'string' && DATASET_UPLOAD_STATUSES.has(status);
}

function isValidDatasetValidationStatus(status) {
  return typeof status === 'string' && DATASET_VALIDATION_STATUSES.has(status);
}

function isValidArtifactType(t) { return ALLOWED_ARTIFACT_TYPES.has(t); }
function isValidArtifactStorageKind(k) { return ALLOWED_ARTIFACT_STORAGE_KINDS.has(k); }
function isValidArtifactStatus(s) { return ALLOWED_ARTIFACT_STATUSES.has(s); }
function isValidEdgeType(t) { return ALLOWED_EDGE_TYPES.has(t); }
function isValidParentRole(r) { return ALLOWED_PARENT_ROLES.has(r); }

function generateAnalysisObjectId() { return genId('ao'); }
function generateJobId() { return genId('job'); }
function generateClaimToken() { return `wct_${crypto.randomBytes(18).toString('hex')}`; }
function generateOrganizationId() { return genId('org'); }
function generateProjectId() { return genId('proj'); }
function generateDatasetId() { return genId('ds'); }
function generatePipelineDefinitionId() { return genId('pipe'); }
function isValidPipelineDefinitionId(id) { return typeof id === 'string' && PIPELINE_ID_RE.test(id); }
function generateProvenanceId() { return genId('prov'); }
function generateFigureId() { return genId('fig'); }
function generateJobArtifactId() { return genId('art'); }
function generateAnalysisObjectEdgeId() { return genId('aoe'); }

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
  // Lazy require so importing this file does not attempt a database connection.
  const { Pool } = require('pg');
  pool = new Pool(config.postgresConfig());
  pool.on('error', (error) => {
    const code = error && typeof error.code === 'string'
      ? error.code.replace(/[^A-Z0-9_]/gi, '').slice(0, 64)
      : 'POOL_ERROR';
    console.error(`[DB] idle pool connection failed (${code || 'POOL_ERROR'}).`);
  });
  return pool;
}

async function query(text, params = []) {
  const p = await connect();
  return p.query(text, params);
}

async function initSchema() {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    // Express and the standalone worker may start together on a fresh database.
    // PostgreSQL's IF NOT EXISTS DDL is not catalog-race-safe across sessions, so
    // serialize the idempotent schema bootstrap with one transaction-scoped lock.
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [0x5343524e, 5]);
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function checkHealth(options = {}) {
  const timeoutMs = Number.isInteger(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : 1000;
  await query({ text: 'SELECT 1', query_timeout: timeoutMs });
  return true;
}

async function reportStandaloneWorkerRuntimeState(state) {
  const normalized = typeof state === 'string' ? state.trim().toLowerCase() : '';
  if (!WORKER_RUNTIME_STATES.has(normalized)) {
    throw codedError('INVALID_WORKER_RUNTIME_STATE', 'Worker runtime state is invalid.');
  }
  const { rows } = await query(
    `INSERT INTO worker_runtime_status (singleton, state, updated_at)
     VALUES (TRUE, $1, now())
     ON CONFLICT (singleton) DO UPDATE SET state = EXCLUDED.state, updated_at = now()
     RETURNING state, updated_at`,
    [normalized]
  );
  return {
    state: rows[0]?.state || normalized,
    updatedAt: toCanonicalTs(rows[0]?.updated_at),
  };
}

async function getStandaloneWorkerRuntimeStatus(options = {}) {
  const staleAfterMs = Number.isInteger(Number(options.staleAfterMs)) && Number(options.staleAfterMs) > 0
    ? Number(options.staleAfterMs)
    : DEFAULT_WORKER_RUNTIME_STALE_AFTER_MS;
  const now = options.now === undefined ? new Date() : normalizeTimestamp(options.now);
  const { rows } = await query(
    'SELECT state, updated_at FROM worker_runtime_status WHERE singleton = TRUE LIMIT 1'
  );
  const row = rows[0];
  if (!row) return { status: 'unknown', updatedAt: null };
  const updatedAt = row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at);
  const fresh = !Number.isNaN(updatedAt.getTime()) && now.getTime() - updatedAt.getTime() <= staleAfterMs;
  return {
    status: fresh && row.state === 'ready' ? 'ready' : 'unavailable',
    updatedAt: toCanonicalTs(row.updated_at),
  };
}

async function acquireWebTopologyLock() {
  const p = await connect();
  const client = await p.connect();
  let released = false;
  let lost = false;
  const onClientError = () => { lost = true; };
  client.on('error', onClientError);
  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [0x5343524e, 700]
    );
    if (!result.rows[0] || result.rows[0].acquired !== true) {
      throw codedError(
        'WEB_TOPOLOGY_LOCKED',
        'Another web process already owns the supported single-web topology.'
      );
    }
  } catch (error) {
    client.off('error', onClientError);
    client.release();
    throw error;
  }
  return Object.freeze({
    isHeld() {
      return !released && !lost;
    },
    async check() {
      if (released || lost) {
        throw codedError('WEB_TOPOLOGY_LOCK_LOST', 'The web topology lock was lost.');
      }
      try {
        await client.query({ text: 'SELECT 1', query_timeout: 1000 });
      } catch {
        // A bounded probe timeout is not evidence that the reserved session or
        // advisory lock disappeared. The client's error event marks confirmed
        // connection loss; other failures are transient and the watchdog
        // requires consecutive failures before taking the process down.
        if (lost || released) {
          throw codedError('WEB_TOPOLOGY_LOCK_LOST', 'The web topology lock was lost.');
        }
        throw codedError('WEB_TOPOLOGY_LOCK_CHECK_FAILED', 'The web topology lock could not be verified.');
      }
      return true;
    },
    async release() {
      if (released) return;
      released = true;
      try {
        if (!lost) await client.query('SELECT pg_advisory_unlock($1, $2)', [0x5343524e, 700]);
      } finally {
        client.off('error', onClientError);
        client.release();
      }
    },
  });
}

async function acquireStandaloneWorkerLock() {
  const p = await connect();
  const client = await p.connect();
  let released = false;
  let lost = false;
  const onClientError = () => { lost = true; };
  client.on('error', onClientError);
  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [0x5343524e, 500]
    );
    if (!result.rows[0] || result.rows[0].acquired !== true) {
      throw codedError(
        'WORKER_TOPOLOGY_LOCKED',
        'Another standalone worker already owns the supported single-worker topology.'
      );
    }
    const active = await client.query(
      "SELECT 1 FROM jobs WHERE status = 'running' AND lease_expires_at > now() LIMIT 1"
    );
    if (active.rows[0]) {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [0x5343524e, 500]);
      throw codedError(
        'WORKER_ACTIVE_CLAIM_EXISTS',
        'A prior standalone worker still has an active claim; wait for drain or lease expiry.'
      );
    }
  } catch (error) {
    client.off('error', onClientError);
    client.release();
    throw error;
  }
  return Object.freeze({
    async check() {
      if (released || lost) {
        throw codedError('WORKER_TOPOLOGY_LOCK_LOST', 'The standalone worker topology lock was lost.');
      }
      try {
        await client.query('SELECT 1');
      } catch {
        lost = true;
        throw codedError('WORKER_TOPOLOGY_LOCK_LOST', 'The standalone worker topology lock was lost.');
      }
      return true;
    },
    async release() {
      if (released) return;
      released = true;
      try {
        if (!lost) await client.query('SELECT pg_advisory_unlock($1, $2)', [0x5343524e, 500]);
      } finally {
        client.off('error', onClientError);
        client.release();
      }
    },
  });
}

// TEST-ONLY: drop the app tables so a contract run starts from a clean schema.
// Guarded so it can never run against a production database.
async function resetSchemaForTests() {
  if (config.isProduction()) {
    throw new Error('resetSchemaForTests must not run in production.');
  }
  await query(`
    DROP TABLE IF EXISTS
      project_pipeline_selections, pipeline_definitions,
      analysis_object_edges, job_artifacts, jobs, analysis_objects,
      datasets, project_members, projects, organization_members,
      organizations, figure_collection, results_cache, provenance,
      worker_runtime_status, platform_capabilities, operator_audit_events, users
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
async function saveProvenance(envelope) {
  const prov = envelope.provenance || {};
  const owner = requireOwnerEmail(envelope.userEmail || prov.userEmail);
  if (typeof prov.id !== 'string' || prov.id.length < 1 || prov.id.length > 200 || prov.id.includes('\0')) {
    throw codedError('INVALID_PROVENANCE', 'Provenance id must contain 1-200 safe characters.');
  }
  const id = prov.id;
  const existing = await query('SELECT user_email FROM provenance WHERE id = $1', [id]);
  if (existing.rows[0] && normalizeEmail(existing.rows[0].user_email) !== owner) {
    throw codedError('PROVENANCE_NOT_FOUND', 'Provenance record not found.');
  }
  const saved = await query(
    `INSERT INTO provenance
       (id, user_email, timestamp, language, language_version, packages, script,
        parameters, parent_ids, operation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET
       user_email = EXCLUDED.user_email,
       timestamp = EXCLUDED.timestamp,
       language = EXCLUDED.language,
       language_version = EXCLUDED.language_version,
       packages = EXCLUDED.packages,
       script = EXCLUDED.script,
       parameters = EXCLUDED.parameters,
       parent_ids = EXCLUDED.parent_ids,
       operation = EXCLUDED.operation
     WHERE provenance.user_email = EXCLUDED.user_email
     RETURNING id`,
    [
      id,
      owner,
      String(prov.timestamp || ''),
      String(prov.language || ''),
      String(prov.languageVersion || ''),
      JSON.stringify(prov.packages || []),
      String(prov.script || ''),
      JSON.stringify(prov.parameters || {}),
      JSON.stringify(prov.parentIds || []),
      String(prov.operation || 'unknown')
    ]
  );
  if (saved.rowCount === 0) {
    throw codedError('PROVENANCE_NOT_FOUND', 'Provenance record not found.');
  }
  return id;
}

function rowToProvenance(row) {
  if (!row) return null;
  return {
    id: row.id,
    userEmail: row.user_email,
    timestamp: row.timestamp,
    language: row.language,
    languageVersion: row.language_version,
    packages: parseJson(row.packages, []),
    script: row.script,
    parameters: parseJson(row.parameters, {}),
    parentIds: parseJson(row.parent_ids, []),
    operation: row.operation || 'unknown'
  };
}

async function getProvenance(id, userEmail) {
  const owner = requireOwnerEmail(userEmail);
  const { rows } = await query('SELECT * FROM provenance WHERE id = $1 AND user_email = $2', [String(id), owner]);
  return rowToProvenance(rows[0]);
}

async function getAllProvenance(userEmail) {
  const owner = requireOwnerEmail(userEmail);
  const { rows } = await query('SELECT * FROM provenance WHERE user_email = $1 ORDER BY created_at DESC', [owner]);
  return rows.map(rowToProvenance);
}

async function getProvenanceChain(id, userEmail) {
  requireOwnerEmail(userEmail);
  const visited = new Set();
  const ordered = [];
  async function walk(currentId) {
    if (visited.has(currentId)) return;
    visited.add(currentId);
    const prov = await getProvenance(currentId, userEmail);
    if (!prov) return;
    for (const parentId of prov.parentIds) await walk(parentId);
    ordered.push(prov);
  }
  await walk(id);
  return ordered;
}

async function deleteProvenance(id, userEmail) {
  const owner = requireOwnerEmail(userEmail);
  await query('DELETE FROM results_cache WHERE provenance_id = $1 AND user_email = $2', [String(id), owner]);
  const res = await query('DELETE FROM provenance WHERE id = $1 AND user_email = $2', [String(id), owner]);
  return res.rowCount > 0;
}

function makeCacheKey(operation, params, dataVersion, parentIds = [], userEmail = '') {
  const payload = JSON.stringify({ operation, params, dataVersion, parentIds, userEmail: normalizeEmail(userEmail) });
  return crypto.createHash('sha256').update(payload).digest('hex').substring(0, 16);
}

async function getCachedResult(cacheKey, userEmail) {
  const owner = requireOwnerEmail(userEmail);
  const { rows } = await query(
    'SELECT * FROM results_cache WHERE cache_key = $1 AND user_email = $2',
    [String(cacheKey), owner]
  );
  if (!rows[0]) return null;
  return {
    cacheKey: rows[0].cache_key,
    provenanceId: rows[0].provenance_id,
    result: parseJson(rows[0].result_data, null)
  };
}

async function setCachedResult(cacheKey, provenanceId, resultData, userEmail) {
  const owner = requireOwnerEmail(userEmail);
  const prov = await query('SELECT id FROM provenance WHERE id = $1 AND user_email = $2', [String(provenanceId), owner]);
  if (!prov.rows[0]) throw new Error('Cannot cache result for provenance owned by another user.');
  const saved = await query(
    `INSERT INTO results_cache (cache_key, user_email, provenance_id, result_data)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (cache_key) DO UPDATE SET
       user_email = EXCLUDED.user_email,
       provenance_id = EXCLUDED.provenance_id,
       result_data = EXCLUDED.result_data,
       created_at = now()
     WHERE results_cache.user_email = EXCLUDED.user_email
     RETURNING cache_key`,
    [String(cacheKey), owner, String(provenanceId), JSON.stringify(resultData)]
  );
  if (saved.rowCount === 0) {
    throw codedError('CACHE_NOT_FOUND', 'Cache record not found.');
  }
}

async function clearCache(userEmail) {
  const owner = requireOwnerEmail(userEmail);
  await query('DELETE FROM results_cache WHERE user_email = $1', [owner]);
}

function assertSafeFigureFilePath(filePath) {
  if (filePath === undefined || filePath === null || filePath === '') return '';
  if (typeof filePath !== 'string') throw new Error('Figure file path must be a string.');
  if (filePath.includes('\0')) throw new Error('Figure file path is invalid.');
  if (filePath.split(/[\\/]+/).includes('..')) throw new Error('Figure file path must not contain path traversal segments.');
  return filePath;
}

async function saveFigure(record) {
  const userEmail = requireOwnerEmail(record.userEmail);
  const safeFilePath = assertSafeFigureFilePath(record.filePath);
  const existing = await query('SELECT user_email FROM figure_collection WHERE id = $1', [String(record.id)]);
  if (existing.rows[0] && normalizeEmail(existing.rows[0].user_email) !== userEmail) {
    throw codedError('FIGURE_NOT_FOUND', 'Cannot replace a figure owned by another user.');
  }
  const saved = await query(
    `INSERT INTO figure_collection
       (id, user_email, object_id, plot_type, title, params_json, file_path,
        file_format, thumbnail_b64)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       user_email = EXCLUDED.user_email,
       object_id = EXCLUDED.object_id,
       plot_type = EXCLUDED.plot_type,
       title = EXCLUDED.title,
       params_json = EXCLUDED.params_json,
       file_path = EXCLUDED.file_path,
       file_format = EXCLUDED.file_format,
       thumbnail_b64 = EXCLUDED.thumbnail_b64
     WHERE figure_collection.user_email = EXCLUDED.user_email
     RETURNING id`,
    [
      String(record.id),
      userEmail,
      record.objectId || '',
      record.plotType || 'Unknown',
      record.title || '',
      JSON.stringify(record.params || {}),
      safeFilePath || '',
      record.fileFormat || 'png',
      record.thumbnailB64 || ''
    ]
  );
  if (saved.rowCount === 0) {
    throw codedError('FIGURE_NOT_FOUND', 'Cannot replace a figure owned by another user.');
  }
  return record.id;
}

async function getFiguresByUser(email) {
  const owner = requireOwnerEmail(email);
  const { rows } = await query(
    'SELECT * FROM figure_collection WHERE user_email = $1 ORDER BY created_at DESC',
    [owner]
  );
  return rows.map(r => ({
    id: r.id,
    userEmail: r.user_email,
    objectId: r.object_id,
    plotType: r.plot_type,
    title: r.title,
    params: parseJson(r.params_json, {}),
    // Legacy gallery compatibility keeps the display basename but never sends
    // an internal absolute/relative storage path to the browser.
    // Records can survive a restore from either POSIX or Windows hosts. Split
    // both separator styles so platform mismatch cannot expose a stored path.
    filePath: r.file_path ? String(r.file_path).split(/[\\/]+/).pop() : '',
    fileFormat: r.file_format,
    thumbnailB64: r.thumbnail_b64,
    createdAt: r.created_at
  }));
}

async function deleteFigure(id, userEmail) {
  const owner = requireOwnerEmail(userEmail);
  const res = await query('DELETE FROM figure_collection WHERE id = $1 AND user_email = $2', [String(id), owner]);
  return res.rowCount > 0;
}

async function createUser(email, password, displayName) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const salt = passwords.newSalt();
  const passwordHash = await passwords.hashPassword(password, salt);
  try {
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, salt, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, display_name, session_version, created_at`,
      [normalizedEmail, passwordHash, salt, String(displayName || '').trim()]
    );
    const u = rows[0];
    // node-postgres returns BIGINT as a string to avoid precision loss; user ids
    // are small and the app treats them as numbers.
    return {
      id: Number(u.id),
      email: u.email,
      displayName: u.display_name,
      sessionVersion: String(u.session_version),
      createdAt: u.created_at,
    };
  } catch (err) {
    if (err && err.code === '23505') {
      return { error: 'An account with this email already exists.' };
    }
    throw err;
  }
}

async function provisionUserByOperator(email, password, displayName) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const salt = passwords.newSalt();
  const passwordHash = await passwords.hashPassword(password, salt);
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, salt, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, display_name, session_version, created_at`,
      [normalizedEmail, passwordHash, salt, String(displayName || '').trim()]
    );
    const user = rows[0];
    const audit = await client.query(
      `INSERT INTO operator_audit_events
         (event_type, target_user_id, target_email, metadata_json)
       VALUES ('account.provisioned', $1, $2, $3)
       RETURNING id, created_at`,
      [user.id, user.email, JSON.stringify({ source: 'operator_cli' })]
    );
    await client.query('COMMIT');
    return {
      id: Number(user.id),
      email: user.email,
      displayName: user.display_name,
      sessionVersion: String(user.session_version),
      createdAt: user.created_at,
      auditEventId: String(audit.rows[0].id),
      auditCreatedAt: audit.rows[0].created_at,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      return { error: 'An account with this email already exists.' };
    }
    throw error;
  } finally {
    client.release();
  }
}

async function resetUserPasswordByOperator(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const salt = passwords.newSalt();
  const passwordHash = await passwords.hashPassword(password, salt);
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE users
          SET password_hash = $2,
              salt = $3,
              session_version = session_version + 1
        WHERE email = $1
        RETURNING id, email, display_name, session_version, created_at`,
      [normalizedEmail, passwordHash, salt]
    );
    if (!rows[0]) {
      throw codedError('USER_NOT_FOUND', 'No account exists for that email.');
    }
    const user = rows[0];
    const audit = await client.query(
      `INSERT INTO operator_audit_events
         (event_type, target_user_id, target_email, metadata_json)
       VALUES ('account.password_reset', $1, $2, $3)
       RETURNING id, created_at`,
      [user.id, user.email, JSON.stringify({ source: 'operator_cli', sessionsRevoked: true })]
    );
    await client.query('COMMIT');
    return {
      id: Number(user.id),
      email: user.email,
      displayName: user.display_name,
      sessionVersion: String(user.session_version),
      createdAt: user.created_at,
      auditEventId: String(audit.rows[0].id),
      auditCreatedAt: audit.rows[0].created_at,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
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
  const ok = await passwords.verifyPassword(password, user ? user.password_hash : null);
  if (!user || !ok) return { error: passwords.GENERIC_CREDENTIAL_ERROR };
  return {
    id: Number(user.id),
    email: user.email,
    displayName: user.display_name,
    sessionVersion: String(user.session_version),
    createdAt: user.created_at,
  };
}

const MAX_POSTGRES_BIGINT = 9223372036854775807n;

function isCanonicalPositiveIntegerString(value, maximum) {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]{0,18}$/.test(text)) return false;
  try { return BigInt(text) <= maximum; } catch { return false; }
}

function isSafeUserId(value) {
  return isCanonicalPositiveIntegerString(value, BigInt(Number.MAX_SAFE_INTEGER));
}

function isSessionVersion(value) {
  return isCanonicalPositiveIntegerString(value, MAX_POSTGRES_BIGINT);
}

async function getUserForSession(userId, sessionVersion) {
  const uid = Number(userId);
  const version = String(sessionVersion || '');
  if (!isSafeUserId(userId) || !Number.isSafeInteger(uid) || !isSessionVersion(version)) return null;
  const { rows } = await query(
    `SELECT id, email, display_name, created_at
       FROM users
      WHERE id = $1 AND session_version = $2`,
    [uid, version]
  );
  if (!rows[0]) return null;
  return {
    id: Number(rows[0].id),
    email: rows[0].email,
    displayName: rows[0].display_name,
    createdAt: rows[0].created_at,
  };
}

async function getUserSessionVersion(userId) {
  const uid = Number(userId);
  if (!isSafeUserId(userId) || !Number.isSafeInteger(uid)) return null;
  const { rows } = await query('SELECT session_version FROM users WHERE id = $1', [uid]);
  return rows[0] ? String(rows[0].session_version) : null;
}

async function revokeUserSessions(userId, expectedVersion) {
  const uid = Number(userId);
  const version = String(expectedVersion || '');
  if (!isSafeUserId(userId) || !Number.isSafeInteger(uid) || !isSessionVersion(version)) {
    throw codedError('INVALID_SESSION', 'A valid session generation is required.');
  }
  const { rows } = await query(
    `UPDATE users
        SET session_version = session_version + 1
      WHERE id = $1 AND session_version = $2
        AND session_version < 9223372036854775807
      RETURNING session_version`,
    [uid, version]
  );
  if (rows[0]) return String(rows[0].session_version);
  const current = await getUserSessionVersion(uid);
  if (current === version) {
    throw codedError('SESSION_VERSION_EXHAUSTED', 'The session generation cannot be revoked safely.');
  }
  // A concurrent logout already advanced the generation, or the user was
  // deleted. In both cases this exact credential is no longer usable.
  return null;
}

// ── Organizations / projects / membership ───────────────────────────────────
async function hasPipelineRegistryPublishCapability(userId) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) return false;
  const { rows } = await query(
    `SELECT 1 FROM platform_capabilities
      WHERE user_id = $1 AND capability = $2`,
    [uid, PIPELINE_REGISTRY_PUBLISH_CAPABILITY]
  );
  return Boolean(rows[0]);
}

async function getPipelineRegistryCapabilities(userId) {
  return {
    canPublishPipelineManifests: await hasPipelineRegistryPublishCapability(userId),
  };
}

async function setPipelineRegistryPublisherByEmail(email, enabled) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) throw codedError('INVALID_USER', 'A user email is required.');
  if (typeof enabled !== 'boolean') throw codedError('INVALID_CAPABILITY', 'Capability state must be boolean.');
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, email FROM users WHERE email = $1 FOR UPDATE',
      [normalizedEmail]
    );
    if (!rows[0]) throw codedError('USER_NOT_FOUND', 'User not found.');
    const userId = Number(rows[0].id);
    if (enabled) {
      await client.query(
        `INSERT INTO platform_capabilities (user_id, capability)
         VALUES ($1, $2)
         ON CONFLICT (user_id, capability) DO NOTHING`,
        [userId, PIPELINE_REGISTRY_PUBLISH_CAPABILITY]
      );
    } else {
      await client.query(
        'DELETE FROM platform_capabilities WHERE user_id = $1 AND capability = $2',
        [userId, PIPELINE_REGISTRY_PUBLISH_CAPABILITY]
      );
    }
    const audit = await client.query(
      `INSERT INTO operator_audit_events
         (event_type, target_user_id, target_email, metadata_json)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        enabled ? 'platform_capability_granted' : 'platform_capability_revoked',
        userId,
        rows[0].email,
        JSON.stringify({ capability: PIPELINE_REGISTRY_PUBLISH_CAPABILITY }),
      ]
    );
    await client.query('COMMIT');
    return {
      userId,
      email: rows[0].email,
      canPublishPipelineManifests: enabled,
      auditEventId: String(audit.rows[0].id),
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* original error wins */ }
    throw error;
  } finally {
    client.release();
  }
}

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

async function createOrganizationForUser(ownerUserId, input = {}) {
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
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO organizations (id, name, owner_user_id) VALUES ($1, $2, $3)', [id, name, owner]);
    await client.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [id, owner]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getOrganizationForUser(id, owner);
}

async function getOrganizationForUser(organizationId, userId) {
  if (typeof organizationId !== 'string' || organizationId === '') return null;
  const { rows } = await query(
    `SELECT o.id, o.name, o.owner_user_id, o.created_at, o.updated_at, m.role AS role
       FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id
      WHERE o.id = $1 AND m.user_id = $2`,
    [organizationId, Number(userId)]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    ownerUserId: Number(row.owner_user_id),
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function listOrganizationsForUser(userId) {
  const { rows } = await query(
    `SELECT o.id, o.name, o.owner_user_id, o.created_at, o.updated_at, m.role AS role
       FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id
      WHERE m.user_id = $1
      ORDER BY o.created_at DESC, o.id DESC`,
    [Number(userId)]
  );
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    ownerUserId: Number(row.owner_user_id),
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

async function verifyOrganizationMember(userId, organizationId) {
  if (typeof organizationId !== 'string' || organizationId === '') return null;
  const { rows } = await query(
    'SELECT organization_id, user_id, role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
    [organizationId, Number(userId)]
  );
  if (!rows[0]) return null;
  return { organizationId: rows[0].organization_id, userId: Number(rows[0].user_id), role: rows[0].role };
}

async function requireOrganizationRole(userId, organizationId, allowedRoles) {
  const membership = await verifyOrganizationMember(userId, organizationId);
  if (!membership) throw codedError('NOT_FOUND', 'Organization not found.');
  const allowed = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  if (!allowed.includes(membership.role)) {
    throw codedError('FORBIDDEN', 'You do not have permission to perform this action.');
  }
  return membership;
}

async function addOrganizationMember(organizationId, userId, role) {
  if (!isValidRole(role)) throw codedError('INVALID_ROLE', 'Invalid role.');
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) throw codedError('INVALID_OWNER', 'A valid user id is required.');
  if (await verifyOrganizationMember(uid, organizationId)) {
    throw codedError('ALREADY_MEMBER', 'User is already a member of this organization.');
  }
  await query(
    'INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)',
    [String(organizationId), uid, role]
  );
  return { organizationId: String(organizationId), userId: uid, role };
}

async function createProjectForUser(userId, input = {}) {
  const creator = Number(userId);
  if (!Number.isInteger(creator) || creator <= 0) throw codedError('INVALID_OWNER', 'A valid authenticated user is required.');
  const organizationId = typeof input.organizationId === 'string' ? input.organizationId : '';
  if (!organizationId) throw codedError('INVALID_ORG', 'organizationId is required.');
  await requireOrganizationRole(creator, organizationId, ['owner', 'admin']);
  const name = normalizeName(input.name);
  if (!name) throw codedError('INVALID_NAME', 'Project name is required.');
  if (name.length > MAX_NAME_LENGTH) throw codedError('INVALID_NAME', `Project name must be at most ${MAX_NAME_LENGTH} characters.`);
  const description = input.description == null ? '' : String(input.description);
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw codedError('INVALID_DESCRIPTION', `Project description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`);
  }
  const id = generateProjectId();
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO projects (id, organization_id, name, description, created_by_user_id) VALUES ($1, $2, $3, $4, $5)',
      [id, organizationId, name, description, creator]
    );
    await client.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [id, creator]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getProjectForUser(id, creator);
}

async function updateProject(projectId, input = {}) {
  const sets = [];
  const params = [];
  if (input.name !== undefined) {
    const name = normalizeName(input.name);
    if (!name) throw codedError('INVALID_NAME', 'Project name is required.');
    if (name.length > MAX_NAME_LENGTH) throw codedError('INVALID_NAME', `Project name must be at most ${MAX_NAME_LENGTH} characters.`);
    params.push(name); sets.push(`name = $${params.length}`);
  }
  if (input.description !== undefined) {
    const description = input.description == null ? '' : String(input.description);
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw codedError('INVALID_DESCRIPTION', `Project description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`);
    }
    params.push(description); sets.push(`description = $${params.length}`);
  }
  if (sets.length === 0) throw codedError('NO_FIELDS', 'No updatable fields provided.');
  params.push(String(projectId));
  await query(`UPDATE projects SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
}

async function getProjectMember(projectId, userId) {
  const { rows } = await query(
    'SELECT project_id, user_id, role FROM project_members WHERE project_id = $1 AND user_id = $2',
    [String(projectId), Number(userId)]
  );
  if (!rows[0]) return null;
  return { projectId: rows[0].project_id, userId: Number(rows[0].user_id), role: rows[0].role };
}

async function countProjectOwners(projectId) {
  const { rows } = await query(
    "SELECT COUNT(*)::int AS n FROM project_members WHERE project_id = $1 AND role = 'owner'",
    [String(projectId)]
  );
  return Number(rows[0]?.n || 0);
}

async function lockProjectAndResolveMemberActor(client, projectId, actor) {
  const pid = String(projectId);
  const project = await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [pid]);
  if (!project.rows[0]) throw codedError('NOT_FOUND', 'Project not found.');

  if (actor && typeof actor === 'object') {
    const actorUserId = Number(actor.userId);
    if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
      throw codedError('NOT_FOUND', 'Project not found.');
    }
    const membership = await client.query(
      'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [pid, actorUserId]
    );
    if (!membership.rows[0]) throw codedError('NOT_FOUND', 'Project not found.');
    if (!['owner', 'admin'].includes(membership.rows[0].role)) {
      throw codedError('FORBIDDEN', 'You do not have permission to perform this action.');
    }
    return membership.rows[0].role;
  }

  // Compatibility for trusted helper callers/tests. HTTP routes always pass the
  // authenticated user id above so the acting role is re-read under the lock.
  if (!['owner', 'admin'].includes(actor)) {
    throw codedError('FORBIDDEN', 'You do not have permission to perform this action.');
  }
  return actor;
}

async function addProjectMemberByEmail(projectId, email, role, actor) {
  if (!isValidRole(role)) throw codedError('INVALID_ROLE', 'Invalid role.');
  if (typeof email !== 'string' || !email.trim()) throw codedError('INVALID_EMAIL', 'A member email is required.');
  const pid = String(projectId);
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const actorRole = await lockProjectAndResolveMemberActor(client, pid, actor);
    if (role === 'owner' && actorRole !== 'owner') {
      throw codedError('FORBIDDEN', 'Only an owner can grant the owner role.');
    }
    const found = await client.query(
      'SELECT id, email, display_name FROM users WHERE email = $1',
      [String(email).trim().toLowerCase()]
    );
    const user = found.rows[0];
    if (!user) throw codedError('USER_NOT_FOUND', 'No user found with that email.');
    const existing = await client.query(
      'SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2',
      [pid, Number(user.id)]
    );
    if (existing.rows[0]) throw codedError('ALREADY_MEMBER', 'User is already a member of this project.');
    await client.query(
      'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
      [pid, Number(user.id), role]
    );
    await client.query('COMMIT');
    return {
      userId: Number(user.id),
      email: user.email,
      displayName: user.display_name,
      role,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updateProjectMemberRole(projectId, targetUserId, role, actor) {
  if (!isValidRole(role)) throw codedError('INVALID_ROLE', 'Invalid role.');
  const pid = String(projectId);
  const target = Number(targetUserId);
  if (!Number.isInteger(target) || target <= 0) {
    throw codedError('INVALID_OWNER', 'A valid member user id is required.');
  }
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const actorRole = await lockProjectAndResolveMemberActor(client, pid, actor);
    const found = await client.query(
      'SELECT project_id, user_id, role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [pid, target]
    );
    const member = found.rows[0];
    if (!member) throw codedError('MEMBER_NOT_FOUND', 'Project member not found.');
    if (role === 'owner' && member.role !== 'owner' && actorRole !== 'owner') {
      throw codedError('FORBIDDEN', 'Only an owner can grant the owner role.');
    }
    if (member.role === 'owner' && role !== 'owner' && actorRole !== 'owner') {
      throw codedError('FORBIDDEN', 'Only an owner can demote an owner.');
    }
    if (member.role === 'owner' && role !== 'owner') {
      const owners = await client.query(
        "SELECT COUNT(*)::int AS n FROM project_members WHERE project_id = $1 AND role = 'owner'",
        [pid]
      );
      if (Number(owners.rows[0]?.n || 0) <= 1) {
        throw codedError('LAST_OWNER', 'Cannot demote the last owner of the project.');
      }
    }
    const updated = await client.query(
      'UPDATE project_members SET role = $1, updated_at = now() WHERE project_id = $2 AND user_id = $3 RETURNING project_id, user_id, role',
      [role, pid, target]
    );
    await client.query('COMMIT');
    return {
      projectId: updated.rows[0].project_id,
      userId: Number(updated.rows[0].user_id),
      role: updated.rows[0].role,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function removeProjectMember(projectId, targetUserId, actor) {
  const pid = String(projectId);
  const target = Number(targetUserId);
  if (!Number.isInteger(target) || target <= 0) {
    throw codedError('INVALID_OWNER', 'A valid member user id is required.');
  }
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const actorRole = await lockProjectAndResolveMemberActor(client, pid, actor);
    const found = await client.query(
      'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [pid, target]
    );
    const member = found.rows[0];
    if (!member) throw codedError('MEMBER_NOT_FOUND', 'Project member not found.');
    if (member.role === 'owner' && actorRole !== 'owner') {
      throw codedError('FORBIDDEN', 'Only an owner can remove an owner.');
    }
    if (member.role === 'owner') {
      const owners = await client.query(
        "SELECT COUNT(*)::int AS n FROM project_members WHERE project_id = $1 AND role = 'owner'",
        [pid]
      );
      if (Number(owners.rows[0]?.n || 0) <= 1) {
        throw codedError('LAST_OWNER', 'Cannot remove the last owner of the project.');
      }
    }
    await client.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [pid, target]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function validatedPlatformPipelineDefinition(row) {
  if (!row || !isValidPipelineDefinitionId(row.id)
      || row.project_id !== null || row.visibility !== PLATFORM_PIPELINE_VISIBILITY
      || typeof row.manifest_id !== 'string' || row.manifest_id === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(row.manifest_json);
  } catch {
    return null;
  }
  let manifest;
  try {
    manifest = validatePipelineManifest(parsed);
  } catch {
    return null;
  }
  if (manifest.id !== row.manifest_id || manifest.name !== row.name) return null;
  return {
    id: row.id,
    projectId: null,
    ownerUserId: Number(row.owner_user_id),
    visibility: PLATFORM_PIPELINE_VISIBILITY,
    manifestId: row.manifest_id,
    name: row.name,
    manifest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicPipelineDefinition(definition) {
  if (!definition) return null;
  return {
    id: definition.id,
    projectId: definition.projectId,
    visibility: definition.visibility,
    manifestId: definition.manifestId,
    name: definition.name,
    manifest: definition.manifest,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  };
}

function defaultPipelineDefinitionPublic(projectId) {
  return {
    id: DEFAULT_PIPELINE_ID,
    manifestId: DEFAULT_PIPELINE_ID,
    projectId: projectId || null,
    visibility: 'builtin',
    name: 'Default Seurat scRNA-seq Pipeline',
    manifest: getDefaultPipelineManifest(),
    builtin: true,
  };
}

async function getAccessiblePipelineDefinition(pipelineId) {
  if (isBuiltInPipelineId(pipelineId)) return { builtin: true };
  if (!isValidPipelineDefinitionId(pipelineId)) return null;
  const { rows } = await query(
    `SELECT * FROM pipeline_definitions
      WHERE id = $1
        AND project_id IS NULL
        AND visibility = $2
        AND manifest_id IS NOT NULL`,
    [String(pipelineId), PLATFORM_PIPELINE_VISIBILITY]
  );
  return validatedPlatformPipelineDefinition(rows[0]);
}

async function listProjectPipelineDefinitions(userId, projectId) {
  await requireProjectRole(userId, projectId, PIPELINE_DEFINITION_READ_ROLES);
  const { rows } = await query(
    `SELECT * FROM pipeline_definitions
      WHERE project_id IS NULL
        AND visibility = $1
        AND manifest_id IS NOT NULL
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [PLATFORM_PIPELINE_VISIBILITY, PLATFORM_PIPELINE_REGISTRY_LIMIT]
  );
  const trusted = rows.map(validatedPlatformPipelineDefinition).filter(Boolean);
  return [
    defaultPipelineDefinitionPublic(projectId),
    ...trusted.map(toPublicPipelineDefinition),
  ];
}

async function createPipelineRegistryDefinition(userId, input = {}) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) {
    throw codedError('FORBIDDEN', 'Platform pipeline publication is not permitted.');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((field) => field !== 'manifest')) {
    throw codedError('INVALID_PIPELINE_DEFINITION', 'Only a declarative manifest may be published.');
  }
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [0x5343524e, 6]);
    const capability = await client.query(
      `SELECT 1 FROM platform_capabilities
        WHERE user_id = $1 AND capability = $2
        FOR SHARE`,
      [uid, PIPELINE_REGISTRY_PUBLISH_CAPABILITY]
    );
    if (!capability.rows[0]) {
      throw codedError('FORBIDDEN', 'Platform pipeline publication is not permitted.');
    }
    const count = await client.query(
      `SELECT count(*)::integer AS count FROM pipeline_definitions
        WHERE project_id IS NULL AND visibility = $1`,
      [PLATFORM_PIPELINE_VISIBILITY]
    );
    if (Number(count.rows[0]?.count || 0) >= PLATFORM_PIPELINE_REGISTRY_LIMIT) {
      throw codedError('PIPELINE_REGISTRY_FULL', 'The trusted pipeline registry has reached its configured limit.');
    }
    const manifest = validatePipelineManifest(input.manifest);
    const id = generatePipelineDefinitionId();
    const inserted = await client.query(
      `INSERT INTO pipeline_definitions
         (id, project_id, owner_user_id, visibility, manifest_id, name, manifest_json)
       VALUES ($1, NULL, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        id,
        uid,
        PLATFORM_PIPELINE_VISIBILITY,
        manifest.id,
        manifest.name,
        JSON.stringify(manifest),
      ]
    );
    await client.query('COMMIT');
    return toPublicPipelineDefinition(validatedPlatformPipelineDefinition(inserted.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    if (err && err.code === '23505') {
      throw codedError('PIPELINE_MANIFEST_EXISTS', 'A trusted pipeline with this manifest id already exists.');
    }
    throw err;
  } finally {
    client.release();
  }
}

async function getProjectPipelineSelection(userId, projectId) {
  await requireProjectRole(userId, projectId, PIPELINE_SELECTION_ROLES);
  const { rows } = await query(
    'SELECT * FROM project_pipeline_selections WHERE project_id = $1 AND user_id = $2',
    [String(projectId), Number(userId)]
  );
  const requestedId = rows[0]?.pipeline_id || DEFAULT_PIPELINE_ID;
  const accessible = await getAccessiblePipelineDefinition(requestedId);
  const pipelineId = accessible ? requestedId : DEFAULT_PIPELINE_ID;
  const definition = isBuiltInPipelineId(pipelineId)
    ? defaultPipelineDefinitionPublic(projectId)
    : toPublicPipelineDefinition(accessible);
  return {
    projectId: String(projectId),
    userId: Number(userId),
    pipelineId,
    definition,
    selectionUnavailable: requestedId !== pipelineId,
    updatedAt: rows[0]?.updated_at || null,
  };
}

async function setProjectPipelineSelection(userId, projectId, pipelineId) {
  await requireProjectRole(userId, projectId, PIPELINE_SELECTION_ROLES);
  if (typeof pipelineId !== 'string' || pipelineId === '') {
    throw codedError('INVALID_PIPELINE_SELECTION', 'pipelineId is required.');
  }
  const accessible = await getAccessiblePipelineDefinition(pipelineId);
  if (!accessible) throw codedError('PIPELINE_NOT_FOUND', 'Pipeline definition not found.');
  await query(
    `INSERT INTO project_pipeline_selections (project_id, user_id, pipeline_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (project_id, user_id)
     DO UPDATE SET pipeline_id = EXCLUDED.pipeline_id, updated_at = EXCLUDED.updated_at`,
    [String(projectId), Number(userId), String(pipelineId)]
  );
  return getProjectPipelineSelection(userId, projectId);
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
async function updateDatasetForProject(userId, projectId, datasetId, input = {}) {
  await requireProjectRole(userId, projectId, DATASET_WRITE_ROLES);
  const existing = await getDatasetRow(datasetId, projectId);
  if (!existing) throw codedError('NOT_FOUND', 'Dataset not found.');

  const sets = [];
  const params = [];
  let nextUpload = existing.uploadStatus;
  let nextValidation = existing.validationStatus;

  if (input.uploadStatus !== undefined) {
    if (!isValidDatasetUploadStatus(input.uploadStatus)) throw codedError('INVALID_UPLOAD_STATUS', 'Invalid upload_status.');
    nextUpload = input.uploadStatus;
    params.push(input.uploadStatus); sets.push(`upload_status = $${params.length}`);
  }
  if (input.validationStatus !== undefined) {
    if (!isValidDatasetValidationStatus(input.validationStatus)) throw codedError('INVALID_VALIDATION_STATUS', 'Invalid validation_status.');
    nextValidation = input.validationStatus;
    params.push(input.validationStatus); sets.push(`validation_status = $${params.length}`);
  }
  assertDatasetStatusCombo(nextUpload, nextValidation);
  if (input.validationErrors !== undefined) {
    params.push(normalizeValidationErrors(input.validationErrors)); sets.push(`validation_errors = $${params.length}`);
  }
  if (input.metadata !== undefined) {
    assertPlainObject(input.metadata, 'INVALID_METADATA', 'metadata must be a plain JSON object.');
    params.push(JSON.stringify(input.metadata)); sets.push(`metadata = $${params.length}`);
  }
  if (input.originalFilename !== undefined) {
    params.push(sanitizeDatasetFilename(input.originalFilename)); sets.push(`original_filename = $${params.length}`);
  }
  if (sets.length === 0) throw codedError('NO_FIELDS', 'No updatable fields provided.');
  params.push(String(datasetId), String(projectId));
  await query(
    `UPDATE datasets SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $${params.length - 1} AND project_id = $${params.length}`,
    params
  );
  return getDatasetRow(datasetId, projectId);
}

async function markDatasetUploaded(projectId, datasetId, { internalStorageKey, storageUri = null, sha256, fileSizeBytes }) {
  await query(
    `UPDATE datasets
        SET upload_status = 'uploaded',
            internal_storage_key = $1,
            storage_uri = $2,
            sha256 = $3,
            file_size_bytes = $4,
            updated_at = now()
      WHERE id = $5 AND project_id = $6`,
    [
      internalStorageKey != null ? String(internalStorageKey) : null,
      storageUri != null ? String(storageUri) : null,
      sha256 != null ? String(sha256) : null,
      Number.isFinite(fileSizeBytes) ? fileSizeBytes : null,
      String(datasetId),
      String(projectId)
    ]
  );
  return getDatasetRow(datasetId, projectId);
}

async function markDatasetUploadFailed(projectId, datasetId) {
  await query(
    `UPDATE datasets
        SET upload_status = 'failed',
            validation_status = CASE WHEN validation_status = 'valid' THEN 'invalid' ELSE validation_status END,
            updated_at = now()
      WHERE id = $1 AND project_id = $2`,
    [String(datasetId), String(projectId)]
  );
  return getDatasetRow(datasetId, projectId);
}

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
        object_type, display_name, metadata_json, created_by_provenance_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      id, owner,
      input.projectId != null ? String(input.projectId) : null,
      datasetId,
      parentObjectId,
      lineageRootId || id,
      objectType,
      input.displayName != null ? String(input.displayName) : null,
      JSON.stringify(metadata),
      // The route verifies the caller owns this provenance record (404 otherwise); we
      // persist the link so it round-trips on the public read.
      input.createdByProvenanceId ? String(input.createdByProvenanceId) : null
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

const createAnalysisObjectForUser = createAnalysisObject;

// Legacy owner-scoped HTTP routes are private-scope compatibility surfaces.
// Project-associated rows must stay behind the project RBAC routes; otherwise a
// removed creator could keep reading or deriving work from project data merely
// because owner_user_id still records scientific authorship.
async function getPrivateAnalysisObjectForUser(id, ownerUserId) {
  const { rows } = await query(
    `SELECT ao.* FROM analysis_objects ao
      WHERE ao.id = $1 AND ao.owner_user_id = $2 AND ao.project_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM analysis_objects parent
           WHERE parent.id = ao.parent_object_id AND parent.project_id IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1
            FROM analysis_objects root
            LEFT JOIN datasets root_dataset ON root_dataset.id = root.dataset_id
           WHERE root.id = ao.lineage_root_id
             AND (root.project_id IS NOT NULL OR root_dataset.project_id IS NOT NULL)
        )
        AND NOT EXISTS (
          SELECT 1 FROM datasets d
           WHERE d.id = ao.dataset_id AND d.project_id IS NOT NULL
        )`,
    [String(id), Number(ownerUserId)]
  );
  return rowToAnalysisObject(rows[0]);
}

async function listPrivateAnalysisObjectsForUser(ownerUserId, filters = {}) {
  const { clauses, params } = filterClauses(filters, {
    datasetId: 'ao.dataset_id',
    parentObjectId: 'ao.parent_object_id',
    lineageRootId: 'ao.lineage_root_id',
    objectType: 'ao.object_type'
  });
  const allParams = [Number(ownerUserId), ...params];
  const where = [
    'ao.owner_user_id = $1',
    'ao.project_id IS NULL',
    `NOT EXISTS (
      SELECT 1 FROM analysis_objects parent
       WHERE parent.id = ao.parent_object_id AND parent.project_id IS NOT NULL
    )`,
    `NOT EXISTS (
      SELECT 1
        FROM analysis_objects root
        LEFT JOIN datasets root_dataset ON root_dataset.id = root.dataset_id
       WHERE root.id = ao.lineage_root_id
         AND (root.project_id IS NOT NULL OR root_dataset.project_id IS NOT NULL)
    )`,
    `NOT EXISTS (
      SELECT 1 FROM datasets d
       WHERE d.id = ao.dataset_id AND d.project_id IS NOT NULL
    )`,
    ...clauses.map((c, i) => c.replace(`$${i + 1}`, `$${i + 2}`))
  ];
  const { rows } = await query(
    `SELECT ao.* FROM analysis_objects ao WHERE ${where.join(' AND ')} ORDER BY ao.created_at DESC, ao.id DESC`,
    allParams
  );
  return rows.map(rowToAnalysisObject);
}

async function createPrivateAnalysisObjectForUser(ownerUserId, input = {}) {
  if (input.projectId !== undefined && input.projectId !== null) {
    throw codedError('PARENT_NOT_FOUND', 'Project-scoped analysis objects require a project route.');
  }
  // Every durable dataset is project-scoped. A dataset-backed object must carry
  // that same project id and therefore cannot be created through this legacy
  // private route.
  if (input.datasetId !== undefined && input.datasetId !== null) {
    throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
  }
  if (input.parentObjectId !== undefined && input.parentObjectId !== null) {
    const parent = typeof input.parentObjectId === 'string'
      ? await getPrivateAnalysisObjectForUser(input.parentObjectId, ownerUserId)
      : null;
    if (!parent) throw codedError('PARENT_NOT_FOUND', 'Parent analysis object not found.');
  }
  return createAnalysisObject(ownerUserId, { ...input, projectId: null, datasetId: null });
}

async function verifyAnalysisObjectOwner(ownerUserId, objectId) {
  return !!(await getAnalysisObjectForUser(objectId, ownerUserId));
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
async function updateProjectAnalysisObjectSummary(userId, projectId, objectId, summary = {}) {
  await requireProjectRole(userId, projectId, ANALYSIS_WRITE_ROLES);
  const pid = String(projectId);
  const existing = await getProjectAnalysisObjectRow(objectId, pid);
  if (!existing) throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  const input = summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : {};
  const cleanSummary = {};
  for (const field of ALLOWED_ANALYSIS_SUMMARY_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      throw codedError('INVALID_METADATA', `Summary field '${field}' must be a non-negative number.`);
    }
    cleanSummary[field] = n;
  }
  const metadata = existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : {};
  const prevSummary = metadata.summary && typeof metadata.summary === 'object' && !Array.isArray(metadata.summary)
    ? metadata.summary : {};
  const nextMetadata = { ...metadata, summary: { ...prevSummary, ...cleanSummary } };
  await query(
    'UPDATE analysis_objects SET metadata_json = $1, updated_at = now() WHERE id = $2 AND project_id = $3',
    [JSON.stringify(nextMetadata), String(objectId), pid]
  );
  return getProjectAnalysisObjectRow(objectId, pid);
}

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
  if (jobType === 'seurat.pipeline.v1') {
    throw codedError('INVALID_JOB_TYPE',
      'seurat.pipeline.v1 jobs must be created through a project-scoped dataset.');
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
       (id, owner_user_id, project_id, analysis_object_id, dataset_id, job_type,
        status, parameters_json, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      id, owner,
      input.projectId != null ? String(input.projectId) : null,
      analysisObjectId,
      datasetId,
      jobType,
      INITIAL_JOB_STATUS,
      JSON.stringify(parameters),
      maxAttemptsForJobType(jobType, input.projectId)
    ]
  );
  return rowToJob(rows[0]);
}

const createJobForUser = createJob;

async function verifyJobOwner(ownerUserId, jobId) {
  return !!(await getJobForUser(jobId, ownerUserId));
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
    // Worker-coordination + scheduling columns (claim_token / worker_id / lease /
    // attempts / max_attempts / priority) are server-tier internal and are intentionally
    // NOT projected here — the public job shape must never carry a claim-token bearer
    // capability or the scheduling internals. The worker view re-adds them via
    // rowToWorkerJob().
    createdAt: toCanonicalTs(row.created_at),
    updatedAt: toCanonicalTs(row.updated_at),
    startedAt: toCanonicalTs(row.started_at),
    completedAt: toCanonicalTs(row.completed_at),
    canceledAt: toCanonicalTs(row.canceled_at)
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

async function getPrivateJobForUser(id, ownerUserId) {
  const { rows } = await query(
    `SELECT j.* FROM jobs j
      WHERE j.id = $1 AND j.owner_user_id = $2 AND j.project_id IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM analysis_objects ao
            LEFT JOIN analysis_objects parent ON parent.id = ao.parent_object_id
            LEFT JOIN analysis_objects root ON root.id = ao.lineage_root_id
            LEFT JOIN datasets source_dataset ON source_dataset.id = ao.dataset_id
            LEFT JOIN datasets root_dataset ON root_dataset.id = root.dataset_id
           WHERE ao.id IN (j.analysis_object_id, j.result_analysis_object_id)
             AND (ao.project_id IS NOT NULL
               OR parent.project_id IS NOT NULL
               OR root.project_id IS NOT NULL
               OR source_dataset.project_id IS NOT NULL
               OR root_dataset.project_id IS NOT NULL)
        )
        AND NOT EXISTS (
          SELECT 1 FROM datasets d
           WHERE d.id = j.dataset_id AND d.project_id IS NOT NULL
        )`,
    [String(id), Number(ownerUserId)]
  );
  return rowToJob(rows[0]);
}

async function listPrivateJobsForUser(ownerUserId, filters = {}) {
  const clauses = [
    'j.owner_user_id = $1',
    'j.project_id IS NULL',
    `NOT EXISTS (
      SELECT 1
        FROM analysis_objects ao
        LEFT JOIN analysis_objects parent ON parent.id = ao.parent_object_id
        LEFT JOIN analysis_objects root ON root.id = ao.lineage_root_id
        LEFT JOIN datasets source_dataset ON source_dataset.id = ao.dataset_id
        LEFT JOIN datasets root_dataset ON root_dataset.id = root.dataset_id
       WHERE ao.id IN (j.analysis_object_id, j.result_analysis_object_id)
         AND (ao.project_id IS NOT NULL
           OR parent.project_id IS NOT NULL
           OR root.project_id IS NOT NULL
           OR source_dataset.project_id IS NOT NULL
           OR root_dataset.project_id IS NOT NULL)
    )`,
    `NOT EXISTS (
      SELECT 1 FROM datasets d
       WHERE d.id = j.dataset_id AND d.project_id IS NOT NULL
    )`
  ];
  const params = [Number(ownerUserId)];
  const allowed = {
    status: 'j.status',
    jobType: 'j.job_type',
    analysisObjectId: 'j.analysis_object_id',
    resultAnalysisObjectId: 'j.result_analysis_object_id',
    datasetId: 'j.dataset_id'
  };
  for (const [field, column] of Object.entries(allowed)) {
    if (filters[field]) { params.push(String(filters[field])); clauses.push(`${column} = $${params.length}`); }
  }
  const { rows } = await query(
    `SELECT j.* FROM jobs j WHERE ${clauses.join(' AND ')} ORDER BY j.created_at DESC, j.id DESC`,
    params
  );
  return rows.map(rowToJob);
}

async function createPrivateJobForUser(ownerUserId, input = {}) {
  if (input.projectId !== undefined && input.projectId !== null) {
    throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Project-scoped jobs require a project route.');
  }
  if (input.datasetId !== undefined && input.datasetId !== null) {
    throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
  }
  if (input.analysisObjectId !== undefined && input.analysisObjectId !== null) {
    const object = typeof input.analysisObjectId === 'string'
      ? await getPrivateAnalysisObjectForUser(input.analysisObjectId, ownerUserId)
      : null;
    if (!object) throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  return createJob(ownerUserId, { ...input, projectId: null, datasetId: null });
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
  const serverManagedResultTypes = new Set([
    'pbmc.pipeline.v1',
    'seurat.pipeline.v1',
    'deg.find_markers.v1',
    'enrichment.gsea.v1',
    'cellchat.infer.v1',
    'checkpoint.load.v1',
    'checkpoint.fork.v1',
  ]);
  const noDatasetBindingTypes = new Set([
    'pbmc.pipeline.v1',
    'deg.find_markers.v1',
    'enrichment.gsea.v1',
    'cellchat.infer.v1',
    'checkpoint.load.v1',
    'checkpoint.fork.v1',
  ]);
  const requiresAnalysisObjectTypes = new Set([
    'pbmc.pipeline.v1',
    'seurat.pipeline.v1',
    'deg.find_markers.v1',
    'enrichment.gsea.v1',
    'cellchat.infer.v1',
    'checkpoint.load.v1',
    'checkpoint.fork.v1',
  ]);
  if (serverManagedResultTypes.has(jobType)
      && input.resultAnalysisObjectId !== undefined) {
    throw codedError('INVALID_PARAMETERS',
      `${jobType} resultAnalysisObjectId is server-managed and must not be provided.`);
  }
  if (noDatasetBindingTypes.has(jobType) && input.datasetId !== undefined) {
    throw codedError('INVALID_PARAMETERS',
      `${jobType} datasetId is not accepted; inputs are derived from the source analysis object.`);
  }
  if (requiresAnalysisObjectTypes.has(jobType)
      && (input.analysisObjectId === undefined || input.analysisObjectId === null)) {
    throw codedError('INVALID_PARAMETERS', `${jobType} requires a source analysisObjectId.`);
  }
  const parameters = input.parameters === undefined ? {} : input.parameters;
  assertPlainObject(parameters, 'INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
  let analysisObjectId = null;
  let analysisObject = null;
  if (input.analysisObjectId !== undefined && input.analysisObjectId !== null) {
    analysisObject = typeof input.analysisObjectId === 'string'
      ? await getProjectAnalysisObjectRow(input.analysisObjectId, pid)
      : null;
    if (!analysisObject) {
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
  let dataset = null;
  if (input.datasetId !== undefined && input.datasetId !== null) {
    dataset = typeof input.datasetId === 'string' ? await getDatasetRow(input.datasetId, pid) : null;
    if (!dataset) {
      throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
    }
    datasetId = input.datasetId;
  }
  if (jobType === 'seurat.pipeline.v1') {
    if (!datasetId) {
      throw codedError('INVALID_PARAMETERS', 'seurat.pipeline.v1 requires datasetId.');
    }
    if (!analysisObjectId) {
      throw codedError('INVALID_PARAMETERS', 'seurat.pipeline.v1 requires an input analysisObjectId for lineage.');
    }
    if (analysisObject.datasetId !== datasetId) {
      throw codedError('INVALID_PARAMETERS', 'seurat.pipeline.v1 input analysisObjectId must reference the same datasetId.');
    }
    validateSeuratPipelineParams(parameters);
    assertSupportedSeuratPipelineDataset(dataset);
  }
  if (jobType === 'checkpoint.load.v1' || jobType === 'checkpoint.fork.v1') {
    if (!analysisObjectId) {
      throw codedError('INVALID_PARAMETERS', `${jobType} requires a source analysisObjectId.`);
    }
    if (Object.keys(parameters).length > 0) {
      throw codedError('INVALID_PARAMETERS', `${jobType} does not accept client parameters.`);
    }
  }
  if (jobType === 'enrichment.gsea.v1') {
    validateEnrichmentGseaParams(parameters);
  }
  if (jobType === 'cellchat.infer.v1') {
    validateCellChatInferenceParams(parameters);
  }
  // These handlers read or mutate a process-local R object. Project membership
  // permits durable metadata access, but never lets a collaborator use another
  // member's live state. Reject before queue insertion so an invalid request
  // cannot consume the deployment's single worker slot only to fail later.
  const privateLiveInputJobTypes = new Set([
    'deg.find_markers.v1',
    'enrichment.gsea.v1',
    'cellchat.infer.v1',
    'checkpoint.load.v1',
  ]);
  if (privateLiveInputJobTypes.has(jobType)
      && (!analysisObject || analysisObject.ownerUserId !== owner)) {
    throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  const id = genId('job');
  const { rows } = await query(
    `INSERT INTO jobs
       (id, owner_user_id, project_id, analysis_object_id, result_analysis_object_id,
        dataset_id, job_type, status, parameters_json, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [id, Number(owner), pid, analysisObjectId, resultAnalysisObjectId, datasetId,
      jobType, INITIAL_JOB_STATUS, JSON.stringify(parameters), maxAttemptsForJobType(jobType, pid)]
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

async function cancelProjectJob(userId, projectId, jobId) {
  const pid = String(projectId);
  const actorUserId = Number(userId);
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    // Claim selection already uses job -> project lock order. Keep that order
    // here to avoid a cancellation/claim deadlock, then re-read the actor role
    // under the project lock before mutating the job.
    const locked = await client.query(
      'SELECT * FROM jobs WHERE id = $1 AND project_id = $2 FOR UPDATE',
      [String(jobId), pid]
    );
    const row = locked.rows[0];
    if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
    const project = await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [pid]);
    if (!project.rows[0]) throw codedError('NOT_FOUND', 'Project not found.');
    const membershipResult = await client.query(
      'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [pid, actorUserId]
    );
    const role = membershipResult.rows[0]?.role;
    if (!role) throw codedError('NOT_FOUND', 'Project not found.');
    if (!PROJECT_JOB_WRITE_ROLES.includes(role)) {
      throw codedError('FORBIDDEN', 'You do not have permission to perform this action.');
    }
    const membership = { userId: actorUserId, role };
    const job = rowToJob(row);
    if (membership.role === 'analyst' && job.ownerUserId !== membership.userId) {
      throw codedError('FORBIDDEN', 'Analysts can only cancel their own jobs.');
    }
    if (TERMINAL_JOB_STATUSES.has(job.status)) {
      throw codedError('JOB_NOT_CANCELABLE', `Job is already ${job.status}.`);
    }

    // Output publication takes this same row lock before committing. Under READ
    // COMMITTED, this query gets a fresh snapshot after any blocked publisher
    // commits, so cancellation cannot hide an already-published durable output.
    const output = await client.query(
      'SELECT 1 FROM job_artifacts WHERE job_id = $1 LIMIT 1',
      [String(jobId)]
    );
    if (row.result_analysis_object_id !== null || output.rows[0]) {
      throw codedError('JOB_NOT_CANCELABLE', 'Job can no longer be canceled.');
    }

    const cancelLog = normalizeJobLogEntry({ level: 'info', message: 'Job canceled.' });
    const canceled = await client.query(
      `UPDATE jobs SET
         status = 'canceled',
         logs_json = (logs_json::jsonb || $1::jsonb)::text,
         updated_at = now(),
         canceled_at = now(),
         claim_token = NULL,
         lease_expires_at = NULL
       WHERE id = $2 AND project_id = $3 AND status IN ('queued', 'running')
       RETURNING *`,
      [JSON.stringify([cancelLog]), String(jobId), pid]
    );
    if (!canceled.rows[0]) {
      throw codedError('JOB_NOT_CANCELABLE', 'Job can no longer be canceled.');
    }
    await client.query('COMMIT');
    return rowToJob(canceled.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

async function cancelJobForUser(ownerUserId, jobId) {
  const owner = Number(ownerUserId);
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      'SELECT * FROM jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE',
      [String(jobId), owner]
    );
    const row = locked.rows[0];
    if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
    const job = rowToJob(row);
    if (TERMINAL_JOB_STATUSES.has(job.status)) {
      throw codedError('JOB_NOT_CANCELABLE', `Job is already ${job.status}.`);
    }
    const output = await client.query(
      'SELECT 1 FROM job_artifacts WHERE job_id = $1 LIMIT 1',
      [String(jobId)]
    );
    if (row.result_analysis_object_id !== null || output.rows[0]) {
      throw codedError('JOB_NOT_CANCELABLE', 'Job can no longer be canceled.');
    }

    const cancelLog = normalizeJobLogEntry({ level: 'info', message: 'Job canceled.' });
    const canceled = await client.query(
      `UPDATE jobs SET
         status = 'canceled',
         logs_json = (logs_json::jsonb || $1::jsonb)::text,
         updated_at = now(),
         canceled_at = now(),
         claim_token = NULL,
         lease_expires_at = NULL
       WHERE id = $2 AND owner_user_id = $3 AND status IN ('queued', 'running')
       RETURNING *`,
      [JSON.stringify([cancelLog]), String(jobId), owner]
    );
    if (!canceled.rows[0]) {
      throw codedError('JOB_NOT_CANCELABLE', 'Job can no longer be canceled.');
    }
    await client.query('COMMIT');
    return rowToJob(canceled.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function cancelPrivateJobForUser(ownerUserId, jobId) {
  if (!(await getPrivateJobForUser(jobId, ownerUserId))) {
    throw codedError('JOB_NOT_FOUND', 'Job not found.');
  }
  return cancelJobForUser(ownerUserId, jobId);
}

// ── Job artifacts (metadata-first; result-checkpoint immutability) ───────────
async function getProjectProvenanceRow(provenanceId, projectId) {
  if (typeof provenanceId !== 'string' || provenanceId === '') return null;
  const { rows } = await query(
    'SELECT * FROM provenance WHERE id = $1 AND project_id = $2',
    [String(provenanceId), String(projectId)]
  );
  return rowToProjectProvenance(rows[0]);
}

async function getProjectFigureRow(figureId, projectId) {
  if (typeof figureId !== 'string' || figureId === '') return null;
  const { rows } = await query(
    'SELECT * FROM figure_collection WHERE id = $1 AND project_id = $2',
    [String(figureId), String(projectId)]
  );
  return rowToProjectFigure(rows[0]);
}

function rowToProjectProvenance(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    createdByUserId: Number(row.created_by_user_id),
    datasetId: row.dataset_id,
    analysisObjectId: row.analysis_object_id,
    jobId: row.job_id,
    resultAnalysisObjectId: row.result_analysis_object_id,
    timestamp: row.timestamp,
    language: row.language,
    languageVersion: row.language_version,
    packages: parseJson(row.packages, []),
    script: row.script,
    parameters: parseJson(row.parameters, {}),
    parentIds: parseJson(row.parent_ids, []),
    operation: row.operation || 'unknown',
    createdAt: row.created_at
  };
}

function rowToProjectFigure(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    createdByUserId: Number(row.created_by_user_id),
    analysisObjectId: row.analysis_object_id,
    jobId: row.job_id,
    provenanceId: row.provenance_id,
    datasetId: row.dataset_id,
    plotType: row.plot_type,
    title: row.title,
    params: parseJson(row.params_json, {}),
    fileFormat: row.file_format,
    thumbnailB64: row.thumbnail_b64,
    createdAt: row.created_at
  };
}

async function resolveSameProjectRefs(pid, input, { allowResult = false, allowProvenanceRef = false, allowParents = false } = {}) {
  const out = {};
  if (input.datasetId !== undefined && input.datasetId !== null) {
    if (typeof input.datasetId !== 'string' || !(await getDatasetRow(input.datasetId, pid))) {
      throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
    }
    out.datasetId = input.datasetId;
  }
  if (input.analysisObjectId !== undefined && input.analysisObjectId !== null) {
    if (typeof input.analysisObjectId !== 'string' || !(await getProjectAnalysisObjectRow(input.analysisObjectId, pid))) {
      throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    }
    out.analysisObjectId = input.analysisObjectId;
  }
  if (input.jobId !== undefined && input.jobId !== null) {
    if (typeof input.jobId !== 'string' || !(await getProjectJobRow(input.jobId, pid))) {
      throw codedError('JOB_NOT_FOUND', 'Job not found.');
    }
    out.jobId = input.jobId;
  }
  if (allowResult && input.resultAnalysisObjectId !== undefined && input.resultAnalysisObjectId !== null) {
    if (typeof input.resultAnalysisObjectId !== 'string' || !(await getProjectAnalysisObjectRow(input.resultAnalysisObjectId, pid))) {
      throw codedError('RESULT_OBJECT_NOT_FOUND', 'Result analysis object not found.');
    }
    out.resultAnalysisObjectId = input.resultAnalysisObjectId;
  }
  if (allowProvenanceRef && input.provenanceId !== undefined && input.provenanceId !== null) {
    if (typeof input.provenanceId !== 'string' || !(await getProjectProvenanceRow(input.provenanceId, pid))) {
      throw codedError('PROVENANCE_NOT_FOUND', 'Provenance record not found.');
    }
    out.provenanceId = input.provenanceId;
  }
  if (allowParents && input.parentIds !== undefined && input.parentIds !== null) {
    if (!Array.isArray(input.parentIds)) throw codedError('INVALID_PARENT_IDS', 'parentIds must be an array.');
    for (const parentId of input.parentIds) {
      if (typeof parentId !== 'string' || !(await getProjectProvenanceRow(parentId, pid))) {
        throw codedError('PARENT_NOT_FOUND', 'Parent provenance record not found.');
      }
    }
    out.parentIds = input.parentIds.map(String);
  }
  return out;
}

async function createProjectProvenance(userId, projectId, input = {}) {
  const membership = await requireProjectRole(userId, projectId, PROVENANCE_WRITE_ROLES);
  const actor = membership.userId;
  const pid = String(projectId);
  const parameters = input.parameters === undefined ? {} : input.parameters;
  assertPlainObject(parameters, 'INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
  const packages = input.packages === undefined ? [] : input.packages;
  if (!Array.isArray(packages)) throw codedError('INVALID_PACKAGES', 'packages must be an array.');
  const refs = await resolveSameProjectRefs(pid, input, { allowResult: true, allowParents: true });
  const id = generateProvenanceId();
  const { rows } = await query(
    `INSERT INTO provenance
       (id, user_email, project_id, created_by_user_id, dataset_id, analysis_object_id, job_id,
        result_analysis_object_id, timestamp, language, language_version, packages, script,
        parameters, parent_ids, operation)
     VALUES ($1, '', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      id, pid, Number(actor), refs.datasetId || null, refs.analysisObjectId || null,
      refs.jobId || null, refs.resultAnalysisObjectId || null,
      input.timestamp != null ? String(input.timestamp) : new Date().toISOString(),
      input.language != null ? String(input.language) : '',
      input.languageVersion != null ? String(input.languageVersion) : '',
      JSON.stringify(packages),
      input.script != null ? String(input.script) : '',
      JSON.stringify(parameters),
      JSON.stringify(refs.parentIds || []),
      input.operation != null ? String(input.operation) : 'unknown'
    ]
  );
  return rowToProjectProvenance(rows[0]);
}

async function listProjectProvenance(userId, projectId, filters = {}) {
  await requireProjectRole(userId, projectId, PROVENANCE_READ_ROLES);
  const clauses = ['project_id = $1'];
  const params = [String(projectId)];
  const allowed = { datasetId: 'dataset_id', analysisObjectId: 'analysis_object_id', jobId: 'job_id', operation: 'operation' };
  for (const [field, column] of Object.entries(allowed)) {
    if (filters[field]) { params.push(String(filters[field])); clauses.push(`${column} = $${params.length}`); }
  }
  const { rows } = await query(`SELECT * FROM provenance WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`, params);
  return rows.map(rowToProjectProvenance);
}

async function getProjectProvenance(userId, projectId, provenanceId) {
  await requireProjectRole(userId, projectId, PROVENANCE_READ_ROLES);
  return getProjectProvenanceRow(provenanceId, projectId);
}

async function createProjectFigure(userId, projectId, input = {}) {
  const membership = await requireProjectRole(userId, projectId, FIGURE_WRITE_ROLES);
  const actor = membership.userId;
  const pid = String(projectId);
  const params = input.params === undefined ? {} : input.params;
  assertPlainObject(params, 'INVALID_PARAMETERS', 'params must be a plain JSON object.');
  const plotType = input.plotType === undefined || input.plotType === null ? 'Unknown' : input.plotType;
  if (typeof plotType !== 'string' || plotType === '') throw codedError('INVALID_PLOT_TYPE', 'plotType must be a non-empty string.');
  const refs = await resolveSameProjectRefs(pid, input, { allowProvenanceRef: true });
  const id = generateFigureId();
  const { rows } = await query(
    `INSERT INTO figure_collection
       (id, user_email, project_id, created_by_user_id, analysis_object_id, job_id, provenance_id,
        dataset_id, plot_type, title, params_json, file_path, file_format, thumbnail_b64)
     VALUES ($1, '', $2, $3, $4, $5, $6, $7, $8, $9, $10, '', $11, $12)
     RETURNING *`,
    [
      id, pid, Number(actor), refs.analysisObjectId || null, refs.jobId || null,
      refs.provenanceId || null, refs.datasetId || null, plotType,
      input.title != null ? String(input.title) : '',
      JSON.stringify(params),
      input.fileFormat != null ? String(input.fileFormat) : 'png',
      input.thumbnailB64 != null ? String(input.thumbnailB64) : ''
    ]
  );
  return rowToProjectFigure(rows[0]);
}

async function listProjectFigures(userId, projectId, filters = {}) {
  await requireProjectRole(userId, projectId, FIGURE_READ_ROLES);
  const clauses = ['project_id = $1'];
  const params = [String(projectId)];
  const allowed = {
    analysisObjectId: 'analysis_object_id',
    jobId: 'job_id',
    provenanceId: 'provenance_id',
    datasetId: 'dataset_id',
    plotType: 'plot_type'
  };
  for (const [field, column] of Object.entries(allowed)) {
    if (filters[field]) { params.push(String(filters[field])); clauses.push(`${column} = $${params.length}`); }
  }
  const { rows } = await query(`SELECT * FROM figure_collection WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`, params);
  return rows.map(rowToProjectFigure);
}

async function getProjectFigure(userId, projectId, figureId) {
  await requireProjectRole(userId, projectId, FIGURE_READ_ROLES);
  return getProjectFigureRow(figureId, projectId);
}

const CHECKPOINT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

function isSafeInternalStorageKey(key) {
  if (typeof key !== 'string' || key === '') return false;
  if (/^([/\\]|[A-Za-z]:[/\\]|\\\\)/.test(key)) return false;
  if (/(^|[/\\])\.\.([/\\]|$)/.test(key)) return false;
  if (key.includes('\\') || key.includes('\0')) return false;
  return CHECKPOINT_KEY_RE.test(key);
}

function assertProjectArtifactStorageKey(jobRow, key, kind) {
  if (!jobRow.project_id) return;
  if (!storage.isProjectStorageKey(key, {
    projectId: jobRow.project_id,
    kind,
  })) {
    throw codedError('INVALID_STORAGE_KEY', 'Durable artifact key is outside the job project scope.');
  }
}

function normalizeChecksumSha256(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : undefined;
}

function normalizeArtifactSizeBytes(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const i = Math.floor(n);
  if (i < 0 || i > 1e15) return undefined;
  return i;
}

function assertArtifactMetadata(metadata) {
  assertPlainObject(metadata, 'INVALID_METADATA', 'metadata must be a plain JSON object.');
}

async function getJobArtifactRowById(id) {
  if (typeof id !== 'string' || id === '') return null;
  const { rows } = await query('SELECT * FROM job_artifacts WHERE id = $1', [String(id)]);
  return rowToJobArtifact(rows[0]);
}

async function resolveArtifactRefs(jobRow, input = {}, executor = query) {
  const pid = jobRow.project_id || null;
  const owner = Number(jobRow.owner_user_id);
  const out = {
    datasetId: jobRow.dataset_id || null,
    analysisObjectId: jobRow.analysis_object_id || null,
    resultAnalysisObjectId: jobRow.result_analysis_object_id || null,
    provenanceId: null,
    figureId: null
  };

  async function exists(sql, params) {
    const result = await executor(sql, params);
    return !!result.rows[0];
  }

  async function resolveAo(id, code, label) {
    if (typeof id !== 'string') throw codedError(code, `${label} not found.`);
    const ok = pid
      ? await exists('SELECT 1 FROM analysis_objects WHERE id = $1 AND project_id = $2', [id, pid])
      : await exists('SELECT 1 FROM analysis_objects WHERE id = $1 AND owner_user_id = $2', [id, owner]);
    if (!ok) throw codedError(code, `${label} not found.`);
    return id;
  }

  if (input.analysisObjectId !== undefined && input.analysisObjectId !== null) {
    out.analysisObjectId = await resolveAo(input.analysisObjectId, 'ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object');
  }
  if (input.resultAnalysisObjectId !== undefined && input.resultAnalysisObjectId !== null) {
    out.resultAnalysisObjectId = await resolveAo(input.resultAnalysisObjectId, 'RESULT_OBJECT_NOT_FOUND', 'Result analysis object');
  }
  if (input.datasetId !== undefined && input.datasetId !== null) {
    if (!pid || typeof input.datasetId !== 'string'
        || !(await exists('SELECT 1 FROM datasets WHERE id = $1 AND project_id = $2', [input.datasetId, pid]))) {
      throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
    }
    out.datasetId = input.datasetId;
  }
  if (input.provenanceId !== undefined && input.provenanceId !== null) {
    if (!pid || typeof input.provenanceId !== 'string'
        || !(await exists('SELECT 1 FROM provenance WHERE id = $1 AND project_id = $2', [input.provenanceId, pid]))) {
      throw codedError('PROVENANCE_NOT_FOUND', 'Provenance record not found.');
    }
    out.provenanceId = input.provenanceId;
  }
  if (input.figureId !== undefined && input.figureId !== null) {
    if (!pid || typeof input.figureId !== 'string'
        || !(await exists('SELECT 1 FROM figure_collection WHERE id = $1 AND project_id = $2', [input.figureId, pid]))) {
      throw codedError('FIGURE_NOT_FOUND', 'Figure not found.');
    }
    out.figureId = input.figureId;
  }
  return out;
}

async function insertJobArtifactRow(client, {
  id,
  jobRow,
  refs,
  artifactType,
  name = null,
  description = null,
  mimeType = null,
  storageKind = 'metadata_only',
  storageUri = null,
  checksumSha256 = null,
  sizeBytes = null,
  status = 'available',
  metadata = {}
}) {
  await client.query(
    `INSERT INTO job_artifacts
       (id, project_id, job_id, dataset_id, analysis_object_id, result_analysis_object_id,
        provenance_id, figure_id, created_by_user_id, artifact_type, name, description,
        mime_type, storage_kind, storage_uri, checksum_sha256, size_bytes, status, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      id,
      jobRow.project_id || null,
      jobRow.id,
      refs.datasetId || null,
      refs.analysisObjectId || null,
      refs.resultAnalysisObjectId || null,
      refs.provenanceId || null,
      refs.figureId || null,
      Number(jobRow.owner_user_id),
      artifactType,
      name,
      description,
      mimeType,
      storageKind,
      storageUri,
      checksumSha256,
      sizeBytes,
      status,
      JSON.stringify(metadata)
    ]
  );
}

async function prepareMetadataArtifact(jobRow, input = {}, executor = query) {
  const artifactType = typeof input.artifactType === 'string' ? input.artifactType.trim() : 'other_metadata';
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
  const status = input.status === undefined || input.status === null ? 'available' : String(input.status);
  if (!isValidArtifactStatus(status)) {
    throw codedError('INVALID_ARTIFACT_STATUS', `Invalid status. Allowed: ${[...ALLOWED_ARTIFACT_STATUSES].join(', ')}.`);
  }
  const metadata = input.metadata === undefined ? {} : input.metadata;
  assertArtifactMetadata(metadata);
  const refs = await resolveArtifactRefs(jobRow, input, executor);
  return {
    id: generateJobArtifactId(),
    jobRow,
    refs,
    artifactType,
    name: input.name != null ? String(input.name) : null,
    description: input.description != null ? String(input.description) : null,
    mimeType: input.mimeType != null ? String(input.mimeType) : null,
    storageKind,
    status,
    metadata,
  };
}

async function lockWorkerClaimRow(client, jobId, workerId, claimToken, now) {
  const locked = await client.query('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [String(jobId)]);
  const row = locked.rows[0];
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, workerId, claimToken, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  return row;
}

async function createJobArtifactByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const p = await connect();
  const client = await p.connect();
  let prepared;
  try {
    await client.query('BEGIN');
    const row = await lockWorkerClaimRow(client, jobId, wid, token, now);
    prepared = await prepareMetadataArtifact(row, input, client.query.bind(client));
    await insertJobArtifactRow(client, prepared);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return getJobArtifactRowById(prepared.id);
}

async function createCheckpointArtifactForJobByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const artifactType = typeof input.artifactType === 'string' ? input.artifactType.trim() : 'checkpoint';
  if (!isValidArtifactType(artifactType)) {
    throw codedError('INVALID_ARTIFACT_TYPE',
      `Invalid artifactType. Allowed: ${[...ALLOWED_ARTIFACT_TYPES].join(', ')}.`);
  }
  const storageKind = input.storageKind === undefined || input.storageKind === null ? 'local_internal' : String(input.storageKind);
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
  assertArtifactMetadata(metadata);
  const id = generateJobArtifactId();
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const row = await lockWorkerClaimRow(client, jobId, wid, token, now);
    assertProjectArtifactStorageKey(row, input.internalStorageKey, 'checkpoints');
    const refs = await resolveArtifactRefs(row, input, client.query.bind(client));
    await insertJobArtifactRow(client, {
      id,
      jobRow: row,
      refs,
      artifactType,
      name: input.name != null ? String(input.name) : null,
      description: input.description != null ? String(input.description) : null,
      mimeType: input.mimeType != null ? String(input.mimeType) : null,
      storageKind,
      storageUri: input.internalStorageKey,
      checksumSha256: checksum,
      sizeBytes,
      status,
      metadata
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return getJobArtifactRowById(id);
}

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

async function getJobRowById(id) {
  if (typeof id !== 'string' || id === '') return null;
  const { rows } = await query('SELECT * FROM jobs WHERE id = $1', [String(id)]);
  return rows[0] || null;
}

function rowToWorkerJob(row) {
  if (!row) return null;
  return {
    ...rowToJob(row),
    workerId: row.worker_id,
    claimToken: row.claim_token,
    leaseExpiresAt: toCanonicalTs(row.lease_expires_at),
    heartbeatAt: toCanonicalTs(row.heartbeat_at),
    lockedAt: toCanonicalTs(row.locked_at),
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 1),
    priority: Number(row.priority || 0),
    lastWorkerError: row.last_worker_error ? parseJson(row.last_worker_error, null) : null
  };
}

async function getWorkerJob(jobId) {
  return rowToWorkerJob(await getJobRowById(jobId));
}

function workerHoldsClaim(row, workerId, claimToken, now) {
  const lease = row && row.lease_expires_at ? normalizeTimestamp(row.lease_expires_at) : null;
  return !!row
    && row.status === 'running'
    && row.worker_id === workerId
    && typeof row.claim_token === 'string'
    && row.claim_token === claimToken
    && lease
    && lease.getTime() > now.getTime();
}

const CLAIMED_OWNED_OBJECT_JOB_TYPES = new Set([
  'r.object.inspect',
  'pbmc.pipeline.v1',
  'checkpoint.load.v1',
  'deg.find_markers.v1',
  'enrichment.gsea.v1',
  'cellchat.infer.v1',
]);

async function requireClaimedJobRowByWorker(jobId, workerId, claimToken, opts = {}, expectedJobType = null) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = await getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  if (expectedJobType && row.job_type !== expectedJobType) {
    throw codedError('INVALID_JOB_TYPE', `A claimed ${expectedJobType} job is required.`);
  }
  return row;
}

async function resolveOwnedAnalysisObjectForClaimedJob(row) {
  if (!row.analysis_object_id) {
    throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  const object = row.project_id
    ? await getProjectAnalysisObjectRow(row.analysis_object_id, row.project_id)
    : await getPrivateAnalysisObjectForUser(row.analysis_object_id, Number(row.owner_user_id));
  if (!object || object.ownerUserId !== Number(row.owner_user_id)) {
    throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  return object;
}

// Worker-only resolvers authorize against the live job claim, not the creator's
// current project membership. Membership is authoritative up to claim time; once
// a project job is running, these helpers preserve its exact job/project/resource
// binding so a validly claimed handler may finish after a later demotion/removal.
// Every helper derives resource ids from the trusted job row and rechecks the
// worker id, claim token, running status, and unexpired lease on each call.
async function getOwnedAnalysisObjectForJobByWorker(jobId, workerId, claimToken, opts = {}) {
  const row = await requireClaimedJobRowByWorker(jobId, workerId, claimToken, opts);
  if (!CLAIMED_OWNED_OBJECT_JOB_TYPES.has(row.job_type)) {
    throw codedError('INVALID_JOB_TYPE', 'A claimed live-object job is required.');
  }
  return resolveOwnedAnalysisObjectForClaimedJob(row);
}

async function getSeuratPipelineInputsForJobByWorker(jobId, workerId, claimToken, opts = {}) {
  const row = await requireClaimedJobRowByWorker(
    jobId, workerId, claimToken, opts, 'seurat.pipeline.v1'
  );
  if (!row.project_id || !row.dataset_id || !row.analysis_object_id) {
    throw codedError('INVALID_JOB_CONTEXT', 'Seurat pipeline job inputs are incomplete.');
  }
  const [dataset, inputObject] = await Promise.all([
    getDatasetRow(row.dataset_id, row.project_id),
    getProjectAnalysisObjectRow(row.analysis_object_id, row.project_id),
  ]);
  if (!dataset) throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
  if (!inputObject) throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  if (inputObject.datasetId !== dataset.id) {
    throw codedError('INVALID_PARAMETERS', 'Seurat pipeline input object must reference the same dataset as the job.');
  }
  return { dataset, inputObject };
}

async function getLoadableCheckpointForJobByWorker(jobId, workerId, claimToken, opts = {}) {
  const row = await requireClaimedJobRowByWorker(
    jobId, workerId, claimToken, opts, 'checkpoint.load.v1'
  );
  const object = await resolveOwnedAnalysisObjectForClaimedJob(row);
  const checkpoint = await resolveCheckpointArtifact(object.id, object.projectId || null);
  return {
    analysisObjectId: object.id,
    projectId: object.projectId || null,
    ...checkpoint,
  };
}

async function getForkableCheckpointForJobByWorker(jobId, workerId, claimToken, opts = {}) {
  const row = await requireClaimedJobRowByWorker(
    jobId, workerId, claimToken, opts, 'checkpoint.fork.v1'
  );
  if (!row.project_id || !row.analysis_object_id) {
    throw codedError('INVALID_JOB_CONTEXT', 'Checkpoint fork job inputs are incomplete.');
  }
  const sourceObject = await getProjectAnalysisObjectRow(row.analysis_object_id, row.project_id);
  if (!sourceObject) throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  const checkpoint = await resolveCheckpointArtifact(sourceObject.id, row.project_id);
  return {
    sourceAnalysisObject: sourceObject,
    analysisObjectId: sourceObject.id,
    projectId: row.project_id,
    ...checkpoint,
  };
}

async function claimNextJob(workerId, opts = {}) {
  const wid = requireWorkerId(workerId);
  const now = normalizeWorkerNow(opts);
  const leaseSeconds = normalizeLeaseSeconds(opts.leaseSeconds);
  let allowedJobTypes = null;
  if (opts.allowedJobTypes !== undefined && opts.allowedJobTypes !== null) {
    if (!Array.isArray(opts.allowedJobTypes)) {
      throw codedError('INVALID_WORKER_CAPABILITIES', 'allowedJobTypes must be an array.');
    }
    allowedJobTypes = [...new Set(opts.allowedJobTypes.map((value) => String(value)))];
    if (allowedJobTypes.some((jobType) => !ALLOWED_JOB_TYPES.has(jobType))) {
      throw codedError('INVALID_WORKER_CAPABILITIES', 'allowedJobTypes contains an invalid job type.');
    }
  }
  const claimToken = generateClaimToken();
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      'SELECT pg_advisory_xact_lock($1, $2)',
      WORKER_CLAIM_GATE_LOCK
    );
    const activeClaim = await client.query(
      `SELECT 1 FROM jobs
        WHERE status = 'running'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > $1
        LIMIT 1`,
      [now]
    );
    if (activeClaim.rows[0]) {
      await client.query('COMMIT');
      return null;
    }

    // Membership/role changes are authoritative at claim time. Ineligible
    // project jobs, plus legacy projectless jobs that reference project-scoped
    // inputs, are canceled before any handler or R contact; completed and
    // already-running scientific history is preserved.
    const revoked = await client.query(
      `SELECT j.id, j.job_type, j.attempts, j.logs_json,
              (j.project_id IS NULL) AS invalid_project_scope,
              (j.result_analysis_object_id IS NOT NULL
                OR EXISTS (SELECT 1 FROM job_artifacts a WHERE a.job_id = j.id)
                OR EXISTS (SELECT 1 FROM analysis_object_edges e WHERE e.job_id = j.id)
              ) AS has_committed_output
         FROM jobs j
        WHERE j.status = 'queued'
          AND (
            (j.project_id IS NOT NULL
              AND NOT (COALESCE(j.last_worker_error::jsonb ->> 'code', '') = ANY($2::text[]))
              AND NOT EXISTS (
                SELECT 1 FROM project_members pm
                 WHERE pm.project_id = j.project_id
                   AND pm.user_id = j.owner_user_id
                   AND pm.role = ANY($1::text[])
              ))
            OR
            (j.project_id IS NULL AND (
              EXISTS (
                SELECT 1
                  FROM analysis_objects ao
                  LEFT JOIN analysis_objects parent ON parent.id = ao.parent_object_id
                  LEFT JOIN analysis_objects root ON root.id = ao.lineage_root_id
                  LEFT JOIN datasets source_dataset ON source_dataset.id = ao.dataset_id
                  LEFT JOIN datasets root_dataset ON root_dataset.id = root.dataset_id
                 WHERE ao.id IN (j.analysis_object_id, j.result_analysis_object_id)
                   AND (ao.project_id IS NOT NULL
                     OR parent.project_id IS NOT NULL
                     OR root.project_id IS NOT NULL
                     OR source_dataset.project_id IS NOT NULL
                     OR root_dataset.project_id IS NOT NULL)
              )
              OR EXISTS (
                SELECT 1 FROM datasets d
                 WHERE d.id = j.dataset_id AND d.project_id IS NOT NULL
              )
            ))
          )
        ORDER BY j.created_at ASC, j.id ASC
        LIMIT 100
        FOR UPDATE OF j SKIP LOCKED`,
      [PROJECT_JOB_WRITE_ROLES, RECOVERY_ONLY_PENDING_CODES]
    );
    const accessError = normalizeJobError({
      code: 'PROJECT_ACCESS_REVOKED',
      message: 'Job canceled because its creator no longer has permission to run project jobs.',
    });
    const scopeError = normalizeJobError({
      code: 'INVALID_PROJECT_SCOPE',
      message: 'Job canceled because a project-associated input was submitted without project scope.',
    });
    for (const row of revoked.rows) {
      const cancellationError = row.invalid_project_scope ? scopeError : accessError;
      const logs = [
        ...parseJson(row.logs_json, []),
        normalizeJobLogEntry({ level: 'warn', message: cancellationError.message }),
      ];
      if (row.has_committed_output) {
        // Never label durable scientific history as canceled. A reviewed
        // project-scoped job type is left queued for the recovery-only claim
        // below; invalid/unknown shapes fail closed without another handler.
        if (!row.invalid_project_scope && RETRYABLE_DURABLE_JOB_TYPES.has(row.job_type)) continue;
        await client.query(
          `UPDATE jobs SET status = 'failed', logs_json = $1, error_json = $2,
             completed_at = $3, updated_at = $3, worker_id = NULL,
             claim_token = NULL, lease_expires_at = NULL
           WHERE id = $4 AND status = 'queued'`,
          [JSON.stringify(logs), JSON.stringify(cancellationError), now, row.id]
        );
        continue;
      }
      if (!row.invalid_project_scope
          && Number(row.attempts) > 0
          && RETRYABLE_DURABLE_JOB_TYPES.has(row.job_type)) {
        // A prior authorized attempt may have atomically written its private
        // signed R receipt even when no DB output transaction is visible yet.
        // Preserve one receipt-only claim after access revocation; the worker is
        // explicitly forbidden from dispatching R under this marker.
        const recoveryError = normalizeJobError({
          code: R_RETRY_RECOVERY_PENDING,
          message: 'Creator access changed after a prior attempt; queued for recovery-only inspection.',
        });
        await client.query(
          `UPDATE jobs SET logs_json = $1, last_worker_error = $2, updated_at = $3
            WHERE id = $4 AND status = 'queued'`,
          [JSON.stringify(logs), JSON.stringify(recoveryError), now, row.id]
        );
        continue;
      }
      await client.query(
        `UPDATE jobs SET status = 'canceled', logs_json = $1, error_json = $2,
           canceled_at = $3, updated_at = $3, worker_id = NULL,
           claim_token = NULL, lease_expires_at = NULL
         WHERE id = $4 AND status = 'queued'`,
        [JSON.stringify(logs), JSON.stringify(cancellationError), now, row.id]
      );
    }

    const found = await client.query(
      `SELECT j.id, j.project_id, j.owner_user_id,
              (COALESCE(j.last_worker_error::jsonb ->> 'code', '') = ANY($4::text[]))
                AS recovery_only_pending,
              (j.result_analysis_object_id IS NOT NULL
                OR EXISTS (SELECT 1 FROM job_artifacts a WHERE a.job_id = j.id)
                OR EXISTS (SELECT 1 FROM analysis_object_edges e WHERE e.job_id = j.id)
              ) AS has_committed_output
         FROM jobs j
        WHERE j.status = 'queued' AND j.attempts < j.max_attempts
          AND ($2::text[] IS NULL OR j.job_type = ANY($2::text[]))
          AND (
            (j.project_id IS NULL
              AND NOT EXISTS (
                SELECT 1
                  FROM analysis_objects ao
                  LEFT JOIN analysis_objects parent ON parent.id = ao.parent_object_id
                  LEFT JOIN analysis_objects root ON root.id = ao.lineage_root_id
                  LEFT JOIN datasets source_dataset ON source_dataset.id = ao.dataset_id
                  LEFT JOIN datasets root_dataset ON root_dataset.id = root.dataset_id
                 WHERE ao.id IN (j.analysis_object_id, j.result_analysis_object_id)
                   AND (ao.project_id IS NOT NULL
                     OR parent.project_id IS NOT NULL
                     OR root.project_id IS NOT NULL
                     OR source_dataset.project_id IS NOT NULL
                     OR root_dataset.project_id IS NOT NULL)
              )
              AND NOT EXISTS (
                SELECT 1 FROM datasets d
                 WHERE d.id = j.dataset_id AND d.project_id IS NOT NULL
              )
            ) OR EXISTS (
              SELECT 1 FROM project_members pm
               WHERE pm.project_id = j.project_id
                 AND pm.user_id = j.owner_user_id
                 AND pm.role = ANY($1::text[])
            )
            OR (
              j.project_id IS NOT NULL
              AND j.job_type = ANY($3::text[])
              AND (j.result_analysis_object_id IS NOT NULL
                OR EXISTS (SELECT 1 FROM job_artifacts a WHERE a.job_id = j.id)
                OR EXISTS (SELECT 1 FROM analysis_object_edges e WHERE e.job_id = j.id))
            )
            OR (
              j.project_id IS NOT NULL
              AND COALESCE(j.last_worker_error::jsonb ->> 'code', '') = ANY($4::text[])
            )
          )
        ORDER BY j.priority DESC, j.created_at ASC, j.id ASC
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED`,
      [
        PROJECT_JOB_WRITE_ROLES,
        allowedJobTypes,
        [...RETRYABLE_DURABLE_JOB_TYPES],
        RECOVERY_ONLY_PENDING_CODES,
      ]
    );
    if (!found.rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    const selected = found.rows[0];
    const id = selected.id;
    if (selected.project_id && !selected.has_committed_output
        && !selected.recovery_only_pending) {
      // Serialize the final eligibility check with membership mutations. If a
      // removal/demotion committed while this job was being selected, cancel it
      // under the same job lock instead of starting a handler with stale access.
      await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [selected.project_id]);
      const eligible = await client.query(
        `SELECT 1 FROM project_members
          WHERE project_id = $1 AND user_id = $2 AND role = ANY($3::text[])`,
        [selected.project_id, Number(selected.owner_user_id), PROJECT_JOB_WRITE_ROLES]
      );
      if (!eligible.rows[0]) {
        const row = await client.query('SELECT logs_json FROM jobs WHERE id = $1', [id]);
        const logs = [
          ...parseJson(row.rows[0]?.logs_json, []),
          normalizeJobLogEntry({ level: 'warn', message: accessError.message }),
        ];
        await client.query(
          `UPDATE jobs SET status = 'canceled', logs_json = $1, error_json = $2,
             canceled_at = $3, updated_at = $3, worker_id = NULL,
             claim_token = NULL, lease_expires_at = NULL
           WHERE id = $4 AND status = 'queued'`,
          [JSON.stringify(logs), JSON.stringify(accessError), now, id]
        );
        await client.query('COMMIT');
        return null;
      }
    }
    const updated = await client.query(
      `UPDATE jobs SET
         status = 'running',
         worker_id = $1,
         claim_token = $2,
         attempts = attempts + 1,
         locked_at = $3,
         heartbeat_at = $3,
         lease_expires_at = $4,
         started_at = COALESCE(started_at, $3),
         updated_at = $3
       WHERE id = $5 AND status = 'queued' AND attempts < max_attempts
       RETURNING *`,
      [wid, claimToken, now, addSeconds(now, leaseSeconds), id]
    );
    await client.query('COMMIT');
    return rowToWorkerJob(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function heartbeatJob(jobId, workerId, claimToken, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const leaseSeconds = normalizeLeaseSeconds(opts.leaseSeconds);
  if (!(await getJobRowById(jobId))) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  const { rows } = await query(
    `UPDATE jobs SET heartbeat_at = $1, lease_expires_at = $2, updated_at = $1
      WHERE id = $3 AND worker_id = $4 AND claim_token = $5
        AND status = 'running' AND lease_expires_at > $1
        AND COALESCE(last_worker_error::jsonb ->> 'code', '') <> $6
      RETURNING *`,
    [now, addSeconds(now, leaseSeconds), String(jobId), wid, token, R_TIMEOUT_INDETERMINATE]
  );
  if (!rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  return rowToWorkerJob(rows[0]);
}

/**
 * Persist the point of no safe retry immediately before a receipt-backed R
 * request is dispatched. A worker-process crash closes its HTTP socket but does
 * not stop synchronous R execution, so an expired lease carrying this marker is
 * observed and recovered without ever issuing the handler a second time.
 */
async function markRDispatchStartedByWorker(jobId, workerId, claimToken, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const marker = JSON.stringify(normalizeJobError({
    code: R_DISPATCH_STARTED,
    message: 'A receipt-backed R operation was dispatched; retries require recovery-only handling.',
  }));
  if (!(await getJobRowById(jobId))) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  const { rows } = await query(
    `UPDATE jobs SET last_worker_error = $1, updated_at = $2
      WHERE id = $3 AND worker_id = $4 AND claim_token = $5
        AND status = 'running' AND lease_expires_at > $2
        AND job_type = ANY($6::text[])
      RETURNING *`,
    [
      marker,
      now,
      String(jobId),
      wid,
      token,
      [...RETRYABLE_DURABLE_JOB_TYPES],
    ]
  );
  if (!rows[0]) throw codedError(
    'CLAIM_LOST',
    'This worker no longer holds a valid receipt-backed claim on the job.'
  );
  return rowToWorkerJob(rows[0]);
}

async function completeJobByWorker(jobId, workerId, claimToken, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = await getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  if (!validateJobTransition(row.status, 'completed')) throw codedError('INVALID_TRANSITION', `Cannot complete a job in status '${row.status}'.`);
  let resultId = row.result_analysis_object_id;
  if (opts.resultAnalysisObjectId !== undefined && opts.resultAnalysisObjectId !== null) {
    if (typeof opts.resultAnalysisObjectId !== 'string' ||
        !(await getAnalysisObjectForUser(opts.resultAnalysisObjectId, Number(row.owner_user_id)))) {
      throw codedError('RESULT_OBJECT_NOT_FOUND', 'Result analysis object not found.');
    }
    resultId = opts.resultAnalysisObjectId;
  }
  const logs = opts.log !== undefined
    ? [...parseJson(row.logs_json, []), normalizeJobLogEntry(opts.log)]
    : parseJson(row.logs_json, []);
  const { rows } = await query(
    `UPDATE jobs SET
       status = 'completed',
       result_analysis_object_id = $1,
       logs_json = $2,
       completed_at = $3,
       heartbeat_at = $3,
       updated_at = $3,
       claim_token = NULL,
       lease_expires_at = NULL
     WHERE id = $4 AND worker_id = $5 AND claim_token = $6
       AND status = 'running' AND lease_expires_at > $3
     RETURNING *`,
    [resultId == null ? null : String(resultId), JSON.stringify(logs), now, String(jobId), wid, token]
  );
  if (!rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  return rowToWorkerJob(rows[0]);
}

/**
 * Recover the narrow crash window where a handler's atomic output transaction
 * committed but the process died before the generic terminal job update. Only
 * exact, reviewed output shapes are resumable; partial/ambiguous output fails
 * closed without another R call.
 */
async function resumeCommittedJobByWorker(jobId, workerId, claimToken, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = await getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }

  const recoverySpecs = {
    'pbmc.pipeline.v1': { artifacts: ['checkpoint', 'pipeline_summary'], result: true, edges: 1 },
    'seurat.pipeline.v1': { artifacts: ['checkpoint', 'pipeline_summary'], result: true, edges: 1 },
    'checkpoint.fork.v1': {
      artifacts: ['checkpoint_fork'], result: true, edges: 1, runtimeBoundArtifact: 'checkpoint_fork',
    },
    'checkpoint.load.v1': {
      artifacts: ['checkpoint_load'], result: false, edges: 0, runtimeBoundArtifact: 'checkpoint_load',
    },
    'deg.find_markers.v1': { artifacts: ['deg_markers', 'deg_summary'], result: false, edges: 0 },
    'enrichment.gsea.v1': {
      artifacts: ['enrichment_results', 'enrichment_summary'], result: false, edges: 0,
    },
    'cellchat.infer.v1': {
      artifacts: ['cellchat_results', 'cellchat_summary'], result: false, edges: 0,
    },
  };
  const spec = recoverySpecs[row.job_type];
  if (!spec) return { resumed: false, committedOutput: false };

  const artifacts = await query(
    `SELECT artifact_type, storage_kind, storage_uri, checksum_sha256, size_bytes, metadata_json
       FROM job_artifacts WHERE job_id = $1 ORDER BY created_at ASC, id ASC`,
    [String(jobId)]
  );
  const counts = new Map();
  for (const artifact of artifacts.rows) {
    counts.set(artifact.artifact_type, (counts.get(artifact.artifact_type) || 0) + 1);
  }
  const edgeCountResult = await query(
    'SELECT COUNT(*)::integer AS count FROM analysis_object_edges WHERE job_id = $1',
    [String(jobId)]
  );
  const edgeCount = Number(edgeCountResult.rows[0].count);
  const totalArtifacts = artifacts.rows.length;
  const hasCommittedOutput = totalArtifacts > 0 || edgeCount > 0 || !!row.result_analysis_object_id;
  if (!hasCommittedOutput) return { resumed: false, committedOutput: false };

  const artifactsComplete = totalArtifacts === spec.artifacts.length
    && spec.artifacts.every((artifactType) => counts.get(artifactType) === 1);
  const resultComplete = spec.result ? !!row.result_analysis_object_id : !row.result_analysis_object_id;
  const edgesComplete = edgeCount === spec.edges;
  async function failRecovery(errorCode, message, logMessage) {
    await failJobByWorker(
      jobId,
      wid,
      token,
      {
        code: errorCode,
        message,
      },
      {
        ...(opts.now === undefined ? {} : { now: opts.now }),
        log: { level: 'error', message: logMessage },
      }
    );
    return { resumed: false, committedOutput: true, failed: true, errorCode };
  }

  if (!artifactsComplete || !resultComplete || !edgesComplete) {
    return failRecovery(
      'INCOMPLETE_COMMITTED_OUTPUT',
      'A prior worker left an incomplete durable output; the job was stopped safely.',
      'Incomplete prior output detected; refusing to rerun R.'
    );
  }

  const localArtifacts = artifacts.rows.filter((artifact) => artifact.storage_kind === 'local_internal');
  if (localArtifacts.length > 0) {
    if (typeof opts.inspectStorageObject !== 'function') {
      return failRecovery(
        'COMMITTED_OUTPUT_INVALID',
        'A prior worker output could not be verified; the job was stopped safely.',
        'Prior output storage could not be verified; refusing recovery.'
      );
    }
    try {
      for (const artifact of localArtifacts) {
        const kind = artifact.artifact_type === 'checkpoint'
          ? 'checkpoints'
          : (artifact.artifact_type === 'deg_markers'
            || artifact.artifact_type === 'enrichment_results' ? 'artifacts' : null);
        if (!kind || !row.project_id || !storage.isProjectStorageKey(artifact.storage_uri, {
          projectId: row.project_id,
          kind,
        })) {
          throw codedError('INVALID_STORAGE_KEY', 'Committed output storage is outside the job scope.');
        }
        const checksumSha256 = normalizeChecksumSha256(artifact.checksum_sha256);
        const sizeBytes = normalizeArtifactSizeBytes(artifact.size_bytes);
        if (!checksumSha256 || sizeBytes === null || sizeBytes === undefined) {
          throw codedError('INVALID_STORAGE_METADATA', 'Committed output integrity metadata is invalid.');
        }
        await opts.inspectStorageObject(artifact.storage_uri, { checksumSha256, sizeBytes });
      }
    } catch {
      return failRecovery(
        'COMMITTED_OUTPUT_INVALID',
        'A prior worker output failed integrity verification; the job was stopped safely.',
        'Prior output failed storage integrity verification; refusing recovery.'
      );
    }
  }

  if (spec.runtimeBoundArtifact) {
    const runtimeArtifact = artifacts.rows.find(
      (artifact) => artifact.artifact_type === spec.runtimeBoundArtifact
    );
    const metadata = runtimeArtifact ? parseJson(runtimeArtifact.metadata_json, {}) : {};
    const committedHash = metadata && metadata.loaded && metadata.loaded.runtimeInstanceHash;
    const currentHash = opts.rRuntimeInstanceHash;
    if (!/^[0-9a-f]{64}$/.test(String(committedHash || ''))
        || committedHash !== currentHash) {
      return failRecovery(
        'LIVE_R_STATE_LOST',
        'The R runtime restarted after a live-state operation; rerun the operation explicitly.',
        'R runtime identity changed after committed live-state output; refusing false recovery.'
      );
    }
  }

  const recoveryLog = normalizeJobLogEntry({
    level: 'info',
    message: 'Recovered committed output after a prior worker lease expired.',
  });
  // Hashing a large checkpoint above can take longer than the lease. Never use
  // the timestamp captured before that I/O for the guarded terminal update: an
  // expired claim must not be able to complete merely because its old timestamp
  // still predates lease_expires_at. Production uses the database clock at the
  // statement boundary; tests may continue to inject an explicit deterministic
  // timestamp through opts.now.
  const terminalNow = opts.now === undefined ? null : normalizeWorkerNow(opts);
  const { rows } = await query(
    `UPDATE jobs SET
       status = 'completed',
       logs_json = (logs_json::jsonb || $1::jsonb)::text,
       completed_at = COALESCE($2::timestamptz, CURRENT_TIMESTAMP),
       heartbeat_at = COALESCE($2::timestamptz, CURRENT_TIMESTAMP),
       updated_at = COALESCE($2::timestamptz, CURRENT_TIMESTAMP),
       claim_token = NULL,
       lease_expires_at = NULL
     WHERE id = $3 AND worker_id = $4 AND claim_token = $5
       AND status = 'running'
       AND lease_expires_at > COALESCE($2::timestamptz, CURRENT_TIMESTAMP)
     RETURNING *`,
    [JSON.stringify([recoveryLog]), terminalNow, String(jobId), wid, token]
  );
  if (!rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  return { resumed: true, committedOutput: true, job: rowToWorkerJob(rows[0]) };
}

async function failJobByWorker(jobId, workerId, claimToken, error, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = await getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  if (!validateJobTransition(row.status, 'failed')) throw codedError('INVALID_TRANSITION', `Cannot fail a job in status '${row.status}'.`);
  const errObj = normalizeJobError(error === undefined || error === null ? { message: 'Job failed.' } : error);
  const errJson = JSON.stringify(errObj);
  const logs = opts.log !== undefined
    ? [...parseJson(row.logs_json, []), normalizeJobLogEntry(opts.log)]
    : parseJson(row.logs_json, []);
  const { rows } = await query(
    `UPDATE jobs SET
       status = 'failed',
       error_json = $1,
       last_worker_error = $1,
       logs_json = $2,
       completed_at = $3,
       heartbeat_at = $3,
       updated_at = $3,
       claim_token = NULL,
       lease_expires_at = NULL
     WHERE id = $4 AND worker_id = $5 AND claim_token = $6
       AND status = 'running' AND lease_expires_at > $3
     RETURNING *`,
    [errJson, JSON.stringify(logs), now, String(jobId), wid, token]
  );
  if (!rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  return rowToWorkerJob(rows[0]);
}

/**
 * Record an indeterminate R bridge outcome without terminally failing or releasing
 * the job. The R request may still be executing after a local timeout or transport
 * disconnect, so immediately re-queueing would permit overlapping R execution. The
 * claim remains running for a bounded grace period and is converted by
 * reapExpiredJobs into one recovery-only claim.
 */
async function deferIndeterminateRTimeoutByWorker(jobId, workerId, claimToken, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const requestedGraceSeconds = normalizeLeaseSeconds(opts.recoveryDelaySeconds);
  const recoveryDelaySeconds = Math.min(
    requestedGraceSeconds,
    R_TIMEOUT_RECOVERY_MAX_GRACE_SECONDS
  );
  const row = await getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }

  const timeoutState = normalizeJobError({
    code: R_TIMEOUT_INDETERMINATE,
    message: 'The local R execution outcome is unknown; waiting for bounded output recovery.',
  });
  const logs = [
    ...parseJson(row.logs_json, []),
    normalizeJobLogEntry({
      level: 'warn',
      message: 'R execution became indeterminate after a local timeout or disconnect; waiting before exact-output recovery.',
    }),
  ];
  const { rows } = await query(
    `UPDATE jobs SET
       error_json = NULL,
       last_worker_error = $1,
       logs_json = $2,
       heartbeat_at = $3,
       lease_expires_at = $4,
       updated_at = $3
     WHERE id = $5 AND worker_id = $6 AND claim_token = $7
       AND status = 'running' AND lease_expires_at > $3
     RETURNING *`,
    [
      JSON.stringify(timeoutState),
      JSON.stringify(logs),
      now,
      addSeconds(now, recoveryDelaySeconds),
      String(jobId),
      wid,
      token,
    ]
  );
  if (!rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  return rowToWorkerJob(rows[0]);
}

async function releaseJob(jobId, workerId, claimToken, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = await getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  if (!validateJobTransition(row.status, 'queued')) throw codedError('INVALID_TRANSITION', `Cannot release a job in status '${row.status}'.`);
  const logs = opts.log !== undefined ? [...parseJson(row.logs_json, []), normalizeJobLogEntry(opts.log)] : parseJson(row.logs_json, []);
  const { rows } = await query(
    `UPDATE jobs SET
       status = 'queued',
       worker_id = NULL,
       claim_token = NULL,
       locked_at = NULL,
       lease_expires_at = NULL,
       heartbeat_at = $1,
       attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
       logs_json = $2,
       updated_at = $1
     WHERE id = $3 AND worker_id = $4 AND claim_token = $5
       AND status = 'running' AND lease_expires_at > $1
     RETURNING *`,
    [now, JSON.stringify(logs), String(jobId), wid, token]
  );
  if (!rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  return rowToWorkerJob(rows[0]);
}

async function appendJobLogByWorker(jobId, workerId, claimToken, entry, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = await getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  const logs = [...parseJson(row.logs_json, []), normalizeJobLogEntry(entry)];
  const { rows } = await query(
    `UPDATE jobs SET logs_json = $1, updated_at = $2
      WHERE id = $3 AND worker_id = $4 AND claim_token = $5
        AND status = 'running' AND lease_expires_at > $2
      RETURNING *`,
    [JSON.stringify(logs), now, String(jobId), wid, token]
  );
  if (!rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  return rowToWorkerJob(rows[0]);
}

async function reapExpiredJobs(opts = {}) {
  const now = normalizeWorkerNow(opts);
  const candidates = await query(
    `SELECT id FROM jobs
      WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1`,
    [now]
  );
  const requeued = [];
  const failed = [];
  for (const candidate of candidates.rows) {
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      // Atomic output publishers take this same row lock. After waiting for a
      // publisher, READ COMMITTED gives the output query below a fresh snapshot.
      const locked = await client.query('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [candidate.id]);
      const row = locked.rows[0];
      if (!row || row.status !== 'running' || !row.lease_expires_at
          || new Date(row.lease_expires_at).getTime() > now.getTime()) {
        await client.query('COMMIT');
        continue;
      }
      const output = await client.query(
        `SELECT
           EXISTS (SELECT 1 FROM job_artifacts a WHERE a.job_id = $1)
           OR EXISTS (SELECT 1 FROM analysis_object_edges e WHERE e.job_id = $1)
           AS present`,
        [row.id]
      );
      const hasCommittedOutput = row.result_analysis_object_id !== null || output.rows[0]?.present === true;
      const attempts = Number(row.attempts);
      const maxAttempts = Number(row.max_attempts);
      const previousError = parseJson(row.last_worker_error, {});
      const rDispatchStarted = previousError.code === R_DISPATCH_STARTED;
      const indeterminateRTimeout = previousError.code === R_TIMEOUT_INDETERMINATE;
      const recoveryOnlyClaim = RECOVERY_ONLY_PENDING_CODES.includes(previousError.code);
      if (rDispatchStarted) {
        // A hard worker crash can sever Node's upstream socket while the separate
        // R process continues synchronously. Revoke the dead claim and spend one
        // bounded observation window before granting receipt-only recovery. A
        // crash between this marker and actual dispatch may therefore fail, but
        // can never duplicate scientific execution.
        const recoveryError = JSON.stringify(normalizeJobError({
          code: R_TIMEOUT_INDETERMINATE,
          message: 'The worker exited after R dispatch; waiting for bounded completion recovery.',
        }));
        await client.query(
          `UPDATE jobs SET worker_id = NULL, claim_token = NULL, locked_at = NULL,
             lease_expires_at = $1, heartbeat_at = $2,
             last_worker_error = $3, updated_at = $2
           WHERE id = $4`,
          [addSeconds(now, R_TIMEOUT_RECOVERY_MAX_GRACE_SECONDS), now, recoveryError, row.id]
        );
      } else if (indeterminateRTimeout) {
        // The grace window ended. Grant exactly one claim that may validate and
        // finalize an exact committed output, but must never invoke the handler/R.
        // Refund only the claim consumed by this bounded recovery handoff.
        const recoveryError = JSON.stringify(normalizeJobError({
          code: R_TIMEOUT_RECOVERY_PENDING,
          message: 'R recovery grace period ended; queued for one recovery-only claim.',
        }));
        await client.query(
          `UPDATE jobs SET status = 'queued', attempts = GREATEST(attempts - 1, 0),
             worker_id = NULL, claim_token = NULL, locked_at = NULL,
             lease_expires_at = NULL, heartbeat_at = $1,
             last_worker_error = $2, updated_at = $1
           WHERE id = $3`,
          [now, recoveryError, row.id]
        );
        requeued.push(row.id);
      } else if (recoveryOnlyClaim) {
        // A recovery-only worker also died or stalled. We cannot prove the
        // separate synchronous R process stopped, so revoke the dead claim and
        // return to observation instead of failing, cleaning, or ever falling
        // through to another scientific dispatch. Operators may explicitly
        // cancel a permanently stuck job.
        const recoveryError = JSON.stringify(normalizeJobError({
          code: R_TIMEOUT_INDETERMINATE,
          message: 'Recovery is still observing an indeterminate R execution.',
        }));
        await client.query(
          `UPDATE jobs SET worker_id = NULL, claim_token = NULL, locked_at = NULL,
             lease_expires_at = $1, heartbeat_at = $2,
             last_worker_error = $3, updated_at = $2
           WHERE id = $4`,
          [addSeconds(now, R_TIMEOUT_RECOVERY_MAX_GRACE_SECONDS), now, recoveryError, row.id]
        );
      } else if (attempts < maxAttempts) {
        const lastErr = JSON.stringify(normalizeJobError({
          code: 'LEASE_EXPIRED', message: 'Worker lease expired; job re-queued for another claim.',
        }));
        await client.query(
          `UPDATE jobs SET status = 'queued', worker_id = NULL, claim_token = NULL,
             locked_at = NULL, lease_expires_at = NULL, heartbeat_at = $1,
             last_worker_error = $2, updated_at = $1
           WHERE id = $3`,
          [now, lastErr, row.id]
        );
        requeued.push(row.id);
      } else {
        if (hasCommittedOutput && RETRYABLE_DURABLE_JOB_TYPES.has(row.job_type)) {
          // Preserve the execution-attempt ceiling while granting exactly one
          // recovery-only claim. claimNextJob increments attempts back to the
          // final value, and resumeCommittedJobByWorker runs before any handler.
          const recoveryError = JSON.stringify(normalizeJobError({
            code: COMMITTED_OUTPUT_RECOVERY_PENDING,
            message: 'Final output committed before lease expiry; queued for recovery-only finalization.',
          }));
          await client.query(
            `UPDATE jobs SET status = 'queued', attempts = GREATEST(attempts - 1, 0),
               worker_id = NULL, claim_token = NULL, locked_at = NULL,
               lease_expires_at = NULL, heartbeat_at = $1,
               last_worker_error = $2, updated_at = $1
             WHERE id = $3`,
            [now, recoveryError, row.id]
          );
          requeued.push(row.id);
        } else {
          const errJson = JSON.stringify(normalizeJobError({
            code: 'LEASE_EXPIRED',
            message: 'Worker lease expired and the claim budget is exhausted; job failed.',
          }));
          await client.query(
            `UPDATE jobs SET status = 'failed', error_json = $1, last_worker_error = $1,
               completed_at = $2, heartbeat_at = $2, claim_token = NULL,
               lease_expires_at = NULL, updated_at = $2
             WHERE id = $3`,
            [errJson, now, row.id]
          );
          failed.push(row.id);
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return { requeued, failed };
}

async function setJobScheduling(jobId, opts = {}) {
  const id = String(jobId);
  const row = await getJobRowById(id);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  const sets = [];
  const params = [];
  if (opts.priority !== undefined) {
    if (!Number.isInteger(opts.priority)) throw codedError('INVALID_PRIORITY', 'priority must be an integer.');
    params.push(opts.priority); sets.push(`priority = $${params.length}`);
  }
  if (opts.maxAttempts !== undefined) {
    if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) throw codedError('INVALID_MAX_ATTEMPTS', 'maxAttempts must be a positive integer.');
    params.push(opts.maxAttempts); sets.push(`max_attempts = $${params.length}`);
  }
  if (opts.createdAt !== undefined) {
    let createdAt;
    try { createdAt = normalizeTimestamp(opts.createdAt); }
    catch { throw codedError('INVALID_CREATED_AT', 'createdAt must be a valid timestamp.'); }
    params.push(createdAt); sets.push(`created_at = $${params.length}`);
  }
  if (sets.length === 0) return rowToWorkerJob(row);
  params.push(id);
  await query(`UPDATE jobs SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
  return getWorkerJob(id);
}

async function createCheckpointForJobByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = await getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  if (row.result_analysis_object_id) {
    throw codedError('CHECKPOINT_EXISTS', 'Job already has a result checkpoint object.');
  }

  const owner = Number(row.owner_user_id);
  const pid = row.project_id || null;
  const objectType = input.objectType === undefined || input.objectType === null
    ? 'generic' : String(input.objectType).trim();
  if (!isValidObjectType(objectType)) {
    throw codedError('INVALID_OBJECT_TYPE', `Invalid objectType. Allowed: ${[...ALLOWED_OBJECT_TYPES].join(', ')}.`);
  }
  const metadata = input.metadata === undefined ? {} : input.metadata;
  assertPlainObject(metadata, 'INVALID_METADATA', 'metadata must be a plain JSON object.');

  const parentObjectId = input.parentObjectId !== undefined && input.parentObjectId !== null
    ? String(input.parentObjectId)
    : (row.analysis_object_id || null);
  let lineageRootId = null;
  if (parentObjectId) {
    const parent = pid ? await getProjectAnalysisObjectRow(parentObjectId, pid)
                       : await getAnalysisObjectForUser(parentObjectId, owner);
    if (!parent) throw codedError('PARENT_NOT_FOUND', 'Parent analysis object not found.');
    lineageRootId = parent.lineageRootId || parent.id;
  }

  let datasetId = row.dataset_id || null;
  if (input.datasetId !== undefined && input.datasetId !== null) {
    if (!pid || typeof input.datasetId !== 'string' || !(await getDatasetRow(input.datasetId, pid))) {
      throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
    }
    datasetId = input.datasetId;
  }

  const id = generateAnalysisObjectId();
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO analysis_objects
         (id, owner_user_id, project_id, dataset_id, parent_object_id, lineage_root_id,
          object_type, display_name, storage_uri, object_hash, metadata_json, created_by_provenance_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, $9, NULL)`,
      [
        id,
        owner,
        pid,
        datasetId,
        parentObjectId,
        lineageRootId || id,
        objectType,
        input.displayName != null ? String(input.displayName) : null,
        JSON.stringify(metadata)
      ]
    );
    const linked = await client.query(
      `UPDATE jobs SET result_analysis_object_id = $1, updated_at = $2
       WHERE id = $3 AND worker_id = $4 AND claim_token = $5
         AND status = 'running' AND lease_expires_at > $2
         AND result_analysis_object_id IS NULL`,
      [id, now, String(jobId), wid, token]
    );
    if (linked.rowCount !== 1) {
      throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    }
    if (parentObjectId) {
      await insertLineageEdgeRow(client, {
        projectId: pid,
        parentObjectId,
        childObjectId: id,
        jobId: String(jobId),
        edgeType: 'checkpoint',
        parentRole: 'primary',
        metadata: {},
        createdByUserId: owner
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return pid ? getProjectAnalysisObjectRow(id, pid) : getAnalysisObjectForUser(id, owner);
}

function validateLocalInternalArtifactSpec(input, {
  defaultArtifactType = 'checkpoint',
  artifactTypeRequired = false,
  helperName = 'worker completion'
} = {}) {
  const artifactType = typeof input.artifactType === 'string' ? input.artifactType.trim() : defaultArtifactType;
  if ((artifactTypeRequired && !artifactType) || !isValidArtifactType(artifactType)) {
    throw codedError('INVALID_ARTIFACT_TYPE',
      `Invalid artifactType. Allowed: ${[...ALLOWED_ARTIFACT_TYPES].join(', ')}.`);
  }
  const storageKind = input.storageKind === undefined || input.storageKind === null ? 'local_internal' : String(input.storageKind);
  if (storageKind !== 'local_internal') {
    throw codedError('INVALID_STORAGE_KIND', `${helperName} records a local_internal artifact.`);
  }
  if (!isSafeInternalStorageKey(input.internalStorageKey)) {
    throw codedError('INVALID_STORAGE_KEY', 'internalStorageKey must be a safe, relative, server-allocated key.');
  }
  const checksum = normalizeChecksumSha256(input.checksumSha256);
  if (checksum === undefined || checksum === null) {
    throw codedError('INVALID_CHECKSUM', 'checksumSha256 must be a 64-char hex string.');
  }
  const sizeBytes = normalizeArtifactSizeBytes(input.sizeBytes);
  if (sizeBytes === undefined || sizeBytes === null) {
    throw codedError('INVALID_SIZE', 'sizeBytes must be a non-negative integer.');
  }
  const status = input.status === undefined || input.status === null ? 'available' : String(input.status);
  if (!isValidArtifactStatus(status)) {
    throw codedError('INVALID_ARTIFACT_STATUS', `Invalid status. Allowed: ${[...ALLOWED_ARTIFACT_STATUSES].join(', ')}.`);
  }
  const metadata = input.metadata === undefined ? {} : input.metadata;
  assertArtifactMetadata(metadata);
  return { artifactType, storageKind, storageUri: input.internalStorageKey, checksumSha256: checksum, sizeBytes, status, metadata };
}

function validateMetadataOnlyArtifactSpec(input, {
  defaultArtifactType = '',
  artifactTypeRequired = true
} = {}) {
  const artifactType = typeof input.artifactType === 'string' ? input.artifactType.trim() : defaultArtifactType;
  if ((artifactTypeRequired && !artifactType) || !isValidArtifactType(artifactType)) {
    throw codedError('INVALID_ARTIFACT_TYPE',
      `Invalid artifactType. Allowed: ${[...ALLOWED_ARTIFACT_TYPES].join(', ')}.`);
  }
  const storageKind = input.storageKind === undefined || input.storageKind === null ? 'metadata_only' : String(input.storageKind);
  if (!isValidArtifactStorageKind(storageKind)) {
    throw codedError('INVALID_STORAGE_KIND', `Invalid storageKind. Allowed: ${[...ALLOWED_ARTIFACT_STORAGE_KINDS].join(', ')}.`);
  }
  const status = input.status === undefined || input.status === null ? 'available' : String(input.status);
  if (!isValidArtifactStatus(status)) {
    throw codedError('INVALID_ARTIFACT_STATUS', `Invalid status. Allowed: ${[...ALLOWED_ARTIFACT_STATUSES].join(', ')}.`);
  }
  const metadata = input.metadata === undefined ? {} : input.metadata;
  assertArtifactMetadata(metadata);
  return { artifactType, storageKind, status, metadata };
}

async function completePbmcPipelineResultByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = await getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  if (row.result_analysis_object_id) throw codedError('CHECKPOINT_EXISTS', 'Job already has a result checkpoint object.');

  const owner = Number(row.owner_user_id);
  const pid = row.project_id || null;
  const result = input.result && typeof input.result === 'object' ? input.result : {};
  const objectType = result.objectType === undefined || result.objectType === null ? 'generic' : String(result.objectType).trim();
  if (!isValidObjectType(objectType)) {
    throw codedError('INVALID_OBJECT_TYPE', `Invalid objectType. Allowed: ${[...ALLOWED_OBJECT_TYPES].join(', ')}.`);
  }
  const resultMetadata = result.metadata === undefined ? {} : result.metadata;
  assertPlainObject(resultMetadata, 'INVALID_METADATA', 'metadata must be a plain JSON object.');
  const cpSpec = validateLocalInternalArtifactSpec(
    input.checkpointArtifact && typeof input.checkpointArtifact === 'object' ? input.checkpointArtifact : {},
    { defaultArtifactType: 'checkpoint', helperName: 'completePbmcPipelineResultByWorker' }
  );
  assertProjectArtifactStorageKey(row, cpSpec.storageUri, 'checkpoints');
  const sm = input.summaryArtifact && typeof input.summaryArtifact === 'object' ? input.summaryArtifact : {};
  const smSpec = validateMetadataOnlyArtifactSpec(sm);

  const parentObjectId = result.parentObjectId !== undefined && result.parentObjectId !== null
    ? String(result.parentObjectId)
    : (row.analysis_object_id || null);
  let lineageRootId = null;
  if (parentObjectId) {
    const parent = pid ? await getProjectAnalysisObjectRow(parentObjectId, pid)
                       : await getAnalysisObjectForUser(parentObjectId, owner);
    if (!parent) throw codedError('PARENT_NOT_FOUND', 'Parent analysis object not found.');
    lineageRootId = parent.lineageRootId || parent.id;
  }
  const datasetId = row.dataset_id || null;
  const resultId = generateAnalysisObjectId();
  const checkpointArtifactId = generateJobArtifactId();
  const summaryArtifactId = generateJobArtifactId();
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO analysis_objects
         (id, owner_user_id, project_id, dataset_id, parent_object_id, lineage_root_id, object_type,
          display_name, storage_uri, object_hash, metadata_json, created_by_provenance_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, $9, NULL)`,
      [
        resultId,
        owner,
        pid,
        datasetId,
        parentObjectId,
        lineageRootId || resultId,
        objectType,
        result.displayName != null ? String(result.displayName) : null,
        JSON.stringify(resultMetadata)
      ]
    );
    const linkInfo = await client.query(
      `UPDATE jobs SET result_analysis_object_id = $1, updated_at = $2
       WHERE id = $3 AND worker_id = $4 AND claim_token = $5
         AND status = 'running' AND lease_expires_at > $2
         AND result_analysis_object_id IS NULL`,
      [resultId, now, String(jobId), wid, token]
    );
    if (linkInfo.rowCount !== 1) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    if (parentObjectId) {
      await insertLineageEdgeRow(client, {
        projectId: pid,
        parentObjectId,
        childObjectId: resultId,
        jobId: String(jobId),
        edgeType: 'checkpoint',
        parentRole: 'primary',
        metadata: {},
        createdByUserId: owner
      });
    }
    await insertJobArtifactRow(client, {
      id: checkpointArtifactId,
      jobRow: row,
      refs: { datasetId, analysisObjectId: parentObjectId, resultAnalysisObjectId: resultId },
      artifactType: cpSpec.artifactType,
      name: input.checkpointArtifact && input.checkpointArtifact.name != null ? String(input.checkpointArtifact.name) : null,
      description: input.checkpointArtifact && input.checkpointArtifact.description != null ? String(input.checkpointArtifact.description) : null,
      storageKind: cpSpec.storageKind,
      storageUri: cpSpec.storageUri,
      checksumSha256: cpSpec.checksumSha256,
      sizeBytes: cpSpec.sizeBytes,
      status: cpSpec.status,
      metadata: cpSpec.metadata
    });
    await insertJobArtifactRow(client, {
      id: summaryArtifactId,
      jobRow: row,
      refs: { datasetId, analysisObjectId: parentObjectId, resultAnalysisObjectId: resultId },
      artifactType: smSpec.artifactType,
      name: sm.name != null ? String(sm.name) : null,
      description: sm.description != null ? String(sm.description) : null,
      storageKind: smSpec.storageKind,
      status: smSpec.status,
      metadata: smSpec.metadata
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return {
    resultObject: pid ? await getProjectAnalysisObjectRow(resultId, pid) : await getAnalysisObjectForUser(resultId, owner),
    checkpointArtifact: await getJobArtifactRowById(checkpointArtifactId),
    summaryArtifact: await getJobArtifactRowById(summaryArtifactId)
  };
}

async function completeSeuratPipelineResultByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = await getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  if (row.result_analysis_object_id) throw codedError('CHECKPOINT_EXISTS', 'Job already has a result checkpoint object.');
  if (!row.project_id || !row.dataset_id || !row.analysis_object_id || !(await getDatasetRow(row.dataset_id, row.project_id))) {
    throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
  }

  const owner = Number(row.owner_user_id);
  const pid = row.project_id;
  const datasetId = row.dataset_id;
  const result = input.result && typeof input.result === 'object' ? input.result : {};
  const resultMetadata = result.metadata === undefined ? {} : result.metadata;
  assertPlainObject(resultMetadata, 'INVALID_METADATA', 'metadata must be a plain JSON object.');
  const cpSpec = validateLocalInternalArtifactSpec(
    input.checkpointArtifact && typeof input.checkpointArtifact === 'object' ? input.checkpointArtifact : {},
    { defaultArtifactType: 'checkpoint', helperName: 'completeSeuratPipelineResultByWorker' }
  );
  assertProjectArtifactStorageKey(row, cpSpec.storageUri, 'checkpoints');
  const sm = input.summaryArtifact && typeof input.summaryArtifact === 'object' ? input.summaryArtifact : {};
  const smSpec = validateMetadataOnlyArtifactSpec(sm);

  const sourceId = row.analysis_object_id;
  const sourceObject = await getProjectAnalysisObjectRow(sourceId, pid);
  if (!sourceObject || sourceObject.datasetId !== datasetId) {
    throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  const resultId = generateAnalysisObjectId();
  const checkpointArtifactId = generateJobArtifactId();
  const summaryArtifactId = generateJobArtifactId();
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO analysis_objects
         (id, owner_user_id, project_id, dataset_id, parent_object_id, lineage_root_id, object_type,
          display_name, storage_uri, object_hash, metadata_json, created_by_provenance_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'seurat', $7, NULL, NULL, $8, NULL)`,
      [
        resultId,
        owner,
        pid,
        datasetId,
        sourceId,
        sourceObject.lineageRootId || sourceId,
        result.displayName != null ? String(result.displayName) : 'Seurat pipeline result',
        JSON.stringify(resultMetadata)
      ]
    );
    const linkInfo = await client.query(
      `UPDATE jobs SET result_analysis_object_id = $1, updated_at = $2
       WHERE id = $3 AND worker_id = $4 AND claim_token = $5
         AND status = 'running' AND lease_expires_at > $2
         AND result_analysis_object_id IS NULL`,
      [resultId, now, String(jobId), wid, token]
    );
    if (linkInfo.rowCount !== 1) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    await insertLineageEdgeRow(client, {
      projectId: pid,
      parentObjectId: sourceId,
      childObjectId: resultId,
      jobId: String(jobId),
      edgeType: 'checkpoint',
      parentRole: 'primary',
      metadata: { source: 'dataset', datasetId },
      createdByUserId: owner
    });
    await insertJobArtifactRow(client, {
      id: checkpointArtifactId,
      jobRow: row,
      refs: { datasetId, analysisObjectId: sourceId, resultAnalysisObjectId: resultId },
      artifactType: cpSpec.artifactType,
      name: input.checkpointArtifact && input.checkpointArtifact.name != null ? String(input.checkpointArtifact.name) : null,
      description: input.checkpointArtifact && input.checkpointArtifact.description != null ? String(input.checkpointArtifact.description) : null,
      storageKind: cpSpec.storageKind,
      storageUri: cpSpec.storageUri,
      checksumSha256: cpSpec.checksumSha256,
      sizeBytes: cpSpec.sizeBytes,
      status: cpSpec.status,
      metadata: cpSpec.metadata
    });
    await insertJobArtifactRow(client, {
      id: summaryArtifactId,
      jobRow: row,
      refs: { datasetId, analysisObjectId: sourceId, resultAnalysisObjectId: resultId },
      artifactType: smSpec.artifactType,
      name: sm.name != null ? String(sm.name) : null,
      description: sm.description != null ? String(sm.description) : null,
      storageKind: smSpec.storageKind,
      status: smSpec.status,
      metadata: smSpec.metadata
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return {
    sourceObject: await getProjectAnalysisObjectRow(sourceId, pid),
    resultObject: await getProjectAnalysisObjectRow(resultId, pid),
    checkpointArtifact: await getJobArtifactRowById(checkpointArtifactId),
    summaryArtifact: await getJobArtifactRowById(summaryArtifactId)
  };
}

async function completeDegFindMarkersResultByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = await getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  const existing = await query(
    "SELECT 1 FROM job_artifacts WHERE job_id = $1 AND artifact_type = 'deg_markers' LIMIT 1",
    [String(row.id)]
  );
  if (existing.rows[0]) throw codedError('DEG_RESULT_EXISTS', 'Job already has a DEG marker result artifact.');

  const tbl = input.markersArtifact && typeof input.markersArtifact === 'object' ? input.markersArtifact : {};
  const tblSpec = validateLocalInternalArtifactSpec(tbl, {
    defaultArtifactType: 'deg_markers',
    helperName: 'completeDegFindMarkersResultByWorker'
  });
  assertProjectArtifactStorageKey(row, tblSpec.storageUri, 'artifacts');
  const sm = input.summaryArtifact && typeof input.summaryArtifact === 'object' ? input.summaryArtifact : {};
  const smSpec = validateMetadataOnlyArtifactSpec(sm, { defaultArtifactType: 'deg_summary', artifactTypeRequired: false });
  const markersArtifactId = generateJobArtifactId();
  const summaryArtifactId = generateJobArtifactId();
  const refs = {
    datasetId: row.dataset_id || null,
    analysisObjectId: row.analysis_object_id || null,
    resultAnalysisObjectId: row.result_analysis_object_id || null
  };
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const claimRow = await client.query(
      `SELECT 1 FROM jobs
       WHERE id = $1 AND worker_id = $2 AND claim_token = $3
         AND status = 'running' AND lease_expires_at > $4
       FOR UPDATE`,
      [String(row.id), wid, token, now]
    );
    if (!claimRow.rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    const duplicate = await client.query(
      "SELECT 1 FROM job_artifacts WHERE job_id = $1 AND artifact_type = 'deg_markers' LIMIT 1",
      [String(row.id)]
    );
    if (duplicate.rows[0]) throw codedError('DEG_RESULT_EXISTS', 'Job already has a DEG marker result artifact.');
    await insertJobArtifactRow(client, {
      id: markersArtifactId,
      jobRow: row,
      refs,
      artifactType: tblSpec.artifactType,
      name: tbl.name != null ? String(tbl.name) : null,
      description: tbl.description != null ? String(tbl.description) : null,
      mimeType: tbl.mimeType != null ? String(tbl.mimeType) : null,
      storageKind: tblSpec.storageKind,
      storageUri: tblSpec.storageUri,
      checksumSha256: tblSpec.checksumSha256,
      sizeBytes: tblSpec.sizeBytes,
      status: tblSpec.status,
      metadata: tblSpec.metadata
    });
    await insertJobArtifactRow(client, {
      id: summaryArtifactId,
      jobRow: row,
      refs,
      artifactType: smSpec.artifactType,
      name: sm.name != null ? String(sm.name) : null,
      description: sm.description != null ? String(sm.description) : null,
      storageKind: smSpec.storageKind,
      status: smSpec.status,
      metadata: smSpec.metadata
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return {
    markersArtifact: await getJobArtifactRowById(markersArtifactId),
    summaryArtifact: await getJobArtifactRowById(summaryArtifactId)
  };
}

/**
 * Atomically publish the two outputs of enrichment.gsea.v1. The full table stays
 * in private project storage; the second artifact contains only the bridge-sanitized,
 * bounded preview used by the UI. No analysis object or lineage edge is created.
 */
async function completeEnrichmentGseaResultByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = await getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  if (row.job_type !== 'enrichment.gsea.v1') {
    throw codedError('INVALID_JOB_TYPE', 'A claimed enrichment.gsea.v1 job is required.');
  }
  const existing = await query(
    "SELECT 1 FROM job_artifacts WHERE job_id = $1 AND artifact_type = 'enrichment_results' LIMIT 1",
    [String(row.id)]
  );
  if (existing.rows[0]) {
    throw codedError('ENRICHMENT_RESULT_EXISTS', 'Job already has a pathway-enrichment result artifact.');
  }

  const table = input.resultsArtifact && typeof input.resultsArtifact === 'object'
    ? input.resultsArtifact : {};
  const tableSpec = validateLocalInternalArtifactSpec(table, {
    defaultArtifactType: 'enrichment_results',
    helperName: 'completeEnrichmentGseaResultByWorker'
  });
  if (tableSpec.artifactType !== 'enrichment_results') {
    throw codedError('INVALID_ARTIFACT_TYPE', 'The enrichment result artifact type is fixed.');
  }
  assertProjectArtifactStorageKey(row, tableSpec.storageUri, 'artifacts');
  if (tableSpec.sizeBytes > 50 * 1024 * 1024) {
    throw codedError('ENRICHMENT_RESULT_TOO_LARGE', 'Pathway-enrichment result exceeds its safe size limit.');
  }
  const nRows = tableSpec.metadata && tableSpec.metadata.nRows;
  if (!Number.isInteger(nRows) || nRows < 0 || nRows > 100000) {
    throw codedError('INVALID_ENRICHMENT_RESULT', 'Pathway-enrichment result row count is invalid.');
  }

  const summary = input.summaryArtifact && typeof input.summaryArtifact === 'object'
    ? input.summaryArtifact : {};
  const summarySpec = validateMetadataOnlyArtifactSpec(summary, {
    defaultArtifactType: 'enrichment_summary', artifactTypeRequired: false
  });
  if (summarySpec.artifactType !== 'enrichment_summary'
      || summarySpec.storageKind !== 'metadata_only') {
    throw codedError('INVALID_ARTIFACT_TYPE', 'The enrichment summary artifact type is fixed.');
  }
  const encodedSummary = JSON.stringify(summarySpec.metadata);
  if (Buffer.byteLength(encodedSummary, 'utf8') > 128 * 1024) {
    throw codedError('INVALID_ENRICHMENT_SUMMARY', 'Pathway-enrichment summary exceeds its safe size limit.');
  }

  const resultsArtifactId = generateJobArtifactId();
  const summaryArtifactId = generateJobArtifactId();
  const refs = {
    datasetId: row.dataset_id || null,
    analysisObjectId: row.analysis_object_id || null,
    resultAnalysisObjectId: null
  };
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const claimRow = await client.query(
      `SELECT 1 FROM jobs
       WHERE id = $1 AND worker_id = $2 AND claim_token = $3
         AND status = 'running' AND lease_expires_at > $4
       FOR UPDATE`,
      [String(row.id), wid, token, now]
    );
    if (!claimRow.rows[0]) {
      throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    }
    const duplicate = await client.query(
      "SELECT 1 FROM job_artifacts WHERE job_id = $1 AND artifact_type = 'enrichment_results' LIMIT 1",
      [String(row.id)]
    );
    if (duplicate.rows[0]) {
      throw codedError('ENRICHMENT_RESULT_EXISTS', 'Job already has a pathway-enrichment result artifact.');
    }
    await insertJobArtifactRow(client, {
      id: resultsArtifactId,
      jobRow: row,
      refs,
      artifactType: tableSpec.artifactType,
      name: table.name != null ? String(table.name) : null,
      description: table.description != null ? String(table.description) : null,
      mimeType: table.mimeType != null ? String(table.mimeType) : null,
      storageKind: tableSpec.storageKind,
      storageUri: tableSpec.storageUri,
      checksumSha256: tableSpec.checksumSha256,
      sizeBytes: tableSpec.sizeBytes,
      status: tableSpec.status,
      metadata: tableSpec.metadata
    });
    await insertJobArtifactRow(client, {
      id: summaryArtifactId,
      jobRow: row,
      refs,
      artifactType: summarySpec.artifactType,
      name: summary.name != null ? String(summary.name) : null,
      description: summary.description != null ? String(summary.description) : null,
      storageKind: summarySpec.storageKind,
      status: summarySpec.status,
      metadata: summarySpec.metadata
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return {
    resultsArtifact: await getJobArtifactRowById(resultsArtifactId),
    summaryArtifact: await getJobArtifactRowById(summaryArtifactId)
  };
}

/**
 * Atomically publish the two outputs of `cellchat.infer.v1`. The complete
 * ligand-receptor candidate table remains in private project storage; the
 * metadata-only companion is already strictly sanitized by rWorkerBridge and
 * is the only CellChat content exposed through project artifact APIs.
 */
async function completeCellChatInferenceResultByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = await getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  if (row.job_type !== 'cellchat.infer.v1') {
    throw codedError('INVALID_JOB_TYPE', 'A claimed cellchat.infer.v1 job is required.');
  }
  const existing = await query(
    "SELECT 1 FROM job_artifacts WHERE job_id = $1 AND artifact_type = 'cellchat_results' LIMIT 1",
    [String(row.id)]
  );
  if (existing.rows[0]) {
    throw codedError('CELLCHAT_RESULT_EXISTS', 'Job already has a cell-communication result artifact.');
  }

  const table = input.resultsArtifact && typeof input.resultsArtifact === 'object'
    ? input.resultsArtifact : {};
  const tableSpec = validateLocalInternalArtifactSpec(table, {
    defaultArtifactType: 'cellchat_results',
    helperName: 'completeCellChatInferenceResultByWorker'
  });
  if (tableSpec.artifactType !== 'cellchat_results') {
    throw codedError('INVALID_ARTIFACT_TYPE', 'The cell-communication result artifact type is fixed.');
  }
  assertProjectArtifactStorageKey(row, tableSpec.storageUri, 'artifacts');
  if (tableSpec.sizeBytes > 50 * 1024 * 1024) {
    throw codedError('CELLCHAT_RESULT_TOO_LARGE', 'Cell-communication result exceeds its safe size limit.');
  }
  const nRows = tableSpec.metadata && tableSpec.metadata.nRows;
  if (!Number.isInteger(nRows) || nRows < 0 || nRows > MAX_CELLCHAT_RESULT_ROWS) {
    throw codedError('INVALID_CELLCHAT_RESULT', 'Cell-communication result row count is invalid.');
  }

  const summary = input.summaryArtifact && typeof input.summaryArtifact === 'object'
    ? input.summaryArtifact : {};
  const summarySpec = validateMetadataOnlyArtifactSpec(summary, {
    defaultArtifactType: 'cellchat_summary', artifactTypeRequired: false
  });
  if (summarySpec.artifactType !== 'cellchat_summary'
      || summarySpec.storageKind !== 'metadata_only') {
    throw codedError('INVALID_ARTIFACT_TYPE', 'The cell-communication summary artifact type is fixed.');
  }
  const encodedSummary = JSON.stringify(summarySpec.metadata);
  if (Buffer.byteLength(encodedSummary, 'utf8') > 128 * 1024) {
    throw codedError('INVALID_CELLCHAT_SUMMARY', 'Cell-communication summary exceeds its safe size limit.');
  }

  const resultsArtifactId = generateJobArtifactId();
  const summaryArtifactId = generateJobArtifactId();
  const refs = {
    datasetId: row.dataset_id || null,
    analysisObjectId: row.analysis_object_id || null,
    resultAnalysisObjectId: null
  };
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const claimRow = await client.query(
      `SELECT 1 FROM jobs
       WHERE id = $1 AND worker_id = $2 AND claim_token = $3
         AND status = 'running' AND lease_expires_at > $4
       FOR UPDATE`,
      [String(row.id), wid, token, now]
    );
    if (!claimRow.rows[0]) {
      throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    }
    const duplicate = await client.query(
      "SELECT 1 FROM job_artifacts WHERE job_id = $1 AND artifact_type = 'cellchat_results' LIMIT 1",
      [String(row.id)]
    );
    if (duplicate.rows[0]) {
      throw codedError('CELLCHAT_RESULT_EXISTS', 'Job already has a cell-communication result artifact.');
    }
    await insertJobArtifactRow(client, {
      id: resultsArtifactId,
      jobRow: row,
      refs,
      artifactType: tableSpec.artifactType,
      name: table.name != null ? String(table.name) : null,
      description: table.description != null ? String(table.description) : null,
      mimeType: table.mimeType != null ? String(table.mimeType) : null,
      storageKind: tableSpec.storageKind,
      storageUri: tableSpec.storageUri,
      checksumSha256: tableSpec.checksumSha256,
      sizeBytes: tableSpec.sizeBytes,
      status: tableSpec.status,
      metadata: tableSpec.metadata
    });
    await insertJobArtifactRow(client, {
      id: summaryArtifactId,
      jobRow: row,
      refs,
      artifactType: summarySpec.artifactType,
      name: summary.name != null ? String(summary.name) : null,
      description: summary.description != null ? String(summary.description) : null,
      storageKind: summarySpec.storageKind,
      status: summarySpec.status,
      metadata: summarySpec.metadata
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return {
    resultsArtifact: await getJobArtifactRowById(resultsArtifactId),
    summaryArtifact: await getJobArtifactRowById(summaryArtifactId)
  };
}

async function resolveCheckpointArtifact(analysisObjectId, projectId) {
  const { rows } = await query(
    `SELECT * FROM job_artifacts
     WHERE result_analysis_object_id = $1
       AND artifact_type = 'checkpoint'
       AND storage_kind = 'local_internal'
       AND status = 'available'
     ORDER BY created_at ASC, id ASC`,
    [analysisObjectId]
  );
  const candidates = rows.map(rowToJobArtifact).filter((artifact) =>
    (artifact.projectId || null) === (projectId || null));
  if (candidates.length === 0) {
    throw codedError('NO_CHECKPOINT_ARTIFACT', 'No loadable checkpoint for this analysis object.');
  }
  if (candidates.length > 1) {
    throw codedError('AMBIGUOUS_CHECKPOINT', 'Multiple loadable checkpoints; refusing to choose.');
  }
  const artifact = candidates[0];
  if (!isSafeInternalStorageKey(artifact.storageUri)) {
    throw codedError('INVALID_STORAGE_KEY', 'Checkpoint storage key is missing or unsafe.');
  }
  if (String(artifact.storageUri).startsWith('projects/')
      && !storage.isProjectStorageKey(artifact.storageUri, {
        projectId,
        kind: 'checkpoints',
      })) {
    throw codedError('INVALID_STORAGE_KEY', 'Checkpoint storage key is outside the project scope.');
  }
  const checksum = normalizeChecksumSha256(artifact.checksumSha256);
  if (checksum === undefined || checksum === null) {
    throw codedError('INVALID_CHECKSUM', 'Checkpoint checksum is missing or invalid.');
  }
  const sizeBytes = normalizeArtifactSizeBytes(artifact.sizeBytes);
  if (sizeBytes === undefined || sizeBytes === null) {
    throw codedError('INVALID_SIZE', 'Checkpoint size is missing or invalid.');
  }
  return {
    checkpointArtifactId: artifact.id,
    internalStorageKey: artifact.storageUri,
    checksumSha256: checksum,
    sizeBytes,
  };
}

async function getLoadableCheckpointForAnalysisObject(projectId, analysisObjectId, ownerUserId) {
  if (typeof analysisObjectId !== 'string' || analysisObjectId === '') {
    throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  const owner = Number(ownerUserId);
  if (!Number.isInteger(owner) || owner <= 0) {
    throw codedError('INVALID_OWNER', 'A valid owner user id is required.');
  }
  const pid = projectId === undefined || projectId === null || projectId === '' ? null : String(projectId);
  const obj = await getAnalysisObjectForUser(analysisObjectId, owner);
  if (!obj) throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  const objProjectId = obj.projectId || null;
  if (pid) {
    if (objProjectId !== pid) throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  } else if (objProjectId) {
    throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  const checkpoint = await resolveCheckpointArtifact(analysisObjectId, objProjectId);
  return {
    analysisObjectId,
    projectId: objProjectId,
    ...checkpoint,
  };
}

async function getForkableCheckpointForAnalysisObject(userId, projectId, analysisObjectId) {
  await requireProjectRole(userId, projectId, PROJECT_JOB_WRITE_ROLES);
  if (typeof analysisObjectId !== 'string' || !AO_ID_RE.test(analysisObjectId)) {
    throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  const sourceObject = await getProjectAnalysisObjectRow(analysisObjectId, String(projectId));
  if (!sourceObject) throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  const checkpoint = await resolveCheckpointArtifact(analysisObjectId, String(projectId));
  return {
    sourceAnalysisObject: sourceObject,
    analysisObjectId,
    projectId: String(projectId),
    ...checkpoint,
  };
}

async function completeCheckpointForkByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
  const wid = requireWorkerId(workerId);
  const token = requireClaimToken(claimToken);
  const now = normalizeWorkerNow(opts);
  const row = await getJobRowById(jobId);
  if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
  if (!workerHoldsClaim(row, wid, token, now)) {
    throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
  }
  if (row.job_type !== 'checkpoint.fork.v1' || !row.project_id || !row.analysis_object_id) {
    throw codedError('INVALID_JOB_TYPE', 'A project checkpoint fork job is required.');
  }
  if (row.result_analysis_object_id) {
    throw codedError('CHECKPOINT_EXISTS', 'Job already has a fork result object.');
  }
  const resultId = input.resultAnalysisObjectId;
  if (typeof resultId !== 'string' || !AO_ID_RE.test(resultId)) {
    throw codedError('INVALID_RESULT_OBJECT_ID', 'A server-generated result object id is required.');
  }
  const sourceObject = await getProjectAnalysisObjectRow(row.analysis_object_id, row.project_id);
  if (!sourceObject) throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  const checkpoint = await resolveCheckpointArtifact(sourceObject.id, row.project_id);
  if (input.checkpointArtifactId !== checkpoint.checkpointArtifactId) {
    throw codedError('INVALID_CHECKPOINT', 'Checkpoint selection changed before fork completion.');
  }
  const loaded = input.loaded === undefined ? {} : input.loaded;
  assertPlainObject(loaded, 'INVALID_METADATA', 'loaded summary must be a plain JSON object.');
  const resultMetadata = {
    source: 'checkpoint.fork.v1',
    sourceAnalysisObjectId: sourceObject.id,
    sourceCheckpointArtifactId: checkpoint.checkpointArtifactId,
    scientific_output: true,
  };
  const artifactId = generateJobArtifactId();
  const p = await connect();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT 1 FROM analysis_objects WHERE id = $1', [resultId]);
    if (existing.rows[0]) throw codedError('CHECKPOINT_EXISTS', 'Fork result object already exists.');
    await client.query(
      `INSERT INTO analysis_objects
         (id, owner_user_id, project_id, dataset_id, parent_object_id, lineage_root_id,
          object_type, display_name, storage_uri, object_hash, metadata_json,
          created_by_provenance_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, $9, NULL)`,
      [
        resultId,
        Number(row.owner_user_id),
        row.project_id,
        sourceObject.datasetId || null,
        sourceObject.id,
        sourceObject.lineageRootId || sourceObject.id,
        sourceObject.objectType,
        `Fork of ${sourceObject.displayName || sourceObject.id}`,
        JSON.stringify(resultMetadata),
      ]
    );
    const linked = await client.query(
      `UPDATE jobs SET result_analysis_object_id = $1, updated_at = $2
       WHERE id = $3 AND worker_id = $4 AND claim_token = $5
         AND status = 'running' AND lease_expires_at > $2
         AND result_analysis_object_id IS NULL`,
      [resultId, now, String(jobId), wid, token]
    );
    if (linked.rowCount !== 1) {
      throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    }
    await insertLineageEdgeRow(client, {
      projectId: row.project_id,
      parentObjectId: sourceObject.id,
      childObjectId: resultId,
      jobId: String(jobId),
      edgeType: 'checkpoint_fork',
      parentRole: 'primary',
      metadata: { checkpointArtifactId: checkpoint.checkpointArtifactId },
      createdByUserId: Number(row.owner_user_id),
    });
    await insertJobArtifactRow(client, {
      id: artifactId,
      jobRow: row,
      refs: {
        datasetId: sourceObject.datasetId || null,
        analysisObjectId: sourceObject.id,
        resultAnalysisObjectId: resultId,
      },
      artifactType: 'checkpoint_fork',
      name: 'Checkpoint fork summary',
      description: 'Sanitized record of a durable checkpoint fork into a private live session.',
      storageKind: 'metadata_only',
      status: 'available',
      metadata: {
        sourceAnalysisObjectId: sourceObject.id,
        resultAnalysisObjectId: resultId,
        checkpointArtifactId: checkpoint.checkpointArtifactId,
        live_state_mutation: true,
        scientific_output: false,
        loaded,
      },
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return {
    resultObject: await getProjectAnalysisObjectRow(resultId, row.project_id),
    artifact: await getJobArtifactRowById(artifactId),
  };
}

async function createLineageEdgesForChild(actorUserId, childObjectId, parents = []) {
  if (!Array.isArray(parents) || parents.length === 0) {
    throw codedError('INVALID_PARENTS', 'parents must be a non-empty array.');
  }
  const p = await connect();
  const client = await p.connect();
  const createdIds = [];
  try {
    await client.query('BEGIN');
    for (const parent of parents) {
      const edge = await createLineageEdge(actorUserId, { ...parent, childObjectId });
      createdIds.push(edge.id);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const { rows } = await query(
    `SELECT * FROM analysis_object_edges WHERE id = ANY($1::text[])
     ORDER BY created_at ASC, id ASC`,
    [createdIds]
  );
  return rows.map(rowToAnalysisObjectEdge);
}

module.exports = {
  // lifecycle
  isConfigured,
  connect,
  query,
  initSchema,
  checkHealth,
  reportStandaloneWorkerRuntimeState,
  getStandaloneWorkerRuntimeStatus,
  acquireWebTopologyLock,
  acquireStandaloneWorkerLock,
  resetSchemaForTests,
  close,
  // constants / state machine
  JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  INITIAL_JOB_STATUS,
  DEFAULT_WORKER_RUNTIME_STALE_AFTER_MS,
  PROJECT_ROLES,
  ALLOWED_OBJECT_TYPES,
  ALLOWED_JOB_TYPES,
  RETRYABLE_DURABLE_JOB_TYPES,
  ALLOWED_DATASET_FILE_TYPES,
  ALLOWED_ARTIFACT_TYPES,
  validateJobTransition,
  genId,
  isValidObjectType,
  generateAnalysisObjectId,
  isValidJobType,
  isValidJobStatus,
  generateJobId,
  generateClaimToken,
  isValidRole,
  generateOrganizationId,
  generateProjectId,
  generatePipelineDefinitionId,
  isValidPipelineDefinitionId,
  isValidDatasetFileType,
  isValidDatasetUploadStatus,
  isValidDatasetValidationStatus,
  generateDatasetId,
  sanitizeDatasetFilename,
  generateProvenanceId,
  generateFigureId,
  isValidArtifactType,
  isValidArtifactStorageKind,
  isValidArtifactStatus,
  generateJobArtifactId,
  isSafeInternalStorageKey,
  isValidEdgeType,
  isValidParentRole,
  generateAnalysisObjectEdgeId,
  // users
  createUser,
  provisionUserByOperator,
  resetUserPasswordByOperator,
  getUserByEmail,
  verifyUser,
  getUserForSession,
  getUserSessionVersion,
  revokeUserSessions,
  hasPipelineRegistryPublishCapability,
  getPipelineRegistryCapabilities,
  setPipelineRegistryPublisherByEmail,
  // owner-scoped provenance / cache / figures
  saveProvenance,
  getProvenance,
  getAllProvenance,
  getProvenanceChain,
  deleteProvenance,
  makeCacheKey,
  getCachedResult,
  setCachedResult,
  clearCache,
  saveFigure,
  assertSafeFigureFilePath,
  getFiguresByUser,
  deleteFigure,
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
  createOrganizationForUser,
  getOrganizationForUser,
  listOrganizationsForUser,
  verifyOrganizationMember,
  requireOrganizationRole,
  addOrganizationMember,
  createProjectForUser,
  updateProject,
  getProjectMember,
  countProjectOwners,
  addProjectMemberByEmail,
  updateProjectMemberRole,
  removeProjectMember,
  // pipeline definitions
  PIPELINE_REGISTRY_PUBLISH_CAPABILITY,
  toPublicPipelineDefinition,
  listProjectPipelineDefinitions,
  createPipelineRegistryDefinition,
  getProjectPipelineSelection,
  setProjectPipelineSelection,
  // datasets
  createDatasetForProject,
  listDatasetsForProject,
  getDatasetForProject,
  verifyDatasetProjectAccess,
  updateDatasetForProject,
  markDatasetUploaded,
  markDatasetUploadFailed,
  rowToDataset,
  toPublicDataset,
  // analysis objects
  createAnalysisObject,
  createAnalysisObjectForUser,
  createPrivateAnalysisObjectForUser,
  verifyAnalysisObjectOwner,
  getAnalysisObjectForUser,
  getPrivateAnalysisObjectForUser,
  listAnalysisObjectsForUser,
  listPrivateAnalysisObjectsForUser,
  createProjectAnalysisObject,
  listProjectAnalysisObjects,
  getProjectAnalysisObject,
  updateProjectAnalysisObjectSummary,
  rowToAnalysisObject,
  toPublicAnalysisObject,
  // jobs
  createJob,
  createJobForUser,
  createPrivateJobForUser,
  verifyJobOwner,
  cancelJobForUser,
  cancelPrivateJobForUser,
  getJobForUser,
  getPrivateJobForUser,
  listJobsForUser,
  listPrivateJobsForUser,
  createProjectJob,
  listProjectJobs,
  getProjectJob,
  cancelProjectJob,
  transitionJobStatus,
  updateJobStatusForUser,
  appendJobLogForUser,
  getWorkerJob,
  claimNextJob,
  heartbeatJob,
  markRDispatchStartedByWorker,
  completeJobByWorker,
  resumeCommittedJobByWorker,
  failJobByWorker,
  deferIndeterminateRTimeoutByWorker,
  releaseJob,
  appendJobLogByWorker,
  reapExpiredJobs,
  setJobScheduling,
  getOwnedAnalysisObjectForJobByWorker,
  getSeuratPipelineInputsForJobByWorker,
  getLoadableCheckpointForJobByWorker,
  getForkableCheckpointForJobByWorker,
  rowToJob,
  toPublicJob,
  R_TIMEOUT_INDETERMINATE,
  R_TIMEOUT_RECOVERY_PENDING,
  R_DISPATCH_STARTED,
  R_RETRY_RECOVERY_PENDING,
  COMMITTED_OUTPUT_RECOVERY_PENDING,
  // project provenance / figures
  createProjectProvenance,
  listProjectProvenance,
  getProjectProvenance,
  createProjectFigure,
  listProjectFigures,
  getProjectFigure,
  // artifacts
  createArtifact,
  createResultCheckpoint,
  getJobArtifactsByJobId,
  listProjectArtifacts,
  listProjectJobArtifacts,
  getProjectArtifact,
  createJobArtifactByWorker,
  createCheckpointArtifactForJobByWorker,
  createCheckpointForJobByWorker,
  completePbmcPipelineResultByWorker,
  completeSeuratPipelineResultByWorker,
  completeDegFindMarkersResultByWorker,
  completeEnrichmentGseaResultByWorker,
  completeCellChatInferenceResultByWorker,
  getLoadableCheckpointForAnalysisObject,
  getForkableCheckpointForAnalysisObject,
  completeCheckpointForkByWorker,
  rowToJobArtifact,
  toPublicJobArtifact,
  // lineage
  createLineageEdge,
  createLineageEdgesForChild,
  lineageEdgeWouldCreateCycle,
  listLineageParents,
  listLineageChildren,
  listProjectAnalysisObjectParents,
  listProjectAnalysisObjectChildren,
  getProjectAnalysisObjectLineage,
  buildLineageGraph,
  rowToAnalysisObjectEdge
};
