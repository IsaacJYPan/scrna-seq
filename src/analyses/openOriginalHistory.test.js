import { describe, expect, it, vi } from 'vitest';
import { prepareOriginalObjectHistory } from './openOriginalHistory';

function setup() {
  let resolve;
  const pending = new Promise(yes => { resolve = yes; });
  const scope = { userId: 1, projectId: 'proj_one', workspaceId: 'workspace', objectId: 'ao_current', activeTab: 'analyses', unsavedLiveChanges: false };
  const target = { identity: 'server', epoch: 2, blocked: false };
  const api = { listProjectAnalysisObjects: vi.fn(() => pending) };
  const select = { version: 0 };
  const run = () => prepareOriginalObjectHistory({ api, objectId: 'ao_saved', getScope: () => scope,
    getTarget: () => ({ ...target }), getSelection: () => select.version });
  const finish = () => resolve([{ id: 'ao_saved', projectId: 'proj_one', ownerUserId: 1, displayName: 'Saved donor study', metadata: {} }]);
  return { api, scope, target, select, run, finish };
}

describe('deliberate original history navigation', () => {
  it('reads only source metadata and prepares the explicitly requested object', async () => {
    const state = setup(), result = state.run(); state.finish();
    expect(await result).toMatchObject({ projectId: 'proj_one', objects: [{ id: 'ao_saved' }], selectObject: true });
    expect(state.api.listProjectAnalysisObjects).toHaveBeenCalledExactlyOnceWith('proj_one');
    expect(state.scope.objectId).toBe('ao_current');
  });
  it('blocks before fetching when another object has unsaved live changes', async () => {
    const state = setup(); state.scope.unsavedLiveChanges = true;
    await expect(state.run()).rejects.toMatchObject({ code: 'UNSAVED_LIVE_WORK' });
    expect(state.api.listProjectAnalysisObjects).not.toHaveBeenCalled();
  });
  it('preserves live work that becomes dirty during the metadata request', async () => {
    const state = setup(), result = state.run(); state.scope.unsavedLiveChanges = true; state.finish();
    await expect(result).rejects.toMatchObject({ code: 'UNSAVED_LIVE_WORK' });
    expect(state.scope.objectId).toBe('ao_current');
  });
  it.each(['userId', 'projectId', 'workspaceId', 'activeTab', 'objectId'])('rejects a late response after %s changes', async field => {
    const state = setup(), result = state.run(); state.scope[field] = 'different'; state.finish();
    await expect(result).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  });
  it.each(['epoch', 'identity', 'blocked'])('rejects a late response after the server %s changes', async field => {
    const state = setup(), result = state.run(); state.target[field] = field === 'blocked' ? true : field === 'epoch' ? 3 : 'another'; state.finish();
    await expect(result).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  });
  it('rejects a restored selection and preserves dirty work when history is already for that object', async () => {
    const state = setup(), result = state.run(); state.select.version += 1; state.finish();
    await expect(result).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
    state.scope.objectId = 'ao_saved'; state.scope.unsavedLiveChanges = true;
    expect(await state.run()).toMatchObject({ selectObject: false });
  });
});
