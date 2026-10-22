'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { getServiceExecutionIdentity } = require('./executionTargets');
const { createArtifactVersionService } = require('./artifactVersions');
const { createServerDataImportService } = require('./serverDataImports');
const contracts = Promise.all([import('../shared/analysisLocalIntake.mjs'), import('../shared/artifactImport.mjs'),
  import('../shared/analysisAttachment.mjs'), import('../shared/analysisServerIntake.mjs'), import('../shared/serverDataImport.mjs')]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const time = value => new Date(value).toISOString();
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const prefix = kind => kind ? `ANALYSIS_${kind.toUpperCase()}_INTAKE` : 'ANALYSIS_INTAKE';
const missing = kind => { throw failure(`${prefix(kind)}_NOT_FOUND`, 'This import is not confirmed yet. Keep its original request and check again.', 404); };
const conflict = kind => { throw failure(`${prefix(kind)}_REQUEST_CONFLICT`, 'This request belongs to another import. Recover that import before starting a new one.', 409); };

function acceptedImport(recipe, imported, schema) {
  const canonical = schema.canonicalArtifactImportRequest(recipe.importRequest);
  let captured;
  try { captured = schema.canonicalArtifactImportRequest(imported.request_json); }
  catch (error) { if (error?.code !== 'INVALID_ARTIFACT_IMPORT_RESPONSE') throw error; return null; }
  if (imported.request_sha256 !== digest(canonical) || captured !== canonical || imported.checksum_sha256 !== recipe.importRequest.sha256
      || Number(imported.size_bytes) !== recipe.importRequest.sizeBytes || !/^av_[a-f0-9]{24}$/.test(imported.version_id) || imported.previous_version_id !== null) return null;
  return { versionId: imported.version_id, sha256: imported.checksum_sha256, sizeBytes: Number(imported.size_bytes), previousVersionId: null };
}
function matchesAttachment(recipe, acceptance, attached, userId, intakeSchema, attachmentSchema) {
  const expected = intakeSchema.analysisLocalIntakeAttachmentRequest(recipe, acceptance);
  const { action, attachmentId } = recipe.attachment;
  const canonical = action === 'correct' ? attachmentSchema.canonicalAnalysisAttachmentCorrection(attachmentId, expected) : attachmentSchema.canonicalAnalysisAttachmentContent(expected);
  const captured = { reference: attached.reference_json, caption: attached.caption, suppliedOrigin: attached.supplied_origin_json,
    ...(action === 'correct' ? { expectedHeadRevisionId: attached.expected_head_revision_id } : {}) };
  let actual;
  try { actual = action === 'correct' ? attachmentSchema.canonicalAnalysisAttachmentCorrection(attached.attachment_id, captured) : attachmentSchema.canonicalAnalysisAttachmentContent(captured); }
  catch (error) { if (error?.code !== 'INVALID_ANALYSIS_ATTACHMENT') throw error; return false; }
  return attached.action === action && (action === 'create' ? attached.expected_head_revision_id === null : attached.attachment_id === attachmentId)
    && Number(attached.source_owner_user_id) === Number(userId) && attached.request_sha256 === digest(canonical) && actual === canonical;
}

function createAnalysisIntakeService({ database, provider, transaction, writable, attachmentResult, head, item }) {
  const artifacts = createArtifactVersionService(database, provider), server = createServerDataImportService(database, provider);
  const sourceKind = row => row.source_kind || 'local';
  async function adapters() {
    const [local, importSchema, attachment, remote, serverSchema] = await contracts;
    return {
      attachment,
      local: {
        normalize: local.normalizeAnalysisLocalIntake, canonical: local.canonicalAnalysisLocalIntake,
        scope: recipe => recipe.importRequest, filename: recipe => recipe.importRequest.originalFilename,
        canStart: () => true, attachmentSchema: local,
        match(recipe, row) { const acceptance = acceptedImport(recipe, row, importSchema); return { status: acceptance ? 'accepted' : 'conflict', acceptance }; },
        async serialize(client, context, row) {
          const receipt = await artifacts.serializeImportReceipt(client, row, projectWritable(context));
          if (receipt.version?.owner) receipt.version.owner.displayName = server.displayLabel(receipt.version.owner.displayName, 200, 'Researcher');
          return receipt;
        },
      },
      server: {
        normalize: remote.normalizeAnalysisServerIntake, canonical: remote.canonicalAnalysisServerIntake,
        scope: recipe => recipe, filename: recipe => recipe.importRequest.relativePath.split('/').at(-1),
        canStart: (userId, projectId, recipe) => server.hasSourceGrant(userId, projectId, recipe.importRequest),
        attachmentSchema: { analysisLocalIntakeAttachmentRequest: remote.analysisServerIntakeAttachmentRequest },
        match(recipe, row) {
          const canonical = serverSchema.canonicalServerDataImportRequest(recipe.importRequest);
          let captured = null;
          if (row.request_json !== null) {
            try { captured = serverSchema.canonicalServerDataImportRequest(row.request_json); }
            catch (error) { if (!['SERVER_IMPORT_REQUEST_INVALID', 'SERVER_IMPORT_METADATA_INVALID', 'SERVER_IMPORT_PATH_INVALID', 'INVALID_ARTIFACT_NAME'].includes(error?.code)) throw error; return { status: 'conflict', acceptance: null }; }
          }
          if (row.request_sha256 !== digest(canonical) || captured !== null && captured !== canonical || row.root_id !== recipe.importRequest.rootId
              || row.relative_path !== recipe.importRequest.relativePath || row.name !== recipe.importRequest.name || row.artifact_type !== 'auto'
              || row.previous_version_id !== null || row.source_metadata_json?.serviceId !== recipe.serviceId
              || Number(row.reserved_bytes) !== recipe.selectionSizeBytes || Number(row.source_identity_json?.file?.size) !== recipe.selectionSizeBytes) return { status: 'conflict', acceptance: null };
          if (row.status === 'completed') { const acceptance = server.journalAcceptance(row); return { status: acceptance ? 'accepted' : 'legacy-unrecorded', acceptance }; }
          return { status: row.status === 'failed' ? 'failed' : 'pending', acceptance: null };
        },
        serialize: (client, context, row, serviceId) => server.serializeJournal(client, { serviceId, canImport: server.canImportPolicy(context.member, context.user) }, row, true),
      },
    };
  }
  function projectWritable(context) { return ['owner', 'admin', 'analyst'].includes(context.member.role) && !context.user.is_demo_guest && !config.demoMode(); }
  async function identity(client) {
    const row = (await client.query('SELECT service_id FROM service_execution_identity WHERE singleton=TRUE')).rows[0];
    return row?.service_id || (await getServiceExecutionIdentity(client)).id;
  }
  function flags(context, kind, recipe, userId, projectId) {
    const allowed = writable(context);
    return { canContinue: allowed, canStartImport: allowed && (kind === 'local' || server.hasSourceGrant(userId, projectId, recipe.importRequest)), canAttach: allowed };
  }
  function assertFresh(context) {
    if (!['owner', 'admin', 'analyst'].includes(context.member.role)) throw failure('FORBIDDEN', 'Project write access is required to import a file.', 403);
    if (context.analysis.status !== 'active') throw failure('ANALYSIS_ARCHIVED', 'Restore this analysis to continue importing files.', 409);
    if (context.user.is_demo_guest || config.demoMode()) throw failure('FORBIDDEN', 'File imports are disabled on this server.', 403);
  }
  async function observe(client, userId, projectId, analysisId, rows) {
    if (!rows.length) return [];
    // Never wait on upload/copy fences while holding analysis/project locks.
    // Missing operation receipts remain unconfirmed, including in-flight writes.
    const sources = await adapters(), receipts = new Map();
    for (const [kind, table] of [['local', 'managed_artifact_import_receipts'], ['server', 'server_data_imports']]) {
      const selected = rows.filter(row => sourceKind(row) === kind);
      if (!selected.length) continue;
      const records = (await client.query(`SELECT * FROM ${table} WHERE project_id=$1 AND owner_user_id=$2 AND request_id=ANY($3::uuid[])`, [projectId, userId, selected.map(row => row.request_id)])).rows;
      receipts.set(kind, new Map(records.map(row => [row.request_id, row])));
    }
    const attachments = (await client.query(`SELECT * FROM research_analysis_attachment_revisions WHERE project_id=$1 AND analysis_id=$2 AND actor_user_id=$3 AND request_id=ANY($4::uuid[])`, [projectId, analysisId, userId, rows.map(row => row.attachment_request_id)])).rows;
    const attachmentById = new Map(attachments.map(row => [row.request_id, row]));
    return rows.map(row => {
      const kind = sourceKind(row), adapter = sources[kind], recipe = adapter.normalize(row.recipe_json), imported = receipts.get(kind)?.get(row.request_id), attached = attachmentById.get(row.attachment_request_id);
      const match = imported ? adapter.match(recipe, imported) : { status: 'unconfirmed', acceptance: null };
      let attachmentStatus = attached ? 'conflict' : 'unconfirmed';
      if (attached && match.acceptance && matchesAttachment(recipe, match.acceptance, attached, userId, adapter.attachmentSchema, sources.attachment)) attachmentStatus = 'accepted';
      return { row, kind, adapter, recipe, imported, attached, importStatus: match.status, attachmentStatus };
    });
  }
  async function display(client, context, userId, projectId, analysisId, serviceId, row, replayed, legacy = false) {
    const observed = (await observe(client, userId, projectId, analysisId, [row]))[0];
    const capabilities = flags(context, observed.kind, observed.recipe, userId, projectId);
    return { ...(legacy ? {} : { sourceKind: observed.kind }), serviceId, projectId, analysisId, ownerUserId: Number(userId),
      ...(legacy ? { canContinue: capabilities.canContinue, canUpload: capabilities.canStartImport, canAttach: capabilities.canAttach } : capabilities),
      requestId: row.request_id, requestSha256: row.request_sha256, recipe: observed.recipe, createdAt: time(row.created_at), replayed,
      importOutcome: { status: observed.importStatus, receipt: ['unconfirmed', 'conflict'].includes(observed.importStatus) ? null : await observed.adapter.serialize(client, context, observed.imported, serviceId) },
      attachmentOutcome: { status: observed.attachmentStatus, receipt: observed.attachmentStatus === 'accepted' ? await attachmentResult(client, context, userId, projectId, analysisId, observed.attached, true) : null } };
  }
  async function existing(client, context, userId, projectId, analysisId, serviceId, recipe, adapter, kind, hash, canonical, legacy) {
    const row = (await client.query('SELECT * FROM research_analysis_intakes WHERE project_id=$1 AND owner_user_id=$2 AND request_id=$3', [projectId, userId, recipe.requestId])).rows[0];
    if (!row) return null;
    if (sourceKind(row) !== kind || row.analysis_id !== analysisId || row.request_sha256 !== hash || adapter.canonical(analysisId, row.recipe_json) !== canonical) conflict(kind);
    return display(client, context, userId, projectId, analysisId, serviceId, row, true, legacy);
  }
  async function admit(kind, userId, projectId, analysisId, input, legacy = false) {
    const sources = await adapters(), adapter = sources[kind], recipe = adapter.normalize(input), canonical = adapter.canonical(analysisId, recipe), hash = digest(canonical);
    const scope = adapter.scope(recipe);
    if (scope.projectId !== projectId || scope.ownerUserId !== Number(userId)) throw failure(`INVALID_${prefix(kind)}`, 'Use the account and project where this import was started.');
    if (kind === 'server') {
      await server.settleImports(userId, projectId, [recipe.requestId]);
      const recovered = await transaction(userId, projectId, analysisId, async (client, context) => {
        const serviceId = await identity(client);
        if (serviceId !== recipe.serviceId) throw failure(`${prefix(kind)}_SERVICE_CHANGED`, 'Reconnect to the server where this import was started.', 409);
        const saved = await existing(client, context, userId, projectId, analysisId, serviceId, recipe, adapter, kind, hash, canonical, legacy);
        if (!saved) assertFresh(context);
        return saved;
      }, true);
      if (recovered) return recovered;
      await server.inspectSelection(userId, projectId, recipe.importRequest, { sizeBytes: recipe.selectionSizeBytes, maximumBytes: (await contracts)[3].ANALYSIS_SERVER_INTAKE_LIMITS.fileBytes });
    }
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const serviceId = await identity(client);
      if (serviceId !== recipe.serviceId) throw failure(`${prefix(kind)}_SERVICE_CHANGED`, 'Reconnect to the server where this import was started.', 409);
      // Keep the existing local fence namespace; both adapters now share it.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`analysis-local-intake:${projectId}:${userId}:${recipe.requestId}`]);
      const saved = await existing(client, context, userId, projectId, analysisId, serviceId, recipe, adapter, kind, hash, canonical, legacy);
      if (saved) return saved;
      assertFresh(context);
      if (!adapter.canStart(userId, projectId, recipe)) throw failure('SERVER_INTAKE_SOURCE_UNAVAILABLE', 'The original server source grant is unavailable. Keep this request and select a new source deliberately.', 409);
      if ((await client.query('SELECT 1 FROM research_analysis_intakes WHERE project_id=$1 AND analysis_id=$2 AND owner_user_id=$3 AND attachment_request_id=$4', [projectId, analysisId, userId, recipe.attachment.requestId])).rowCount) conflict(kind);
      const count = (await client.query('SELECT COUNT(*)::int AS n FROM research_analysis_intakes WHERE project_id=$1 AND analysis_id=$2', [projectId, analysisId])).rows[0].n;
      if (count >= 2000) throw failure(`${prefix(kind)}_LIMIT`, 'This analysis has reached its 2000-import limit. Existing imports are still available.', 409);
      if (recipe.attachment.action === 'correct') {
        const current = await head(client, projectId, analysisId, recipe.attachment.attachmentId);
        if (current.head_revision_id !== recipe.attachment.expectedHeadRevisionId) throw Object.assign(failure('ANALYSIS_ATTACHMENT_HEAD_CONFLICT', 'This attachment changed. Review its current revision before saving your correction.', 409), { attachment: await item(client, userId, projectId, current), submittedExpectedHeadRevisionId: recipe.attachment.expectedHeadRevisionId });
      }
      const row = (await client.query(`INSERT INTO research_analysis_intakes (project_id,analysis_id,owner_user_id,request_id,attachment_request_id,service_id,request_sha256,recipe_json,source_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [projectId, analysisId, userId, recipe.requestId, recipe.attachment.requestId, serviceId, hash, recipe, kind])).rows[0];
      return display(client, context, userId, projectId, analysisId, serviceId, row, false, legacy);
    }, true);
  }
  async function get(kind, userId, projectId, analysisId, requestId, legacy = false) {
    if (typeof requestId !== 'string' || !UUID.test(requestId)) missing(kind);
    if (kind !== 'local') await server.settleImports(userId, projectId, [requestId]);
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const row = (await client.query('SELECT * FROM research_analysis_intakes WHERE project_id=$1 AND analysis_id=$2 AND owner_user_id=$3 AND request_id=$4 AND ($5::text IS NULL OR source_kind=$5)', [projectId, analysisId, userId, requestId.toLowerCase(), kind])).rows[0];
      if (!row) missing(kind);
      const serviceId = await identity(client);
      if (row.service_id !== serviceId) throw failure(`${prefix(kind)}_SERVICE_CHANGED`, 'Reconnect to the server where this import was started.', 409);
      return display(client, context, userId, projectId, analysisId, serviceId, row, true, legacy);
    }, true);
  }
  async function list(kind, userId, projectId, analysisId, options = {}, legacy = false) {
    const invalid = () => failure(`INVALID_${prefix(kind)}_PAGE`, 'This import page is invalid. Reload the list.');
    if (Object.keys(options).some(key => !['limit', 'cursor'].includes(key))) throw invalid();
    const limit = options.limit === undefined ? 30 : Number(options.limit); let cursor = null;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw invalid();
    if (options.cursor !== undefined) {
      if (typeof options.cursor !== 'string' || !options.cursor || options.cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(options.cursor)) throw invalid();
      try { cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; throw invalid(); }
      if (!Array.isArray(cursor) || cursor.length !== 3 || cursor[0] !== analysisId || typeof cursor[1] !== 'string' || !Number.isFinite(Date.parse(cursor[1])) || new Date(cursor[1]).toISOString() !== cursor[1] || typeof cursor[2] !== 'string' || !UUID.test(cursor[2])) throw invalid();
    }
    if (kind !== 'local') await server.settleImports(userId, projectId);
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const serviceId = await identity(client);
      const rows = (await client.query(`SELECT * FROM research_analysis_intakes WHERE project_id=$1 AND analysis_id=$2 AND owner_user_id=$3 AND service_id=$4
        AND ($5::timestamptz IS NULL OR (date_trunc('milliseconds',created_at),request_id)<($5::timestamptz,$6::uuid)) AND ($8::text IS NULL OR source_kind=$8)
        ORDER BY date_trunc('milliseconds',created_at) DESC,request_id DESC LIMIT $7`, [projectId, analysisId, userId, serviceId, cursor?.[1] || null, cursor?.[2] || null, limit + 1, kind])).rows;
      const selected = rows.slice(0, limit), observations = await observe(client, userId, projectId, analysisId, selected), last = selected.at(-1);
      const allowed = writable(context);
      return { serviceId, projectId, analysisId, ownerUserId: Number(userId), canContinue: allowed, ...(legacy ? { canUpload: allowed } : {}), canAttach: allowed,
        items: observations.map(observed => {
          const { row, recipe, importStatus, attachmentStatus, adapter } = observed;
          return { requestId: row.request_id, requestSha256: row.request_sha256, createdAt: time(row.created_at), originalFilename: adapter.filename(recipe), name: recipe.importRequest.name,
            caption: recipe.attachment.caption, action: recipe.attachment.action, attachmentId: recipe.attachment.attachmentId, expectedHeadRevisionId: recipe.attachment.expectedHeadRevisionId,
            importStatus, attachmentStatus, ...(legacy ? {} : { sourceKind: observed.kind, canStartImport: flags(context, observed.kind, recipe, userId, projectId).canStartImport }) };
        }), nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([analysisId, time(last.created_at), last.request_id])).toString('base64url') : null };
    }, true);
  }
  return {
    admitLocalIntake: (u, p, a, input) => admit('local', u, p, a, input, true),
    getLocalIntake: (u, p, a, id) => get('local', u, p, a, id, true), listLocalIntakes: (u, p, a, query) => list('local', u, p, a, query, true),
    admitServerIntake: (u, p, a, input) => admit('server', u, p, a, input),
    getServerIntake: (u, p, a, id) => get('server', u, p, a, id), listServerIntakes: (u, p, a, query) => list('server', u, p, a, query),
    getIntake: (u, p, a, id) => get(null, u, p, a, id), listIntakes: (u, p, a, query) => list(null, u, p, a, query),
  };
}
module.exports = { createAnalysisIntakeService, createAnalysisLocalIntakeService: createAnalysisIntakeService };
