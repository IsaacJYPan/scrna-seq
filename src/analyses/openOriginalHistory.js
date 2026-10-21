import { mapBackendAnalysisObject } from '../backendWorkspaceModel';

const dirty = () => Object.assign(new Error('Save your current live analysis in Data workspace before switching objects.'), { code: 'UNSAVED_LIVE_WORK' });
const changed = () => Object.assign(new Error('The selected workspace changed. Open the source again from its project.'), { code: 'TARGET_CHANGED' });

// Read metadata without changing selection or its cache. The caller commits the
// navigation synchronously only after this final scope/dirty-state check.
export function originalHistoryScopeChanged(before, after, target, currentTarget, selection, currentSelection) {
  return after.userId !== before.userId || after.projectId !== before.projectId || after.workspaceId !== before.workspaceId
    || after.activeTab !== before.activeTab || after.objectId !== before.objectId || currentSelection !== selection
    || currentTarget.blocked || currentTarget.identity !== target.identity || currentTarget.epoch !== target.epoch;
}

export async function prepareOriginalObjectHistory({ api, objectId, getScope, getTarget, getSelection, allowDirtyRead = false }) {
  const before = { ...getScope() }, target = getTarget(), selection = getSelection();
  if (!before.projectId) throw new Error('Choose a project first.');
  if (target.blocked) throw changed();
  if (!allowDirtyRead && before.unsavedLiveChanges && before.objectId !== objectId) throw dirty();
  const objects = (await api.listProjectAnalysisObjects(before.projectId)).map(mapBackendAnalysisObject);
  const after = getScope(), currentTarget = getTarget();
  if (originalHistoryScopeChanged(before, after, target, currentTarget, selection, getSelection())) throw changed();
  if (!allowDirtyRead && after.unsavedLiveChanges && after.objectId !== objectId) throw dirty();
  if (!objects.some(object => object.id === objectId && object.projectId === before.projectId)) throw new Error('The original object is no longer available in this project.');
  return { projectId: before.projectId, objects, selectObject: after.objectId !== objectId };
}
