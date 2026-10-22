import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ARTIFACT_IMPORT_SCHEMA, canonicalArtifactImportRequest, normalizeArtifactImportRequest } from '../shared/artifactImport.mjs';
import { ANALYSIS_LOCAL_INTAKE_LIMITS, analysisLocalIntakeAttachmentRequest, canonicalAnalysisLocalIntake, normalizeAnalysisLocalIntake } from '../shared/analysisLocalIntake.mjs';

const db = require('./pgDatabase');
const storage = require('./storage');
const { createAnalysisAttachmentService } = require('./analysisAttachments');
const { createArtifactVersionService } = require('./artifactVersions');
const { createResearchAnalysisService } = require('./researchAnalyses');
const sha = value => createHash('sha256').update(value).digest('hex');
const fixtureProject = 'proj_' + 'a'.repeat(24), fixtureAnalysis = 'ra_' + 'b'.repeat(24), fixtureService = 'svc_' + 'c'.repeat(32);
const fixture = () => {
  const requestId = '00000000-0000-4000-8000-000000000001';
  return { requestId, serviceId: fixtureService, importRequest: { schema: ARTIFACT_IMPORT_SCHEMA, projectId: fixtureProject, ownerUserId: 7, requestId,
    originalFilename: 'evidence.csv', name: 'β comparison', artifactType: 'auto', previousVersionId: null, sha256: 'd'.repeat(64), sizeBytes: 12 },
  attachment: { requestId: '00000000-0000-4000-8000-000000000002', action: 'create', attachmentId: null, expectedHeadRevisionId: null,
    caption: '  β comparison\r\ncomplete  ', suppliedOrigin: {} } };
};

