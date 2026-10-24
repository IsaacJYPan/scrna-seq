import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSnapshotJson, canonicalAnalysisSnapshotPreparation, canonicalAnalysisSnapshotResultView,
  canonicalAnalysisSnapshotTypedDescriptor } from '../../shared/analysisSnapshotPreparationDispatch.mjs';
import { validateSnapshotPreparation, validateSnapshotPreparationOptions, validateSnapshotPackage,
  decodeSnapshotPreparationTyped as decode, decodeSnapshotPreparationTable } from './snapshotPreparationValidation';
import { validateSnapshotPublication, validateSnapshotPublicationReceipt } from './snapshotPublicationValidation';
import { snapshotScope, snapshotRecipe, snapshotRecord } from './snapshotPreparationTestFixtures';
import { linkedRecipe, linkedRecord } from './snapshotLinkedTestFixtures';
import { typedRecipe, typedRecord, typedOptions, typedTableBytes, typedTable, typedMetricsBytes, typedMetrics } from './snapshotTypedTestFixtures';
import { publicationScope, publicationFull, publicationAnchor, publicationReceipt } from './snapshotPublicationTestFixtures';

const hash = value => createHash('sha256').update(value).digest('hex'), copy = value => structuredClone(value);
const error = { code: 'INVALID_SNAPSHOT_PREPARATION_RESPONSE' }, pubError = { code: 'INVALID_SNAPSHOT_PUBLICATION_RESPONSE' };
const binding = value => ({ serviceId: value.serviceId, projectId: value.projectId, analysisId: value.analysisId,
  ownerUserId: value.ownerUserId, preparationId: value.preparationId, snapshotSha256: value.snapshotSha256 });
function reseal(value) {
  if (value.recipe) value.requestSha256 = hash(canonicalAnalysisSnapshotPreparation(value.recipe));
  if (value.package) value.snapshotSha256 = hash(canonicalSnapshotJson(value.package)); return value;
}
function bodySeal(result, body) {
  const text = canonicalSnapshotJson(body), bytes = new TextEncoder().encode(text); result.view.blobSha256 = hash(text); result.view.blobBytes = bytes.length;
  const { viewSha256: _sha, ...view } = result.view; void _sha;
  result.view.viewSha256 = hash(canonicalAnalysisSnapshotResultView({ ...view, source: body.source })); return bytes;
}

describe('strict retained typed preparation and publication bindings', () => {
  it.each(['table', 'metrics', 'image'])('accepts actual exact %s recipe/package/view with original A envelope', async family => {
    const value = typedRecord(typedRecipe({ family }));
    expect(await validateSnapshotPreparation(value, snapshotScope, value.recipe)).toEqual(value);
    expect(await validateSnapshotPackage(value.package, binding(value))).toEqual(value.package);
  });
  it.each(['table', 'metrics'])('decodes checked real %s bytes and declared meaning', async family => {
    const value = typedRecord(typedRecipe({ family })), result = value.package.results[0], bytes = family === 'table' ? typedTableBytes(result) : typedMetricsBytes(result);
    expect((await decode(bytes, result)).family).toBe(family);
    if (family === 'table') expect((await decodeSnapshotPreparationTable(bytes, result)).rows[0]).toEqual([null, false, true, 0, '', 1.25, 'null', 'donor 🧬']);
  });
  it('accepts independent viewer/publisher/actor identities with typed package neutral binding', async () => {
    const prepared = typedRecord(typedRecipe({ family: 'metrics' })), value = publicationFull({ prepared });
    const accepted = await validateSnapshotPublication(value, publicationScope, publicationAnchor(value));
    expect(accepted.viewerUserId).toBe(17); expect(accepted.package.ownerUserId).toBe(7);
    const receipt = publicationReceipt({ current: publicationFull({ prepared, viewerUserId: 7 }) });
    expect((await validateSnapshotPublicationReceipt(receipt, snapshotScope, receipt.request)).current.package.results[0].view.family).toBe('metrics');
    await expect(validateSnapshotPublication(value, publicationScope, { ...publicationAnchor(value), snapshotSha256: 'f'.repeat(64) })).rejects.toMatchObject(pubError);
  });
  it('preserves old v1/C1 private and public full validation unchanged', async () => {
    for (const value of [snapshotRecord(snapshotRecipe()), linkedRecord(linkedRecipe())]) {
      expect(await validateSnapshotPreparation(value, snapshotScope, value.recipe)).toEqual(value);
      const pub = publicationFull({ prepared: value }); expect(await validateSnapshotPublication(pub, publicationScope, publicationAnchor(pub))).toEqual(pub);
    }
  });
  it.each(['preparing', 'failed', 'deleted'])('keeps typed original UUID recovery in %s state', async state => {
    const recipe = typedRecipe(), value = typedRecord(recipe, { state }); expect((await validateSnapshotPreparation(value, snapshotScope, recipe)).state).toBe(state);
    expect(value.package).toBeNull();
  });
  it('accepts current unavailability without changing package or descriptor SHA', async () => {
    const ready = typedRecord(), value = typedRecord(ready.recipe, { unavailable: true }); expect(value.snapshotSha256).toBe(ready.snapshotSha256);
    expect((await validateSnapshotPreparation(value, snapshotScope)).availability.status).toBe('unavailable');
  });
  it.each([
    ['changed descriptor intent', value => { value.package.results[0].view.descriptorSha256 = 'f'.repeat(64); }],
    ['changed supplied caption', value => { value.package.results[0].origin.caption = 'Changed intent'; }],
    ['changed saved N', value => { value.package.analysis.version++; value.package.results[0].origin.analysisVersion++; }],
    ['source-owner confusion', value => { value.package.results[0].source.ownerUserId = 17; }],
    ['old fixed schema', value => { value.package.results[0].view.schema = 'traceomics.fixed-result-view.v2'; }],
    ['future fixed schema', value => { value.package.results[0].view.schema = 'traceomics.fixed-result-view.v4'; }],
    ['unbound view meaning', value => { value.package.results[0].view.semantics.title = 'Changed meaning'; }],
    ['missing meaning', value => { delete value.package.results[0].view.semantics; }],
    ['flattened typed origin', value => { value.package.results[0].origin.kind = 'analysis-reference'; }],
    ['unrecognized source metadata', value => { value.package.results[0].source.storageKey = '/private'; }],
    ['private descriptor metadata', value => { value.package.results[0].view.descriptor = { path: '/private' }; }],
  ])('rejects freshly package-hashed %s', async (_name, change) => { const value = typedRecord(); change(value); reseal(value); await expect(validateSnapshotPreparation(value, snapshotScope, value.recipe)).rejects.toMatchObject(error); });
});

