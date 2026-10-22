import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalServerDataImportRequest, normalizeServerDataImportRequest } from '../../shared/serverDataImport.mjs';
import { validateServerDataImport, validateServerDataImportList } from './serverDataImportValidation';

const scope = { projectId: `proj_${'1'.repeat(24)}`, userId: 7, serviceId: `svc_${'2'.repeat(32)}` };
const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const id = `sdi_${'3'.repeat(24)}`, artifactId = `af_${'4'.repeat(24)}`, versionId = `av_${'5'.repeat(24)}`;
const previousVersionId = `av_${'6'.repeat(24)}`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fileSha = sha256('sample,value\nA,2');
const invalid = { code: 'SERVER_DATA_RESPONSE_INVALID' };
const original = (extras = {}) => ({ requestId, rootId: 'lab-data', relativePath: 'study/results.csv', selectionToken: 'a'.repeat(64),
  name: 'Original server result', artifactType: 'auto', previousVersionId: null, ...extras });
const common = () => ({ projectId: scope.projectId, ownerUserId: 7, serviceId: scope.serviceId, canImport: true });
function pending(input = original()) {
  const request = normalizeServerDataImportRequest(input);
  return { ...common(), id, requestId: request.requestId, requestSha256: sha256(canonicalServerDataImportRequest(request)), request, name: request.name,
    status: 'pending', replayed: false, source: { rootId: request.rootId, relativePath: request.relativePath, name: request.relativePath.split('/').at(-1),
      serviceId: scope.serviceId, serviceLabel: 'Research server', ...(request.sampleMetadata ? { sampleMetadata: structuredClone(request.sampleMetadata) } : {}) },
    reservedBytes: 16, bytesCopied: 8, createdAt: '2026-10-20T12:00:00.000Z', updatedAt: '2026-10-20T12:00:01.000Z', expiresAt: '2026-10-20T12:15:00.000Z',
    acceptanceState: 'not-accepted', acceptance: null, availability: 'not-recorded', version: null, error: null,
    message: 'The server is copying and verifying the original source.' };
}
function succeeded(input = original()) {
  const result = pending(input), previous = result.request.previousVersionId;
  Object.assign(result, { status: 'succeeded', bytesCopied: 16, message: null, acceptanceState: 'recorded', availability: 'recorded',
    acceptance: { artifactId, versionId, versionNumber: previous ? 2 : 1, previousVersionId: previous, sha256: fileSha, sizeBytes: 16, createdAt: result.updatedAt } });
  result.version = { kind: 'artifact-version', schemaVersion: 1, artifactId, versionId, projectId: scope.projectId, ownerId: '7',
    name: result.name, type: result.request.artifactType === 'sample-sheet' ? 'sample-sheet' : 'table', format: { id: 'org.ietf.csv', version: '1' },
    sha256: fileSha, sizeBytes: 16, storageRef: versionId, sourceRunId: null, createdAt: result.acceptance.createdAt, previews: ['table'],
    versionNumber: result.acceptance.versionNumber, previousVersionId: previous, owner: { id: '7', displayName: 'Researcher' },
    source: { kind: 'managed-file', id: versionId }, reference: { artifactId, versionId, projectId: scope.projectId, sha256: fileSha },
    previewBudget: { responseBytes: 262144, imageBytes: 5242880, maximumRows: 100 }, canReplace: true,
    sourceImport: { importId: id, rootId: result.source.rootId, rootLabel: 'Authorized study data', relativePath: result.source.relativePath,
      serviceId: scope.serviceId, serviceLabel: result.source.serviceLabel, sha256: fileSha, importedAt: result.updatedAt,
      ...(result.source.sampleMetadata ? { sampleMetadata: structuredClone(result.source.sampleMetadata) } : {}) } };
  return result;
}
function failed() {
  return { ...pending(), status: 'failed', message: null, error: { code: 'SERVER_IMPORT_SOURCE_CHANGED', message: 'The source changed while copying.' } };
}
function summary(result = pending()) {
  const { request: _request, replayed: _replayed, version: _version, message: _message, projectId: _project, ownerUserId: _owner,
    serviceId: _service, canImport: _canImport, ...item } = result;
  return { ...item, availability: item.status === 'succeeded' ? 'not-checked' : 'not-recorded' };
}
const list = (items = [summary()]) => ({ ...common(), items, nextCursor: null });

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

