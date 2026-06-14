/**
 * SQLite Database Module (runs in Electron main process)
 * 
 * Stores provenance records and cached results persistently.
 * Uses better-sqlite3 for synchronous, fast SQLite access.
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
  `);

  // ── Schema migration: add 'operation' column if missing (for pre-existing DBs) ──
  const cols = db.prepare("PRAGMA table_info(provenance)").all().map(c => c.name);
  if (!cols.includes('operation')) {
    db.exec("ALTER TABLE provenance ADD COLUMN operation TEXT DEFAULT 'unknown'");
    console.log('[DB] Migrated: added operation column to provenance table');
  }

  console.log('[DB] Database initialized at', dbPath);
  return db;
}

// ── Provenance CRUD ──────────────────────────────────────────────

const _insertProv = () => db.prepare(`
  INSERT OR REPLACE INTO provenance
    (id, timestamp, language, language_version, packages, script, parameters, parent_ids, operation)
  VALUES
    (@id, @timestamp, @language, @languageVersion, @packages, @script, @parameters, @parentIds, @operation)
`);

function saveProvenance(envelope) {
  const prov = envelope.provenance;
  _insertProv().run({
    id: String(prov.id || ''),
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

function getProvenance(id) {
  const row = db.prepare('SELECT * FROM provenance WHERE id = ?').get(id);
  if (!row) return null;
  return rowToProvenance(row);
}

function getAllProvenance() {
  const rows = db.prepare('SELECT * FROM provenance ORDER BY created_at DESC').all();
  return rows.map(rowToProvenance);
}

function rowToProvenance(row) {
  return {
    id: row.id,
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
function getProvenanceChain(id) {
  const visited = new Set();
  const ordered = [];

  function walk(currentId) {
    if (visited.has(currentId)) return;
    visited.add(currentId);

    const prov = getProvenance(currentId);
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
function deleteProvenance(id) {
  db.prepare('DELETE FROM provenance WHERE id = ?').run(id);
  // Also clean up any cache entries referencing this provenance
  db.prepare('DELETE FROM results_cache WHERE provenance_id = ?').run(id);
}

/**
 * Delete all provenance records created after a given timestamp.
 * Used for cascade invalidation when re-running a pipeline step.
 */
function deleteProvenanceAfter(timestamp) {
  // Get IDs to delete (for cache cleanup)
  const rows = db.prepare('SELECT id FROM provenance WHERE created_at > ?').all(timestamp);
  const ids = rows.map(r => r.id);
  
  if (ids.length > 0) {
    // Delete cache entries
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM results_cache WHERE provenance_id IN (${placeholders})`).run(...ids);
    // Delete provenance records
    db.prepare(`DELETE FROM provenance WHERE created_at > ?`).run(timestamp);
  }
  return ids;
}

/**
 * Delete provenance records by operation names that come after a given step.
 * E.g., if re-running 'normalize', delete 'pca', 'cluster', 'umap' records.
 */
function deleteDownstreamProvenance(operationNames) {
  if (!operationNames || operationNames.length === 0) return [];
  const placeholders = operationNames.map(() => '?').join(',');
  
  // Find records by checking if the parameters JSON contains the operation field
  // Since we store operation in the envelope, we search by the script/parameters
  const rows = db.prepare(
    `SELECT id FROM provenance WHERE operation IN (${placeholders})`
  ).all(...operationNames);
  
  return rows.map(r => r.id);
}

// ── Results Cache ────────────────────────────────────────────────

/**
 * Generate a cache key from operation name + parameters + data version + parent dependencies.
 */
function makeCacheKey(operation, params, dataVersion, parentIds = []) {
  const payload = JSON.stringify({ operation, params, dataVersion, parentIds });
  return crypto.createHash('sha256').update(payload).digest('hex').substring(0, 16);
}

function getCachedResult(cacheKey) {
  const row = db.prepare('SELECT * FROM results_cache WHERE cache_key = ?').get(cacheKey);
  if (!row) return null;
  return {
    cacheKey: row.cache_key,
    provenanceId: row.provenance_id,
    result: JSON.parse(row.result_data)
  };
}

function setCachedResult(cacheKey, provenanceId, resultData) {
  db.prepare(`
    INSERT OR REPLACE INTO results_cache (cache_key, provenance_id, result_data)
    VALUES (?, ?, ?)
  `).run(cacheKey, provenanceId, JSON.stringify(resultData));
}

function clearCache() {
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
  db.prepare(`
    INSERT OR REPLACE INTO figure_collection
      (id, user_email, object_id, plot_type, title, params_json, file_path, file_format, thumbnail_b64)
    VALUES
      (@id, @userEmail, @objectId, @plotType, @title, @paramsJson, @filePath, @fileFormat, @thumbnailB64)
  `).run({
    id: record.id,
    userEmail: record.userEmail || '',
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
  ).all(email.trim().toLowerCase());
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

function deleteFigure(id) {
  db.prepare('DELETE FROM figure_collection WHERE id = ?').run(id);
  return true;
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
  deleteProvenanceAfter,
  makeCacheKey,
  getCachedResult,
  setCachedResult,
  clearCache,
  createUser,
  verifyUser,
  getUserByEmail,
  saveFigure,
  getFiguresByUser,
  deleteFigure
};

