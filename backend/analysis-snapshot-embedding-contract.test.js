import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ANALYSIS_SNAPSHOT_TYPED_LIMITS as T, normalizeAnalysisSnapshotTypedDescriptor, canonicalAnalysisSnapshotTypedDescriptor,
  canonicalAnalysisSnapshotResultViewV3, parseAnalysisSnapshotScalarJson } from '../shared/analysisSnapshotTypedResult.mjs';
import { normalizeAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPackage, canonicalSnapshotJson } from '../shared/analysisSnapshotPreparationDispatch.mjs';
import { embeddingValue, embeddingDescriptor, embeddingRecipe, embeddingRecord, embeddingBody } from '../src/analyses/snapshotEmbeddingTestFixtures';
import { typedRecipe, typedRecord } from '../src/analyses/snapshotTypedTestFixtures';
import { workflowRecipe, workflowRecord, workflowSelection } from '../src/analyses/snapshotWorkflowTestFixtures';
import { snapshotRecipe, snapshotRecord } from '../src/analyses/snapshotPreparationTestFixtures';
import { linkedRecipe, linkedRecord } from '../src/analyses/snapshotLinkedTestFixtures';
import * as legacy from '../shared/analysisSnapshotPreparation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const source = result => ({ artifactId: result.source.artifactId, versionId: result.source.versionId, projectId: 'proj_' + '2'.repeat(16), sha256: result.source.sha256 });
const literalDescriptor = '{"id":"eri_888888888888888888888888","profileId":null,"schema":"traceomics.retained-output-descriptor.v1","semantics":{"axes":{"x":{"label":null,"unit":null},"y":{"label":null,"unit":null}},"entityType":null,"role":null,"title":null},"sha256":"f2d53144fc5c62f68dac63add30b0524bdc6cd07931c50fc8998c6610f1318aa","sizeBytes":68,"type":"scatter"}';
const literalRequest = '{"schema":"traceomics.analysis-snapshot-preparation.v2","serviceId":"svc_11111111111111111111111111111111","projectId":"proj_2222222222222222","analysisId":"ra_333333333333333333333333","ownerUserId":7,"requestId":"12345678-1234-4234-8234-123456789abc","analysisVersion":2,"results":[{"kind":"typed-analysis-reference","reference":{"kind":"artifact-version","versionId":"eri_888888888888888888888888","sha256":"f2d53144fc5c62f68dac63add30b0524bdc6cd07931c50fc8998c6610f1318aa"},"descriptorSha256":"48a2d7f6f9c7003f61de52775a7df755433c517d2c77e22b668c036f61a4e831","caption":"Recorded coordinate finding","view":{"family":"embedding","pointLimit":2}}],"documents":[],"notes":{"summary":null,"decisions":null,"limitations":null},"prerequisites":[]}';
const literalBody = '{"family":"embedding","groups":["A","B"],"identity":{"indexBase":0,"kind":"source-identifiers","scope":"exact-source-version"},"ids":["c","b"],"sampling":{"aggregated":false,"budgetLimited":false,"method":"sha256-priority-v1","requestedLimit":2,"returnedCount":2,"sampled":true,"sourceCount":3,"stratified":false},"semantics":{"axes":{"x":{"label":null,"unit":null},"y":{"label":null,"unit":null}},"entityType":null,"role":null,"title":null},"source":{"artifactId":"eri_888888888888888888888888","projectId":"proj_2222222222222222","sha256":"f2d53144fc5c62f68dac63add30b0524bdc6cd07931c50fc8998c6610f1318aa","versionId":"eri_888888888888888888888888"},"sourceIndices":[2,1],"x":[3,2],"y":[6,5]}';