it('preserves the literal existing canonical order, UUID/token hash, defaults and supplied empty annotations', async () => {
  const input = { sampleMetadata: {}, name: ' Original server result ', selectionToken: 'a'.repeat(64), relativePath: 'study/results.csv',
    rootId: 'lab-data', requestId: requestId.toUpperCase() };
  const canonical = `{"requestId":"${requestId}","rootId":"lab-data","relativePath":"study/results.csv","selectionToken":"${'a'.repeat(64)}","name":"Original server result","artifactType":"auto","previousVersionId":null,"sampleMetadata":{}}`;
  expect(canonicalServerDataImportRequest(input)).toBe(canonical);
  expect(canonicalServerDataImportRequest(original())).not.toContain('sampleMetadata');
  const result = pending(input), value = await validateServerDataImport(result, scope, input);
  expect(value.requestSha256).toBe(sha256(canonical)); expect(value.request.sampleMetadata).toEqual({});
  expect(sha256(canonicalServerDataImportRequest({ ...input, requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }))).not.toBe(value.requestSha256);
  expect(sha256(canonicalServerDataImportRequest({ ...input, selectionToken: 'b'.repeat(64) }))).not.toBe(value.requestSha256);
});

it('normalizes annotations in their existing alphabetical order while preserving exact request and source identity', async () => {
  const input = original({ sampleMetadata: { tissue: ' brain ', sampleId: ' A ', condition: ' treated ' } });
  const result = pending(input);
  expect(canonicalServerDataImportRequest(input).endsWith('"sampleMetadata":{"condition":"treated","sampleId":"A","tissue":"brain"}}')).toBe(true);
  await expect(validateServerDataImport(result, { ...scope, userId: '7', requestId }, input)).resolves.toEqual(result);
});

it.each([pending, failed, succeeded])('preserves current reader authority and the exact %s outcome without broadening it', async fixture => {
  const result = fixture(); result.canImport = false; result.replayed = true;
  const value = await validateServerDataImport(result, scope);
  expect(value).toEqual(result); expect(value).not.toBe(result); expect(value.source).not.toBe(result.source);
  expect(value.canImport).toBe(false);
});

it('keeps immutable original acceptance when current artifact metadata or bytes are missing', async () => {
  const result = succeeded(original({ previousVersionId })); result.availability = 'unavailable'; result.version = null; result.canImport = false;
  const value = await validateServerDataImport(result, scope, original({ previousVersionId }));
  expect(value.acceptance).toEqual(result.acceptance); expect(value.acceptance.previousVersionId).toBe(previousVersionId);
  expect(value.availability).toBe('unavailable'); expect(value.version).toBeNull(); expect(value.canImport).toBe(false);
});

it('retains explicit legacy completion without inventing a checksum or a current version', async () => {
  const result = succeeded(); Object.assign(result, { request: null, acceptanceState: 'legacy-unrecorded', acceptance: null,
    availability: 'unavailable', version: null, canImport: false, replayed: true });
  await expect(validateServerDataImport(result, { projectId: scope.projectId, userId: '7' })).resolves.toEqual(result);
  expect(validateServerDataImportList(list([summary(result)]), scope).items[0].acceptanceState).toBe('legacy-unrecorded');
});

it('binds a reconstructable legacy receipt to a caller-held canonical hash even when the original request is not retained', async () => {
  const result = succeeded(); result.request = null;
  await expect(validateServerDataImport(result, scope, original())).resolves.toEqual(result);
  await expect(validateServerDataImport(result, scope, original({ selectionToken: 'b'.repeat(64) }))).rejects.toMatchObject(invalid);
});

it('validates sample-sheet purpose and an exact replacement predecessor without choosing a newer artifact version', async () => {
  const input = original({ previousVersionId, artifactType: 'sample-sheet' }), result = succeeded(input);
  expect((await validateServerDataImport(result, scope, input)).version.type).toBe('sample-sheet');
  result.version.versionId = `av_${'9'.repeat(24)}`;
  await expect(validateServerDataImport(result, scope, input)).rejects.toMatchObject(invalid);
});

it('accepts the existing account display-name bound independently of import authority', async () => {
  const result = succeeded(); result.version.owner.displayName = 'R'.repeat(200); result.canImport = false;
  await expect(validateServerDataImport(result, scope)).resolves.toMatchObject({ canImport: false, version: { owner: { displayName: 'R'.repeat(200) } } });
});