describe('typed options independently hash the exact declared descriptor', () => {
  it.each(['table', 'metrics', 'image'])('accepts selected-N %s typed metadata with checked descriptor SHA', async family => {
    const value = typedOptions({ family }); expect(await validateSnapshotPreparationOptions(value, snapshotScope, 'analysis-typed-references', 2)).toEqual(value);
    expect(value.items[0].descriptorSha256).toBe(hash(canonicalAnalysisSnapshotTypedDescriptor(value.items[0].descriptor)));
  });
  it.each([
    ['changed descriptor hash', value => { value.items[0].descriptorSha256 = 'f'.repeat(64); }],
    ['meaning change under original SHA', value => { value.items[0].descriptor.semantics.title = 'Other title'; }],
    ['profile change under original SHA', value => { value.items[0].descriptor.profileId = null; }],
    ['reference/source mismatch', value => { value.items[0].reference.sha256 = 'f'.repeat(64); }],
    ['wrong saved revision', value => { value.analysisVersion++; }],
    ['null eligibility', value => { value.items[0].viewFamily = null; }],
    ['family mismatch', value => { value.items[0].viewFamily = 'image'; }],
    ['unrecognized semantics', value => { value.items[0].descriptor.semantics.path = '/private'; }],
    ['unnormalized semantics', value => { value.items[0].descriptor.semantics = {}; }],
    ['extra field', value => { value.items[0].source = { path: '/private' }; }],
    ['false integrity', value => { value.items[0].integrity = 'verified'; }],
    ['false availability', value => { value.items[0].availability = 'available'; }],
    ['duplicate identity', value => { value.items.push(copy(value.items[0])); }],
  ])('rejects %s', async (_name, change) => { const value = typedOptions(); change(value); await expect(async () => validateSnapshotPreparationOptions(value, snapshotScope, 'analysis-typed-references', 2)).rejects.toMatchObject(error); });
  it('requires exact selected version and current discovery scope', async () => {
    const value = typedOptions(); await expect(async () => validateSnapshotPreparationOptions(value, snapshotScope, 'analysis-typed-references')).rejects.toMatchObject(error);
    await expect(async () => validateSnapshotPreparationOptions(value, { ...snapshotScope, userId: 17 }, 'analysis-typed-references', 2)).rejects.toMatchObject(error);
  });
  it('captures options/scope before independent async descriptor hash verification', async () => {
    const value = typedOptions(), scope = { ...snapshotScope }; let release; const gate = new Promise(resolve => { release = resolve; });
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await gate; return webcrypto.subtle.digest(...args); });
    const pending = validateSnapshotPreparationOptions(value, scope, 'analysis-typed-references', 2); value.items[0].descriptor.semantics.title = 'Late change'; scope.userId = 17;
    release(); try { expect((await pending).ownerUserId).toBe(7); } finally { digest.mockRestore(); }
  });
  it('does not invoke getter code in descriptor or schema while rejecting it', async () => {
    const value = typedOptions(), getter = vi.fn(() => 'private'); Object.defineProperty(value.items[0].descriptor, 'profileId', { enumerable: true, get: getter });
    await expect(async () => validateSnapshotPreparationOptions(value, snapshotScope, 'analysis-typed-references', 2)).rejects.toMatchObject(error); expect(getter).not.toHaveBeenCalled();
  });
});

