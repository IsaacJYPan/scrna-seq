import { ANALYSIS_LOCAL_INTAKE_LIMITS, normalizeAnalysisLocalIntake, canonicalAnalysisLocalIntake,
  analysisLocalIntakeAttachmentRequest } from '../../shared/analysisLocalIntake.mjs';
import { ANALYSIS_ATTACHMENT_ID, ANALYSIS_ATTACHMENT_REVISION_ID, normalizeAnalysisAttachmentCreate } from '../../shared/analysisAttachment.mjs';
import { validateArtifactFormat } from '../../shared/analysisModel.mjs';
import { normalizeArtifactImportRequest, validateArtifactImportReceipt } from '../artifacts/artifactImportReceipt';
import { validateAttachmentAcceptance, validateAttachmentCorrectionAcceptance } from './analysisAttachmentValidation';

const serviceId = /^svc_[a-f0-9]{32}$/;
const analysisId = /^ra_[a-f0-9]{24}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const checksum = /^[a-f0-9]{64}$/;
const commonFields = ['serviceId', 'projectId', 'analysisId', 'ownerUserId', 'canContinue', 'canUpload', 'canAttach'];
const originFields = ['origin', 'sourceReference', 'documentReference', 'environmentReference'];
const revisionFields = ['id', 'attachmentId', 'revisionNumber', 'previousRevisionId', 'reference', 'caption', 'suppliedOrigin', 'createdByUserId', 'createdAt'];
const formats = { 'org.ietf.csv': 'table', 'org.iana.tsv': 'table', 'org.w3.png': 'image', 'org.iso.jpeg': 'image' };
const placeholderId = '00000000-0000-4000-8000-000000000000';
const fail = () => { throw Object.assign(new Error('The original local intake could not be confirmed. Keep its original requests and check again.'), { code: 'INVALID_ANALYSIS_LOCAL_INTAKE_RESPONSE' }); };

