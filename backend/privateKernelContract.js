'use strict';

const { createHash } = require('node:crypto');
const { imageDimensions } = require('./artifactPreviews');
const { validateEnvironmentReference, assertEnvironmentMatches } = require('./rEnvironment');
const LIMITS = Object.freeze({ sourceBytes: 32768, resultBytes: 1048576, stdoutBytes: 65536, diagnosticBytes: 8192, tables: 2, rows: 100, columns: 30, cellCharacters: 2000, figures: 4, imageBytes: 262144, imagePixels: 12000000, executions: 500, inputs: 5, inputBytes: 250 * 1024 * 1024 });
const KERNEL_ID = /^pk_[a-f0-9]{24}$/;
const EXECUTION_ID = /^pex_[a-f0-9]{24}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
function kernelError(code, message, status = 400) { return Object.assign(new Error(message), { code, status, publicSafeHandlerError: true }); }
function invalid() { throw kernelError('PRIVATE_KERNEL_RESPONSE_INVALID', 'The private R runtime returned an invalid response. Its execution state must be checked before continuing.', 502); }
function utc(value) { if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) invalid(); return new Date(value).toISOString(); }
function text(value, maximum) { if (typeof value !== 'string' || Buffer.byteLength(value) > maximum || value.includes('\0')) invalid(); return value; }
function source(value) { if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > LIMITS.sourceBytes) throw kernelError('PRIVATE_KERNEL_SOURCE_INVALID', 'Select 1–32768 UTF-8 bytes of R source.'); return value; }
function scope(row) { return { ownerUserId: Number(row.owner_user_id), projectId: row.project_id, workspaceId: row.workspace_id, ...(row.runtime_generation ? { generation: row.runtime_generation } : {}) }; }
function identities(raw, expected) {
  if (!raw || raw.ok !== true || raw.kernelId !== expected.id || !HASH.test(raw.generation || '') || expected.runtime_generation && raw.generation !== expected.runtime_generation) invalid();
  return { ok: true, kernelId: raw.kernelId, generation: raw.generation };
}
function state(raw, expected) {
  const identity = identities(raw, expected);
  if (!['starting', 'ready', 'executing', 'unknown', 'stopped'].includes(raw.status)) invalid();
  const environment = validateEnvironmentReference(raw.environment); assertEnvironmentMatches(expected.environment_json, environment);
  const resources = {};
  for (const key of ['memoryBytes', 'pidsLimit', 'idleTimeoutSeconds', 'maxLifetimeSeconds']) { if (!Number.isSafeInteger(raw.resources?.[key]) || raw.resources[key] < 1) invalid(); resources[key] = raw.resources[key]; }
  if (!Number.isFinite(raw.resources?.cpuLimit) || raw.resources.cpuLimit <= 0 || raw.resources.cpuLimit > 8) invalid(); resources.cpuLimit = raw.resources.cpuLimit;
  if (resources.memoryBytes > 8 * 1024 ** 3 || resources.pidsLimit > 1024 || resources.idleTimeoutSeconds > 3600 || resources.maxLifetimeSeconds > 14400) invalid();
  if (raw.target?.kind !== 'service' || typeof raw.target.id !== 'string' || !/^[a-z][a-z0-9.-]{0,79}$/.test(raw.target.id) || !HASH.test(raw.target.generation || '')) invalid();
  return { ...identity, status: raw.status, environment, resources, target: { kind: 'service', id: raw.target.id, generation: raw.target.generation }, startedAt: utc(raw.startedAt), expiresAt: utc(raw.expiresAt), ...(raw.lastExecution ? { lastExecution: raw.lastExecution } : {}) };
}
function result(raw, expected, execution) {
  const identity = identities(raw, expected);
  if (raw.executionId !== execution.id || raw.order !== Number(execution.execution_order) || !['completed', 'failed', 'executing', 'unknown'].includes(raw.status)) invalid();
  if (['executing', 'unknown'].includes(raw.status)) return { ...identity, executionId: execution.id, order: raw.order, status: raw.status };
  if (Buffer.byteLength(JSON.stringify(raw)) > LIMITS.resultBytes) invalid();
  const stdout = text(raw.stdout, LIMITS.stdoutBytes);
  if (!Array.isArray(raw.warnings) || raw.warnings.length > 100) invalid();
  const warnings = raw.warnings.map(value => text(value, LIMITS.diagnosticBytes));
  if (Buffer.byteLength(JSON.stringify(warnings)) > LIMITS.diagnosticBytes) invalid();
  const error = raw.error == null ? null : { message: text(raw.error.message, LIMITS.diagnosticBytes), ...(typeof raw.error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(raw.error.code) ? { code: raw.error.code } : {}) };
  if (!Array.isArray(raw.tables) || raw.tables.length > LIMITS.tables || !Array.isArray(raw.figures) || raw.figures.length > LIMITS.figures) invalid();
  const tables = raw.tables.map(table => {
    if (!Array.isArray(table.columns) || !table.columns.length || table.columns.length > LIMITS.columns || !Array.isArray(table.rows) || table.rows.length > LIMITS.rows) invalid();
    const columns = table.columns.map(value => text(value, 160)); if (new Set(columns).size !== columns.length || columns.some(value => !value)) invalid();
    const rows = table.rows.map(row => { if (!Array.isArray(row) || row.length !== columns.length) invalid(); return row.map(value => { if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value; if (typeof value === 'string' && value.length <= LIMITS.cellCharacters) return value; invalid(); }); });
    return { name: typeof table.name === 'string' ? text(table.name, 160) : 'R table', columns, rows, truncated: table.truncated === true };
  });
  const figures = raw.figures.map(figure => {
    if (figure.mimeType !== 'image/png' || typeof figure.data !== 'string' || figure.data.length > Math.ceil(LIMITS.imageBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(figure.data)) invalid();
    const bytes = Buffer.from(figure.data, 'base64'); const dimensions = imageDimensions(bytes, 'org.w3.png');
    if (!bytes.length || bytes.length > LIMITS.imageBytes || digest(bytes) !== figure.sha256 || dimensions.width !== figure.width || dimensions.height !== figure.height || !dimensions.width || !dimensions.height || dimensions.width > 8192 || dimensions.height > 8192 || dimensions.width * dimensions.height > LIMITS.imagePixels) invalid();
    return { mimeType: 'image/png', data: figure.data, width: dimensions.width, height: dimensions.height, sha256: figure.sha256 };
  });
  return { ...identity, executionId: execution.id, order: raw.order, status: raw.status, stdout, warnings, error, tables, figures, truncated: raw.truncated === true, startedAt: utc(raw.startedAt), completedAt: utc(raw.completedAt) };
}
function validatePrivateKernelStatus(raw, expected = {}) {
  return state(raw, { id: expected.kernelId || raw?.kernelId, runtime_generation: expected.generation, environment_json: expected.environment || raw?.environment });
}
function validatePrivateKernelExecutionResult(raw, expected = {}) {
  return result(raw, { id: expected.kernelId || raw?.kernelId, runtime_generation: expected.generation || raw?.generation }, { id: expected.executionId || raw?.executionId, execution_order: expected.order ?? raw?.order });
}
module.exports = { LIMITS, KERNEL_ID, EXECUTION_ID, HASH, UUID, digest, kernelError, utc, source, scope, state, result, validatePrivateKernelStatus, validatePrivateKernelExecutionResult };
