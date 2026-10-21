import { describe, expect, it } from 'vitest';
import { canonicalRetainedWorkflowSnapshot, normalizeWorkflowSnapshotOpen, WORKFLOW_SNAPSHOT_LIMITS } from '../shared/workflowSnapshot.mjs';
import { validateResearchAnalysisReference } from '../shared/researchAnalysis.mjs';
const requestId = '550E8400-E29B-41D4-A716-446655440000';
const body = (extra = {}) => ({ requestId, sha256: 'a'.repeat(64), expectedInstance: null, replace: false, ...extra });
const snapshot = () => ({ projectId: 'proj_' + 'a'.repeat(24), ownerUserId: 3, analysisObjectId: 'ao_' + 'b'.repeat(24), packageDigest: 'c'.repeat(64),
  package: { files: { 'main.R': '  inspect("β")\r\n' }, z: 1, a: 2 }, state: { generation: 2, root: { id: 'exact' }, results: {}, active: null } });
describe('exact retained workflow snapshot contract', () => {
  it('binds full captured method/state/object/owner scope and preserves exact source', () => {
    const original = canonicalRetainedWorkflowSnapshot(snapshot());
    expect(original).toContain('  inspect(\\"β\\")\\r\\n');
    expect(canonicalRetainedWorkflowSnapshot({ ...snapshot(), name: 'Another label', id: 'another snapshot' })).toBe(original);
    const item = snapshot(); item.package = { a: 2, z: 1, files: item.package.files };
    expect(canonicalRetainedWorkflowSnapshot(item)).toBe(original);
    for (const extra of [{ projectId: 'another' }, { ownerUserId: 4 }, { analysisObjectId: 'another' }, { packageDigest: 'd'.repeat(64) },
      { package: { files: { 'main.R': 'changed()' } } }, { state: { generation: 3 } }]) {
      expect(canonicalRetainedWorkflowSnapshot({ ...snapshot(), ...extra })).not.toBe(original);
    }
  });
  it('accepts an exact snapshot reference without treating it as an artifact', () => {
    const reference = { kind: 'workflow-snapshot', snapshotId: 'wfs_' + 'a'.repeat(24), sha256: 'b'.repeat(64) };
    expect(validateResearchAnalysisReference(reference)).toEqual(reference);
    for (const extra of [{ snapshotId: 'wfi_' + 'a'.repeat(24) }, { versionId: 'av_fake' }, { sha256: 'B'.repeat(64) }]) {
      expect(() => validateResearchAnalysisReference({ ...reference, ...extra })).toThrow();
    }
  });
  it('requires an original UUID, exact hash and explicit working instance/generation decision', () => {
    expect(normalizeWorkflowSnapshotOpen(body())).toEqual({ ...body(), requestId: requestId.toLowerCase() });
    const expectedInstance = { id: 'wfi_' + 'd'.repeat(24), generation: 8 };
    expect(normalizeWorkflowSnapshotOpen(body({ expectedInstance, replace: true })).expectedInstance).toEqual(expectedInstance);
    for (const extra of [{ expectedInstance: undefined }, { requestId: 'bad' }, { replace: true }, { expectedInstance: { id: expectedInstance.id, generation: -1 } },
      { expectedInstance: { ...expectedInstance, generation: 2147483647 } }, { payload: {} }, { ownerUserId: 1 }]) {
      expect(() => normalizeWorkflowSnapshotOpen(body(extra))).toThrow();
    }
  });
  it('rejects unbounded or non-JSON captured source before hashing', () => {
    expect(() => canonicalRetainedWorkflowSnapshot({ ...snapshot(), state: { value: 'x'.repeat(WORKFLOW_SNAPSHOT_LIMITS.sourceBytes) } })).toThrow();
    const cycle = {}; cycle.self = cycle;
    expect(() => canonicalRetainedWorkflowSnapshot({ ...snapshot(), state: cycle })).toThrow();
    const getter = {}; Object.defineProperty(getter, 'secret', { enumerable: true, get() { throw new Error('Getter executed'); } });
    expect(() => canonicalRetainedWorkflowSnapshot({ ...snapshot(), state: getter })).toThrow('unsupported fields');
  });
});
