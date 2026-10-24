import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSnapshotJson, canonicalAnalysisSnapshotPreparation, canonicalAnalysisSnapshotWorkflowContextBinding } from '../../shared/analysisSnapshotPreparationDispatch.mjs';
import { validateSnapshotPreparation, validateSnapshotPreparationOptions, validateSnapshotPackage, decodeSnapshotPreparationTyped } from './snapshotPreparationValidation';
import { validateSnapshotPublication, validateSnapshotPublicationReceipt } from './snapshotPublicationValidation';
import { snapshotScope } from './snapshotPreparationTestFixtures';
import { typedTableBytes, typedMetricsBytes } from './snapshotTypedTestFixtures';
import { workflowSelection, workflowRecipe, workflowRecord, workflowOptions, workflowReferencePrerequisite, workflowSnapshotReference } from './snapshotWorkflowTestFixtures';
import { publicationFull, publicationScope, publicationAnchor, publicationReceipt } from './snapshotPublicationTestFixtures';

const hash = value => createHash('sha256').update(value).digest('hex'), copy = value => structuredClone(value), error = { code: 'INVALID_SNAPSHOT_PREPARATION_RESPONSE' };
const all = () => workflowSelection({ method: true, parameterKeys: ['include-empty', 'min-cells', 'mode'], seed: true, environment: true });
const binding = value => ({ serviceId: value.serviceId, projectId: value.projectId, analysisId: value.analysisId, ownerUserId: value.ownerUserId,
  preparationId: value.preparationId, snapshotSha256: value.snapshotSha256 });
function reseal(value, contexts = false) {
  if (contexts) for (const item of value.package.results) item.origin.contextSha256 = hash(canonicalAnalysisSnapshotWorkflowContextBinding({ serviceId: value.serviceId, projectId: value.projectId,
    analysisId: value.analysisId, ownerUserId: value.ownerUserId, analysisVersion: value.package.analysis.version, context: item.origin.context }));
  value.snapshotSha256 = hash(canonicalSnapshotJson(value.package)); return value;
}
const options = value => validateSnapshotPreparationOptions(value, snapshotScope, 'captured-workflow-outputs', 2, workflowSnapshotReference());

