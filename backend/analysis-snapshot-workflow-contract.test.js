import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ANALYSIS_SNAPSHOT_WORKFLOW_CONTEXT_SCHEMA, ANALYSIS_SNAPSHOT_WORKFLOW_CONTEXT_BINDING_SCHEMA, ANALYSIS_SNAPSHOT_WORKFLOW_LIMITS as W,
  normalizeAnalysisSnapshotWorkflowContextOffer as offer, normalizeAnalysisSnapshotWorkflowContextSelection as selection,
  normalizeAnalysisSnapshotWorkflowContext as context, projectAnalysisSnapshotWorkflowContext as project,
  canonicalAnalysisSnapshotWorkflowContextBinding as canonical, normalizeAnalysisSnapshotWorkflowOutputReference as reference,
  normalizeAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPackage, canonicalSnapshotJson,
} from '../shared/analysisSnapshotPreparationDispatch.mjs';
import { workflowOffer, workflowSelection, workflowContext, workflowRecipe, workflowRecord, workflowReferencePrerequisite, workflowSnapshotReference } from '../src/analyses/snapshotWorkflowTestFixtures';
import { snapshotScope, snapshotRecipe, snapshotRecord } from '../src/analyses/snapshotPreparationTestFixtures';
import { linkedRecipe, linkedRecord } from '../src/analyses/snapshotLinkedTestFixtures';
import { typedRecipe, typedRecord } from '../src/analyses/snapshotTypedTestFixtures';

const hash = value => createHash('sha256').update(value).digest('hex'), copy = value => structuredClone(value);
const binding = (ctx = workflowContext(), changes = {}) => ({ serviceId: snapshotScope.serviceId, projectId: snapshotScope.projectId, analysisId: snapshotScope.analysisId,
  ownerUserId: snapshotScope.userId, analysisVersion: 2, context: ctx, ...changes });
const all = () => workflowSelection({ method: true, parameterKeys: ['include-empty', 'min-cells', 'mode'], seed: true, environment: true });
const literal = '{"analysisId":"ra_333333333333333333333333","analysisVersion":2,"context":{"environment":null,"method":null,"parameters":[],"port":"values","relation":"recorded-in-capture","schema":"traceomics.captured-workflow-context.v1","seed":null,"snapshotReference":{"kind":"workflow-snapshot","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","snapshotId":"wfs_777777777777777777777777"},"stepId":"counts"},"ownerUserId":7,"projectId":"proj_2222222222222222","schema":"traceomics.captured-workflow-context-binding.v1","serviceId":"svc_11111111111111111111111111111111"}';

