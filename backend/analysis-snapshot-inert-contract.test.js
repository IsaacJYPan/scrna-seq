import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { FIXED_RESULT_VIEW_SCHEMA_V4, ANALYSIS_SNAPSHOT_INERT_LIMITS as L, projectAnalysisSnapshotInertPrefix as project,
  canonicalAnalysisSnapshotInertBody as bodyCanonical, canonicalAnalysisSnapshotResultViewV4 as viewCanonical } from '../shared/analysisSnapshotInertResult.mjs';
import { normalizeAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPackage, canonicalSnapshotJson } from '../shared/analysisSnapshotPreparationDispatch.mjs';
import { inertValue, inertRecipe, inertRecord, inertBody } from '../src/analyses/snapshotInertTestFixtures';
import { snapshotScope, snapshotRecipe, snapshotRecord } from '../src/analyses/snapshotPreparationTestFixtures';
import { embeddingRecipe, embeddingRecord } from '../src/analyses/snapshotEmbeddingTestFixtures';
import * as legacy from '../shared/analysisSnapshotPreparation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex'), encoder = new TextEncoder();
const source = { artifactId: 'af_' + 'c'.repeat(24), versionId: 'av_' + '8'.repeat(24), projectId: snapshotScope.projectId, sha256: 'a'.repeat(64) };
const literalRequest = '{"schema":"traceomics.analysis-snapshot-preparation.v2","serviceId":"svc_11111111111111111111111111111111","projectId":"proj_2222222222222222","analysisId":"ra_333333333333333333333333","ownerUserId":7,"requestId":"12345678-1234-4234-8234-123456789abc","analysisVersion":2,"results":[{"kind":"inert-analysis-reference","reference":{"kind":"artifact-version","versionId":"av_888888888888888888888888","sha256":"4f7398088e74abfe0a25c313ed9756a32221c12f9df13d0c66d34c8d13cdc115"},"caption":"Selected inert source text","view":{"family":"text","maxBytes":8},"includeSourceText":true}],"documents":[],"notes":{"summary":null,"decisions":null,"limitations":null},"prerequisites":[]}';
const literalBody = '{"family":"text","includedSourceBytes":6,"maxBytes":8,"representation":"utf8-source-prefix","source":{"artifactId":"af_cccccccccccccccccccccccc","projectId":"proj_2222222222222222","sha256":"4f7398088e74abfe0a25c313ed9756a32221c12f9df13d0c66d34c8d13cdc115","versionId":"av_888888888888888888888888"},"sourceBytes":14,"sourceFormatId":"org.ietf.text","syntax":"not-checked","text":"\uFEFFA\\r\\n","truncated":true}';
function prefix(text, maxBytes = 16384, sourceFormatId = 'org.ietf.text') {
  const bytes = encoder.encode(text); return { source: { ...source }, sourceFormatId, sourceBytes: bytes.length, maxBytes, bytes: bytes.subarray(0, maxBytes) };
}

