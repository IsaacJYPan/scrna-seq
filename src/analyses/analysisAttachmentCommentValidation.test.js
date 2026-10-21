import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalAnalysisAttachmentComment, normalizeAnalysisAttachmentComment } from '../../shared/analysisAttachmentComment.mjs';
import { validateAttachmentCommentAcceptance, validateAttachmentCommentList } from './analysisAttachmentCommentValidation';

const scope = { projectId: `proj_${'1'.repeat(24)}`, analysisId: `ra_${'2'.repeat(24)}`, userId: 1 };
const attachmentId = `raa_${'3'.repeat(24)}`, revisionId = `rar_${'4'.repeat(24)}`, newerRevisionId = `rar_${'5'.repeat(24)}`;
const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const input = { requestId, body: 'Could you explain the treated sample?' };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const common = { projectId: scope.projectId, analysisId: scope.analysisId, attachmentId, revisionId,
  headRevisionId: newerRevisionId, canComment: true };
const comment = changes => ({ id: `rac_${'6'.repeat(24)}`, attachmentId, revisionId, body: input.body,
  authorUserId: 1, authorDisplayName: 'Research colleague', createdAt: '2026-10-20T12:00:00.000Z', ...changes });
const list = () => ({ ...common, comments: [comment()], nextCursor: null });
const acceptance = () => ({ ...common, requestId, requestSha256: sha256(canonicalAnalysisAttachmentComment(attachmentId, revisionId, input)),
  replayed: false, comment: comment() });
const invalid = { code: 'INVALID_ANALYSIS_ATTACHMENT_COMMENT_RESPONSE' };

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

it('accepts revision-bound plain comments under independent current commenting authority and returns a separate safe copy', () => {
  const result = list(); result.canComment = false;
  const value = validateAttachmentCommentList(result, scope, attachmentId, revisionId);
  expect(value).toEqual(result); expect(value).not.toBe(result); expect(value.comments).not.toBe(result.comments);
  expect(value.comments[0]).not.toBe(result.comments[0]);
  expect(value.headRevisionId).toBe(newerRevisionId); expect(value.revisionId).toBe(revisionId); expect(value.canComment).toBe(false);
  expect(value).not.toHaveProperty('canWrite');
});

it('accepts a bounded newest-first page with stable descending IDs for equal timestamps', () => {
  const result = list(); result.nextCursor = 'eyJwYWdlIjoxfQ';
  result.comments = [comment({ id: `rac_${'f'.repeat(24)}`, createdAt: '2026-10-20T12:00:01.000Z' }),
    comment({ id: `rac_${'9'.repeat(24)}` }), comment({ id: `rac_${'8'.repeat(24)}` })];
  expect(validateAttachmentCommentList(result, scope, attachmentId, revisionId)).toEqual(result);
});

it('accepts an empty final page, a full 30-comment page and exact Unicode body/name limits', () => {
  const empty = list(); empty.comments = [];
  expect(validateAttachmentCommentList(empty, scope, attachmentId, revisionId).comments).toEqual([]);
  const result = list(); result.comments = Array.from({ length: 30 }, (_, index) => comment({
    id: `rac_${(30 - index).toString(16).padStart(24, '0')}`, body: '🧪'.repeat(4000), authorDisplayName: '🧬'.repeat(160) }));
  expect(validateAttachmentCommentList(result, scope, attachmentId, revisionId).comments).toHaveLength(30);
});

