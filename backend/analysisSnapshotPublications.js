'use strict';

const crypto = require('node:crypto');
const db = require('./pgDatabase');
const config = require('./config');
const audit = require('./projectAudit');
const { getServiceExecutionIdentity } = require('./executionTargets');
const contract = import('../shared/analysisSnapshotPublication.mjs');
const snapshots = import('../shared/analysisSnapshotPreparationDispatch.mjs');
const READ = ['owner', 'admin', 'analyst', 'viewer'], WRITE = ['owner', 'admin', 'analyst'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const iso = value => new Date(value).toISOString();
const error = (code, message, status = 409) => Object.assign(new Error(message), { code: `ANALYSIS_SNAPSHOT_${code}`, status });
const missing = () => { throw error('PUBLICATION_NOT_FOUND', 'This publication or accepted action is not confirmed in this analysis.', 404); };
const scopeMissing = () => { throw error('SCOPE_NOT_FOUND', 'Current access to this project and analysis could not be confirmed.', 404); };
const unavailable = () => error('VIEW_UNAVAILABLE', 'The exact retained finding is missing or failed its integrity check. Its original publication remains recorded.');
const verification = new Map();
const safeLabel = value => {
  const text = String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim(); let result = '';
  for (const character of text) { if (result.length + character.length > 200) break; result += character; }
  return result.trim() || 'Researcher';
};

function createAnalysisSnapshotPublicationService(database = db) {
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
      const result = await action(client, { user, member, analysis, serviceId });
      committing = true; await client.query('COMMIT'); committing = false; return result;
    } catch (failure) {
      if (committing) { failure.snapshotUncertainCommit = true; destroy = true; }
      try { await client.query('ROLLBACK'); } catch { destroy = true; }
      throw failure;
    } finally { client.release(destroy); }
  }
  const canPublish = context => WRITE.includes(context.member.role) && context.analysis.status === 'active' && !context.user.is_demo_guest && !config.demoMode();
  function assertWritable(context) {
    if (!WRITE.includes(context.member.role) || context.user.is_demo_guest || config.demoMode()) throw error('WRITE_REQUIRED', 'Current project write access is required to publish findings.', 403);
    if (context.analysis.status !== 'active') throw error('ANALYSIS_ARCHIVED', 'Restore this analysis before publishing new findings.');
  }
  const canWithdraw = (value, context) => value.state === 'published' && (Number(value.publisher_user_id) === Number(context.user.id) || ['owner', 'admin'].includes(context.member.role));
  const policy = value => ({ state: value.state, version: Number(value.policy_version), withdrawnAt: value.withdrawn_at ? iso(value.withdrawn_at) : null,
    withdrawnByUserId: value.withdrawn_by_user_id === null ? null : Number(value.withdrawn_by_user_id) });
  async function row(client, projectId, analysisId, publicationId, lock = false) {
    if (!(await contract).ANALYSIS_SNAPSHOT_PUBLICATION_ID.test(publicationId || '')) missing();
    const value = (await client.query(`SELECT publication.*,publisher.display_name AS publisher_label FROM research_analysis_snapshot_publications publication
      JOIN users publisher ON publisher.id=publication.publisher_user_id WHERE publication.id=$1 AND publication.project_id=$2 AND publication.analysis_id=$3${lock ? ' FOR UPDATE OF publication' : ''}`,
    [publicationId, projectId, analysisId])).rows[0];
    if (!value) missing(); return value;
  }
  const summary = (value, context) => ({ publicationId: value.id, publisherUserId: Number(value.publisher_user_id), publisherLabel: safeLabel(value.publisher_label),
    publishedAt: iso(value.published_at), preparationId: value.preparation_id, snapshotSha256: value.snapshot_sha256, policy: policy(value), canWithdraw: canWithdraw(value, context),
    selection: value.state === 'withdrawn' ? null : value.selection_json || { analysisVersion: value.package_json.analysis.version, analysisName: value.package_json.analysis.name,
      resultCount: value.package_json.results.length, documentCount: value.package_json.documents.length, prerequisiteCount: value.package_json.prerequisites.items.length } });
  const envelope = (value, context, availability) => ({ schema: 'traceomics.analysis-snapshot-publication.v1', serviceId: value.service_id, projectId: value.project_id,
    analysisId: value.analysis_id, viewerUserId: Number(context.user.id), publicationId: value.id, publisherUserId: Number(value.publisher_user_id), publisherLabel: safeLabel(value.publisher_label),
    publishedAt: iso(value.published_at), preparationId: value.preparation_id, snapshotSha256: value.snapshot_sha256, policy: policy(value), canPublish: canPublish(context),
    canWithdraw: canWithdraw(value, context), package: value.state === 'published' ? value.package_json : null, availability: value.state === 'published' ? availability : null });
  async function bounded(value, bytes, maximum) { if (Buffer.byteLength(bytes || JSON.stringify(value)) > maximum) throw error('CAPACITY', 'This finding exceeds its bounded response.'); return value; }
  async function collect(client, preparationId, publicationId) {
    return (await client.query(`SELECT blob.* FROM research_analysis_snapshot_blobs blob ${publicationId ? 'JOIN research_analysis_snapshot_publication_blobs lease ON lease.preparation_id=blob.preparation_id AND lease.view_id=blob.id AND lease.kind=blob.kind' : ''}
      WHERE blob.preparation_id=$1${publicationId ? ' AND lease.publication_id=$2' : ''} ORDER BY blob.id`, publicationId ? [preparationId, publicationId] : [preparationId])).rows;
  }
  async function availability(value, blobs, requireIntact = false) {
    const source = await snapshots;
    if (hash(source.canonicalAnalysisSnapshotPackage(value.package_json)) !== value.snapshot_sha256) throw unavailable();
    const rows = new Map(blobs.map(blob => [blob.id, blob])); let total = 0;
    const inspect = (item, kind) => {
      const expected = item.view || item, blob = rows.get(item.viewId); total += expected.blobBytes;
      return blob && blob.kind === kind && blob.sha256 === expected.blobSha256 && blob.size_bytes === expected.blobBytes
        && Buffer.isBuffer(blob.content) && blob.content.length === expected.blobBytes && hash(blob.content) === expected.blobSha256 ? 'available' : 'unavailable';
    };
    const views = value.package_json.results.map(item => ({ viewId: item.viewId, status: inspect(item, 'result') }));
    const documents = value.package_json.documents.map(item => ({ documentId: item.documentId, versionId: item.versionId, status: inspect(item, 'document') }));
    if (total > source.ANALYSIS_SNAPSHOT_PREPARATION_LIMITS.retainedBytes) throw unavailable();
    const result = { status: [...views, ...documents].every(item => item.status === 'available') ? 'available' : 'unavailable', views, documents };
    if (requireIntact && (result.status !== 'available' || rows.size !== views.length + documents.length)) throw unavailable();
    return result;
  }
  async function observe(userId, projectId, analysisId, publicationId) {
    const first = await transaction(userId, projectId, analysisId, async client => {
      const value = await row(client, projectId, analysisId, publicationId);
      return { value, blobs: value.state === 'published' ? await collect(client, value.preparation_id, value.id) : [] };
    });
    const currentAvailability = first.value.state === 'published' ? await availability(first.value, first.blobs) : null;
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const current = await row(client, projectId, analysisId, publicationId);
      if (current.snapshot_sha256 !== first.value.snapshot_sha256) throw unavailable();
      return bounded(envelope(current, context, currentAvailability), null, (await contract).ANALYSIS_SNAPSHOT_PUBLICATION_LIMITS.fullBytes);
    });
  }
  const acceptance = value => ({ action: value.action, publicationId: value.publication_id, snapshotSha256: value.snapshot_sha256,
    acceptedAt: iso(value.accepted_at), acceptedPolicyVersion: Number(value.accepted_policy_version), auditEventId: value.audit_event_id });
  async function requestRow(client, userId, projectId, requestId) {
    return (await client.query('SELECT * FROM research_analysis_snapshot_publication_requests WHERE project_id=$1 AND actor_user_id=$2 AND request_id=$3', [projectId, userId, requestId])).rows[0];
  }
  function matchRequest(value, analysisId, action, requestSha) {
    if (value.analysis_id !== analysisId || value.action !== action || value.request_sha256 !== requestSha) throw error('REQUEST_CONFLICT', 'This UUID already identifies another exact publication action. Recover the original action.');
  }
  async function receipt(userId, projectId, analysisId, requestId, replayed = true) {
    if (!UUID.test(requestId || '')) missing();
    const found = await transaction(userId, projectId, analysisId, async client => {
      const value = await requestRow(client, userId, projectId, requestId.toLowerCase()); if (!value || value.analysis_id !== analysisId) missing(); return value;
    });
    const current = await observe(userId, projectId, analysisId, found.publication_id);
    return bounded({ schema: 'traceomics.analysis-snapshot-publication.v1', serviceId: current.serviceId, projectId, analysisId, actorUserId: Number(userId),
      requestId: found.request_id, requestSha256: found.request_sha256, request: found.request_json, replayed, acceptance: acceptance(found), current }, null,
    (await contract).ANALYSIS_SNAPSHOT_PUBLICATION_LIMITS.fullBytes);
  }
  function assertScope(input, context, userId, projectId, analysisId) {
    if (input.serviceId !== context.serviceId || input.projectId !== projectId || input.analysisId !== analysisId || input.ownerUserId !== Number(userId)) throw error('SCOPE_CONFLICT', 'This action belongs to a different service, project, analysis or account.');
  }
  async function existing(userId, projectId, analysisId, input, action, sha) {
    return transaction(userId, projectId, analysisId, async (client, context) => {
      assertScope(input, context, userId, projectId, analysisId); const found = await requestRow(client, userId, projectId, input.requestId);
      if (found) matchRequest(found, analysisId, action, sha); return !!found;
    });
  }
  async function insertRequest(client, context, input, action, sha, publicationId, auditEventId) {
    await client.query(`INSERT INTO research_analysis_snapshot_publication_requests(project_id,analysis_id,actor_user_id,request_id,action,request_json,request_sha256,publication_id,snapshot_sha256,accepted_policy_version,audit_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [input.projectId, input.analysisId, context.user.id, input.requestId, action, { action, ...input }, sha, publicationId, input.snapshotSha256, action === 'publish' ? 1 : 2, auditEventId]);
  }
  async function publish(userId, projectId, analysisId, input) {
    const schema = await contract, source = await snapshots, recipe = schema.normalizePublishAnalysisSnapshot(input), canonical = schema.canonicalPublishAnalysisSnapshot(recipe), sha = hash(canonical);
    if (await existing(userId, projectId, analysisId, recipe, 'publish', sha)) return { ...await receipt(userId, projectId, analysisId, recipe.requestId), created: false };
    const token = {}, key = `${projectId}:${userId}:${recipe.requestId}`;
    if (verification.size >= schema.ANALYSIS_SNAPSHOT_PUBLICATION_LIMITS.verificationConcurrency || verification.has(key)) throw error('BUSY', 'Publication verification is busy. Keep this exact action and check its original receipt before trying again.', 503);
    verification.set(key, token);
    try {
      const capture = await transaction(userId, projectId, analysisId, async (client, context) => {
        assertWritable(context);
        const candidate = (await client.query('SELECT * FROM research_analysis_snapshot_preparations WHERE id=$1 AND project_id=$2 AND analysis_id=$3 AND owner_user_id=$4', [recipe.preparationId, projectId, analysisId, userId])).rows[0];
        if (!candidate || candidate.state !== 'ready' || candidate.snapshot_sha256 !== recipe.snapshotSha256) throw error('SOURCE_UNAVAILABLE', 'Choose your exact ready private preparation before publishing.');
        return { candidate, blobs: await collect(client, candidate.id) };
      });
      await availability({ package_json: capture.candidate.package_json, snapshot_sha256: capture.candidate.snapshot_sha256 }, capture.blobs, true);
      const created = await transaction(userId, projectId, analysisId, async (client, context) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`snapshot-publication-request:${projectId}:${userId}:${recipe.requestId}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`snapshot-capacity:${projectId}`]);
        const previous = await requestRow(client, userId, projectId, recipe.requestId); if (previous) { matchRequest(previous, analysisId, 'publish', sha); return false; }
        assertWritable(context);
        const candidate = (await client.query('SELECT * FROM research_analysis_snapshot_preparations WHERE id=$1 AND project_id=$2 AND analysis_id=$3 AND owner_user_id=$4 FOR UPDATE', [recipe.preparationId, projectId, analysisId, userId])).rows[0];
        if (!candidate || candidate.state !== 'ready' || candidate.generation !== capture.candidate.generation || candidate.snapshot_sha256 !== recipe.snapshotSha256
            || source.canonicalAnalysisSnapshotPackage(candidate.package_json) !== source.canonicalAnalysisSnapshotPackage(capture.candidate.package_json)) throw error('SOURCE_UNAVAILABLE', 'The exact private preparation is no longer ready for publication.');
        const currentBlobs = (await client.query('SELECT id,kind,sha256,size_bytes FROM research_analysis_snapshot_blobs WHERE preparation_id=$1 ORDER BY id', [candidate.id])).rows;
        const metadata = blob => ({ id: blob.id, kind: blob.kind, sha256: blob.sha256, size_bytes: blob.size_bytes });
        if (source.canonicalSnapshotJson(currentBlobs) !== source.canonicalSnapshotJson(capture.blobs.map(metadata))) throw unavailable();
        const active = (await client.query("SELECT id FROM research_analysis_snapshot_publications WHERE preparation_id=$1 AND state='published'", [candidate.id])).rows[0];
        if (active) throw Object.assign(error('ALREADY_PUBLISHED', 'This private preparation already has an active publication. Open the existing finding.'), { publication: summary(await row(client, projectId, analysisId, active.id), context) });
        const bytes = Buffer.byteLength(source.canonicalAnalysisSnapshotPackage(candidate.package_json)) + schema.ANALYSIS_SNAPSHOT_PUBLICATION_LIMITS.metadataAllowanceBytes;
        const usage = await projectSnapshotUsage(client, projectId), publications = Number((await client.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_publications WHERE project_id=$1', [projectId])).rows[0].n);
        if (publications >= schema.ANALYSIS_SNAPSHOT_PUBLICATION_LIMITS.publications || usage + bytes > source.ANALYSIS_SNAPSHOT_PREPARATION_LIMITS.projectBytes) throw error('CAPACITY', 'This project has reached its retained publication capacity. Withdrawal remains available.');
        const publicationId = `aspub_${crypto.randomBytes(12).toString('hex')}`;
        await client.query(`INSERT INTO research_analysis_snapshot_publications(id,service_id,project_id,analysis_id,publisher_user_id,preparation_id,request_id,request_sha256,package_json,snapshot_sha256,metadata_bytes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [publicationId, context.serviceId, projectId, analysisId, userId, candidate.id, recipe.requestId, sha, candidate.package_json, recipe.snapshotSha256, bytes]);
        for (const blob of currentBlobs) await client.query('INSERT INTO research_analysis_snapshot_publication_blobs(publication_id,preparation_id,view_id,kind) VALUES($1,$2,$3,$4)', [publicationId, candidate.id, blob.id, blob.kind]);
        const event = await audit.recordEvent(client, { projectId, actorUserId: userId, action: 'snapshot.published', targetType: 'snapshot_publication', targetId: publicationId,
          details: { snapshotSha256: recipe.snapshotSha256, policyVersion: 1, resultCount: candidate.package_json.results.length, documentCount: candidate.package_json.documents.length } });
        await insertRequest(client, context, recipe, 'publish', sha, publicationId, event.id); return true;
      });
      return { ...await receipt(userId, projectId, analysisId, recipe.requestId, !created), created };
    } finally { if (verification.get(key) === token) verification.delete(key); }
  }
  async function withdraw(userId, projectId, analysisId, input) {
    const schema = await contract, recipe = schema.normalizeWithdrawAnalysisSnapshot(input), sha = hash(schema.canonicalWithdrawAnalysisSnapshot(recipe));
    if (await existing(userId, projectId, analysisId, recipe, 'withdraw', sha)) return receipt(userId, projectId, analysisId, recipe.requestId);
    const created = await transaction(userId, projectId, analysisId, async (client, context) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`snapshot-publication-request:${projectId}:${userId}:${recipe.requestId}`]);
      const previous = await requestRow(client, userId, projectId, recipe.requestId); if (previous) { matchRequest(previous, analysisId, 'withdraw', sha); return false; }
      const target = await row(client, projectId, analysisId, recipe.publicationId);
      await client.query('SELECT id FROM research_analysis_snapshot_preparations WHERE id=$1 FOR UPDATE', [target.preparation_id]);
      const current = await row(client, projectId, analysisId, recipe.publicationId, true);
      if (current.snapshot_sha256 !== recipe.snapshotSha256) throw error('REQUEST_CONFLICT', 'This action does not identify the acknowledged exact publication.');
      if (current.state === 'withdrawn') throw error('ALREADY_WITHDRAWN', 'This publication is already withdrawn. Recover the original accepted withdrawal instead of inventing another acceptance.');
      if (!canWithdraw(current, context)) throw error('WITHDRAW_REQUIRED', 'Only this publisher or a current project owner or administrator may withdraw this finding.', 403);
      await client.query("UPDATE research_analysis_snapshot_publications SET state='withdrawn',policy_version=2,withdrawn_at=clock_timestamp(),withdrawn_by_user_id=$2 WHERE id=$1", [current.id, userId]);
      await client.query('DELETE FROM research_analysis_snapshot_publication_blobs WHERE publication_id=$1', [current.id]);
      await deleteUnreferencedSnapshotBlobs(client, current.preparation_id);
      const event = await audit.recordEvent(client, { projectId, actorUserId: userId, action: 'snapshot.withdrawn', targetType: 'snapshot_publication', targetId: current.id,
        details: { snapshotSha256: current.snapshot_sha256, policyVersion: 2 } });
      await insertRequest(client, context, recipe, 'withdraw', sha, current.id, event.id); return true;
    });
    return receipt(userId, projectId, analysisId, recipe.requestId, !created);
  }
  async function readBlob(userId, projectId, analysisId, publicationId, viewId, kind) {
    if (!(await snapshots).ANALYSIS_SNAPSHOT_VIEW_ID.test(viewId || '')) missing();
    const captured = await transaction(userId, projectId, analysisId, async client => {
      const value = await row(client, projectId, analysisId, publicationId); if (value.state !== 'published') throw error('PUBLICATION_WITHDRAWN', 'This publication has been withdrawn. Its retained bodies are no longer shared.');
      const item = (kind === 'result' ? value.package_json.results : value.package_json.documents).find(item => item.viewId === viewId); if (!item) missing();
      const blob = (await client.query(`SELECT blob.* FROM research_analysis_snapshot_blobs blob JOIN research_analysis_snapshot_publication_blobs lease
        ON lease.preparation_id=blob.preparation_id AND lease.view_id=blob.id AND lease.kind=blob.kind WHERE lease.publication_id=$1 AND lease.view_id=$2 AND lease.kind=$3`, [publicationId, viewId, kind])).rows[0];
      return { value, item, blob };
    });
    const expected = captured.item.view || captured.item, blob = captured.blob;
    if (!blob || blob.content.length !== expected.blobBytes || blob.size_bytes !== expected.blobBytes || blob.sha256 !== expected.blobSha256 || hash(blob.content) !== expected.blobSha256) throw unavailable();
    await transaction(userId, projectId, analysisId, async client => {
      const current = await row(client, projectId, analysisId, publicationId);
      if (current.state !== 'published' || current.policy_version !== captured.value.policy_version) throw error('PUBLICATION_WITHDRAWN', 'This publication has been withdrawn. Its retained bodies are no longer shared.');
      if (current.snapshot_sha256 !== captured.value.snapshot_sha256 || !(await client.query('SELECT 1 FROM research_analysis_snapshot_publication_blobs WHERE publication_id=$1 AND preparation_id=$2 AND view_id=$3 AND kind=$4', [publicationId, current.preparation_id, viewId, kind])).rowCount) throw unavailable();
    });
    return { bytes: blob.content, mimeType: kind === 'document' || ['table', 'metrics', 'embedding'].includes(captured.item.view.family) ? 'application/json; charset=utf-8' : captured.item.source.format.id === 'org.w3.png' ? 'image/png' : 'image/jpeg' };
  }
  async function paging(userId, projectId, analysisId, serviceId, input, requests) {
    const schema = await contract, L = schema.ANALYSIS_SNAPSHOT_PUBLICATION_LIMITS, limit = input.limit === undefined ? 30 : Number(input.limit);
    if (Object.keys(input).some(key => !['limit', 'cursor'].includes(key)) || input.limit !== undefined && !['string', 'number'].includes(typeof input.limit)
        || typeof input.limit === 'string' && !/^[1-9][0-9]?$/.test(input.limit) || !Number.isSafeInteger(limit) || limit < 1 || limit > L.page) throw error('INVALID_PAGE', 'Choose a publication page size from 1 to 30.', 400);
    const kind = requests ? 'publication-requests' : 'snapshot-publications', scope = hash((await snapshots).canonicalSnapshotJson([serviceId, projectId, analysisId, Number(userId)])).slice(0, 16);
    let position = null, identity = null;
    if (input.cursor !== undefined) {
      try {
        if (typeof input.cursor !== 'string' || input.cursor.length > L.cursor || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
        const bytes = Buffer.from(input.cursor, 'base64url'); if (bytes.toString('base64url') !== input.cursor) throw new Error();
        const decoded = JSON.parse(bytes.toString('utf8'));
        if (!Array.isArray(decoded) || decoded.length !== 4 || decoded[0] !== kind || decoded[1] !== scope || typeof decoded[2] !== 'string' || iso(decoded[2]) !== decoded[2]
            || !(requests ? UUID : schema.ANALYSIS_SNAPSHOT_PUBLICATION_ID).test(decoded[3])) throw new Error();
        [, , position, identity] = decoded;
      } catch { throw error('INVALID_PAGE', 'This publication cursor does not belong to the current account and analysis.', 400); }
    }
    return { limit, position, identity, cursor: value => Buffer.from(JSON.stringify([kind, scope, iso(requests ? value.accepted_at : value.published_at), requests ? value.request_id : value.id])).toString('base64url') };
  }
  async function list(userId, projectId, analysisId, input = {}, requests = false) {
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const page = await paging(userId, projectId, analysisId, context.serviceId, input, requests), params = [projectId, analysisId, page.limit + 1];
      if (requests) params.push(userId);
      let where = '';
      if (page.position) { params.push(page.position, page.identity); where = ` AND (date_trunc('milliseconds',${requests ? 'receipt.accepted_at' : 'publication.published_at'}),${requests ? 'receipt.request_id' : 'publication.id'})<($${params.length - 1}::timestamptz,$${params.length}${requests ? '::uuid' : ''})`; }
      const values = (await client.query(requests
        ? `SELECT receipt.*,publication.state,publication.policy_version,publication.withdrawn_at,publication.withdrawn_by_user_id FROM research_analysis_snapshot_publication_requests receipt JOIN research_analysis_snapshot_publications publication ON publication.id=receipt.publication_id WHERE receipt.project_id=$1 AND receipt.analysis_id=$2 AND receipt.actor_user_id=$4${where} ORDER BY date_trunc('milliseconds',receipt.accepted_at) DESC,receipt.request_id DESC LIMIT $3`
        : `SELECT publication.id,publication.publisher_user_id,publication.published_at,publication.preparation_id,publication.snapshot_sha256,
          publication.state,publication.policy_version,publication.withdrawn_at,publication.withdrawn_by_user_id,publisher.display_name AS publisher_label,
          CASE WHEN publication.state='published' THEN jsonb_build_object('analysisVersion',publication.package_json#>'{analysis,version}',
            'analysisName',publication.package_json#>'{analysis,name}','resultCount',jsonb_array_length(publication.package_json->'results'),
            'documentCount',jsonb_array_length(publication.package_json->'documents'),'prerequisiteCount',jsonb_array_length(publication.package_json#>'{prerequisites,items}')) ELSE NULL END AS selection_json
          FROM research_analysis_snapshot_publications publication JOIN users publisher ON publisher.id=publication.publisher_user_id
          WHERE publication.project_id=$1 AND publication.analysis_id=$2${where} ORDER BY date_trunc('milliseconds',publication.published_at) DESC,publication.id DESC LIMIT $3`, params)).rows;
      const result = { schema: 'traceomics.analysis-snapshot-publication.v1', serviceId: context.serviceId, projectId, analysisId,
        [requests ? 'actorUserId' : 'viewerUserId']: Number(userId), ...(!requests ? { canPublish: canPublish(context) } : {}), items: [], nextCursor: null };
      let last;
      for (const value of values.slice(0, page.limit)) {
        const item = requests ? { requestId: value.request_id, requestSha256: value.request_sha256, request: value.request_json, acceptance: acceptance(value), currentPolicy: policy(value) } : summary(value, context);
        result.items.push(item);
        if (Buffer.byteLength(JSON.stringify(result)) + 256 > (await contract).ANALYSIS_SNAPSHOT_PUBLICATION_LIMITS.listBytes) { result.items.pop(); break; }
        last = value;
      }
      if (last && (values.length > result.items.length)) result.nextCursor = page.cursor(last);
      if (!last && values.length) throw error('CAPACITY', 'A publication summary exceeds the bounded list response.');
      return result;
    });
  }
  return { publish, withdraw, get: observe, getByRequest: receipt, list, listRequests: (userId, projectId, analysisId, input) => list(userId, projectId, analysisId, input, true), readBlob };
}

async function projectSnapshotUsage(client, projectId) {
  const value = (await client.query(`SELECT (COALESCE((SELECT SUM(reserved_bytes) FROM research_analysis_snapshot_preparations WHERE project_id=$1),0)
    +COALESCE((SELECT SUM(blob.size_bytes) FROM research_analysis_snapshot_blobs blob JOIN research_analysis_snapshot_preparations candidate ON candidate.id=blob.preparation_id WHERE candidate.project_id=$1 AND candidate.state='deleted'),0)
    +COALESCE((SELECT SUM(metadata_bytes) FROM research_analysis_snapshot_publications WHERE project_id=$1),0))::bigint AS bytes`, [projectId])).rows[0];
  return Number(value.bytes);
}
async function deleteUnreferencedSnapshotBlobs(client, preparationId) {
  await client.query(`DELETE FROM research_analysis_snapshot_blobs blob WHERE blob.preparation_id=$1
    AND EXISTS(SELECT 1 FROM research_analysis_snapshot_preparations candidate WHERE candidate.id=blob.preparation_id AND candidate.state='deleted')
    AND NOT EXISTS(SELECT 1 FROM research_analysis_snapshot_publication_blobs lease WHERE lease.preparation_id=blob.preparation_id AND lease.view_id=blob.id)`, [preparationId]);
}
function analysisSnapshotPublicationRoutes({ database = db, logger = console } = {}) {
  const router = require('express').Router({ mergeParams: true }), service = createAnalysisSnapshotPublicationService(database);
  const handler = (action, status = 200) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const value = await action(req);
      if (value?.bytes) {
        res.set({ 'Content-Type': value.mimeType, 'Content-Length': String(value.bytes.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
        return res.status(200).send(value.bytes);
      }
      const created = value?.created, result = { ...value }; delete result.created;
      res.set('Cache-Control', 'private, no-store').status(status === 201 && created === false ? 200 : status).json(result);
    } catch (failure) {
      if (failure.snapshotUncertainCommit) return res.status(500).json({ error: 'This action may have committed. Keep its exact UUID and recover the original accepted action before trying again.', code: 'ANALYSIS_SNAPSHOT_UNCONFIRMED' });
      if (!failure.status && failure.code !== 'INVALID_ANALYSIS_SNAPSHOT_PUBLICATION') logger.error?.(`[AnalysisSnapshotPublication] Request could not be confirmed (${String(failure.code || 'REQUEST_FAILED').replace(/[^A-Z0-9_]/gi, '').slice(0, 64)}).`);
      const status = failure.status || (String(failure.code || '').startsWith('INVALID_') ? 400 : 500);
      res.status(status).json({ error: status === 500 ? 'The publication could not be confirmed.' : failure.message, code: failure.code || 'ANALYSIS_SNAPSHOT_INTERNAL', ...(failure.publication ? { publication: failure.publication } : {}) });
    }
  };
  const args = req => [req.user.id, req.params.projectId, req.params.analysisId];
  const noQuery = req => { if (Object.keys(req.query).length) throw error('INVALID_PAGE', 'This exact retained view does not accept query parameters.', 400); };
  router.get('/requests', handler(req => service.listRequests(...args(req), req.query)));
  router.get('/requests/:requestId', handler(req => { noQuery(req); return service.getByRequest(...args(req), req.params.requestId); }));
  router.get('/', handler(req => service.list(...args(req), req.query)));
  router.post('/', handler(req => service.publish(...args(req), req.body), 201));
  router.post('/:publicationId/withdrawals', handler(req => {
    if (req.body?.publicationId !== req.params.publicationId) throw error('REQUEST_CONFLICT', 'The withdrawal target must match this exact publication.');
    return service.withdraw(...args(req), req.body);
  }));
  router.get('/:publicationId/views/:viewId', handler(req => { noQuery(req); return service.readBlob(...args(req), req.params.publicationId, req.params.viewId, 'result'); }));
  router.get('/:publicationId/documents/:viewId', handler(req => { noQuery(req); return service.readBlob(...args(req), req.params.publicationId, req.params.viewId, 'document'); }));
  router.get('/:publicationId', handler(req => { noQuery(req); return service.get(...args(req), req.params.publicationId); }));
  return router;
}
module.exports = { createAnalysisSnapshotPublicationService, analysisSnapshotPublicationRoutes, projectSnapshotUsage, deleteUnreferencedSnapshotBlobs };
