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
