import { ANALYSIS_SERVER_INTAKE_LIMITS, normalizeAnalysisServerIntake, canonicalAnalysisServerIntake,
  analysisServerIntakeAttachmentRequest } from '../../shared/analysisServerIntake.mjs';
import { ANALYSIS_ATTACHMENT_ID, ANALYSIS_ATTACHMENT_REVISION_ID, normalizeAnalysisAttachmentCreate } from '../../shared/analysisAttachment.mjs';
import { normalizeServerDataImportRequest } from '../../shared/serverDataImport.mjs';
import { validateAnalysisLocalIntake, validateAnalysisLocalIntakeList } from './analysisLocalIntakeValidation';
import { validateAttachmentAcceptance, validateAttachmentCorrectionAcceptance } from './analysisAttachmentValidation';
import { validateServerDataImport } from '../artifacts/serverDataImportValidation';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const SERVICE = /^svc_[a-f0-9]{32}$/;
const commonFields = ['serviceId', 'projectId', 'analysisId', 'ownerUserId', 'canContinue', 'canAttach'];
const summaryFields = ['sourceKind', 'canStartImport', 'requestId', 'requestSha256', 'createdAt', 'originalFilename', 'name',
  'caption', 'action', 'attachmentId', 'expectedHeadRevisionId', 'importStatus', 'attachmentStatus'];
const localStatuses = ['unconfirmed', 'conflict', 'accepted'];
const serverStatuses = ['unconfirmed', 'conflict', 'pending', 'failed', 'accepted', 'legacy-unrecorded'];
const originFields = ['origin', 'sourceReference', 'documentReference', 'environmentReference'];
const revisionFields = ['id', 'attachmentId', 'revisionNumber', 'previousRevisionId', 'reference', 'caption', 'suppliedOrigin', 'createdByUserId', 'createdAt'];
const placeholder = '00000000-0000-4000-8000-000000000000';
const fail = () => { throw Object.assign(new Error('The original evidence import could not be confirmed. Keep its requests and check again.'), { code: 'INVALID_EVIDENCE_INTAKE_RESPONSE' }); };

