import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ARTIFACT_UPLOAD_LIMITS, artifactImportRequestSha256, canonicalArtifactImportRequest, normalizeArtifactImportRequest, prepareArtifactImportRequest, validateArtifactImportReceipt } from './artifactImportReceipt';

const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const previousVersionId = `av_${'1'.repeat(24)}`;
const artifactId = `af_${'2'.repeat(24)}`;
const versionId = `av_${'3'.repeat(24)}`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const prepared = overrides => ({ schema: 'traceomics.artifact-import.v1', projectId: 'project', ownerUserId: 1, requestId,
  originalFilename: 'scores.csv', name: 'Gene scores', artifactType: 'sample-sheet', previousVersionId, sha256: sha256('gene,score\nA,2'), sizeBytes: 14, ...overrides });

async function accepted(request = prepared(), overrides = {}) {
  const acceptance = { artifactId, versionId, versionNumber: 2, previousVersionId: request.previousVersionId, sha256: request.sha256,
    sizeBytes: request.sizeBytes, createdAt: '2026-10-20T12:00:00.000Z' };
  const version = { artifactId, versionId, versionNumber: 2, previousVersionId: request.previousVersionId, projectId: request.projectId,
    ownerId: String(request.ownerUserId), name: request.name, type: 'sample-sheet', sha256: request.sha256, sizeBytes: request.sizeBytes,
    canReplace: true, reference: { artifactId, versionId, projectId: request.projectId, sha256: request.sha256 } };
  return { requestId, request, requestSha256: await artifactImportRequestSha256(request), status: 'succeeded', acceptance,
    availability: 'recorded', version, canImport: true, ...overrides };
}

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

it('binds the actual selected bytes, byte count, normalized settings, account and immutable replacement into the canonical request', async () => {
  const content = 'gene,score\nα,2\0';
  const file = new File([content], '  scores.csv  ');
  const request = await prepareArtifactImportRequest({ file, name: '  Gene scores  ', artifactType: 'sample-sheet', previousVersionId,
    projectId: 'project', ownerUserId: '1', requestId });
  expect(request).toEqual(prepared({ sha256: sha256(content), sizeBytes: new TextEncoder().encode(content).byteLength }));
  const canonical = JSON.stringify({ schema: 'traceomics.artifact-import.v1', projectId: 'project', ownerUserId: 1, requestId,
    originalFilename: 'scores.csv', name: 'Gene scores', artifactType: 'sample-sheet', previousVersionId,
    sha256: sha256(content), sizeBytes: file.size });
  expect(canonicalArtifactImportRequest(request)).toBe(canonical);
  const reordered = Object.fromEntries(Object.entries(request).reverse());
  expect(await artifactImportRequestSha256(reordered)).toBe(sha256(canonical));
  expect(await artifactImportRequestSha256(prepared({ ...request, previousVersionId: null }))).not.toBe(sha256(canonical));
});

it('uses the basename for a default name and counts empty files exactly', async () => {
  const file = new File([], 'C:\\uploads\\empty.csv');
  await expect(prepareArtifactImportRequest({ file, projectId: 'project', ownerUserId: 1, requestId })).resolves.toEqual(prepared({
    name: 'empty.csv', originalFilename: 'empty.csv', artifactType: 'auto', previousVersionId: null, sha256: sha256(''), sizeBytes: 0,
  }));
});

it('rejects an oversized or unreadable file before submitting any request', async () => {
  const input = { name: 'Gene scores', projectId: 'project', ownerUserId: 1, requestId };
  const arrayBuffer = vi.fn();
  await expect(prepareArtifactImportRequest({ ...input, file: { name: 'scores.csv', size: ARTIFACT_UPLOAD_LIMITS.otherFileBytes + 1, arrayBuffer } })).rejects.toMatchObject({ code: 'INVALID_ARTIFACT_IMPORT_INPUT' });
  expect(arrayBuffer).not.toHaveBeenCalled();
  await expect(prepareArtifactImportRequest({ ...input, file: { name: 'object.rds', size: ARTIFACT_UPLOAD_LIMITS.fileBytes + 1, arrayBuffer } })).rejects.toMatchObject({ code: 'INVALID_ARTIFACT_IMPORT_INPUT' });
  await expect(prepareArtifactImportRequest({ ...input, file: { name: 'scores.csv', size: 2, arrayBuffer: async () => new Uint8Array([1]).buffer } })).rejects.toMatchObject({ code: 'INVALID_ARTIFACT_IMPORT_INPUT' });
  await expect(prepareArtifactImportRequest({ ...input, file: { name: 'scores.csv', size: 2, arrayBuffer: async () => { throw new Error('disk unavailable'); } } })).rejects.toMatchObject({ code: 'INVALID_ARTIFACT_IMPORT_INPUT' });
});

