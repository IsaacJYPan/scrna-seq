'use strict';

// `trusted.method.v1`: run one library method (trusted-methods/) on an
// accepted analysis in the isolated, no-network R sandbox.
//
// The R source is never taken from the job. The job names a method, its
// version and the SHA-256 of its source; the handler loads that method from
// the server's own library, refuses if the bytes changed, revalidates every
// parameter against the catalog, and compiles the script with the same
// wrapper used for workflow packages (workflowRuntime.compileStep). Outputs
// are checked with the workflow output validator before anything is recorded.

const crypto = require('crypto');
const { compileStep } = require('../workflowRuntime');
const { validateWorkflowOutput } = require('../workflowOutputs');
const { EXPERT_R_RESOURCE_POLICY_VERSION } = require('../expertR');
const storage = require('../storage');
const { loadLibrary, methodByKey, resolveMethodParameters, singleMethodPackage } = require('../workflowTrust/trustedMethods');
const { codedHandlerError } = require('./jobErrors');

const MAX_TOTAL_OUTPUT_BYTES = 200 * 1024 * 1024;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function resolveJobMethod(parameters) {
  const p = parameters && typeof parameters === 'object' ? parameters : {};
  const keys = Object.keys(p).sort().join(',');
  if (keys !== 'method,methodSourceSha256,methodVersion,values') {
    throw codedHandlerError('INVALID_PARAMETERS', 'Trusted method job parameters are malformed.');
  }
  const method = methodByKey(p.method);
  if (!method) throw codedHandlerError('TRUSTED_METHOD_UNKNOWN', 'This trusted method is not installed.');
  if (method.version !== p.methodVersion || method.sourceSha256 !== p.methodSourceSha256) {
    throw codedHandlerError('TRUSTED_METHOD_CHANGED', 'The trusted method changed after this run was planned.');
  }
  let resolved;
  try {
    resolved = resolveMethodParameters(method, p.values);
  } catch (error) {
    throw codedHandlerError('INVALID_PARAMETERS', error.message);
  }
  return { method, values: resolved.values };
}

function compileMethod(method, values) {
  const pkg = singleMethodPackage(method);
  const seed = Number.isSafeInteger(values.seed) ? values.seed : 1;
  const state = { active: { stepId: 'run', inputs: { analysis: { root: true } }, parameters: values, seed } };
  return { ...compileStep(pkg, state), seed, profileId: pkg.runtime.profileId };
}

async function readJson(provider, key, descriptor) {
  const file = await provider.openVerifiedRead(key, { checksumSha256: descriptor.sha256, sizeBytes: descriptor.sizeBytes });
  try { return JSON.parse(await file.handle.readFile({ encoding: 'utf8' })); } finally { await file.handle.close(); }
}

// Only declared metrics, as bounded scalars, reach trial comparison.
function boundedMetrics(method, metrics) {
  const summary = {};
  for (const { key } of method.metrics) {
    const value = metrics && Object.hasOwn(metrics, key) ? metrics[key] : undefined;
    if (typeof value === 'number' && Number.isFinite(value)) summary[key] = value;
    else if (typeof value === 'boolean') summary[key] = value;
    else if (typeof value === 'string' && value.length <= 80) summary[key] = value;
  }
  return summary;
}

