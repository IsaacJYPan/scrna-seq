import {
  ANALYSIS_SNAPSHOT_PUBLICATION_SCHEMA as SCHEMA, ANALYSIS_SNAPSHOT_PUBLICATION_LIMITS as L,
  ANALYSIS_SNAPSHOT_PUBLICATION_ID as PUBLICATION, normalizePublishAnalysisSnapshot,
  canonicalPublishAnalysisSnapshot, normalizeWithdrawAnalysisSnapshot, canonicalWithdrawAnalysisSnapshot,
} from '../../shared/analysisSnapshotPublication.mjs';
import { ANALYSIS_SNAPSHOT_PREPARATION_LIMITS as A, canonicalSnapshotJson } from '../../shared/analysisSnapshotPreparation.mjs';
import { validateSnapshotPackage } from './snapshotPreparationValidation';

const SERVICE = /^svc_[a-f0-9]{32}$/, PROJECT = /^proj_[a-f0-9]{16,40}$/, ANALYSIS = /^ra_[a-f0-9]{24}$/;
const PREPARATION = /^asp_[a-f0-9]{24}$/, SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const scopeKeys = ['schema', 'serviceId', 'projectId', 'analysisId'];
const summaryKeys = ['publicationId', 'publisherUserId', 'publisherLabel', 'publishedAt', 'preparationId', 'snapshotSha256', 'policy', 'canWithdraw', 'selection'];
const fail = () => { throw Object.assign(new Error('The exact published snapshot could not be confirmed. Keep the original request and check again.'), { code: 'INVALID_SNAPSHOT_PUBLICATION_RESPONSE' }); };
const capture = (value, maximum) => JSON.parse(canonicalSnapshotJson(value, maximum));
function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (required.some(key => !Object.hasOwn(descriptors, key)) || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string'
      || !required.includes(key) && !optional.includes(key) || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) fail();
}
function pattern(value, expression) { if (typeof value !== 'string' || !expression.test(value)) fail(); }
function integer(value, min = 1, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(); }
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail();
}
function scopeCopy(input, discovery = false) {
  fields(input, ['projectId', 'analysisId', 'userId'], ['serviceId']);
  const value = { projectId: input.projectId, analysisId: input.analysisId, userId: input.userId, serviceId: input.serviceId };
  pattern(value.projectId, PROJECT); pattern(value.analysisId, ANALYSIS);
  if (typeof value.userId !== 'number' && (typeof value.userId !== 'string' || !/^[1-9]\d*$/.test(value.userId))) fail();
  value.userId = Number(value.userId); integer(value.userId);
  if (!discovery || value.serviceId !== undefined) pattern(value.serviceId, SERVICE);
  return value;
}
function envelope(value, scope, actor, extra) {
  fields(value, [...scopeKeys, actor, ...extra]);
  if (value.schema !== SCHEMA || value.projectId !== scope.projectId || value.analysisId !== scope.analysisId
      || value[actor] !== scope.userId) fail();
  pattern(value.serviceId, SERVICE); if (scope.serviceId !== undefined && value.serviceId !== scope.serviceId) fail();
}
function label(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value || value !== value.trim()
      || value.length > L.publisherLabel || /[\p{Cc}\p{Cf}]/u.test(value)) fail();
}
function policy(value, publishedAt) {
  fields(value, ['state', 'version', 'withdrawnAt', 'withdrawnByUserId']);
  if (value.state === 'published') {
    if (value.version !== 1 || value.withdrawnAt !== null || value.withdrawnByUserId !== null) fail();
  } else if (value.state === 'withdrawn') {
    if (value.version !== 2) fail(); timestamp(value.withdrawnAt); integer(value.withdrawnByUserId);
    if (publishedAt && value.withdrawnAt < publishedAt) fail();
  } else fail();
}
function header(value, viewer) {
  pattern(value.publicationId, PUBLICATION); pattern(value.preparationId, PREPARATION); pattern(value.snapshotSha256, SHA);
  integer(value.publisherUserId); label(value.publisherLabel); timestamp(value.publishedAt); policy(value.policy, value.publishedAt);
  if (typeof value.canWithdraw !== 'boolean' || value.policy.state === 'withdrawn' && value.canWithdraw
      || value.policy.state === 'published' && value.publisherUserId === viewer && !value.canWithdraw) fail();
}
function summary(value, viewer) {
  fields(value, summaryKeys); header(value, viewer);
  if (value.policy.state === 'withdrawn') { if (value.selection !== null) fail(); return; }
  fields(value.selection, ['analysisVersion', 'analysisName', 'resultCount', 'documentCount', 'prerequisiteCount']);
  integer(value.selection.analysisVersion, 1, 2147483647);
  const name = value.selection.analysisName;
  // Copied saved analysis names preserve the owning contract's codepoint bound.
  if (typeof name !== 'string' || !name.isWellFormed() || !name || name !== name.trim() || [...name].length > 160
      || [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) fail();
  integer(value.selection.resultCount, 1, A.results); integer(value.selection.documentCount, 0, A.documents);
  integer(value.selection.prerequisiteCount, 0, A.prerequisites);
}
function page(value) {
  if (!Array.isArray(value.items) || value.items.length > L.page) fail();
  if (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !value.nextCursor || value.nextCursor.length > L.cursor
      || !/^[A-Za-z0-9_-]+$/.test(value.nextCursor)) || !value.items.length && value.nextCursor !== null) fail();
}
function ordered(items, time, identity) {
  const ids = new Set();
  items.forEach((item, i) => {
    if (ids.has(identity(item))) fail(); ids.add(identity(item));
    if (i && (time(items[i - 1]) < time(item) || time(items[i - 1]) === time(item) && identity(items[i - 1]) <= identity(item))) fail();
  });
}
const digest = async value => {
  if (!globalThis.crypto?.subtle) fail();
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
};
function anchorCopy(input) {
  fields(input, ['publicationId', 'snapshotSha256'], ['preparationId', 'publisherUserId']);
  const value = { publicationId: input.publicationId, snapshotSha256: input.snapshotSha256,
    preparationId: input.preparationId, publisherUserId: input.publisherUserId };
  pattern(value.publicationId, PUBLICATION); pattern(value.snapshotSha256, SHA);
  if (value.preparationId !== undefined) pattern(value.preparationId, PREPARATION);
  if (value.publisherUserId !== undefined) integer(value.publisherUserId);
  return value;
}
function availability(value, pkg) {
  fields(value, ['status', 'views', 'documents']);
  if (!['available', 'unavailable'].includes(value.status) || !Array.isArray(value.views) || !Array.isArray(value.documents)
      || value.views.length !== pkg.results.length || value.documents.length !== pkg.documents.length) fail();
  value.views.forEach((item, i) => { fields(item, ['viewId', 'status']);
    if (item.viewId !== pkg.results[i].viewId || !['available', 'unavailable'].includes(item.status)) fail(); });
  value.documents.forEach((item, i) => { fields(item, ['documentId', 'versionId', 'status']);
    if (item.documentId !== pkg.documents[i].documentId || item.versionId !== pkg.documents[i].versionId
        || !['available', 'unavailable'].includes(item.status)) fail(); });
  if (value.status !== ([...value.views, ...value.documents].every(item => item.status === 'available') ? 'available' : 'unavailable')) fail();
}
async function full(value, scope, anchor) {
  envelope(value, scope, 'viewerUserId', ['publicationId', 'publisherUserId', 'publisherLabel', 'publishedAt', 'preparationId',
    'snapshotSha256', 'policy', 'canPublish', 'canWithdraw', 'package', 'availability']);
  header(value, scope.userId);
  if (typeof value.canPublish !== 'boolean' || value.publicationId !== anchor.publicationId || value.snapshotSha256 !== anchor.snapshotSha256
      || anchor.preparationId !== undefined && value.preparationId !== anchor.preparationId
      || anchor.publisherUserId !== undefined && value.publisherUserId !== anchor.publisherUserId) fail();
  if (value.policy.state === 'withdrawn') {
    if (value.package !== null || value.availability !== null) fail(); return value;
  }
  const pkg = await validateSnapshotPackage(value.package, { serviceId: value.serviceId, projectId: value.projectId,
    analysisId: value.analysisId, ownerUserId: value.publisherUserId, preparationId: value.preparationId, snapshotSha256: value.snapshotSha256 });
  if (pkg.createdAt > value.publishedAt) fail(); availability(value.availability, pkg); return value;
}
export function validateSnapshotPublicationList(input, expectedScope) {
  try {
    const value = capture(input, L.listBytes), scope = scopeCopy(expectedScope, true);
    envelope(value, scope, 'viewerUserId', ['canPublish', 'items', 'nextCursor']);
    if (typeof value.canPublish !== 'boolean') fail(); page(value);
    value.items.forEach(item => summary(item, scope.userId));
    ordered(value.items, item => item.publishedAt, item => item.publicationId); return value;
  } catch { fail(); }
}
export async function validateSnapshotPublication(input, expectedScope, expectedAnchor) {
  try {
    // Capture the viewer, immutable anchor and all nested body values before SHA awaits.
    const value = capture(input, L.fullBytes), scope = scopeCopy(expectedScope), anchor = anchorCopy(expectedAnchor);
    return await full(value, scope, anchor);
  } catch { fail(); }
}
function request(value, scope, requireNormalized = true) {
  if (!value || !['publish', 'withdraw'].includes(value.action)) fail();
  const { action, ...body } = value;
  const normalized = (action === 'publish' ? normalizePublishAnalysisSnapshot : normalizeWithdrawAnalysisSnapshot)(body);
  const result = { action, ...normalized };
  if (normalized.ownerUserId !== scope.userId || normalized.projectId !== scope.projectId || normalized.analysisId !== scope.analysisId
      || scope.serviceId !== undefined && normalized.serviceId !== scope.serviceId
      || requireNormalized && canonicalSnapshotJson(result) !== canonicalSnapshotJson(value)) fail();
  return result;
}
function canonicalRequest(value) {
  const { action, ...body } = value;
  return (action === 'publish' ? canonicalPublishAnalysisSnapshot : canonicalWithdrawAnalysisSnapshot)(body);
}
function accepted(value, original) {
  fields(value, ['action', 'publicationId', 'snapshotSha256', 'acceptedAt', 'acceptedPolicyVersion', 'auditEventId']);
  pattern(value.publicationId, PUBLICATION); pattern(value.snapshotSha256, SHA); timestamp(value.acceptedAt);
  pattern(value.auditEventId, /^aud_[a-f0-9]{24}$/);
  if (value.action !== original.action || value.snapshotSha256 !== original.snapshotSha256
      || value.acceptedPolicyVersion !== (original.action === 'publish' ? 1 : 2)
      || original.action === 'withdraw' && value.publicationId !== original.publicationId) fail();
}
async function actionSummary(value, scope) {
  fields(value, ['requestId', 'requestSha256', 'request', 'acceptance', 'currentPolicy']);
  pattern(value.requestId, UUID); pattern(value.requestSha256, SHA);
  const original = request(value.request, scope); accepted(value.acceptance, original); policy(value.currentPolicy);
  if (original.requestId !== value.requestId || await digest(canonicalRequest(original)) !== value.requestSha256
      || original.action === 'withdraw' && (value.currentPolicy.state !== 'withdrawn'
        || value.currentPolicy.withdrawnAt > value.acceptance.acceptedAt || value.currentPolicy.withdrawnByUserId !== scope.userId)
      || original.action === 'publish' && value.currentPolicy.state === 'withdrawn' && value.currentPolicy.withdrawnAt < value.acceptance.acceptedAt) fail();
}
export async function validateSnapshotPublicationRequests(input, expectedScope) {
  try {
    const value = capture(input, L.listBytes), scope = scopeCopy(expectedScope, true);
    envelope(value, scope, 'actorUserId', ['items', 'nextCursor']); page(value);
    const bound = { ...scope, serviceId: value.serviceId }, publications = new Map();
    for (const item of value.items) {
      await actionSummary(item, bound);
      const key = item.acceptance.publicationId, previous = publications.get(key);
      if (previous && (previous.request.action === item.request.action || previous.acceptance.snapshotSha256 !== item.acceptance.snapshotSha256
          || canonicalSnapshotJson(previous.currentPolicy) !== canonicalSnapshotJson(item.currentPolicy))) fail();
      publications.set(key, item);
    }
    ordered(value.items, item => item.acceptance.acceptedAt, item => item.requestId); return value;
  } catch { fail(); }
}
export async function validateSnapshotPublicationReceipt(input, expectedScope, expectedRequest) {
  try {
    const value = capture(input, L.fullBytes), scope = scopeCopy(expectedScope);
    const expected = expectedRequest === undefined ? null : request(capture(expectedRequest, L.requestBytes), scope, false);
    envelope(value, scope, 'actorUserId', ['requestId', 'requestSha256', 'request', 'replayed', 'acceptance', 'current']);
    pattern(value.requestId, UUID); pattern(value.requestSha256, SHA); if (typeof value.replayed !== 'boolean') fail();
    const original = request(value.request, scope); accepted(value.acceptance, original);
    if (original.requestId !== value.requestId || expected && canonicalRequest(expected) !== canonicalRequest(original)
        || await digest(canonicalRequest(original)) !== value.requestSha256) fail();
    const anchor = { publicationId: value.acceptance.publicationId, snapshotSha256: value.acceptance.snapshotSha256,
      ...(original.action === 'publish' ? { preparationId: original.preparationId, publisherUserId: scope.userId } : {}) };
    await full(value.current, scope, anchor);
    if (original.action === 'publish' && (value.current.publishedAt > value.acceptance.acceptedAt
          || value.current.policy.state === 'withdrawn' && value.current.policy.withdrawnAt < value.acceptance.acceptedAt)
        || original.action === 'withdraw' && (value.current.policy.state !== 'withdrawn'
          || value.current.policy.withdrawnAt > value.acceptance.acceptedAt || value.current.policy.withdrawnByUserId !== scope.userId)) fail();
    return value;
  } catch { fail(); }
}
export function validateSnapshotAlreadyPublished(input, expectedScope, acknowledgedPreparation) {
  try {
    const value = capture(input, L.listBytes), scope = scopeCopy(expectedScope), expected = capture(acknowledgedPreparation, L.requestBytes);
    fields(value, ['error', 'code', 'publication']); fields(expected, ['preparationId', 'snapshotSha256']);
    pattern(expected.preparationId, PREPARATION); pattern(expected.snapshotSha256, SHA);
    if (value.code !== 'ANALYSIS_SNAPSHOT_ALREADY_PUBLISHED' || typeof value.error !== 'string' || !value.error
        || value.error.length > 500 || /[\p{Cc}\p{Cf}]/u.test(value.error)) fail();
    summary(value.publication, scope.userId);
    if (value.publication.policy.state !== 'published' || value.publication.publisherUserId !== scope.userId
        || value.publication.preparationId !== expected.preparationId || value.publication.snapshotSha256 !== expected.snapshotSha256) fail();
    return value;
  } catch { fail(); }
}
