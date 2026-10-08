import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { importArtifactVersion, listArtifactVersions, previewArtifactVersion } from './artifactApi';

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
  await importArtifactVersion('project', { file, name: 'Table', artifactType: 'sample-sheet', previousVersionId: 'av_prior' });
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe('/api/artifact-versions/project/av_prior/versions');
  expect(options.method).toBe('POST'); expect(options.body.get('file')).toBe(file);
  expect(options.body.get('artifactType')).toBe('sample-sheet'); expect(options.body.get('name')).toBe('Table');
  expect(options.headers['Content-Type']).toBeUndefined();
});

it('returns safe public errors for unreachable or invalid artifact responses', async () => {
  fetch.mockRejectedValueOnce(new Error('Request failed at https://secret-host/private'));
  await expect(listArtifactVersions('project')).rejects.toThrow('The artifact service could not be reached. Please try again.');
  fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('<html>private detail'); } });
  await expect(listArtifactVersions('project')).rejects.toThrow('The artifact service returned an invalid response. Please try again.');
});

it('retains useful access/integrity errors and cancellation semantics', async () => {
  fetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Artifact bytes changed.', code: 'ARTIFACT_INTEGRITY_FAILED' }) });
  await expect(listArtifactVersions('project')).rejects.toMatchObject({ message: 'Artifact bytes changed.', status: 409, code: 'ARTIFACT_INTEGRITY_FAILED' });
  const canceled = new DOMException('Aborted', 'AbortError'); fetch.mockRejectedValueOnce(canceled);
  await expect(listArtifactVersions('project')).rejects.toBe(canceled);
});
