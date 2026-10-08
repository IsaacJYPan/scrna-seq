'use strict';

const { createHash, randomBytes } = require('node:crypto');
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 32 * 1024;

function recordError() {
  return Object.assign(new Error('The completed analysis could not be recorded in execution history.'), { code: 'LIVE_HISTORY_INVALID' });
}

function boundedJson(value, depth = 0) {
  if (depth > 16) throw recordError();
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 10000) throw recordError();
    return value.map(item => boundedJson(item, depth + 1));
  }
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw recordError();
  const result = Object.create(null);
  for (const [key, item] of Object.entries(value).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw recordError();
    result[key] = boundedJson(item, depth + 1);
  }
  return result;
}

function journalRecord(envelope) {
  const provenance = envelope?.provenance;
  const execution = provenance?.execution;
  if (!execution) return null; // Older R services have no verified execution ordering.
  if (provenance.language !== 'R' || typeof provenance.script !== 'string'
      || Buffer.byteLength(provenance.script, 'utf8') > MAX_SOURCE_BYTES
      || !/^[a-f0-9]{64}$/.test(execution.generation)
      || !Number.isSafeInteger(execution.order) || execution.order < 1
      || !Number.isSafeInteger(envelope?.live_state?.live_revision) || envelope.live_state.live_revision < 0
      || typeof provenance.operation !== 'string' || !/^[a-z][a-z0-9.-]{0,79}$/.test(provenance.operation)
      || typeof provenance.languageVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(provenance.languageVersion)
      || typeof provenance.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(provenance.timestamp)
      || !Number.isFinite(Date.parse(provenance.timestamp))
      || !Array.isArray(execution.packages) || execution.packages.length > 128) throw recordError();
  const packages = execution.packages.map(item => {
    if (!item || typeof item.name !== 'string' || !/^[A-Za-z][A-Za-z0-9.]{0,79}$/.test(item.name)
        || (item.version !== null && (typeof item.version !== 'string' || !/^[A-Za-z0-9.+-]{1,80}$/.test(item.version)))) throw recordError();
    return { name: item.name, version: item.version };
  });
  const sourceSha256 = createHash('sha256').update(provenance.script, 'utf8').digest('hex');
  const record = {
    source: { language: 'R', code: provenance.script, sha256: sourceSha256 },
    parameters: boundedJson(provenance.parameters ?? {}),
    environment: { rVersion: provenance.languageVersion, packages },
    target: { kind: 'service', id: 'interactive-r', precision: 'service-process' },
    timestamp: provenance.timestamp,
    status: 'completed',
  };
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) throw recordError();
  return { record, sourceSha256, generation: execution.generation, order: execution.order,
    liveRevision: envelope.live_state.live_revision, operation: provenance.operation };
}

// Called only after a successful, bounded response from the authenticated R
// service and an owned-object proxy admission. There is no browser write route.
async function recordLiveRExecution({ db, req, envelope }) {
  if (!['GET', 'POST'].includes(String(req?.method).toUpperCase()) || !req?.verifiedObjectId || !req?.user?.id) return null;
  const entry = journalRecord(envelope);
  if (!entry) return null;
  const object = await db.getAnalysisObjectForUser(req.verifiedObjectId, req.user.id);
  if (!object?.projectId) return null;
  const id = `lex_${randomBytes(12).toString('hex')}`;
  const { rows } = await db.query(
    `INSERT INTO live_execution_records
      (id, project_id, owner_user_id, analysis_object_id, operation, kernel_generation,
       kernel_order, live_revision, source_sha256, record_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT (project_id, owner_user_id, kernel_generation, kernel_order) DO NOTHING
     RETURNING id`,
    [id, object.projectId, Number(req.user.id), req.verifiedObjectId, entry.operation,
      entry.generation, entry.order, entry.liveRevision, entry.sourceSha256, JSON.stringify(entry.record)]
  );
  if (rows[0]) return { id: rows[0].id, status: 'recorded' };
  const existing = await db.query(
    `SELECT id, source_sha256, analysis_object_id, operation, live_revision, record_json
       FROM live_execution_records WHERE project_id=$1 AND owner_user_id=$2
        AND kernel_generation=$3 AND kernel_order=$4`,
    [object.projectId, Number(req.user.id), entry.generation, entry.order]
  );
  const old = existing.rows[0];
  if (!old || old.source_sha256 !== entry.sourceSha256 || old.analysis_object_id !== req.verifiedObjectId
      || old.operation !== entry.operation || Number(old.live_revision) !== entry.liveRevision
      || JSON.stringify(boundedJson(old.record_json)) !== JSON.stringify(boundedJson(entry.record))) throw recordError();
  return { id: old.id, status: 'recorded' };
}

async function recordLiveRExecutionBounded(options, timeoutMs = 2000) {
  let timer;
  try {
    return await Promise.race([
      recordLiveRExecution(options),
      new Promise((_, reject) => { timer = setTimeout(() => reject(recordError()), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

module.exports = { MAX_RECORD_BYTES, MAX_SOURCE_BYTES, journalRecord, recordLiveRExecution, recordLiveRExecutionBounded };
