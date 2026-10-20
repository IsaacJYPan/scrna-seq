'use strict';

const crypto = require('node:crypto');
const pendingContract = import('../shared/notebookPending.mjs');
const digest = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const iso = value => new Date(value).toISOString();

function createNotebookPendingService({ transaction, writable, head, validateScope, receipt, writeSource }) {
  const scopeArgs = (userId, projectId, analysisId) => [projectId, analysisId, userId];
  const slotKey = documentId => documentId || 'create';
  const selection = (includePayload = true) => `SELECT s.project_id,s.analysis_id,s.owner_user_id,s.slot_key,s.journal_version,s.request_id,
    s.created_at,s.updated_at${includePayload ? ',s.payload_json' : ''},r.document_id,r.action,r.admitted_version,r.request_sha256,r.confirmed_draft_version,
    r.state,r.failure_json,r.result_document_id,r.result_version_id,v.version AS result_version,v.sha256 AS result_sha256
    FROM research_document_pending s JOIN research_document_pending_requests r
    USING(project_id,analysis_id,owner_user_id,request_id)
    LEFT JOIN research_document_revisions v ON v.document_id=r.result_document_id AND v.id=r.result_version_id`;

  function metadata(row) {
    if (!row) return null;
    return { schema: 'traceomics.notebook-pending.v1', visibility: 'private', ownerUserId: Number(row.owner_user_id),
      projectId: row.project_id, analysisId: row.analysis_id, documentId: row.document_id, action: row.action,
      journalVersion: row.journal_version === undefined ? undefined : Number(row.journal_version), admittedVersion: Number(row.admitted_version),
      requestId: row.request_id, requestSha256: row.request_sha256,
      confirmedDraftVersion: row.confirmed_draft_version === null ? null : Number(row.confirmed_draft_version), state: row.state,
      outcome: row.result_document_id ? { documentId: row.result_document_id, versionId: row.result_version_id,
        version: Number(row.result_version), sha256: row.result_sha256 } : null,
      failure: row.failure_json ? { code: row.failure_json.code, message: row.failure_json.message,
        submittedExpectedVersion: row.failure_json.submittedExpectedVersion } : null,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
  }

  async function readSlot(client, userId, projectId, analysisId, documentId) {
    return (await client.query(`${selection()} WHERE s.project_id=$1 AND s.analysis_id=$2 AND s.owner_user_id=$3 AND s.slot_key=$4`,
      [...scopeArgs(userId, projectId, analysisId), slotKey(documentId)])).rows[0];
  }
  async function readReservation(client, userId, projectId, analysisId, requestId) {
    return (await client.query(`SELECT r.*,v.version AS result_version,v.sha256 AS result_sha256 FROM research_document_pending_requests r
      LEFT JOIN research_document_revisions v ON v.document_id=r.result_document_id AND v.id=r.result_version_id
      WHERE r.project_id=$1 AND r.analysis_id=$2 AND r.owner_user_id=$3 AND r.request_id=$4`,
    [...scopeArgs(userId, projectId, analysisId), requestId])).rows[0];
  }
  async function lockRequest(client, userId, projectId, analysisId, requestId) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`notebook:${projectId}:${analysisId}:${userId}:${requestId}`]);
  }
  async function lockSlot(client, userId, projectId, analysisId, documentId) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`notebook-pending:${projectId}:${analysisId}:${userId}:${slotKey(documentId)}`]);
  }
  function response(row, accepted, result, replayed = false) {
    const journal = row ? { ...metadata(row), payload: row.payload_json, failure: row.failure_json } : null;
    return { journal, journalVersion: Number(row?.journal_version || 0), replayed,
      ...(accepted ? { admission: metadata(accepted) } : {}), ...(result ? { result } : {}) };
  }
  async function existingScope(client, userId, projectId, analysisId, documentId) {
    if (documentId) await head(client, projectId, analysisId, documentId);
  }

  async function getPending(userId, projectId, analysisId, documentId = null) {
    await validateScope(projectId, analysisId, documentId || undefined);
    return transaction(userId, projectId, analysisId, async client => {
      await existingScope(client, userId, projectId, analysisId, documentId);
      return response(await readSlot(client, userId, projectId, analysisId, documentId));
    });
  }

  async function listPending(userId, projectId, analysisId, options = {}) {
    const limit = Number(options.limit ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw failure('INVALID_NOTEBOOK_PAGE', 'Choose a pending source page size from 1 to 100.');
    let cursor;
    if (options.cursor !== undefined) {
      try {
        if (typeof options.cursor !== 'string' || options.cursor.length > 256) throw new Error();
        cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(cursor) || cursor.length !== 3 || ![0, 1].includes(cursor[0])
            || typeof cursor[1] !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(cursor[1]) || !Number.isFinite(Date.parse(cursor[1]))
            || typeof cursor[2] !== 'string' || !/^(create|doc_[a-f0-9]{24})$/.test(cursor[2])) throw new Error();
      } catch { throw failure('INVALID_NOTEBOOK_PAGE', 'The pending source page cursor is invalid.'); }
    }
    return transaction(userId, projectId, analysisId, async client => {
      // Create is always first, including an already successful reply lost at
      // shutdown. Other slots are bounded and source-free in this discovery API.
      const rank = "CASE WHEN s.slot_key='create' THEN 1 ELSE 0 END";
      const rows = (await client.query(`${selection(false)} WHERE s.project_id=$1 AND s.analysis_id=$2 AND s.owner_user_id=$3
        ${cursor ? `AND (${rank},date_trunc('milliseconds',s.updated_at),s.slot_key)<($5::integer,$6::timestamptz,$7::text)` : ''}
        ORDER BY ${rank} DESC,date_trunc('milliseconds',s.updated_at) DESC,s.slot_key DESC LIMIT $4`,
      [...scopeArgs(userId, projectId, analysisId), limit + 1, ...(cursor || [])])).rows;
      const selected = rows.slice(0, limit), last = selected.at(-1);
      return { journals: selected.map(metadata), nextCursor: rows.length > limit
        ? Buffer.from(JSON.stringify([last.slot_key === 'create' ? 1 : 0, iso(last.updated_at), last.slot_key])).toString('base64url') : null };
    });
  }

  async function admitPending(userId, projectId, analysisId, documentId, input) {
    await validateScope(projectId, analysisId, documentId || undefined);
    const schema = await pendingContract, action = documentId ? 'save' : 'create';
    const parsed = schema.normalizeNotebookPendingAdmission(action, input);
    const requestHash = digest(schema.canonicalNotebookPendingRequest({ action, projectId, analysisId, documentId, payload: parsed.payload }));
    const admissionHash = digest(JSON.stringify({ requestHash, confirmedDraftVersion: parsed.confirmedDraftVersion }));
    return transaction(userId, projectId, analysisId, async (client, access) => {
      // All operations lock the original shared UUID before their slot/document.
      await lockRequest(client, userId, projectId, analysisId, parsed.payload.requestId);
      await lockSlot(client, userId, projectId, analysisId, documentId);
      await existingScope(client, userId, projectId, analysisId, documentId);
      const row = await readSlot(client, userId, projectId, analysisId, documentId);
      const accepted = await readReservation(client, userId, projectId, analysisId, parsed.payload.requestId);
      if (accepted) {
        if (accepted.admission_sha256 !== admissionHash || accepted.slot_key !== slotKey(documentId)) {
          throw failure('NOTEBOOK_PENDING_REQUEST_CONFLICT', 'This request already admitted different source or private checkpoint metadata. Recover the original submission before saving again.', 409);
        }
        const result = accepted.state === 'succeeded' ? await receipt(client, userId, projectId, analysisId, accepted.request_id, requestHash) : null;
        return response(row, accepted, result, true);
      }
      const saved = await receipt(client, userId, projectId, analysisId, parsed.payload.requestId, requestHash);
      if (!saved) writable(access);
      if (Number(row?.journal_version || 0) !== parsed.expectedJournalVersion || row?.state === 'pending') {
        throw Object.assign(failure('NOTEBOOK_PENDING_CONFLICT', row?.state === 'pending'
          ? 'Another source submission is still pending. Resolve that exact request before saving another.'
          : 'This pending source slot changed in another window. Review its current submission before continuing.', 409),
        { currentJournal: response(row).journal, currentJournalVersion: Number(row?.journal_version || 0) });
      }
      const version = Number(row?.journal_version || 0) + 1;
      await client.query(`INSERT INTO research_document_pending_requests
        (project_id,analysis_id,owner_user_id,request_id,slot_key,document_id,action,admitted_version,request_sha256,
          admission_sha256,confirmed_draft_version,state,result_document_id,result_version_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [...scopeArgs(userId, projectId, analysisId), parsed.payload.requestId, slotKey(documentId), documentId, action, version,
        requestHash, admissionHash, parsed.confirmedDraftVersion, saved ? 'succeeded' : 'pending',
        saved?.submission.documentId || null, saved?.submission.versionId || null]);
      await client.query(`INSERT INTO research_document_pending
        (project_id,analysis_id,owner_user_id,slot_key,journal_version,request_id,payload_json) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(project_id,analysis_id,owner_user_id,slot_key) DO UPDATE
          SET journal_version=EXCLUDED.journal_version,request_id=EXCLUDED.request_id,payload_json=EXCLUDED.payload_json,updated_at=clock_timestamp()`,
      [...scopeArgs(userId, projectId, analysisId), slotKey(documentId), version, parsed.payload.requestId,
        saved ? null : JSON.stringify(parsed.payload)]);
      return response(await readSlot(client, userId, projectId, analysisId, documentId),
        await readReservation(client, userId, projectId, analysisId, parsed.payload.requestId), saved);
    });
  }

  async function submitPending(userId, projectId, analysisId, documentId, input) {
    await validateScope(projectId, analysisId, documentId || undefined);
    const parsed = (await pendingContract).normalizeNotebookPendingSubmit(input);
    return transaction(userId, projectId, analysisId, async (client, access) => {
      await lockRequest(client, userId, projectId, analysisId, parsed.requestId);
      await lockSlot(client, userId, projectId, analysisId, documentId);
      await existingScope(client, userId, projectId, analysisId, documentId);
      let row = await readSlot(client, userId, projectId, analysisId, documentId);
      let accepted = await readReservation(client, userId, projectId, analysisId, parsed.requestId);
      if (!accepted || accepted.slot_key !== slotKey(documentId) || Number(accepted.admitted_version) !== parsed.admittedVersion) {
        throw failure('NOTEBOOK_PENDING_NOT_FOUND', 'That exact private source submission was not found.', 404);
      }
      if (accepted.state === 'rejected') return response(row, accepted, null, true);
      const saved = await receipt(client, userId, projectId, analysisId, accepted.request_id, accepted.request_sha256);
      if (accepted.state === 'succeeded') return response(row, accepted, saved, true);
      if (!row || row.request_id !== parsed.requestId || Number(row.journal_version) !== parsed.admittedVersion || !row.payload_json) {
        throw failure('NOTEBOOK_PENDING_UNAVAILABLE', 'The exact pending source could not be confirmed. Keep this request and check again.', 500);
      }
      let result = saved, rejected = null;
      if (!result) {
        try { result = await writeSource(client, access, userId, projectId, analysisId, documentId, accepted.action, row.payload_json); }
        catch (error) {
          if (error.code !== 'NOTEBOOK_VERSION_CONFLICT') {
            error.currentJournal = response(row).journal; error.currentJournalVersion = Number(row.journal_version); throw error;
          }
          rejected = { code: error.code, message: error.message, currentHead: error.currentHead, submittedExpectedVersion: error.submittedExpectedVersion };
        }
      }
      await client.query(`UPDATE research_document_pending_requests SET state=$5,failure_json=$6,result_document_id=$7,
        result_version_id=$8,updated_at=clock_timestamp() WHERE project_id=$1 AND analysis_id=$2 AND owner_user_id=$3 AND request_id=$4`,
      [...scopeArgs(userId, projectId, analysisId), parsed.requestId, rejected ? 'rejected' : 'succeeded',
        rejected ? JSON.stringify(rejected) : null, result?.submission.documentId || null, result?.submission.versionId || null]);
      await client.query(`UPDATE research_document_pending SET journal_version=journal_version+1,
        payload_json=CASE WHEN $5::boolean THEN payload_json ELSE NULL END,updated_at=clock_timestamp()
        WHERE project_id=$1 AND analysis_id=$2 AND owner_user_id=$3 AND slot_key=$4 AND request_id=$6 AND journal_version=$7`,
      [...scopeArgs(userId, projectId, analysisId), slotKey(documentId), Boolean(rejected), parsed.requestId, parsed.admittedVersion]);
      row = await readSlot(client, userId, projectId, analysisId, documentId);
      accepted = await readReservation(client, userId, projectId, analysisId, parsed.requestId);
      return response(row, accepted, result);
    });
  }

  return { getPending, listPending, admitPending, submitPending };
}

module.exports = { createNotebookPendingService };
