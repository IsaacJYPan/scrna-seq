import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getArtifactImportReceipt, importArtifactVersion, listArtifactVersions, previewArtifactVersion } from './artifactApi';

vi.mock('../api', () => ({ apiUrl: value => value }));
beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

it('sends bounded preview options with cookie authentication and CSRF header', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ integrityVerified: true }) });
  await previewArtifactVersion('project 1', 'av_123', { offset: 25, limit: 10 });
  expect(fetch).toHaveBeenCalledWith('/api/artifact-versions/project%201/av_123/preview?offset=25&limit=10', expect.objectContaining({ credentials: 'include', headers: { 'X-Traceomics-Csrf': '1' } }));
});

it('submits a new immutable version through multipart without changing its prior reference', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ versionId: 'av_next' }) });
  const file = new File(['a,b\n1,2'], 'table.csv');
  const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const expectedRequestSha256 = 'b'.repeat(64);
  const signal = new AbortController().signal;
  await importArtifactVersion('project', { file, name: 'Table', artifactType: 'sample-sheet', previousVersionId: 'av_prior', requestId, expectedRequestSha256, signal });
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe('/api/artifact-versions/project/av_prior/versions');
  expect(options.method).toBe('POST'); expect(options.body.get('file')).toBe(file);
  expect(options.body.get('artifactType')).toBe('sample-sheet'); expect(options.body.get('name')).toBe('Table');
  expect(options.body.get('requestId')).toBe(requestId); expect(options.body.get('expectedRequestSha256')).toBe(expectedRequestSha256);
  expect(options.signal).toBe(signal);
  expect(options.headers['Content-Type']).toBeUndefined();
});

it('checks one original receipt through a source-free authenticated GET without resending bytes', async () => {
  const receipt = { requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'succeeded', availability: 'unavailable', version: null, canImport: false };
  fetch.mockResolvedValue({ ok: true, json: async () => receipt });
  const signal = new AbortController().signal;
  await expect(getArtifactImportReceipt('project 1', receipt.requestId, { signal })).resolves.toBe(receipt);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/artifact-versions/project%201/imports/${receipt.requestId}`, expect.objectContaining({ credentials: 'include', signal, headers: { 'X-Traceomics-Csrf': '1' } }));
  expect(fetch.mock.calls[0][1]).not.toHaveProperty('body');
  expect(fetch.mock.calls[0][1]).not.toHaveProperty('method');
});

it('returns safe public errors for unreachable or invalid artifact responses', async () => {
  fetch.mockRejectedValueOnce(new Error('Request failed at https://secret-host/private'));
  await expect(listArtifactVersions('project')).rejects.toThrow('The artifact service could not be reached. Please try again.');
  fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('<html>private detail'); } });
  await expect(listArtifactVersions('project')).rejects.toThrow('The artifact service returned an invalid response. Please try again.');
});

it('retains useful access/integrity errors and cancellation semantics', async () => {
  fetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Artifact bytes changed.', code: 'ARTIFACT_INTEGRITY_FAILED' }) });
  await expect(listArtifactVersions('project')).rejects.toMatchObject({ message: 'The saved file is missing or its integrity check failed. Earlier versions remain available.', status: 409, code: 'ARTIFACT_INTEGRITY_FAILED' });
  const canceled = new DOMException('Aborted', 'AbortError'); fetch.mockRejectedValueOnce(canceled);
  await expect(listArtifactVersions('project')).rejects.toBe(canceled);
});

it.each([
  [404, 'ARTIFACT_IMPORT_NOT_FOUND', 'No accepted receipt is available yet.'],
  [409, 'ARTIFACT_IMPORT_REQUEST_CONFLICT', 'This request identifies a different accepted import.'],
  [403, 'FORBIDDEN', 'Your current project role cannot perform this action.'],
  [403, 'PROJECT_ROLE_REQUIRED', 'Your current project role cannot perform this action.'],
  [500, 'UNRECOGNIZED_PRIVATE_FAILURE', 'The artifact request could not be confirmed.'],
])('keeps receipt errors public for status %i and %s', async (status, code, publicMessage) => {
  fetch.mockResolvedValue({ ok: false, status, json: async () => ({ code, error: '/private/lab/receipt.sqlite contains a database detail' }) });
  const failure = await getArtifactImportReceipt('project', 'original-request').catch(error => error);
  expect(failure).toMatchObject({ status, code });
  expect(failure.message).toContain(publicMessage);
  expect(failure.message).not.toMatch(/private|sqlite|database/);
});
