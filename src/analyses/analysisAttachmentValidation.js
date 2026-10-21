import { ANALYSIS_ATTACHMENT_ID, ANALYSIS_ATTACHMENT_LIMITS, ANALYSIS_ATTACHMENT_REVISION_ID,
  canonicalAnalysisAttachmentContent, canonicalAnalysisAttachmentCorrection, normalizeAnalysisAttachmentCreate,
  normalizeAnalysisAttachmentCorrection } from '../../shared/analysisAttachment.mjs';

const managedVersionId = /^av_[a-f0-9]{24}$/;
const analysisId = /^ra_[a-f0-9]{24}$/;
const checksum = /^[a-f0-9]{64}$/;
const supportedFormats = new Set(['org.ietf.csv', 'org.iana.tsv', 'org.w3.png', 'org.iso.jpeg']);
const placeholderRequestId = '00000000-0000-4000-8000-000000000000';
const fail = () => { throw Object.assign(new Error('The attachment response could not be confirmed. Keep the original request and check again.'), { code: 'INVALID_ANALYSIS_ATTACHMENT_RESPONSE' }); };
const positiveInteger = value => Number.isSafeInteger(value) && value > 0 && value < 2147483647;
const sourceAccess = value => {
  if (!['available', 'restricted', 'unavailable'].includes(value)) fail();
  return value;
};
const canonicalContent = value => canonicalAnalysisAttachmentContent({ reference: value.reference, caption: value.caption, suppliedOrigin: value.suppliedOrigin });

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) fail();
  return value;
}
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value)
      || !Number.isFinite(Date.parse(value))) fail();
  return value;
}
function cursor(value) {
  if (value !== null && (typeof value !== 'string' || !value || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value))) fail();
  return value;
}
function envelope(result, scope) {
  record(scope); record(result);
  if (typeof scope.projectId !== 'string' || !scope.projectId || scope.projectId.length > 128 || /\p{Cc}/u.test(scope.projectId)
      || typeof scope.analysisId !== 'string' || !analysisId.test(scope.analysisId)
      || !['number', 'string'].includes(typeof scope.userId) || typeof scope.userId === 'string' && !/^[1-9]\d*$/.test(scope.userId)
      || !Number.isSafeInteger(Number(scope.userId)) || Number(scope.userId) < 1
      || result.projectId !== scope.projectId || result.analysisId !== scope.analysisId || typeof result.canWrite !== 'boolean') fail();
  return { projectId: result.projectId, analysisId: result.analysisId, canWrite: result.canWrite };
}
function content(value) {
  record(value); record(value.reference); record(value.suppliedOrigin);
  let normalized;
  try { normalized = normalizeAnalysisAttachmentCreate({ requestId: placeholderRequestId, reference: value.reference, caption: value.caption, suppliedOrigin: value.suppliedOrigin }); }
  catch { fail(); }
  if (Object.keys(normalized.reference).some(key => value.reference[key] !== normalized.reference[key])
      || value.caption !== normalized.caption || Object.keys(normalized.suppliedOrigin).some(key => value.suppliedOrigin[key] !== normalized.suppliedOrigin[key])) fail();
  return { reference: normalized.reference, caption: normalized.caption, suppliedOrigin: normalized.suppliedOrigin };
}
function revision(value, attachmentId, requireLineage = false) {
  record(value);
  if (typeof value.id !== 'string' || !ANALYSIS_ATTACHMENT_REVISION_ID.test(value.id)
      || typeof value.attachmentId !== 'string' || !ANALYSIS_ATTACHMENT_ID.test(value.attachmentId)
      || attachmentId !== undefined && value.attachmentId !== attachmentId || !positiveInteger(value.revisionNumber)
      || value.revisionNumber > (ANALYSIS_ATTACHMENT_LIMITS.revisions ?? 200)
      || !Number.isSafeInteger(value.createdByUserId) || value.createdByUserId < 1) fail();
  const hasPrevious = Object.hasOwn(value, 'previousRevisionId');
  if (requireLineage && !hasPrevious || hasPrevious && (value.revisionNumber === 1 ? value.previousRevisionId !== null
    : typeof value.previousRevisionId !== 'string' || !ANALYSIS_ATTACHMENT_REVISION_ID.test(value.previousRevisionId) || value.previousRevisionId === value.id)) fail();
  return { id: value.id, attachmentId: value.attachmentId, revisionNumber: value.revisionNumber, ...content(value),
    createdByUserId: value.createdByUserId, createdAt: timestamp(value.createdAt), ...(hasPrevious ? { previousRevisionId: value.previousRevisionId } : {}) };
}
function attachment(value, requireLineage = false) {
  record(value);
  if (typeof value.id !== 'string' || !ANALYSIS_ATTACHMENT_ID.test(value.id)
      || typeof value.headRevisionId !== 'string' || !ANALYSIS_ATTACHMENT_REVISION_ID.test(value.headRevisionId)) fail();
  const saved = revision(value.revision, value.id, requireLineage);
  if (saved.id !== value.headRevisionId) fail();
  return { id: value.id, headRevisionId: value.headRevisionId, revision: saved, sourceAccess: sourceAccess(value.sourceAccess) };
}
function page(items, key) {
  if (!Array.isArray(items) || items.length > ANALYSIS_ATTACHMENT_LIMITS.page || Object.keys(items).length !== items.length
      || Array.from({ length: items.length }, (_, index) => Object.getOwnPropertyDescriptor(items, index))
        .some(descriptor => !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      || new Set(items.map(key)).size !== items.length) fail();
  return items;
}

export function validateAttachmentList(result, scope) {
  const common = envelope(result, scope);
  if (!Array.isArray(result.attachments) || result.attachments.length > ANALYSIS_ATTACHMENT_LIMITS.page) fail();
  page(result.attachments, (_item, index) => index);
  const attachments = result.attachments.map(value => attachment(value));
  return { ...common, attachments: page(attachments, item => item.id), nextCursor: cursor(result.nextCursor) };
}

function option(value) {
  record(value); record(value.reference); record(value.format);
  const reference = value.reference;
  if (Reflect.ownKeys(reference).length !== 3 || reference.kind !== 'artifact-version'
      || typeof reference.versionId !== 'string' || !managedVersionId.test(reference.versionId)
      || typeof reference.sha256 !== 'string' || !checksum.test(reference.sha256)
      || typeof value.name !== 'string' || !value.name.trim() || [...value.name].length > 160
      || !value.name.isWellFormed() || /\p{Cc}/u.test(value.name)
      || !supportedFormats.has(value.format.id) || value.format.version !== '1'
      || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0 || value.sizeBytes > 200 * 1024 * 1024) fail();
  const format = { id: value.format.id, version: value.format.version };
  return { reference: { kind: reference.kind, versionId: reference.versionId, sha256: reference.sha256 }, name: value.name,
    format, sizeBytes: value.sizeBytes, createdAt: timestamp(value.createdAt) };
}
export function validateAttachmentOptions(result, scope) {
  const common = envelope(result, scope);
  if (!Array.isArray(result.items) || result.items.length > ANALYSIS_ATTACHMENT_LIMITS.page) fail();
  page(result.items, (_item, index) => index);
  const items = result.items.map(option);
  return { ...common, items: page(items, item => item.reference.versionId), nextCursor: cursor(result.nextCursor) };
}

export async function validateAttachmentAcceptance(result, scope, input) {
  let request;
  try { request = normalizeAnalysisAttachmentCreate(input); } catch { fail(); }
  return validateAcceptance(result, scope, request, canonicalAnalysisAttachmentContent(request));
}

async function validateAcceptance(result, scope, request, canonical, attachmentId) {
  const common = envelope(result, scope);
  const correction = attachmentId !== undefined;
  const bytes = new TextEncoder().encode(canonical);
  let requestSha256;
  try { requestSha256 = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
  catch { fail(); }
  if (result.requestId !== request.requestId || result.requestSha256 !== requestSha256 || typeof result.replayed !== 'boolean') fail();
  const acceptedRevision = revision(result.acceptedRevision, attachmentId, correction);
  const current = attachment(result.attachment, correction);
  if ((correction ? acceptedRevision.revisionNumber < 2 || acceptedRevision.previousRevisionId !== request.expectedHeadRevisionId
      || current.headRevisionId === request.expectedHeadRevisionId : acceptedRevision.revisionNumber !== 1)
      || acceptedRevision.createdByUserId !== Number(scope.userId) || canonicalContent(acceptedRevision) !== canonicalContent(request)
      || current.id !== acceptedRevision.attachmentId || current.revision.revisionNumber < acceptedRevision.revisionNumber
      || current.revision.revisionNumber === acceptedRevision.revisionNumber && JSON.stringify(current.revision) !== JSON.stringify(acceptedRevision)
      || current.revision.revisionNumber === acceptedRevision.revisionNumber + 1 && Object.hasOwn(current.revision, 'previousRevisionId')
        && current.revision.previousRevisionId !== acceptedRevision.id
      || current.revision.id === acceptedRevision.id && JSON.stringify(current.revision) !== JSON.stringify(acceptedRevision)) fail();
  const hasAcceptedAccess = Object.hasOwn(result, 'acceptedSourceAccess');
  if (correction && !hasAcceptedAccess) fail();
  return { ...common, requestId: result.requestId, requestSha256, replayed: result.replayed, acceptedRevision, attachment: current,
    ...(hasAcceptedAccess ? { acceptedSourceAccess: sourceAccess(result.acceptedSourceAccess) } : {}) };
}

export async function validateAttachmentCorrectionAcceptance(result, scope, attachmentId, input) {
  if (typeof attachmentId !== 'string' || !ANALYSIS_ATTACHMENT_ID.test(attachmentId)) fail();
  let request, canonical;
  try { request = normalizeAnalysisAttachmentCorrection(input); canonical = canonicalAnalysisAttachmentCorrection(attachmentId, request); }
  catch { fail(); }
  return validateAcceptance(result, scope, request, canonical, attachmentId);
}

function revisionEnvelope(result, scope, attachmentId) {
  const common = envelope(result, scope);
  if (typeof attachmentId !== 'string' || !ANALYSIS_ATTACHMENT_ID.test(attachmentId) || result.attachmentId !== attachmentId
      || typeof result.headRevisionId !== 'string' || !ANALYSIS_ATTACHMENT_REVISION_ID.test(result.headRevisionId)) fail();
  return { ...common, attachmentId, headRevisionId: result.headRevisionId };
}
function historicalRevision(value, attachmentId) {
  record(value);
  return { revision: revision(value.revision, attachmentId, true), sourceAccess: sourceAccess(value.sourceAccess) };
}

export function validateAttachmentHistory(result, scope, attachmentId) {
  const common = revisionEnvelope(result, scope, attachmentId);
  page(result.revisions, (_item, index) => index);
  const revisions = result.revisions.map(value => historicalRevision(value, attachmentId));
  page(revisions, value => value.revision.id);
  for (let index = 0; index < revisions.length; index++) {
    const current = revisions[index].revision, previous = revisions[index - 1]?.revision;
    if (current.previousRevisionId === common.headRevisionId || index > 0 && current.id === common.headRevisionId
        || previous && (previous.revisionNumber !== current.revisionNumber + 1 || previous.previousRevisionId !== current.id)) fail();
  }
  const nextCursor = cursor(result.nextCursor);
  const lastNumber = revisions.at(-1)?.revision.revisionNumber;
  if (!revisions.length && nextCursor !== null || lastNumber === 1 && nextCursor !== null || lastNumber > 1 && nextCursor === null) fail();
  return { ...common, revisions, nextCursor };
}

export function validateAttachmentRevision(result, scope, attachmentId, revisionId, expectedReference) {
  const common = revisionEnvelope(result, scope, attachmentId);
  if (typeof revisionId !== 'string' || !ANALYSIS_ATTACHMENT_REVISION_ID.test(revisionId)
      || Object.hasOwn(result, 'revisions') || Object.hasOwn(result, 'nextCursor')) fail();
  const value = historicalRevision(result, attachmentId);
  if (value.revision.id !== revisionId || value.revision.previousRevisionId === common.headRevisionId) fail();
  if (expectedReference !== undefined) {
    let reference;
    try { reference = normalizeAnalysisAttachmentCreate({ requestId: placeholderRequestId, reference: expectedReference, caption: 'Expected source' }).reference; }
    catch { fail(); }
    if (value.revision.reference.versionId !== reference.versionId || value.revision.reference.sha256 !== reference.sha256) fail();
  }
  return { ...common, ...value };
}
