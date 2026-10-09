'use strict';

const { randomBytes, createHash } = require('node:crypto');
const { validateEnvironmentReference } = require('./rEnvironment');
const SERVICE_ID = /^svc_[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const RUNTIME_KINDS = new Set(['guided-r', 'sandbox-r', 'private-r', 'service']);
function invalid() {
  return Object.assign(new Error('Execution target evidence is unavailable or invalid.'), { code: 'EXECUTION_RECEIPT_INVALID' });
}
function serviceLabel(value = process.env.EXECUTION_SERVICE_LABEL || 'Analysis server') {
  if (typeof value !== 'string' || value !== value.trim() || !/^[\p{L}\p{N} ._()-]{1,80}$/u.test(value)) throw invalid();
  return value;
}
// The installation identity belongs to this database, never to a browser URL,
// a hostname, a credential, or a mutable worker heartbeat.
async function getServiceExecutionIdentity(db) {
  const candidate = 'svc_' + randomBytes(16).toString('hex');
  await db.query('INSERT INTO service_execution_identity(singleton, service_id) VALUES(TRUE,$1) ON CONFLICT(singleton) DO NOTHING', [candidate]);
  const row = (await db.query('SELECT service_id FROM service_execution_identity WHERE singleton=TRUE')).rows[0];
  if (!SERVICE_ID.test(row?.service_id || '')) throw invalid();
  return { id: row.service_id, label: serviceLabel() };
}
function validateExecutionTarget(raw) {
  if (!raw || raw.kind !== 'service' || typeof raw.label !== 'string' || !SERVICE_ID.test(raw.id || '') || !HASH.test(raw.generation || '')
      || raw.precision !== 'recorded-executor' || !RUNTIME_KINDS.has(raw.runtimeKind)
      || raw.runtimeGeneration !== null && !HASH.test(raw.runtimeGeneration || '')) throw invalid();
  return { kind: 'service', id: raw.id, label: serviceLabel(raw.label), generation: raw.generation,
    precision: 'recorded-executor', runtimeKind: raw.runtimeKind, runtimeGeneration: raw.runtimeGeneration };
}
function validateExecutionReceiptInput(raw) {
  if (!raw || typeof raw.operation !== 'string' || !/^[a-z][a-z0-9_.-]{0,99}$/.test(raw.operation)
      || !RUNTIME_KINDS.has(raw.runtimeKind) || raw.runtimeGeneration != null && !HASH.test(raw.runtimeGeneration)) throw invalid();
  const environment = raw.environment || { precision: 'unavailable', reference: null };
  if (!['pinned-request', 'unavailable'].includes(environment.precision)
      || environment.precision === 'unavailable' && environment.reference != null) throw invalid();
  return { operation: raw.operation, runtimeKind: raw.runtimeKind, runtimeGeneration: raw.runtimeGeneration || null,
    environment: { precision: environment.precision, reference: environment.precision === 'pinned-request'
      ? validateEnvironmentReference(environment.reference) : null } };
}
function rowToExecutionReceipt(row) {
  if (!HASH.test(row?.dispatch_id || '') || !Number.isSafeInteger(Number(row?.attempt)) || Number(row.attempt) < 1
      || row.dispatch_at == null || !Number.isFinite(new Date(row.dispatch_at).getTime())) throw invalid();
  const input = validateExecutionReceiptInput({ operation: row.operation, runtimeKind: row.target_json?.runtimeKind,
    runtimeGeneration: row.target_json?.runtimeGeneration, environment: row.environment_json });
  return { dispatchId:row.dispatch_id, attempt: Number(row.attempt), operation: input.operation, dispatchAt: new Date(row.dispatch_at).toISOString(),
    target: validateExecutionTarget(row.target_json), environment: input.environment };
}
async function privateKernelTarget(db, target) {
  const identity = await getServiceExecutionIdentity(db);
  return validatePrivateKernelTarget({ ...target, serviceId: identity.id, serviceLabel: identity.label, runtimeKind: 'private-r' });
}
function validatePrivateKernelTarget(raw) {
  if (!raw || raw.kind !== 'service' || !/^[a-z][a-z0-9.-]{0,79}$/.test(raw.id || '') || !HASH.test(raw.generation || '')) throw invalid();
  const target = { kind: 'service', id: raw.id, generation: raw.generation };
  if (raw.serviceId !== undefined) {
    if (!SERVICE_ID.test(raw.serviceId) || typeof raw.serviceLabel !== 'string' || raw.runtimeKind !== 'private-r') throw invalid();
    Object.assign(target, { serviceId: raw.serviceId, serviceLabel: serviceLabel(raw.serviceLabel), runtimeKind: 'private-r' });
  }
  return target;
}
function executorGeneration(workerId) { return createHash('sha256').update(String(workerId)).digest('hex'); }
module.exports = { getServiceExecutionIdentity, validateExecutionTarget, validateExecutionReceiptInput,
  rowToExecutionReceipt, privateKernelTarget, validatePrivateKernelTarget, executorGeneration, serviceLabel };
