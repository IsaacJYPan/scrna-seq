'use strict';

// Only existing owning file adapters may offer inert source text. A typed
// result, opaque job artifact or caller-supplied filename is never promoted.
function projectInertSource(source) {
  return ['managed-file', 'private-input'].includes(source.sourceKind) && !source.typedDescriptor
    && ['org.ietf.text', 'org.ietf.json'].includes(source.format.id) && source.format.version === '1'
    && Number.isSafeInteger(source.size) && source.size >= 0 && source.size <= 200 * 1024 * 1024
    ? { source, family: 'text' } : null;
}
async function inertSnapshotMetadata(artifacts, client, userId, projectId, reference) {
  if (reference.kind !== 'artifact-version') return null;
  try { return projectInertSource(await artifacts.snapshotSourceMetadata(client, userId, projectId, reference)); }
  catch (failure) { if (failure.code !== 'ARTIFACT_VERSION_NOT_FOUND') throw failure; return null; }
}
module.exports = { projectInertSource, inertSnapshotMetadata };
