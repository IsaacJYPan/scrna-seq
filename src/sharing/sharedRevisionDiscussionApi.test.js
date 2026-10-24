import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listSharedRevisionComments } from './sharedRevisionDiscussionApi';
import { withExecutionTarget } from '../runtime/executionTarget';

vi.mock('../api', () => ({ apiUrl: path => path }));
vi.mock('../runtime/executionTarget', () => ({ withExecutionTarget: vi.fn(action => action()) }));
const ids = [`proj_${'1'.repeat(24)}`, `ra_${'2'.repeat(24)}`, `raa_${'3'.repeat(24)}`, `rar_${'4'.repeat(24)}`];
const path = `/api/projects/${ids[0]}/analyses/${ids[1]}/attachments/${ids[2]}/revisions/${ids[3]}/comments`;
const response = (body = '{}', changes = {}) => new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8' }, ...changes });
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response())); });
afterEach(() => vi.unstubAllGlobals());

it('uses only exact authenticated GETs with a fixed30 page and the current execution-target fence', async () => {
  const signal = new AbortController().signal;
  await listSharedRevisionComments(...ids, { cursor: 'known_older-page', signal });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`${path}?limit=30&cursor=known_older-page`, expect.objectContaining({ method: 'GET', credentials: 'include', signal }));
  expect(fetch.mock.calls[0][1].body).toBeUndefined();
  expect(withExecutionTarget).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { mutation: false });
});

it('accepts a full legal30-comment Unicode page larger than the publication-list budget', async () => {
  const body = JSON.stringify({ comments: Array.from({ length: 30 }, () => ({ body: '🧬'.repeat(4000) })) });
  expect(new TextEncoder().encode(body).length).toBeGreaterThan(128 * 1024);
  expect(new TextEncoder().encode(body).length).toBeLessThan(1024 * 1024);
  fetch.mockResolvedValueOnce(response(body));
  const result = await listSharedRevisionComments(...ids);
  expect(result.comments).toHaveLength(30); expect(result.comments[0].body).toBe('🧬'.repeat(4000));
});

it('rejects an oversized declared response before reading or parsing its body', async () => {
  const cancel = vi.fn(), arrayBuffer = vi.fn(), json = vi.fn();
  fetch.mockResolvedValueOnce({ ok: true, headers: new Headers({ 'Content-Type': 'application/json', 'Content-Length': String(1024 * 1024 + 1) }),
    body: { cancel }, arrayBuffer, json });
  await expect(listSharedRevisionComments(...ids)).rejects.toMatchObject({ code: 'INVALID_SHARED_DISCUSSION_RESPONSE' });
  expect(cancel).toHaveBeenCalledOnce(); expect(arrayBuffer).not.toHaveBeenCalled(); expect(json).not.toHaveBeenCalled();
});

it('cancels a growing streamed response at1MiB before JSON parsing, even without Content-Length', async () => {
  const cancel = vi.fn(), releaseLock = vi.fn(), read = vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(256 * 1024) });
  const json = vi.fn(); fetch.mockResolvedValueOnce({ ok: true, headers: new Headers({ 'Content-Type': 'application/json' }),
    body: { getReader: () => ({ read, cancel, releaseLock }) }, json });
  await expect(listSharedRevisionComments(...ids)).rejects.toMatchObject({ code: 'INVALID_SHARED_DISCUSSION_RESPONSE' });
  expect(read).toHaveBeenCalledTimes(5); expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce(); expect(json).not.toHaveBeenCalled();
});

it.each(['text/html', 'image/svg+xml'])('rejects %s instead of interpreting untrusted discussion markup', async type => {
  fetch.mockResolvedValueOnce(new Response('<script>private</script>', { headers: { 'Content-Type': type } }));
  await expect(listSharedRevisionComments(...ids)).rejects.toMatchObject({ code: 'INVALID_SHARED_DISCUSSION_RESPONSE' });
});

it.each([{}, [], 500, null])('drops malformed server error code %j while preserving the safe HTTP status', async code => {
  fetch.mockResolvedValueOnce(response(JSON.stringify({ code, error: 'credentials@server/private' }), { status: 500 }));
  const error = await listSharedRevisionComments(...ids).catch(value => value);
  expect(error.status).toBe(500); expect(error.code).toBeUndefined(); expect(error.message).not.toContain('credentials');
});

it.each([401, 403, 404])('preserves HTTP%i and recognized source-free error codes for the caller authority check', async status => {
  fetch.mockResolvedValueOnce(response(JSON.stringify({ code: 'ANALYSIS_ATTACHMENT_NOT_FOUND' }), { status }));
  await expect(listSharedRevisionComments(...ids)).rejects.toMatchObject({ status, code: 'ANALYSIS_ATTACHMENT_NOT_FOUND' });
});

it.each([
  [0, '../project'], [1, 'current-head'], [2, []], [3, 'rar_current'],
])('rejects an invalid exact identifier at index%i before any fetch', async (index, value) => {
  const input = [...ids]; input[index] = value;
  await expect(listSharedRevisionComments(...input)).rejects.toMatchObject({ code: 'INVALID_SHARED_DISCUSSION_REQUEST' });
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['', 'a'.repeat(257), '../path', [], 30])('rejects malformed cursor %j without letting it change the route/page bound', async cursor => {
  await expect(listSharedRevisionComments(...ids, { cursor })).rejects.toMatchObject({ code: 'INVALID_SHARED_DISCUSSION_REQUEST' });
  expect(fetch).not.toHaveBeenCalled();
});

it('propagates caller abort without a retry or a mutation', async () => {
  const error = new DOMException('Canceled', 'AbortError'); fetch.mockRejectedValueOnce(error);
  await expect(listSharedRevisionComments(...ids)).rejects.toBe(error); expect(fetch).toHaveBeenCalledOnce();
});