describe('exact captured workflow package intent and independent context hashes', () => {
  it.each(['table', 'metrics', 'image'])('accepts captured %s, selected false/zero/seed0 and checked environment reference', async family => {
    const recipe = workflowRecipe({ family, selection: all() }), value = workflowRecord(recipe);
    expect(await validateSnapshotPreparation(value, snapshotScope, recipe)).toEqual(value);
    expect(await validateSnapshotPackage(value.package, binding(value))).toEqual(value.package);
    expect(value.package.results[0].origin.context.parameters.map(item => item.value)).toEqual([false, 0, 'paired']);
  });
  it('keeps default-off context empty while retaining exact capture relationship', async () => {
    const value = workflowRecord(), accepted = await validateSnapshotPreparation(value, snapshotScope, value.recipe);
    expect(accepted.package.results[0].origin.context).toMatchObject({ relation: 'recorded-in-capture', method: null, parameters: [], seed: null, environment: null });
    expect(accepted.package.results[0].origin.contextEvidence.environment).toBe('not-included');
  });
  it.each(['table', 'metrics'])('decodes actual fixed %s bytes through captured origin without reading a workflow', async family => {
    const value = workflowRecord(workflowRecipe({ family, selection: all() })), result = value.package.results[0];
    const bytes = family === 'table' ? typedTableBytes(result) : typedMetricsBytes(result);
    expect((await decodeSnapshotPreparationTyped(bytes, result)).family).toBe(family);
  });
  it('shares capture context with viewer17 while package belongs to publisher7', async () => {
    const prepared = workflowRecord(workflowRecipe({ selection: all() })), value = publicationFull({ prepared });
    expect((await validateSnapshotPublication(value, publicationScope, publicationAnchor(value))).package.results[0].origin.context.seed).toBe(0);
    const receipt = publicationReceipt({ current: publicationFull({ prepared, viewerUserId: 7 }) });
    expect((await validateSnapshotPublicationReceipt(receipt, snapshotScope, receipt.request)).current.package.ownerUserId).toBe(7);
  });
  it.each(['opaque', 'unsupported-view', 'restricted-or-unavailable', 'not-included'])('preserves exact captured reference-only prerequisite %s without a capability', async reason => {
    const recipe = workflowRecipe({ prerequisites: [workflowReferencePrerequisite()] }), value = workflowRecord(recipe, { referenceReasons: [reason] });
    expect((await validateSnapshotPreparation(value, snapshotScope, recipe)).package.prerequisites.items[0]).toMatchObject({ reason, role: 'reference-only', integrity: 'not-checked', dataAccess: 'not-granted' });
  });
  it.each(['preparing', 'failed', 'deleted'])('recovers captured original intent in %s without inventing ready context', async state => {
    const recipe = workflowRecipe({ selection: all() }), value = workflowRecord(recipe, { state });
    expect((await validateSnapshotPreparation(value, snapshotScope, recipe)).state).toBe(state); expect(value.package).toBeNull();
  });
  it.each([
    ['unbound context SHA', value => { value.package.results[0].origin.contextSha256 = 'f'.repeat(64); }],
    ['changed context without digest', value => { value.package.results[0].origin.context.seed = 1; }],
    ['producing-code claim', value => { value.package.results[0].origin.context.relation = 'producing-code'; }],
    ['unknown context fields', value => { value.package.results[0].origin.context.privateState = {}; }],
    ['extra proof claim', value => { value.package.results[0].origin.contextEvidence.runtime = 'verified'; }],
    ['wrong environment proof', value => { value.package.results[0].origin.contextEvidence.environment = 'not-included'; }],
    ['wire negative zero', value => { value.package.results[0].origin.context.parameters[1].value = -0; }],
    ['wrong captured step', value => { value.package.results[0].origin.stepId = 'another'; }],
    ['wrong capture source', value => { value.package.results[0].origin.snapshotReference.sha256 = 'f'.repeat(64); }],
    ['wrong selected source owner', value => { value.package.results[0].source.ownerUserId = 17; }],
    ['promoted prerequisite access', value => { value.package.prerequisites.items[0].dataAccess = 'granted'; }],
    ['private context in prerequisite', value => { value.package.prerequisites.items[0].context = {}; }],
  ])('rejects package-rehashed %s', async (_name, change) => {
    const recipe = workflowRecipe({ selection: all(), prerequisites: [workflowReferencePrerequisite()] }), value = workflowRecord(recipe); change(value); reseal(value);
    await expect(validateSnapshotPreparation(value, snapshotScope, recipe)).rejects.toMatchObject(error);
  });
  it('rejects a changed selected setting even when context and package digests were recomputed', async () => {
    const recipe = workflowRecipe({ selection: all() }), value = workflowRecord(recipe); value.package.results[0].origin.context.parameters[0].value = true; reseal(value, true);
    await expect(validateSnapshotPreparation(value, snapshotScope, recipe)).rejects.toMatchObject(error);
  });
  it('keeps context scope anchored to its actual publisher and chosen analysis version', async () => {
    const value = workflowRecord(workflowRecipe({ selection: all() })), item = value.package.results[0];
    item.origin.contextSha256 = hash(canonicalAnalysisSnapshotWorkflowContextBinding({ serviceId: value.serviceId, projectId: value.projectId, analysisId: value.analysisId,
      ownerUserId: 17, analysisVersion: 2, context: item.origin.context })); reseal(value);
    await expect(validateSnapshotPackage(value.package, binding(value))).rejects.toMatchObject(error);
  });
  it('captures original response/intent/scope before awaited context hash work', async () => {
    const value = workflowRecord(workflowRecipe({ selection: all() })), expected = copy(value.recipe), scope = { ...snapshotScope }; let release;
    const gate = new Promise(resolve => { release = resolve; }), digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await gate; return webcrypto.subtle.digest(...args); });
    const pending = validateSnapshotPreparation(value, scope, expected); value.package.results[0].origin.context.seed = 100; scope.userId = 17; expected.results[0].contextSelection.seed = false;
    release(); try { expect((await pending).package.results[0].origin.context.seed).toBe(0); } finally { digest.mockRestore(); }
  });
});

