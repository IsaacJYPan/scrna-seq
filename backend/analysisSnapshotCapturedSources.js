'use strict';

const crypto = require('node:crypto');
const storage = require('./storage');
const { snapshotPublicationOutputs } = require('./retainedWorkflowSnapshots');
const { projectTypedSource } = require('./analysisSnapshotTypedSources');
const { validateEnvironmentReference, assertEnvironmentMatches, readEnvironmentArtifact } = require('./rEnvironment');
const snapshots = import('../shared/analysisSnapshotPreparationDispatch.mjs');
const contexts = import('../shared/analysisSnapshotWorkflowContext.mjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const error = (code, message, status = 409) => Object.assign(new Error(message), { code: `ANALYSIS_SNAPSHOT_${code}`, status });
const unavailable = () => error('SOURCE_UNAVAILABLE', 'The exact selected owned capture or output is unavailable.');
const isCapturedResult = selected => selected.kind === 'captured-workflow-output';
const isTypedResult = selected => selected.kind === 'typed-analysis-reference' || isCapturedResult(selected);

function createCapturedSnapshotSources(database, artifacts, provider) {
  async function capture(client, userId, projectId, reference, memo, selectedPorts = null) {
    const key = `${reference.snapshotId}:${reference.sha256}`;
    if (!memo.has(key)) {
      try { memo.set(key, await snapshotPublicationOutputs(client, userId, projectId, reference, selectedPorts)); }
      catch (failure) {
        if (['WORKFLOW_SNAPSHOT_NOT_FOUND', 'WORKFLOW_PUBLICATION_UNSUPPORTED'].includes(failure.code)) throw unavailable();
        throw failure;
      }
    }
    return memo.get(key);
  }
  async function current(client, userId, projectId, recorded) {
    let source;
    try { source = await artifacts.snapshotSourceMetadata(client, userId, projectId, recorded.reference); }
    catch (failure) { if (failure.code === 'ARTIFACT_VERSION_NOT_FOUND') return { source: null, typed: null, reason: 'restricted-or-unavailable' }; throw failure; }
    const typed = await projectTypedSource(source), schema = await snapshots;
    if (recorded.consistent && recorded.descriptor && typed && schema.canonicalSnapshotJson(typed.descriptor) === schema.canonicalSnapshotJson(recorded.descriptor)) return { source, typed, reason: null };
    return { source, typed: null, reason: recorded.consistent && recorded.type === 'rds' && ['org.r-project.rds', 'org.traceomics.seurat-checkpoint'].includes(source.format.id) ? 'opaque' : 'unsupported-view' };
  }
  async function environmentMetadata(client, userId, projectId, expected) {
    const source = await database.getProjectArtifactInternal(userId, projectId, expected.artifact.id, { client });
    if (!source || source.createdByUserId !== Number(userId) || source.artifactType !== 'expert_r_environment' || source.status !== 'available'
        || source.storageKind !== 'local_internal' || source.checksumSha256 !== expected.artifact.checksumSha256 || source.sizeBytes !== expected.artifact.sizeBytes
        || !storage.isProjectStorageKey(source.storageUri, { projectId, kind: 'artifacts' })) throw unavailable();
    try { assertEnvironmentMatches(expected.reference, validateEnvironmentReference(source.metadata?.environment)); }
    catch { throw error('SOURCE_CONTEXT_CHANGED', 'The recorded exact environment relationship is unavailable or changed.'); }
    return { id: source.id, key: source.storageUri, sha256: source.checksumSha256, sizeBytes: source.sizeBytes, reference: expected.reference };
  }
  async function selected(client, userId, projectId, recipe, selection, keys, memo, prerequisite = false) {
    const schema = await snapshots;
    if (!keys.has(schema.canonicalSnapshotJson(selection.snapshotReference))) throw unavailable();
    const selectedPorts = [...recipe.results, ...recipe.prerequisites].filter(item => item.snapshotReference
      && schema.canonicalSnapshotJson(item.snapshotReference) === schema.canonicalSnapshotJson(selection.snapshotReference)).map(item => ({ stepId: item.stepId, port: item.port }));
    const items = await capture(client, userId, projectId, selection.snapshotReference, memo, selectedPorts);
    const recorded = items.find(item => item.stepId === selection.stepId && item.port === selection.port
      && schema.canonicalSnapshotJson(item.reference) === schema.canonicalSnapshotJson(selection.reference));
    if (!recorded) throw unavailable();
    const state = await current(client, userId, projectId, recorded);
    if (prerequisite) return { ...selection, role: 'reference-only', reason: state.reason || 'not-included', integrity: 'not-checked', dataAccess: 'not-granted' };
    if (!state.typed || state.typed.family !== selection.view.family || state.typed.descriptorSha256 !== selection.descriptorSha256) throw error('SOURCE_CHANGED', 'The captured and current output descriptors no longer agree.');
    const api = await contexts;
    let context;
    try { context = api.projectAnalysisSnapshotWorkflowContext({ snapshotReference: selection.snapshotReference, stepId: selection.stepId, port: selection.port, offer: recorded.offer, selection: selection.contextSelection }); }
    catch (failure) { if (failure.code === 'INVALID_ANALYSIS_SNAPSHOT_PREPARATION') throw error('SOURCE_CONTEXT_CHANGED', 'The exact requested recorded context is unavailable.'); throw failure; }
    const contextSha256 = hash(api.canonicalAnalysisSnapshotWorkflowContextBinding({ serviceId: recipe.serviceId, projectId, analysisId: recipe.analysisId, ownerUserId: userId, analysisVersion: recipe.analysisVersion, context }));
    if (contextSha256 !== selection.contextSha256) throw error('SOURCE_CONTEXT_CHANGED', 'The selected recorded context does not match its reviewed exact identity.');
    const environment = context.environment ? await environmentMetadata(client, userId, projectId, recorded.environment) : null;
    const original = { artifact_id: state.source.artifactId, id: state.source.versionId, owner_user_id: state.source.ownerId, checksum_sha256: state.source.checksum,
      size_bytes: state.source.size, name: state.source.name, format_json: state.source.format, storage_key: state.source.key };
    return { original, descriptor: state.typed.descriptor, descriptorSha256: state.typed.descriptorSha256, environment,
      origin: { kind: selection.kind, snapshotReference: selection.snapshotReference, analysisVersion: recipe.analysisVersion, stepId: selection.stepId, port: selection.port,
        reference: selection.reference, caption: selection.caption, captionOrigin: 'user-supplied', context, contextSha256,
        contextEvidence: { capture: 'fingerprint-checked', environment: context.environment ? 'manifest-checked' : 'not-included' } } };
  }
  async function verifyEnvironments(userId, projectId, results) {
    const distinct = new Map(results.filter(item => item.environment).map(item => [item.environment.id, item.environment]));
    for (const item of distinct.values()) {
      try { await readEnvironmentArtifact(provider, { internalStorageKey: item.key, checksumSha256: item.sha256, sizeBytes: item.sizeBytes }, item.reference); }
      catch (failure) {
        if (failure.code?.startsWith('R_ENVIRONMENT_') || failure.code?.startsWith('STORAGE_') || ['UNSAFE_STORAGE_PATH', 'INVALID_STORAGE_KEY', 'EACCES', 'EPERM'].includes(failure.code)) throw error('SOURCE_CONTEXT_CHANGED', 'The exact selected recorded environment could not be verified.');
        throw failure;
      }
      const client = await (await database.connect()).connect();
      try { const currentSource = await environmentMetadata(client, userId, projectId, { artifact: { id: item.id, checksumSha256: item.sha256, sizeBytes: item.sizeBytes }, reference: item.reference });
        if (currentSource.key !== item.key) throw error('SOURCE_CONTEXT_CHANGED', 'The exact selected environment changed while being read.'); }
      finally { client.release(); }
    }
  }
  async function options(client, context, userId, projectId, analysisId, input, canPrepare, saved) {
    const schema = await snapshots, version = Number(input.analysisVersion), limit = input.limit === undefined ? 30 : Number(input.limit);
    if (Object.keys(input).some(key => !['kind', 'analysisVersion', 'snapshotId', 'snapshotSha256', 'limit', 'cursor'].includes(key))
        || !['string', 'number'].includes(typeof input.analysisVersion) || !/^[1-9][0-9]{0,9}$/.test(String(input.analysisVersion)) || !Number.isSafeInteger(version) || version > 2147483647
        || input.limit !== undefined && !['string', 'number'].includes(typeof input.limit) || !/^[1-9][0-9]?$/.test(String(input.limit ?? 30)) || limit > 30
        || typeof input.snapshotId !== 'string' || !/^wfs_[a-f0-9]{24}$/.test(input.snapshotId) || typeof input.snapshotSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.snapshotSha256)) throw error('INVALID_PAGE', 'Choose one exact saved analysis and captured workflow.', 400);
    const reference = { kind: 'workflow-snapshot', snapshotId: input.snapshotId, sha256: input.snapshotSha256 };
    const savedReferences = await saved(version);
    if (!savedReferences.some(item => schema.canonicalSnapshotJson(item) === schema.canonicalSnapshotJson(reference))) throw unavailable();
    const items = await capture(client, userId, projectId, reference, new Map());
    const scope = hash(schema.canonicalSnapshotJson([context.serviceId, Number(userId), projectId, analysisId, version, reference])).slice(0, 32); let position = 0;
    if (input.cursor !== undefined) {
      try {
        if (typeof input.cursor !== 'string' || input.cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
        const bytes = Buffer.from(input.cursor, 'base64url'); if (bytes.toString('base64url') !== input.cursor) throw new Error(); const cursor = JSON.parse(bytes.toString());
        if (!Array.isArray(cursor) || cursor.length !== 3 || cursor[0] !== 'captured-workflow-outputs' || cursor[1] !== scope || !Number.isSafeInteger(cursor[2]) || cursor[2] < 0 || cursor[2] >= items.length) throw new Error(); position = cursor[2];
      } catch { throw error('INVALID_PAGE', 'This captured-output cursor belongs to another saved selection or account.', 400); }
    }
    const response = { schema: 'traceomics.analysis-snapshot-preparation.v1', serviceId: context.serviceId, projectId, analysisId, ownerUserId: Number(userId), canPrepare,
      kind: 'captured-workflow-outputs', analysisVersion: version, snapshotReference: reference, items: [], nextCursor: null };
    while (position < items.length && response.items.length < limit) {
      const item = items[position], state = await current(client, userId, projectId, item);
      response.items.push({ stepId: item.stepId, stepLabel: item.stepLabel, port: item.port, outputLabel: item.outputLabel, reference: item.reference,
        viewFamily: state.typed?.family || null, descriptor: state.typed?.descriptor || null, descriptorSha256: state.typed?.descriptorSha256 || null,
        referenceOnlyReason: state.reason, contextOffer: state.typed ? item.offer : null, integrity: 'not-checked', availability: 'not-checked' });
      if (Buffer.byteLength(JSON.stringify(response)) + 256 > 128 * 1024) { response.items.pop(); break; } position++;
    }
    if (position < items.length && response.items.length) response.nextCursor = Buffer.from(JSON.stringify(['captured-workflow-outputs', scope, position])).toString('base64url');
    return response;
  }
  return { selected, options, verifyEnvironments };
}

module.exports = { createCapturedSnapshotSources, isCapturedResult, isTypedResult };
