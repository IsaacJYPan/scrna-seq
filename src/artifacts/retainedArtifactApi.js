import { artifactImageUrl } from './artifactApi';
import { withExecutionTarget } from '../runtime/executionTarget';

export const RETAINED_IMAGE_LIMIT = 5 * 1024 * 1024;

// Images must cross the same target boundary as JSON reads. A raw <img src>
// would otherwise bypass that boundary and could outlive a server switch.
export function fetchRetainedArtifactImage(projectId, versionId, expectedSha256, { signal } = {}) {
  return withExecutionTarget(async () => {
    let response;
    try {
      response = await fetch(artifactImageUrl(projectId, versionId), {
        credentials: 'include', signal, headers: { Accept: 'image/png, image/jpeg', 'X-Traceomics-Csrf': '1' },
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('The saved image could not be reached. Try again.');
    }
    if (!response.ok) throw Object.assign(new Error('The saved image is unavailable or access is restricted.'), { status: response.status });
    const type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    const declared = Number(response.headers.get('Content-Length'));
    if (!['image/png', 'image/jpeg'].includes(type) || declared > RETAINED_IMAGE_LIMIT) {
      await response.body?.cancel();
      throw new Error('This saved image exceeds the supported raster preview limits.');
    }
    let bytes;
    if (response.body?.getReader) {
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.byteLength;
          if (size > RETAINED_IMAGE_LIMIT) {
            await reader.cancel();
            throw new Error('This saved image exceeds the supported raster preview limits.');
          }
          chunks.push(result.value);
        }
        bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      } finally { reader.releaseLock(); }
    } else bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > RETAINED_IMAGE_LIMIT) throw new Error('This saved image exceeds the supported raster preview limits.');
    if (!globalThis.crypto?.subtle) throw new Error('Image integrity verification is unavailable in this browser.');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== expectedSha256) throw Object.assign(new Error('The saved image does not match the requested checksum.'), { code: 'ARTIFACT_INTEGRITY_FAILED', status: 409 });
    return new Blob([bytes], { type });
  });
}
