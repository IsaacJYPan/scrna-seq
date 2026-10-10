'use strict';

const { timestamp, safeText } = require('./executionHistoryProjection');
const { rowToExecutionReceipt, validatePrivateKernelTarget, executorGeneration } = require('./executionTargets');

const SCHEMA = 'traceomics.run-monitoring.v1';
const LIMITS = Object.freeze({ page: 25, logs: 50, logBytes: 64 * 1024, messageBytes: 2000, detailBytes: 128 * 1024, sampleAgeMs: 15000 });
const READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const JOB_ID = /^job_[a-f0-9]{16,64}$/;
const EXECUTION_ID = /^pex_[a-f0-9]{24}$/;
const HASH = /^[a-f0-9]{64}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const TERMINAL = new Set(['completed', 'failed', 'canceled']);
const UNKNOWN_TARGET = Object.freeze({ kind: 'unknown', id: null, precision: 'unavailable' });
function failure(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
const missing = () => failure('MONITORED_RUN_NOT_FOUND', 'Run not found.', 404);
function bytesText(value, maximum) {
  if (typeof value !== 'string') return '';
  const bytes = Buffer.from(value);
  if (bytes.length <= maximum) return value;
  let end = maximum;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

// Logs are an inspection view, never an unrestricted console transport. Scrub
// complete sensitive spans before applying a UTF-8 budget so truncation cannot
// reveal a credential prefix or leave half of a private path visible.
function scrubLogText(value, maximum = LIMITS.messageBytes) {
  if (typeof value !== 'string') return { text: '', redacted: false, truncated: false };
  let text = Array.from(value).filter(character => { const code = character.charCodeAt(0); return code >= 32 && code !== 127 || [9, 10, 13].includes(code); }).join('');
  text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[Private key omitted]');
  text = text.replace(/-----END [A-Z ]*PRIVATE KEY-----/g, '[Private key omitted]');
  // A tail can begin between PEM lines. Hide isolated long encoded material
  // rather than exposing a key body whose opening marker preceded this page.
  text = text.replace(/^\s*[A-Za-z0-9+/=_-]{40,}\s*$/gm, '[Encoded value omitted]');
  text = text.replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, '[Credential omitted]');
  text = text.replace(/\b(?:https?|ssh|postgres(?:ql)?|mongodb(?:\+srv)?|redis|s3|file):\/\/[^\s"'<>]+/gi, '[Address omitted]');
  text = text.replace(/(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._-]+[\\/])[^\s"'<>)]*/g, '[Path omitted]');
  text = text.replace(/(^|[\s("'=])\/[A-Za-z0-9._~-]+(?:\/[^\s"'<>)]*)?/gm, '$1[Path omitted]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[Credential omitted]');
  text = text.replace(/\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g, '[Credential omitted]');
  const sensitiveLine = /\b(?:(?:api|access|refresh|auth|session)[_-]?)?(?:token|secret|password|passwd|credential|authorization|cookie|claim(?:[_-]?token)?|private[_-]?key|worker[_-]?id|state[_-]?key|session[_-]?id)\b[^\n]*?["']?\s*(?:=|:)/i;
  text = text.split('\n').map(line => sensitiveLine.test(line) ? '[Sensitive log line omitted]' : line).join('\n');
  const redacted = text !== value;
  const bounded = bytesText(text, maximum);
  return { text: bounded, redacted, truncated: bounded !== text };
}
function safeError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = scrubLogText(typeof value.message === 'string' ? value.message : 'The run failed.', 2000);
  return { code: typeof value.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.code) ? value.code : 'RUN_ERROR', message: message.text || 'The run failed.' };
}
function projectLogs(entries, total = entries?.length || 0, options = {}) {
  const source = Array.isArray(entries) ? entries : [];
  const selected = source.slice(-LIMITS.logs);
  const messages = selected.map(entry => typeof entry === 'string' ? entry : typeof entry?.message === 'string' ? entry.message : '');
  const withheld = new Set();
  let inPrivateKey = false;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const begin = message.search(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    const end = message.search(/-----END [A-Z ]*PRIVATE KEY-----/);
    if (inPrivateKey || begin !== -1 || end !== -1) withheld.add(index);
    if (end !== -1) {
      // A page may start halfway through a PEM block. The ending marker also
      // identifies preceding encoded lines, including its short final line.
      for (let previous = index - 1; previous >= 0 && /^\s*[A-Za-z0-9+/=]{8,}\s*$/.test(messages[previous]); previous--) withheld.add(previous);
    }
    if (begin !== -1 && (end === -1 || begin > end)) inPrivateKey = true;
    else if (end !== -1) inPrivateKey = false;
  }
  let budget = LIMITS.logBytes, redacted = false, truncated = total > selected.length || options.truncated === true;
  const reversed = [];
  for (let index = selected.length - 1; index >= 0; index--) {
    const entry = selected[index];
    const clean = withheld.has(index) ? { text: '[Private key omitted]', redacted: true, truncated: false } : scrubLogText(messages[index]);
    redacted ||= clean.redacted; truncated ||= clean.truncated || entry?.oversized === true;
    const item = { ts: timestamp(entry?.ts), level: ['info', 'warn', 'error', 'debug'].includes(entry?.level) ? entry.level : 'info', message: clean.text };
    const size = Buffer.byteLength(JSON.stringify(item));
    if (size > budget) { truncated = true; break; }
    budget -= size; reversed.push(item);
  }
  const items = reversed.reverse();
  const count = Number.isSafeInteger(Number(total)) && Number(total) >= 0 ? Number(total) : source.length;
  return { items, omittedCount: Math.max(0, count - items.length), truncated, redacted,
    available: options.available !== false,
    note: options.note || 'Recent retained logs are bounded and scrubbed. Worker events do not measure scientific completion.' };
}
function dateMs(value) { const ts = timestamp(value); return ts ? Date.parse(ts) : null; }
function duration(start, end) { return start == null || end == null || end < start ? null : Math.min(end - start, Number.MAX_SAFE_INTEGER); }
function summary(row, checkedAt) {
  const kind = row.kind || (EXECUTION_ID.test(row.id) ? 'r-console' : 'job');
  const created = dateMs(row.created_at), started = dateMs(row.started_at);
  const terminal = TERMINAL.has(row.status);
  const ended = dateMs(row.status === 'canceled' ? row.canceled_at : row.completed_at);
  const current = terminal ? ended : Date.parse(checkedAt);
  return { id: row.id, projectId: row.project_id, kind,
    operation: kind === 'r-console' ? 'Free R console command' : safeText(row.job_type, 100) || 'Analysis job',
    status: ['queued', 'running', 'reserved', 'unknown', 'completed', 'failed', 'canceled'].includes(row.status) ? row.status : 'unknown',
    timestamps: { createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at), startedAt: timestamp(row.started_at), completedAt: timestamp(row.completed_at), canceledAt: timestamp(row.canceled_at) },
    timing: { queueElapsedMs: duration(created, started ?? current), runElapsedMs: started === null ? null : duration(started, current), totalElapsedMs: duration(created, current), remainingMs: null } };
}
function unavailableResources(limits = null) {
  return { state: 'unavailable', scope: null, observedAt: null, memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, cpuLimit: null,
    dispatchId: null, kernelGeneration: null, limits,
    note: 'Current resource use is unavailable. Configured limits are separate from measured use.' };
}
function policyLimits(raw) {
  if (!raw || !Number.isSafeInteger(raw.memoryBytes) || raw.memoryBytes < 1 || raw.memoryBytes > 64 * 1024 ** 3
    || !Number.isFinite(raw.cpuLimit) || raw.cpuLimit <= 0 || raw.cpuLimit > 64) return null;
  const result = { memoryBytes: raw.memoryBytes, cpuLimit: raw.cpuLimit };
  for (const key of ['pidsLimit', 'idleTimeoutSeconds', 'maxLifetimeSeconds']) if (Number.isSafeInteger(raw[key]) && raw[key] > 0 && raw[key] <= 86400) result[key] = raw[key];
  return result;
}
function projectObservation(raw, checkedAt, binding, limits = null, executionStartedAt = null) {
  const unknown = unavailableResources(limits);
  const observedAt = timestamp(raw?.observedAt), age = observedAt ? Date.parse(checkedAt) - Date.parse(observedAt) : null;
  if (raw?.state !== 'observed' || raw.scope !== 'r-container' || age === null || age < -1000 || age > LIMITS.sampleAgeMs
    || executionStartedAt !== null && (dateMs(executionStartedAt) === null || Date.parse(observedAt) < dateMs(executionStartedAt))
    || !Number.isSafeInteger(raw.memoryBytes) || raw.memoryBytes < 0 || raw.memoryBytes > 64 * 1024 ** 3
    || !Number.isSafeInteger(raw.memoryLimitBytes) || raw.memoryLimitBytes < 1 || raw.memoryLimitBytes > 64 * 1024 ** 3 || raw.memoryBytes > raw.memoryLimitBytes
    || !Number.isFinite(raw.cpuPercent) || raw.cpuPercent < 0 || raw.cpuPercent > 6400
    || !Number.isFinite(raw.cpuLimit) || raw.cpuLimit <= 0 || raw.cpuLimit > 64) return unknown;
  return { ...unknown, state: 'observed', scope: 'r-container', observedAt, memoryBytes: raw.memoryBytes, memoryLimitBytes: raw.memoryLimitBytes,
    cpuPercent: raw.cpuPercent, cpuLimit: raw.cpuLimit, ...binding,
    note: 'A recent observation of this R container. CPU percentage may exceed 100% when multiple cores are used.' };
}
function workerEvidence(row, checkedAt) {
  const heartbeatAt = timestamp(row.heartbeat_at), lease = dateMs(row.lease_expires_at), heartbeat = dateMs(row.heartbeat_at), current = Date.parse(checkedAt);
  const state = row.kind === 'r-console' ? 'unknown' : row.status !== 'running' ? 'not-running'
    : lease == null || heartbeat == null || heartbeat > current + 1000 ? 'unknown' : lease > current ? 'lease-current' : 'lease-expired';
  return { state, heartbeatAt, leaseExpiresAt: row.kind === 'r-console' ? null : timestamp(row.lease_expires_at), note: row.kind === 'r-console' ? 'Private R commands do not use a batch worker lease.' : 'A current worker lease indicates coordination liveness; it does not prove scientific progress.' };
}

function currentDispatch(row, receipt) {
  const lockedAt = dateMs(row.locked_at), dispatchedAt = dateMs(receipt?.dispatchAt);
  return !!receipt && row.status === 'running' && receipt.attempt === Number(row.attempts)
    && typeof row.worker_id === 'string' && receipt.target.generation === executorGeneration(row.worker_id)
    && lockedAt !== null && dispatchedAt !== null && dispatchedAt >= lockedAt;
}

const JOB_LOG_COLUMNS = `jsonb_array_length(CASE WHEN jsonb_typeof(j.logs_json::jsonb)='array' THEN j.logs_json::jsonb ELSE '[]'::jsonb END) AS log_count,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('ts',LEFT(e.value->>'ts',40),'level',LEFT(e.value->>'level',20),
      'message',CASE WHEN octet_length(e.value->>'message')<=8192 THEN e.value->>'message' ELSE '[Oversized log message omitted]' END,
      'oversized',octet_length(e.value->>'message')>8192) ORDER BY e.ordinality),'[]'::jsonb)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.logs_json::jsonb)='array' THEN j.logs_json::jsonb ELSE '[]'::jsonb END) WITH ORDINALITY e(value,ordinality)
    WHERE e.ordinality>GREATEST(jsonb_array_length(CASE WHEN jsonb_typeof(j.logs_json::jsonb)='array' THEN j.logs_json::jsonb ELSE '[]'::jsonb END)-50,0)) AS logs_tail`;

function createRunMonitoringService(db, options = {}) {
  const now = options.now || Date.now;
  const stamp = () => new Date(now()).toISOString();
  async function access(userId, projectId) {
    if (!PROJECT_ID.test(projectId || '')) throw failure('MONITORING_REQUEST_INVALID', 'Select a valid project.');
    await db.requireProjectRole(userId, projectId, READ_ROLES);
  }
  async function job(userId, projectId, id) {
    return (await db.query(`SELECT j.id,j.project_id,j.owner_user_id,j.job_type,j.status,j.created_at,j.updated_at,j.started_at,j.completed_at,j.canceled_at,
      j.heartbeat_at,j.lease_expires_at,j.attempts,j.worker_id,j.locked_at,j.last_worker_error::jsonb->>'code' AS recovery_code,${JOB_LOG_COLUMNS},
      CASE WHEN octet_length(j.error_json)<=32768 THEN j.error_json ELSE NULL END AS error_json
      FROM jobs j WHERE j.id=$1 AND j.project_id=$2 AND j.owner_user_id=$3`, [id, projectId, userId])).rows[0];
  }
  async function command(userId, projectId, id) {
    return (await db.query(`SELECT e.id,e.project_id,e.owner_user_id,e.status,e.created_at,e.updated_at,e.started_at,e.completed_at,e.kernel_id,e.kernel_generation,e.execution_order,
      CASE WHEN octet_length(e.result_json->>'stdout')<=65536 THEN e.result_json->>'stdout' ELSE NULL END AS stdout,
      octet_length(e.result_json->>'stdout')>65536 AS stdout_omitted,
      CASE WHEN octet_length((e.result_json->'warnings')::text)<=32768 THEN e.result_json->'warnings' ELSE NULL END AS warnings,
      octet_length((e.result_json->'warnings')::text)>32768 AS warnings_omitted,
      CASE WHEN octet_length((e.result_json->'error')::text)<=32768 THEN e.result_json->'error' ELSE NULL END AS error,e.result_json->'truncated' AS result_truncated,
      k.id AS private_kernel_id,k.project_id AS kernel_project_id,k.owner_user_id AS kernel_owner_user_id,k.workspace_id,k.runtime_generation,k.status AS kernel_status,k.active_execution_id,k.resources_json,k.target_json
      FROM private_r_executions e JOIN private_r_kernels k ON k.id=e.kernel_id
      WHERE e.id=$1 AND e.project_id=$2 AND e.owner_user_id=$3 AND k.project_id=$2 AND k.owner_user_id=$3`, [id, projectId, userId])).rows[0];
  }
  async function latestReceipt(userId, projectId, id) {
    const row = (await db.query('SELECT dispatch_id,attempt,operation,dispatch_at,target_json,environment_json FROM job_execution_receipts WHERE job_id=$1 AND project_id=$2 AND owner_user_id=$3 ORDER BY dispatch_order DESC LIMIT 1', [id, projectId, userId])).rows[0];
    if (!row) return { receipt: null, invalid: false };
    try { return { receipt: rowToExecutionReceipt(row), invalid: false }; }
    catch { return { receipt: null, invalid: true }; }
  }
  async function list(userId, projectId, query = {}) {
    await access(userId, projectId);
    if (Object.keys(query).some(key => !['limit', 'before'].includes(key))) throw failure('MONITORING_PAGE_INVALID', 'Choose a supported monitoring page.');
    const limit = Number(query.limit ?? LIMITS.page);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.page || Array.isArray(query.limit)) throw failure('MONITORING_PAGE_INVALID', 'Choose 1–25 runs.');
    let cursor = null;
    if (query.before !== undefined) {
      try {
        if (typeof query.before !== 'string' || query.before.length > 256 || !/^[A-Za-z0-9_-]+$/.test(query.before)) throw new Error();
        cursor = JSON.parse(Buffer.from(query.before, 'base64url').toString());
        if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== 'string' || cursor[0] !== timestamp(cursor[0]) || ![JOB_ID, EXECUTION_ID].some(pattern => pattern.test(cursor[1]))) throw new Error();
      } catch { throw failure('MONITORING_PAGE_INVALID', 'The monitoring cursor is invalid.'); }
    }
    const rows = (await db.query(`SELECT * FROM (
      SELECT j.id,j.project_id,'job'::text AS kind,j.job_type,j.status,date_trunc('milliseconds',j.created_at) AS created_at,j.updated_at,j.started_at,j.completed_at,j.canceled_at
      FROM jobs j WHERE j.project_id=$1 AND j.owner_user_id=$2
      UNION ALL
      SELECT e.id,e.project_id,'r-console'::text AS kind,NULL::text AS job_type,e.status,date_trunc('milliseconds',e.created_at) AS created_at,e.updated_at,e.started_at,e.completed_at,NULL::timestamptz AS canceled_at
      FROM private_r_executions e JOIN private_r_kernels k ON k.id=e.kernel_id WHERE e.project_id=$1 AND e.owner_user_id=$2 AND k.project_id=$1 AND k.owner_user_id=$2
      ) r ${cursor ? 'WHERE (r.created_at,r.id)<($4::timestamptz,$5::text)' : ''} ORDER BY r.created_at DESC,r.id DESC LIMIT $3`, [projectId, userId, limit + 1, ...(cursor || [])])).rows;
    await access(userId, projectId);
    const checkedAt = stamp(), items = rows.slice(0, limit).map(row => summary(row, checkedAt));
    const last = items.at(-1);
    return { schema: SCHEMA, checkedAt, staleAfterMs: 10000, items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.timestamps.createdAt, last.id])).toString('base64url') : null };
  }
  async function get(userId, projectId, id) {
    await access(userId, projectId);
    if (![JOB_ID, EXECUTION_ID].some(pattern => pattern.test(id || ''))) throw missing();
    const isConsole = EXECUTION_ID.test(id);
    let row = await (isConsole ? command : job)(userId, projectId, id);
    if (!row) throw missing();
    let evidence = isConsole ? null : await latestReceipt(userId, projectId, id);
    let raw = null;
    const firstRow = row, firstReceipt = evidence?.receipt;
    const observing = row.status === 'running' && (isConsole ? row.kernel_status === 'running' && row.active_execution_id === row.id && row.runtime_generation === row.kernel_generation : firstReceipt?.target.runtimeKind === 'sandbox-r' && currentDispatch(row, firstReceipt));
    if (observing) {
      try {
        raw = isConsole ? await options.observeKernel?.({ ...row, id: row.private_kernel_id, project_id: row.kernel_project_id, owner_user_id: row.kernel_owner_user_id })
          : await options.observeJob?.(row, firstReceipt);
      } catch { /* Missing telemetry never changes the durable scientific state. */ }
    }
    row = await (isConsole ? command : job)(userId, projectId, id);
    if (!row) throw missing();
    if (!isConsole) evidence = await latestReceipt(userId, projectId, id);
    await access(userId, projectId);
    const checkedAt = stamp(); row.kind = isConsole ? 'r-console' : 'job';
    const detail = { schema: SCHEMA, checkedAt, staleAfterMs: 10000, ...summary(row, checkedAt) };
    detail.target = { ...UNKNOWN_TARGET };
    detail.execution = null; detail.kernel = null;
    let limits = null;
    if (isConsole) {
      if (row.kernel_generation === row.runtime_generation) {
        try { detail.target = validatePrivateKernelTarget(row.target_json); } catch { /* Inconsistent retained targets remain unavailable. */ }
      }
      detail.kernel = { id: row.kernel_id, generation: HASH.test(row.kernel_generation || '') ? row.kernel_generation : null, order: Number(row.execution_order), status: row.kernel_status };
      limits = row.kernel_generation === row.runtime_generation ? policyLimits(row.resources_json) : null;
    } else if (evidence.receipt) {
      detail.target = evidence.receipt.target;
      detail.execution = { dispatchId: evidence.receipt.dispatchId, attempt: evidence.receipt.attempt, dispatchAt: evidence.receipt.dispatchAt };
    }
    const same = row.status === 'running' && firstRow.status === 'running' && (isConsole
      ? row.kernel_status === 'running' && row.active_execution_id === row.id && row.runtime_generation === row.kernel_generation && row.kernel_generation === firstRow.kernel_generation
      : !!firstReceipt && evidence.receipt?.dispatchId === firstReceipt.dispatchId && currentDispatch(row, evidence.receipt));
    detail.resources = same ? projectObservation(raw, checkedAt, isConsole ? { kernelGeneration: row.kernel_generation } : { dispatchId: evidence.receipt.dispatchId }, limits,
      isConsole ? row.started_at : evidence.receipt.dispatchAt) : unavailableResources(limits);
    detail.progress = { state: row.status === 'completed' ? 'complete' : 'unknown', percent: row.status === 'completed' ? 100 : null, remainingMs: null,
      note: row.status === 'completed' ? 'The server retained a completed outcome.' : row.recovery_code === 'R_TIMEOUT_INDETERMINATE'
        ? 'The server is reconciling an unconfirmed execution outcome. Scientific progress and remaining time are unknown.'
        : 'Scientific progress and remaining time are unknown. Elapsed time and worker liveness do not estimate completion.' };
    detail.worker = workerEvidence(row, checkedAt);
    if (isConsole) {
      const cleanStdout = scrubLogText(row.stdout, 65536);
      const stdout = cleanStdout.text.split(/\r?\n/).filter(Boolean).map(message => ({ ts: row.completed_at, level: 'info', message }));
      const warnings = Array.isArray(row.warnings) ? row.warnings.slice(0, 100).map(message => ({ ts: row.completed_at, level: 'warn', message })) : [];
      detail.logs = projectLogs([...stdout, ...warnings], stdout.length + warnings.length, { available: row.stdout != null || row.warnings != null, truncated: row.result_truncated === true || row.stdout_omitted === true || row.warnings_omitted === true,
        note: row.status === 'running' ? 'Console output is retained when the command finishes; streaming output is unavailable.' : 'Retained console output is bounded and scrubbed. Tables and figures remain in the command journal.' });
      detail.error = safeError(row.error);
      detail.logs.redacted ||= cleanStdout.redacted;
    } else {
      detail.logs = projectLogs(row.logs_tail, Number(row.log_count));
      let error = null; try { error = typeof row.error_json === 'string' ? JSON.parse(row.error_json) : row.error_json; } catch { /* Do not expose malformed error payloads. */ }
      detail.error = safeError(error);
    }
    if (Buffer.byteLength(JSON.stringify(detail)) > LIMITS.detailBytes) throw failure('MONITORING_RESPONSE_INVALID', 'Run monitoring is temporarily unavailable.', 503);
    return detail;
  }
  return Object.freeze({ list, get });
}

module.exports = { SCHEMA, LIMITS, createRunMonitoringService, scrubLogText, projectLogs, safeError, projectObservation, policyLimits, summary };
