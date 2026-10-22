import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalServerDataImportRequest, normalizeServerDataImportRequest } from '../../shared/serverDataImport.mjs';
import { getServerDataImport, importServerData, listServerDataFiles, listServerDataImports, listServerDataRoots } from './serverDataApi';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => { vi.unstubAllGlobals(); delete window.desktopShell; });
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
const projectId = `proj_${'1'.repeat(24)}`, serviceId = `svc_${'2'.repeat(32)}`;
const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const validationScope = { userId: 7, serviceId };
const original = () => ({ requestId, rootId: 'lab-data', relativePath: 'study/analysis.rds', selectionToken: 'a'.repeat(64), name: 'Analysis', artifactType: 'auto' });
function receipt() {
  const request = normalizeServerDataImportRequest(original());
  return { projectId, ownerUserId: 7, serviceId, canImport: true, id: `sdi_${'3'.repeat(24)}`, requestId,
    requestSha256: createHash('sha256').update(canonicalServerDataImportRequest(request)).digest('hex'), request, name: request.name,
    status: 'pending', replayed: false, source: { rootId: request.rootId, relativePath: request.relativePath, name: 'analysis.rds', serviceId, serviceLabel: 'Research server' },
    reservedBytes: 3400, bytesCopied: 0, createdAt: '2026-10-20T12:00:00.000Z', updatedAt: '2026-10-20T12:00:00.000Z', expiresAt: '2026-10-20T12:15:00.000Z',
    acceptanceState: 'not-accepted', acceptance: null, availability: 'not-recorded', version: null, error: null, message: 'The server is creating the original snapshot.' };
}
function discovery() {
  const { request: _request, replayed: _replayed, version: _version, message: _message, projectId: _project, ownerUserId: _owner,
    serviceId: _service, canImport: _canImport, ...item } = receipt();
  return { projectId, ownerUserId: 7, serviceId, canImport: false, items: [item], nextCursor: null };
}

it('requests bounded server metadata on the selected service with encoded project, root and relative directory', async () => {
  const fetch = vi.fn().mockResolvedValue(response({ items: [], nextCursor: null })); vi.stubGlobal('fetch', fetch);
  await listServerDataRoots('project/a');
  await listServerDataFiles('project/a', 'root b', { path: 'study/sample 1', cursor: 'next', limit: 25 });
  expect(fetch).toHaveBeenNthCalledWith(1, '/api/server-data/project%2Fa/roots', expect.objectContaining({ credentials: 'include', headers: { 'X-Traceomics-Csrf': '1' } }));
  expect(fetch.mock.calls[1][0]).toBe('/api/server-data/project%2Fa/roots/root%20b/files?path=study%2Fsample+1&limit=25&cursor=next');
});

it('sends only source selection metadata and an idempotency request, then looks up that request without replay', async () => {
  const fetch = vi.fn().mockResolvedValue(response(receipt())); vi.stubGlobal('fetch', fetch);
  const input = original(), controller = new AbortController();
  await importServerData(projectId, input, controller.signal, validationScope);
  await getServerDataImport(projectId, requestId, controller.signal, validationScope);
  expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Traceomics-Csrf': '1' }, body: JSON.stringify(input) });
  expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  expect(fetch.mock.calls[1][0]).toBe(`/api/server-data/${projectId}/imports/${requestId}`);
  expect(fetch.mock.calls[1][1].method).toBeUndefined();
  expect(fetch.mock.calls[1][1].body).toBeUndefined();
});

it('marks lost or invalid import responses as unconfirmed and preserves safe admission errors', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('private transport details')).mockResolvedValueOnce({ ok: true, status: 202, json: async () => { throw new Error('bad JSON'); } }).mockResolvedValueOnce(response({ error: 'Source changed. Refresh the folder.', code: 'SERVER_DATA_SOURCE_CHANGED' }, 409));
  vi.stubGlobal('fetch', fetch);
  await expect(importServerData('project', {})).rejects.toMatchObject({ code: 'SERVER_DATA_IMPORT_UNCONFIRMED' });
  await expect(importServerData('project', {})).rejects.toMatchObject({ code: 'SERVER_DATA_IMPORT_UNCONFIRMED' });
  await expect(importServerData('project', {})).rejects.toMatchObject({ status: 409, code: 'SERVER_DATA_SOURCE_CHANGED', message: 'Source changed. Refresh the folder.' });
});

