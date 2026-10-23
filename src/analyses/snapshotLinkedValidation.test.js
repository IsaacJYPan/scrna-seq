import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSnapshotJson, canonicalAnalysisSnapshotPreparation,
  canonicalAnalysisSnapshotResultView } from '../../shared/analysisSnapshotPreparationDispatch.mjs';
import { validateSnapshotPreparation, validateSnapshotPreparationOptions, validateSnapshotPackage,
  decodeSnapshotPreparationTable } from './snapshotPreparationValidation';
import { validateSnapshotPublication, validateSnapshotPublicationReceipt } from './snapshotPublicationValidation';
import { linkedRecipe, linkedRecord, linkedReference, linkedOptions, linkedTableBytes, linkedImageResult } from './snapshotLinkedTestFixtures';
import { snapshotScope, snapshotRecipe, snapshotRecord } from './snapshotPreparationTestFixtures';
import { publicationScope, publicationFull, publicationAnchor, publicationReceipt } from './snapshotPublicationTestFixtures';

const hash = value => createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);
const error = { code: 'INVALID_SNAPSHOT_PREPARATION_RESPONSE' };
const publicationError = { code: 'INVALID_SNAPSHOT_PUBLICATION_RESPONSE' };
const prereq = (reference = linkedReference()) => ({ kind: 'analysis-reference', reference, label: 'Exact dependency', detail: null });
const binding = value => ({ serviceId: value.serviceId, projectId: value.projectId, analysisId: value.analysisId,
  ownerUserId: value.ownerUserId, preparationId: value.preparationId, snapshotSha256: value.snapshotSha256 });
function reseal(value) {
  if (value.recipe) value.requestSha256 = hash(canonicalAnalysisSnapshotPreparation(value.recipe));
  if (value.package) value.snapshotSha256 = hash(canonicalSnapshotJson(value.package)); return value;
}
function tableDescriptor(changes = {}) {
  const value = linkedRecord(), result = value.package.results[0]; return { ...result, ...changes };
}

