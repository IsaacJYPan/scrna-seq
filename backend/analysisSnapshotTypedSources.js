'use strict';

const crypto = require('node:crypto');
const contract = import('../shared/analysisSnapshotTypedResult.mjs');
const formats = { table: 'org.traceomics.table', metrics: 'org.ietf.json', figure: 'org.w3.png' };

// This is a projection of an already authorized owning source, never another
// source resolver or a grant inferred from a filename, MIME type or JSON body.
async function projectTypedSource(source) {
  const original = source.typedDescriptor;
  if (source.sourceKind !== 'workflow-output' || !original || !Object.hasOwn(formats, original.type)
      || source.format.id !== formats[original.type] || source.format.version !== '1'
      || original.id !== source.versionId || original.sha256 !== source.checksum || original.sizeBytes !== source.size
      || source.size < 1 || source.size > 5 * 1024 * 1024) return null;
  const schema = await contract;
  let descriptor;
  try {
    descriptor = schema.normalizeAnalysisSnapshotTypedDescriptor({ schema: schema.ANALYSIS_SNAPSHOT_TYPED_DESCRIPTOR_SCHEMA,
      id: original.id, type: original.type, sha256: original.sha256, sizeBytes: original.sizeBytes,
      profileId: original.profileId ?? null, semantics: original.semantics ?? {} });
  } catch (failure) {
    if (![400, 413].includes(failure.status)) throw failure;
    return null;
  }
  return { descriptor, descriptorSha256: crypto.createHash('sha256').update(schema.canonicalAnalysisSnapshotTypedDescriptor(descriptor)).digest('hex'),
    family: original.type === 'figure' ? 'image' : original.type };
}

async function typedSnapshotMetadata(artifacts, client, userId, projectId, reference) {
  if (reference.kind !== 'artifact-version') return null;
  try {
    const source = await artifacts.snapshotSourceMetadata(client, userId, projectId, reference);
    const projection = await projectTypedSource(source);
    return projection ? { source, ...projection } : null;
  } catch (failure) {
    if (failure.code !== 'ARTIFACT_VERSION_NOT_FOUND') throw failure;
    return null;
  }
}

module.exports = { projectTypedSource, typedSnapshotMetadata };
