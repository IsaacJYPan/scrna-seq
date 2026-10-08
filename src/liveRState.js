export function hasAttachedLiveRObject(datasetInfo) {
  return Boolean(datasetInfo?.id && datasetInfo.liveState === 'attached');
}

export function reconcileRestoredSession(currentUser, restoredUser) {
  if (currentUser?.email) return currentUser;
  return restoredUser?.email ? restoredUser : null;
}

export function consumeSavedObjectSelection(expectedObjectId, selectedObjectId) {
  const preserve = Boolean(expectedObjectId && selectedObjectId && expectedObjectId === selectedObjectId);
  return { preserve, nextExpectedObjectId: preserve ? null : expectedObjectId };
}

export function pipelineProbeAction({ currentKey, nextKey, serverAttached, liveState }) {
  if (currentKey !== nextKey) return 'probe';
  if (!serverAttached && liveState === 'attached') return 'probe';
  return 'skip';
}

export const PIPELINE_PROBE_MAX_RETRIES = 8;

export function pipelineProbeRetryDelay(attempt, jitter = 0) {
  const safeAttempt = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
  const safeJitter = Number.isFinite(jitter) ? Math.min(250, Math.max(0, jitter)) : 0;
  return Math.min(5_000, 500 * (2 ** (safeAttempt - 1))) + safeJitter;
}

export function serverUnsavedLiveChanges(state) {
  if (state?.exists === false) return false;
  if (typeof state?.has_unsaved_changes === 'boolean') return state.has_unsaved_changes;
  if (Number.isSafeInteger(state?.live_revision) && state.live_revision >= 0) {
    if (state.saved_revision === null) return true;
    if (Number.isSafeInteger(state.saved_revision) && state.saved_revision >= 0) {
      return state.live_revision !== state.saved_revision;
    }
  }
  // An older server cannot establish a saved baseline.
  return null;
}
