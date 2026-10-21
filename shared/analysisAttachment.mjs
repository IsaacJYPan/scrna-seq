export const ANALYSIS_ATTACHMENT_SCHEMA = 'traceomics.analysis-attachment.v1';
export const ANALYSIS_ATTACHMENT_ID = /^raa_[a-f0-9]{24}$/;
export const ANALYSIS_ATTACHMENT_REVISION_ID = /^rar_[a-f0-9]{24}$/;
export const ANALYSIS_ATTACHMENT_LIMITS = Object.freeze({ caption: 2000, origin: 2000, attachments: 200, page: 30, revisions: 200, analysisRevisions: 2000 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const originFields = ['origin', 'sourceReference', 'documentReference', 'environmentReference'];
function invalid(message) {
  throw Object.assign(new Error(message), { code: 'INVALID_ANALYSIS_ATTACHMENT', status: 400 });
}
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Use only plain attachment fields.');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      invalid('Use only the documented attachment fields. Source bytes, paths and ownership are not attachment fields.');
    }
  }
}
function text(value, label, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string') invalid(`${label} must be plain text.`);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!normalized && nullable) return null;
  if (!normalized || [...normalized].length > 2000 || !normalized.isWellFormed()
      || /\p{Cc}/u.test(normalized.replace(/[\t\n]/g, ''))) invalid(`${label} must contain 1–2000 characters without hidden controls.`);
  return normalized;
}
export function normalizeAnalysisAttachmentCreate(input) {
  fields(input, ['requestId', 'reference', 'caption', 'suppliedOrigin']);
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) invalid('Keep a request UUID to create or recover this attachment.');
  fields(input.reference, ['kind', 'versionId', 'sha256']);
  if (input.reference.kind !== 'artifact-version' || typeof input.reference.versionId !== 'string'
      || !/^av_[a-f0-9]{24}$/.test(input.reference.versionId) || typeof input.reference.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(input.reference.sha256)) invalid('Select an exact managed artifact version and its SHA-256 checksum.');
  const supplied = input.suppliedOrigin === undefined ? {} : input.suppliedOrigin;
  fields(supplied, originFields);
  return { requestId: input.requestId.toLowerCase(),
    reference: { kind: 'artifact-version', versionId: input.reference.versionId, sha256: input.reference.sha256 },
    caption: text(input.caption, 'Caption'),
    suppliedOrigin: Object.fromEntries(originFields.map(key => [key, text(supplied[key], 'Supplied origin note', true)])) };
}
export function canonicalAnalysisAttachmentContent(input) {
  fields(input, ['requestId', 'reference', 'caption', 'suppliedOrigin']);
  // The request identity is outside the content digest. Accept content alone so
  // clients can compare an immutable revision without fabricating an identity.
  const { reference, caption, suppliedOrigin } = normalizeAnalysisAttachmentCreate({ ...input, requestId: '00000000-0000-4000-8000-000000000000' });
  return JSON.stringify({ reference, caption, suppliedOrigin });
}
export function normalizeAnalysisAttachmentCorrection(input) {
  fields(input, ['requestId', 'expectedHeadRevisionId', 'reference', 'caption', 'suppliedOrigin']);
  if (typeof input.expectedHeadRevisionId !== 'string' || !ANALYSIS_ATTACHMENT_REVISION_ID.test(input.expectedHeadRevisionId)) {
    invalid('Keep the exact current attachment revision before saving a correction.');
  }
  const { requestId, reference, caption, suppliedOrigin } = normalizeAnalysisAttachmentCreate({ requestId: input.requestId,
    reference: input.reference, caption: input.caption, suppliedOrigin: input.suppliedOrigin });
  return { requestId, expectedHeadRevisionId: input.expectedHeadRevisionId, reference, caption, suppliedOrigin };
}
export function canonicalAnalysisAttachmentCorrection(attachmentId, input) {
  if (typeof attachmentId !== 'string' || !ANALYSIS_ATTACHMENT_ID.test(attachmentId)) invalid('Keep the original attachment identity for this correction.');
  fields(input, ['requestId', 'expectedHeadRevisionId', 'reference', 'caption', 'suppliedOrigin']);
  const { expectedHeadRevisionId, reference, caption, suppliedOrigin } = normalizeAnalysisAttachmentCorrection({ ...input, requestId: '00000000-0000-4000-8000-000000000000' });
  return JSON.stringify({ action: 'correct', attachmentId, expectedHeadRevisionId, reference, caption, suppliedOrigin });
}
