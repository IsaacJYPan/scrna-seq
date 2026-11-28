'use strict';

// The per-user records kept before projects existed: provenance envelopes, the
// results cache keyed by those envelopes, and the personal figure gallery. Every
// row is owned by a normalized email; reads and writes never cross owners, and
// an upsert cannot take over another owner's id.

const crypto = require('crypto');

function createPersonalRecordsStore({ query, codedError, parseJson, requireOwnerEmail, normalizeEmail }) {
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

  return {
    saveProvenance,
    getProvenance,
    getAllProvenance,
    getProvenanceChain,
    deleteProvenance,
    makeCacheKey,
    getCachedResult,
    setCachedResult,
    clearCache,
    assertSafeFigureFilePath,
    saveFigure,
    getFiguresByUser,
    deleteFigure,
  };
}

module.exports = { createPersonalRecordsStore };
