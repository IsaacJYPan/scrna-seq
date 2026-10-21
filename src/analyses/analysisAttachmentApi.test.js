import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAnalysisAttachment, correctAnalysisAttachment, getAnalysisAttachmentRequest, getAnalysisAttachmentRevision,
  listAnalysisAttachments, listAnalysisAttachmentOptions, listAnalysisAttachmentRevisions, listAnalysisAttachmentComments,
  createAnalysisAttachmentComment, getAnalysisAttachmentCommentRequest } from './analysisAttachmentApi';
import { withExecutionTarget } from '../runtime/executionTarget';

vi.mock('../api', () => ({ apiUrl: value => value }));
vi.mock('../runtime/executionTarget', () => ({ withExecutionTarget: vi.fn(action => action()) }));
const endpoint = '/api/projects/project%201/analyses/analysis%201/attachments';
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => vi.unstubAllGlobals());

it.each([
  [listAnalysisAttachments, '?limit=30&cursor=next_cursor'],
  [listAnalysisAttachmentOptions, '/options?limit=30&cursor=next_cursor'],
])('loads a bounded attachment page with current workspace fencing and authenticated cancellation', async (load, suffix) => {
  const response = { canWrite: false, nextCursor: null }; fetch.mockResolvedValue({ ok: true, json: async () => response });
  const signal = new AbortController().signal;
  await expect(load('project 1', 'analysis 1', { cursor: 'next_cursor', signal })).resolves.toBe(response);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(endpoint + suffix, expect.objectContaining({ method: 'GET', credentials: 'include', signal }));
  expect(fetch.mock.calls[0][1]).not.toHaveProperty('body');
  expect(withExecutionTarget).toHaveBeenCalledWith(expect.any(Function), { mutation: false });
});

it('creates from the exact normalized metadata body without file bytes or replacing analysis notes', async () => {
  const body = { requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', reference: { kind: 'artifact-version', versionId: `av_${'1'.repeat(24)}`, sha256: 'a'.repeat(64) },
    caption: 'Treatment response', suppliedOrigin: { origin: null, sourceReference: null, documentReference: null, environmentReference: null } };
  const signal = new AbortController().signal; const result = { requestId: body.requestId, replayed: false };
  fetch.mockResolvedValue({ ok: true, json: async () => result });
  await expect(createAnalysisAttachment('project 1', 'analysis 1', body, { signal })).resolves.toBe(result);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(endpoint, expect.objectContaining({ method: 'POST', credentials: 'include', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  expect(withExecutionTarget).toHaveBeenCalledWith(expect.any(Function), { mutation: true });
});

it('checks the original request with a source-free GET and never creates an attachment automatically', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ replayed: true, canWrite: false }) });
  const signal = new AbortController().signal;
  await getAnalysisAttachmentRequest('project 1', 'analysis 1', 'original/request', { signal });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(endpoint + '/requests/original%2Frequest', expect.objectContaining({ method: 'GET', credentials: 'include', signal }));
  expect(fetch.mock.calls[0][1]).not.toHaveProperty('body');
  expect(withExecutionTarget).toHaveBeenCalledWith(expect.any(Function), { mutation: false });
});

it.each([
  [404, 'ANALYSIS_ATTACHMENT_REQUEST_NOT_FOUND'],
  [409, 'ANALYSIS_ATTACHMENT_REQUEST_CONFLICT'],
  [403, 'FORBIDDEN'],
])('preserves status %i and %s so the UI can distinguish uncertainty from a denial', async (status, code) => {
  fetch.mockResolvedValue({ ok: false, status, json: async () => ({ code, error: 'The attachment request could not be confirmed.' }) });
  await expect(getAnalysisAttachmentRequest('project 1', 'analysis 1', 'request')).rejects.toMatchObject({ status, code });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('rejects unreadable success responses and preserves caller cancellation without retrying', async () => {
  fetch.mockResolvedValueOnce({ ok: true, json: async () => { throw new SyntaxError('Invalid response'); } });
  await expect(listAnalysisAttachments('project 1', 'analysis 1')).rejects.toThrow('The attachment service returned an unreadable response.');
  const failure = new DOMException('Aborted', 'AbortError'); fetch.mockRejectedValueOnce(failure);
  await expect(listAnalysisAttachmentOptions('project 1', 'analysis 1')).rejects.toBe(failure);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('posts a correction to its exact attachment with the frozen expected head and normalized content', async () => {
  const body = { requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expectedHeadRevisionId: `rar_${'1'.repeat(24)}`,
    reference: { kind: 'artifact-version', versionId: `av_${'2'.repeat(24)}`, sha256: 'a'.repeat(64) },
    caption: 'Corrected caption', suppliedOrigin: { origin: null, sourceReference: null, documentReference: null, environmentReference: null } };
  const signal = new AbortController().signal; const result = { requestId: body.requestId, replayed: false };
  fetch.mockResolvedValue({ ok: true, json: async () => result });
  await expect(correctAnalysisAttachment('project 1', 'analysis 1', 'attachment/1', body, { signal })).resolves.toBe(result);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(endpoint + '/attachment%2F1/revisions', expect.objectContaining({ method: 'POST', credentials: 'include', signal,
    body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));
  expect(withExecutionTarget).toHaveBeenCalledWith(expect.any(Function), { mutation: true });
});

it('reads bounded revision history and one exact revision through authenticated source-free GETs', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ canWrite: false }) });
  const signal = new AbortController().signal;
  await listAnalysisAttachmentRevisions('project 1', 'analysis 1', 'attachment/1', { cursor: 'older_page', signal });
  await getAnalysisAttachmentRevision('project 1', 'analysis 1', 'attachment/1', 'revision/2', { signal });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    endpoint + '/attachment%2F1/revisions?limit=30&cursor=older_page', endpoint + '/attachment%2F1/revisions/revision%2F2',
  ]);
  for (const [, options] of fetch.mock.calls) {
    expect(options).toMatchObject({ method: 'GET', credentials: 'include', signal }); expect(options).not.toHaveProperty('body');
  }
  expect(withExecutionTarget).toHaveBeenNthCalledWith(1, expect.any(Function), { mutation: false });
  expect(withExecutionTarget).toHaveBeenNthCalledWith(2, expect.any(Function), { mutation: false });
});

