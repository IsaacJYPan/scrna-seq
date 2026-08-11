export function hasAttachedLiveRObject(datasetInfo) {
  return Boolean(datasetInfo?.id && datasetInfo.liveState === 'attached');
}

export function pipelineProbeAction({ currentKey, nextKey, serverAttached, liveState }) {
  if (currentKey !== nextKey) return 'probe';
  if (serverAttached && liveState !== 'attached') return 'project-attached';
  if (!serverAttached && liveState === 'attached') return 'probe';
  return 'skip';
}
