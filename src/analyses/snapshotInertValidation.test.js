import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSnapshotJson, canonicalAnalysisSnapshotResultView } from '../../shared/analysisSnapshotPreparationDispatch.mjs';
import { validateSnapshotPreparation, validateSnapshotPreparationOptions, validateSnapshotPackage, decodeSnapshotPreparationInert as decode } from './snapshotPreparationValidation';
import { validateSnapshotPublication, validateSnapshotPublicationReceipt } from './snapshotPublicationValidation';
import { inertValue, inertRecipe, inertRecord, inertBody, inertBytes, inertOptions } from './snapshotInertTestFixtures';
import { snapshotScope } from './snapshotPreparationTestFixtures';
import { snapshotRecipe } from './snapshotPreparationTestFixtures';
import { linkedImageResult } from './snapshotLinkedTestFixtures';
import { typedRecipe, typedDescriptor } from './snapshotTypedTestFixtures';
import { workflowRecipe } from './snapshotWorkflowTestFixtures';
import { embeddingRecipe } from './snapshotEmbeddingTestFixtures';
import { publicationFull, publicationScope, publicationAnchor, publicationReceipt } from './snapshotPublicationTestFixtures';

const hash = value => createHash('sha256').update(value).digest('hex'), error = { code: 'INVALID_SNAPSHOT_PREPARATION_RESPONSE' };
const binding = value => ({ serviceId: value.serviceId, projectId: value.projectId, analysisId: value.analysisId, ownerUserId: value.ownerUserId, preparationId: value.preparationId, snapshotSha256: value.snapshotSha256 });
function bodySeal(result, body) {
  return rawSeal(result, canonicalSnapshotJson(body), body.source);
}
function rawSeal(result, text, source) {
  const bytes = new TextEncoder().encode(text); result.view.blobSha256 = hash(bytes); result.view.blobBytes = bytes.length;
  const { viewSha256: _hash, ...view } = result.view; void _hash;
  result.view.viewSha256 = hash(canonicalAnalysisSnapshotResultView({ ...view, source })); return bytes;
}
function reseal(value) { value.snapshotSha256 = hash(canonicalSnapshotJson(value.package)); return value; }

