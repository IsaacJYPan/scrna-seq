'use strict';

const storage = require('./storage');
const invalid = () => Object.assign(new Error('Choose a saved-work category, page size from 1 to 50, and valid page cursor.'), { status: 400, code: 'INVALID_SAVED_WORK_PAGE' });
const label = (value, fallback) => [...String(value || fallback)].map(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character).join('').slice(0, 160);
const iso = value => new Date(value).toISOString();
const validSource = (row, projectId) => /^[a-f0-9]{64}$/.test(row.sha || '') && Number.isSafeInteger(Number(row.bytes))
  && Number(row.bytes) >= 0 && storage.isProjectStorageKey(row.key, { projectId });
const reference = row => row.checkpoint && row.object_id
  ? { kind: 'analysis-object', analysisObjectId: row.object_id, checkpointVersionId: row.id, sha256: row.sha }
  : { kind: 'artifact-version', versionId: row.id, sha256: row.sha };

function createExistingWorkCatalog({ transaction, sourceSql }) {
  async function origins(client, projectId, userId, ids) {
    if (!ids.length) return new Map();
    const rows = (await client.query(`SELECT a.id,j.id AS job_id,COALESCE(a.result_analysis_object_id,a.analysis_object_id,j.result_analysis_object_id,j.analysis_object_id) AS object_id,
      NULL::text AS package_digest,NULL::text AS package_id,NULL::text AS package_version
      FROM job_artifacts a JOIN jobs j ON j.id=a.job_id WHERE a.project_id=$1 AND j.project_id=$1
      AND a.created_by_user_id=$2 AND a.id=ANY($3::text[])
      UNION ALL SELECT a.id,j.id,COALESCE(i.analysis_object_id,j.result_analysis_object_id,j.analysis_object_id),i.package_digest,i.package_json->>'id',i.package_json->>'version'
      FROM workflow_artifacts a JOIN jobs j ON j.id=a.job_id LEFT JOIN workflow_runs r ON r.job_id=j.id
      LEFT JOIN workflow_instances i ON i.id=r.instance_id AND i.owner_user_id=$2 AND i.project_id=$1
      WHERE a.project_id=$1 AND j.project_id=$1 AND a.owner_user_id=$2 AND a.id=ANY($3::text[])`, [projectId, userId, ids])).rows;
    return new Map(rows.map(row => [row.id, { jobId: row.job_id, analysisObjectId: row.object_id || null, package: /^[a-f0-9]{64}$/.test(row.package_digest || '')
      ? { digest: row.package_digest, id: label(row.package_id, 'Recorded method'), version: label(row.package_version, 'Unknown version') } : null }]));
  }
  async function list(userId, projectId, options = {}) {
    const kind = options.kind ?? 'objects', limit = Number(options.limit ?? 30);
    if (!['objects', 'results'].includes(kind) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw invalid();
    let cursor;
    if (options.cursor !== undefined) {
      try {
        if (typeof options.cursor !== 'string' || options.cursor.length > 256) throw invalid();
        cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(cursor) || cursor.length !== 3 || cursor[0] !== kind || typeof cursor[1] !== 'string'
            || !/^\d{4}-\d\d-\d\dT/.test(cursor[1]) || !Number.isFinite(Date.parse(cursor[1]))
            || typeof cursor[2] !== 'string' || !(kind === 'objects' ? /^ao_[a-f0-9]{16,40}$/ : /^(av|art|eri)_[a-f0-9]{16,40}$/).test(cursor[2])) throw invalid();
      } catch { throw invalid(); }
    }
    return transaction(userId, projectId, async client => {
      const paging = cursor ? [cursor[1], cursor[2]] : [];
      if (kind === 'objects') {
        // Only established project metadata is shared. Private saved source is
        // resolved solely for the current owner and never inferred from liveState.
        const rows = (await client.query(`SELECT id,owner_user_id,display_name,object_type,created_at FROM analysis_objects
          WHERE project_id=$1 ${cursor ? "AND (date_trunc('milliseconds',created_at),id)<($3::timestamptz,$4::text)" : ''}
          ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $2`, [projectId, limit + 1, ...paging])).rows;
        const selected = rows.slice(0, limit), owned = selected.filter(row => Number(row.owner_user_id) === userId).map(row => row.id);
        const saved = owned.length ? (await client.query(`SELECT DISTINCT ON (object_id) * FROM (${sourceSql}) source
          WHERE checkpoint AND object_id=ANY($3::text[]) ORDER BY object_id,created_at DESC,id DESC`, [projectId, userId, owned])).rows : [];
        const byObject = new Map(saved.filter(row => validSource(row, projectId)).map(row => [row.object_id, row]));
        const origin = await origins(client, projectId, userId, [...byObject.values()].map(row => row.id));
        return page(rows, selected.map(row => {
          const source = byObject.get(row.id), own = Number(row.owner_user_id) === userId;
          return { id: row.id, kind: 'analysis-object', label: label(row.display_name, 'Saved analysis object'), type: label(row.object_type, 'Analysis object'),
            ownerUserId: Number(row.owner_user_id), ownership: own ? 'yours' : 'colleague', reference: source ? reference(source) : null,
            savedState: source ? 'recorded' : own ? 'not-recorded' : 'restricted', liveState: 'not-checked', notebookSource: 'not-linked',
            createdAt: iso(row.created_at), savedAt: source ? iso(source.created_at) : null, origin: source ? origin.get(source.id) || null : null };
        }), kind, limit, projectId);
      }
      const rows = (await client.query(`SELECT * FROM (${sourceSql}) source
        ${cursor ? "WHERE (date_trunc('milliseconds',created_at),id)<($4::timestamptz,$5::text)" : ''}
        ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $3`, [projectId, userId, limit + 1, ...paging])).rows;
      const selected = rows.slice(0, limit), origin = await origins(client, projectId, userId, selected.map(row => row.id));
      // A checkpoint can reference its object only when that object is owned by
      // this account. Other permitted result records remain exact artifact refs.
      const objectIds = selected.filter(row => row.checkpoint && row.object_id).map(row => row.object_id);
      const owned = new Set(objectIds.length ? (await client.query('SELECT id FROM analysis_objects WHERE project_id=$1 AND owner_user_id=$2 AND id=ANY($3::text[])', [projectId, userId, objectIds])).rows.map(row => row.id) : []);
      return page(rows, selected.map(row => ({ id: row.id, kind: 'artifact-version', label: label(row.name, 'Saved result'), type: label(row.type, 'Result'),
        ownerUserId: userId, ownership: 'yours', reference: validSource(row, projectId) ? reference({ ...row, checkpoint: row.checkpoint && owned.has(row.object_id) }) : null,
        savedState: validSource(row, projectId) ? 'recorded' : 'not-recorded', liveState: 'not-checked', notebookSource: 'not-linked',
        createdAt: iso(row.created_at), savedAt: iso(row.created_at), origin: origin.get(row.id) || null })), kind, limit, projectId);
    });
  }
  function page(rows, items, kind, limit, projectId) {
    const last = rows.slice(0, limit).at(-1);
    return { projectId, kind, items, nextCursor: rows.length > limit
      ? Buffer.from(JSON.stringify([kind, iso(last.created_at), last.id])).toString('base64url') : null };
  }
  return { list };
}
module.exports = { createExistingWorkCatalog };
