'use strict';

const crypto = require('node:crypto');
const contract = import('../shared/researchAnalysis.mjs');
const snapshots = import('../shared/analysisSnapshotPreparationDispatch.mjs');
const { typedSnapshotMetadata } = require('./analysisSnapshotTypedSources');
const SCHEMA = 'traceomics.analysis-snapshot-preparation.v2';
const formats = ['org.ietf.csv', 'org.iana.tsv', 'org.w3.png', 'org.iso.jpeg'];
const failure = (code, message, status = 409) => Object.assign(new Error(message), { code: `ANALYSIS_SNAPSHOT_${code}`, status });
const isLinkedRecipe = recipe => recipe.schema === SCHEMA;
const safeSource = original => ({ artifactId: original.artifact_id, versionId: original.id, ownerUserId: Number(original.owner_user_id),
  sha256: original.checksum_sha256, sizeBytes: Number(original.size_bytes), name: original.name, format: { id: original.format_json.id, version: original.format_json.version } });
function asOriginal(source) {
  return { artifact_id: source.artifactId, id: source.versionId, owner_user_id: source.ownerId, checksum_sha256: source.checksum,
    size_bytes: source.size, name: source.name, format_json: source.format, storage_key: source.key };
}
function support(source) {
  // C1 has no meaning/units projection. Keep explicitly declared typed output
  // semantics for C2 rather than discard them from an apparently complete view.
  if (source.typedDescriptor && Object.hasOwn(source.typedDescriptor, 'semantics')) return { family: null, reason: 'unsupported-view' };
  if (['org.r-project.rds', 'org.traceomics.seurat-checkpoint'].includes(source.format.id)) return { family: null, reason: 'opaque' };
  if (!formats.includes(source.format.id) || source.format.version !== '1' || source.size < 1 || source.size > 200 * 1024 * 1024) return { family: null, reason: 'unsupported-view' };
  const family = ['org.ietf.csv', 'org.iana.tsv'].includes(source.format.id) ? 'table' : 'image';
  return family === 'image' && source.size > 5 * 1024 * 1024 ? { family: null, reason: 'unsupported-view' } : { family, reason: null };
}
async function references(client, projectId, analysisId, analysisVersion) {
  const saved = (await client.query('SELECT snapshot_json FROM research_analysis_revisions WHERE project_id=$1 AND analysis_id=$2 AND version=$3', [projectId, analysisId, analysisVersion])).rows[0]?.snapshot_json;
  if (!saved || !Array.isArray(saved.references) || saved.references.length > 50) throw failure('SOURCE_UNAVAILABLE', 'Choose an exact saved analysis version with recorded references.');
  const validator = await contract;
  return saved.references.map(item => validator.validateResearchAnalysisReference(item));
}
async function metadata(artifacts, client, userId, projectId, reference) {
  if (reference.kind === 'analysis-object') return { source: null, family: null, reason: 'opaque', label: 'Saved checkpoint reference' };
  if (reference.kind === 'workflow-snapshot') return { source: null, family: null, reason: 'unsupported-view', label: 'Saved workflow reference' };
  try {
    const source = await artifacts.snapshotSourceMetadata(client, userId, projectId, reference), accepted = support(source);
    return { source, ...accepted, label: source.name };
  } catch (error) {
    if (error.code !== 'ARTIFACT_VERSION_NOT_FOUND') throw error;
    return { source: null, family: null, reason: 'restricted-or-unavailable', label: 'Saved reference' };
  }
}
function createLinkedSnapshotSources(artifacts, legacySources) {
  async function sources(client, userId, projectId, analysisId, recipe) {
    const schema = await snapshots, saved = await references(client, projectId, analysisId, recipe.analysisVersion);
    const keys = new Set(saved.map(item => schema.canonicalSnapshotJson(item))), legacySelections = recipe.results.filter(item => item.kind === 'attachment-revision');
    const legacy = await legacySources(client, userId, projectId, analysisId, { ...recipe, schema: undefined, results: legacySelections.map(({ kind: _kind, ...item }) => item) });
    const results = []; let attachmentIndex = 0;
    for (const selected of recipe.results) {
      if (selected.kind === 'attachment-revision') {
        const captured = legacy.results[attachmentIndex++];
        captured.original.owner_user_id = userId;
        // New v2 source labels use the same narrow safe owning projection;
        // historical attachment caption/origin remain entirely unchanged.
        const owned = await artifacts.snapshotSourceMetadata(client, userId, projectId, selected.reference); captured.original.name = owned.name;
        results.push(captured); continue;
      }
      if (!keys.has(schema.canonicalSnapshotJson(selected.reference))) throw failure('SOURCE_UNAVAILABLE', 'The selected result is not linked in this exact saved analysis version.');
      if (selected.kind === 'typed-analysis-reference') {
        const typed = await typedSnapshotMetadata(artifacts, client, userId, projectId, selected.reference);
        if (!typed || typed.family !== selected.view.family || typed.descriptorSha256 !== selected.descriptorSha256) throw failure('SOURCE_CHANGED', 'The exact selected typed source or its recorded meaning changed. Review its current descriptor before preparing a new request.');
        results.push({ original: asOriginal(typed.source), descriptor: typed.descriptor, descriptorSha256: typed.descriptorSha256,
          origin: { kind: selected.kind, reference: selected.reference, analysisVersion: recipe.analysisVersion, caption: selected.caption, captionOrigin: 'user-supplied' } });
        continue;
      }
      const selectedSource = await metadata(artifacts, client, userId, projectId, selected.reference);
      if (!selectedSource.source || selectedSource.family !== selected.view.family) throw failure('SOURCE_UNAVAILABLE', 'Choose an owned linked CSV, TSV, PNG or JPEG with a supported fixed view.');
      results.push({ original: asOriginal(selectedSource.source), origin: { kind: 'analysis-reference', reference: selected.reference, analysisVersion: recipe.analysisVersion,
        caption: selected.caption, captionOrigin: 'user-supplied' } });
    }
    const prerequisites = [];
    for (const item of recipe.prerequisites) {
      if (item.kind !== 'analysis-reference') { prerequisites.push(item); continue; }
      if (!keys.has(schema.canonicalSnapshotJson(item.reference))) throw failure('SOURCE_UNAVAILABLE', 'This prerequisite is not recorded in the selected exact saved analysis version.');
      const source = await metadata(artifacts, client, userId, projectId, item.reference);
      prerequisites.push({ ...item, role: 'reference-only', reason: source.reason || 'not-included', integrity: 'not-checked', dataAccess: 'not-granted' });
    }
    const distinct = new Map(results.map(item => [item.original.id, Number(item.original.size_bytes)]));
    if ([...distinct.values()].reduce((a, b) => a + b, 0) > 200 * 1024 * 1024) throw failure('CAPACITY', 'The distinct selected original sources exceed the 200 MiB preparation limit.');
    return { results, documents: legacy.documents, prerequisites };
  }
  async function options(client, context, userId, projectId, analysisId, input, canPrepare) {
    const kind = input.kind, typedOnly = kind === 'analysis-typed-references';
    const version = Number(input.analysisVersion), limit = input.limit === undefined ? 30 : Number(input.limit);
    if (Object.keys(input).some(key => !['kind', 'analysisVersion', 'limit', 'cursor'].includes(key))
        || !['string', 'number'].includes(typeof input.analysisVersion) || typeof input.analysisVersion === 'string' && !/^[1-9][0-9]{0,9}$/.test(input.analysisVersion)
        || !Number.isSafeInteger(version) || version < 1 || version > 2147483647
        || input.limit !== undefined && !['string', 'number'].includes(typeof input.limit) || typeof input.limit === 'string' && !/^[1-9][0-9]?$/.test(input.limit)
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw failure('INVALID_PAGE', 'Choose an exact saved analysis version and page size from 1 to 30.', 400);
    const schema = await snapshots, saved = await references(client, projectId, analysisId, version);
    const scope = crypto.createHash('sha256').update(schema.canonicalSnapshotJson([context.serviceId, Number(userId), projectId, analysisId, version])).digest('hex').slice(0, 16);
    let start = 0;
    if (input.cursor !== undefined) {
      try {
        if (typeof input.cursor !== 'string' || input.cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
        const bytes = Buffer.from(input.cursor, 'base64url'); if (bytes.toString('base64url') !== input.cursor) throw new Error();
        const value = JSON.parse(bytes.toString());
        if (!Array.isArray(value) || value.length !== 4 || value[0] !== kind || value[1] !== scope || value[2] !== version || !Number.isInteger(value[3]) || value[3] < 0 || value[3] >= saved.length) throw new Error();
        start = value[3];
      } catch { throw failure('INVALID_PAGE', 'This linked-reference cursor belongs to a different account or saved analysis version.', 400); }
    }
    const result = { schema: 'traceomics.analysis-snapshot-preparation.v1', serviceId: context.serviceId, projectId, analysisId, ownerUserId: Number(userId),
      canPrepare, kind, analysisVersion: version, items: [], nextCursor: null };
    let position = start;
    while (position < saved.length && result.items.length < limit) {
      const reference = saved[position];
      const source = typedOnly ? await typedSnapshotMetadata(artifacts, client, userId, projectId, reference) : await metadata(artifacts, client, userId, projectId, reference);
      if (!source) { position++; continue; }
      const item = typedOnly ? { reference, label: source.source.name, viewFamily: source.family, descriptor: source.descriptor, descriptorSha256: source.descriptorSha256, integrity: 'not-checked', availability: 'not-checked' }
        : { reference, label: source.label, viewFamily: source.family, referenceOnlyReason: source.reason, integrity: 'not-checked', availability: 'not-checked' };
      result.items.push(item);
      if (Buffer.byteLength(JSON.stringify(result)) + 256 > 128 * 1024) { result.items.pop(); break; }
      position++;
    }
    if (position < saved.length && result.items.length) result.nextCursor = Buffer.from(JSON.stringify([kind, scope, version, position])).toString('base64url');
    return result;
  }
  return { sources, options };
}
module.exports = { createLinkedSnapshotSources, isLinkedRecipe, safeSource };
