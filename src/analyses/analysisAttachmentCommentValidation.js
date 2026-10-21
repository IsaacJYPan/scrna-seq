import { ANALYSIS_ATTACHMENT_ID, ANALYSIS_ATTACHMENT_REVISION_ID } from '../../shared/analysisAttachment.mjs';
import { ANALYSIS_ATTACHMENT_COMMENT_ID, ANALYSIS_ATTACHMENT_COMMENT_LIMITS, canonicalAnalysisAttachmentComment,
  normalizeAnalysisAttachmentComment } from '../../shared/analysisAttachmentComment.mjs';

const analysisId = /^ra_[a-f0-9]{24}$/;
const checksum = /^[a-f0-9]{64}$/;
const placeholderRequestId = '00000000-0000-4000-8000-000000000000';
const scopeFields = ['projectId', 'analysisId', 'userId'];
const commonFields = ['projectId', 'analysisId', 'attachmentId', 'revisionId', 'headRevisionId', 'canComment'];
const commentFields = ['id', 'attachmentId', 'revisionId', 'body', 'authorUserId', 'authorDisplayName', 'createdAt'];
const fail = () => { throw Object.assign(new Error('The discussion response could not be confirmed. Keep the original comment request and check again.'), { code: 'INVALID_ANALYSIS_ATTACHMENT_COMMENT_RESPONSE' }); };
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.length || keys.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key !== 'string' || !allowed.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
  })) fail();
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

function envelope(result, scope, attachmentId, revisionId, extraFields) {
  fields(scope, scopeFields); fields(result, [...commonFields, ...extraFields]);
  if (typeof scope.projectId !== 'string' || !scope.projectId || scope.projectId.length > 128 || /\p{Cc}/u.test(scope.projectId)
      || typeof scope.analysisId !== 'string' || !analysisId.test(scope.analysisId)
      || !['number', 'string'].includes(typeof scope.userId) || typeof scope.userId === 'string' && !/^[1-9]\d*$/.test(scope.userId)
      || !positiveInteger(Number(scope.userId)) || result.projectId !== scope.projectId || result.analysisId !== scope.analysisId
      || typeof attachmentId !== 'string' || !ANALYSIS_ATTACHMENT_ID.test(attachmentId) || result.attachmentId !== attachmentId
      || typeof revisionId !== 'string' || !ANALYSIS_ATTACHMENT_REVISION_ID.test(revisionId) || result.revisionId !== revisionId
      || typeof result.headRevisionId !== 'string' || !ANALYSIS_ATTACHMENT_REVISION_ID.test(result.headRevisionId)
      || typeof result.canComment !== 'boolean') fail();
  return { projectId: result.projectId, analysisId: result.analysisId, attachmentId, revisionId,
    headRevisionId: result.headRevisionId, canComment: result.canComment };
}

function comment(value, attachmentId, revisionId) {
  fields(value, commentFields);
  let normalized;
  try { normalized = normalizeAnalysisAttachmentComment({ requestId: placeholderRequestId, body: value.body }); }
  catch { fail(); }
  if (typeof value.id !== 'string' || !ANALYSIS_ATTACHMENT_COMMENT_ID.test(value.id)
      || value.attachmentId !== attachmentId || value.revisionId !== revisionId || value.body !== normalized.body
      || !positiveInteger(value.authorUserId) || typeof value.authorDisplayName !== 'string'
      || !value.authorDisplayName || value.authorDisplayName !== value.authorDisplayName.trim()
      || [...value.authorDisplayName].length > ANALYSIS_ATTACHMENT_COMMENT_LIMITS.authorDisplayName
      || !value.authorDisplayName.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value.authorDisplayName)) fail();
  return { id: value.id, attachmentId, revisionId, body: normalized.body, authorUserId: value.authorUserId,
    authorDisplayName: value.authorDisplayName, createdAt: timestamp(value.createdAt) };
}

function page(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > ANALYSIS_ATTACHMENT_COMMENT_LIMITS.page
      || Reflect.ownKeys(value).length !== value.length + 1
      || Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, index))
        .some(descriptor => !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) fail();
  return value;
}

function cursor(value) {
  if (value !== null && (typeof value !== 'string' || !value || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value))) fail();
  return value;
}

export function validateAttachmentCommentList(result, scope, attachmentId, revisionId) {
  const common = envelope(result, scope, attachmentId, revisionId, ['comments', 'nextCursor']);
  const comments = page(result.comments).map(value => comment(value, attachmentId, revisionId));
  if (new Set(comments.map(value => value.id)).size !== comments.length) fail();
  for (let index = 1; index < comments.length; index++) {
    const previous = comments[index - 1], current = comments[index];
    const previousTime = Date.parse(previous.createdAt), currentTime = Date.parse(current.createdAt);
    if (previousTime < currentTime || previousTime === currentTime && previous.id < current.id) fail();
  }
  const nextCursor = cursor(result.nextCursor);
  if (!comments.length && nextCursor !== null) fail();
  return { ...common, comments, nextCursor };
}

export async function validateAttachmentCommentAcceptance(result, scope, attachmentId, revisionId, input) {
  const common = envelope(result, scope, attachmentId, revisionId, ['requestId', 'requestSha256', 'replayed', 'comment']);
  let request, canonical;
  try { request = normalizeAnalysisAttachmentComment(input); canonical = canonicalAnalysisAttachmentComment(attachmentId, revisionId, request); }
  catch { fail(); }
  const saved = comment(result.comment, attachmentId, revisionId);
  const { requestId, requestSha256, replayed } = result;
  if (requestId !== request.requestId || typeof requestSha256 !== 'string' || !checksum.test(requestSha256)
      || typeof replayed !== 'boolean' || saved.authorUserId !== Number(scope.userId) || saved.body !== request.body) fail();
  let expectedSha256;
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    expectedSha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  } catch { fail(); }
  if (requestSha256 !== expectedSha256) fail();
  return { ...common, requestId, requestSha256, replayed, comment: saved };
}
