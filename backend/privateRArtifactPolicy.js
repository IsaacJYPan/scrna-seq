'use strict';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const MAX_BYTES = 64 * GiB;
const FIELDS = Object.freeze({
  maxOutputBytes: ['PRIVATE_R_MAX_OUTPUT_BYTES', 512 * MiB, MAX_BYTES],
  maxInputFileBytes: ['PRIVATE_R_MAX_INPUT_FILE_BYTES', 512 * MiB, MAX_BYTES],
  maxInputTotalBytes: ['PRIVATE_R_MAX_INPUT_TOTAL_BYTES', GiB, MAX_BYTES],
  managedQuotaBytes: ['PRIVATE_R_MANAGED_QUOTA_BYTES', 5 * GiB, MAX_BYTES],
  diskReserveBytes: ['PRIVATE_R_DISK_RESERVE_BYTES', GiB, MAX_BYTES],
  transferTimeoutSeconds: ['PRIVATE_R_TRANSFER_TIMEOUT_SECONDS', 900, 3600],
});
const LEGACY_OUTPUT_BYTES = 20 * MiB;

function invalid(name) {
  return Object.assign(new Error(`${name} must be a positive integer within the private R artifact policy bounds.`),
    { code: 'PRIVATE_R_POLICY_INVALID' });
}

function getPrivateRArtifactPolicy(env = process.env) {
  const policy = { schemaVersion: 1 };
  for (const [field, [name, fallback, maximum]] of Object.entries(FIELDS)) {
    const raw = env[name];
    const text = raw == null ? '' : String(raw).trim();
    const value = text ? Number(text) : fallback;
    if (text && !/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw invalid(name);
    policy[field] = value;
  }
  if (policy.maxInputFileBytes > policy.maxInputTotalBytes) throw invalid('PRIVATE_R_MAX_INPUT_TOTAL_BYTES');
  return Object.freeze(policy);
}

function validatePrivateRArtifactPolicy(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== 1) throw invalid('Private R artifact policy');
  const policy = { schemaVersion: 1 };
  for (const [field, [, , maximum]] of Object.entries(FIELDS)) {
    const value = raw[field];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw invalid('Private R artifact policy');
    policy[field] = value;
  }
  if (policy.maxInputFileBytes > policy.maxInputTotalBytes) throw invalid('Private R artifact policy');
  // Project only declared numeric limits; a broker cannot attach paths or errors.
  return Object.freeze(policy);
}

function effectivePrivateRArtifactPolicy(runtime, env = process.env) {
  if (runtime?.state !== 'ready' || runtime.persistentKernel !== true) return null;
  const configured = getPrivateRArtifactPolicy(env);
  let broker;
  try { broker = validatePrivateRArtifactPolicy(runtime.privateRArtifactPolicy); } catch { /* Older adapters use their original bounds. */ }
  const streaming = runtime.persistentKernelStreamedPublications === true && broker;
  return Object.freeze({
    schemaVersion: 1,
    maxOutputBytes: Math.min(configured.maxOutputBytes, streaming ? broker.maxOutputBytes : LEGACY_OUTPUT_BYTES),
    maxInputFileBytes: Math.min(configured.maxInputFileBytes, streaming ? broker.maxInputFileBytes : 200 * MiB),
    maxInputTotalBytes: Math.min(configured.maxInputTotalBytes, streaming ? broker.maxInputTotalBytes : 250 * MiB),
    managedQuotaBytes: configured.managedQuotaBytes,
    // These are host controls enforced by the broker, rather than the web
    // service's admission ceilings. Report the observed broker configuration.
    diskReserveBytes: broker?.diskReserveBytes || GiB,
    transferTimeoutSeconds: streaming ? broker.transferTimeoutSeconds : 30,
  });
}

module.exports = { getPrivateRArtifactPolicy, validatePrivateRArtifactPolicy, effectivePrivateRArtifactPolicy, LEGACY_OUTPUT_BYTES };
