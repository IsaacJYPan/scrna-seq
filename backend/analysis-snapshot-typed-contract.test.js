import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ANALYSIS_SNAPSHOT_TYPED_DESCRIPTOR_SCHEMA, FIXED_RESULT_VIEW_SCHEMA_V3, ANALYSIS_SNAPSHOT_SCALAR_MODEL,
  ANALYSIS_SNAPSHOT_TYPED_LIMITS as T, normalizeAnalysisSnapshotTypedDescriptor as descriptor, canonicalAnalysisSnapshotTypedDescriptor as descriptorCanonical,
  canonicalAnalysisSnapshotResultViewV3 as viewCanonical, parseAnalysisSnapshotScalarJson as parse, projectAnalysisSnapshotJsonTable as project,
} from '../shared/analysisSnapshotTypedResult.mjs';
import { canonicalAnalysisSnapshotPreparation, normalizeAnalysisSnapshotPreparation,
  canonicalAnalysisSnapshotPackage, canonicalSnapshotJson } from '../shared/analysisSnapshotPreparationDispatch.mjs';
import * as legacy from '../shared/analysisSnapshotPreparation.mjs';
import { typedRecipe, typedRecord, typedDescriptor, typedValue, typedImageBytes } from '../src/analyses/snapshotTypedTestFixtures';
import { snapshotRecipe, snapshotRecord, snapshotScope } from '../src/analyses/snapshotPreparationTestFixtures';
import { linkedRecipe, linkedRecord } from '../src/analyses/snapshotLinkedTestFixtures';

const hash = value => createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);
const source = descriptor => ({ artifactId: descriptor.id, versionId: descriptor.id, projectId: snapshotScope.projectId, sha256: descriptor.sha256 });
const table = (value = typedValue(), changes = {}) => { const d = typedDescriptor(); return { source: source(d), descriptor: d, value, offset: 0, limit: 25, ...changes }; };
const literalDescriptor = '{"id":"eri_666666666666666666666666","profileId":null,"schema":"traceomics.retained-output-descriptor.v1","semantics":{"role":null,"title":null},"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sizeBytes":256,"type":"table"}';
const literalRequest = '{"schema":"traceomics.analysis-snapshot-preparation.v2","serviceId":"svc_11111111111111111111111111111111","projectId":"proj_2222222222222222","analysisId":"ra_333333333333333333333333","ownerUserId":7,"requestId":"12345678-1234-4234-8234-123456789abc","analysisVersion":2,"results":[{"kind":"typed-analysis-reference","reference":{"kind":"artifact-version","versionId":"eri_666666666666666666666666","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"descriptorSha256":"cab59a9a59a25fc36ef8743b09be669222fd23ad93f5a0b5b60018ac6d550abd","caption":"Recorded measured finding","view":{"family":"table","offset":0,"limit":25}}],"documents":[],"notes":{"summary":null,"decisions":null,"limitations":null},"prerequisites":[]}';