it.each([
  ['extra source information', value => ({ ...value, sourcePath: 'C:\\private\\scores.csv' })],
  ['request identity', value => ({ ...value, requestId: 'not-a-uuid' })],
  ['account identity', value => ({ ...value, ownerUserId: '1' })],
  ['untrimmed name', value => ({ ...value, name: ' Gene scores ' })],
  ['line breaks', value => ({ ...value, name: 'Gene\nscores' })],
  ['source path', value => ({ ...value, originalFilename: '../scores.csv' })],
  ['unsupported purpose', value => ({ ...value, artifactType: 'table' })],
  ['mutable replacement', value => ({ ...value, previousVersionId: 'latest' })],
  ['uppercase checksum', value => ({ ...value, sha256: 'A'.repeat(64) })],
  ['fractional size', value => ({ ...value, sizeBytes: 1.5 })],
  ['inherited identity', value => Object.create(value)],
  ['accessor field', value => Object.defineProperty({ ...value }, 'name', { enumerable: true, get: () => 'Gene scores' })],
])('rejects a canonical request with %s', (_label, mutate) => {
  expect(() => normalizeArtifactImportRequest(mutate(prepared()))).toThrow(expect.objectContaining({ code: 'INVALID_ARTIFACT_IMPORT_RESPONSE' }));
});

it('accepts exact POST and GET receipts while honoring current read-only authority', async () => {
  const receipt = await accepted(undefined, { canImport: false });
  expect((await validateArtifactImportReceipt(receipt, prepared())).canImport).toBe(false);
  const { version, ...importRequest } = receipt;
  const result = await validateArtifactImportReceipt({ ...version, importRequest: { ...importRequest, replayed: true } }, prepared(), { post: true });
  expect(result).toMatchObject({ requestId, acceptance: receipt.acceptance, canImport: false, version, replayed: true });
  expect(result.version.canReplace).toBe(true);
});

it('confirms acceptance without claiming bytes are still available', async () => {
  const receipt = await accepted(undefined, { availability: 'unavailable', version: null, canImport: false });
  await expect(validateArtifactImportReceipt(receipt, prepared())).resolves.toMatchObject({ acceptance: receipt.acceptance, availability: 'unavailable', version: null, canImport: false });
  const { version: _version, ...importRequest } = receipt;
  await expect(validateArtifactImportReceipt({ version: null, importRequest: { ...importRequest, replayed: true } }, prepared(), { post: true })).resolves.toMatchObject({ availability: 'unavailable', version: null });
});

it.each([
  ['another request', value => { value.requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; }],
  ['another request account', value => { value.request.ownerUserId = 2; }],
  ['another request project', value => { value.request.projectId = 'other-project'; }],
  ['changed upload settings', value => { value.request.name = 'Different scores'; }],
  ['changed fingerprint', value => { value.requestSha256 = '0'.repeat(64); }],
  ['missing authority', value => { delete value.canImport; }],
  ['nonboolean authority', value => { value.canImport = 'true'; }],
  ['unconfirmed state', value => { value.status = 'unknown'; }],
  ['wrong accepted artifact', value => { value.acceptance.artifactId = `af_${'4'.repeat(24)}`; }],
  ['wrong accepted version', value => { value.acceptance.versionId = `av_${'4'.repeat(24)}`; }],
  ['wrong accepted replacement', value => { value.acceptance.previousVersionId = null; }],
  ['wrong accepted bytes', value => { value.acceptance.sha256 = '0'.repeat(64); }],
  ['wrong accepted size', value => { value.acceptance.sizeBytes++; }],
  ['invalid accepted time', value => { value.acceptance.createdAt = 'not a date'; }],
  ['missing recorded version', value => { value.version = null; }],
  ['unavailable bytes with a version', value => { value.availability = 'unavailable'; }],
  ['wrong retained owner', value => { value.version.ownerId = '2'; }],
  ['wrong retained project', value => { value.version.projectId = 'other-project'; }],
  ['wrong retained version number', value => { value.version.versionNumber++; }],
  ['wrong retained purpose', value => { value.version.type = 'table'; }],
  ['wrong exact reference', value => { value.version.reference.sha256 = '0'.repeat(64); }],
])('leaves an outcome unconfirmed for %s', async (_label, mutate) => {
  const receipt = await accepted();
  mutate(receipt);
  await expect(validateArtifactImportReceipt(receipt, prepared())).rejects.toMatchObject({ code: 'INVALID_ARTIFACT_IMPORT_RESPONSE' });
});

it('rejects bare or nested unrelated acknowledgements rather than treating any success response as acceptance', async () => {
  const receipt = await accepted();
  await expect(validateArtifactImportReceipt(receipt.version, prepared(), { post: true })).rejects.toMatchObject({ code: 'INVALID_ARTIFACT_IMPORT_RESPONSE' });
  await expect(validateArtifactImportReceipt({ version: receipt.version, importRequest: receipt }, prepared(), { post: true })).rejects.toMatchObject({ code: 'INVALID_ARTIFACT_IMPORT_RESPONSE' });
  const { version, ...importRequest } = receipt;
  await expect(validateArtifactImportReceipt({ ...version, importRequest }, prepared(), { post: true })).rejects.toMatchObject({ code: 'INVALID_ARTIFACT_IMPORT_RESPONSE' });
});
