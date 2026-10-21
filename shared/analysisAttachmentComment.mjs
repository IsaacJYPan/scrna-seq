export const ANALYSIS_ATTACHMENT_COMMENT_SCHEMA = 'traceomics.analysis-attachment-comment.v1';
export const ANALYSIS_ATTACHMENT_COMMENT_ID = /^rac_[a-f0-9]{24}$/;
export const ANALYSIS_ATTACHMENT_COMMENT_LIMITS = Object.freeze({ body: 4000, authorDisplayName: 160, page: 30, revision: 200, analysis: 2000 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function invalid(message) {
  throw Object.assign(new Error(message), { code: 'INVALID_ANALYSIS_ATTACHMENT_COMMENT', status: 400 });
}
function fields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid('Use plain comment fields.');
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !['requestId', 'body'].includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      invalid('Use only the comment text and original request UUID. The contributor, time and evidence target are set by the server.');
    }
  }
}
export function normalizeAnalysisAttachmentComment(input) {
  fields(input);
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) invalid('Keep a request UUID to add or recover this exact comment.');
  if (typeof input.body !== 'string') invalid('A comment must contain plain text.');
  const body = input.body.replace(/\r\n?/g, '\n').trim();
  if (!body || [...body].length > ANALYSIS_ATTACHMENT_COMMENT_LIMITS.body || !body.isWellFormed()
      || /\p{Cc}/u.test(body.replace(/[\t\n]/g, '')) || /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(body)) {
    invalid('A comment must contain 1–4000 characters without hidden controls.');
  }
  return { requestId: input.requestId.toLowerCase(), body };
}
export function canonicalAnalysisAttachmentComment(attachmentId, revisionId, input) {
  if (typeof attachmentId !== 'string' || !/^raa_[a-f0-9]{24}$/.test(attachmentId)
      || typeof revisionId !== 'string' || !/^rar_[a-f0-9]{24}$/.test(revisionId)) invalid('Keep the exact attachment and revision for this discussion.');
  fields(input);
  const { body } = normalizeAnalysisAttachmentComment({ ...input, requestId: '00000000-0000-4000-8000-000000000000' });
  return JSON.stringify({ action: 'comment', attachmentId, revisionId, body });
}