it.each([
  ['another project', value => { value.projectId = `proj_${'9'.repeat(24)}`; }],
  ['another owner', value => { value.ownerUserId = 8; }],
  ['coerced owner', value => { value.ownerUserId = '7'; }],
  ['invalid owner', value => { value.ownerUserId = 0; }],
  ['another service', value => { value.serviceId = `svc_${'9'.repeat(32)}`; }],
  ['malformed service', value => { value.serviceId = 'https://private.example'; }],
  ['another exact request', value => { value.requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; }],
  ['uppercase response UUID', value => { value.requestId = requestId.toUpperCase(); }],
  ['wrong operation ID', value => { value.id = 'sdi_private'; }],
  ['coerced capability', value => { value.canImport = 'true'; }],
  ['missing capability', value => { delete value.canImport; }],
  ['coerced replay flag', value => { value.replayed = 1; }],
  ['malformed checksum', value => { value.requestSha256 = 'A'.repeat(64); }],
  ['incorrect checksum', value => { value.requestSha256 = '0'.repeat(64); }],
  ['unrelated canonical request', value => { value.request.selectionToken = 'b'.repeat(64); }],
  ['unnormalized original body', value => { value.request.name = ' Original server result '; }],
  ['unknown original field', value => { value.request.hostPath = '/private/file'; }],
  ['unknown status', value => { value.status = 'complete'; }],
  ['negative reservation', value => { value.reservedBytes = -1; }],
  ['excessive reservation', value => { value.reservedBytes = 64 * 1024 ** 3 + 1; }],
  ['fractional progress', value => { value.bytesCopied = 1.5; }],
  ['progress exceeds reservation', value => { value.bytesCopied = 17; }],
  ['invalid created date', value => { value.createdAt = '2026-02-30T12:00:00.000Z'; }],
  ['noncanonical date', value => { value.createdAt = '2026-10-20T12:00:00Z'; }],
  ['update precedes creation', value => { value.updatedAt = '2026-10-19T12:00:00.000Z'; }],
  ['deadline precedes creation', value => { value.expiresAt = value.createdAt; }],
  ['unknown source field', value => { value.source.absolutePath = '/private/study/results.csv'; }],
  ['unsafe source path', value => { value.source.relativePath = '../results.csv'; }],
  ['unrelated source path', value => { value.source.relativePath = 'other/results.csv'; }],
  ['unrelated root', value => { value.source.rootId = 'other-root'; }],
  ['source name mismatch', value => { value.source.name = 'other.csv'; }],
  ['unrelated source service', value => { value.source.serviceId = `svc_${'9'.repeat(32)}`; }],
  ['source control character', value => { value.source.serviceLabel = 'Research\u0000server'; }],
  ['oversized source label', value => { value.source.serviceLabel = 'x'.repeat(81); }],
  ['unbound sample context', value => { value.source.sampleMetadata = { condition: 'other' }; }],
  ['private unknown response field', value => { value.storagePath = '/private/artifacts'; }],
  ['fake pending acceptance', value => { value.acceptanceState = 'recorded'; }],
  ['fake pending availability', value => { value.availability = 'recorded'; }],
  ['fake pending version', value => { value.version = succeeded().version; }],
  ['pending failure', value => { value.error = { code: 'ERROR', message: 'Rejected' }; }],
  ['missing pending copy message', value => { value.message = null; }],
])('rejects exact response with %s', async (_label, mutate) => {
  const result = pending(); mutate(result);
  await expect(validateServerDataImport(result, { ...scope, requestId }, original())).rejects.toMatchObject(invalid);
});

