import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSnapshotJson, canonicalAnalysisSnapshotResultView } from '../../shared/analysisSnapshotPreparationDispatch.mjs';
import { validateSnapshotPreparation, validateSnapshotPreparationOptions, validateSnapshotPackage, decodeSnapshotPreparationTyped as decode } from './snapshotPreparationValidation';
import { validateSnapshotPublication, validateSnapshotPublicationReceipt } from './snapshotPublicationValidation';
import { embeddingValue, embeddingDescriptor, embeddingRecipe, embeddingRecord, embeddingBody, embeddingBytes, embeddingOptions } from './snapshotEmbeddingTestFixtures';
import { snapshotScope } from './snapshotPreparationTestFixtures';
import { snapshotRecipe } from './snapshotPreparationTestFixtures';
import { linkedRecipe } from './snapshotLinkedTestFixtures';
import { typedRecipe, typedDescriptor } from './snapshotTypedTestFixtures';
import { workflowSelection, workflowSnapshotReference } from './snapshotWorkflowTestFixtures';
import { publicationFull, publicationScope, publicationAnchor, publicationReceipt } from './snapshotPublicationTestFixtures';

const hash = value => createHash('sha256').update(value).digest('hex'), error = { code: 'INVALID_SNAPSHOT_PREPARATION_RESPONSE' };
const binding = value => ({ serviceId: value.serviceId, projectId: value.projectId, analysisId: value.analysisId, ownerUserId: value.ownerUserId, preparationId: value.preparationId, snapshotSha256: value.snapshotSha256 });
function bodySeal(result, body) {
  const text = canonicalSnapshotJson(body), bytes = new TextEncoder().encode(text); result.view.blobSha256 = hash(text); result.view.blobBytes = bytes.length;
  const { viewSha256: _hash, ...view } = result.view; void _hash;
  result.view.viewSha256 = hash(canonicalAnalysisSnapshotResultView({ ...view, source: body.source })); return bytes;
}
function rehash(record) { record.snapshotSha256 = hash(canonicalSnapshotJson(record.package)); return record; }

