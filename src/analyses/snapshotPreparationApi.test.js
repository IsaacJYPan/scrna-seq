import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { createSnapshotPreparation, deleteSnapshotPreparation, getSnapshotPreparationRequest,
  listSnapshotPreparations, listSnapshotPreparationOptions, readSnapshotPreparationDocument, readSnapshotPreparationView,
  resumeSnapshotPreparation } from './snapshotPreparationApi';
import { withExecutionTarget } from '../runtime/executionTarget';

vi.mock('../api', () => ({ apiUrl: value => value }));
vi.mock('../runtime/executionTarget', () => ({ withExecutionTarget: vi.fn(fn => fn()) }));
const base = '/api/projects/project%201/analyses/analysis%201/snapshot-preparations';
const bytes = new TextEncoder().encode('{"family":"table","rows":[["selected"]]}');
const digest = value => createHash('sha256').update(value).digest('hex');
const descriptor = { viewId: 'asv_a', source: { format: { id: 'org.ietf.csv', version: '1' } },
  view: { family: 'table', blobBytes: bytes.byteLength, blobSha256: digest(bytes) } };
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn()); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => vi.unstubAllGlobals());

it('keeps discovery and original recovery read-only, with bounded encoded selectors and no original-source query', async () => {
  fetch.mockImplementation(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  const signal = new AbortController().signal;
  await listSnapshotPreparations('project 1', 'analysis 1', { cursor: 'older/page', signal });
  await listSnapshotPreparationOptions('project 1', 'analysis 1', 'results', { signal });
  await getSnapshotPreparationRequest('project 1', 'analysis 1', 'original/request', { signal });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([base + '?limit=30&cursor=older%2Fpage', base + '/options?limit=30&kind=results', base + '/requests/original%2Frequest']);
  for (const [, options] of fetch.mock.calls) expect(options).toMatchObject({ method: 'GET', credentials: 'include', signal });
  for (const [, options] of withExecutionTarget.mock.calls) expect(options).toEqual({ mutation: false });
});

it('sends explicit prepare, exact resume and exact deletion through the mutation boundary without automatic retry', async () => {
  fetch.mockImplementation(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  const recipe = { requestId: 'original', notes: { summary: 'Unchanged\nnotes.' } }, original = { requestId: 'original', requestSha256: 'a'.repeat(64) };
  await createSnapshotPreparation('project 1', 'analysis 1', recipe);
  await resumeSnapshotPreparation('project 1', 'analysis 1', 'prep/1', original);
  await deleteSnapshotPreparation('project 1', 'analysis 1', 'prep/1', original);
  expect(fetch.mock.calls.map(([url, options]) => [url, options.method, options.body])).toEqual([
    [base, 'POST', JSON.stringify(recipe)], [base + '/prep%2F1/resume', 'POST', JSON.stringify(original)], [base + '/prep%2F1', 'DELETE', JSON.stringify(original)],
  ]);
  for (const [, options] of withExecutionTarget.mock.calls) expect(options).toEqual({ mutation: true });
});

it('binds linked choice discovery to an explicit saved analysis version without changing legacy queries', async () => {
  fetch.mockImplementation(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  await listSnapshotPreparationOptions('project 1', 'analysis 1', 'analysis-references', { analysisVersion: 19, cursor: 'saved/page' });
  expect(fetch.mock.calls[0][0]).toBe(base + '/options?limit=30&kind=analysis-references&cursor=saved%2Fpage&analysisVersion=19');
  expect(withExecutionTarget).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { mutation: false });
});

it('verifies exact retained bytes before returning them, without adding an offset or reopening private artifacts', async () => {
  fetch.mockResolvedValue(new Response(bytes, { headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
  const result = await readSnapshotPreparationView('project 1', 'analysis 1', 'asp_1', descriptor);
  expect(Array.from(result.bytes)).toEqual(Array.from(bytes)); expect(result.type).toBe('application/json');
  expect(fetch.mock.calls[0][0]).toBe(base + '/asp_1/views/asv_a');
  expect(withExecutionTarget).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { mutation: false });
});

it.each(['checksum', 'short', 'long', 'mime'])('rejects a retained body with %s mismatch before any caller can parse or render it', async kind => {
  const data = kind === 'short' ? bytes.slice(1) : kind === 'long' ? new Uint8Array(bytes.length + 1) : bytes;
  fetch.mockResolvedValue(new Response(data, { headers: { 'Content-Type': kind === 'mime' ? 'text/html' : 'application/json' } }));
  await expect(readSnapshotPreparationView('project 1', 'analysis 1', 'asp_1', kind === 'checksum' ? { ...descriptor, view: { ...descriptor.view, blobSha256: 'b'.repeat(64) } } : descriptor))
    .rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_PREPARATION_RESPONSE' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('refuses an oversized declared list before reading its body', async () => {
  const cancel = vi.fn(), getReader = vi.fn();
  fetch.mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'application/json', 'Content-Length': '131073' }), body: { cancel, getReader } });
  await expect(listSnapshotPreparations('project 1', 'analysis 1')).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_PREPARATION_RESPONSE' });
  expect(cancel).toHaveBeenCalledOnce(); expect(getReader).not.toHaveBeenCalled();
});

it('cancels a dishonest oversized stream and releases its reader without buffering later chunks', async () => {
  const reader = { read: vi.fn().mockResolvedValueOnce({ done: false, value: new Uint8Array(131073) }), cancel: vi.fn(), releaseLock: vi.fn() };
  fetch.mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), body: { getReader: () => reader } });
  await expect(listSnapshotPreparations('project 1', 'analysis 1')).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_PREPARATION_RESPONSE' });
  expect(reader.cancel).toHaveBeenCalledOnce(); expect(reader.releaseLock).toHaveBeenCalledOnce(); expect(reader.read).toHaveBeenCalledOnce();
});

it('preserves a scoped not-found code but never displays a private server exception path', async () => {
  fetch.mockResolvedValue(new Response(JSON.stringify({ code: 'SNAPSHOT_PREPARATION_NOT_FOUND', error: 'private/absolute/path' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
  const result = await getSnapshotPreparationRequest('project 1', 'analysis 1', 'original').catch(error => error);
  expect(result).toMatchObject({ status: 404, code: 'SNAPSHOT_PREPARATION_NOT_FOUND' }); expect(result.message).not.toContain('private/absolute/path');
  expect(fetch).toHaveBeenCalledOnce();
});

it('checks the exact supporting source bytes using its own retained view ID without loading a mutable document head', async () => {
  fetch.mockResolvedValue(new Response(bytes, { headers: { 'Content-Type': 'application/json' } }));
  await readSnapshotPreparationDocument('project 1', 'analysis 1', 'asp_1', { viewId: 'asv_source', blobBytes: bytes.byteLength, blobSha256: digest(bytes) });
  expect(fetch.mock.calls[0][0]).toBe(base + '/asp_1/documents/asv_source');
});

it('does not dispatch a body read with an unverified oversized document descriptor', async () => {
  await expect(readSnapshotPreparationDocument('project 1', 'analysis 1', 'asp_1', { viewId: 'asv_source', blobBytes: 1048577, blobSha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_PREPARATION_RESPONSE' });
  expect(fetch).not.toHaveBeenCalled(); expect(withExecutionTarget).not.toHaveBeenCalled();
});