describe('immutable source-free local intake contracts', () => {
  it('preserves the literal v1 import field order, UUID-included digest and 160 UTF-16 name bound', () => {
    const input = fixture().importRequest;
    const literal = '{"schema":"traceomics.artifact-import.v1","projectId":"proj_aaaaaaaaaaaaaaaaaaaaaaaa","ownerUserId":7,"requestId":"00000000-0000-4000-8000-000000000001","originalFilename":"evidence.csv","name":"β comparison","artifactType":"auto","previousVersionId":null,"sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sizeBytes":12}';
    expect(canonicalArtifactImportRequest(input)).toBe(literal);
    expect(sha(canonicalArtifactImportRequest(input))).toBe(sha(literal));
    expect(canonicalArtifactImportRequest({ ...input, requestId: randomUUID() })).not.toBe(literal);
    expect(normalizeArtifactImportRequest({ ...input, name: '🧬'.repeat(80) }).name).toHaveLength(160);
    expect(() => normalizeArtifactImportRequest({ ...input, name: '🧬'.repeat(81) })).toThrow();
  });
  it('binds account, workspace, analysis, exact file meaning, action, context and separate UUIDs without bytes', () => {
    const input = fixture(), parsed = normalizeAnalysisLocalIntake(input), canonical = canonicalAnalysisLocalIntake(fixtureAnalysis, input);
    expect(parsed.attachment).toMatchObject({ caption: 'β comparison\ncomplete', suppliedOrigin: { origin: null, sourceReference: null, documentReference: null, environmentReference: null } });
    expect(JSON.parse(canonical)).toEqual({ schema: 'traceomics.analysis-local-intake.v1', serviceId: fixtureService, projectId: fixtureProject,
      analysisId: fixtureAnalysis, ownerUserId: 7, requestId: input.requestId, importRequest: input.importRequest, attachment: parsed.attachment });
    for (const changed of [{ ...input, serviceId: 'svc_' + 'd'.repeat(32) }, { ...input, importRequest: { ...input.importRequest, ownerUserId: 8 } },
      { ...input, attachment: { ...input.attachment, caption: 'Other interpretation' } }, { ...input, attachment: { ...input.attachment, action: 'correct', attachmentId: 'raa_' + 'e'.repeat(24), expectedHeadRevisionId: 'rar_' + 'f'.repeat(24) } }]) {
      expect(canonicalAnalysisLocalIntake(fixtureAnalysis, changed)).not.toBe(canonical);
    }
    expect(canonicalAnalysisLocalIntake('ra_' + 'f'.repeat(24), input)).not.toBe(canonical);
    const acceptance = { versionId: 'av_' + 'e'.repeat(24), sha256: input.importRequest.sha256, sizeBytes: 12, previousVersionId: null };
    expect(analysisLocalIntakeAttachmentRequest(input, acceptance)).toEqual({ requestId: input.attachment.requestId,
      reference: { kind: 'artifact-version', versionId: acceptance.versionId, sha256: acceptance.sha256 }, caption: parsed.attachment.caption, suppliedOrigin: parsed.attachment.suppliedOrigin });
    expect(() => analysisLocalIntakeAttachmentRequest(input, { ...acceptance, sha256: 'f'.repeat(64) })).toThrow();
  });
  it('rejects file bodies, unknown/accessor/prototype fields, unsupported purposes, targets, sizes and malformed Unicode', () => {
    const input = fixture(); let read = false;
    const getter = { ...input }; Object.defineProperty(getter, 'importRequest', { enumerable: true, get() { read = true; return input.importRequest; } });
    const values = [getter, Object.assign(Object.create({ inherited: true }), input), { ...input, bytes: 'scientific data' },
      { ...input, attachment: { ...input.attachment, requestId: input.requestId } }, { ...input, attachment: { ...input.attachment, caption: '\ud800' } },
      { ...input, attachment: { ...input.attachment, caption: 'x'.repeat(2001) } }, { ...input, attachment: { ...input.attachment, attachmentId: 'raa_' + 'e'.repeat(24) } },
      { ...input, attachment: { ...input.attachment, action: 'correct' } }];
    for (const change of [{ originalFilename: 'private.rds' }, { originalFilename: 'vector.svg' }, { sizeBytes: ANALYSIS_LOCAL_INTAKE_LIMITS.fileBytes + 1 },
      { artifactType: 'sample-sheet' }, { previousVersionId: 'av_' + 'e'.repeat(24) }, { name: 'x\0y' }, { sha256: 'broken' }, { requestId: randomUUID() }]) values.push({ ...input, importRequest: { ...input.importRequest, ...change } });
    for (const value of values) expect(() => normalizeAnalysisLocalIntake(value)).toThrow();
    expect(read).toBe(false);
    const upper = { ...input, requestId: input.requestId.toUpperCase(), importRequest: { ...input.importRequest, requestId: input.requestId.toUpperCase() } };
    expect(normalizeAnalysisLocalIntake(upper).requestId).toBe(input.requestId);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('local evidence intake PostgreSQL, upload and attachment recovery', () => {
  let directory, provider, service, artifacts, http, server, owner, colleague, viewer, outsider, project, analysis, serviceId, oldRoot;
  const bytes = 'gene,score\nA,12\n';
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'traceomics-local-intake-'));
    oldRoot = process.env.STORAGE_ROOT; process.env.STORAGE_ROOT = path.join(directory, 'storage');
    provider = storage.createLocalStorageProvider(); http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    await db.resetSchemaForTests(); service = createAnalysisAttachmentService(db, provider); artifacts = createArtifactVersionService(db, provider);
    owner = await http.createUserWithToken({ email: 'intake-owner@example.test', displayName: 'Evidence researcher' });
    colleague = await http.createUserWithToken({ email: 'intake-colleague@example.test' }); viewer = await http.createUserWithToken({ email: 'intake-viewer@example.test' });
    outsider = await http.createUserWithToken({ email: 'intake-outsider@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Intake lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Laptop evidence' });
    await db.addProjectMember(project.id, colleague.user.id, 'analyst'); await db.addProjectMember(project.id, viewer.user.id, 'viewer');
    analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Outside evidence' })).analysis;
    serviceId = (await service.listLocalIntakes(owner.user.id, project.id, analysis.id)).serviceId;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (oldRoot === undefined) delete process.env.STORAGE_ROOT; else process.env.STORAGE_ROOT = oldRoot;
    await db.close(); await rm(directory, { recursive: true, force: true });
  });
  const base = (a = analysis, p = project) => `/api/projects/${p.id}/analyses/${a.id}/attachments/local-intakes`;
  const recipe = (actor = owner, changes = {}) => {
    const requestId = randomUUID();
    return { requestId, serviceId, importRequest: { schema: ARTIFACT_IMPORT_SCHEMA, projectId: project.id, ownerUserId: actor.user.id, requestId,
      originalFilename: 'laptop-evidence.csv', name: 'Treatment result', artifactType: 'auto', previousVersionId: null, sha256: sha(bytes), sizeBytes: Buffer.byteLength(bytes) },
    attachment: { requestId: randomUUID(), action: 'create', attachmentId: null, expectedHeadRevisionId: null, caption: 'Completed laptop result', suppliedOrigin: { origin: 'Supplied outside the app' } }, ...changes };
  };
  const post = (value, actor = owner, a = analysis) => http.api(server, base(a), { method: 'POST', token: actor.token, body: value });
  const get = (requestId, actor = owner, a = analysis) => http.api(server, `${base(a)}/${requestId}`, { token: actor.token });
  const list = (query = '', actor = owner, a = analysis) => http.api(server, base(a) + query, { token: actor.token });
  const count = async table => (await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
  async function upload(value, actor = owner, content = bytes, serviceOverride = artifacts) {
    const filename = path.join(directory, randomUUID()); await writeFile(filename, content);
    return serviceOverride.importFile(actor.user.id, project.id, { path: filename, originalFilename: value.importRequest.originalFilename,
      name: value.importRequest.name, artifactType: value.importRequest.artifactType, requestId: value.requestId,
      expectedRequestSha256: sha(canonicalArtifactImportRequest(value.importRequest)) });
  }
  async function attach(value, imported, actor = owner) {
    const body = analysisLocalIntakeAttachmentRequest(value, imported.importRequest.acceptance);
    return value.attachment.action === 'correct' ? service.correct(actor.user.id, project.id, analysis.id, value.attachment.attachmentId, body) : service.create(actor.user.id, project.id, analysis.id, body);
  }
  async function wrappedDatabase(intercept) {
    const pool = await db.connect();
    return { ...db, connect: async () => ({ connect: async () => {
      const client = await pool.connect(); return { query: (sql, values) => intercept(client, sql, values), release: destroy => client.release(destroy) };
    } }) };
  }
  async function seed(values, actor = owner) {
    await db.query(`INSERT INTO research_analysis_intakes
      (project_id,analysis_id,owner_user_id,request_id,attachment_request_id,service_id,request_sha256,recipe_json,created_at)
      SELECT $1,$2,$3,request_id,attachment_request_id,$4,request_sha256,recipe_json,'2026-01-01T00:00:00Z'
      FROM jsonb_to_recordset($5::jsonb) AS x(request_id uuid,attachment_request_id uuid,request_sha256 text,recipe_json jsonb)`,
    [project.id, analysis.id, actor.user.id, serviceId, JSON.stringify(values.map(value => ({ request_id: value.requestId, attachment_request_id: value.attachment.requestId,
      request_sha256: sha(canonicalAnalysisLocalIntake(analysis.id, value)), recipe_json: normalizeAnalysisLocalIntake(value) })))]);
  }

  it('acknowledges metadata before bytes without importing, attaching, executing or changing unrelated analysis drafts', async () => {
    const value = recipe(), response = await post(value);
    expect(response.status).toBe(201); expect(response.res.headers.get('cache-control')).toContain('no-store');
    expect(response.data).toMatchObject({ serviceId, projectId: project.id, analysisId: analysis.id, ownerUserId: owner.user.id, requestId: value.requestId,
      requestSha256: sha(canonicalAnalysisLocalIntake(analysis.id, value)), canContinue: true, canUpload: true, canAttach: true, replayed: false,
      recipe: normalizeAnalysisLocalIntake(value), importOutcome: { status: 'unconfirmed', receipt: null }, attachmentOutcome: { status: 'unconfirmed', receipt: null } });
    for (const table of ['managed_artifact_versions', 'managed_artifact_import_receipts', 'research_analysis_attachments', 'jobs', 'private_r_executions', 'workflow_runs']) expect(await count(table)).toBe(0);
    expect((await createResearchAnalysisService().get(owner.user.id, project.id, analysis.id)).analysis).toEqual(analysis);
    expect((await post(value)).status).toBe(200); expect((await get(value.requestId)).data.requestSha256).toBe(response.data.requestSha256);
    const discovered = await list(); expect(discovered.data.items).toHaveLength(1); expect(discovered.data.items[0]).toMatchObject({ requestId: value.requestId, action: 'create', importStatus: 'unconfirmed', attachmentStatus: 'unconfirmed' });
    expect(JSON.stringify(response.data)).not.toMatch(/storage_key|localPath|fileBytes|content\.csv/);
  });

  it('observes the original accepted import and attachment independently after reopen, newer corrections and missing bytes', async () => {
    const value = recipe(); await post(value);
    const imported = await upload(value), importOnly = await get(value.requestId);
    expect(importOnly.data).toMatchObject({ importOutcome: { status: 'accepted', receipt: { requestId: value.requestId, availability: 'recorded' } }, attachmentOutcome: { status: 'unconfirmed' } });
    expect(await count('research_analysis_attachments')).toBe(0);
    const attached = await attach(value, imported), firstRevision = attached.acceptedRevision;
    const newer = await service.correct(colleague.user.id, project.id, analysis.id, attached.attachment.id, { requestId: randomUUID(), expectedHeadRevisionId: firstRevision.id,
      reference: firstRevision.reference, caption: 'Colleague supplied context correction', suppliedOrigin: {} });
    const key = (await db.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [imported.versionId])).rows[0].storage_key; await unlink(provider.resolveKey(key));
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    const reopened = createAnalysisAttachmentService(db, provider), recovered = await reopened.getLocalIntake(owner.user.id, project.id, analysis.id, value.requestId);
    expect(recovered).toMatchObject({ canContinue: false, canUpload: false, canAttach: false,
      importOutcome: { status: 'accepted', receipt: { availability: 'unavailable', version: null, canImport: false } },
      attachmentOutcome: { status: 'accepted', receipt: { acceptedRevision: firstRevision, acceptedSourceAccess: 'unavailable', attachment: { headRevisionId: newer.acceptedRevision.id } } } });
    expect((await post(value)).status).toBe(200); expect((await list()).data.items[0]).toMatchObject({ importStatus: 'accepted', attachmentStatus: 'accepted' });
    expect(await count('managed_artifact_versions')).toBe(1); expect(await count('research_analysis_attachment_revisions')).toBe(2);
  });

  it('keeps source-independent import acceptance when a managed row is removed before attachment', async () => {
    const value = recipe(); await post(value); const imported = await upload(value);
    await db.query('DELETE FROM managed_artifact_versions WHERE id=$1', [imported.versionId]);
    const response = await get(value.requestId); expect(response.status).toBe(200);
    expect(response.data.importOutcome).toMatchObject({ status: 'accepted', receipt: { acceptance: { versionId: imported.versionId, sha256: value.importRequest.sha256 }, availability: 'unavailable', version: null } });
    expect(response.data.attachmentOutcome.status).toBe('unconfirmed'); expect(await count('research_analysis_intakes')).toBe(1);
  });

  it('keeps owner recipes private under current membership, with archive/demo and current reader recovery distinct from fresh write', async () => {
    const value = recipe(); await post(value);
    for (const actor of [viewer, colleague, outsider]) expect((await get(value.requestId, actor)).status).toBe(404);
    expect((await list('', viewer)).data.items).toEqual([]); expect((await list('', outsider)).status).toBe(404);
    expect((await post(recipe(viewer), viewer)).status).toBe(403);
    expect((await post({ ...value, importRequest: { ...value.importRequest, ownerUserId: viewer.user.id } })).data.code).toBe('INVALID_ANALYSIS_LOCAL_INTAKE');
    await createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, status: 'archived' });
    expect((await get(value.requestId)).data.canContinue).toBe(false); expect((await post(value)).status).toBe(200);
    expect((await post(recipe())).data.code).toBe('ANALYSIS_ARCHIVED');
    await createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: 2, status: 'active' });
    const oldMode = process.env.APP_DEPLOYMENT_MODE; process.env.APP_DEPLOYMENT_MODE = 'demo';
    try { expect((await get(value.requestId)).data.canUpload).toBe(false); expect((await post(value)).status).toBe(200); expect((await post(recipe())).status).toBe(403); }
    finally { if (oldMode === undefined) delete process.env.APP_DEPLOYMENT_MODE; else process.env.APP_DEPLOYMENT_MODE = oldMode; }
    await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, owner.user.id]);
    expect((await get(value.requestId)).status).toBe(404); expect((await list()).status).toBe(404);
  });

  it('serializes UUID races, freezes context and enforces separate import and attachment identities across analysis scopes', async () => {
    const value = recipe(), race = await Promise.all([post(value), post(value)]);
    expect(race.map(result => result.status).sort()).toEqual([200, 201]); expect(await count('research_analysis_intakes')).toBe(1);
    expect((await post({ ...value, attachment: { ...value.attachment, caption: 'Changed after admission' } })).data.code).toBe('ANALYSIS_LOCAL_INTAKE_REQUEST_CONFLICT');
    const second = recipe(); second.attachment.requestId = value.attachment.requestId;
    expect((await post(second)).data.code).toBe('ANALYSIS_LOCAL_INTAKE_REQUEST_CONFLICT');
    const other = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Another question' })).analysis;
    expect((await post(value, owner, other)).data.code).toBe('ANALYSIS_LOCAL_INTAKE_REQUEST_CONFLICT'); expect((await get(value.requestId, owner, other)).status).toBe(404);
    const shared = recipe(), cross = await Promise.all([post(shared), post(shared, owner, other)]);
    expect(cross.map(result => result.status).sort()).toEqual([201, 409]);
    const foreign = recipe(colleague); foreign.requestId = value.requestId; foreign.importRequest.requestId = value.requestId;
    expect((await post(foreign, colleague)).status).toBe(201); expect((await list('', colleague)).data.items).toHaveLength(1);
  });

  it('recovers real committed admission after a lost COMMIT acknowledgement through bounded owner discovery', async () => {
    let lost = false;
    const wrapped = await wrappedDatabase(async (client, sql, values) => {
      const result = await client.query(sql, values);
      if (sql === 'COMMIT' && !lost) { lost = true; throw Object.assign(new Error('Owned fixture loses committed admission reply'), { code: 'ECONNRESET' }); }
      return result;
    });
    const value = recipe(); await expect(createAnalysisAttachmentService(wrapped, provider).admitLocalIntake(owner.user.id, project.id, analysis.id, value)).rejects.toMatchObject({ code: 'ECONNRESET' });
    const reopened = createAnalysisAttachmentService(db, provider), discovery = await reopened.listLocalIntakes(owner.user.id, project.id, analysis.id);
    expect(discovery.items).toHaveLength(1); expect(discovery.items[0].requestId).toBe(value.requestId);
    expect((await reopened.getLocalIntake(owner.user.id, project.id, analysis.id, value.requestId)).recipe).toEqual(normalizeAnalysisLocalIntake(value));
    expect((await post(value)).status).toBe(200); expect(await count('research_analysis_intakes')).toBe(1); expect(await count('managed_artifact_versions')).toBe(0);
  });

  it('binds stable installation identity and never conflates absent admission with rejection or another workspace', async () => {
    const value = recipe(); expect((await get(value.requestId)).data.code).toBe('ANALYSIS_LOCAL_INTAKE_NOT_FOUND');
    const changed = { ...value, serviceId: 'svc_' + 'f'.repeat(32) };
    expect((await post(changed)).data.code).toBe('ANALYSIS_LOCAL_INTAKE_SERVICE_CHANGED'); expect(await count('research_analysis_intakes')).toBe(0);
    await post(value);
    const sameService = await db.getServiceExecutionIdentity(); expect(sameService.id).toBe(serviceId);
    expect((await get(value.requestId)).data.serviceId).toBe(serviceId);
    await expect(db.query('UPDATE service_execution_identity SET service_id=$1 WHERE singleton=TRUE', ['svc_' + 'e'.repeat(32)])).rejects.toMatchObject({ code: '55000' });
    expect((await list()).data.serviceId).toBe(serviceId);
  });

  it('recovers lost genuine upload and attachment commit replies from the original admitted UUIDs without deleting accepted bytes', async () => {
    const value = recipe(); await post(value);
    async function loseCommit() {
      let lost = false;
      return wrappedDatabase(async (client, sql, values) => {
        const result = await client.query(sql, values);
        if (sql === 'COMMIT' && !lost) { lost = true; throw Object.assign(new Error('Owned fixture loses an accepted stage reply'), { code: 'ECONNRESET' }); }
        return result;
      });
    }
    await expect(upload(value, owner, bytes, createArtifactVersionService(await loseCommit(), provider))).rejects.toMatchObject({ code: 'ECONNRESET' });
    const importRecovered = (await get(value.requestId)).data;
    expect(importRecovered).toMatchObject({ importOutcome: { status: 'accepted', receipt: { availability: 'recorded' } }, attachmentOutcome: { status: 'unconfirmed' } });
    const accepted = importRecovered.importOutcome.receipt.acceptance;
    const key = (await db.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [accepted.versionId])).rows[0].storage_key;
    expect(await readFile(provider.resolveKey(key), 'utf8')).toBe(bytes);
    const sourceBody = analysisLocalIntakeAttachmentRequest(value, accepted);
    await expect(createAnalysisAttachmentService(await loseCommit(), provider).create(owner.user.id, project.id, analysis.id, sourceBody)).rejects.toMatchObject({ code: 'ECONNRESET' });
    const recovered = (await get(value.requestId)).data;
    expect(recovered.importOutcome.status).toBe('accepted'); expect(recovered.attachmentOutcome.status).toBe('accepted');
    expect((await service.create(owner.user.id, project.id, analysis.id, sourceBody)).acceptedRevision).toEqual(recovered.attachmentOutcome.receipt.acceptedRevision);
    expect(await count('managed_artifact_versions')).toBe(1); expect(await count('research_analysis_attachment_revisions')).toBe(1);
  });

  it('reports conflicting existing import and attachment UUID meanings rather than adopting their sources or context', async () => {
    const acceptedInput = recipe(), imported = await upload(acceptedInput);
    const changed = { ...acceptedInput, importRequest: { ...acceptedInput.importRequest, name: 'Different frozen meaning' } }; await post(changed);
    expect((await get(changed.requestId)).data.importOutcome).toEqual({ status: 'conflict', receipt: null });
    const value = recipe(); await post(value); const matchingImport = await upload(value);
    await service.create(owner.user.id, project.id, analysis.id, { ...analysisLocalIntakeAttachmentRequest(value, matchingImport.importRequest.acceptance), caption: 'Different accepted attachment meaning' });
    const recovered = await get(value.requestId); expect(recovered.data.importOutcome.status).toBe('accepted'); expect(recovered.data.attachmentOutcome).toEqual({ status: 'conflict', receipt: null });
    const waiting = recipe(); await post(waiting);
    await service.create(owner.user.id, project.id, analysis.id, { requestId: waiting.attachment.requestId, reference: { kind: 'artifact-version', versionId: imported.versionId, sha256: imported.sha256 }, caption: waiting.attachment.caption, suppliedOrigin: waiting.attachment.suppliedOrigin });
    expect((await get(waiting.requestId)).data).toMatchObject({ importOutcome: { status: 'unconfirmed' }, attachmentOutcome: { status: 'conflict', receipt: null } });
    const discovery = await list(); expect(discovery.data.items.filter(item => item.importStatus === 'conflict')).toHaveLength(1); expect(discovery.data.items.filter(item => item.attachmentStatus === 'conflict')).toHaveLength(2);
  });

  it('keeps correction intake immutable across a competing head without automatically rebasing or attaching', async () => {
    const original = recipe(); await post(original); const imported = await upload(original), created = await attach(original, imported);
    const value = recipe(); value.attachment = { ...value.attachment, action: 'correct', attachmentId: created.attachment.id, expectedHeadRevisionId: created.acceptedRevision.id };
    expect((await post(value)).status).toBe(201); const replacement = await upload(value);
    const newer = await service.correct(colleague.user.id, project.id, analysis.id, created.attachment.id, { requestId: randomUUID(), expectedHeadRevisionId: created.acceptedRevision.id,
      reference: created.acceptedRevision.reference, caption: 'Competing correction', suppliedOrigin: {} });
    await expect(attach(value, replacement)).rejects.toMatchObject({ code: 'ANALYSIS_ATTACHMENT_HEAD_CONFLICT' });
    expect((await get(value.requestId)).data).toMatchObject({ recipe: normalizeAnalysisLocalIntake(value), importOutcome: { status: 'accepted' }, attachmentOutcome: { status: 'unconfirmed' } });
    expect((await post(value)).status).toBe(200);
    const stale = recipe(); stale.attachment = { ...value.attachment, requestId: stale.attachment.requestId };
    expect((await post(stale)).data).toMatchObject({ code: 'ANALYSIS_ATTACHMENT_HEAD_CONFLICT', submittedExpectedHeadRevisionId: created.acceptedRevision.id, attachment: { headRevisionId: newer.acceptedRevision.id } });
    expect(await count('research_analysis_attachment_revisions')).toBe(2);
    const deliberate = recipe(); deliberate.attachment = { ...deliberate.attachment, action: 'correct', attachmentId: created.attachment.id, expectedHeadRevisionId: newer.acceptedRevision.id };
    expect((await post(deliberate)).status).toBe(201);
    const deliberatelyImported = await upload(deliberate), corrected = await attach(deliberate, deliberatelyImported);
    expect(corrected.acceptedRevision.previousRevisionId).toBe(newer.acceptedRevision.id);
    expect((await get(deliberate.requestId)).data.attachmentOutcome).toMatchObject({ status: 'accepted', receipt: { acceptedRevision: corrected.acceptedRevision } });
    expect((await get(value.requestId)).data.attachmentOutcome.status).toBe('unconfirmed');
  });

  it('uses existing exact multipart upload hashes and preserves the frozen recipe after a rejected changed file', async () => {
    const value = recipe(); await post(value);
    async function multipart(content) {
      const form = new FormData(); form.append('file', new Blob([content], { type: 'text/csv' }), value.importRequest.originalFilename);
      form.append('name', value.importRequest.name); form.append('artifactType', 'auto'); form.append('requestId', value.requestId); form.append('expectedRequestSha256', sha(canonicalArtifactImportRequest(value.importRequest)));
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/artifact-versions/${project.id}`, { method: 'POST', headers: { Cookie: `${require('./config').sessionCookieName()}=${owner.token}`, Origin: 'http://localhost:5173' }, body: form });
      return { status: response.status, data: await response.json() };
    }
    expect((await multipart('gene,score\nA,13\n')).data.code).toBe('ARTIFACT_IMPORT_SOURCE_CHANGED');
    expect(await count('managed_artifact_versions')).toBe(0); expect((await get(value.requestId)).data.importOutcome.status).toBe('unconfirmed');
    const uploaded = await multipart(bytes); expect(uploaded.status).toBe(201); expect((await multipart(bytes)).status).toBe(200);
    expect(await count('managed_artifact_versions')).toBe(1); await attach(value, uploaded.data);
    expect((await get(value.requestId)).data.attachmentOutcome.status).toBe('accepted');
  });

  it('reads unconfirmed outcomes without waiting on the upload advisory lock or deadlocking project read/write locks', async () => {
    const value = recipe(); await post(value);
    let reached, release; const entered = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const wrapper = await wrappedDatabase(async (client, sql, values) => {
      const result = await client.query(sql, values);
      if (sql.includes('pg_advisory_xact_lock') && String(values?.[0]).startsWith('artifact-import:')) { reached(); await gate; }
      return result;
    });
    const pending = upload(value, owner, bytes, createArtifactVersionService(wrapper, provider)); await entered;
    let timer;
    try {
      const observed = await Promise.race([get(value.requestId), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Recovery waited on upload fence')), 2500); })]);
      expect(observed.status).toBe(200); expect(observed.data.importOutcome.status).toBe('unconfirmed');
    } finally { clearTimeout(timer); release(); }
    await pending; expect((await get(value.requestId)).data.importOutcome.status).toBe('accepted');
  });

  it('bounds concurrent admissions across owners at 2000 and retains replay at the limit', async () => {
    const values = Array.from({ length: 1999 }, () => recipe()); await seed(values);
    const requests = [recipe(), recipe(colleague)], race = await Promise.all([post(requests[0]), post(requests[1], colleague)]);
    expect(race.map(result => result.status).sort()).toEqual([201, 409]); expect(race.find(result => result.status === 409).data.code).toBe('ANALYSIS_LOCAL_INTAKE_LIMIT');
    expect(await count('research_analysis_intakes')).toBe(2000); expect((await post(values[0])).status).toBe(200);
  });

  it('paginates owner-only source-free metadata deterministically, including completed and conflicted admissions', async () => {
    const values = Array.from({ length: 5 }, () => recipe()); await seed(values);
    const noFiles = createAnalysisAttachmentService(db, { resolveKey() { throw new Error('List must not inspect source bytes'); } });
    const first = await noFiles.listLocalIntakes(owner.user.id, project.id, analysis.id, { limit: '2' });
    const second = await noFiles.listLocalIntakes(owner.user.id, project.id, analysis.id, { limit: '2', cursor: first.nextCursor });
    const third = await noFiles.listLocalIntakes(owner.user.id, project.id, analysis.id, { limit: '2', cursor: second.nextCursor });
    expect([...first.items, ...second.items, ...third.items].map(item => item.requestId)).toEqual(values.map(value => value.requestId).sort().reverse());
    expect(third.nextCursor).toBeNull(); expect(JSON.stringify(first)).not.toMatch(/recipe|sha256|versionId|storage_key/);
    for (const query of ['?limit=31', '?limit=0', '?cursor=bad', '?unknown=x']) expect((await list(query)).data.code).toBe('INVALID_ANALYSIS_LOCAL_INTAKE_PAGE');
    const other = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Other list' })).analysis;
    expect((await list(`?cursor=${first.nextCursor}`, owner, other)).status).toBe(400);
  });

  it('keeps every recipe field immutable and upgrades v27 idempotently without rewriting existing evidence or import receipts', async () => {
    const value = recipe(); await post(value); const imported = await upload(value), attached = await attach(value, imported);
    const comment = await service.addComment(viewer.user.id, project.id, analysis.id, attached.attachment.id, attached.acceptedRevision.id, { requestId: randomUUID(), body: 'Keep exact evidence' });
    for (const update of ["request_sha256='" + 'f'.repeat(64) + "'", "recipe_json='{}'::jsonb", 'created_at=now()', "service_id='svc_" + 'f'.repeat(32) + "'"]) {
      await expect(db.query(`UPDATE research_analysis_intakes SET ${update} WHERE request_id=$1`, [value.requestId])).rejects.toMatchObject({ code: '55000' });
    }
    await expect(db.query('DELETE FROM research_analysis_intakes WHERE request_id=$1', [value.requestId])).rejects.toMatchObject({ code: '55000' });
    await db.query('DROP TABLE research_analysis_intakes'); await db.query("UPDATE app_schema_contract SET schema_version=20261027 WHERE schema_key='traceomics.runtime'");
    await db.initSchema({ force: true }); await db.initSchema({ force: true });
    expect((await artifacts.getImportReceipt(owner.user.id, project.id, value.requestId)).acceptance.versionId).toBe(imported.versionId);
    expect((await service.getRequest(owner.user.id, project.id, analysis.id, value.attachment.requestId)).acceptedRevision).toEqual(attached.acceptedRevision);
    expect((await service.getCommentRequest(viewer.user.id, project.id, analysis.id, comment.requestId)).comment).toEqual(comment.comment);
    await expect(db.query('DELETE FROM managed_artifact_versions WHERE id=$1', [imported.versionId])).rejects.toMatchObject({ code: '55000' });
    expect((await post(value)).status).toBe(201); expect((await get(value.requestId)).data.attachmentOutcome.status).toBe('accepted');
    expect((await db.query("SELECT schema_version FROM app_schema_contract WHERE schema_key='traceomics.runtime'")).rows[0].schema_version).toBe(20261031);
  });

  it('removes recipes and receipts before scoped demo analysis cleanup without affecting another owner workspace', async () => {
    const value = recipe(); await post(value); const imported = await upload(value); await attach(value, imported);
    const organization = await db.createOrganizationForUser(colleague.user.id, { name: 'Persistent intake lab' });
    const retainedProject = await db.createProjectForUser(colleague.user.id, { organizationId: organization.id, name: 'Keep private intake' });
    const retainedAnalysis = (await createResearchAnalysisService().create(colleague.user.id, retainedProject.id, { requestId: randomUUID(), name: 'Keep local admission' })).analysis;
    const retained = recipe(colleague); retained.importRequest.projectId = retainedProject.id;
    await service.admitLocalIntake(colleague.user.id, retainedProject.id, retainedAnalysis.id, retained);
    await db.query("UPDATE users SET is_demo_guest=TRUE,expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [owner.user.id]);
    expect(await db.deleteExpiredDemoGuest(owner.user.id)).toBe(true); expect(await count('research_analysis_intakes')).toBe(1);
    expect((await service.getLocalIntake(colleague.user.id, retainedProject.id, retainedAnalysis.id, retained.requestId)).recipe).toEqual(normalizeAnalysisLocalIntake(retained));
    expect(await count('managed_artifact_import_receipts')).toBe(0);
  });
});