describe('strict typed raw body interpretation', () => {
  it('accepts cross-realm Uint8Array through native accessors without caller iteration', async () => {
    const result = typedRecord().package.results[0], input = typedTableBytes(result), foreign = runInNewContext('new Uint8Array(values)', { values: Array.from(input) });
    Object.defineProperty(foreign, 'constructor', { get: () => { throw Error('constructor'); } }); foreign[Symbol.iterator] = () => { throw Error('iterator'); };
    expect((await decode(foreign, result)).rows[0][1]).toBe(false);
    await expect(decode(new DataView(input.buffer, input.byteOffset, input.byteLength), result)).rejects.toMatchObject(error);
  });
  it.each([
    ['changed source scope', body => { body.source.projectId = 'proj_' + '9'.repeat(16); }],
    ['changed source identity', body => { body.source.sha256 = 'f'.repeat(64); }],
    ['extra body field', body => { body.path = '/private'; }],
    ['wrong scalar model', body => { body.scalarModel = 'arbitrary'; }],
    ['extra included row', body => { body.rows.push(copy(body.rows[0])); }],
    ['claimed total row mismatch', body => { body.totalRows = 2; }],
    ['false hasMore', body => { body.hasMore = true; }],
    ['false truncation', body => { body.truncated = true; }],
    ['nested value', body => { body.rows[0][0] = { nested: 1 }; }],
    ['too long cell', body => { body.rows[0][0] = 'a'.repeat(2001); }],
    ['wrong row shape', body => { body.rows[0].pop(); }],
    ['duplicate columns', body => { body.columns[1] = body.columns[0]; }],
    ['changed body meaning', body => { body.semantics.title = 'Other title'; }],
  ])('rejects resealed table body %s', async (_name, change) => {
    const result = typedRecord().package.results[0], body = typedTable(result); change(body);
    const bytes = bodySeal(result, body);
    // A wrong project cannot be made valid by recomputing a body blob alone;
    // restore the original scoped view anchor for this adversarial response.
    if (_name === 'changed source scope') result.view.viewSha256 = typedRecord().package.results[0].view.viewSha256;
    await expect(decode(bytes, result)).rejects.toMatchObject(error);
  });
  it.each([
    ['unit override', body => { body.items[0].unit = 'invented'; }], ['label override', body => { body.items[0].label = 'invented'; }],
    ['source override', body => { body.source.versionId = 'eri_' + '9'.repeat(24); }], ['unknown key', body => { body.items[0].key = 'invented'; }],
    ['missing declared metric', body => { body.items.shift(); }], ['duplicate key', body => { body.items.push(copy(body.items[0])); }],
    ['nested metric', body => { body.items[0].value = {}; }], ['role override', body => { body.semantics.role = 'primary'; }],
  ])('rejects resealed metrics %s', async (_name, change) => {
    const result = typedRecord(typedRecipe({ family: 'metrics' })).package.results[0], body = typedMetrics(result); change(body);
    await expect(decode(bodySeal(result, body), result)).rejects.toMatchObject(error);
  });
  it('checks raw checksum and canonical bytes separately from metadata', async () => {
    const result = typedRecord().package.results[0], bytes = typedTableBytes(result), bad = new Uint8Array(bytes); bad[0] = 32;
    await expect(decode(bad, result)).rejects.toMatchObject(error);
    const text = JSON.stringify(typedTable(result)), noncanonical = new TextEncoder().encode(text); result.view.blobSha256 = hash(text); result.view.blobBytes = noncanonical.length;
    await expect(decode(noncanonical, result)).rejects.toMatchObject(error);
  });
  it('captures descriptor/bytes before an asynchronous hash race', async () => {
    const result = typedRecord().package.results[0], bytes = typedTableBytes(result); let release; const gate = new Promise(resolve => { release = resolve; });
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await gate; return webcrypto.subtle.digest(...args); });
    const pending = decode(bytes, result); result.origin.caption = 'Late changed'; result.view.semantics.title = 'Late changed'; bytes.fill(32);
    release(); try { expect((await pending).semantics.title).toBe('Recorded scalar table'); } finally { digest.mockRestore(); }
  });
  it('checks caller descriptor source owner and exact typed tag before rendering', async () => {
    const result = typedRecord().package.results[0], bytes = typedTableBytes(result); result.source.ownerUserId = 0;
    await expect(decode(bytes, result)).rejects.toMatchObject(error);
    const wrong = typedRecord().package.results[0]; wrong.origin.kind = 'analysis-reference'; await expect(decode(typedTableBytes(wrong), wrong)).rejects.toMatchObject(error);
  });
  it('rejects image bytes and metrics through the table-only decoder entry point', async () => {
    const result = typedRecord(typedRecipe({ family: 'metrics' })).package.results[0];
    await expect(decodeSnapshotPreparationTable(typedMetricsBytes(result), result)).rejects.toMatchObject(error);
    const image = typedRecord(typedRecipe({ family: 'image' })).package.results[0]; await expect(decode(new Uint8Array(), image)).rejects.toMatchObject(error);
  });
});