describe('linked snapshot private and public semantic bindings', () => {
  it('accepts exact v2 recipe/package/view hashes with original A outer envelope', async () => {
    const value = linkedRecord(); expect((await validateSnapshotPreparation(value, snapshotScope, value.recipe)).package).toEqual(value.package);
    expect(await validateSnapshotPackage(value.package, binding(value))).toEqual(value.package);
    expect(value.schema).toBe('traceomics.analysis-snapshot-preparation.v1');
  });
  it.each(['av', 'art', 'eri'])('accepts owned exact %s direct findings and table raw bytes', async prefix => {
    const recipe = linkedRecipe({ results: [{ ...linkedRecipe().results[0], reference: linkedReference({ versionId: prefix + '_' + '4'.repeat(24) }) }] });
    const value = linkedRecord(recipe); await expect(validateSnapshotPreparation(value, snapshotScope, recipe)).resolves.toMatchObject({ state: 'ready' });
    const result = value.package.results[0]; await expect(decodeSnapshotPreparationTable(linkedTableBytes(result), result)).resolves.toMatchObject({ rows: [['donor α', '3']] });
  });
  it('accepts v2 PNG with original bytes retained and unchanged fixed-source notebook contract', async () => {
    const value = linkedRecord(linkedRecipe({ results: [linkedImageResult()] }));
    const accepted = await validateSnapshotPreparation(value, snapshotScope, value.recipe);
    expect(accepted.package.results[0].view).toMatchObject({ family: 'image', spec: null, width: 1, height: 1 });
    expect(accepted.package.documents[0].blobSha256).toBe(accepted.recipe.documents[0].sha256);
  });
  it('accepts mixed attached/direct context with distinct source-owner and caption actor', async () => {
    const recipe = linkedRecipe({ results: [{ kind: 'attachment-revision', ...snapshotRecipe().results[0] }, linkedRecipe().results[0]] });
    const value = linkedRecord(recipe), accepted = await validateSnapshotPreparation(value, snapshotScope, recipe);
    expect(accepted.package.results[0].origin.attachment.createdByUserId).toBe(8);
    expect(accepted.package.results[0].source.ownerUserId).toBe(7);
    expect(accepted.package.results[1].origin.captionOrigin).toBe('user-supplied');
  });
  it('accepts two fixed excerpts of the same source with separate exact view identities', async () => {
    const first = linkedRecipe().results[0], recipe = linkedRecipe({ results: [first, { ...first, view: { ...first.view, offset: 25 } }] });
    const value = linkedRecord(recipe), accepted = await validateSnapshotPreparation(value, snapshotScope, recipe);
    expect(new Set(accepted.package.results.map(item => item.view.viewSha256)).size).toBe(2);
  });
  it.each(['opaque', 'unsupported-view', 'restricted-or-unavailable', 'not-included'])('accepts honest reference-only reason %s while checking original intent', async reason => {
    const recipe = linkedRecipe({ prerequisites: [prereq()] }), value = linkedRecord(recipe, { referenceReasons: [reason] });
    const accepted = await validateSnapshotPreparation(value, snapshotScope, recipe);
    expect(accepted.package.prerequisites.items[0]).toMatchObject({ reason, integrity: 'not-checked', dataAccess: 'not-granted', role: 'reference-only' });
  });
  it.each(['preparing', 'failed', 'deleted'])('keeps v2 %s recovery honest without a fabricated ready package', async state => {
    const recipe = linkedRecipe(), value = linkedRecord(recipe, { state });
    const accepted = await validateSnapshotPreparation(value, snapshotScope, recipe); expect(accepted.package).toBeNull();
    expect(accepted.recipe).toEqual(state === 'deleted' ? null : recipe);
  });
  it('accepts unavailable retained bytes without modifying immutable package SHA', async () => {
    const ready = linkedRecord(), unavailable = linkedRecord(ready.recipe, { unavailable: true });
    expect(unavailable.snapshotSha256).toBe(ready.snapshotSha256);
    expect((await validateSnapshotPreparation(unavailable, snapshotScope)).availability.status).toBe('unavailable');
  });
  it('accepts colleague viewer17 with publisher7 and owner-bound package7, without a private envelope', async () => {
    const prepared = linkedRecord(), value = publicationFull({ prepared });
    const accepted = await validateSnapshotPublication(value, publicationScope, publicationAnchor(value));
    expect(accepted.viewerUserId).toBe(17); expect(accepted.package.ownerUserId).toBe(7);
    const receipt = publicationReceipt({ current: publicationFull({ viewerUserId: 7, prepared }) });
    expect((await validateSnapshotPublicationReceipt(receipt, snapshotScope, receipt.request)).current.package.schema).toBe('traceomics.analysis-snapshot-package.v2');
  });
  it('keeps the v1 request and package valid through both exact validators', async () => {
    const value = snapshotRecord(snapshotRecipe()); await expect(validateSnapshotPreparation(value, snapshotScope, value.recipe)).resolves.toEqual(value);
    expect((await validateSnapshotPackage(value.package, binding(value))).schema).toBe('traceomics.analysis-snapshot-package.v1');
  });
  it.each([
    ['changed original caption', value => { value.package.results[0].origin.caption = 'Different claimed intent'; }],
    ['changed saved version', value => { value.package.analysis.version++; value.package.results[0].origin.analysisVersion++; }],
    ['changed source SHA', value => { value.package.results[0].source.sha256 = 'f'.repeat(64); value.package.results[0].origin.reference.sha256 = 'f'.repeat(64); }],
    ['changed excerpt', value => { value.package.results[0].view.spec.offset++; }],
    ['changed source owner', value => { value.package.results[0].source.ownerUserId = 17; }],
    ['old package discriminator', value => { value.package.schema = 'traceomics.analysis-snapshot-package.v1'; }],
    ['unknown package discriminator', value => { value.package.schema = 'traceomics.analysis-snapshot-package.v3'; }],
    ['old fixed discriminator', value => { value.package.results[0].view.schema = 'traceomics.fixed-result-view.v1'; }],
    ['unbound view SHA', value => { value.package.results[0].view.viewSha256 = 'f'.repeat(64); }],
    ['result metadata source path', value => { value.package.results[0].source.path = '/private/data'; }],
    ['promoted source grant', value => { value.package.prerequisites.items[0].dataAccess = 'granted'; }],
    ['promoted source integrity', value => { value.package.prerequisites.items[0].integrity = 'verified'; }],
    ['changed prerequisite identity', value => { value.package.prerequisites.items[0].reference.sha256 = 'f'.repeat(64); }],
    ['changed prerequisite label', value => { value.package.prerequisites.items[0].label = 'Unexpected label'; }],
  ])('rejects a freshly hashed package with %s', async (_label, change) => {
    const recipe = linkedRecipe({ prerequisites: [prereq()] }), value = linkedRecord(recipe); change(value); reseal(value);
    await expect(validateSnapshotPreparation(value, snapshotScope, recipe)).rejects.toMatchObject(error);
  });
  it('rejects wrong selected publication SHA and owner/viewer confusion for v2', async () => {
    const value = publicationFull({ prepared: linkedRecord() });
    await expect(validateSnapshotPublication(value, publicationScope, { ...publicationAnchor(value), snapshotSha256: 'f'.repeat(64) })).rejects.toMatchObject(publicationError);
    value.package.ownerUserId = 17; value.snapshotSha256 = hash(canonicalSnapshotJson(value.package));
    await expect(validateSnapshotPublication(value, publicationScope, publicationAnchor(value))).rejects.toMatchObject(publicationError);
  });
  it('captures response, original intent, and scope before asynchronous verification', async () => {
    const value = linkedRecord(), expected = copy(value.recipe), scope = { ...snapshotScope }; let release;
    const gate = new Promise(resolve => { release = resolve; });
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await gate; return webcrypto.subtle.digest(...args); });
    const pending = validateSnapshotPreparation(value, scope, expected);
    value.package.results[0].source.ownerUserId = 17; expected.results[0].caption = 'Late mutation'; scope.userId = 17;
    release(); try { expect((await pending).package.results[0].source.ownerUserId).toBe(7); } finally { digest.mockRestore(); }
  });
  it('rejects getter/prototype/cycle payloads without invoking custom code', async () => {
    const value = linkedRecord(), getter = vi.fn(() => 'private'); Object.defineProperty(value.package.results[0].source, 'name', { enumerable: true, get: getter });
    await expect(validateSnapshotPreparation(value, snapshotScope)).rejects.toMatchObject(error); expect(getter).not.toHaveBeenCalled();
    const foreign = linkedRecord(); Object.setPrototypeOf(foreign.package.results[0].origin, { permission: true });
    await expect(validateSnapshotPreparation(foreign, snapshotScope)).rejects.toMatchObject(error);
    const cycle = linkedRecord(); cycle.package.prerequisites = cycle.package;
    await expect(validateSnapshotPreparation(cycle, snapshotScope)).rejects.toMatchObject(error);
  });
});