it.each([
  ['wrong project', value => { value.projectId = 'another-project'; }],
  ['wrong analysis', value => { value.analysisId = `ra_${'9'.repeat(24)}`; }],
  ['wrong attachment', value => { value.attachmentId = `raa_${'9'.repeat(24)}`; }],
  ['wrong target revision', value => { value.revisionId = newerRevisionId; }],
  ['missing current head', value => { delete value.headRevisionId; }],
  ['coerced current head', value => { value.headRevisionId = [newerRevisionId]; }],
  ['mutable current head', value => { value.headRevisionId = 'latest'; }],
  ['missing comment authority', value => { delete value.canComment; }],
  ['coerced comment authority', value => { value.canComment = 'true'; }],
  ['write authority substituting for comment authority', value => { value.canWrite = true; }],
  ['unknown server source field', value => { value.privateStorageKey = '/private/source'; }],
  ['missing cursor', value => { delete value.nextCursor; }],
  ['empty cursor', value => { value.nextCursor = ''; }],
  ['oversized cursor', value => { value.nextCursor = 'a'.repeat(257); }],
  ['path-like cursor', value => { value.nextCursor = '/private/path'; }],
  ['empty continuing page', value => { value.comments = []; value.nextCursor = 'next'; }],
  ['duplicate comment identity', value => { value.comments.push(structuredClone(value.comments[0])); }],
  ['oversized page', value => { value.comments = Array(31).fill(value.comments[0]); }],
  ['oldest-first comments', value => { value.comments.push(comment({ id: `rac_${'7'.repeat(24)}`, createdAt: '2026-10-20T12:00:01.000Z' })); }],
  ['wrong tie order', value => { value.comments.push(comment({ id: `rac_${'7'.repeat(24)}` })); }],
  ['wrong stable ID', value => { value.comments[0].id = `rar_${'6'.repeat(24)}`; }],
  ['coerced stable ID', value => { value.comments[0].id = [value.comments[0].id]; }],
  ['comment for another attachment', value => { value.comments[0].attachmentId = `raa_${'9'.repeat(24)}`; }],
  ['comment for current instead of requested revision', value => { value.comments[0].revisionId = newerRevisionId; }],
  ['unknown comment field', value => { value.comments[0].sourceAccess = 'available'; }],
  ['empty body', value => { value.comments[0].body = ''; }],
  ['unnormalized body', value => { value.comments[0].body = '  Comment  '; }],
  ['unnormalized line endings', value => { value.comments[0].body = 'First\r\nSecond'; }],
  ['oversized body', value => { value.comments[0].body = 'α'.repeat(4001); }],
  ['body control', value => { value.comments[0].body = 'First\u0000Second'; }],
  ['directional body control', value => { value.comments[0].body = 'First\u202eSecond'; }],
  ['malformed body Unicode', value => { value.comments[0].body = '\ud800'; }],
  ['coerced author ID', value => { value.comments[0].authorUserId = '1'; }],
  ['invalid author ID', value => { value.comments[0].authorUserId = 0; }],
  ['unsafe author ID', value => { value.comments[0].authorUserId = Number.MAX_SAFE_INTEGER + 1; }],
  ['missing captured display name', value => { delete value.comments[0].authorDisplayName; }],
  ['empty captured display name', value => { value.comments[0].authorDisplayName = ''; }],
  ['unnormalized captured display name', value => { value.comments[0].authorDisplayName = '  Colleague  '; }],
  ['oversized captured display name', value => { value.comments[0].authorDisplayName = 'α'.repeat(161); }],
  ['control in captured display name', value => { value.comments[0].authorDisplayName = 'Colleague\nName'; }],
  ['directional captured display name', value => { value.comments[0].authorDisplayName = 'Colleague\u202e'; }],
  ['format control in captured display name', value => { value.comments[0].authorDisplayName = 'Colleague\ufeff'; }],
  ['malformed name Unicode', value => { value.comments[0].authorDisplayName = '\ud800'; }],
  ['invalid time', value => { value.comments[0].createdAt = 'today'; }],
  ['impossible calendar date', value => { value.comments[0].createdAt = '2026-02-30T12:00:00.000Z'; }],
  ['invalid clock time', value => { value.comments[0].createdAt = '2026-10-20T24:00:00.000Z'; }],
])('rejects a comment list with %s', (_label, mutate) => {
  const result = list(); mutate(result);
  expect(() => validateAttachmentCommentList(result, scope, attachmentId, revisionId)).toThrow(expect.objectContaining(invalid));
});

it.each([
  ['invalid analysis', { ...scope, analysisId: 'latest' }],
  ['invalid project', { ...scope, projectId: 'project\nsecret' }],
  ['invalid actor', { ...scope, userId: 0 }],
  ['coerced actor', { ...scope, userId: [1] }],
  ['ambiguous actor string', { ...scope, userId: '01' }],
])('rejects invalid caller scope: %s', (_label, caller) => {
  expect(() => validateAttachmentCommentList(list(), caller, attachmentId, revisionId)).toThrow(expect.objectContaining(invalid));
});

it('rejects non-JSON objects, accessors, hidden/symbol fields and sparse/accessor comment arrays without evaluating getters', () => {
  const getter = vi.fn(() => true);
  const bad = [Object.create(list()), Object.defineProperty(list(), 'canComment', { enumerable: true, get: getter }),
    Object.defineProperty(list(), 'secret', { value: 1 }), Object.assign(list(), { [Symbol('secret')]: true })];
  const sparse = list(); sparse.comments = Array(1); bad.push(sparse);
  const accessor = list(); Object.defineProperty(accessor.comments, 0, { enumerable: true, get: getter }); bad.push(accessor);
  const decorated = list(); decorated.comments.extra = true; bad.push(decorated);
  const decoratedSymbol = list(); decoratedSymbol.comments[Symbol('extra')] = true; bad.push(decoratedSymbol);
  const nested = list(); Object.defineProperty(nested.comments[0], 'body', { enumerable: true, get: getter }); bad.push(nested);
  for (const result of bad) expect(() => validateAttachmentCommentList(result, scope, attachmentId, revisionId)).toThrow(expect.objectContaining(invalid));
  expect(getter).not.toHaveBeenCalled();
});