describe('known fixed embedding contract without a new journal or package version', () => {
  it('pins independent literal descriptor/request/body/view hashes and the unchanged SHA-priority sample', () => {
    // These literals were derived with an independent full rank sort, not the
    // production bounded heap, and retain original-source versus view identity.
    const value = { x: [1, 2, 3], y: [4, 5, 6], ids: ['a', 'b', 'c'], groups: ['A', 'B', 'A'] };
    const descriptor = embeddingDescriptor({ value, profileId: null, semantics: {} }), recipe = embeddingRecipe({ value, descriptor, pointLimit: 2, documents: [] });
    const record = embeddingRecord(recipe, { values: [value], descriptors: [descriptor] }), result = record.package.results[0];
    expect(canonicalAnalysisSnapshotTypedDescriptor(descriptor)).toBe(literalDescriptor);
    expect(hash(literalDescriptor)).toBe('48a2d7f6f9c7003f61de52775a7df755433c517d2c77e22b668c036f61a4e831');
    expect(canonicalAnalysisSnapshotPreparation(recipe)).toBe(literalRequest);
    expect(record.requestSha256).toBe('af9ce103904481f9a9bf81bda268653d2608b0c63c20e44a51245a39466b068d');
    expect(canonicalSnapshotJson(embeddingBody(result, value))).toBe(literalBody);
    expect(result.view.blobSha256).toBe('33505b2b927413e677626987c899099a965f98bd10c1654031afda134467d80c');
    expect(result.view.viewSha256).toBe('617831c88de484c355f46ae045bb34e3a097c708750ff672795999512bc37476');
    expect(record.snapshotSha256).toBe('8756a1db3951aecbaa3429d15efc084696f831e126d76daea9752b97d2a4b20d');
    expect(hash(canonicalAnalysisSnapshotPackage(record.package))).toBe(record.snapshotSha256);
  });
  it('uses the existing bounded projection contract and exact four-field source identity', () => {
    expect(T).toMatchObject({ sourceBytes: 5242880, responseBytes: 262144, sourcePoints: 100000, maximumPoints: 5000, defaultPoints: 2000, groups: 40, identifierCharacters: 200, groupCharacters: 100 });
    const record = embeddingRecord(), result = record.package.results[0];
    expect(canonicalAnalysisSnapshotPackage(record.package)).toBe(canonicalSnapshotJson(record.package));
    const { viewSha256, ...view } = result.view;
    expect(hash(canonicalAnalysisSnapshotResultViewV3({ ...view, source: source(result) }))).toBe(viewSha256);
    expect(result.view.spec).toEqual({ pointLimit: 5 }); expect(result.view.family).toBe('embedding');
    expect(result.source.format).toEqual({ id: 'org.traceomics.coordinates', version: '1' });
    expect(result.view.blobSha256).not.toBe(result.source.sha256);
  });
  it.each([1, 5, 2000, 5000])('accepts an explicit maximum of %i in direct and captured requests', pointLimit => {
    for (const captured of [false, true]) {
      const recipe = embeddingRecipe({ pointLimit, captured }), record = embeddingRecord(recipe);
      expect(normalizeAnalysisSnapshotPreparation(recipe)).toEqual(recipe);
      expect(record.package.results[0].view.spec).toEqual({ pointLimit });
    }
  });
  it.each([undefined, null, 0, -1, 1.5, 5001, '5', Infinity])('rejects unsupported or implicit point bound %s', pointLimit => {
    const recipe = embeddingRecipe(); recipe.results[0].view.pointLimit = pointLimit;
    expect(() => normalizeAnalysisSnapshotPreparation(recipe)).toThrow();
  });
  it('does not allow client ranking, aggregation, recoloring or a generic flat embedding', () => {
    for (const field of ['method', 'seed', 'groups', 'stratified', 'aggregated', 'responseBytes']) {
      const recipe = embeddingRecipe(); recipe.results[0].view[field] = 1; expect(() => normalizeAnalysisSnapshotPreparation(recipe)).toThrow();
    }
    const recipe = embeddingRecipe(); recipe.results[0].kind = 'analysis-reference'; delete recipe.results[0].descriptorSha256;
    expect(() => normalizeAnalysisSnapshotPreparation(recipe)).toThrow();
  });
  it('distinguishes deliberate bounds but rejects same-bound caption/descriptor changes as duplicates', () => {
    const recipe = embeddingRecipe(), selected = recipe.results[0];
    const different = normalizeAnalysisSnapshotPreparation({ ...recipe, results: [selected, { ...selected, view: { family: 'embedding', pointLimit: 7 } }] });
    expect(embeddingRecord(different).package.results.map(result => result.view.spec.pointLimit)).toEqual([5, 7]);
    expect(() => normalizeAnalysisSnapshotPreparation({ ...recipe, results: [selected, { ...selected, caption: 'Another caption', descriptorSha256: 'f'.repeat(64) }] })).toThrow();
  });
  it('keeps captured reviewed context distinct while preserving identical source bounds', () => {
    const first = embeddingRecipe({ captured: true }).results[0], second = embeddingRecipe({ captured: true, selection: workflowSelection({ seed: true }) }).results[0];
    const recipe = embeddingRecipe({ results: [first, second] }), value = embeddingRecord(recipe);
    expect(value.package.results.map(result => result.origin.context.seed)).toEqual([null, 0]);
    expect(value.package.results[0].view).toEqual(value.package.results[1].view);
    expect(value.package.results[0].origin.contextSha256).not.toBe(value.package.results[1].origin.contextSha256);
  });
  it('preserves all earlier package and canonical branches literally', () => {
    const old = snapshotRecipe(), saved = snapshotRecord(old);
    expect(canonicalAnalysisSnapshotPreparation(old)).toBe(legacy.canonicalAnalysisSnapshotPreparation(old));
    expect(canonicalAnalysisSnapshotPackage(saved.package)).toBe(legacy.canonicalAnalysisSnapshotPackage(saved.package));
    for (const [recipe, record] of [[linkedRecipe(), linkedRecord()], [typedRecipe(), typedRecord()], [workflowRecipe(), workflowRecord()]]) {
      expect(canonicalAnalysisSnapshotPreparation(normalizeAnalysisSnapshotPreparation(recipe))).toBe(canonicalAnalysisSnapshotPreparation(recipe));
      expect(canonicalAnalysisSnapshotPackage(record.package)).toBe(canonicalSnapshotJson(record.package));
    }
  });
  it('retains unknown meaning rather than inferring cell IDs or units', () => {
    const descriptor = embeddingDescriptor({ semantics: {} });
    expect(descriptor.semantics).toEqual({ role: null, title: null, entityType: null, axes: { x: { label: null, unit: null }, y: { label: null, unit: null } } });
    const value = embeddingValue({ ids: false, groups: false }), d = embeddingDescriptor({ value, semantics: {} });
    const result = embeddingRecord(embeddingRecipe({ value, descriptor: d }), { values: [value], descriptors: [d] }).package.results[0];
    expect(embeddingBody(result, value)).toMatchObject({ ids: null, identity: { kind: 'source-row-positions' }, semantics: descriptor.semantics });
  });
  it.each([
    ['view dimensions', result => { result.view.width = 100; }], ['unknown spec', result => { result.view.spec.seed = 0; }],
    ['unbounded spec', result => { result.view.spec.pointLimit = 5001; }], ['erased spec', result => { result.view.spec = null; }],
    ['flat source format', result => { result.source.format.id = 'org.ietf.json'; }], ['missing meaning', result => { result.view.semantics = {}; }],
    ['inferred entity', result => { result.view.semantics.entityType = 'patient'; }], ['mixed fixed schema', result => { result.view.schema = 'traceomics.fixed-result-view.v2'; }],
  ])('rejects %s in a scientific package', (_label, change) => {
    const record = embeddingRecord(); change(record.package.results[0]); expect(() => canonicalAnalysisSnapshotPackage(record.package)).toThrow();
  });
  it('rejects package duplicates even when only published pointLimit was erased or copied', () => {
    const recipe = embeddingRecipe(), record = embeddingRecord(embeddingRecipe({ results: [recipe.results[0], { ...recipe.results[0], view: { family: 'embedding', pointLimit: 6 } }] }));
    record.package.results[1].view.spec.pointLimit = 5; expect(() => canonicalAnalysisSnapshotPackage(record.package)).toThrow();
  });
  it('pins descriptor semantics/profile separately from unchanged original coordinates', () => {
    const descriptor = embeddingDescriptor(), original = canonicalAnalysisSnapshotTypedDescriptor(descriptor);
    for (const changes of [{ profileId: null }, { semantics: { ...descriptor.semantics, axes: { ...descriptor.semantics.axes, x: { label: 'Coordinate', unit: 'µm' } } } }, { semantics: { ...descriptor.semantics, entityType: null } }]) {
      expect(canonicalAnalysisSnapshotTypedDescriptor({ ...descriptor, ...changes })).not.toBe(original);
    }
    const getter = vi.fn(() => 'cell'), invalid = clone(descriptor); Object.defineProperty(invalid.semantics, 'entityType', { enumerable: true, get: getter });
    expect(() => normalizeAnalysisSnapshotTypedDescriptor(invalid)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it.each(['{"x":[1],"x":[2],"y":[3]}', '{"x":[-0],"y":[0]}', '{"x":[9007199254740993],"y":[0]}', '{"x":[1e-999],"y":[0]}', '{"x":[1e309],"y":[0]}'])('guards complete coordinate JSON %s', text => {
    expect(() => parseAnalysisSnapshotScalarJson(text)).toThrow();
  });
});