describe('exact saved-version reference chooser validation', () => {
  it('accepts scoped version-bound metadata only, preserving reference order', () => {
    const first = linkedOptions().items[0], other = { ...first, reference: linkedReference({ versionId: 'eri_' + '5'.repeat(24) }) };
    const value = linkedOptions({ items: [first, other] }); expect(validateSnapshotPreparationOptions(value, snapshotScope, 'analysis-references', 2)).toEqual(value);
  });
  it.each(['opaque', 'unsupported-view', 'restricted-or-unavailable'])('accepts reference-only chooser reason %s without an existence assertion', reason => {
    const value = linkedOptions({ viewFamily: null, reason }); expect(validateSnapshotPreparationOptions(value, snapshotScope, 'analysis-references', 2).items[0].availability).toBe('not-checked');
  });
  it.each([
    ['wrong saved revision', value => { value.analysisVersion = 3; }],
    ['unexpected source owner', value => { value.items[0].sourceOwnerUserId = 7; }],
    ['source path disclosure', value => { value.items[0].source = { path: '/private' }; }],
    ['false integrity', value => { value.items[0].integrity = 'verified'; }],
    ['false availability', value => { value.items[0].availability = 'available'; }],
    ['unrecognized family', value => { value.items[0].viewFamily = 'text'; }],
    ['eligible reason mismatch', value => { value.items[0].referenceOnlyReason = 'opaque'; }],
    ['omitted null family reason', value => { value.items[0].viewFamily = null; }],
    ['client notincluded reason', value => { value.items[0].viewFamily = null; value.items[0].referenceOnlyReason = 'not-included'; }],
    ['duplicate identity', value => { value.items.push(copy(value.items[0])); }],
    ['hidden label controls', value => { value.items[0].label = 'Hidden\u200blabel'; }],
    ['overbound label', value => { value.items[0].label = 'a'.repeat(201); }],
  ])('rejects %s', (_label, change) => { const value = linkedOptions(); change(value); expect(() => validateSnapshotPreparationOptions(value, snapshotScope, 'analysis-references', 2)).toThrow(expect.objectContaining(error)); });
  it('requires a deliberate saved revision anchor and rejects stale service/scope', () => {
    const value = linkedOptions(); expect(() => validateSnapshotPreparationOptions(value, snapshotScope, 'analysis-references')).toThrow();
    expect(() => validateSnapshotPreparationOptions(value, { ...snapshotScope, serviceId: 'svc_' + '9'.repeat(32) }, 'analysis-references', 2)).toThrow();
    expect(() => validateSnapshotPreparationOptions(value, { ...snapshotScope, userId: 17 }, 'analysis-references', 2)).toThrow();
  });
});

