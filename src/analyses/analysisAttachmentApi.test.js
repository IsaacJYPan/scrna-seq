import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAnalysisAttachment, getAnalysisAttachmentRequest, listAnalysisAttachments, listAnalysisAttachmentOptions } from './analysisAttachmentApi';
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