it.each([
  ['unrelated artifact', value => { value.acceptance.artifactId = `af_${'9'.repeat(24)}`; }],
  ['unrelated version', value => { value.acceptance.versionId = `av_${'9'.repeat(24)}`; }],
  ['missing immutable acceptance', value => { value.acceptance = null; }],
  ['forged accepted checksum', value => { value.acceptance.sha256 = 'b'.repeat(64); }],
  ['forged accepted size', value => { value.acceptance.sizeBytes = 15; }],
  ['incomplete successful copy', value => { value.bytesCopied = 15; }],
  ['invalid initial lineage', value => { value.acceptance.versionNumber = 2; }],
  ['unbound predecessor', value => { value.acceptance.previousVersionId = previousVersionId; value.acceptance.versionNumber = 2; }],
  ['self predecessor', value => { value.acceptance.previousVersionId = versionId; value.acceptance.versionNumber = 2; }],
  ['invalid accepted time', value => { value.acceptance.createdAt = '2026-02-30T12:00:00.000Z'; }],
  ['private acceptance field', value => { value.acceptance.storageKey = '/private/file'; }],
  ['wrong current project', value => { value.version.projectId = `proj_${'9'.repeat(24)}`; }],
  ['wrong current owner', value => { value.version.ownerId = '8'; }],
  ['later current version', value => { value.version.versionId = `av_${'9'.repeat(24)}`; }],
  ['renamed current version', value => { value.version.name = 'Later metadata'; }],
  ['wrong current bytes', value => { value.version.sha256 = 'b'.repeat(64); }],
  ['wrong current size', value => { value.version.sizeBytes = 15; }],
  ['wrong current lineage', value => { value.version.previousVersionId = previousVersionId; }],
  ['wrong accepted creation time', value => { value.version.createdAt = value.createdAt; }],
  ['wrong opaque storage reference', value => { value.version.storageRef = `av_${'9'.repeat(24)}`; }],
  ['fabricated scientific source', value => { value.version.sourceRunId = 'run_scientific'; }],
  ['wrong owner metadata', value => { value.version.owner.id = '8'; }],
  ['unbounded owner label', value => { value.version.owner.displayName = 'x'.repeat(201); }],
  ['wrong source kind', value => { value.version.source.kind = 'shared-file'; }],
  ['wrong source version', value => { value.version.source.id = `av_${'9'.repeat(24)}`; }],
  ['wrong reference', value => { value.version.reference.sha256 = 'b'.repeat(64); }],
  ['unknown current file path', value => { value.version.hostPath = '/private/file'; }],
  ['current preview widening', value => { value.version.previews = ['execute']; }],
  ['duplicate preview capability', value => { value.version.previews = ['table', 'table']; }],
  ['invalid preview budget', value => { value.version.previewBudget.maximumRows = 0; }],
  ['wrong format', value => { value.version.format.id = 'org.w3.png'; value.version.type = 'image'; }],
  ['wrong artifact purpose', value => { value.version.type = 'sample-sheet'; }],
  ['newer source provenance', value => { value.version.sourceImport.importId = `sdi_${'9'.repeat(24)}`; }],
  ['wrong provenance checksum', value => { value.version.sourceImport.sha256 = 'b'.repeat(64); }],
  ['wrong provenance service', value => { value.version.sourceImport.serviceId = `svc_${'9'.repeat(32)}`; }],
  ['wrong provenance source', value => { value.version.sourceImport.relativePath = 'other/results.csv'; }],
  ['unbound provenance sample notes', value => { value.version.sourceImport.sampleMetadata = {}; }],
  ['invented legacy current version', value => { value.acceptanceState = 'legacy-unrecorded'; value.acceptance = null; value.availability = 'unavailable'; }],
  ['success with failure', value => { value.error = { code: 'ERROR', message: 'Rejected' }; }],
  ['success copy message', value => { value.message = 'Still copying'; }],
])('rejects terminal acceptance with %s', async (_label, mutate) => {
  const result = succeeded(); mutate(result);
  await expect(validateServerDataImport(result, scope, original())).rejects.toMatchObject(invalid);
});

it('keeps terminal failure distinct from uncertainty and never treats failed progress as an accepted version', async () => {
  const result = failed(); result.canImport = false;
  await expect(validateServerDataImport(result, scope)).resolves.toMatchObject({ status: 'failed', error: result.error, acceptance: null, version: null });
  result.error.hostPath = '/private/file';
  await expect(validateServerDataImport(result, scope)).rejects.toMatchObject(invalid);
});

it('discovers at most thirty owner-scoped newest-first receipts without claiming current file availability', () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ ...summary(succeeded()), id: `sdi_${(30 - index).toString(16).padStart(24, '0')}`,
    requestId: `${(index + 1).toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa` }));
  const result = list(items); result.nextCursor = 'eyJwYWdlIjoxfQ'; result.canImport = false;
  const value = validateServerDataImportList(result, { projectId: scope.projectId, userId: '7' });
  expect(value.items).toHaveLength(30); expect(value.canImport).toBe(false); expect(value.items.every(row => row.availability === 'not-checked')).toBe(true);
  expect(value.items[0]).not.toBe(result.items[0]); expect(validateServerDataImportList(list([]), scope).items).toEqual([]);
});