async function trustedMethodHandler(ctx) {
  await ctx.heartbeat();
  const job = ctx.job;
  const { method, values } = resolveJobMethod(job.parameters);
  await ctx.log({ level: 'info', message: `trusted.method.v1: ${method.key}@${method.version} validated before sandbox contact.` });

  const owned = await ctx.getOwnedAnalysisObject();
  if (!owned || owned.id !== job.analysisObjectId) throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  if (typeof ctx.runExpertSandbox !== 'function' || typeof ctx.completeTrustedMethodResult !== 'function') {
    throw codedHandlerError('EXPERT_R_UNAVAILABLE', 'Trusted methods require the isolated R runtime.');
  }
  const checkpoint = await ctx.getHydrationCheckpoint();
  if (!checkpoint || checkpoint.analysisObjectId !== job.analysisObjectId
      || typeof checkpoint.internalStorageKey !== 'string' || !/^[0-9a-f]{64}$/.test(String(checkpoint.checksumSha256 || ''))
      || !Number.isSafeInteger(checkpoint.sizeBytes)) {
    throw codedHandlerError('NO_CHECKPOINT_ARTIFACT', 'Trusted methods require a durable checkpoint.');
  }

  const compiled = compileMethod(method, values);
  if (compiled.profileId !== loadLibrary().runtimeProfileId) throw codedHandlerError('EXPERT_R_UNAVAILABLE', 'Runtime profile mismatch.');
  const outputStorageKey = storage.projectStorageFileKey(job.projectId, 'artifacts', job.id, 'trusted-method');
  await ctx.heartbeat();
  const result = await ctx.runExpertSandbox({
    jobId: job.id,
    projectId: job.projectId,
    profileId: compiled.profileId,
    script: compiled.script,
    checkpointStorageKey: checkpoint.internalStorageKey,
    checkpointChecksumSha256: checkpoint.checksumSha256,
    checkpointSizeBytes: checkpoint.sizeBytes,
    privateInputs: [],
    outputStorageKey,
    workflowOutputs: compiled.outputs,
  });
  const files = Array.isArray(result?.workflowFiles) ? result.workflowFiles : null;
  if (!result || result.saved !== true || result.scriptSha256 !== sha256(compiled.script)
      || result.checkpointChecksumSha256 !== checkpoint.checksumSha256 || result.profileId !== compiled.profileId
      || result.resourcePolicyVersion !== EXPERT_R_RESOURCE_POLICY_VERSION
      || !/^sha256:[a-f0-9]{64}$/.test(result.sandboxImageDigest || '') || !files
      || files.length !== Object.keys(compiled.outputs).length
      || files.reduce((total, file) => total + (Number(file?.sizeBytes) || 0), 0) > MAX_TOTAL_OUTPUT_BYTES) {
    throw codedHandlerError('TRUSTED_METHOD_RESULT_INVALID', 'The sandbox response does not match the trusted method.');
  }

  const provider = ctx.storageProvider || storage.createLocalStorageProvider();
  const outputs = {};
  for (const [port, declaration] of Object.entries(compiled.outputs)) {
    const file = files.find((item) => item && item.name === declaration.name);
    const key = `${outputStorageKey}-${declaration.name}`;
    if (!file || file.storageKey !== key || !/^[a-f0-9]{64}$/.test(file.checksumSha256 || '')
        || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) {
      throw codedHandlerError('TRUSTED_METHOD_RESULT_INVALID', `Output ${port} is missing or malformed.`);
    }
    const descriptor = { type: declaration.type, sha256: file.checksumSha256, sizeBytes: file.sizeBytes };
    try { await validateWorkflowOutput(provider, key, descriptor); } catch {
      throw codedHandlerError('TRUSTED_METHOD_RESULT_INVALID', `Output ${port} does not match its declared type.`);
    }
    outputs[port] = { ...descriptor, storageKey: key, label: method.outputs[port].label };
  }
  const metrics = await readJson(provider, outputs[method.summaryOutput].storageKey, outputs[method.summaryOutput]);
  const summary = boundedMetrics(method, metrics);

  const provenance = {
    analysisKind: 'trusted_method',
    method: { key: method.key, version: method.version, sourceSha256: method.sourceSha256, provenance: method.provenance },
    parameters: values,
    seed: compiled.seed,
    packageProfileId: compiled.profileId,
    sandboxImageDigest: result.sandboxImageDigest,
    resourcePolicyVersion: result.resourcePolicyVersion,
    scriptSha256: result.scriptSha256,
    input: { analysisObjectId: job.analysisObjectId, checkpointArtifactId: checkpoint.checkpointArtifactId,
      checkpointChecksumSha256: checkpoint.checksumSha256, checkpointSizeBytes: checkpoint.sizeBytes },
  };
  const completion = await ctx.completeTrustedMethodResult({
    method: method.key,
    displayName: method.title,
    objectType: outputs.analysis ? 'seurat' : 'generic',
    metadata: { ...provenance, summary },
    outputs: Object.entries(outputs).map(([port, output]) => ({ port, ...output })),
  });
  await ctx.log({ level: 'info', message: `trusted.method.v1: recorded result ${completion.resultObject.id} for ${method.key}.` });
  return {
    resultAnalysisObjectId: completion.resultObject.id,
    result: { ok: true, handled: 'trusted.method.v1', method: method.key, resultAnalysisObjectId: completion.resultObject.id },
  };
}

module.exports = { trustedMethodHandler, resolveJobMethod, compileMethod, boundedMetrics };
