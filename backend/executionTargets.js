'use strict';

const { randomBytes, createHash } = require('node:crypto');
const { validateEnvironmentReference } = require('./rEnvironment');

const SERVICE_ID = /^svc_[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const RUNTIME_KINDS = new Set(['guided-r', 'sandbox-r', 'private-r', 'service']);

function invalidReceipt() {
  const error = new Error('Execution target evidence is unavailable or invalid.');
  error.code = 'EXECUTION_RECEIPT_INVALID';
  return error;
}

function serviceLabel(value = process.env.EXECUTION_SERVICE_LABEL || 'Analysis server') {
  if (typeof value !== 'string' || value !== value.trim() || !/^[\p{L}\p{N} ._()-]{1,80}$/u.test(value)) {
    throw invalidReceipt();
  }
  return value;
}

// Persist the installation identity so worker restarts keep the same service ID.
async function getServiceExecutionIdentity(db) {
  const candidate = 'svc_' + randomBytes(16).toString('hex');
  await db.query('INSERT INTO service_execution_identity(singleton, service_id) VALUES(TRUE,$1) ON CONFLICT(singleton) DO NOTHING', [candidate]);
  const row = (await db.query('SELECT service_id FROM service_execution_identity WHERE singleton=TRUE')).rows[0];
  if (!SERVICE_ID.test(row?.service_id || '')) throw invalidReceipt();
  return { id: row.service_id, label: serviceLabel() };
}

function validateExecutionTarget(raw) {
  if (!raw || raw.kind !== 'service' || typeof raw.label !== 'string') throw invalidReceipt();
  if (!SERVICE_ID.test(raw.id || '') || !HASH.test(raw.generation || '')) throw invalidReceipt();
  if (raw.precision !== 'recorded-executor' || !RUNTIME_KINDS.has(raw.runtimeKind)) throw invalidReceipt();
  if (raw.runtimeGeneration !== null && !HASH.test(raw.runtimeGeneration || '')) throw invalidReceipt();

  return {
    kind: 'service',
    id: raw.id,
    label: serviceLabel(raw.label),
    generation: raw.generation,
    precision: 'recorded-executor',
    runtimeKind: raw.runtimeKind,
    runtimeGeneration: raw.runtimeGeneration,
  };
}

function validateExecutionReceiptInput(raw) {
  if (!raw || typeof raw.operation !== 'string' || !/^[a-z][a-z0-9_.-]{0,99}$/.test(raw.operation)) {
    throw invalidReceipt();
  }
  if (!RUNTIME_KINDS.has(raw.runtimeKind)) throw invalidReceipt();
  if (raw.runtimeGeneration != null && !HASH.test(raw.runtimeGeneration)) throw invalidReceipt();

  const environment = raw.environment || { precision: 'unavailable', reference: null };
  if (!['pinned-request', 'unavailable'].includes(environment.precision)) throw invalidReceipt();
  if (environment.precision === 'unavailable' && environment.reference != null) throw invalidReceipt();
  const reference = environment.precision === 'pinned-request'
    ? validateEnvironmentReference(environment.reference) : null;

  return {
    operation: raw.operation,
    runtimeKind: raw.runtimeKind,
    runtimeGeneration: raw.runtimeGeneration || null,
    environment: { precision: environment.precision, reference },
  };
}

function rowToExecutionReceipt(row) {
  if (!HASH.test(row?.dispatch_id || '')) throw invalidReceipt();
  const attempt = Number(row.attempt);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw invalidReceipt();
  if (row.dispatch_at == null) throw invalidReceipt();
  const dispatchAt = new Date(row.dispatch_at);
  if (!Number.isFinite(dispatchAt.getTime())) throw invalidReceipt();

  const input = validateExecutionReceiptInput({
    operation: row.operation,
    runtimeKind: row.target_json?.runtimeKind,
    runtimeGeneration: row.target_json?.runtimeGeneration,
    environment: row.environment_json,
  });
  return {
    dispatchId: row.dispatch_id,
    attempt,
    operation: input.operation,
    dispatchAt: dispatchAt.toISOString(),
    target: validateExecutionTarget(row.target_json),
    environment: input.environment,
  };
}

async function privateKernelTarget(db, target) {
  const identity = await getServiceExecutionIdentity(db);
  return validatePrivateKernelTarget({ ...target, serviceId: identity.id, serviceLabel: identity.label, runtimeKind: 'private-r' });
}

function validatePrivateKernelTarget(raw) {
  if (!raw || raw.kind !== 'service' || !/^[a-z][a-z0-9.-]{0,79}$/.test(raw.id || '')) throw invalidReceipt();
  if (!HASH.test(raw.generation || '')) throw invalidReceipt();

  const target = { kind: 'service', id: raw.id, generation: raw.generation };
  if (raw.serviceId !== undefined) {
    if (!SERVICE_ID.test(raw.serviceId) || typeof raw.serviceLabel !== 'string' || raw.runtimeKind !== 'private-r') {
      throw invalidReceipt();
    }
    Object.assign(target, { serviceId: raw.serviceId, serviceLabel: serviceLabel(raw.serviceLabel), runtimeKind: 'private-r' });
  }
  return target;
}

function executorGeneration(workerId) {
  return createHash('sha256').update(String(workerId)).digest('hex');
}

module.exports = {
  getServiceExecutionIdentity,
  validateExecutionTarget,
  validateExecutionReceiptInput,
  rowToExecutionReceipt,
  privateKernelTarget,
  validatePrivateKernelTarget,
  executorGeneration,
  serviceLabel,
};