function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key !== 'string' || !required.includes(key) && !optional.includes(key)
      || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
  })) fail();
}
function densePage(value, limit) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit
      || Reflect.ownKeys(value).length !== value.length + 1
      || Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, index))
        .some(descriptor => !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) fail();
  return value;
}
function json(value, depth = 0) {
  if (depth > 24) fail();
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { densePage(value, 10000).forEach(item => json(item, depth + 1)); return; }
  if (!value || typeof value !== 'object') fail();
  const keys = Reflect.ownKeys(value);
  fields(value, keys);
  if (keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) fail();
  keys.forEach(key => json(value[key], depth + 1));
}
function equal(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
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
function envelope(result, scope, extras, discovery = false) {
  fields(scope, ['projectId', 'analysisId', 'userId'], ['serviceId']); fields(result, [...commonFields, ...extras]);
  if (typeof scope.projectId !== 'string' || !/^proj_[a-f0-9]{16,40}$/.test(scope.projectId)
      || typeof scope.analysisId !== 'string' || !analysisId.test(scope.analysisId)
      || !['number', 'string'].includes(typeof scope.userId) || typeof scope.userId === 'string' && !/^[1-9]\d*$/.test(scope.userId)
      || !Number.isSafeInteger(Number(scope.userId)) || Number(scope.userId) < 1
      || typeof result.serviceId !== 'string' || !serviceId.test(result.serviceId)
      || (!discovery || scope.serviceId !== undefined) && (typeof scope.serviceId !== 'string' || !serviceId.test(scope.serviceId) || result.serviceId !== scope.serviceId)
      || result.projectId !== scope.projectId || result.analysisId !== scope.analysisId || result.ownerUserId !== Number(scope.userId)
      || typeof result.canContinue !== 'boolean' || typeof result.canUpload !== 'boolean' || typeof result.canAttach !== 'boolean'
      || result.canContinue !== result.canUpload || result.canContinue !== result.canAttach) fail();
  return Object.fromEntries(commonFields.map(key => [key, result[key]]));
}
function outcome(value) {
  fields(value, ['status', 'receipt']);
  if (!['unconfirmed', 'conflict', 'accepted'].includes(value.status)
      || (value.status === 'accepted' ? value.receipt === null : value.receipt !== null)) fail();
  return value.status;
}
function summary(value, common) {
  fields(value, ['requestId', 'requestSha256', 'createdAt', 'originalFilename', 'name', 'caption', 'action', 'attachmentId',
    'expectedHeadRevisionId', 'importStatus', 'attachmentStatus']);
  if (typeof value.requestId !== 'string' || !uuid.test(value.requestId) || typeof value.requestSha256 !== 'string' || !checksum.test(value.requestSha256)
      || !['unconfirmed', 'conflict', 'accepted'].includes(value.importStatus) || !['unconfirmed', 'conflict', 'accepted'].includes(value.attachmentStatus)
      || value.attachmentStatus === 'accepted' && value.importStatus !== 'accepted'
      || value.action !== 'create' && value.action !== 'correct'
      || value.action === 'create' && (value.attachmentId !== null || value.expectedHeadRevisionId !== null)
      || value.action === 'correct' && (typeof value.attachmentId !== 'string' || !ANALYSIS_ATTACHMENT_ID.test(value.attachmentId)
        || typeof value.expectedHeadRevisionId !== 'string' || !ANALYSIS_ATTACHMENT_REVISION_ID.test(value.expectedHeadRevisionId))) fail();
  try {
    normalizeArtifactImportRequest({ schema: 'traceomics.artifact-import.v1', projectId: common.projectId, ownerUserId: common.ownerUserId,
      requestId: value.requestId, originalFilename: value.originalFilename, name: value.name, artifactType: 'auto', previousVersionId: null,
      sha256: '0'.repeat(64), sizeBytes: 0 });
    const normalized = normalizeAnalysisAttachmentCreate({ requestId: placeholderId,
      reference: { kind: 'artifact-version', versionId: `av_${'0'.repeat(24)}`, sha256: '0'.repeat(64) }, caption: value.caption });
    if (normalized.caption !== value.caption || !/\.(?:csv|tsv|png|jpe?g)$/i.test(value.originalFilename)) fail();
  } catch { fail(); }
  return { ...value, createdAt: timestamp(value.createdAt) };
}
export function validateAnalysisLocalIntakeList(result, scope) {
  json(result);
  const common = envelope(result, scope, ['items', 'nextCursor'], true);
  const items = densePage(result.items, ANALYSIS_LOCAL_INTAKE_LIMITS.page).map(value => summary(value, common));
  if (new Set(items.map(value => value.requestId)).size !== items.length) fail();
  for (let index = 1; index < items.length; index++) {
    const previous = items[index - 1], current = items[index];
    if (Date.parse(previous.createdAt) < Date.parse(current.createdAt)
        || Date.parse(previous.createdAt) === Date.parse(current.createdAt) && previous.requestId < current.requestId) fail();
  }
  const nextCursor = result.nextCursor;
  if (nextCursor !== null && (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > ANALYSIS_LOCAL_INTAKE_LIMITS.cursor
      || !/^[A-Za-z0-9_-]+$/.test(nextCursor)) || !items.length && nextCursor !== null) fail();
  return { ...common, items, nextCursor };
}
function importReceipt(value) {
  fields(value, ['requestId', 'status', 'canImport', 'requestSha256', 'request', 'acceptance', 'availability', 'version']);
  fields(value.acceptance, ['artifactId', 'versionId', 'versionNumber', 'previousVersionId', 'sha256', 'sizeBytes', 'createdAt']);
  if (value.acceptance.versionNumber !== 1) fail();
  timestamp(value.acceptance.createdAt);
  if (value.version !== null) {
    fields(value.version, ['artifactId', 'versionId', 'projectId', 'ownerId', 'sha256', 'sizeBytes', 'name', 'versionNumber', 'previousVersionId', 'reference', 'format', 'type'],
      ['kind', 'schemaVersion', 'storageRef', 'sourceRunId', 'createdAt', 'previews', 'owner', 'source', 'previewBudget', 'canReplace']);
    fields(value.version.reference, ['artifactId', 'versionId', 'projectId', 'sha256']);
    try { validateArtifactFormat(value.version.format); } catch { fail(); }
    if (!Object.hasOwn(formats, value.version.format.id) || value.version.format.version !== '1' || value.version.type !== formats[value.version.format.id]) fail();
    if (Object.hasOwn(value.version, 'kind') && value.version.kind !== 'artifact-version'
        || Object.hasOwn(value.version, 'schemaVersion') && value.version.schemaVersion !== 1
        || Object.hasOwn(value.version, 'storageRef') && value.version.storageRef !== value.acceptance.versionId
        || Object.hasOwn(value.version, 'sourceRunId') && value.version.sourceRunId !== null
        || Object.hasOwn(value.version, 'canReplace') && value.version.canReplace !== true) fail();
    if (Object.hasOwn(value.version, 'createdAt')) timestamp(value.version.createdAt);
    if (Object.hasOwn(value.version, 'owner')) {
      fields(value.version.owner, ['id', 'displayName']);
      if (value.version.owner.id !== value.version.ownerId || typeof value.version.owner.displayName !== 'string'
          || !value.version.owner.displayName.trim() || value.version.owner.displayName.length > 200 || /\p{Cc}/u.test(value.version.owner.displayName)) fail();
    }
    if (Object.hasOwn(value.version, 'source')) {
      fields(value.version.source, ['kind', 'id']);
      if (value.version.source.kind !== 'managed-file' || value.version.source.id !== value.acceptance.versionId) fail();
    }
    if (Object.hasOwn(value.version, 'previewBudget')) {
      fields(value.version.previewBudget, ['responseBytes', 'imageBytes', 'maximumRows']);
      if (Object.values(value.version.previewBudget).some(item => !Number.isSafeInteger(item) || item < 1)) fail();
    }
    if (Object.hasOwn(value.version, 'previews')) {
      densePage(value.version.previews, 16);
      if (value.version.previews.some(item => !['table', 'image'].includes(item)) || new Set(value.version.previews).size !== value.version.previews.length) fail();
    }
  }
}
function attachmentReceipt(value) {
  fields(value, ['projectId', 'analysisId', 'canWrite', 'requestId', 'requestSha256', 'replayed', 'acceptedRevision', 'acceptedSourceAccess', 'attachment']);
  fields(value.attachment, ['id', 'headRevisionId', 'revision', 'sourceAccess']);
  for (const revision of [value.acceptedRevision, value.attachment.revision]) {
    fields(revision, revisionFields); fields(revision.reference, ['kind', 'versionId', 'sha256']); fields(revision.suppliedOrigin, originFields);
    timestamp(revision.createdAt);
  }
}
export async function validateAnalysisLocalIntake(result, scope, expectedRecipe) {
  try {
    json(result);
    result = JSON.parse(JSON.stringify(result));
    const common = envelope(result, scope, ['requestId', 'requestSha256', 'recipe', 'createdAt', 'replayed', 'importOutcome', 'attachmentOutcome']);
    const recipe = normalizeAnalysisLocalIntake(result.recipe), canonical = canonicalAnalysisLocalIntake(scope.analysisId, recipe);
    if (!equal(result.recipe, recipe) || recipe.serviceId !== common.serviceId || recipe.importRequest.projectId !== common.projectId
        || recipe.importRequest.ownerUserId !== common.ownerUserId || result.requestId !== recipe.requestId
        || typeof result.requestSha256 !== 'string' || !checksum.test(result.requestSha256) || typeof result.replayed !== 'boolean') fail();
    if (expectedRecipe !== undefined && canonicalAnalysisLocalIntake(scope.analysisId, expectedRecipe) !== canonical) fail();
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    const requestSha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (result.requestSha256 !== requestSha256) fail();
    const importStatus = outcome(result.importOutcome), attachmentStatus = outcome(result.attachmentOutcome);
    let imported = null, attached = null;
    if (importStatus === 'accepted') {
      importReceipt(result.importOutcome.receipt);
      imported = await validateArtifactImportReceipt(result.importOutcome.receipt, recipe.importRequest);
    }
    if (attachmentStatus === 'accepted') {
      if (!imported) fail();
      attachmentReceipt(result.attachmentOutcome.receipt);
      const input = analysisLocalIntakeAttachmentRequest(recipe, imported.acceptance);
      attached = recipe.attachment.action === 'correct'
        ? await validateAttachmentCorrectionAcceptance(result.attachmentOutcome.receipt, scopeWithoutService(scope), recipe.attachment.attachmentId, input)
        : await validateAttachmentAcceptance(result.attachmentOutcome.receipt, scopeWithoutService(scope), input);
    }
    return { ...common, requestId: recipe.requestId, requestSha256, recipe, createdAt: timestamp(result.createdAt), replayed: result.replayed,
      importOutcome: { status: importStatus, receipt: imported && JSON.parse(JSON.stringify(imported)) },
      attachmentOutcome: { status: attachmentStatus, receipt: attached } };
  } catch { fail(); }
}
const scopeWithoutService = scope => ({ projectId: scope.projectId, analysisId: scope.analysisId, userId: scope.userId });