it('preserves a structured CAS rejection so edits can be rebased deliberately without automatically resubmitting', async () => {
  const attachment = { id: `raa_${'3'.repeat(24)}`, headRevisionId: `rar_${'4'.repeat(24)}` };
  const submittedExpectedHeadRevisionId = `rar_${'2'.repeat(24)}`;
  fetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ code: 'ANALYSIS_ATTACHMENT_HEAD_CONFLICT', error: 'A newer revision is saved.',
    attachment, submittedExpectedHeadRevisionId }) });
  await expect(correctAnalysisAttachment('project 1', 'analysis 1', attachment.id, { expectedHeadRevisionId: submittedExpectedHeadRevisionId }))
    .rejects.toMatchObject({ status: 409, code: 'ANALYSIS_ATTACHMENT_HEAD_CONFLICT', attachment, submittedExpectedHeadRevisionId });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('reads bounded exact-revision comments and source-free original comment receipts as authenticated non-mutations', async () => {
  const result = { canComment: true }; fetch.mockResolvedValue({ ok: true, json: async () => result });
  const signal = new AbortController().signal;
  await listAnalysisAttachmentComments('project 1', 'analysis 1', 'attachment/1', 'revision/2', { cursor: 'older_page', signal });
  await getAnalysisAttachmentCommentRequest('project 1', 'analysis 1', 'original/request', { signal });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    endpoint + '/attachment%2F1/revisions/revision%2F2/comments?limit=30&cursor=older_page',
    endpoint + '/comment-requests/original%2Frequest',
  ]);
  for (const [, options] of fetch.mock.calls) {
    expect(options).toMatchObject({ method: 'GET', credentials: 'include', signal }); expect(options).not.toHaveProperty('body');
  }
  expect(withExecutionTarget).toHaveBeenNthCalledWith(1, expect.any(Function), { mutation: false });
  expect(withExecutionTarget).toHaveBeenNthCalledWith(2, expect.any(Function), { mutation: false });
});

it('posts only the frozen comment body and UUID to its exact attachment revision without a head CAS or file bytes', async () => {
  const body = Object.freeze({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', body: 'Explain this result.\nA second line.' });
  fetch.mockResolvedValue({ ok: true, json: async () => ({ requestId: body.requestId }) });
  const signal = new AbortController().signal;
  await createAnalysisAttachmentComment('project 1', 'analysis 1', 'attachment/1', 'revision/2', body, { signal });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(endpoint + '/attachment%2F1/revisions/revision%2F2/comments', expect.objectContaining({
    method: 'POST', credentials: 'include', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  expect(withExecutionTarget).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { mutation: true });
});

it.each([[404, 'ANALYSIS_ATTACHMENT_COMMENT_REQUEST_NOT_FOUND'], [409, 'ANALYSIS_ATTACHMENT_COMMENT_REQUEST_CONFLICT'], [409, 'ANALYSIS_ARCHIVED']])(
  'preserves comment receipt status %i and %s without retrying or turning a lookup into a write', async (status, code) => {
    fetch.mockResolvedValue({ ok: false, status, json: async () => ({ code, error: 'The comment request could not be confirmed.' }) });
    await expect(getAnalysisAttachmentCommentRequest('project 1', 'analysis 1', 'original')).rejects.toMatchObject({ status, code });
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1].method).toBe('GET');
  });
