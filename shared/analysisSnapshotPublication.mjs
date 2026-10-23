import { canonicalSnapshotJson } from './analysisSnapshotPreparation.mjs';

export const ANALYSIS_SNAPSHOT_PUBLICATION_SCHEMA = 'traceomics.analysis-snapshot-publication.v1';
export const ANALYSIS_SNAPSHOT_PUBLICATION_ID = /^aspub_[a-f0-9]{24}$/;
export const ANALYSIS_SNAPSHOT_PUBLICATION_LIMITS = Object.freeze({
  publications: 2000, requestBytes: 2048, metadataAllowanceBytes: 8192,
  page: 30, cursor: 256, listBytes: 128 * 1024, fullBytes: 384 * 1024,
  publisherLabel: 200, verificationConcurrency: 2,
});

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/, SERVICE = /^svc_[a-f0-9]{32}$/;
const PROJECT = /^proj_[a-f0-9]{16,40}$/, ANALYSIS = /^ra_[a-f0-9]{24}$/, PREPARATION = /^asp_[a-f0-9]{24}$/;
const L = ANALYSIS_SNAPSHOT_PUBLICATION_LIMITS;
function invalid() {
  throw Object.assign(new Error('Choose an exact snapshot, workspace and original publication request.'), {
    code: 'INVALID_ANALYSIS_SNAPSHOT_PUBLICATION', status: 400,
  });
}
function normalize(input, action) {
  let value;
  // The shared strict serializer inspects descriptors without invoking getters,
  // toJSON, iterators or constructors. Only this captured copy is read below.
  try { value = JSON.parse(canonicalSnapshotJson(input, L.requestBytes)); } catch { invalid(); }
  const target = action === 'publish' ? 'preparationId' : 'publicationId';
  const keys = ['requestId', 'serviceId', 'projectId', 'analysisId', 'ownerUserId', target, 'snapshotSha256'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
      || keys.some(key => !Object.hasOwn(value, key))
      || typeof value.requestId !== 'string' || !UUID.test(value.requestId)
      || typeof value.serviceId !== 'string' || !SERVICE.test(value.serviceId)
      || typeof value.projectId !== 'string' || !PROJECT.test(value.projectId)
      || typeof value.analysisId !== 'string' || !ANALYSIS.test(value.analysisId)
      || !Number.isSafeInteger(value.ownerUserId) || value.ownerUserId < 1
      || typeof value[target] !== 'string' || !(action === 'publish' ? PREPARATION : ANALYSIS_SNAPSHOT_PUBLICATION_ID).test(value[target])
      || typeof value.snapshotSha256 !== 'string' || !SHA.test(value.snapshotSha256)) invalid();
  // ownerUserId owns the action journal. For an admin withdrawal it is the
  // administrator, while the immutable package owner remains its publisher.
  return { requestId: value.requestId.toLowerCase(), serviceId: value.serviceId, projectId: value.projectId,
    analysisId: value.analysisId, ownerUserId: value.ownerUserId, [target]: value[target], snapshotSha256: value.snapshotSha256 };
}
function canonical(input, action) {
  const value = normalize(input, action), target = action === 'publish' ? 'preparationId' : 'publicationId';
  return JSON.stringify({ schema: ANALYSIS_SNAPSHOT_PUBLICATION_SCHEMA, action, serviceId: value.serviceId,
    projectId: value.projectId, analysisId: value.analysisId, ownerUserId: value.ownerUserId,
    requestId: value.requestId, [target]: value[target], snapshotSha256: value.snapshotSha256 });
}
export const normalizePublishAnalysisSnapshot = input => normalize(input, 'publish');
export const normalizeWithdrawAnalysisSnapshot = input => normalize(input, 'withdraw');
export const canonicalPublishAnalysisSnapshot = input => canonical(input, 'publish');
export const canonicalWithdrawAnalysisSnapshot = input => canonical(input, 'withdraw');