describe('private bound captured-output options', () => {
  it.each(['table', 'metrics', 'image'])('accepts exact capture/N %s options and privately reviewed offers', async family => {
    const value = workflowOptions({ family }); expect(await options(value)).toEqual(value);
    expect(value.items[0].contextOffer.parameters[1].value).toBe(false);
  });
  it.each(['opaque', 'unsupported-view', 'restricted-or-unavailable'])('keeps valid recorded reference %s selectable with no current descriptor/body metadata', async reason => {
    const value = workflowOptions({ reason }), accepted = await options(value); expect(accepted.items[0]).toMatchObject({ viewFamily: null, descriptor: null, descriptorSha256: null, contextOffer: null, referenceOnlyReason: reason });
  });
  it.each([
    ['wrong N', value => { value.analysisVersion++; }], ['wrong capture', value => { value.snapshotReference.sha256 = 'f'.repeat(64); }],
    ['fake available claim', value => { value.items[0].availability = 'available'; }], ['fake integrity claim', value => { value.items[0].integrity = 'verified'; }],
    ['changed descriptor SHA', value => { value.items[0].descriptorSha256 = 'f'.repeat(64); }], ['unbound current source', value => { value.items[0].reference.sha256 = 'f'.repeat(64); }],
    ['wrong context method label', value => { value.items[0].contextOffer.method.stepLabel = 'Another step'; }],
    ['private free text parameter', value => { value.items[0].contextOffer.parameters[0].type = 'text'; }],
    ['negative zero offer', value => { value.items[0].contextOffer.seed = -0; }],
    ['extra current source metadata', value => { value.items[0].source = { path: '/private' }; }],
    ['duplicate step/port', value => { value.items.push(copy(value.items[0])); }],
    ['null descriptor on eligible', value => { value.items[0].descriptor = null; }],
    ['reference-only actual descriptor', value => { value.items[0].viewFamily = null; value.items[0].referenceOnlyReason = 'restricted-or-unavailable'; }],
  ])('rejects %s', async (_name, change) => { const value = workflowOptions(); change(value); await expect(async () => options(value)).rejects.toMatchObject(error); });
  it('requires original capture anchor and refuses service/account confusion', async () => {
    const value = workflowOptions(); await expect(async () => validateSnapshotPreparationOptions(value, snapshotScope, 'captured-workflow-outputs', 2)).rejects.toMatchObject(error);
    await expect(async () => validateSnapshotPreparationOptions(value, { ...snapshotScope, userId: 17 }, 'captured-workflow-outputs', 2, workflowSnapshotReference())).rejects.toMatchObject(error);
  });
  it('does not invoke nested offer getters or prototype code', async () => {
    const value = workflowOptions(), getter = vi.fn(() => 'private'); Object.defineProperty(value.items[0].contextOffer.parameters[0], 'value', { enumerable: true, get: getter });
    await expect(async () => options(value)).rejects.toMatchObject(error); expect(getter).not.toHaveBeenCalled();
  });
  it('captures a chosen snapshot anchor and offer before asynchronous descriptor verification', async () => {
    const value = workflowOptions(), expected = workflowSnapshotReference(); let release;
    const gate = new Promise(resolve => { release = resolve; }), digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await gate; return webcrypto.subtle.digest(...args); });
    const pending = validateSnapshotPreparationOptions(value, snapshotScope, 'captured-workflow-outputs', 2, expected); expected.sha256 = 'f'.repeat(64); value.items[0].contextOffer.parameters[0].value = 100;
    release(); try { expect((await pending).items[0].contextOffer.parameters[0].value).toBe(0); } finally { digest.mockRestore(); }
  });
});

describe('captured typed body descriptor fences', () => {
  it('rejects mismatched capture/context evidence while retaining original fixed body hash', async () => {
    const value = workflowRecord(workflowRecipe({ selection: all() })).package.results[0], bytes = typedTableBytes(value);
    value.origin.context.port = 'other'; await expect(decodeSnapshotPreparationTyped(bytes, value)).rejects.toMatchObject(error);
    const wrong = workflowRecord().package.results[0]; wrong.origin.contextEvidence.environment = 'manifest-checked'; await expect(decodeSnapshotPreparationTyped(typedTableBytes(wrong), wrong)).rejects.toMatchObject(error);
  });
  it('keeps exact fixed view SHA stable when only selected recorded context differs', async () => {
    const first = workflowRecord(), second = workflowRecord(workflowRecipe({ selection: all() }));
    expect(first.package.results[0].view.viewSha256).toBe(second.package.results[0].view.viewSha256); expect(first.snapshotSha256).not.toBe(second.snapshotSha256);
    expect(first.package.results[0].origin.contextSha256).not.toBe(second.package.results[0].origin.contextSha256);
  });
  it('preserves original request canonical when checking the same private record again', async () => {
    const recipe = workflowRecipe({ selection: all() }), before = canonicalAnalysisSnapshotPreparation(recipe), value = workflowRecord(recipe);
    await validateSnapshotPreparation(value, snapshotScope, recipe); expect(canonicalAnalysisSnapshotPreparation(recipe)).toBe(before);
  });
});
