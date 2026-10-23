// Test-only accepted identities. Production never imports these builders.
import { createHash } from 'node:crypto';
import { snapshotScope, snapshotRecipe, snapshotRecord } from './snapshotPreparationTestFixtures';
import { canonicalSnapshotJson } from '../../shared/analysisSnapshotPreparation.mjs';
import { ANALYSIS_SNAPSHOT_PUBLICATION_SCHEMA as schema, normalizePublishAnalysisSnapshot, canonicalPublishAnalysisSnapshot,
  normalizeWithdrawAnalysisSnapshot, canonicalWithdrawAnalysisSnapshot } from '../../shared/analysisSnapshotPublication.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const publicationScope = { ...snapshotScope, userId: 17 };
export const publicationTime = '2026-10-22T12:05:00.000Z';
export const withdrawalTime = '2026-10-22T12:10:00.000Z';
export function publicationPreparation(ownerUserId = 7, changes = {}) {
  return snapshotRecord(snapshotRecipe({ ownerUserId, ...changes }));
}
export function publicationFull({ viewerUserId = 17, publisherUserId = 7, prepared = publicationPreparation(publisherUserId),
  state = 'published', withdrawnByUserId = publisherUserId, ...changes } = {}) {
  return { schema, serviceId: prepared.serviceId, projectId: prepared.projectId, analysisId: prepared.analysisId,
    viewerUserId, publicationId: 'aspub_' + 'd'.repeat(24), publisherUserId, publisherLabel: 'Researcher α',
    publishedAt: publicationTime, preparationId: prepared.preparationId, snapshotSha256: prepared.snapshotSha256,
    policy: state === 'published' ? { state, version: 1, withdrawnAt: null, withdrawnByUserId: null }
      : { state, version: 2, withdrawnAt: withdrawalTime, withdrawnByUserId },
    canPublish: false, canWithdraw: state === 'published' && viewerUserId === publisherUserId,
    package: state === 'published' ? structuredClone(prepared.package) : null,
    availability: state === 'published' ? structuredClone(prepared.availability) : null, ...changes };
}
export function publicationAnchor(value) {
  return { publicationId: value.publicationId, snapshotSha256: value.snapshotSha256,
    preparationId: value.preparationId, publisherUserId: value.publisherUserId };
}
export function publicationSummary(value) {
  return { publicationId: value.publicationId, publisherUserId: value.publisherUserId, publisherLabel: value.publisherLabel,
    publishedAt: value.publishedAt, preparationId: value.preparationId, snapshotSha256: value.snapshotSha256,
    policy: structuredClone(value.policy), canWithdraw: value.canWithdraw, selection: value.package ? {
      analysisVersion: value.package.analysis.version, analysisName: value.package.analysis.name, resultCount: value.package.results.length,
      documentCount: value.package.documents.length, prerequisiteCount: value.package.prerequisites.items.length } : null };
}
export function publicationList(values = [], { scope = publicationScope, canPublish = false, nextCursor = null } = {}) {
  return { schema, serviceId: scope.serviceId, projectId: scope.projectId, analysisId: scope.analysisId,
    viewerUserId: Number(scope.userId), canPublish, items: values.map(publicationSummary)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.publicationId.localeCompare(a.publicationId)), nextCursor };
}
export function publicationReceipt({ action = 'publish', actorUserId = 7, publisherUserId = 7,
  current = publicationFull({ viewerUserId: actorUserId, publisherUserId,
    state: action === 'withdraw' ? 'withdrawn' : 'published', withdrawnByUserId: actorUserId }),
  requestId = action === 'publish' ? '12345678-1234-4234-8234-123456789abc' : '12345678-1234-4234-8234-123456789abd',
  replayed = false } = {}) {
  const body = { requestId, serviceId: current.serviceId, projectId: current.projectId, analysisId: current.analysisId,
    ownerUserId: actorUserId, ...(action === 'publish' ? { preparationId: current.preparationId } : { publicationId: current.publicationId }), snapshotSha256: current.snapshotSha256 };
  const request = { action, ...(action === 'publish' ? normalizePublishAnalysisSnapshot : normalizeWithdrawAnalysisSnapshot)(body) };
  return { schema, serviceId: current.serviceId, projectId: current.projectId, analysisId: current.analysisId,
    actorUserId, requestId, requestSha256: hash((action === 'publish' ? canonicalPublishAnalysisSnapshot : canonicalWithdrawAnalysisSnapshot)(body)),
    request, replayed, acceptance: { action, publicationId: current.publicationId, snapshotSha256: current.snapshotSha256,
      acceptedAt: action === 'publish' ? current.publishedAt : current.policy.withdrawnAt,
      acceptedPolicyVersion: action === 'publish' ? 1 : 2, auditEventId: 'aud_' + (action === 'publish' ? 'a' : 'b').repeat(24) }, current };
}
export function publicationRequestSummary(receipt) {
  return { requestId: receipt.requestId, requestSha256: receipt.requestSha256, request: structuredClone(receipt.request),
    acceptance: structuredClone(receipt.acceptance), currentPolicy: structuredClone(receipt.current.policy) };
}
export function publicationRequests(receipts = [], { scope = { ...publicationScope, userId: 7 }, nextCursor = null } = {}) {
  return { schema, serviceId: scope.serviceId, projectId: scope.projectId, analysisId: scope.analysisId, actorUserId: Number(scope.userId),
    items: receipts.map(publicationRequestSummary).sort((a, b) => b.acceptance.acceptedAt.localeCompare(a.acceptance.acceptedAt)
      || b.requestId.localeCompare(a.requestId)), nextCursor };
}
export function resealPublication(value) {
  value.snapshotSha256 = hash(canonicalSnapshotJson(value.package)); return value;
}