describe('strict fixed embedding intent and exact retained bytes', () => {
  it.each([false, true])('accepts actual fixed embedding with captured=%s and independently checks every identity', async captured => {
    const value = embeddingRecord(embeddingRecipe({ captured, selection: workflowSelection({ seed: true }) })), result = value.package.results[0];
    expect(await validateSnapshotPreparation(value, snapshotScope, value.recipe)).toEqual(value);
    expect(await validateSnapshotPackage(value.package, binding(value))).toEqual(value.package);
    const body = await decode(embeddingBytes(result), result);
    expect(body.sampling).toMatchObject({ sourceCount: 12, returnedCount: 5, requestedLimit: 5, method: 'sha256-priority-v1', stratified: false, aggregated: false });
    body.sourceIndices.forEach((sourceIndex, at) => { expect(body.ids[at]).toBe(embeddingValue().ids[sourceIndex]); expect(body.x[at]).toBe(embeddingValue().x[sourceIndex]); });
  });
  it('allows a colleague17 and separate actor to inspect publisher7 exact points without source authority', async () => {
    const prepared = embeddingRecord(embeddingRecipe({ captured: true })), full = publicationFull({ prepared });
    expect((await validateSnapshotPublication(full, publicationScope, publicationAnchor(full))).package.ownerUserId).toBe(7);
    const receipt = publicationReceipt({ current: publicationFull({ prepared, viewerUserId: 7 }) });
    expect((await validateSnapshotPublicationReceipt(receipt, snapshotScope, receipt.request)).current.package.results[0].view.spec.pointLimit).toBe(5);
  });
  it('validates mixed flat/table/metrics/semantic image/direct and captured embedding views through the same public package', async () => {
    const outside = { kind: 'attachment-revision', ...snapshotRecipe().results[0] }, flat = linkedRecipe().results[0], table = typedRecipe().results[0];
    const metrics = typedRecipe({ family: 'metrics', descriptor: typedDescriptor({ type: 'metrics', id: 'eri_' + '9'.repeat(24) }) }).results[0];
    const image = typedRecipe({ family: 'image', descriptor: typedDescriptor({ type: 'figure', id: 'eri_' + '5'.repeat(24) }) }).results[0];
    const direct = embeddingRecipe().results[0], captured = embeddingRecipe({ captured: true, pointLimit: 7, selection: workflowSelection({ seed: true }) }).results[0];
    const recipe = embeddingRecipe({ results: [outside, flat, table, metrics, image, direct, captured] }), value = embeddingRecord(recipe);
    expect((await validateSnapshotPreparation(value, snapshotScope, recipe)).package.results.map(item => item.view.family)).toEqual(['table', 'table', 'table', 'metrics', 'image', 'embedding', 'embedding']);
    const pub = publicationFull({ prepared: value }); expect((await validateSnapshotPublication(pub, publicationScope, publicationAnchor(pub))).package.results).toHaveLength(7);
    expect((await decode(embeddingBytes(value.package.results[6]), value.package.results[6])).sampling.requestedLimit).toBe(7);
  });
  it.each(['preparing', 'failed', 'deleted'])('retains original point bound through %s recovery without inventing bytes', async state => {
    const recipe = embeddingRecipe({ captured: true }), value = embeddingRecord(recipe, { state });
    expect((await validateSnapshotPreparation(value, snapshotScope, recipe)).state).toBe(state); expect(value.package).toBeNull();
  });
  it('keeps current unavailable overlay independent of the immutable embedding acceptance', async () => {
    const ready = embeddingRecord(), unavailable = embeddingRecord(ready.recipe, { unavailable: true });
    expect(unavailable.snapshotSha256).toBe(ready.snapshotSha256); expect((await validateSnapshotPreparation(unavailable, snapshotScope)).availability.status).toBe('unavailable');
  });
  it('rejects package-rehashed changed point bounds even when the fixed view hash was also recomputed', async () => {
    const value = embeddingRecord(), result = value.package.results[0], body = embeddingBody(result); result.view.spec.pointLimit = 7;
    body.sampling.requestedLimit = 7; body.sampling.budgetLimited = true; bodySeal(result, body); rehash(value);
    await expect(validateSnapshotPreparation(value, snapshotScope, value.recipe)).rejects.toMatchObject(error);
  });
  it.each([
    ['source owner', value => { value.package.results[0].source.ownerUserId = 17; }],
    ['descriptor identity', value => { value.package.results[0].view.descriptorSha256 = 'f'.repeat(64); }],
    ['captured identity', value => { value.package.results[0].origin.snapshotReference.sha256 = 'f'.repeat(64); }],
    ['captured context', value => { value.package.results[0].origin.contextSha256 = 'f'.repeat(64); }],
    ['invented source metadata', value => { value.package.results[0].source.filePath = '/private'; }],
    ['different family', value => { value.package.results[0].view.family = 'metrics'; }],
  ])('rejects package-rehashed %s', async (_label, change) => {
    const value = embeddingRecord(embeddingRecipe({ captured: true })); change(value); rehash(value); await expect(validateSnapshotPreparation(value, snapshotScope, value.recipe)).rejects.toMatchObject(error);
  });
  it('accepts cross-realm exact byte arrays without trusting constructor or custom iteration', async () => {
    const result = embeddingRecord().package.results[0], bytes = embeddingBytes(result), foreign = runInNewContext('new Uint8Array(values)', { values: Array.from(bytes) });
    Object.defineProperty(foreign, 'constructor', { get() { throw Error('constructor'); } }); foreign[Symbol.iterator] = () => { throw Error('iterator'); };
    expect((await decode(foreign, result)).family).toBe('embedding'); await expect(decode(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result)).rejects.toMatchObject(error);
  });
  it('captures original descriptor and bytes before awaited digest work', async () => {
    const result = embeddingRecord().package.results[0], bytes = new Uint8Array(embeddingBytes(result)); let release;
    const held = new Promise(resolve => { release = resolve; });
    const spy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await held; return webcrypto.subtle.digest(...args); });
    const pending = decode(bytes, result); result.view.spec.pointLimit = 9; bytes.fill(0); release();
    try { expect((await pending).sampling.requestedLimit).toBe(5); } finally { spy.mockRestore(); }
  });
  it('captures original point bound, private scope and request before asynchronous package checking', async () => {
    const value = embeddingRecord(embeddingRecipe({ captured: true })), expected = structuredClone(value.recipe), scope = { ...snapshotScope }; let release;
    const held = new Promise(resolve => { release = resolve; });
    const spy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await held; return webcrypto.subtle.digest(...args); });
    const pending = validateSnapshotPreparation(value, scope, expected); value.package.results[0].view.spec.pointLimit = 9; expected.results[0].view.pointLimit = 8; scope.userId = 17; release();
    try { expect((await pending).package.results[0].view.spec.pointLimit).toBe(5); } finally { spy.mockRestore(); }
  });
});

