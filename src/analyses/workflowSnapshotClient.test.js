import { describe, expect, it } from 'vitest';
import { WORKFLOW_RESTORATION_SCHEMA } from '../../shared/workflowSnapshot.mjs';
import { validateWorkflowRestoration } from './workflowSnapshotClient';

const identity = (prefix, value) => `${prefix}_${value.repeat(24)}`;
const setup = ({ replacing = false } = {}) => {
  const snapshot = { id: identity('wfs', 'a'), sha256: 'b'.repeat(64), projectId: identity('proj', 'c'),
    analysisObjectId: identity('ao', 'd'), packageDigest: 'e'.repeat(64), state: { generation: 3 } };
  const request = { requestId: '550e8400-e29b-41d4-a716-446655440000', sha256: snapshot.sha256,
    expectedInstance: replacing ? { id: identity('wfi', 'f'), generation: 8 } : null, replace: replacing };
  const instanceId = request.expectedInstance?.id || identity('wfi', '1');
  const generation = (request.expectedInstance?.generation ?? snapshot.state.generation) + 1;
  const result = { replayed: false, canEditWorking: true, restoration: { schema: WORKFLOW_RESTORATION_SCHEMA,
    requestId: request.requestId, snapshotId: snapshot.id, sha256: snapshot.sha256, analysisObjectId: snapshot.analysisObjectId,
    packageDigest: snapshot.packageDigest, instanceId, generation, createdAt: '2026-10-20T00:00:00.000Z' },
  currentInstance: { id: instanceId, projectId: snapshot.projectId, analysisObjectId: snapshot.analysisObjectId,
    packageDigest: snapshot.packageDigest, package: { tabs: [{ id: 'overview' }, { id: 'cell-counts' }] },
    state: { generation, active: null, results: {} } } };
  return { snapshot, request, result, validate: () => validateWorkflowRestoration(result, snapshot, request) };
};
const invalid = validate => expect(validate).toThrow(expect.objectContaining({ code: 'INVALID_WORKFLOW_RESTORATION_RESPONSE' }));

describe('saved workflow restoration confirmation', () => {
  it.each([false, true])('accepts a correctly bound %s replacement receipt without changing source or response', replacing => {
    const state = setup({ replacing }), before = JSON.stringify(state);
    expect(state.validate()).toBe(state.result);
    expect(JSON.stringify(state)).toBe(before);
  });

  it.each([
    ['schema', 'traceomics.workflow-restoration.v2'],
    ['requestId', '550e8400-e29b-41d4-a716-446655440001'],
    ['snapshotId', identity('wfs', '2')],
    ['sha256', '2'.repeat(64)],
    ['analysisObjectId', identity('ao', '2')],
    ['packageDigest', '2'.repeat(64)],
    ['instanceId', 'wfi_invalid'],
    ['generation', -1],
    ['generation', 4.5],
    ['generation', 2147483647],
    ['generation', '4'],
  ])('rejects a receipt with an incorrect %s', (field, value) => {
    const state = setup(); state.result.restoration[field] = value; invalid(state.validate);
  });

  it('binds the receipt to both the requested source hash and the reviewed snapshot hash', () => {
    const state = setup(); state.request.sha256 = '2'.repeat(64); state.result.restoration.sha256 = state.request.sha256;
    invalid(state.validate);
  });

  it('requires the accepted generation to advance exactly once from the captured source for a new instance', () => {
    for (const delta of [-1, 0, 2, 10]) {
      const state = setup(); state.result.restoration.generation = state.snapshot.state.generation + delta;
      state.result.currentInstance.state.generation = state.result.restoration.generation;
      invalid(state.validate);
    }
  });

  it('advances from the explicitly identified working generation rather than the older saved source', () => {
    const state = setup({ replacing: true });
    expect(state.result.restoration.generation).toBe(9); expect(state.snapshot.state.generation).toBe(3);
    expect(state.validate()).toBe(state.result);
    state.result.restoration.generation = state.snapshot.state.generation + 1;
    state.result.currentInstance.state.generation = state.result.restoration.generation;
    invalid(state.validate);
  });

  it('rejects a replacement receipt for another valid instance even if its current head agrees', () => {
    const state = setup({ replacing: true });
    state.result.restoration.instanceId = identity('wfi', '2'); state.result.currentInstance.id = state.result.restoration.instanceId;
    invalid(state.validate);
  });

  it.each([
    ['id', identity('wfi', '2')],
    ['projectId', identity('proj', '2')],
    ['analysisObjectId', identity('ao', '2')],
    ['packageDigest', '2'.repeat(64)],
  ])('rejects a current head with a different %s', (field, value) => {
    const state = setup(); state.result.currentInstance[field] = value; invalid(state.validate);
  });

  it.each([-1, 1.5, 2147483647, '4', undefined])('rejects invalid current generation %s', generation => {
    const state = setup(); state.result.currentInstance.state.generation = generation; invalid(state.validate);
  });

  it('rejects a current head older than the accepted receipt even on a replay', () => {
    const state = setup(); state.result.replayed = true;
    state.result.currentInstance.state.generation = state.result.restoration.generation - 1;
    invalid(state.validate);
  });

  it.each([undefined, {}, { package: { tabs: [] } }, { package: { tabs: [{ id: '../escape' }] } }, { package: { tabs: [{ id: 'Uppercase' }] } }])('rejects an absent or unusable current head %j', replacement => {
    const state = setup(); state.result.currentInstance = replacement === undefined ? undefined : { ...state.result.currentInstance, ...replacement };
    if (replacement && !Object.keys(replacement).length) state.result.currentInstance = {};
    invalid(state.validate);
  });

  it.each(['replayed', 'canEditWorking'])('requires an explicit boolean %s instead of inferring permission or replay status', field => {
    for (const value of [undefined, null, 0, 1, 'true', {}]) {
      const state = setup(); state.result[field] = value; invalid(state.validate);
    }
  });

  it('accepts the original receipt with newer current state without replacing it with the saved snapshot', () => {
    const state = setup({ replacing: true }); state.result.replayed = true;
    state.result.currentInstance.state = { generation: 13, active: { jobId: 'newer_job' }, results: { inspection: { parameters: { donor: 'newer donor' } } } };
    const newer = state.result.currentInstance, accepted = state.result.restoration;
    expect(state.validate()).toBe(state.result);
    expect(state.result.currentInstance).toBe(newer); expect(state.result.restoration).toBe(accepted);
    expect(state.result.restoration.generation).toBe(9); expect(state.result.currentInstance.state.generation).toBe(13);
  });

  it('confirms an original replay after writer access is removed while preserving its read-only newer head', () => {
    const state = setup(); state.result.replayed = true; state.result.canEditWorking = false;
    state.result.currentInstance.state.generation += 2;
    expect(state.validate()).toBe(state.result); expect(state.result.canEditWorking).toBe(false);
    expect(state.result.currentInstance.state.generation).toBe(6);
  });

  it.each([true, false])('confirms a replay after the original working copy closed with writer permission %s', canEditWorking => {
    const state = setup(); state.result.replayed = true; state.result.canEditWorking = canEditWorking; state.result.currentInstance = null;
    expect(state.validate()).toBe(state.result); expect(state.result.currentInstance).toBeNull();
  });

  it('rejects a fresh acceptance that claims there is no working head', () => {
    const state = setup(); state.result.currentInstance = null; invalid(state.validate);
  });

  it.each([null, undefined, {}, { restoration: null }])('rejects an absent confirmation %j', result => {
    const state = setup(); invalid(() => validateWorkflowRestoration(result, state.snapshot, state.request));
  });
});
