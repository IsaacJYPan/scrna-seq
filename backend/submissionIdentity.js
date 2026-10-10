'use strict';

const { createHash } = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function invalid(message = 'The submission request is invalid.') {
  return Object.assign(new Error(message), { code: 'INVALID_SUBMISSION_REQUEST' });
}
function submissionRequestId(value, optional = false) {
  if (optional && value === undefined) return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid('A valid submission request UUID is required.');
  return value.toLowerCase();
}
function canonical(value, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 20000 || depth > 40) throw invalid('The submission request exceeds its complexity limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1, budget));
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key], depth + 1, budget);
    return result;
  }
  throw invalid('The submission request must contain only JSON values.');
}
function projectSubmissionHash(input) {
  const json = JSON.stringify(canonical({ jobType: typeof input.jobType === 'string' ? input.jobType.trim() : input.jobType,
    analysisObjectId: input.analysisObjectId ?? null, resultAnalysisObjectId: input.resultAnalysisObjectId ?? null,
    datasetId: input.datasetId ?? null, parameters: input.parameters === undefined ? {} : input.parameters }));
  if (Buffer.byteLength(json, 'utf8') > 256 * 1024) throw invalid('The submission request exceeds its byte limit.');
  return createHash('sha256').update(json).digest('hex');
}
module.exports = { submissionRequestId, projectSubmissionHash };
