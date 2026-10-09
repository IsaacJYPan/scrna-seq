import { afterEach, expect, it, vi } from 'vitest';
import { getServerDataImport, importServerData, listServerDataFiles, listServerDataRoots } from './serverDataApi';

afterEach(() => { vi.unstubAllGlobals(); delete window.desktopShell; });
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });

it('requests bounded server metadata on the selected service with encoded project, root and relative directory', async () => {
  const fetch = vi.fn().mockResolvedValue(response({ items: [], nextCursor: null })); vi.stubGlobal('fetch', fetch);
  await listServerDataRoots('project/a');
  await listServerDataFiles('project/a', 'root b', { path: 'study/sample 1', cursor: 'next', limit: 25 });
  expect(fetch).toHaveBeenNthCalledWith(1, '/api/server-data/project%2Fa/roots', expect.objectContaining({ credentials: 'include', headers: { 'X-Traceomics-Csrf': '1' } }));
  expect(fetch.mock.calls[1][0]).toBe('/api/server-data/project%2Fa/roots/root%20b/files?path=study%2Fsample+1&limit=25&cursor=next');
});

it('sends only source selection metadata and an idempotency request, then looks up that request without replay', async () => {
  const fetch = vi.fn().mockResolvedValue(response({ status: 'pending', requestId: 'request-1' })); vi.stubGlobal('fetch', fetch);
  const input = { requestId: 'request-1', rootId: 'root', relativePath: 'study/analysis.rds', selectionToken: 'a'.repeat(64), name: 'Analysis', artifactType: 'auto' };
  await importServerData('project', input);
  await getServerDataImport('project', 'request-1');
  expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Traceomics-Csrf': '1' }, body: JSON.stringify(input) });
  expect(fetch.mock.calls[1][0]).toBe('/api/server-data/project/imports/request-1');
  expect(fetch.mock.calls[1][1].method).toBeUndefined();
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
