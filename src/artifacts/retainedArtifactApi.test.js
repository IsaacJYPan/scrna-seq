import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchRetainedArtifactImage, RETAINED_IMAGE_LIMIT } from './retainedArtifactApi';

vi.mock('./artifactApi', () => ({ artifactImageUrl: (project, version) => `/api/artifact-versions/${project}/${version}/image` }));
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQS7nzHwAEYAJeiHDUBAAAAABJRU5ErkJggg==', 'base64');
const sha256 = createHash('sha256').update(bytes).digest('hex');
beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => { delete window.desktopShell; vi.unstubAllGlobals(); });

it('fetches cookie-authenticated raster bytes and compares their actual checksum before returning a blob', async () => {
  fetch.mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
  const blob = await fetchRetainedArtifactImage('project', 'version', sha256);
  expect(blob.type).toBe('image/png'); expect(blob.size).toBe(bytes.length);
  expect(fetch).toHaveBeenCalledWith('/api/artifact-versions/project/version/image', expect.objectContaining({ credentials: 'include', headers: expect.objectContaining({ Accept: 'image/png, image/jpeg' }) }));
});

it('rejects bytes from a different exact version even when the endpoint returns an image successfully', async () => {
  fetch.mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
  await expect(fetchRetainedArtifactImage('project', 'version', '0'.repeat(64))).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_FAILED', status: 409 });
});

it('rejects active content and cancels an image stream when its actual bytes exceed the bound', async () => {
  fetch.mockResolvedValueOnce(new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }));
  await expect(fetchRetainedArtifactImage('project', 'version', sha256)).rejects.toThrow('raster preview limits');
  let cancelled = false;
  fetch.mockResolvedValueOnce(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(RETAINED_IMAGE_LIMIT + 1)); }, cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'image/png' } }));
  await expect(fetchRetainedArtifactImage('project', 'version', sha256)).rejects.toThrow('raster preview limits');
  expect(cancelled).toBe(true);
});

it('preserves source access denial without exposing an upstream error body', async () => {
  fetch.mockResolvedValueOnce(new Response('private host detail', { status: 404 }));
  await expect(fetchRetainedArtifactImage('project', 'version', sha256)).rejects.toMatchObject({ status: 404, message: 'The saved image is unavailable or access is restricted.' });
});

it('rejects a late image on target epoch change without replaying the request', async () => {
  const target = { id: 'lab', endpoint: 'https://analysis.invalid', serviceIdentity: 'service', status: 'connected' };
  let notify, finish;
  window.desktopShell = { getCurrentTarget: async () => target, onTargetStatus: listener => { notify = listener; return () => {}; } };
  fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const loading = fetchRetainedArtifactImage('project', 'version', sha256);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  notify({ ...target, status: 'disconnected' });
  await expect(loading).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  finish(new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
  expect(fetch).toHaveBeenCalledOnce();
});