describe('strict literal source-prefix acceptance without broad source permissions', () => {
  it.each(['org.ietf.text', 'org.ietf.json'])('accepts exact %s with explicit consent and literal source text', async formatId => {
    const text = inertValue(formatId), recipe = inertRecipe({ formatId, text }), value = inertRecord(recipe, { formats: [formatId], values: [text] });
    expect(await validateSnapshotPreparation(value, snapshotScope, recipe)).toEqual(value); expect(await validateSnapshotPackage(value.package, binding(value))).toEqual(value.package);
    const result = value.package.results[0], body = await decode(inertBytes(result, text), result); expect(body.text).toBe(text); expect(body.syntax).toBe('not-checked');
  });
  it('keeps publisher7, colleague17 and the original accepted action distinct', async () => {
    const prepared = inertRecord(), current = publicationFull({ prepared }), value = await validateSnapshotPublication(current, publicationScope, publicationAnchor(current));
    expect(value.viewerUserId).toBe(17); expect(value.package.ownerUserId).toBe(7);
    const receipt = publicationReceipt({ current: publicationFull({ prepared, viewerUserId: 7 }) });
    expect((await validateSnapshotPublicationReceipt(receipt, snapshotScope, receipt.request)).current.package.results[0].origin.includeSourceText).toBe(true);
  });
  it('accepts all8 mixed supported findings plus lazy source through the unchanged private and colleague package', async () => {
    const txt = inertRecipe({ versionId: 'eri_' + 'a'.repeat(24) }).results[0], json = inertRecipe({ formatId: 'org.ietf.json', versionId: 'eri_' + 'b'.repeat(24) }).results[0];
    const outside = { kind: 'attachment-revision', ...snapshotRecipe().results[0] }, image = linkedImageResult();
    const metrics = typedRecipe({ family: 'metrics', descriptor: typedDescriptor({ type: 'metrics', id: 'eri_' + '9'.repeat(24) }) }).results[0];
    const table = workflowRecipe({ port: 'table' }).results[0], direct = embeddingRecipe().results[0], captured = embeddingRecipe({ captured: true, port: 'points', pointLimit: 7 }).results[0];
    const recipe = inertRecipe({ results: [outside, image, metrics, table, direct, captured, txt, json] }), values = [], formats = [];
    values[6] = inertValue(); values[7] = inertValue('org.ietf.json'); formats[6] = 'org.ietf.text'; formats[7] = 'org.ietf.json';
    const value = inertRecord(recipe, { values, formats }); expect((await validateSnapshotPreparation(value, snapshotScope, recipe)).package.results).toHaveLength(8);
    const pub = publicationFull({ prepared: value }); expect((await validateSnapshotPublication(pub, publicationScope, publicationAnchor(pub))).package.documents).toHaveLength(1);
    expect((await decode(inertBytes(value.package.results[7], values[7]), value.package.results[7])).text).toBe(values[7]);
  });
  it.each(['preparing', 'failed', 'deleted'])('recovers original maxBytes and consent in %s without inventing bodies', async state => {
    const recipe = inertRecipe({ maxBytes: 8 }), value = inertRecord(recipe, { state }); expect((await validateSnapshotPreparation(value, snapshotScope, recipe)).state).toBe(state); expect(value.package).toBeNull();
  });
  it('keeps unavailable bodies distinct from lost accepted source-text intent', async () => {
    const ready = inertRecord(), lost = inertRecord(ready.recipe, { unavailable: true }); expect(lost.snapshotSha256).toBe(ready.snapshotSha256);
    expect((await validateSnapshotPreparation(lost, snapshotScope, ready.recipe)).availability.status).toBe('unavailable');
  });
  it('decodes full16KiB source text when the escaped canonical body is much larger without truncating it again', async () => {
    const text = '\0'.repeat(16384), recipe = inertRecipe({ text }), value = inertRecord(recipe, { values: [text] }), result = value.package.results[0];
    const bytes = inertBytes(result, text), decoded = await decode(bytes, result);
    expect(bytes.length).toBeGreaterThan(6 * 16384); expect(bytes.length).toBeLessThanOrEqual(262144); expect(decoded.text).toBe(text); expect(decoded.includedSourceBytes).toBe(16384); expect(decoded.truncated).toBe(false);
  });
  it.each([
    ['consent', value => { value.package.results[0].origin.includeSourceText = false; }], ['source owner', value => { value.package.results[0].source.ownerUserId = 17; }],
    ['source path', value => { value.package.results[0].source.storageKey = '/private'; }], ['supplied caption', value => { value.package.results[0].origin.caption = 'Other intent'; }],
    ['saved N', value => { value.package.results[0].origin.analysisVersion++; }], ['original bound', value => { value.package.results[0].view.spec.maxBytes = 8; }],
  ])('rejects package-rehashed changed %s', async (_label, change) => {
    const value = inertRecord(); change(value); reseal(value); await expect(validateSnapshotPreparation(value, snapshotScope, value.recipe)).rejects.toMatchObject(error);
  });
  it.each(['', '🧬tail', '\uFEFFA\r\n🧬tail'])('decodes exact empty/zero-complete/prefix text %j', async text => {
    const recipe = inertRecipe({ text, maxBytes: 1 }), value = inertRecord(recipe, { values: [text] }), result = value.package.results[0];
    const body = await decode(inertBytes(result, text), result); expect(body.includedSourceBytes).toBe(0); expect(body.truncated).toBe(text !== '');
  });
  it('accepts cross-realm source-body byte arrays without trusting custom iteration', async () => {
    const result = inertRecord().package.results[0], bytes = inertBytes(result), foreign = runInNewContext('new Uint8Array(values)', { values: Array.from(bytes) });
    foreign[Symbol.iterator] = () => { throw Error('iterator'); }; Object.defineProperty(foreign, 'constructor', { get() { throw Error('constructor'); } });
    expect((await decode(foreign, result)).text).toBe(inertValue()); await expect(decode(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result)).rejects.toMatchObject(error);
  });
  it('captures original raw/descriptor before awaited digest work', async () => {
    const result = inertRecord().package.results[0], bytes = new Uint8Array(inertBytes(result)); let release;
    const gate = new Promise(resolve => { release = resolve; }), spy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await gate; return webcrypto.subtle.digest(...args); });
    const pending = decode(bytes, result); bytes.fill(0); result.view.spec.maxBytes = 1; result.origin.includeSourceText = false; release();
    try { expect((await pending).text).toBe(inertValue()); } finally { spy.mockRestore(); }
  });
});

