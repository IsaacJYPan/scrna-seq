const scalar = value => value === null || typeof value === 'boolean' || typeof value === 'string' && value.length <= 2000 || typeof value === 'number' && Number.isFinite(value);
const optionalText = value => value === null || typeof value === 'string' && value.length <= 200;
export function validRetainedTypedPreview(value) {
  if (!value || !value.semantics || ![null, 'primary', 'diagnostic'].includes(value.semantics.role) || !optionalText(value.semantics.title)) return false;
  if (value.family === 'metrics') return Array.isArray(value.items) && value.items.length <= 40
    && new Set(value.items.map(item => item?.key)).size === value.items.length
    && value.items.every(item => item && typeof item.key === 'string' && item.key.length <= 100 && scalar(item.value) && optionalText(item.label) && optionalText(item.unit));
  if (value.family !== 'embedding') return false;
  const count = value.x?.length, sample = value.sampling;
  return Array.isArray(value.x) && count <= 5000 && value.x.every(Number.isFinite)
    && Array.isArray(value.y) && value.y.length === count && value.y.every(Number.isFinite)
    && Array.isArray(value.sourceIndices) && value.sourceIndices.length === count && new Set(value.sourceIndices).size === count
    && sample && Number.isSafeInteger(sample.sourceCount) && sample.sourceCount >= count && sample.sourceCount <= 100000
    && sample.returnedCount === count && Number.isSafeInteger(sample.requestedLimit) && sample.requestedLimit >= count && sample.requestedLimit <= 5000
    && ['none', 'sha256-priority-v1'].includes(sample.method) && sample.sampled === (sample.sourceCount > count)
    && sample.method === (sample.sampled ? 'sha256-priority-v1' : 'none') && sample.aggregated === false && sample.stratified === false && typeof sample.budgetLimited === 'boolean'
    && value.sourceIndices.every(index => Number.isSafeInteger(index) && index >= 0 && index < sample.sourceCount)
    && value.identity?.scope === 'exact-source-version' && value.identity.indexBase === 0
    && (value.ids === null ? value.identity.kind === 'source-row-positions' : Array.isArray(value.ids) && value.ids.length === count
      && value.identity.kind === 'source-identifiers' && new Set(value.ids).size === count && value.ids.every(id => typeof id === 'string' && id.length <= 200))
    && (value.groups === undefined || Array.isArray(value.groups) && value.groups.length === count && new Set(value.groups).size <= 40 && value.groups.every(group => typeof group === 'string' && group.length <= 100))
    && [null, 'cell', 'sample', 'observation', 'feature', 'point'].includes(value.semantics.entityType)
    && ['x', 'y'].every(axis => value.semantics.axes?.[axis] && optionalText(value.semantics.axes[axis].label) && optionalText(value.semantics.axes[axis].unit));
}

export function assertRetainedTypedSource(preview, version) {
  if (!['metrics', 'embedding'].includes(preview?.family)) return;
  const source = preview.source;
  if (!validRetainedTypedPreview(preview) || !source || !version.artifactId || source.artifactId !== version.artifactId
      || source.versionId !== version.versionId || source.projectId !== version.projectId || source.sha256 !== version.sha256) {
    throw Object.assign(new Error('The typed preview does not match the exact saved source.'), { status: 409 });
  }
}