describe('exact retained typed descriptor and fixed representation', () => {
  it('pins the new bounded model without changing legacy contracts', () => {
    expect(ANALYSIS_SNAPSHOT_TYPED_DESCRIPTOR_SCHEMA).toBe('traceomics.retained-output-descriptor.v1');
    expect(FIXED_RESULT_VIEW_SCHEMA_V3).toBe('traceomics.fixed-result-view.v3');
    expect(ANALYSIS_SNAPSHOT_SCALAR_MODEL).toBe('finite-ieee754-safe-integers.v1');
    expect(T).toMatchObject({ sourceBytes: 5242880, sourceRows: 50000, columns: 100, cellCharacters: 2000, responseBytes: 262144, rows: 100, offset: 10000 });
    expect(Object.isFrozen(T)).toBe(true);
  });
  it('keeps an independent literal normalized descriptor canonical preimage', () => {
    const value = typedDescriptor({ sha256: 'a'.repeat(64), sizeBytes: 256, profileId: null, semantics: {} });
    expect(descriptorCanonical(value)).toBe(literalDescriptor);
    expect(hash(descriptorCanonical(value))).toBe('cab59a9a59a25fc36ef8743b09be669222fd23ad93f5a0b5b60018ac6d550abd');
    expect(descriptorCanonical(Object.fromEntries(Object.entries(value).reverse()))).toBe(literalDescriptor);
    expect(descriptor(value).semantics).toEqual({ role: null, title: null });
  });
  it('pins the ordered typed request including its independent descriptor intent', () => {
    const value = typedRecipe({ descriptor: typedDescriptor({ sha256: 'a'.repeat(64), sizeBytes: 256, profileId: null, semantics: {} }), documents: [] });
    expect(canonicalAnalysisSnapshotPreparation(value)).toBe(literalRequest);
  });
  it('pins meaning/profile independently of stable original bytes', () => {
    const value = typedDescriptor(), initial = descriptorCanonical(value);
    expect(descriptorCanonical({ ...value, profileId: null })).not.toBe(initial);
    expect(descriptorCanonical({ ...value, semantics: { ...value.semantics, title: 'Another meaning' } })).not.toBe(initial);
    expect(descriptorCanonical({ ...value, sha256: 'f'.repeat(64) })).not.toBe(initial);
  });
  it.each(['table', 'metrics', 'image'])('accepts exact %s typed request/package/view hashes', family => {
    const recipe = typedRecipe({ family }), value = typedRecord(recipe), item = value.package.results[0], { viewSha256, ...view } = item.view;
    expect(normalizeAnalysisSnapshotPreparation(recipe)).toEqual(recipe);
    expect(canonicalAnalysisSnapshotPreparation(recipe)).toContain('"kind":"typed-analysis-reference"');
    expect(canonicalAnalysisSnapshotPackage(value.package)).toBe(canonicalSnapshotJson(value.package));
    expect(hash(viewCanonical({ ...view, source: source({ id: item.source.versionId, sha256: item.source.sha256 }) }))).toBe(viewSha256);
    if (family === 'image') expect(item.view.blobSha256).toBe(hash(typedImageBytes()));
  });
  it('preserves literal v1 and C1 branch bytes and accepts mixed new branches', () => {
    const old = snapshotRecipe(), v1 = snapshotRecord(old), c1 = linkedRecipe(), oldC1 = canonicalAnalysisSnapshotPreparation(c1);
    expect(canonicalAnalysisSnapshotPreparation(old)).toBe(legacy.canonicalAnalysisSnapshotPreparation(old));
    expect(canonicalAnalysisSnapshotPackage(v1.package)).toBe(legacy.canonicalAnalysisSnapshotPackage(v1.package));
    expect(canonicalAnalysisSnapshotPreparation(normalizeAnalysisSnapshotPreparation(c1))).toBe(oldC1);
    expect(canonicalAnalysisSnapshotPackage(linkedRecord(c1).package)).toContain('traceomics.fixed-result-view.v2');
    const mixed = typedRecipe({ results: [{ kind: 'attachment-revision', ...old.results[0] }, c1.results[0], typedRecipe().results[0]] });
    expect(typedRecord(mixed).package.results.map(item => item.origin.kind)).toEqual(['attachment-revision', 'analysis-reference', 'typed-analysis-reference']);
  });
  it('allows different fixed table excerpts while rejecting caption/descriptor-only duplicate selections', () => {
    const value = typedRecipe(), first = value.results[0];
    expect(normalizeAnalysisSnapshotPreparation({ ...value, results: [first, { ...first, view: { ...first.view, offset: 25 } }] }).results).toHaveLength(2);
    expect(() => normalizeAnalysisSnapshotPreparation({ ...value, results: [first, { ...first, caption: 'Other caption', descriptorSha256: 'f'.repeat(64) }] })).toThrow();
  });
  it.each([
    ['descriptor extra field', value => { value.path = '/private'; }], ['missing field', value => { delete value.profileId; }],
    ['unknown schema', value => { value.schema += 'x'; }], ['future type', value => { value.type = 'density'; }],
    ['unsafe profile', value => { value.profileId = '/private/runtime'; }], ['overbound profile', value => { value.profileId = 'a'.repeat(121); }],
    ['unbound source ID', value => { value.id = 'unknown'; }], ['empty source', value => { value.sizeBytes = 0; }],
    ['too large source', value => { value.sizeBytes = T.sourceBytes + 1; }], ['unknown meaning', value => { value.semantics.privatePath = '/private'; }],
    ['unpaired Unicode meaning', value => { value.semantics.title = '\ud800'; }], ['metric units on table', value => { value.semantics.metrics = {}; }],
  ])('rejects %s', (_name, change) => { const value = typedDescriptor(); change(value); expect(() => descriptor(value)).toThrow(); });
  it('refuses descriptor getters/prototypes without executing custom code', () => {
    const value = typedDescriptor(), getter = vi.fn(() => 'text'); Object.defineProperty(value.semantics, 'title', { enumerable: true, get: getter });
    expect(() => descriptor(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
    const custom = Object.assign(Object.create({ public: true }), typedDescriptor()); expect(() => descriptor(custom)).toThrow();
  });
  it.each([
    ['wrong view schema', value => { value.schema = 'traceomics.fixed-result-view.v2'; }], ['client source metadata', value => { value.source.path = '/private'; }],
    ['omitted descriptor hash', value => { delete value.descriptorSha256; }], ['invalid descriptor hash', value => { value.descriptorSha256 = 'x'; }],
    ['unnormalized meaning', value => { value.semantics = {}; }], ['table image dimensions', value => { value.width = 1; }],
    ['table spec expansion', value => { value.spec.limit = 101; }], ['extra fixed metadata', value => { value.script = 'R'; }],
  ])('rejects %s in fixed3', (_name, change) => {
    const result = typedRecord().package.results[0], { viewSha256: _hash, ...view } = result.view; void _hash;
    const value = { ...view, source: source({ id: result.source.versionId, sha256: result.source.sha256 }) }; change(value); expect(() => viewCanonical(value)).toThrow();
  });
  it('does not allow a typed source to use a flat origin or mismatched format', () => {
    const value = typedRecord().package; value.results[0].source.format.id = 'org.ietf.csv'; expect(() => canonicalAnalysisSnapshotPackage(value)).toThrow();
    const wrong = typedRecord().package; wrong.results[0].origin.kind = 'analysis-reference'; expect(() => canonicalAnalysisSnapshotPackage(wrong)).toThrow();
    const flat = linkedRecord().package; flat.results[0].view = copy(typedRecord().package.results[0].view); expect(() => canonicalAnalysisSnapshotPackage(flat)).toThrow();
  });
});

describe('bounded typed scalar JSON source interpretation', () => {
  it.each(['0', '1', '-1', '1.25', '0.125e2', '9007199254740991', '-9007199254740991', '1e-100', 'true', 'false', 'null', '"donor 🧬"'])('retains supported scalar %s', token => {
    expect(parse(token)).toEqual(JSON.parse(token));
  });
  it('retains ordinary finite fractions under the declared model without pretending decimal arithmetic', () => {
    expect(parse('[{"a":0.1,"b":1.234567890123456789}]')).toEqual([{ a: 0.1, b: Number('1.234567890123456789') }]);
  });
  it.each(['9007199254740992', '9007199254740993', '-9007199254740993', '9007199254740993.0', '9.007199254740993e15', '1e309', '-1e309', '1e-999', '-1e-999', '-0', '-0.0', '-0e0', 'NaN', 'Infinity', '+1', '01', '1.', '.1', 'true false', '[1,]', '{"a":1,}', '{"a":1,"a":2}', '{"a":1,"\u0061":2}', '{"__proto__":1}', '"\\ud800"'])('rejects lossy or unsupported token %s', token => {
    expect(() => parse(token)).toThrow();
  });
  it('bounds bytes, depth and getter-free text inputs', () => {
    expect(() => parse('"' + 'a'.repeat(T.sourceBytes) + '"')).toThrow(expect.objectContaining({ status: 413 }));
    expect(() => parse('[[[[[[0]]]]]]')).toThrow(); expect(() => parse({ toString: () => '[]' })).toThrow();
  });
});

describe('faithful scalar JSON fixed table projection', () => {
  it('retains null/false/true/zero/empty string/numeric text/fraction and Unicode distinctly', () => {
    const result = project(table(parse(JSON.stringify(typedValue()))));
    expect(result.rows).toEqual([[null, false, true, 0, '', 1.25, 'null', 'donor 🧬']]);
    expect(result).toMatchObject({ scalarModel: ANALYSIS_SNAPSHOT_SCALAR_MODEL, offset: 0, limit: 25, totalRows: 1, hasMore: false, truncated: false });
  });
  it('preserves raw integer-index source column order instead of native Object.keys reordering', () => {
    const value = parse('[{"2":"two","1":"one","sample":"A"},{"1":"B1","2":"B2","sample":"B"}]');
    expect(Object.keys(value[0])).toEqual(['1', '2', 'sample']);
    const result = project(table(value)); expect(result.columns).toEqual(['2', '1', 'sample']); expect(result.rows).toEqual([['two', 'one', 'A'], ['B2', 'B1', 'B']]);
  });
  it('retains exact row positions and fixed excerpt facts for later/empty windows', () => {
    const value = [{ sample: 'A' }, { sample: 'B' }, { sample: 'C' }], result = project(table(value, { offset: 1, limit: 1 }));
    expect(result).toMatchObject({ rows: [['B']], offset: 1, totalRows: 3, hasMore: true });
    expect(project(table(value, { offset: 3, limit: 1 }))).toMatchObject({ rows: [], columns: ['sample'], totalRows: 3, hasMore: false });
    expect(project(table([]))).toMatchObject({ rows: [], columns: [], totalRows: 0, hasMore: false });
  });
  it.each([
    ['nested cell', [{ a: { value: 1 } }]], ['array cell', [{ a: [1] }]], ['missing key', [{ a: 1 }, {}]], ['extra key', [{ a: 1 }, { a: 2, b: 3 }]],
    ['null row', [null]], ['empty record', [{}]], ['oversized text', [{ a: 'x'.repeat(2001) }]], ['unsafe number', [{ a: 9007199254740992 }]],
    ['infinite number', [{ a: Infinity }]], ['negative zero', [{ a: -0 }]], ['empty column', [{ '': 1 }]], ['overbound column', [{ ['a'.repeat(101)]: 1 }]],
    ['unsafe column', [JSON.parse('{"__proto__":1}')]], ['too many rows', Array.from({ length: 50001 }, () => ({ a: 1 }))],
  ])('rejects %s without conversion', (_name, value) => { expect(() => project(table(value))).toThrow(); });
  it('bounds actual output bytes and refuses malicious row accessors without invocation', () => {
    const value = Array.from({ length: 100 }, () => ({ a: 'x'.repeat(2000), b: 'x'.repeat(2000) })); expect(() => project(table(value, { limit: 100 }))).toThrow();
    const row = {}, getter = vi.fn(() => 'private'); Object.defineProperty(row, 'a', { enumerable: true, get: getter });
    expect(() => project(table([row]))).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('binds exact source identity and trusted type before projecting', () => {
    const value = table(); value.source.sha256 = 'f'.repeat(64); expect(() => project(value)).toThrow();
    expect(() => project(table(typedValue(), { descriptor: typedDescriptor({ type: 'metrics' }) }))).toThrow();
    expect(() => project(table(typedValue(), { offset: 10001 }))).toThrow();
  });
});