it('accepts plain null-prototype JSON records and preserves tabs, newlines and plain markup as text', () => {
  const result = Object.assign(Object.create(null), list());
  result.comments[0] = Object.assign(Object.create(null), comment({ body: '<strong>Supplied note</strong>\n\tSecond line 👩‍🔬' }));
  expect(validateAttachmentCommentList(result, scope, attachmentId, revisionId).comments[0].body).toBe('<strong>Supplied note</strong>\n\tSecond line 👩‍🔬');
});

it('binds a normalized acceptance to its original revision, body, UUID, author and correction-independent action hash', async () => {
  const draft = { requestId: requestId.toUpperCase(), body: '  First line\r\n\tSecond line  ' };
  const normalized = normalizeAnalysisAttachmentComment(draft), result = acceptance();
  result.canComment = false; result.replayed = true; result.comment.body = normalized.body;
  result.requestSha256 = sha256(canonicalAnalysisAttachmentComment(attachmentId, revisionId, normalized));
  const value = await validateAttachmentCommentAcceptance(result, { ...scope, userId: '1' }, attachmentId, revisionId, draft);
  expect(value).toEqual(result); expect(value.comment).not.toBe(result.comment);
  expect(value.headRevisionId).toBe(newerRevisionId); expect(value.comment.revisionId).toBe(revisionId);
  expect(value.canComment).toBe(false);
  expect(canonicalAnalysisAttachmentComment(attachmentId, revisionId, normalized)).toBe(JSON.stringify({ action: 'comment', attachmentId, revisionId, body: normalized.body }));
});

it.each([
  ['wrong project', value => { value.projectId = 'another-project'; }],
  ['wrong analysis', value => { value.analysisId = `ra_${'9'.repeat(24)}`; }],
  ['wrong attachment', value => { value.attachmentId = `raa_${'9'.repeat(24)}`; }],
  ['wrong revision', value => { value.revisionId = newerRevisionId; }],
  ['invalid current head', value => { value.headRevisionId = 'latest'; }],
  ['wrong request UUID', value => { value.requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; }],
  ['unnormalized response UUID', value => { value.requestId = requestId.toUpperCase(); }],
  ['wrong content hash', value => { value.requestSha256 = '0'.repeat(64); }],
  ['coerced content hash', value => { value.requestSha256 = [value.requestSha256]; }],
  ['uppercase hash', value => { value.requestSha256 = value.requestSha256.toUpperCase(); }],
  ['missing replay status', value => { delete value.replayed; }],
  ['coerced replay status', value => { value.replayed = 1; }],
  ['wrong actor', value => { value.comment.authorUserId = 2; }],
  ['changed comment text', value => { value.comment.body = 'A different question'; }],
  ['unrelated comment target', value => { value.comment.revisionId = newerRevisionId; }],
  ['unknown receipt authority', value => { value.canWrite = true; }],
  ['unknown receipt source', value => { value.sourceAccess = 'available'; }],
  ['unknown accepted comment field', value => { value.comment.path = '/private/source'; }],
  ['malformed accepted name', value => { value.comment.authorDisplayName = 'Colleague\u0000'; }],
])('keeps a comment unconfirmed for acceptance with %s', async (_label, mutate) => {
  const result = acceptance(); mutate(result);
  await expect(validateAttachmentCommentAcceptance(result, scope, attachmentId, revisionId, input)).rejects.toMatchObject(invalid);
});

it('rejects a digest computed for a different action, attachment, revision or body even when the receipt UUID matches', async () => {
  for (const content of [JSON.stringify({ action: 'correct', attachmentId, revisionId, body: input.body }),
    canonicalAnalysisAttachmentComment(`raa_${'9'.repeat(24)}`, revisionId, input),
    canonicalAnalysisAttachmentComment(attachmentId, newerRevisionId, input),
    canonicalAnalysisAttachmentComment(attachmentId, revisionId, { body: 'Another body' })]) {
    const result = acceptance(); result.requestSha256 = sha256(content);
    await expect(validateAttachmentCommentAcceptance(result, scope, attachmentId, revisionId, input)).rejects.toMatchObject(invalid);
  }
});

it.each([
  ['invalid request UUID', { ...input, requestId: 'request-1' }],
  ['empty body', { ...input, body: '  ' }],
  ['oversized body', { ...input, body: 'x'.repeat(4001) }],
  ['hidden control', { ...input, body: 'Question\u0000' }],
  ['unknown input source', { ...input, sourceAccess: 'available' }],
  ['changed original body', { ...input, body: 'Changed after the original request' }],
])('rejects invalid or changed frozen comment input: %s', async (_label, draft) => {
  await expect(validateAttachmentCommentAcceptance(acceptance(), scope, attachmentId, revisionId, draft)).rejects.toMatchObject(invalid);
});

it('requires a working SHA-256 implementation and keeps digest failure unconfirmed', async () => {
  vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockRejectedValue(new Error('Unavailable')) } });
  await expect(validateAttachmentCommentAcceptance(acceptance(), scope, attachmentId, revisionId, input)).rejects.toMatchObject(invalid);
});