describe('literal source prefix without JSON interpretation or executable content', () => {
  it('pins independent ordered request, consent, BOM/CRLF cut body, view and whole-package golden identities', () => {
    const text = '\uFEFFA\r\n🧬tail', recipe = inertRecipe({ text, maxBytes: 8, documents: [] }), value = inertRecord(recipe, { values: [text] });
    const result = value.package.results[0];
    expect(result.source.sha256).toBe('4f7398088e74abfe0a25c313ed9756a32221c12f9df13d0c66d34c8d13cdc115');
    expect(canonicalAnalysisSnapshotPreparation(recipe)).toBe(literalRequest);
    expect(value.requestSha256).toBe('f7c5239047c0b81eeb1460438bc75457559e9b4637c0f76397ecbde7cdd72b60');
    expect(bodyCanonical(inertBody(result, text))).toBe(literalBody);
    expect(result.view.blobSha256).toBe('f550f4bcbde28f7c4ba8aaa5202cc49ecc064e9d66851c633efb6ad5accdd0aa');
    expect(result.view.viewSha256).toBe('eaa0fd4c5c24a39c5b1eb5735ca831e21ff6fb27a70c944e50a21c386d3dfba5');
    expect(value.snapshotSha256).toBe('4516c421f5ed7179d222f784314d0be9407ed3f153b83a70945194321239a0ac');
  });
  it('pins isolated fixed4 and the existing source/body budgets', () => {
    expect(FIXED_RESULT_VIEW_SCHEMA_V4).toBe('traceomics.fixed-result-view.v4');
    expect(L).toEqual({ sourceBytes: 209715200, prefixBytes: 16384, responseBytes: 262144 }); expect(Object.isFrozen(L)).toBe(true);
  });
  it.each(['', 'alpha\r\n\t beta  ', '\uFEFFBOM\r\n', '<script src="/private">inert()</script>', '\0\u001b[31m literal', '🧬漢字', '{"x":9007199254740993,"x":1e-999}'])('preserves every included UTF8 byte of %j', text => {
    const body = project(prefix(text)); expect(body.text).toBe(text); expect(body.includedSourceBytes).toBe(encoder.encode(text).length);
    expect(body.truncated).toBe(false); expect(body.syntax).toBe('not-checked'); expect(encoder.encode(body.text)).toEqual(encoder.encode(text));
  });
  it.each([1, 2, 3, 4, 5])('retains only complete leading codepoints for selected maxBytes=%i', maxBytes => {
    const text = '🧬tail', body = project(prefix(text, maxBytes));
    expect(body.text).toBe(maxBytes < 4 ? '' : maxBytes === 4 ? '🧬' : '🧬t');
    expect(body.truncated).toBe(true); expect(maxBytes - body.includedSourceBytes).toBeLessThanOrEqual(3);
  });
  it('preserves BOM and CRLF while dropping only the partial trailing scalar', () => {
    const text = '\uFEFFA\r\n🧬tail';
    for (const maxBytes of [7, 8, 9]) { const body = project(prefix(text, maxBytes)); expect(body.text).toBe('\uFEFFA\r\n'); expect(body.includedSourceBytes).toBe(6); expect(maxBytes - body.includedSourceBytes).toBe(maxBytes - 6); }
    expect(project(prefix(text, 10)).text).toBe('\uFEFFA\r\n🧬');
  });
  it.each([
    { sourceBytes: 2, maxBytes: 2, bytes: new Uint8Array([0xf0, 0x9f]) },
    { sourceBytes: 4, maxBytes: 3, bytes: new Uint8Array([0x61, 0xff, 0x62]) },
    { sourceBytes: 1, maxBytes: 2, bytes: new Uint8Array([0x80]) },
  ])('rejects invalid included interior or full ending %# without replacement', values => {
    expect(() => project({ source, sourceFormatId: 'org.ietf.text', ...values })).toThrow();
  });
  it('makes no syntax or omitted-suffix validity claim for a literal JSON prefix', () => {
    const text = inertValue('org.ietf.json'), body = project(prefix(text, 32, 'org.ietf.json'));
    expect(body.text).toBe(text.slice(0, 32)); expect(body.syntax).toBe('not-checked'); expect(body).not.toHaveProperty('value');
    expect(project(prefix('{broken JSON', 16384, 'org.ietf.json')).text).toBe('{broken JSON');
  });
  it('does not require buffering or parsing a large source to project its exact declared prefix', () => {
    const body = project({ source, sourceFormatId: 'org.ietf.json', sourceBytes: L.sourceBytes, maxBytes: 1, bytes: new Uint8Array([123]) });
    expect(body).toMatchObject({ text: '{', sourceBytes: L.sourceBytes, includedSourceBytes: 1, truncated: true, syntax: 'not-checked' });
  });
  it('retains the full selected16KiB text even when JSON escaping expands every source character', () => {
    const text = '\0'.repeat(L.prefixBytes), body = project(prefix(text)), canonical = bodyCanonical(body);
    expect(body.text).toBe(text); expect(body.includedSourceBytes).toBe(16384); expect(body.truncated).toBe(false);
    expect(encoder.encode(canonical).byteLength).toBeGreaterThan(6 * 16384); expect(encoder.encode(canonical).byteLength).toBeLessThanOrEqual(L.responseBytes);
  });
  it.each([undefined, false, null, 'true', 1])('requires explicit includeSourceText:true, refusing %s', consent => {
    const recipe = inertRecipe(); recipe.results[0].includeSourceText = consent; expect(() => normalizeAnalysisSnapshotPreparation(recipe)).toThrow();
  });
  it.each([0, -0, -1, 1.1, 16385, '16', Infinity])('rejects unsupported prefix cap %s', maxBytes => {
    const recipe = inertRecipe(); recipe.results[0].view.maxBytes = maxBytes; expect(() => normalizeAnalysisSnapshotPreparation(recipe)).toThrow();
  });
  it('keeps new normalized result field order and consent inside original UUID intent', () => {
    const recipe = inertRecipe(); expect(Object.keys(recipe.results[0])).toEqual(['kind', 'reference', 'caption', 'view', 'includeSourceText']);
    expect(canonicalAnalysisSnapshotPreparation(recipe)).toContain('"view":{"family":"text","maxBytes":16384},"includeSourceText":true');
    const other = inertRecipe({ maxBytes: 8 }); expect(canonicalAnalysisSnapshotPreparation(other)).not.toBe(canonicalAnalysisSnapshotPreparation(recipe));
  });
  it('allows deliberate different prefixes but rejects caption-only duplicate selections', () => {
    const recipe = inertRecipe(), first = recipe.results[0], mixed = inertRecipe({ results: [first, { ...first, view: { family: 'text', maxBytes: 8 } }] });
    expect(inertRecord(mixed).package.results.map(result => result.view.spec.maxBytes)).toEqual([16384, 8]);
    expect(() => inertRecipe({ results: [first, { ...first, caption: 'Different words' }] })).toThrow();
  });
  it('preserves original v1 and existing embedding package branches literally', () => {
    const recipe = snapshotRecipe(), record = snapshotRecord(recipe);
    expect(canonicalAnalysisSnapshotPreparation(recipe)).toBe(legacy.canonicalAnalysisSnapshotPreparation(recipe));
    expect(canonicalAnalysisSnapshotPackage(record.package)).toBe(legacy.canonicalAnalysisSnapshotPackage(record.package));
    const before = embeddingRecord(embeddingRecipe({ captured: true })); expect(canonicalAnalysisSnapshotPackage(before.package)).toBe(canonicalSnapshotJson(before.package));
  });
  it.each([
    ['invented JSON structure', value => { value.value = {}; }], ['false syntax', value => { value.syntax = 'valid'; }],
    ['UTF16 byte confusion', value => { value.includedSourceBytes = value.text.length; }], ['wrong total', value => { value.sourceBytes = 1; }],
    ['false truncation', value => { value.truncated = true; }], ['excess omitted cut', value => { value.sourceBytes = 100; value.maxBytes = 20; value.truncated = true; }],
    ['short source incomplete', value => { value.sourceBytes++; }], ['unpaired Unicode', value => { value.text = '\ud800'; }],
    ['negative zero fact', value => { value.sourceBytes = -0; }], ['opaque format', value => { value.sourceFormatId = 'org.traceomics.opaque-file'; }],
  ])('rejects %s in a retained body', (_label, change) => {
    const body = project(prefix('🧬text')); change(body); expect(() => bodyCanonical(body)).toThrow();
  });
  it('checks exact prefix bytes without custom constructor, byteLength or iterator access', () => {
    const bytes = runInNewContext('new Uint8Array([97,98])'), getter = vi.fn(() => { throw Error('access'); });
    Object.defineProperty(bytes, 'constructor', { get: getter }); Object.defineProperty(bytes, 'byteLength', { get: getter }); bytes[Symbol.iterator] = getter;
    expect(project({ source, sourceFormatId: 'org.ietf.text', sourceBytes: 3, maxBytes: 2, bytes }).text).toBe('ab'); expect(getter).not.toHaveBeenCalled();
    expect(() => project({ ...prefix('ab'), bytes: new DataView(new ArrayBuffer(2)) })).toThrow();
    const input = prefix('ab'), malicious = vi.fn(); Object.defineProperty(input.source, 'sha256', { enumerable: true, get: malicious });
    expect(() => project(input)).toThrow(); expect(malicious).not.toHaveBeenCalled();
  });
  it.each([
    ['old view schema', item => { item.view.schema = 'traceomics.fixed-result-view.v2'; }], ['raster dimension', item => { item.view.width = 1; }],
    ['false consent', item => { item.origin.includeSourceText = false; }], ['source bypass', item => { item.source.format.id = 'org.w3.png'; }],
    ['typed bypass', item => { item.origin.kind = 'typed-analysis-reference'; }], ['JSON interpretation setting', item => { item.view.spec.parse = true; }],
  ])('rejects %s in a package', (_label, change) => {
    const value = inertRecord(); change(value.package.results[0]); expect(() => canonicalAnalysisSnapshotPackage(value.package)).toThrow();
  });
  it('pins distinct source/body/view identities for a valid text result', () => {
    const value = inertRecord(), result = value.package.results[0], body = inertBody(result), { viewSha256, ...view } = result.view;
    expect(result.source.sha256).toBe(hash(inertValue())); expect(result.view.blobSha256).toBe(hash(bodyCanonical(body)));
    expect(hash(viewCanonical({ ...view, source: body.source }))).toBe(viewSha256); expect(viewSha256).not.toBe(result.source.sha256);
  });
});