describe('strict inert metadata and byte facts', () => {
  it.each(['av', 'eri'])('accepts metadata-only recognized %s source with exact saved N', prefix => {
    const value = inertOptions({ versionId: prefix + '_' + '8'.repeat(24) }); expect(validateSnapshotPreparationOptions(value, snapshotScope, value.kind, 2)).toEqual(value);
  });
  it.each([
    ['different saved N', value => { value.analysisVersion++; }], ['unsupported job identity', value => { value.items[0].reference.versionId = 'art_' + '8'.repeat(24); }],
    ['opaque format', value => { value.items[0].sourceFormatId = 'org.traceomics.opaque-file'; }], ['private metadata', value => { value.items[0].path = '/private'; }],
    ['bytes included in chooser', value => { value.items[0].text = 'unselected'; }], ['false integrity', value => { value.items[0].integrity = 'verified'; }],
    ['false availability', value => { value.items[0].availability = 'available'; }], ['source over budget', value => { value.items[0].sourceBytes = 209715201; }],
    ['signed zero byte count', value => { value.items[0].sourceBytes = -0; }],
    ['wrong family', value => { value.items[0].viewFamily = 'json'; }], ['duplicate reference', value => { value.items.push(structuredClone(value.items[0])); }],
  ])('rejects options %s', (_label, change) => {
    const value = inertOptions(); change(value); expect(() => validateSnapshotPreparationOptions(value, snapshotScope, value.kind, 2)).toThrow(expect.objectContaining(error));
  });
  it.each([
    ['extra hidden content', body => { body.privateImport = 'private'; }], ['different family', body => { body.family = 'json'; }],
    ['interpretation claim', body => { body.syntax = 'valid'; }], ['wrong representation', body => { body.representation = 'html'; }],
    ['false source count', body => { body.sourceBytes++; }], ['changed original format', body => { body.sourceFormatId = 'org.ietf.json'; }],
    ['wrong included bytes', body => { body.includedSourceBytes--; }], ['false truncation', body => { body.truncated = true; }],
    ['changed selected bound', body => { body.maxBytes = 8; }], ['new original source', body => { body.source.versionId = 'av_' + '9'.repeat(24); }],
    ['source identity mismatch', body => { body.source.sha256 = 'f'.repeat(64); }],
  ])('rejects resealed body %s', async (_label, change) => {
    const result = inertRecord().package.results[0], body = inertBody(result); change(body); const bytes = bodySeal(result, body); await expect(decode(bytes, result)).rejects.toMatchObject(error);
  });
  it('rejects a raw checksum-resealed malformed source-text Unicode escape', async () => {
    const result = inertRecord().package.results[0], body = inertBody(result);
    const text = canonicalSnapshotJson({ ...body, text: 'placeholder' }).replace('"text":"placeholder"', '"text":"\\ud800"');
    await expect(decode(rawSeal(result, text, body.source), result)).rejects.toMatchObject(error);
  });
  it.each([
    ['outer envelope BOM', text => '\uFEFF' + text],
    ['duplicate envelope key', text => text.replace('"family":"text"', '"family":"text","family":"text"')],
    ['signed zero fact', text => text.replace(/"sourceBytes":\d+/, '"sourceBytes":-0')],
  ])('rejects raw checksum-resealed %s without altering original source text', async (_label, change) => {
    const result = inertRecord().package.results[0], body = inertBody(result), text = change(canonicalSnapshotJson(body));
    await expect(decode(rawSeal(result, text, body.source), result)).rejects.toMatchObject(error);
  });
  it('captures owner scope/intent before asynchronous full validation', async () => {
    const value = inertRecord(), expected = structuredClone(value.recipe), scope = { ...snapshotScope }; let release;
    const gate = new Promise(resolve => { release = resolve; }), spy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await gate; return webcrypto.subtle.digest(...args); });
    const pending = validateSnapshotPreparation(value, scope, expected); scope.userId = 17; expected.results[0].includeSourceText = false; value.package.results[0].view.spec.maxBytes = 1; release();
    try { expect((await pending).package.results[0].origin.includeSourceText).toBe(true); } finally { spy.mockRestore(); }
  });
});