it.each([
  ['wrong scope', value => { value.projectId = `proj_${'9'.repeat(24)}`; }],
  ['another owner', value => { value.ownerUserId = 8; }],
  ['another service', value => { value.serviceId = `svc_${'9'.repeat(32)}`; }],
  ['missing authority', value => { delete value.canImport; }],
  ['unknown envelope field', value => { value.rootPath = '/private/root'; }],
  ['unknown row field', value => { value.items[0].request = original(); }],
  ['unbounded page', value => { value.items = Array(31).fill(summary()); }],
  ['duplicate request', value => { value.items.push({ ...summary(), id: `sdi_${'1'.repeat(24)}` }); }],
  ['duplicate operation', value => { value.items.push({ ...summary(), requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }); }],
  ['newer page entry last', value => { value.items.push({ ...summary(), id: `sdi_${'4'.repeat(24)}`, requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', createdAt: '2026-10-20T12:00:01.000Z' }); }],
  ['wrong same-time operation order', value => { value.items.push({ ...summary(), id: `sdi_${'4'.repeat(24)}`, requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }); }],
  ['current file availability claim', value => { value.items[0] = { ...summary(succeeded()), availability: 'recorded' }; }],
  ['pending availability claim', value => { value.items[0].availability = 'not-checked'; }],
  ['missing cursor', value => { delete value.nextCursor; }],
  ['oversized cursor', value => { value.nextCursor = 'a'.repeat(257); }],
  ['source path cursor', value => { value.nextCursor = '/private/path'; }],
  ['empty continued page', value => { value.items = []; value.nextCursor = 'next'; }],
])('rejects private discovery with %s', (_label, mutate) => {
  const result = list(); mutate(result);
  expect(() => validateServerDataImportList(result, scope)).toThrow(expect.objectContaining(invalid));
});

it.each([
  { projectId: scope.projectId, userId: '07' }, { projectId: scope.projectId, userId: 0 },
  { projectId: scope.projectId, serviceId: 'lab' }, { projectId: scope.projectId, requestId: 'request' },
  { projectId: scope.projectId, userId: 7, credentials: 'secret' },
])('rejects invalid validation scope %j', async badScope => {
  await expect(validateServerDataImport(pending(), badScope)).rejects.toMatchObject(invalid);
  expect(() => validateServerDataImportList(list(), badScope)).toThrow(expect.objectContaining(invalid));
});

it('rejects getters, hidden or inherited fields, sparse arrays and cycles without running response code', async () => {
  const getter = vi.fn(() => true), values = [];
  const accessor = pending(); Object.defineProperty(accessor, 'canImport', { enumerable: true, get: getter }); values.push(accessor);
  const hidden = pending(); Object.defineProperty(hidden, 'secret', { value: 'private' }); values.push(hidden);
  values.push(Object.assign(Object.create({ privatePath: '/private' }), pending()));
  const symbol = pending(); symbol[Symbol('secret')] = true; values.push(symbol);
  const cycle = pending(); cycle.request.circular = cycle; values.push(cycle);
  for (const value of values) await expect(validateServerDataImport(value, scope)).rejects.toMatchObject(invalid);
  expect(getter).not.toHaveBeenCalled();
  const page = list(); page.items = Array(1);
  expect(() => validateServerDataImportList(page, scope)).toThrow(expect.objectContaining(invalid));
  const indexGetter = list(); Object.defineProperty(indexGetter.items, '0', { enumerable: true, get: getter });
  expect(() => validateServerDataImportList(indexGetter, scope)).toThrow(expect.objectContaining(invalid));
  expect(getter).not.toHaveBeenCalled();
});

it('snapshots the complete response and expected request before awaiting the checksum', async () => {
  const result = succeeded(), input = original(); let finish;
  vi.stubGlobal('crypto', { subtle: { digest: vi.fn((_algorithm, bytes) => new Promise(resolve => { finish = () => resolve(webcrypto.subtle.digest('SHA-256', bytes)); })) } });
  const checking = validateServerDataImport(result, scope, input);
  result.canImport = true; result.version.versionId = `av_${'9'.repeat(24)}`; result.acceptance.sha256 = '9'.repeat(64); input.name = 'Changed during digest';
  finish(); const value = await checking;
  expect(value.version.versionId).toBe(versionId); expect(value.acceptance.sha256).toBe(fileSha); expect(value.request.name).toBe('Original server result');
});

it('rejects unavailable checksum computation without confirming the request', async () => {
  vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockRejectedValue(new Error('unavailable')) } });
  await expect(validateServerDataImport(pending(), scope)).rejects.toMatchObject(invalid);
});