describe('strict embedding options and fixed sampling facts', () => {
  it.each([false, true])('accepts descriptor-checked options with captured=%s', async captured => {
    const value = embeddingOptions({ captured });
    expect(await validateSnapshotPreparationOptions(value, snapshotScope, value.kind, 2, captured ? workflowSnapshotReference() : undefined)).toEqual(value);
  });
  it('captures private descriptor, capture anchor and scope before its asynchronous digest', async () => {
    const value = embeddingOptions({ captured: true }), expected = workflowSnapshotReference(), scope = { ...snapshotScope }; let release;
    const held = new Promise(resolve => { release = resolve; });
    const spy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await held; return webcrypto.subtle.digest(...args); });
    const pending = validateSnapshotPreparationOptions(value, scope, value.kind, 2, expected); value.items[0].descriptor.semantics.axes.x.unit = 'changed'; scope.userId = 17; expected.sha256 = 'f'.repeat(64); release();
    try { expect((await pending).items[0].descriptor.semantics.axes.x.unit).toBeNull(); } finally { spy.mockRestore(); }
  });
  it.each([
    ['descriptor meaning', value => { value.items[0].descriptor.semantics.axes.x.unit = 'µm'; }],
    ['descriptor hash', value => { value.items[0].descriptorSha256 = 'f'.repeat(64); }],
    ['source identity', value => { value.items[0].reference.sha256 = 'f'.repeat(64); }],
    ['source type', value => { value.items[0].descriptor.type = 'metrics'; }],
    ['claimed availability', value => { value.items[0].availability = 'available'; }],
    ['changed family', value => { value.items[0].viewFamily = 'image'; }],
    ['wrong N', value => { value.analysisVersion++; }],
  ])('rejects private options %s', async (_label, change) => {
    const value = embeddingOptions(); change(value); await expect(async () => validateSnapshotPreparationOptions(value, snapshotScope, value.kind, 2)).rejects.toMatchObject(error);
  });
  it.each([
    ['invented body', body => { body.script = 'private'; }], ['wrong family', body => { body.family = 'scatter'; }],
    ['different meaning', body => { body.semantics.entityType = 'sample'; }], ['invented axis', body => { body.semantics.axes.x.unit = 'µm'; }],
    ['extra point', body => { body.x.push(1); }], ['mismatched y', body => { body.y.pop(); }],
    ['non-numeric coordinate', body => { body.x[0] = null; }], ['duplicate ids', body => { body.ids[1] = body.ids[0]; }],
    ['empty id', body => { body.ids[0] = ''; }], ['long id', body => { body.ids[0] = 'i'.repeat(201); }],
    ['id controls', body => { body.ids[0] = 'a\nb'; }], ['invented identity', body => { body.identity.kind = 'cells'; }],
    ['nonzero index base', body => { body.identity.indexBase = 1; }], ['unscoped identity', body => { body.identity.scope = 'all-data'; }],
    ['duplicate positions', body => { body.sourceIndices[1] = body.sourceIndices[0]; }], ['out-of-source position', body => { body.sourceIndices[0] = 12; }],
    ['missing position', body => { body.sourceIndices.pop(); }], ['group mismatch', body => { body.groups.pop(); }],
    ['null groups', body => { body.groups = null; }], ['long group', body => { body.groups[0] = 'g'.repeat(101); }],
    ['wrong returned count', body => { body.sampling.returnedCount++; }], ['wrong requested bound', body => { body.sampling.requestedLimit++; }],
    ['incorrect sample fact', body => { body.sampling.sampled = false; }], ['incorrect method', body => { body.sampling.method = 'random'; }],
    ['stratification claim', body => { body.sampling.stratified = true; }], ['aggregation claim', body => { body.sampling.aggregated = true; }],
    ['false budget fact', body => { body.sampling.budgetLimited = true; }], ['unbounded source count', body => { body.sampling.sourceCount = 100001; }],
    ['new sampling field', body => { body.sampling.seed = 1; }],
  ])('rejects resealed retained body %s', async (_label, change) => {
    const result = embeddingRecord().package.results[0], body = embeddingBody(result); change(body); const bytes = bodySeal(result, body);
    await expect(decode(bytes, result)).rejects.toMatchObject(error);
  });
  it.each([{ count: 0, ids: false, groups: false }, { count: 3, ids: false, groups: false }, { count: 3, ids: true, groups: true }])('decodes honest complete/empty/legacy row-position source %j', async settings => {
    const value = embeddingValue(settings), descriptor = embeddingDescriptor({ value, semantics: {} }), result = embeddingRecord(embeddingRecipe({ value, descriptor }), { values: [value], descriptors: [descriptor] }).package.results[0];
    const body = await decode(embeddingBytes(result, value), result); expect(body.sourceIndices).toEqual(Array.from({ length: settings.count }, (_, i) => i));
    expect(body.identity.kind).toBe(settings.ids ? 'source-identifiers' : 'source-row-positions'); expect(body.semantics.entityType).toBeNull();
    expect(body.sampling).toMatchObject({ method: 'none', sampled: false, budgetLimited: false });
  });
  it('rejects reordered complete views and invented zero-point samples from nonempty sources', async () => {
    const value = embeddingValue({ count: 3 }), descriptor = embeddingDescriptor({ value }), result = embeddingRecord(embeddingRecipe({ value, descriptor }), { values: [value], descriptors: [descriptor] }).package.results[0];
    const body = embeddingBody(result, value); body.sourceIndices.reverse(); await expect(decode(bodySeal(result, body), result)).rejects.toMatchObject(error);
    const sampled = embeddingRecord().package.results[0], bad = embeddingBody(sampled);
    bad.x = []; bad.y = []; bad.ids = []; bad.groups = []; bad.sourceIndices = []; bad.sampling.returnedCount = 0; bad.sampling.budgetLimited = true;
    await expect(decode(bodySeal(sampled, bad), sampled)).rejects.toMatchObject(error);
  });
  it('retains a truthful deterministic byte-limited subset without silently increasing requested count', async () => {
    const value = embeddingValue({ count: 2000 }); value.ids = value.ids.map(id => id + 'i'.repeat(175)); value.groups = value.groups.map(group => group + 'g'.repeat(80));
    const descriptor = embeddingDescriptor({ value }), result = embeddingRecord(embeddingRecipe({ value, descriptor, pointLimit: 5000 }), { values: [value], descriptors: [descriptor] }).package.results[0];
    const bytes = embeddingBytes(result, value), body = await decode(bytes, result);
    expect(bytes.length).toBeLessThanOrEqual(262144); expect(body.sampling.budgetLimited).toBe(true); expect(body.sampling.returnedCount).toBeGreaterThan(0); expect(body.sampling.returnedCount).toBeLessThan(2000);
    expect(body.sampling.requestedLimit).toBe(5000); expect(body.sampling.stratified).toBe(false);
    expect(embeddingBytes(result, value)).toEqual(bytes);
  });
  it.each([
    ['duplicate JSON key', text => text.replace('"family":"embedding"', '"family":"embedding","family":"embedding"')],
    ['wire negative zero', text => text.replace(/"x":\[[^,\]]+/, '"x":[-0')],
    ['unsafe integral token', text => text.replace(/"x":\[[^,\]]+/, '"x":[9007199254740993')],
    ['nonzero underflow', text => text.replace(/"x":\[[^,\]]+/, '"x":[1e-999')],
    ['unpaired Unicode', text => text.replace('"ids":[', '"ids":["\\ud800",')],
  ])('rejects checksum-resealed %s before trusting retained facts', async (_label, change) => {
    const result = embeddingRecord().package.results[0], body = embeddingBody(result), text = change(canonicalSnapshotJson(body));
    const bytes = new TextEncoder().encode(text); result.view.blobBytes = bytes.length; result.view.blobSha256 = hash(bytes);
    const { viewSha256: _sha, ...view } = result.view; void _sha;
    result.view.viewSha256 = hash(canonicalAnalysisSnapshotResultView({ ...view, source: body.source }));
    await expect(decode(bytes, result)).rejects.toMatchObject(error);
  });
  it('rejects malformed UTF8 and closed descriptor accessors without invocation', async () => {
    const result = embeddingRecord().package.results[0], bytes = new Uint8Array([0xff]); result.view.blobBytes = 1; result.view.blobSha256 = hash(bytes);
    await expect(decode(bytes, result)).rejects.toMatchObject(error);
    const positive = embeddingRecord().package.results[0], getter = vi.fn(() => 5); Object.defineProperty(positive.view.spec, 'pointLimit', { enumerable: true, get: getter });
    await expect(decode(embeddingBytes(embeddingRecord().package.results[0]), positive)).rejects.toMatchObject(error); expect(getter).not.toHaveBeenCalled();
  });
});