describe('closed captured workflow context selection', () => {
  it('pins separate context versus evidence schemas and existing budgets', () => {
    expect(ANALYSIS_SNAPSHOT_WORKFLOW_CONTEXT_SCHEMA).toBe('traceomics.captured-workflow-context.v1');
    expect(ANALYSIS_SNAPSHOT_WORKFLOW_CONTEXT_BINDING_SCHEMA).toBe('traceomics.captured-workflow-context-binding.v1');
    expect(W).toMatchObject({ offeredParameters: 24, selectedParameters: 12, contextBytes: 16384, candidateContextBytes: 32768, outputs: 320, sourceBytes: 3145728, stateBytes: 2097152, environmentBytes: 262144 });
    expect(Object.isFrozen(W)).toBe(true);
  });
  it('keeps an independent literal scoped context canonical and preserves default-off categories', () => {
    expect(canonical(binding())).toBe(literal);
    expect(hash(canonical(binding()))).toBe('bcc507de381f5eaac35ba8693bbb0963d200bb606a71709d6fa8173e51d9fd93');
    expect(workflowContext()).toMatchObject({ method: null, parameters: [], seed: null, environment: null, relation: 'recorded-in-capture' });
    expect(selection(workflowSelection())).toEqual({ method: false, parameterKeys: [], seed: false, environment: false });
  });
  it('retains reviewed actual false/zero/seed0 and explicit chosen parameter order', () => {
    const selected = all(), value = project({ snapshotReference: workflowSnapshotReference(), stepId: 'counts', port: 'values', offer: workflowOffer(), selection: selected });
    expect(value.parameters.map(item => item.value)).toEqual([false, 0, 'paired']); expect(value.seed).toBe(0); expect(value.environment.profileId).toBe('expert.r.v1');
    expect(context(value)).toEqual(value); expect(offer(workflowOffer()).parameters).toHaveLength(3);
    expect(canonical(binding(value))).not.toBe(canonical(binding()));
  });
  it('binds service/project/analysis/publisher/N/capture independently', () => {
    const first = hash(canonical(binding()));
    for (const changes of [{ serviceId: 'svc_' + '9'.repeat(32) }, { projectId: 'proj_' + '9'.repeat(16) }, { analysisId: 'ra_' + '9'.repeat(24) }, { ownerUserId: 17 }, { analysisVersion: 3 }]) expect(hash(canonical(binding(workflowContext(), changes)))).not.toBe(first);
    expect(hash(canonical(binding(workflowContext({ snapshotReference: workflowSnapshotReference({ sha256: 'f'.repeat(64) }) }))))).not.toBe(first);
  });
  it('never materializes unselected values or substitutes a missing recorded default', () => {
    const value = workflowOffer({ parameters: [], method: null, seed: null, environment: null });
    expect(project({ snapshotReference: workflowSnapshotReference(), stepId: 'counts', port: 'values', offer: value, selection: workflowSelection() })).toMatchObject({ parameters: [], seed: null });
    for (const selected of [workflowSelection({ parameterKeys: ['min-cells'] }), workflowSelection({ method: true }), workflowSelection({ seed: true }), workflowSelection({ environment: true })]) expect(() => project({ snapshotReference: workflowSnapshotReference(), stepId: 'counts', port: 'values', offer: value, selection: selected })).toThrow();
  });
  it.each([
    ['free text', value => { value.parameters[0] = { ...value.parameters[0], type: 'text', value: 'private' }; }],
    ['path choice', value => { value.parameters[2].value = '/private/file'; }], ['URL choice', value => { value.parameters[2].value = 'https://secret'; }],
    ['colon choice', value => { value.parameters[2].value = 'token:secret'; }], ['space choice', value => { value.parameters[2].value = 'hidden token'; }],
    ['overbound choice', value => { value.parameters[2].value = 'x'.repeat(81); }], ['wrong boolean', value => { value.parameters[1].value = 0; }],
    ['unsafe number', value => { value.parameters[0].value = 9007199254740992; }], ['negative zero', value => { value.parameters[0].value = -0; }],
    ['fractional integer', value => { value.parameters[0].value = 0.5; }], ['nonfinite number', value => { value.parameters[0].value = Infinity; }],
    ['duplicate recorded key', value => { value.parameters.push(copy(value.parameters[0])); }], ['invented default', value => { value.parameters[0].default = 10; }],
    ['private method source', value => { value.method.files = { 'private.R': 'code' }; }], ['method unknown field', value => { value.method.entry = 'private.R'; }],
    ['wrong environment identity', value => { value.environment.id = 'renv_' + 'a'.repeat(64); }], ['environment raw manifest', value => { value.environment.packages = []; }],
    ['negative seed', value => { value.seed = -1; }], ['negative zero seed', value => { value.seed = -0; }], ['seed too large', value => { value.seed = 2147483648; }],
  ])('rejects %s in an offered captured projection', (_label, change) => { const value = workflowOffer(); change(value); expect(() => offer(value)).toThrow(); });
  it.each([
    ['implicit defaults', value => { delete value.seed; }], ['extra source field', value => { value.path = '/private'; }],
    ['nonboolean category', value => { value.environment = null; }], ['duplicate selected key', value => { value.parameterKeys = ['mode', 'mode']; }],
    ['unsupported key', value => { value.parameterKeys = ['../source']; }], ['too many keys', value => { value.parameterKeys = Array.from({ length: 13 }, (_, i) => 'param-' + i); }],
  ])('rejects %s in explicit selection', (_label, change) => { const value = workflowSelection(); change(value); expect(() => selection(value)).toThrow(); });
  it('refuses getters/prototypes/cycles without invoking code', () => {
    const value = workflowOffer(), getter = vi.fn(() => 'private'); Object.defineProperty(value.parameters[0], 'value', { enumerable: true, get: getter });
    expect(() => offer(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => offer(Object.assign(Object.create({ approved: true }), workflowOffer()))).toThrow();
    const cycle = workflowOffer(); cycle.method = cycle; expect(() => offer(cycle)).toThrow();
  });
  it('normalizes exact captured identity separately from current output availability', () => {
    const value = workflowReferencePrerequisite(), identity = { snapshotReference: value.snapshotReference, stepId: value.stepId, port: value.port, reference: value.reference };
    expect(reference(identity)).toEqual(identity);
    expect(() => reference({ ...identity, state: 'available' })).toThrow();
    expect(() => reference({ ...identity, snapshotReference: value.reference })).toThrow();
  });
});

describe('known captured result/prerequisite snapshot branches', () => {
  it.each(['table', 'metrics', 'image'])('retains exact captured %s and scoped context evidence in package2/fixed3', family => {
    const recipe = workflowRecipe({ family, selection: all() }), value = workflowRecord(recipe), item = value.package.results[0];
    expect(normalizeAnalysisSnapshotPreparation(recipe)).toEqual(recipe);
    expect(item.origin.context.parameters.map(item => item.value)).toEqual([false, 0, 'paired']);
    expect(item.origin.contextEvidence).toEqual({ capture: 'fingerprint-checked', environment: 'manifest-checked' });
    expect(canonicalAnalysisSnapshotPackage(value.package)).toBe(canonicalSnapshotJson(value.package));
  });
  it('keeps reference-only captured output identity even without source body permission', () => {
    const recipe = workflowRecipe({ prerequisites: [workflowReferencePrerequisite()] });
    for (const reason of ['opaque', 'unsupported-view', 'restricted-or-unavailable', 'not-included']) {
      const value = workflowRecord(recipe, { referenceReasons: [reason] }); expect(value.package.prerequisites.items[0]).toMatchObject({ reason, integrity: 'not-checked', dataAccess: 'not-granted' });
      expect(canonicalAnalysisSnapshotPackage(value.package)).toBe(canonicalSnapshotJson(value.package));
    }
  });
  it('keeps every v1/C1/C2a request and package canonical unchanged', () => {
    for (const [recipe, record] of [[snapshotRecipe(), snapshotRecord], [linkedRecipe(), linkedRecord], [typedRecipe(), typedRecord]]) {
      const request = canonicalAnalysisSnapshotPreparation(recipe), pkg = canonicalAnalysisSnapshotPackage(record(recipe).package);
      expect(canonicalAnalysisSnapshotPreparation(normalizeAnalysisSnapshotPreparation(recipe))).toBe(request);
      expect(pkg).toBe(canonicalSnapshotJson(record(recipe).package));
    }
  });
  it('allows distinct reviewed context selections for the same source/view but rejects caption-only duplicates', () => {
    const first = workflowRecipe().results[0], selected = workflowRecipe({ selection: all() }).results[0], base = workflowRecipe();
    expect(normalizeAnalysisSnapshotPreparation({ ...base, results: [first, selected] }).results).toHaveLength(2);
    expect(() => normalizeAnalysisSnapshotPreparation({ ...base, results: [first, { ...first, caption: 'Another caption' }] })).toThrow();
    const ref = workflowReferencePrerequisite(); expect(() => normalizeAnalysisSnapshotPreparation(workflowRecipe({ prerequisites: [ref, { ...ref, label: 'Another label' }] }))).toThrow();
  });
  it.each([
    ['context producing claim', value => { value.results[0].origin.context.relation = 'producing-code'; }],
    ['wrong captured step', value => { value.results[0].origin.context.stepId = 'another'; }],
    ['wrong captured SHA', value => { value.results[0].origin.context.snapshotReference.sha256 = 'f'.repeat(64); }],
    ['false environment proof', value => { value.results[0].origin.contextEvidence.environment = 'manifest-checked'; }],
    ['invented evidence field', value => { value.results[0].origin.contextEvidence.execution = 'verified'; }],
    ['negative zero wire value', value => { value.results[0].origin.context.seed = -0; }],
    ['private context field', value => { value.results[0].origin.context.runtime = { storage: '/private' }; }],
    ['context missing selected field', value => { delete value.results[0].origin.context.parameters; }],
  ])('rejects %s in package', (_label, change) => { const value = workflowRecord().package; change(value); expect(() => canonicalAnalysisSnapshotPackage(value)).toThrow(); });
});