function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  if (required.some(key => !Object.hasOwn(value, key)) || Reflect.ownKeys(value).some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key !== 'string' || !required.includes(key) && !optional.includes(key)
      || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
  })) fail();
}
function dense(value, limit) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit
      || Reflect.ownKeys(value).length !== value.length + 1
      || Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, index))
        .some(descriptor => !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) fail();
  return value;
}
function snapshot(value) {
  const ancestors = new Set(); let nodes = 0;
  function visit(item, depth = 0) {
    if (++nodes > 100000 || depth > 24) fail();
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') { if (!item.isWellFormed()) fail(); return; }
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || ancestors.has(item)) fail();
    ancestors.add(item);
    if (Array.isArray(item)) dense(item, 10000).forEach(child => visit(child, depth + 1));
    else {
      const keys = Reflect.ownKeys(item); fields(item, keys);
      if (keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) fail();
      keys.forEach(key => visit(item[key], depth + 1));
    }
    ancestors.delete(item);
  }
  visit(value);
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > 512 * 1024) fail();
  return JSON.parse(encoded);
}
function scopeCopy(value, discovery) {
  fields(value, ['projectId', 'analysisId', 'userId'], ['serviceId']);
  const { projectId, analysisId, userId, serviceId } = value;
  if (typeof projectId !== 'string' || !/^proj_[a-f0-9]{16,40}$/.test(projectId)
      || typeof analysisId !== 'string' || !/^ra_[a-f0-9]{24}$/.test(analysisId)
      || !['number', 'string'].includes(typeof userId) || typeof userId === 'string' && !/^[1-9]\d*$/.test(userId)
      || !Number.isSafeInteger(Number(userId)) || Number(userId) < 1
      || (!discovery || serviceId !== undefined) && (typeof serviceId !== 'string' || !SERVICE.test(serviceId))) fail();
  return { projectId, analysisId, userId, ...(serviceId === undefined ? {} : { serviceId }) };
}
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40) fail();
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,6})?(?:Z|([+-])(\d\d):(\d\d))$/.exec(value);
  if (!match) fail();
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  if (+month < 1 || +month > 12 || +day < 1 || +day > new Date(Date.UTC(+year, +month, 0)).getUTCDate()
      || +hour > 23 || +minute > 59 || +second > 59 || +(offsetHour || 0) > 23 || +(offsetMinute || 0) > 59
      || !Number.isFinite(Date.parse(value))) fail();
  return value;
}
function envelope(result, scope, extras) {
  fields(result, [...commonFields, ...extras]);
  if (result.projectId !== scope.projectId || result.analysisId !== scope.analysisId || result.ownerUserId !== Number(scope.userId)
      || typeof result.serviceId !== 'string' || !SERVICE.test(result.serviceId)
      || scope.serviceId !== undefined && result.serviceId !== scope.serviceId
      || typeof result.canContinue !== 'boolean' || typeof result.canAttach !== 'boolean' || result.canContinue !== result.canAttach) fail();
  return Object.fromEntries(commonFields.map(key => [key, result[key]]));
}
function kind(value) { if (!['local', 'server'].includes(value)) fail(); return value; }
function transferFlag(value, common, sourceKind) {
  if (typeof value !== 'boolean' || value && !common.canContinue || sourceKind === 'local' && value !== common.canContinue) fail();
}
function localList(common, items, nextCursor) {
  return { ...common, canUpload: common.canContinue, items: items.map(({ sourceKind: _kind, canStartImport: _start, ...item }) => item), nextCursor };
}
function serverSummary(value, common) {
  if (typeof value.requestId !== 'string' || !UUID.test(value.requestId) || typeof value.requestSha256 !== 'string' || !HASH.test(value.requestSha256)
      || !serverStatuses.includes(value.importStatus) || !localStatuses.includes(value.attachmentStatus)
      || value.attachmentStatus === 'accepted' && value.importStatus !== 'accepted'
      || value.action !== 'create' && value.action !== 'correct'
      || value.action === 'create' && (value.attachmentId !== null || value.expectedHeadRevisionId !== null)
      || value.action === 'correct' && (typeof value.attachmentId !== 'string' || !ANALYSIS_ATTACHMENT_ID.test(value.attachmentId)
        || typeof value.expectedHeadRevisionId !== 'string' || !ANALYSIS_ATTACHMENT_REVISION_ID.test(value.expectedHeadRevisionId))
      || typeof value.originalFilename !== 'string' || value.originalFilename.includes('/') || !/\.(?:csv|tsv|png|jpe?g)$/i.test(value.originalFilename)) fail();
  const selected = normalizeServerDataImportRequest({ requestId: value.requestId, rootId: 'summary', relativePath: value.originalFilename,
    selectionToken: '0'.repeat(64), name: value.name });
  const caption = normalizeAnalysisAttachmentCreate({ requestId: placeholder,
    reference: { kind: 'artifact-version', versionId: 'av_' + '0'.repeat(24), sha256: '0'.repeat(64) }, caption: value.caption });
  if (selected.name !== value.name || caption.caption !== value.caption || !value.originalFilename.isWellFormed()) fail();
  transferFlag(value.canStartImport, common, value.sourceKind); timestamp(value.createdAt);
}
export function validateEvidenceIntakeList(input, expectedScope) {
  try {
    const result = snapshot(input), scope = scopeCopy(expectedScope, true);
    const common = envelope(result, scope, ['items', 'nextCursor']);
    dense(result.items, ANALYSIS_SERVER_INTAKE_LIMITS.page).forEach(value => {
      fields(value, summaryFields); kind(value.sourceKind); transferFlag(value.canStartImport, common, value.sourceKind);
      if (value.sourceKind === 'server') serverSummary(value, common);
    });
    validateAnalysisLocalIntakeList(localList(common, result.items.filter(value => value.sourceKind === 'local'), null), scope);
    if (new Set(result.items.map(value => value.requestId)).size !== result.items.length) fail();
    for (let index = 1; index < result.items.length; index++) {
      const previous = result.items[index - 1], current = result.items[index];
      if (Date.parse(previous.createdAt) < Date.parse(current.createdAt)
          || Date.parse(previous.createdAt) === Date.parse(current.createdAt) && previous.requestId < current.requestId) fail();
    }
    if (result.nextCursor !== null && (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 256
      || !/^[A-Za-z0-9_-]+$/.test(result.nextCursor)) || !result.items.length && result.nextCursor !== null) fail();
    return result;
  } catch { fail(); }
}
function outcome(value, statuses) {
  fields(value, ['status', 'receipt']);
  if (!statuses.includes(value.status) || (['unconfirmed', 'conflict'].includes(value.status) ? value.receipt !== null : value.receipt === null)) fail();
  return value.status;
}
function attachmentReceipt(value) {
  fields(value, ['projectId', 'analysisId', 'canWrite', 'requestId', 'requestSha256', 'replayed', 'acceptedRevision', 'acceptedSourceAccess', 'attachment']);
  fields(value.attachment, ['id', 'headRevisionId', 'revision', 'sourceAccess']);
  for (const revision of [value.acceptedRevision, value.attachment.revision]) {
    fields(revision, revisionFields); fields(revision.reference, ['kind', 'versionId', 'sha256']); fields(revision.suppliedOrigin, originFields);
    timestamp(revision.createdAt);
  }
}
function same(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
}
async function digest(value) {
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function validateEvidenceIntake(input, expectedScope, expectedRecord) {
  try {
    const result = snapshot(input), scope = scopeCopy(expectedScope, false), expected = expectedRecord === undefined ? undefined : snapshot(expectedRecord);
    const common = envelope(result, scope, ['sourceKind', 'canStartImport', 'requestId', 'requestSha256', 'recipe', 'createdAt', 'replayed', 'importOutcome', 'attachmentOutcome']);
    kind(result.sourceKind); transferFlag(result.canStartImport, common, result.sourceKind);
    if (expected !== undefined) { fields(expected, ['sourceKind', 'recipe']); if (kind(expected.sourceKind) !== result.sourceKind) fail(); }
    if (result.sourceKind === 'local') {
      const { sourceKind: _kind, canStartImport, ...legacy } = result;
      const value = await validateAnalysisLocalIntake({ ...legacy, canUpload: canStartImport }, scope, expected?.recipe);
      const { canUpload: _upload, ...validated } = value;
      return { sourceKind: 'local', ...validated, canStartImport };
    }
    const recipe = normalizeAnalysisServerIntake(result.recipe), canonical = canonicalAnalysisServerIntake(scope.analysisId, recipe);
    if (!same(result.recipe, recipe) || recipe.serviceId !== common.serviceId || recipe.projectId !== common.projectId
        || recipe.ownerUserId !== common.ownerUserId || result.requestId !== recipe.requestId
        || typeof result.requestSha256 !== 'string' || !HASH.test(result.requestSha256) || typeof result.replayed !== 'boolean') fail();
    if (expected !== undefined && canonicalAnalysisServerIntake(scope.analysisId, expected.recipe) !== canonical) fail();
    const requestSha256 = await digest(canonical);
    if (result.requestSha256 !== requestSha256) fail();
    const importStatus = outcome(result.importOutcome, serverStatuses), attachmentStatus = outcome(result.attachmentOutcome, localStatuses);
    let imported = null, attached = null;
    if (!['unconfirmed', 'conflict'].includes(importStatus)) {
      imported = await validateServerDataImport(result.importOutcome.receipt,
        { projectId: scope.projectId, userId: scope.userId, serviceId: scope.serviceId, requestId: recipe.requestId }, recipe.importRequest);
      if (imported.reservedBytes !== recipe.selectionSizeBytes
          || importStatus === 'pending' && imported.status !== 'pending' || importStatus === 'failed' && imported.status !== 'failed'
          || importStatus === 'legacy-unrecorded' && (imported.status !== 'succeeded' || imported.acceptanceState !== 'legacy-unrecorded')
          || importStatus === 'accepted' && (imported.status !== 'succeeded' || imported.acceptanceState !== 'recorded')) fail();
      if (importStatus === 'accepted') analysisServerIntakeAttachmentRequest(recipe, imported.acceptance);
    }
    if (attachmentStatus === 'accepted') {
      if (importStatus !== 'accepted') fail();
      attachmentReceipt(result.attachmentOutcome.receipt);
      if (result.attachmentOutcome.receipt.canWrite !== common.canAttach || result.attachmentOutcome.receipt.acceptedSourceAccess === 'restricted') fail();
      const request = analysisServerIntakeAttachmentRequest(recipe, imported.acceptance);
      const attachmentScope = { projectId: scope.projectId, analysisId: scope.analysisId, userId: scope.userId };
      attached = recipe.attachment.action === 'correct'
        ? await validateAttachmentCorrectionAcceptance(result.attachmentOutcome.receipt, attachmentScope, recipe.attachment.attachmentId, request)
        : await validateAttachmentAcceptance(result.attachmentOutcome.receipt, attachmentScope, request);
    }
    return { sourceKind: 'server', ...common, canStartImport: result.canStartImport, requestId: recipe.requestId,
      requestSha256, recipe, createdAt: timestamp(result.createdAt), replayed: result.replayed,
      importOutcome: { status: importStatus, receipt: imported }, attachmentOutcome: { status: attachmentStatus, receipt: attached } };
  } catch { fail(); }
}