it('does not send source selections while a native server is disconnected', async () => {
  window.desktopShell = { getCurrentTarget: async () => ({ id: 'lab', endpoint: 'https://lab.example.test', status: 'disconnected', sshTunnel: { state: 'disconnected' } }) };
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(importServerData('project', {})).rejects.toMatchObject({ code: 'TARGET_DISCONNECTED' });
  expect(fetch).not.toHaveBeenCalled();
});

it('treats an incomplete or mismatched import receipt as unknown instead of confirming another request', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ requestId: 'other', status: 'pending' }))
    .mockResolvedValueOnce(response({ requestId: 'request', status: 'succeeded', version: { projectId: 'other', versionId: 'av_one', sha256: 'a'.repeat(64) } }))
    .mockResolvedValueOnce(response({ requestId: 'request', status: 'succeeded' }));
  vi.stubGlobal('fetch', fetch);
  await expect(importServerData('project', { requestId: 'request' })).rejects.toMatchObject({ code: 'SERVER_DATA_IMPORT_UNCONFIRMED' });
  await expect(importServerData('project', { requestId: 'request' })).rejects.toMatchObject({ code: 'SERVER_DATA_IMPORT_UNCONFIRMED' });
  await expect(getServerDataImport('project', 'request')).rejects.toMatchObject({ code: 'SERVER_DATA_RESPONSE_INVALID' });
});

it('discovers bounded owner-scoped receipts using GET only and keeps current reader capability false', async () => {
  const fetch = vi.fn().mockResolvedValue(response(discovery())); vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  const value = await listServerDataImports(projectId, { cursor: 'page_two', limit: 25, signal: controller.signal, ...validationScope });
  expect(value.canImport).toBe(false); expect(value.items[0].requestId).toBe(requestId);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/server-data/${projectId}/imports?limit=25&cursor=page_two`, expect.objectContaining({ credentials: 'include', signal: controller.signal }));
  expect(fetch.mock.calls[0][1].method).toBeUndefined(); expect(fetch.mock.calls[0][1].body).toBeUndefined();
});

it.each(['ownerUserId', 'serviceId'])('rejects unrelated discovery %s without adopting its current authority', async field => {
  const result = discovery(); result[field] = field === 'ownerUserId' ? 8 : `svc_${'9'.repeat(32)}`; result.canImport = true;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(result)));
  await expect(listServerDataImports(projectId, validationScope)).rejects.toMatchObject({ code: 'SERVER_DATA_RESPONSE_INVALID' });
});

it('binds original normalized POST content and maps a mismatched successful acknowledgement to uncertainty', async () => {
  const result = receipt(); result.request.selectionToken = 'b'.repeat(64);
  result.requestSha256 = createHash('sha256').update(canonicalServerDataImportRequest(result.request)).digest('hex');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(result)));
  await expect(importServerData(projectId, original(), undefined, validationScope)).rejects.toMatchObject({ code: 'SERVER_DATA_IMPORT_UNCONFIRMED' });
});

it('recovers unavailable exact acceptance as a current reader without copying or inventing a version', async () => {
  const result = receipt(); Object.assign(result, { status: 'succeeded', canImport: false, replayed: true, bytesCopied: 3400,
    acceptanceState: 'recorded', availability: 'unavailable', message: null,
    acceptance: { artifactId: `af_${'4'.repeat(24)}`, versionId: `av_${'5'.repeat(24)}`, versionNumber: 1, previousVersionId: null,
      sha256: 'b'.repeat(64), sizeBytes: 3400, createdAt: result.updatedAt } });
  const fetch = vi.fn().mockResolvedValue(response(result)); vi.stubGlobal('fetch', fetch);
  await expect(getServerDataImport(projectId, requestId, undefined, validationScope)).resolves.toMatchObject({ canImport: false, status: 'succeeded', availability: 'unavailable', version: null, acceptance: result.acceptance });
  expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][1].method).toBeUndefined();
});

it('preserves aborts and missing exact receipt codes without sending an automatic retry', async () => {
  const aborted = Object.assign(new Error('Canceled'), { name: 'AbortError' });
  const fetch = vi.fn().mockRejectedValueOnce(aborted).mockResolvedValueOnce(response({ error: 'No request was found.', code: 'SERVER_DATA_IMPORT_NOT_FOUND' }, 404));
  vi.stubGlobal('fetch', fetch);
  await expect(importServerData(projectId, original(), undefined, validationScope)).rejects.toBe(aborted);
  await expect(getServerDataImport(projectId, requestId, undefined, validationScope)).rejects.toMatchObject({ status: 404, code: 'SERVER_DATA_IMPORT_NOT_FOUND' });
  expect(fetch).toHaveBeenCalledTimes(2);
});
