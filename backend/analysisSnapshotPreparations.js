'use strict';

const crypto = require('node:crypto');
const db = require('./pgDatabase');
const storage = require('./storage');
const config = require('./config');
const { getServiceExecutionIdentity } = require('./executionTargets');
const { createArtifactVersionService } = require('./artifactVersions');
const { createLinkedSnapshotSources, isLinkedRecipe, safeSource: linkedSource } = require('./analysisSnapshotLinkedSources');
const { createCapturedSnapshotSources, isTypedResult } = require('./analysisSnapshotCapturedSources');
const contract = import('../shared/analysisSnapshotPreparationDispatch.mjs');
const documents = import('../shared/notebookDocument.mjs');
const READ = ['owner', 'admin', 'analyst', 'viewer'], WRITE = ['owner', 'admin', 'analyst'];
const formats = ['org.ietf.csv', 'org.iana.tsv', 'org.w3.png', 'org.iso.jpeg'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const id = prefix => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const iso = value => new Date(value).toISOString();
const error = (code, message, status = 409) => Object.assign(new Error(message), { code: `ANALYSIS_SNAPSHOT_${code}`, status });
const missing = () => { throw error('PREPARATION_NOT_FOUND', 'This private preparation is not confirmed for this account and analysis.', 404); };
const scopeMissing = () => { throw error('SCOPE_NOT_FOUND', 'Current access to this project and analysis could not be confirmed.', 404); };
const active = new Map();
const retainedError = () => error('VIEW_UNAVAILABLE', 'The exact retained view is missing or failed its integrity check. Its original preparation remains recorded.');
const budget = (value, maximum, message) => { if (value > maximum) throw error('CAPACITY', message); };

function createAnalysisSnapshotPreparationService(database = db, provider = storage.createLocalStorageProvider()) {
  const artifacts = createArtifactVersionService(database, provider);
  const captures = createCapturedSnapshotSources(database, artifacts, provider);
  const linked = createLinkedSnapshotSources(artifacts, legacySources, captures);
  async function transaction(userId, projectId, analysisId, action) {
    if (!/^proj_[a-f0-9]{16,40}$/.test(projectId || '') || !/^ra_[a-f0-9]{24}$/.test(analysisId || '')) scopeMissing();
    const client = await (await database.connect()).connect(); let committing = false, destroy = false;
    try {
      await client.query('BEGIN');
      const user = (await client.query('SELECT id,is_demo_guest FROM users WHERE id=$1 FOR KEY SHARE', [userId])).rows[0];
      if (!user || !(await client.query('SELECT id FROM projects WHERE id=$1 FOR SHARE', [projectId])).rowCount) scopeMissing();
      const member = (await client.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR SHARE', [projectId, userId])).rows[0];
      if (!member || !READ.includes(member.role)) scopeMissing();
      const analysis = (await client.query('SELECT id,status FROM research_analyses WHERE id=$1 AND project_id=$2 FOR SHARE', [analysisId, projectId])).rows[0];
      if (!analysis) scopeMissing();
      const serviceId = (await client.query('SELECT service_id FROM service_execution_identity WHERE singleton=TRUE')).rows[0]?.service_id
        || (await getServiceExecutionIdentity(client)).id;
      const context = { user, member, analysis, serviceId };
      const result = await action(client, context);
      committing = true; await client.query('COMMIT'); committing = false;
      return result;
    } catch (failure) {
      if (committing) { failure.snapshotUncertainCommit = true; destroy = true; }
      try { await client.query('ROLLBACK'); } catch { destroy = true; }
      throw failure;
    } finally { client.release(destroy); }
  }
  const writable = context => WRITE.includes(context.member.role) && context.analysis.status === 'active' && !context.user.is_demo_guest && !config.demoMode();
  function assertWritable(context) {
    if (!WRITE.includes(context.member.role) || context.user.is_demo_guest || config.demoMode()) throw error('WRITE_REQUIRED', 'Current project write access is required to prepare retained views.', 403);
    if (context.analysis.status !== 'active') throw error('ANALYSIS_ARCHIVED', 'Restore this analysis before preparing new retained views.');
  }
  async function row(client, userId, projectId, analysisId, preparationId, lock = false) {
    if (!(await contract).ANALYSIS_SNAPSHOT_PREPARATION_ID.test(preparationId || '')) missing();
    const value = (await client.query(`SELECT * FROM research_analysis_snapshot_preparations WHERE id=$1 AND project_id=$2 AND analysis_id=$3 AND owner_user_id=$4${lock ? ' FOR UPDATE' : ''}`,
      [preparationId, projectId, analysisId, userId])).rows[0];
    if (!value) missing(); return value;
  }
  const fields = value => ({ artifactId: value.artifact_id, versionId: value.id, sha256: value.checksum_sha256,
    sizeBytes: Number(value.size_bytes), name: value.name, format: { id: value.format_json.id, version: value.format_json.version } });
  function eligible(value, projectId) {
    return value && /^av_[a-f0-9]{24}$/.test(value.id) && /^af_[a-f0-9]{24}$/.test(value.artifact_id)
      && /^[a-f0-9]{64}$/.test(value.checksum_sha256) && formats.includes(value.format_json?.id) && value.format_json.version === '1'
      && Number.isSafeInteger(Number(value.size_bytes)) && Number(value.size_bytes) > 0 && Number(value.size_bytes) <= 200 * 1024 * 1024
      && storage.isProjectStorageKey(value.storage_key, { projectId, kind: 'artifacts' });
  }
  function attachment(value) {
    return { attachmentId: value.attachment_id, revisionId: value.id, revisionNumber: Number(value.revision_number),
      caption: value.caption, suppliedOrigin: value.supplied_origin_json, createdByUserId: Number(value.actor_user_id),
      createdAt: iso(value.created_at), sourceOwnerUserId: Number(value.source_owner_user_id) };
  }
  async function analysisProjection(client, projectId, analysisId, version) {
    const saved = (await client.query('SELECT snapshot_json FROM research_analysis_revisions WHERE project_id=$1 AND analysis_id=$2 AND version=$3', [projectId, analysisId, version])).rows[0]?.snapshot_json;
    if (!saved) throw error('SOURCE_UNAVAILABLE', 'The selected exact saved analysis version is unavailable.');
    return { version: saved.version, name: saved.name, description: saved.description, status: saved.status,
      createdByUserId: saved.createdByUserId, createdAt: saved.createdAt, updatedAt: saved.updatedAt,
      revisionSha256: hash((await contract).canonicalSnapshotJson(saved)) };
  }
  async function sources(client, userId, projectId, analysisId, recipe) {
    return isLinkedRecipe(recipe) ? linked.sources(client, userId, projectId, analysisId, recipe) : legacySources(client, userId, projectId, analysisId, recipe);
  }
  async function legacySources(client, userId, projectId, analysisId, recipe) {
    const result = [], sourceBytes = new Map();
    for (const selected of recipe.results) {
      const revision = (await client.query('SELECT * FROM research_analysis_attachment_revisions WHERE id=$1 AND attachment_id=$2 AND project_id=$3 AND analysis_id=$4',
        [selected.revisionId, selected.attachmentId, projectId, analysisId])).rows[0];
      if (!revision || Number(revision.source_owner_user_id) !== Number(userId) || revision.reference_json.kind !== selected.reference.kind
          || revision.reference_json.versionId !== selected.reference.versionId || revision.reference_json.sha256 !== selected.reference.sha256) throw error('SOURCE_UNAVAILABLE', 'Choose an exact attachment revision whose saved source is owned by your account.');
      const original = (await client.query('SELECT * FROM managed_artifact_versions WHERE id=$1 AND project_id=$2 AND owner_user_id=$3 FOR KEY SHARE', [selected.reference.versionId, projectId, userId])).rows[0];
      if (!eligible(original, projectId) || original.checksum_sha256 !== selected.reference.sha256) throw error('SOURCE_UNAVAILABLE', 'The exact selected CSV, TSV, PNG or JPEG source is unavailable.');
      const family = ['org.ietf.csv', 'org.iana.tsv'].includes(original.format_json.id) ? 'table' : 'image';
      if (family !== selected.view.family || family === 'image' && Number(original.size_bytes) > 5 * 1024 * 1024) throw error('VIEW_UNSUPPORTED', 'The selected source cannot supply that bounded retained view.');
      sourceBytes.set(original.id, Number(original.size_bytes)); result.push({ revision, original });
    }
    budget([...sourceBytes.values()].reduce((a, b) => a + b, 0), 200 * 1024 * 1024, 'The distinct original result sources exceed the 200 MiB preparation limit.');
    const savedDocuments = [];
    for (const selected of recipe.documents) {
      const saved = (await client.query('SELECT * FROM research_document_revisions WHERE document_id=$1 AND id=$2 AND project_id=$3 AND analysis_id=$4',
        [selected.documentId, selected.versionId, projectId, analysisId])).rows[0];
      if (!saved || saved.sha256 !== selected.sha256 || Number(saved.content_bytes) > 1024 * 1024) throw error('SOURCE_UNAVAILABLE', 'The exact selected supporting source version is unavailable.');
      savedDocuments.push(saved);
    }
    return { results: result, documents: savedDocuments };
  }
  async function availability(client, value) {
    if (value.state !== 'ready') return null;
    const blobs = (await client.query('SELECT id,sha256,size_bytes,content FROM research_analysis_snapshot_blobs WHERE preparation_id=$1', [value.id])).rows;
    const byId = new Map(blobs.map(blob => [blob.id, blob]));
    const available = descriptor => {
      const blob = byId.get(descriptor.viewId), expected = descriptor.view || descriptor;
      return blob && blob.sha256 === expected.blobSha256 && blob.size_bytes === expected.blobBytes && blob.content.length === expected.blobBytes
        && hash(blob.content) === expected.blobSha256 ? 'available' : 'unavailable';
    };
    const views = value.package_json.results.map(item => ({ viewId: item.viewId, status: available(item) }));
    const documentItems = value.package_json.documents.map(item => ({ documentId: item.documentId, versionId: item.versionId, status: available(item) }));
    return { status: [...views, ...documentItems].every(item => item.status === 'available') ? 'available' : 'unavailable', views, documents: documentItems };
  }
  function envelope(value, context, replayed, currentAvailability) {
    const canPrepare = writable(context);
    return { schema: 'traceomics.analysis-snapshot-preparation.v1', serviceId: value.service_id, projectId: value.project_id,
      analysisId: value.analysis_id, ownerUserId: Number(value.owner_user_id), preparationId: value.id, requestId: value.request_id,
      requestSha256: value.request_sha256, createdAt: iso(value.created_at), updatedAt: iso(value.updated_at), replayed,
      state: value.state, canPrepare, canResume: canPrepare && ['preparing', 'failed'].includes(value.state), canDelete: value.state !== 'deleted',
      recipe: value.recipe_json, snapshotSha256: value.snapshot_sha256, package: value.package_json, availability: currentAvailability, failure: value.failure_json };
  }
  async function observe(userId, projectId, analysisId, preparationId, replayed = false) {
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const value = await row(client, userId, projectId, analysisId, preparationId);
      const result = envelope(value, context, replayed, await availability(client, value));
      budget(Buffer.byteLength(JSON.stringify(result)), (await contract).ANALYSIS_SNAPSHOT_PREPARATION_LIMITS.fullBytes, 'The preparation metadata exceeds its bounded response.');
      return result;
    });
  }
  async function byRequest(userId, projectId, analysisId, requestId) {
    if (!UUID.test(requestId || '')) missing();
    const preparationId = await transaction(userId, projectId, analysisId, async client => {
      const found = (await client.query('SELECT id FROM research_analysis_snapshot_preparations WHERE project_id=$1 AND analysis_id=$2 AND owner_user_id=$3 AND request_id=$4', [projectId, analysisId, userId, requestId.toLowerCase()])).rows[0];
      if (!found) missing(); return found.id;
    });
    return observe(userId, projectId, analysisId, preparationId, true);
  }
  async function prepare(userId, projectId, analysisId, input) {
    const schema = await contract, recipe = schema.normalizeAnalysisSnapshotPreparation(input), canonical = schema.canonicalAnalysisSnapshotPreparation(recipe), requestSha = hash(canonical);
    const admitted = await transaction(userId, projectId, analysisId, async (client, context) => {
      if (recipe.serviceId !== context.serviceId || recipe.projectId !== projectId || recipe.analysisId !== analysisId || recipe.ownerUserId !== Number(userId)) throw error('SCOPE_CONFLICT', 'This preparation belongs to a different service, project, analysis or account.');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`snapshot-capacity:${projectId}`]);
      const previous = (await client.query('SELECT * FROM research_analysis_snapshot_preparations WHERE project_id=$1 AND owner_user_id=$2 AND request_id=$3', [projectId, userId, recipe.requestId])).rows[0];
      if (previous) {
        if (previous.analysis_id !== analysisId || previous.request_sha256 !== requestSha) throw error('REQUEST_CONFLICT', 'This UUID already identifies another exact preparation. Recover its original request.');
        return { id: previous.id, created: false };
      }
      assertWritable(context);
      const analysis = await analysisProjection(client, projectId, analysisId, recipe.analysisVersion);
      await sources(client, userId, projectId, analysisId, recipe);
      const count = (await client.query(`SELECT COUNT(*) FILTER(WHERE owner_user_id=$2)::int AS requests,
        COUNT(*) FILTER(WHERE owner_user_id=$2 AND state<>'deleted')::int AS live,
        COALESCE(SUM(reserved_bytes) FILTER(WHERE owner_user_id=$2),0)::bigint AS owner_bytes,COALESCE(SUM(reserved_bytes),0)::bigint AS project_bytes
        FROM research_analysis_snapshot_preparations WHERE project_id=$1`, [projectId, userId])).rows[0];
      const L = schema.ANALYSIS_SNAPSHOT_PREPARATION_LIMITS;
      budget(count.requests + 1, L.requests, 'This account has reached its retained preparation request limit in this project.');
      budget(count.live + 1, L.live, 'Remove an earlier private preparation before preparing another in this project.');
      budget(Number(count.owner_bytes) + L.retainedBytes, L.ownerBytes, 'Remove an earlier private preparation to free your project preparation capacity.');
      budget(await require('./analysisSnapshotPublications').projectSnapshotUsage(client, projectId) + L.retainedBytes, L.projectBytes, 'This project has reached its retained preparation capacity.');
      const preparationId = id('asp'), plan = [...recipe.results.map((_, index) => ({ viewId: id('asv'), kind: 'result', index })), ...recipe.documents.map((_, index) => ({ viewId: id('asv'), kind: 'document', index }))];
      await client.query(`INSERT INTO research_analysis_snapshot_preparations(id,service_id,project_id,analysis_id,analysis_version,owner_user_id,request_id,request_sha256,recipe_json,analysis_snapshot_json,object_plan_json,state,reserved_bytes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'preparing',$12)`, [preparationId, context.serviceId, projectId, analysisId, recipe.analysisVersion, userId, recipe.requestId, requestSha, recipe, analysis, JSON.stringify(plan), L.retainedBytes]);
      return { id: preparationId, created: true };
    });
    if (!admitted.created) return { ...await observe(userId, projectId, analysisId, admitted.id, true), created: false };
    await build(userId, projectId, analysisId, admitted.id);
    return { ...await observe(userId, projectId, analysisId, admitted.id), created: true };
  }
  async function compile(userId, projectId, analysisId, value) {
    const schema = await contract, recipe = value.recipe_json;
    const captured = await transaction(userId, projectId, analysisId, async (client, context) => { assertWritable(context); return sources(client, userId, projectId, analysisId, recipe); });
    await captures.verifyEnvironments(userId, projectId, captured.results);
    const resultItems = [], documentItems = [], blobs = [], cached = new Map();
    for (const sourceId of new Set(recipe.results.filter(selected => !isTypedResult(selected) && selected.view.family === 'table').map(selected => selected.reference.versionId))) {
      const selections = recipe.results.filter(selected => !isTypedResult(selected) && selected.reference.versionId === sourceId && selected.view.family === 'table');
      const previews = await artifacts.prepareFixedTableViews(userId, projectId, sourceId, selections.map(selected => ({ offset: selected.view.offset, limit: selected.view.limit })));
      for (let index = 0; index < selections.length; index++) {
        const spec = { offset: selections[index].view.offset, limit: selections[index].view.limit };
        cached.set(`${sourceId}:${JSON.stringify(spec)}`, { bytes: Buffer.from(schema.canonicalSnapshotJson(previews[index], schema.ANALYSIS_SNAPSHOT_PREPARATION_LIMITS.tableBytes)), width: null, height: null });
      }
    }
    for (const sourceId of new Set(recipe.results.filter(isTypedResult).map(selected => selected.reference.versionId))) {
      const selections = recipe.results.filter(selected => isTypedResult(selected) && selected.reference.versionId === sourceId);
      const rendered = await artifacts.prepareFixedTypedViews(userId, projectId, sourceId, selections[0].descriptorSha256, selections.map(selected => selected.view));
      for (let index = 0; index < selections.length; index++) cached.set(`${sourceId}:typed:${selections[index].descriptorSha256}:${JSON.stringify(selections[index].view)}`, rendered[index]);
    }
    for (const sourceId of new Set(recipe.results.filter(selected => selected.kind === 'inert-analysis-reference').map(selected => selected.reference.versionId))) {
      const selections = recipe.results.filter(selected => selected.kind === 'inert-analysis-reference' && selected.reference.versionId === sourceId);
      let rendered;
      try { rendered = await artifacts.prepareFixedInertViews(userId, projectId, sourceId, selections.map(selected => selected.view)); }
      catch (failure) {
        // Owning role checks use legacy codes without an HTTP status. Confirm
        // current analysis scope before interpreting those as a source fault.
        if (['NOT_FOUND', 'FORBIDDEN'].includes(failure.code)) await transaction(userId, projectId, analysisId, (_client, context) => assertWritable(context));
        throw failure;
      }
      for (let index = 0; index < selections.length; index++) cached.set(`${sourceId}:inert:${JSON.stringify(selections[index].view)}`, rendered[index]);
    }
    for (const planned of value.object_plan_json) {
      if (planned.kind === 'result') {
        const selected = recipe.results[planned.index], source = captured.results[planned.index], safeSource = isLinkedRecipe(recipe) ? linkedSource(source.original) : fields(source.original);
        const fullReference = { artifactId: safeSource.artifactId, versionId: safeSource.versionId, projectId, sha256: safeSource.sha256 };
        const family = selected.view.family, spec = family === 'table' ? { offset: selected.view.offset, limit: selected.view.limit } : family === 'embedding' ? { pointLimit: selected.view.pointLimit } : family === 'text' ? { maxBytes: selected.view.maxBytes } : null;
        const typed = isTypedResult(selected), inert = selected.kind === 'inert-analysis-reference';
        const cacheKey = inert ? `${safeSource.versionId}:inert:${JSON.stringify(selected.view)}` : typed ? `${safeSource.versionId}:typed:${selected.descriptorSha256}:${JSON.stringify(selected.view)}` : `${safeSource.versionId}:${JSON.stringify(spec)}`;
        let rendered = cached.get(cacheKey);
        if ((typed || inert) && !rendered) throw error('VIEW_UNSUPPORTED', 'The exact selected source did not supply its fixed view.');
        if (!rendered) {
          if (family === 'table') {
            const preview = (await artifacts.preview(userId, projectId, safeSource.versionId, spec)).preview;
            if (preview.family !== 'table') throw error('VIEW_UNSUPPORTED', 'The exact saved table does not support this bounded retained view.');
            rendered = { bytes: Buffer.from(schema.canonicalSnapshotJson(preview, schema.ANALYSIS_SNAPSHOT_PREPARATION_LIMITS.tableBytes)), width: null, height: null };
          } else {
            const image = await (isLinkedRecipe(recipe) ? artifacts.readVerifiedOwnedImage(userId, projectId, safeSource.versionId) : artifacts.readVerifiedImage(userId, projectId, safeSource.versionId));
            rendered = { bytes: image.bytes, width: image.dimensions.width, height: image.dimensions.height };
          }
          cached.set(cacheKey, rendered);
        }
        const descriptor = { schema: inert ? 'traceomics.fixed-result-view.v4' : typed ? 'traceomics.fixed-result-view.v3' : isLinkedRecipe(recipe) ? 'traceomics.fixed-result-view.v2' : schema.FIXED_RESULT_VIEW_SCHEMA, source: fullReference, family, spec, blobSha256: hash(rendered.bytes), blobBytes: rendered.bytes.length, width: rendered.width, height: rendered.height,
          ...(typed ? { descriptorSha256: source.descriptorSha256, semantics: source.descriptor.semantics } : {}) };
        const view = { schema: descriptor.schema, family, spec, blobSha256: descriptor.blobSha256, blobBytes: descriptor.blobBytes, width: descriptor.width, height: descriptor.height };
        if (typed) Object.assign(view, { descriptorSha256: descriptor.descriptorSha256, semantics: descriptor.semantics });
        resultItems.push({ viewId: planned.viewId, ...(isLinkedRecipe(recipe) ? { origin: source.origin || { kind: 'attachment-revision', attachment: attachment(source.revision) } } : { attachment: attachment(source.revision) }), source: safeSource,
          view: { ...view, viewSha256: hash(schema.canonicalAnalysisSnapshotResultView(descriptor)) } });
        blobs.push({ viewId: planned.viewId, kind: 'result', bytes: rendered.bytes, sha256: descriptor.blobSha256 });
      } else {
        const saved = captured.documents[planned.index], canonical = (await documents).canonicalNotebookContent(saved.content_json), bytes = Buffer.from(canonical);
        if (hash(bytes) !== saved.sha256 || bytes.length !== Number(saved.content_bytes)) throw error('SOURCE_CHANGED', 'The saved supporting source failed its exact canonical identity check.');
        const descriptor = { schema: schema.FIXED_DOCUMENT_SOURCE_SCHEMA, source: { documentId: saved.document_id, versionId: saved.id, sha256: saved.sha256 }, blobSha256: saved.sha256, blobBytes: bytes.length };
        documentItems.push({ viewId: planned.viewId, documentId: saved.document_id, versionId: saved.id, version: Number(saved.version), title: saved.title,
          documentKind: saved.document_kind || 'notebook', defaultLanguage: saved.content_json.defaultLanguage, sha256: saved.sha256, contentBytes: bytes.length,
          role: 'supporting-source', producingSource: 'not-established', blobSha256: saved.sha256, blobBytes: bytes.length,
          viewSha256: hash(schema.canonicalAnalysisSnapshotDocumentSource(descriptor)) });
        blobs.push({ viewId: planned.viewId, kind: 'document', bytes, sha256: saved.sha256 });
      }
      budget(blobs.reduce((sum, blob) => sum + blob.bytes.length, 0), schema.ANALYSIS_SNAPSHOT_PREPARATION_LIMITS.retainedBytes, 'The selected retained views exceed the preparation byte limit.');
    }
    const snapshot = { schema: isLinkedRecipe(recipe) ? 'traceomics.analysis-snapshot-package.v2' : schema.ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA, serviceId: value.service_id, projectId, analysisId, ownerUserId: Number(userId),
      preparationId: value.id, createdAt: iso(value.created_at), analysis: value.analysis_snapshot_json, results: resultItems, documents: documentItems,
      notes: recipe.notes, prerequisites: isLinkedRecipe(recipe) ? { declaration: 'selected-and-user-supplied', items: captured.prerequisites } : { declaration: 'user-supplied', items: recipe.prerequisites },
      reproduction: { status: 'not-checked', producingSource: 'not-established', runtime: 'not-included', dataAccess: 'not-granted' } };
    const canonical = schema.canonicalAnalysisSnapshotPackage(snapshot), bytes = blobs.reduce((sum, blob) => sum + blob.bytes.length, 0) + Buffer.byteLength(canonical) + Buffer.byteLength(schema.canonicalAnalysisSnapshotPreparation(recipe));
    budget(bytes, schema.ANALYSIS_SNAPSHOT_PREPARATION_LIMITS.retainedBytes, 'The selected retained views and metadata exceed the preparation byte limit.');
    return { snapshot, snapshotSha256: hash(canonical), bytes, blobs, originalKeys: captured.results.map(item => item.original.storage_key), environments: captured.results.map(item => item.environment || null) };
  }
  async function build(userId, projectId, analysisId, preparationId) {
    if (active.size >= 2 || active.has(preparationId)) return;
    const marker = {}; active.set(preparationId, marker);
    let session, acquired = false, destroy = false;
    try {
      session = await (await database.connect()).connect();
      acquired = (await session.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [`snapshot-build:${preparationId}`])).rows[0]?.acquired === true;
      if (!acquired) return;
      const value = await transaction(userId, projectId, analysisId, async (client, context) => {
        const current = await row(client, userId, projectId, analysisId, preparationId, true);
        if (['ready', 'deleted'].includes(current.state)) return null;
        assertWritable(context);
        return (await client.query(`UPDATE research_analysis_snapshot_preparations SET state='preparing',failure_json=NULL,generation=generation+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [preparationId])).rows[0];
      });
      if (!value) return;
      try {
        const compiled = await compile(userId, projectId, analysisId, value);
        await transaction(userId, projectId, analysisId, async (client, context) => {
          const current = await row(client, userId, projectId, analysisId, preparationId, true);
          if (current.state !== 'preparing' || current.generation !== value.generation) return;
          assertWritable(context);
          const finalSources = await sources(client, userId, projectId, analysisId, current.recipe_json), schema = await contract;
          for (let index = 0; index < finalSources.results.length; index++) {
            if (finalSources.results[index].original.storage_key !== compiled.originalKeys[index]
                || schema.canonicalSnapshotJson(finalSources.results[index].environment || null) !== schema.canonicalSnapshotJson(compiled.environments[index])
                || finalSources.results[index].origin?.context && schema.canonicalSnapshotJson(finalSources.results[index].origin) !== schema.canonicalSnapshotJson(compiled.snapshot.results[index].origin)
                || schema.canonicalSnapshotJson(isLinkedRecipe(current.recipe_json) ? linkedSource(finalSources.results[index].original) : fields(finalSources.results[index].original)) !== schema.canonicalSnapshotJson(compiled.snapshot.results[index].source)) throw error('SOURCE_CHANGED', 'A selected exact source changed while its fixed view was being prepared.');
          }
          for (const blob of compiled.blobs) await client.query('INSERT INTO research_analysis_snapshot_blobs(preparation_id,id,kind,sha256,size_bytes,content) VALUES($1,$2,$3,$4,$5,$6)',
            [preparationId, blob.viewId, blob.kind, blob.sha256, blob.bytes.length, blob.bytes]);
          await client.query(`UPDATE research_analysis_snapshot_preparations SET state='ready',package_json=$2,snapshot_sha256=$3,reserved_bytes=$4,failure_json=NULL,updated_at=clock_timestamp() WHERE id=$1`, [preparationId, compiled.snapshot, compiled.snapshotSha256, compiled.bytes]);
        });
      } catch (failure) {
        if (failure.snapshotUncertainCommit || ![400, 403, 404, 409, 413].includes(failure.status)) throw failure;
        await transaction(userId, projectId, analysisId, async client => {
          const current = await row(client, userId, projectId, analysisId, preparationId, true);
          if (current.state !== 'preparing' || current.generation !== value.generation) return;
          const safe = { code: /^ANALYSIS_SNAPSHOT_[A-Z_]{1,46}$/.test(failure.code || '') ? failure.code : 'ANALYSIS_SNAPSHOT_BUILD_FAILED',
            message: 'This exact preparation could not retain every selected view. Inspect the selected source and limits, then explicitly resume or remove this preparation.' };
          await client.query("UPDATE research_analysis_snapshot_preparations SET state='failed',failure_json=$2,updated_at=clock_timestamp() WHERE id=$1", [preparationId, safe]);
        });
      }
    } catch (failure) { destroy = true; throw failure; }
    finally {
      if (active.get(preparationId) === marker) active.delete(preparationId);
      try { if (acquired && !destroy) await session.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`snapshot-build:${preparationId}`]); }
      catch { destroy = true; }
      session?.release(destroy);
    }
  }
  async function operation(userId, projectId, analysisId, preparationId, input, remove = false) {
    if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== 2
        || !['requestId', 'requestSha256'].every(key => Object.getOwnPropertyDescriptor(input, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value'))
        || !UUID.test(input.requestId || '') || !/^[a-f0-9]{64}$/.test(input.requestSha256 || '')) throw error('INVALID_OPERATION', 'Keep the exact original preparation UUID and checksum.', 400);
    const original = await transaction(userId, projectId, analysisId, async (client, context) => {
      const current = await row(client, userId, projectId, analysisId, preparationId, true);
      if (current.request_id !== input.requestId.toLowerCase() || current.request_sha256 !== input.requestSha256) throw error('REQUEST_CONFLICT', 'This action does not identify the original preparation.');
      if (remove && current.state !== 'deleted') {
        await client.query(`UPDATE research_analysis_snapshot_preparations SET state='deleted',generation=generation+1,recipe_json=NULL,analysis_snapshot_json=NULL,object_plan_json='[]',package_json=NULL,failure_json=NULL,reserved_bytes=0,updated_at=clock_timestamp() WHERE id=$1`, [preparationId]);
        await require('./analysisSnapshotPublications').deleteUnreferencedSnapshotBlobs(client, preparationId);
      } else if (!remove && !['ready', 'deleted'].includes(current.state)) assertWritable(context);
      return current;
    });
    if (!remove && !['ready', 'deleted'].includes(original.state)) await build(userId, projectId, analysisId, preparationId);
    return observe(userId, projectId, analysisId, preparationId, true);
  }
  async function readBlob(userId, projectId, analysisId, preparationId, viewId, kind) {
    if (!(await contract).ANALYSIS_SNAPSHOT_VIEW_ID.test(viewId || '')) missing();
    return transaction(userId, projectId, analysisId, async client => {
      const current = await row(client, userId, projectId, analysisId, preparationId);
      if (current.state !== 'ready') missing();
      const item = (kind === 'result' ? current.package_json.results : current.package_json.documents).find(value => value.viewId === viewId);
      if (!item) missing();
      const expected = item.view || item, blob = (await client.query('SELECT * FROM research_analysis_snapshot_blobs WHERE preparation_id=$1 AND id=$2 AND kind=$3', [preparationId, viewId, kind])).rows[0];
      if (!blob || blob.content.length !== expected.blobBytes || blob.size_bytes !== expected.blobBytes || blob.sha256 !== expected.blobSha256 || hash(blob.content) !== expected.blobSha256) throw retainedError();
      return { bytes: blob.content, mimeType: kind === 'document' || ['table', 'metrics', 'embedding', 'text'].includes(item.view.family) ? 'application/json; charset=utf-8' : item.source.format.id === 'org.w3.png' ? 'image/png' : 'image/jpeg' };
    });
  }
  const cursorScope = (userId, projectId, analysisId) => hash(JSON.stringify([Number(userId), projectId, analysisId])).slice(0, 16);
  const cursorFor = (kind, scope, position, identity) => Buffer.from(JSON.stringify([kind, scope, position, identity])).toString('base64url');
  function paging(input, kind, scope) {
    const limit = input.limit === undefined ? 30 : Number(input.limit);
    if (Object.keys(input).some(key => !['kind', 'limit', 'cursor'].includes(key)) || input.limit !== undefined && !['string', 'number'].includes(typeof input.limit)
        || typeof input.limit === 'string' && !/^[1-9][0-9]?$/.test(input.limit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw error('INVALID_PAGE', 'Choose a page size from 1 to 30.', 400);
    let cursor = null;
    if (input.cursor !== undefined) {
      try { if (typeof input.cursor !== 'string' || input.cursor.length > 256) throw 0; cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); }
      catch { throw error('INVALID_PAGE', 'The private preparation cursor is invalid.', 400); }
      if (!Array.isArray(cursor) || cursor[0] !== kind || cursor[1] !== scope || cursor.length !== 4 || typeof cursor[2] !== 'string' || typeof cursor[3] !== 'string') throw error('INVALID_PAGE', 'The private preparation cursor has a different scope.', 400);
      cursor = [cursor[0], cursor[2], cursor[3]];
    }
    return { limit, cursor };
  }
  async function list(userId, projectId, analysisId, input = {}) {
    const scope = cursorScope(userId, projectId, analysisId), page = paging(input, 'preparations', scope);
    if (page.cursor && (!Number.isFinite(Date.parse(page.cursor[1])) || !/^asp_[a-f0-9]{24}$/.test(page.cursor[2]))) throw error('INVALID_PAGE', 'The preparation cursor is invalid.', 400);
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const values = [projectId, analysisId, userId, page.limit + 1, ...(page.cursor ? page.cursor.slice(1) : [])];
      const rows = (await client.query(`SELECT * FROM research_analysis_snapshot_preparations WHERE project_id=$1 AND analysis_id=$2 AND owner_user_id=$3 AND state<>'deleted'
        ${page.cursor ? "AND (date_trunc('milliseconds',created_at),id)<($5::timestamptz,$6::text)" : ''} ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $4`, values)).rows;
      const items = [], selected = [];
      for (const value of rows.slice(0, page.limit)) {
        const entry = envelope(value, context, false, null);
        const summary = { preparationId: value.id, requestId: value.request_id, requestSha256: value.request_sha256, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
          state: value.state, canResume: entry.canResume, canDelete: entry.canDelete, snapshotSha256: value.snapshot_sha256,
          selection: { analysisVersion: value.analysis_version, analysisName: value.analysis_snapshot_json.name, resultCount: value.recipe_json.results.length, documentCount: value.recipe_json.documents.length, prerequisiteCount: value.recipe_json.prerequisites.length } };
        if (Buffer.byteLength(JSON.stringify([...items, summary])) > 120 * 1024) break;
        items.push(summary); selected.push(value);
      }
      const last = selected.at(-1);
      return { schema: 'traceomics.analysis-snapshot-preparation.v1', serviceId: context.serviceId, projectId, analysisId, ownerUserId: Number(userId), canPrepare: writable(context), items,
        nextCursor: rows.length > selected.length && last ? cursorFor('preparations', scope, iso(last.created_at), last.id) : null };
    });
  }
  async function options(userId, projectId, analysisId, input = {}) {
    if (['analysis-references', 'analysis-typed-references', 'analysis-inert-references', 'captured-workflow-outputs'].includes(input.kind)) return transaction(userId, projectId, analysisId, (client, context) => linked.options(client, context, userId, projectId, analysisId, input, writable(context)));
    const kind = input.kind, scope = cursorScope(userId, projectId, analysisId), page = paging(input, kind, scope);
    if (!['analysis-versions', 'results', 'documents'].includes(kind)) throw error('INVALID_PAGE', 'Choose saved analysis versions, result revisions or supporting source.', 400);
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const items = [], positions = []; let raw;
      if (kind === 'analysis-versions') {
        if (page.cursor && (!/^[0-9]{1,10}$/.test(page.cursor[1]) || page.cursor[2] !== analysisId)) throw error('INVALID_PAGE', 'The saved analysis cursor is invalid.', 400);
        raw = (await client.query(`SELECT version FROM research_analysis_revisions WHERE project_id=$1 AND analysis_id=$2 ${page.cursor ? 'AND version<$4' : ''} ORDER BY version DESC LIMIT $3`, [projectId, analysisId, page.limit + 1, ...(page.cursor ? [Number(page.cursor[1])] : [])])).rows;
        for (const item of raw.slice(0, page.limit)) { items.push(await analysisProjection(client, projectId, analysisId, item.version)); positions.push([String(item.version), analysisId]); }
      } else if (kind === 'results') {
        if (page.cursor && (!Number.isFinite(Date.parse(page.cursor[1])) || !/^rar_[a-f0-9]{24}$/.test(page.cursor[2]))) throw error('INVALID_PAGE', 'The saved result cursor is invalid.', 400);
        let position = page.cursor?.slice(1), scanned = 0, exhausted = false;
        while (items.length <= page.limit && !exhausted && scanned < 2000) {
          const batchSize = Math.min(64, 2000 - scanned);
          const batch = (await client.query(`SELECT r.*,v.id AS source_id,v.artifact_id AS source_artifact_id,v.name AS source_name,
            v.checksum_sha256 AS source_sha256,v.size_bytes AS source_bytes,v.storage_key AS source_key,
            v.format_json->>'id' AS source_format_id,v.format_json->>'version' AS source_format_version
            FROM research_analysis_attachment_revisions r JOIN managed_artifact_versions v ON v.id=r.reference_json->>'versionId' AND v.project_id=r.project_id AND v.owner_user_id=r.source_owner_user_id
            WHERE r.project_id=$1 AND r.analysis_id=$2 AND r.source_owner_user_id=$3 AND v.format_json->>'id'=ANY($5::text[])
              AND v.format_json->>'version'='1' AND v.checksum_sha256=r.reference_json->>'sha256' AND v.size_bytes BETWEEN 1 AND 209715200
            ${position ? "AND (date_trunc('milliseconds',r.created_at),r.id)<($6::timestamptz,$7::text)" : ''}
            ORDER BY date_trunc('milliseconds',r.created_at) DESC,r.id DESC LIMIT $4`, [projectId, analysisId, userId, batchSize + 1, formats, ...(position || [])])).rows;
          exhausted = batch.length <= batchSize;
          for (const revision of batch.slice(0, batchSize)) {
            scanned++; position = [iso(revision.created_at), revision.id];
            const original = { id: revision.source_id, artifact_id: revision.source_artifact_id, project_id: projectId,
              name: revision.source_name, checksum_sha256: revision.source_sha256, size_bytes: revision.source_bytes,
              storage_key: revision.source_key, format_json: { id: revision.source_format_id, version: revision.source_format_version } };
            if (!eligible(original, projectId)) continue;
            items.push({ ...attachment(revision), reference: revision.reference_json, source: fields(original), families: [['org.ietf.csv', 'org.iana.tsv'].includes(original.format_json.id) ? 'table' : 'image'], integrity: 'not-checked' });
            positions.push(position);
            if (items.length > page.limit) break;
          }
        }
        if (!exhausted && scanned >= 2000 && items.length <= page.limit) throw error('OPTIONS_LIMIT', 'This saved result history exceeds the supported bounded scan. Earlier preparations remain retained.');
        raw = items.slice(); items.splice(page.limit); positions.splice(page.limit);
      } else {
        if (page.cursor && (!Number.isFinite(Date.parse(page.cursor[1])) || !/^dv_[a-f0-9]{24}$/.test(page.cursor[2]))) throw error('INVALID_PAGE', 'The saved source cursor is invalid.', 400);
        raw = (await client.query(`SELECT id,document_id,version,title,document_kind,sha256,content_bytes,actor_user_id,created_at,content_json->>'defaultLanguage' AS language FROM research_document_revisions WHERE project_id=$1 AND analysis_id=$2
          ${page.cursor ? "AND (date_trunc('milliseconds',created_at),id)<($4::timestamptz,$5::text)" : ''} ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $3`, [projectId, analysisId, page.limit + 1, ...(page.cursor ? page.cursor.slice(1) : [])])).rows;
        for (const saved of raw.slice(0, page.limit)) {
          items.push({ documentId: saved.document_id, versionId: saved.id, version: Number(saved.version), title: saved.title, documentKind: saved.document_kind || 'notebook', defaultLanguage: saved.language,
            sha256: saved.sha256, contentBytes: Number(saved.content_bytes), actorUserId: Number(saved.actor_user_id), createdAt: iso(saved.created_at), role: 'supporting-source', producingSource: 'not-established' });
          positions.push([iso(saved.created_at), saved.id]);
        }
      }
      while (Buffer.byteLength(JSON.stringify(items)) > 120 * 1024) { items.pop(); positions.pop(); }
      return { schema: 'traceomics.analysis-snapshot-preparation.v1', serviceId: context.serviceId, projectId, analysisId, ownerUserId: Number(userId), canPrepare: writable(context), kind, items,
        nextCursor: raw.length > items.length && positions.length ? cursorFor(kind, scope, ...positions.at(-1)) : null };
    });
  }
  return { prepare, get: observe, getByRequest: byRequest, list, options,
    resume: (userId, projectId, analysisId, preparationId, input) => operation(userId, projectId, analysisId, preparationId, input),
    remove: (userId, projectId, analysisId, preparationId, input) => operation(userId, projectId, analysisId, preparationId, input, true), readBlob };
}

module.exports = { createAnalysisSnapshotPreparationService };

function analysisSnapshotPreparationRoutes({ database = db, logger = console } = {}) {
  const router = require('express').Router({ mergeParams: true }), service = createAnalysisSnapshotPreparationService(database);
  const scope = req => [req.user.id, req.params.projectId, req.params.analysisId];
  const route = (action, raw = false) => async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      if (raw && Object.keys(req.query).length) throw error('INVALID_VIEW_QUERY', 'A retained view has no source paging or query parameters.', 400);
      const result = await action(req);
      if (raw) {
        res.setHeader('Content-Type', result.mimeType); res.setHeader('Content-Length', String(result.bytes.length));
        res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.send(result.bytes);
      } else {
        const { created, ...response } = result; res.status(created ? 201 : 200).json(response);
      }
    } catch (failure) {
      if ([400, 403, 404, 409, 413].includes(failure.status)) return res.status(failure.status).json({ error: failure.message, code: failure.code });
      logger.error?.(`[AnalysisSnapshotPreparation] Request could not be confirmed (${String(failure.code || 'REQUEST_FAILED').replace(/[^A-Z0-9_]/gi, '').slice(0, 64)}).`);
      res.status(500).json({ code: 'ANALYSIS_SNAPSHOT_UNCONFIRMED', error: 'This preparation outcome could not be confirmed. Keep its original request and check it again.' });
    }
  };
  router.get('/options', route(req => service.options(...scope(req), req.query)));
  router.get('/requests/:requestId', route(req => service.getByRequest(...scope(req), req.params.requestId)));
  router.get('/', route(req => service.list(...scope(req), req.query)));
  router.post('/', route(req => service.prepare(...scope(req), req.body)));
  router.get('/:preparationId/views/:viewId', route(req => service.readBlob(...scope(req), req.params.preparationId, req.params.viewId, 'result'), true));
  router.get('/:preparationId/documents/:viewId', route(req => service.readBlob(...scope(req), req.params.preparationId, req.params.viewId, 'document'), true));
  router.post('/:preparationId/resume', route(req => service.resume(...scope(req), req.params.preparationId, req.body)));
  router.delete('/:preparationId', route(req => service.remove(...scope(req), req.params.preparationId, req.body)));
  router.get('/:preparationId', route(req => service.get(...scope(req), req.params.preparationId)));
  return router;
}
module.exports.analysisSnapshotPreparationRoutes = analysisSnapshotPreparationRoutes;
