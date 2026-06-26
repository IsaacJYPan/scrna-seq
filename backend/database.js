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

function saveProvenance(envelope) {
  const prov = envelope.provenance;
  _insertProv().run({
    id: String(prov.id || ''),
    userEmail: normalizeEmail(envelope.userEmail || prov.userEmail),
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

function getProvenance(id, userEmail = null) {
  const row = userEmail
    ? db.prepare('SELECT * FROM provenance WHERE id = ? AND user_email = ?').get(id, normalizeEmail(userEmail))
    : db.prepare('SELECT * FROM provenance WHERE id = ?').get(id);
  if (!row) return null;
  return rowToProvenance(row);
}

function getAllProvenance(userEmail = null) {
  const rows = userEmail
    ? db.prepare('SELECT * FROM provenance WHERE user_email = ? ORDER BY created_at DESC').all(normalizeEmail(userEmail))
    : db.prepare('SELECT * FROM provenance ORDER BY created_at DESC').all();
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
function getProvenanceChain(id, userEmail = null) {
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
function deleteProvenance(id, userEmail = null) {
  const result = userEmail
    ? db.prepare('DELETE FROM provenance WHERE id = ? AND user_email = ?').run(id, normalizeEmail(userEmail))
    : db.prepare('DELETE FROM provenance WHERE id = ?').run(id);
  // Also clean up any cache entries referencing this provenance
  if (userEmail) {
    db.prepare('DELETE FROM results_cache WHERE provenance_id = ? AND user_email = ?').run(id, normalizeEmail(userEmail));
  } else {
    db.prepare('DELETE FROM results_cache WHERE provenance_id = ?').run(id);
  }
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

function getCachedResult(cacheKey, userEmail = null) {
  const row = userEmail
    ? db.prepare('SELECT * FROM results_cache WHERE cache_key = ? AND user_email = ?').get(cacheKey, normalizeEmail(userEmail))
    : db.prepare('SELECT * FROM results_cache WHERE cache_key = ?').get(cacheKey);
  if (!row) return null;
  return {
    cacheKey: row.cache_key,
    provenanceId: row.provenance_id,
    result: JSON.parse(row.result_data)
  };
}

function setCachedResult(cacheKey, provenanceId, resultData, userEmail = '') {
  const normalizedEmail = normalizeEmail(userEmail);
  if (normalizedEmail) {
    const owner = db.prepare('SELECT id FROM provenance WHERE id = ? AND user_email = ?').get(provenanceId, normalizedEmail);
    if (!owner) throw new Error('Cannot cache result for provenance owned by another user.');
  }
  db.prepare(`
    INSERT OR REPLACE INTO results_cache (cache_key, user_email, provenance_id, result_data)
    VALUES (?, ?, ?, ?)
  `).run(cacheKey, normalizedEmail, provenanceId, JSON.stringify(resultData));
}

function clearCache(userEmail = null) {
  if (userEmail) {
    db.prepare('DELETE FROM results_cache WHERE user_email = ?').run(normalizeEmail(userEmail));
    return;
  }
  db.prepare('DELETE FROM results_cache').run();
}

// ── User Authentication ─────────────────────────────────────────

const PBKDF2_ITERATIONS = 600000;

function hashPassword(password, salt) {
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512').toString('hex');
  return `$pbkdf2-sha512$i=${PBKDF2_ITERATIONS}$${salt}$${hash}`;
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

function verifyUser(email, password) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  
  if (!user) {
    return { error: 'No account found with this email.' };
  }

  // Parse the stored hash to see if it uses the new format or fallback to old format
  let storedHash = user.password_hash;
  let isMatch = false;
  
  if (storedHash.startsWith('$pbkdf2-sha512$')) {
    const parts = storedHash.split('$');
    const iters = parseInt(parts[2].split('=')[1], 10);
    const salt = parts[3];
    const hashData = parts[4];
    const attemptHash = crypto.pbkdf2Sync(password, salt, iters, 64, 'sha512').toString('hex');
    isMatch = (attemptHash === hashData);
  } else {
    // Old legacy hash format
    const attemptHash = crypto.pbkdf2Sync(password, user.salt, 100000, 64, 'sha512').toString('hex');
    isMatch = (attemptHash === storedHash);
  }

  if (!isMatch) {
    return { error: 'Incorrect password.' };
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

function saveFigure(record) {
  const userEmail = normalizeEmail(record.userEmail);
  if (!userEmail) throw new Error('Figure user email is required.');

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
    filePath: record.filePath || '',
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

function deleteFigure(id, userEmail = null) {
  const result = userEmail
    ? db.prepare('DELETE FROM figure_collection WHERE id = ? AND user_email = ?').run(id, normalizeEmail(userEmail))
    : db.prepare('DELETE FROM figure_collection WHERE id = ?').run(id);
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
  getFiguresByUser,
  deleteFigure,
  // Analysis objects & lineage
  isValidObjectType,
  generateAnalysisObjectId,
  createAnalysisObjectForUser,
  listAnalysisObjectsForUser,
  getAnalysisObjectForUser,
  verifyAnalysisObjectOwner
};