describe('v2 retained table decoder', () => {
  it('uses native byte brands across realms without caller accessors or iteration', async () => {
    const result = tableDescriptor(), input = linkedTableBytes(result), foreign = runInNewContext('new Uint8Array(values)', { values: [...input] });
    Object.defineProperty(foreign, 'constructor', { get: () => { throw Error('constructor'); } });
    Object.defineProperty(foreign, 'byteLength', { get: () => { throw Error('length'); } });
    foreign[Symbol.iterator] = () => { throw Error('iteration'); };
    expect((await decodeSnapshotPreparationTable(foreign, result)).columns).toEqual(['sample', 'value']);
    await expect(decodeSnapshotPreparationTable(new DataView(input.buffer, input.byteOffset, input.byteLength), result)).rejects.toMatchObject(error);
  });
  it.each([
    ['source-owner zero', value => { value.source.ownerUserId = 0; }],
    ['source-owner omitted', value => { delete value.source.ownerUserId; }],
    ['source path', value => { value.source.name = '../counts.csv'; }],
    ['direct source mismatch', value => { value.origin.reference.sha256 = 'f'.repeat(64); }],
    ['unbound original context', value => { value.origin.analysisVersion = 0; }],
    ['caption control', value => { value.origin.caption = 'a\u200bb'; }],
    ['fabricated attachment', value => { value.attachment = {}; }],
    ['unknown view schema', value => { value.view.schema = 'traceomics.fixed-result-view.v3'; }],
    ['old view schema/new source', value => { value.view.schema = 'traceomics.fixed-result-view.v1'; }],
    ['view bounds changed', value => { value.view.spec.limit++; }],
    ['body checksum changed', value => { value.view.blobSha256 = 'f'.repeat(64); }],
  ])('rejects %s before rendering', async (_label, change) => { const value = tableDescriptor(), bytes = linkedTableBytes(value); change(value); await expect(decodeSnapshotPreparationTable(bytes, value)).rejects.toMatchObject(error); });
  it('binds attached source-owner context in v2 table descriptors', async () => {
    const value = linkedRecord(linkedRecipe({ results: [{ kind: 'attachment-revision', ...snapshotRecipe().results[0] }] })).package.results[0], bytes = linkedTableBytes(value);
    await expect(decodeSnapshotPreparationTable(bytes, value)).resolves.toMatchObject({ family: 'table' }); value.origin.attachment.sourceOwnerUserId = 8;
    await expect(decodeSnapshotPreparationTable(bytes, value)).rejects.toMatchObject(error);
  });
  it('retains exact original cell strings and rejects altered canonical body even with matching blob hash', async () => {
    const result = tableDescriptor(), body = { family: 'table', columns: ['sample'], rows: [['\tprivate?\n🧬']], offset: 0, limit: 25, hasMore: false, scannedRows: 1, truncated: false };
    const text = canonicalSnapshotJson(body), bytes = new TextEncoder().encode(text); result.view.blobSha256 = hash(text); result.view.blobBytes = bytes.length;
    await expect(decodeSnapshotPreparationTable(bytes, result)).resolves.toMatchObject({ rows: body.rows });
    const noncanonical = JSON.stringify(body), badBytes = new TextEncoder().encode(noncanonical); result.view.blobSha256 = hash(noncanonical); result.view.blobBytes = badBytes.length;
    await expect(decodeSnapshotPreparationTable(badBytes, result)).rejects.toMatchObject(error);
  });
  it('checks view digest against source identity separately from package digest', async () => {
    const value = linkedRecord(), item = value.package.results[0], { viewSha256, ...view } = item.view;
    expect(hash(canonicalAnalysisSnapshotResultView({ ...view, source: { artifactId: item.source.artifactId, versionId: item.source.versionId, projectId: value.projectId, sha256: item.source.sha256 } }))).toBe(viewSha256);
    item.view.viewSha256 = 'f'.repeat(64); reseal(value); await expect(validateSnapshotPackage(value.package, binding(value))).rejects.toMatchObject(error);
  });
});
