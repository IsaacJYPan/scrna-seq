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

  db.exec(`
    CREATE TABLE IF NOT EXISTS provenance (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL DEFAULT '',
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

    CREATE TABLE IF NOT EXISTS figure_collection (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS analysis_objects (
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
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
    -- is server-generated. NOTE: this branch adds the durable record + API
    -- only — there is no worker/queue draining jobs yet (see docs/architecture.md).
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      analysis_object_id TEXT,
      result_analysis_object_id TEXT,
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

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_prov_user ON provenance(user_email);
    CREATE INDEX IF NOT EXISTS idx_cache_user ON results_cache(user_email);
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
  _insertProv().run({
    id: String(prov.id || ''),
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
  'normalize', 'qc_filter', 'pca', 'cluster', 'umap', 'find_markers', 'integrate', 'generic'
]);

const JOB_STATUSES = new Set([
  'created', 'queued', 'running', 'waiting_for_user', 'completed', 'failed', 'canceled'
]);

// completed / failed / canceled are terminal: no outgoing transitions.
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'canceled']);

// Explicit allow-list of state-machine edges. Anything not listed is rejected.
const JOB_TRANSITIONS = {
  created: new Set(['queued', 'canceled']),
  queued: new Set(['running', 'canceled']),
  running: new Set(['completed', 'failed', 'waiting_for_user', 'canceled']),
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
    analysisObjectId: row.analysis_object_id,
    resultAnalysisObjectId: row.result_analysis_object_id,
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

  const id = generateJobId();
  db.prepare(`
    INSERT INTO jobs
      (id, owner_user_id, analysis_object_id, job_type, status, parameters_json)
    VALUES
      (@id, @owner, @analysisObjectId, @jobType, @status, @parametersJson)
  `).run({
    id,
    owner,
    analysisObjectId,
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
  db.prepare(`
    UPDATE jobs SET
      status = @status,
      result_analysis_object_id = @resultId,
      logs_json = @logsJson,
      error_json = @errorJson,
      updated_at = datetime('now'),
      started_at = CASE WHEN @status = 'running' AND started_at IS NULL THEN datetime('now') ELSE started_at END,
      completed_at = CASE WHEN @status IN ('completed', 'failed') THEN datetime('now') ELSE completed_at END,
      canceled_at = CASE WHEN @status = 'canceled' THEN datetime('now') ELSE canceled_at END
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

// ── Cleanup ──────────────────────────────────────────────────────

function closeDatabase() {
  if (db) {
    db.close();
    console.log('[DB] Database closed');
  }
}

module.exports = {
  initDatabase,
  closeDatabase,
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
  appendJobLogForUser
};

