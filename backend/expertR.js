'use strict';

const crypto = require('crypto');
const path = require('path');
const { projectStorageFileKey } = require('./storage');

const PROFILE = Object.freeze({
  id: 'scrna-r-4.5-bioconductor-3.22-v1',
  r: '4.5.x',
  bioconductor: '3.22',
  packages: Object.freeze([
    'base', 'stats', 'utils', 'methods', 'Matrix', 'Seurat', 'SeuratObject',
    'dplyr', 'ggplot2', 'patchwork', 'edgeR', 'limma', 'clusterProfiler',
    'fgsea', 'AnnotationDbi', 'org.Hs.eg.db', 'org.Mm.eg.db', 'GO.db',
    'ComplexHeatmap', 'CellChat', 'NMF', 'presto', 'jsonlite',
  ]),
});
const PARAM_NAMES = Object.freeze(['profileId', 'script', 'inputIds']);
const STORED_PARAM_NAMES = Object.freeze(['profileId', 'script', 'inputIds', 'scriptSha256']);
const MAX_SCRIPT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 200 * 1024 * 1024;
const MAX_BUNDLE_BYTES = MAX_OUTPUT_BYTES + (4 * 1024 * 1024);
const RESOURCE_POLICY_VERSION = 'expert-r-sandbox-policy.v3';
const EXPERT_R_ALLOWED_DEPLOYMENT_MODES = new Set(['private', 'byoc', 'shared-private']);
const EXPERT_R_INPUT_EXTENSIONS = new Set(['.csv', '.tsv', '.txt', '.json', '.rds']);
const MAX_EXPERT_R_TABULAR_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_EXPERT_R_RDS_INPUT_BYTES = 200 * 1024 * 1024;
// Multer needs one hard ceiling before the filename-specific policy can run.
const MAX_EXPERT_R_INPUT_BYTES = MAX_EXPERT_R_RDS_INPUT_BYTES;
const MAX_EXPERT_R_INPUTS_PER_RUN = 5;
const MAX_EXPERT_R_PRIVATE_INPUTS = 20;
const MAX_EXPERT_R_PRIVATE_INPUT_STORAGE_BYTES = 250 * 1024 * 1024;

function codedError(code, message) {
  const error = new Error(message); error.code = code; return error;
}

function validateExpertRParams(input, { allowStoredHash = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw codedError('INVALID_PARAMETERS', 'Expert R parameters must be an object.');
  }
  const allowedNames = allowStoredHash ? STORED_PARAM_NAMES : PARAM_NAMES;
  const unknown = Object.keys(input).filter((key) => !allowedNames.includes(key));
  if (unknown.length) throw codedError('UNKNOWN_PARAMETER', `Unknown parameter: ${unknown[0]}.`);
  if (input.profileId !== PROFILE.id) {
    throw codedError('INVALID_PARAMETERS', 'The selected R package profile is not available.');
  }
  if (typeof input.script !== 'string' || input.script.trim() === ''
      || Buffer.byteLength(input.script, 'utf8') > MAX_SCRIPT_BYTES
      || input.script.includes('\0')) {
    throw codedError('INVALID_PARAMETERS', 'R script must contain 1-32768 UTF-8 bytes.');
  }
  const inputIds = input.inputIds === undefined ? [] : input.inputIds;
  if (!Array.isArray(inputIds) || inputIds.length > MAX_EXPERT_R_INPUTS_PER_RUN
      || inputIds.some((id) => typeof id !== 'string' || !/^eri_[0-9a-f]{24}$/.test(id))
      || new Set(inputIds).size !== inputIds.length) {
    throw codedError('INVALID_PARAMETERS', `Select at most ${MAX_EXPERT_R_INPUTS_PER_RUN} distinct private input files.`);
  }
  const scriptSha256 = crypto.createHash('sha256').update(input.script, 'utf8').digest('hex');
  if (allowStoredHash && input.scriptSha256 !== undefined
      && input.scriptSha256 !== scriptSha256) {
    throw codedError('INVALID_PARAMETERS', 'Stored Expert R script provenance is invalid.');
  }
  return {
    params: { profileId: PROFILE.id, script: input.script, inputIds: [...inputIds] },
    scriptSha256,
  };
}

function storedExpertRParams(input) {
  const validated = validateExpertRParams(input);
  return { ...validated.params, scriptSha256: validated.scriptSha256 };
}

function allocateExpertRBundleStorageKey(projectId, jobId) {
  if (typeof jobId !== 'string' || !/^job_[0-9a-f]+$/.test(jobId)) {
    throw codedError('INVALID_JOB_ID', 'A server-generated job ID is required.');
  }
  return projectStorageFileKey(projectId, 'artifacts', jobId, 'expert-r-outputs.tar.gz');
}

