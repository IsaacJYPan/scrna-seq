export function hasAttachedLiveRObject(datasetInfo) {
  return Boolean(datasetInfo?.id && datasetInfo.liveState === 'attached');
}