function generateExpertRInputId() {
  return `eri_${crypto.randomBytes(12).toString('hex')}`;
}

function sanitizeExpertRInputFilename(value) {
  const base = path.basename(String(value || '').replace(/\\/g, '/')).normalize('NFKC');
  const extension = path.extname(base).toLowerCase();
  if (!EXPERT_R_INPUT_EXTENSIONS.has(extension)) {
    throw codedError('INVALID_EXPERT_R_INPUT', 'Expert R inputs must be CSV, TSV, TXT, JSON, or RDS files.');
  }
  const stem = path.basename(base, path.extname(base))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 100) || 'input';
  return `${stem}${extension}`;
}

function maxExpertRInputBytesForFilename(value) {
  const filename = sanitizeExpertRInputFilename(value);
  return path.extname(filename).toLowerCase() === '.rds'
    ? MAX_EXPERT_R_RDS_INPUT_BYTES
    : MAX_EXPERT_R_TABULAR_INPUT_BYTES;
}

function allocateExpertRInputStorageKey(projectId, inputId, originalFilename) {
  if (!/^eri_[0-9a-f]{24}$/.test(String(inputId || ''))) {
    throw codedError('INVALID_EXPERT_R_INPUT', 'A server-generated Expert R input ID is required.');
  }
  const filename = sanitizeExpertRInputFilename(originalFilename);
  return projectStorageFileKey(projectId, 'artifacts', inputId, `private-input${path.extname(filename)}`);
}

function isTrustedExpertRSandboxUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    const host = url.hostname.toLowerCase();
    return ['127.0.0.1', 'localhost', '::1'].includes(host)
      && ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password
      && (url.pathname === '' || url.pathname === '/')
      && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function expertRSandboxEnabled(env = process.env) {
  return EXPERT_R_ALLOWED_DEPLOYMENT_MODES.has(String(env.APP_DEPLOYMENT_MODE || '').trim().toLowerCase())
    && env.EXPERT_R_ENABLED === 'true'
    && ['approved-accounts', 'project-roles'].includes(env.EXPERT_R_ACCESS_POLICY || 'approved-accounts')
    && isTrustedExpertRSandboxUrl(env.EXPERT_R_SANDBOX_URL)
    && /^[0-9a-f]{64}$/.test(String(env.EXPERT_R_SANDBOX_TOKEN || ''));
}

function expertRProfileProbeCode() {
  const packages = PROFILE.packages.map((name) => JSON.stringify(name)).join(',');
  return `stopifnot(getRversion() >= '4.5.0', getRversion() < '4.6.0', file.exists('/app/expert-runner.R')); packages <- c(${packages}); stopifnot(all(vapply(packages, requireNamespace, quietly=TRUE, FUN.VALUE=logical(1)))); stopifnot(as.character(BiocManager::version()) == '3.22')`;
}

module.exports = {
  EXPERT_R_JOB_TYPE: 'expert.r.v1',
  EXPERT_R_PROFILE: PROFILE,
  EXPERT_R_PARAM_NAMES: PARAM_NAMES,
  MAX_EXPERT_R_SCRIPT_BYTES: MAX_SCRIPT_BYTES,
  MAX_EXPERT_R_OUTPUT_BYTES: MAX_OUTPUT_BYTES,
  MAX_EXPERT_R_BUNDLE_BYTES: MAX_BUNDLE_BYTES,
  EXPERT_R_RESOURCE_POLICY_VERSION: RESOURCE_POLICY_VERSION,
  EXPERT_R_ALLOWED_DEPLOYMENT_MODES,
  EXPERT_R_INPUT_EXTENSIONS,
  MAX_EXPERT_R_INPUT_BYTES,
  MAX_EXPERT_R_TABULAR_INPUT_BYTES,
  MAX_EXPERT_R_RDS_INPUT_BYTES,
  MAX_EXPERT_R_INPUTS_PER_RUN,
  MAX_EXPERT_R_PRIVATE_INPUTS,
  MAX_EXPERT_R_PRIVATE_INPUT_STORAGE_BYTES,
  validateExpertRParams,
  storedExpertRParams,
  allocateExpertRBundleStorageKey,
  generateExpertRInputId,
  sanitizeExpertRInputFilename,
  maxExpertRInputBytesForFilename,
  allocateExpertRInputStorageKey,
  isTrustedExpertRSandboxUrl,
  expertRSandboxEnabled,
  expertRProfileProbeCode,
};
