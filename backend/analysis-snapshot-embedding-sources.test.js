import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { beginWorkflowRun, commitWorkflowRun } from '../shared/workflowState.mjs';
import { canonicalAnalysisSnapshotPackage, canonicalAnalysisSnapshotPreparation } from '../shared/analysisSnapshotPreparationDispatch.mjs';
import { canonicalAnalysisSnapshotWorkflowContextBinding, projectAnalysisSnapshotWorkflowContext } from '../shared/analysisSnapshotWorkflowContext.mjs';
import { validateSnapshotPreparation, validateSnapshotPreparationOptions, decodeSnapshotPreparationTyped } from '../src/analyses/snapshotPreparationValidation.js';
import { validateSnapshotPublication, validateSnapshotPublicationReceipt } from '../src/analyses/snapshotPublicationValidation.js';
const db = require('./pgDatabase'), storage = require('./storage');
const { createResearchAnalysisService } = require('./researchAnalyses');
const { createArtifactVersionService } = require('./artifactVersions');
const { createWorkflowRuntime } = require('./workflowRuntime');
const { fingerprint } = require('./retainedWorkflowSnapshots');
const { createAnalysisSnapshotPreparationService } = require('./analysisSnapshotPreparations');
const { createAnalysisSnapshotPublicationService, projectSnapshotUsage } = require('./analysisSnapshotPublications');
const { projectRetainedEmbedding } = require('./retainedTypedPreviews');
const { EXPERT_R_PROFILE } = require('./expertR');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const off = () => ({ method: false, parameterKeys: [], seed: false, environment: false });
const coordinates = (count = 12) => ({ x: Array.from({ length: count }, (_, index) => index / 8), y: Array.from({ length: count }, (_, index) => index % 3 - 0.25),
  ids: Array.from({ length: count }, (_, index) => 'cell-' + index), groups: Array.from({ length: count }, (_, index) => index % 2 ? 'Treated' : 'Control') });

describe.skipIf(!process.env.DATABASE_URL)('fixed sampled embedding findings and current authority', () => {
  let directory, provider, preparations, publications, owner, reader, admin, project, analysis, serviceId, settings, http, server;
  beforeAll(async () => {
    settings = Object.fromEntries(['STORAGE_ROOT', 'VAULT_ROOT', 'APP_DEPLOYMENT_MODE'].map(key => [key, process.env[key]]));
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'traceomics-fixed-embedding-'));
    Object.assign(process.env, { STORAGE_ROOT: path.join(directory, 'storage'), VAULT_ROOT: path.join(directory, 'private'), APP_DEPLOYMENT_MODE: 'private' });
    await fs.mkdir(process.env.STORAGE_ROOT); provider = storage.createLocalStorageProvider(); http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    await db.resetSchemaForTests();
    owner = await http.createUserWithToken({ email: 'embedding-owner@example.test' }); reader = await http.createUserWithToken({ email: 'embedding-reader@example.test' }); admin = await http.createUserWithToken({ email: 'embedding-admin@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Embedding lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Fixed embedding study' });
    await db.addProjectMember(project.id, reader.user.id, 'viewer'); await db.addProjectMember(project.id, admin.user.id, 'admin');
    analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: crypto.randomUUID(), name: 'Selected coordinate findings' })).analysis;
    serviceId = (await db.getServiceExecutionIdentity()).id; preparations = createAnalysisSnapshotPreparationService(db, provider); publications = createAnalysisSnapshotPublicationService();
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve)); await db.close();
    for (const [key, value] of Object.entries(settings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const scope = (actor = owner) => ({ serviceId, projectId: project.id, analysisId: analysis.id, userId: actor.user.id });
  const base = () => `/api/projects/${project.id}/analyses/${analysis.id}`;
  const api = (suffix, options = {}, actor = owner) => http.api(server, base() + suffix, { token: actor.token, ...options });
  const op = saved => ({ requestId: saved.requestId, requestSha256: saved.requestSha256 });
  const recipe = (results, extra = {}) => ({ schema: 'traceomics.analysis-snapshot-preparation.v2', requestId: crypto.randomUUID(), serviceId, projectId: project.id, analysisId: analysis.id,
    ownerUserId: owner.user.id, analysisVersion: analysis.version, results, documents: [], notes: { summary: 'Selected exact points', decisions: null, limitations: null }, prerequisites: [], ...extra });
  const publishInput = saved => ({ requestId: crypto.randomUUID(), serviceId, projectId: project.id, analysisId: analysis.id, ownerUserId: owner.user.id, preparationId: saved.preparationId, snapshotSha256: saved.snapshotSha256 });
  const withdrawInput = (saved, actor = owner) => ({ requestId: crypto.randomUUID(), serviceId, projectId: project.id, analysisId: analysis.id, ownerUserId: actor.user.id, publicationId: saved.acceptance.publicationId, snapshotSha256: saved.acceptance.snapshotSha256 });
  async function pin(references, actor = owner) { analysis = (await createResearchAnalysisService().patch(actor.user.id, project.id, analysis.id, { expectedVersion: analysis.version, references })).analysis; }
  async function source({ value = coordinates(), bytes = null, actor = owner, semantics = { role: 'primary', title: 'Recorded coordinates', entityType: 'cell', axes: { x: { label: 'PC 1' }, y: { label: 'PC 2', unit: 'score' } } } } = {}) {
    bytes ||= Buffer.from(JSON.stringify(value)); const id = db.genId('eri'), job = await db.createProjectJob(actor.user.id, project.id, { jobType: 'generic' });
    await db.query("UPDATE jobs SET status='completed' WHERE id=$1", [job.id]); const key = storage.projectStorageFileKey(project.id, 'artifacts', job.id, 'embedding.json'); await fs.writeFile(provider.prepareWrite(key), bytes);
    const descriptor = { id, type: 'scatter', sha256: hash(bytes), sizeBytes: bytes.length, profileId: EXPERT_R_PROFILE.id, semantics };
    await db.query('INSERT INTO workflow_artifacts(id,owner_user_id,project_id,job_id,descriptor_json,storage_key) VALUES($1,$2,$3,$4,$5,$6)', [id, actor.user.id, project.id, job.id, descriptor, key]);
    return { reference: { kind: 'artifact-version', versionId: id, sha256: hash(bytes) }, descriptor, key, bytes, value };
  }
  async function direct(item, pointLimit = 5, version = analysis.version, target = preparations) {
    const options = await target.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-typed-references', analysisVersion: version });
    expect(await validateSnapshotPreparationOptions(options, scope(), 'analysis-typed-references', version)).toEqual(options);
    const choice = options.items.find(value => value.reference.versionId === item.reference.versionId); expect(choice.viewFamily).toBe('embedding');
    return { kind: 'typed-analysis-reference', reference: item.reference, descriptorSha256: choice.descriptorSha256, caption: 'Exact retained coordinates', view: { family: 'embedding', pointLimit } };
  }
  async function capture(item) {
    const object = await db.createProjectAnalysisObject(owner.user.id, project.id, { objectType: 'seurat', displayName: 'Private source' }), job = await db.createProjectJob(owner.user.id, project.id, { jobType: 'generic', analysisObjectId: object.id });
    await db.query("UPDATE jobs SET status='completed' WHERE id=$1", [job.id]); const bytes = Buffer.from('opaque starting checkpoint'), id = db.genId('art'), key = storage.projectStorageFileKey(project.id, 'checkpoints', job.id, 'input.rds'); await fs.writeFile(provider.prepareWrite(key), bytes);
    await db.query("INSERT INTO job_artifacts(id,project_id,job_id,created_by_user_id,artifact_type,result_analysis_object_id,storage_kind,storage_uri,checksum_sha256,size_bytes,status) VALUES($1,$2,$3,$4,'checkpoint',$5,'local_internal',$6,$7,$8,'available')", [id, project.id, job.id, owner.user.id, object.id, key, hash(bytes), bytes.length]);
    const method = { format: 'traceomics-workflow', schemaVersion: 1, id: 'recorded-embedding', name: 'Recorded embedding method', version: '1.0.0', description: 'Selected capture', runtime: { language: 'r', profileId: EXPERT_R_PROFILE.id }, files: { 'inspect.R': '# Private code must not be copied' },
      steps: [{ id: 'inspect', label: 'Recorded map', entry: 'inspect.R', inputs: { analysis: { from: 'input.analysis', type: 'rds' } }, parameters: [{ key: 'applied', type: 'integer', label: 'Recorded applied setting', default: 4 }], outputs: { points: { type: 'scatter', label: 'Recorded points', semantics: item.descriptor.semantics } } }], tabs: [{ id: 'points', label: 'Points', step: 'inspect', plots: [] }] };
    const runtime = createWorkflowRuntime(db, provider), instance = await runtime.open(owner.user.id, project.id, object.id, JSON.stringify(method));
    const running = beginWorkflowRun(method, instance.state, { id: crypto.randomUUID(), stepId: 'inspect', parameters: { applied: 0 }, seed: 0 });
    const state = commitWorkflowRun(method, running, { id: running.active.id, generation: running.generation, outputs: { points: item.descriptor }, producerKey: hash('recorded') });
    await db.query('UPDATE workflow_instances SET state_json=$2 WHERE id=$1', [instance.id, state]); const saved = await runtime.save(owner.user.id, project.id, instance.id, 'Exact coordinate capture');
    return { runtime, instanceId: instance.id, reference: { kind: 'workflow-snapshot', snapshotId: saved.id, sha256: await fingerprint((await db.query('SELECT * FROM workflow_snapshots WHERE id=$1', [saved.id])).rows[0]) } };
  }
  async function captured(recorded, pointLimit = 5, included = false) {
    const page = await preparations.options(owner.user.id, project.id, analysis.id, { kind: 'captured-workflow-outputs', analysisVersion: analysis.version, snapshotId: recorded.reference.snapshotId, snapshotSha256: recorded.reference.sha256 });
    expect(await validateSnapshotPreparationOptions(page, scope(), 'captured-workflow-outputs', analysis.version, recorded.reference)).toEqual(page);
    const choice = page.items[0], contextSelection = included ? { method: true, parameterKeys: ['applied'], seed: true, environment: false } : off();
    const context = projectAnalysisSnapshotWorkflowContext({ snapshotReference: recorded.reference, stepId: choice.stepId, port: choice.port, offer: choice.contextOffer, selection: contextSelection });
    return { kind: 'captured-workflow-output', snapshotReference: recorded.reference, stepId: choice.stepId, port: choice.port, reference: choice.reference, descriptorSha256: choice.descriptorSha256, caption: 'Reviewed captured points', view: { family: 'embedding', pointLimit }, contextSelection,
      contextSha256: hash(canonicalAnalysisSnapshotWorkflowContextBinding({ serviceId, projectId: project.id, analysisId: analysis.id, ownerUserId: owner.user.id, analysisVersion: analysis.version, context })) };
  }
  async function ready(item = null, pointLimit = 5, target = preparations) { item ||= await source(); await pin([item.reference]); const input = recipe([await direct(item, pointLimit)]); return { item, input, saved: await target.prepare(owner.user.id, project.id, analysis.id, input) }; }
  async function bytes(saved, index = 0, target = preparations) { return target.readBlob(owner.user.id, project.id, analysis.id, saved.preparationId, saved.package.results[index].viewId, 'result'); }
  async function wrappedDatabase(intercept) { const pool = await db.connect(); return { ...db, connect: async () => ({ connect: async () => { const client = await pool.connect(); return { query: (sql, values) => intercept(client, sql, values), release: destroy => client.release(destroy) }; } }) }; }

  it('retains exact direct and captured sampled bounds with one guarded source read, immutable meaning and current colleague JSON', async () => {
    const item = await source(), recorded = await capture(item); await pin([item.reference, recorded.reference]); const input = recipe([await direct(item, 5), await direct(item, 8), await captured(recorded, 5, true), await captured(recorded, 5)]);
    let opens = 0, ranks = 0; const createHash = crypto.createHash.bind(crypto), spy = vi.spyOn(crypto, 'createHash').mockImplementation((...args) => { const digest = createHash(...args), update = digest.update.bind(digest); digest.update = (...values) => { if (values[0] === 'traceomics.retained-embedding.priority.v1\0') ranks++; return update(...values); }; return digest; });
    let saved;
    try { saved = await createAnalysisSnapshotPreparationService(db, { ...provider, openVerifiedRead: (...args) => { opens++; return provider.openVerifiedRead(...args); } }).prepare(owner.user.id, project.id, analysis.id, input); } finally { spy.mockRestore(); }
    expect(saved.state).toBe('ready'); expect(opens).toBe(1); expect(ranks).toBe(24); // Two distinct bounds, not four repeated rankings.
    expect(saved.requestSha256).toBe(hash(canonicalAnalysisSnapshotPreparation(input))); expect(saved.snapshotSha256).toBe(hash(canonicalAnalysisSnapshotPackage(saved.package)));
    const response = { ...saved }; delete response.created; expect(await validateSnapshotPreparation(response, scope(), input)).toEqual(response);
    const first = saved.package.results[0], body = await decodeSnapshotPreparationTyped((await bytes(saved)).bytes, first);
    expect(body).toEqual(projectRetainedEmbedding({ source: body.source, value: item.value, pointLimit: 5, semantics: first.view.semantics }));
    expect(first.view.spec).toEqual({ pointLimit: 5 }); expect(first.view.width).toBeNull(); expect(body.sampling).toMatchObject({ sourceCount: 12, returnedCount: 5, method: 'sha256-priority-v1', aggregated: false, stratified: false });
    expect(saved.package.results[2].origin.context.parameters[0].value).toBe(0); expect(saved.package.results[2].origin.context.seed).toBe(0);
    expect(saved.package.results[2].view.blobSha256).toBe(first.view.blobSha256); expect(saved.package.results[1].view.viewSha256).not.toBe(first.view.viewSha256);
    const action = publishInput(saved), accepted = await publications.publish(owner.user.id, project.id, analysis.id, action), receipt = { ...accepted }; delete receipt.created;
    expect(await validateSnapshotPublicationReceipt(receipt, scope(), { action: 'publish', ...action })).toEqual(receipt);
    await recorded.runtime.close(owner.user.id, project.id, recorded.instanceId); await fs.unlink(provider.resolveKey(item.key));
    const publicRecord = await publications.get(reader.user.id, project.id, analysis.id, accepted.acceptance.publicationId);
    expect(await validateSnapshotPublication(publicRecord, scope(reader), { publicationId: accepted.acceptance.publicationId, snapshotSha256: saved.snapshotSha256 })).toEqual(publicRecord);
    const raw = await publications.readBlob(reader.user.id, project.id, analysis.id, accepted.acceptance.publicationId, first.viewId, 'result'); expect(raw.mimeType).toBe('application/json; charset=utf-8'); expect(await decodeSnapshotPreparationTyped(raw.bytes, first)).toEqual(body);
    expect(JSON.stringify(publicRecord)).not.toMatch(/Private code|internalStorage|storage_key|sourceImport/);
  });

  it.each([{ x: [0.25, 0.5, 0.75], y: [1, 2, 3] }, { x: [], y: [] }])('retains legacy absent identifiers and empty coordinates honestly %#', async value => {
    const { saved } = await ready(await source({ value, semantics: {} }), 2); expect(saved.state).toBe('ready');
    const body = await decodeSnapshotPreparationTyped((await bytes(saved)).bytes, saved.package.results[0]); expect(body.ids).toBeNull(); expect(body).not.toHaveProperty('groups');
    expect(body.identity.kind).toBe('source-row-positions'); expect(body.semantics.entityType).toBeNull(); expect(body.sampling.sourceCount).toBe(value.x.length);
    body.sourceIndices.forEach((index, at) => expect(body.x[at]).toBe(value.x[index]));
  });

  it('bounds actual retained UTF-8 bytes and records byte-limited sampling without dropping alignment', async () => {
    const value = coordinates(1800); value.ids = value.ids.map(id => id + '漢'.repeat(160)); value.groups = value.groups.map(group => group + '界'.repeat(80));
    const { saved } = await ready(await source({ value }), 5000), raw = await bytes(saved), body = await decodeSnapshotPreparationTyped(raw.bytes, saved.package.results[0]);
    expect(raw.bytes.length).toBeLessThanOrEqual(256 * 1024); expect(body.sampling).toMatchObject({ sourceCount: 1800, requestedLimit: 5000, budgetLimited: true, sampled: true });
    expect(body.x.length).toBeGreaterThan(0); expect(body.x.length).toBeLessThan(1800); body.sourceIndices.forEach((index, at) => { expect(body.ids[at]).toBe(value.ids[index]); expect(body.groups[at]).toBe(value.groups[index]); });
  });

  it.each(['{"x":[0,1],"y":[1,2],"ids":["same","same"]}', '{"x":[1],"x":[2],"y":[0]}', '{"x":[9007199254740993],"y":[0]}', '{"x":[1e400],"y":[0]}', '{"x":[1e-4000],"y":[0]}', '{"x":[-0],"y":[0]}', '{"x":[0,null],"y":[1,2]}'])('rejects complete malformed coordinates before retaining any sample: %s', async text => {
    const { saved } = await ready(await source({ bytes: Buffer.from(text) }), 1); expect(saved.state).toBe('failed'); expect(saved.package).toBeNull(); expect(saved.canResume).toBe(true);
    expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
  });

  it('checks omitted points and complete group counts instead of validating only selected points', async () => {
    for (const bad of ['duplicate', 'groups']) {
      const value = coordinates(200); if (bad === 'duplicate') value.ids[199] = value.ids[0]; else value.groups = value.groups.map((_, index) => 'group-' + index % 41);
      const { saved } = await ready(await source({ value }), 1); expect(saved.state).toBe('failed');
    }
  });

  it('keeps options metadata-only, excludes foreign sources, pins old N and rejects altered bound/hash intent', async () => {
    const item = await source(), foreign = await source({ actor: admin }); await pin([item.reference]); await pin([item.reference, foreign.reference], admin); const version = analysis.version;
    const target = createAnalysisSnapshotPreparationService(db, { ...provider, openVerifiedRead: () => { throw new Error('Chooser may not read sources'); } });
    const choices = await target.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-typed-references', analysisVersion: version }); expect(choices.items.map(item => item.reference)).toEqual([item.reference]);
    const selected = await direct(item, 3, version, target); await pin([]); expect((await preparations.prepare(owner.user.id, project.id, analysis.id, recipe([selected], { analysisVersion: version }))).state).toBe('ready');
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, recipe([selected]))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE' });
    for (const view of [{ family: 'embedding', pointLimit: 0 }, { family: 'embedding', pointLimit: 5001 }, { family: 'embedding', pointLimit: 5, seed: 1 }]) await expect(preparations.prepare(owner.user.id, project.id, analysis.id, recipe([{ ...selected, view }], { analysisVersion: version }))).rejects.toMatchObject({ status: 400 });
    const input = recipe([selected], { analysisVersion: version }), saved = await preparations.prepare(owner.user.id, project.id, analysis.id, input);
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, { ...input, results: [{ ...selected, view: { family: 'embedding', pointLimit: 4 } }] })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_REQUEST_CONFLICT' });
    expect((await preparations.getByRequest(owner.user.id, project.id, analysis.id, input.requestId)).snapshotSha256).toBe(saved.snapshotSha256);
  });

  it('shares only selected retained HTTP JSON; viewers/admins receive no private preparation, original source, edit or execution grant', async () => {
    const { item, saved } = await ready(), accepted = await publications.publish(owner.user.id, project.id, analysis.id, publishInput(saved)), id = accepted.acceptance.publicationId, viewId = saved.package.results[0].viewId;
    for (const actor of [reader, admin]) {
      expect((await api(`/snapshot-preparations/${saved.preparationId}`, {}, actor)).status).toBe(404);
      await expect(createArtifactVersionService(db, provider).get(actor.user.id, project.id, item.reference.versionId)).rejects.toMatchObject({ code: 'ARTIFACT_VERSION_NOT_FOUND' });
      await expect(createArtifactVersionService(db, provider).resolveVerified(actor.user.id, project.id, { artifactId: item.reference.versionId, versionId: item.reference.versionId, projectId: project.id, sha256: item.reference.sha256 }, { purpose: 'execution' })).rejects.toThrow();
      expect((await http.api(server, `/api/projects/${project.id}/artifacts/${item.reference.versionId}/download`, { token: actor.token })).status).not.toBe(200);
      const raw = await fetch(`http://127.0.0.1:${server.address().port}${base()}/snapshot-publications/${id}/views/${viewId}`, { headers: { Cookie: `${require('./config').sessionCookieName()}=${actor.token}` } });
      expect(raw.status).toBe(200); expect(raw.headers.get('content-type')).toBe('application/json; charset=utf-8'); expect(raw.headers.get('cache-control')).toContain('no-store'); expect(hash(Buffer.from(await raw.arrayBuffer()))).toBe(saved.package.results[0].view.blobSha256);
    }
    for (const suffix of [`/snapshot-preparations/${saved.preparationId}/views/${viewId}?pointLimit=5000`, `/snapshot-publications/${id}/views/${viewId}?pointLimit=5000`]) expect((await api(suffix)).status).toBe(400);
    expect((await api(`/snapshot-publications/${id}/views/asv_${'a'.repeat(24)}`, {}, reader)).status).toBe(404);
    const other = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: crypto.randomUUID(), name: 'Different analysis' })).analysis;
    await expect(publications.readBlob(reader.user.id, project.id, other.id, id, viewId, 'result')).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Other project lab' }), secondProject = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Other project' });
    await db.addProjectMember(secondProject.id, reader.user.id, 'viewer');
    const secondAnalysis = (await createResearchAnalysisService().create(owner.user.id, secondProject.id, { requestId: crypto.randomUUID(), name: 'Other project analysis' })).analysis;
    await expect(publications.readBlob(reader.user.id, secondProject.id, secondAnalysis.id, id, viewId, 'result')).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND' });
    expect((await createArtifactVersionService(db, provider).get(owner.user.id, project.id, item.reference.versionId)).canReplace).toBe(false);
    const replacement = path.join(directory, 'replacement-' + crypto.randomUUID() + '.json'); await fs.writeFile(replacement, item.bytes);
    await expect(createArtifactVersionService(db, provider).importFile(owner.user.id, project.id, { path: replacement, originalFilename: 'replacement.json', name: 'Cannot replace a retained workflow result' }, item.reference.versionId)).rejects.toMatchObject({ code: 'ARTIFACT_VERSION_READ_ONLY' });
    await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, reader.user.id]);
    expect((await api(`/snapshot-publications/${id}/views/${viewId}`, {}, reader)).status).toBe(404);
    await expect(preparations.prepare(admin.user.id, project.id, analysis.id, { ...recipe([await direct(item)]), ownerUserId: admin.user.id })).rejects.toMatchObject({ status: 409 });
  });

  it('keeps archived retained access and downgraded original replay, while an admin withdrawal ends shared leases', async () => {
    const { saved, input } = await ready(), action = publishInput(saved), accepted = await publications.publish(owner.user.id, project.id, analysis.id, action);
    analysis = (await createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: analysis.version, status: 'archived' })).analysis;
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    expect((await publications.readBlob(reader.user.id, project.id, analysis.id, accepted.acceptance.publicationId, saved.package.results[0].viewId, 'result')).bytes.length).toBeGreaterThan(0);
    expect((await preparations.prepare(owner.user.id, project.id, analysis.id, input)).snapshotSha256).toBe(saved.snapshotSha256);
    expect((await publications.publish(owner.user.id, project.id, analysis.id, action)).replayed).toBe(true);
    await expect(publications.publish(owner.user.id, project.id, analysis.id, { ...action, requestId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_WRITE_REQUIRED' });
    await preparations.remove(owner.user.id, project.id, analysis.id, saved.preparationId, op(saved));
    const withdrawn = await publications.withdraw(admin.user.id, project.id, analysis.id, withdrawInput(accepted, admin)); expect(withdrawn.acceptance.action).toBe('withdraw');
    await expect(publications.readBlob(reader.user.id, project.id, analysis.id, accepted.acceptance.publicationId, saved.package.results[0].viewId, 'result')).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN' });
    expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
  });

  it.each(['revoke', 'withdraw'])('fences held embedding bytes after actual %s before final read authorization', async action => {
    const { saved } = await ready(), accepted = await publications.publish(owner.user.id, project.id, analysis.id, publishInput(saved)), reached = gate(), release = gate(); let held = false;
    const wrapped = await wrappedDatabase(async (client, sql, values) => { const result = await client.query(sql, values); if (sql === 'COMMIT' && !held) { held = true; reached.release(); await release.promise; } return result; });
    const pending = createAnalysisSnapshotPublicationService(wrapped).readBlob(reader.user.id, project.id, analysis.id, accepted.acceptance.publicationId, saved.package.results[0].viewId, 'result'); await reached.promise;
    try { if (action === 'revoke') await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, reader.user.id]); else await publications.withdraw(owner.user.id, project.id, analysis.id, withdrawInput(accepted)); } finally { release.release(); }
    await expect(pending).rejects.toMatchObject({ code: action === 'revoke' ? 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND' : 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN' });
  });

  it('retains one physical sample after private deletion and original loss, and preserves acceptance after retained byte corruption', async () => {
    const { item, saved } = await ready(), before = await projectSnapshotUsage(db, project.id), accepted = await publications.publish(owner.user.id, project.id, analysis.id, publishInput(saved));
    const row = (await db.query('SELECT metadata_bytes FROM research_analysis_snapshot_publications')).rows[0]; expect(await projectSnapshotUsage(db, project.id)).toBe(before + Number(row.metadata_bytes));
    await preparations.remove(owner.user.id, project.id, analysis.id, saved.preparationId, op(saved)); await fs.unlink(provider.resolveKey(item.key));
    expect((await publications.readBlob(reader.user.id, project.id, analysis.id, accepted.acceptance.publicationId, saved.package.results[0].viewId, 'result')).bytes.length).toBe(saved.package.results[0].view.blobBytes);
    // Scoped legacy storage fault; immutable trigger remains enabled for ordinary writes.
    const client = await (await db.connect()).connect(); try { await client.query('BEGIN'); await client.query('SET LOCAL session_replication_role=replica'); await client.query("UPDATE research_analysis_snapshot_blobs SET content=decode(repeat('00',size_bytes),'hex') WHERE preparation_id=$1", [saved.preparationId]); await client.query('COMMIT'); } finally { client.release(); }
    const observed = await publications.get(reader.user.id, project.id, analysis.id, accepted.acceptance.publicationId); expect(observed.snapshotSha256).toBe(saved.snapshotSha256); expect(observed.availability.status).toBe('unavailable');
    await expect(publications.readBlob(reader.user.id, project.id, analysis.id, accepted.acceptance.publicationId, saved.package.results[0].viewId, 'result')).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_VIEW_UNAVAILABLE' });
    expect((await publications.getByRequest(owner.user.id, project.id, analysis.id, accepted.requestId)).acceptance.publicationId).toBe(accepted.acceptance.publicationId);
  });

  it('rejects source/descriptor mutation while a verified embedding is held and holds final metadata through ready adoption', async () => {
    const item = await source(); await pin([item.reference]); const choice = await direct(item), reached = gate(), release = gate(); let held = false;
    const pending = createAnalysisSnapshotPreparationService(db, { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args); if (!held) { held = true; reached.release(); await release.promise; } return opened; } }).prepare(owner.user.id, project.id, analysis.id, recipe([choice])); await reached.promise;
    try { await db.query("UPDATE workflow_artifacts SET descriptor_json=jsonb_set(descriptor_json,'{semantics,axes,x,label}','\"Changed axis\"') WHERE id=$1", [item.reference.versionId]); } finally { release.release(); }
    expect((await pending).state).toBe('failed');
    const current = await direct(item); let closed = false, locked = false;
    const tracking = { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args), close = opened.handle.close.bind(opened.handle); opened.handle.close = async () => { await close(); closed = true; }; return opened; } };
    const wrapped = await wrappedDatabase(async (client, sql, values) => { const result = await client.query(sql, values); if (closed && !locked && sql.startsWith('SELECT * FROM workflow_artifacts') && sql.endsWith(' FOR SHARE')) { locked = true; const competing = await (await db.connect()).connect();
      try { await competing.query('BEGIN'); await competing.query("SET LOCAL lock_timeout='100ms'"); await expect(competing.query("UPDATE workflow_artifacts SET descriptor_json=jsonb_set(descriptor_json,'{semantics,title}','\"Late change\"') WHERE id=$1", [item.reference.versionId])).rejects.toMatchObject({ code: '55P03' }); } finally { await competing.query('ROLLBACK'); competing.release(); } } return result; });
    expect((await createAnalysisSnapshotPreparationService(wrapped, tracking).prepare(owner.user.id, project.id, analysis.id, recipe([current]))).state).toBe('ready'); expect(locked).toBe(true);
  });

  it('does not resurrect a deleted held builder and preserves shared quota reservation accounting', async () => {
    const item = await source(); await pin([item.reference]); const input = recipe([await direct(item)]), reached = gate(), release = gate(); let held = false;
    const target = createAnalysisSnapshotPreparationService(db, { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args); if (!held) { held = true; reached.release(); await release.promise; } return opened; } });
    const pending = target.prepare(owner.user.id, project.id, analysis.id, input); await reached.promise;
    const observed = await preparations.getByRequest(owner.user.id, project.id, analysis.id, input.requestId); expect((await db.query('SELECT reserved_bytes FROM research_analysis_snapshot_preparations')).rows[0].reserved_bytes).toBe(String(16 * 1024 * 1024));
    try { await preparations.remove(owner.user.id, project.id, analysis.id, observed.preparationId, op(observed)); } finally { release.release(); }
    expect((await pending).state).toBe('deleted'); expect(await projectSnapshotUsage(db, project.id)).toBe(0); expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
  });

  it('rejects changed same-FD coordinates after the original complete hash without retaining an unverified sample', async () => {
    const item = await source(); await pin([item.reference]); const input = recipe([await direct(item)]); let changed = false;
    const target = createAnalysisSnapshotPreparationService(db, { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args); if (!changed) { changed = true; await fs.writeFile(provider.resolveKey(item.key), Buffer.from(item.bytes.toString().replace('0.125', '9.125'))); } return opened; } });
    expect((await target.prepare(owner.user.id, project.id, analysis.id, input)).state).toBe('failed'); expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
  });

  it('enforces complete source point and byte bounds before a retained projection can be accepted', async () => {
    const tooMany = await source({ value: coordinates(100001) }); const { saved } = await ready(tooMany, 1); expect(saved.state).toBe('failed');
    const tooLarge = await source({ bytes: Buffer.alloc(5 * 1024 * 1024 + 1, 32) }); await pin([tooLarge.reference]);
    expect((await preparations.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-typed-references', analysisVersion: analysis.version })).items).toEqual([]);
  });

  it('uses the shared ten-private-preparation quota and preserves original replay without rehashing at capacity', async () => {
    const item = await source(); await pin([item.reference]); const choice = await direct(item), input = recipe([choice]);
    const saved = await preparations.prepare(owner.user.id, project.id, analysis.id, input);
    for (let index = 1; index < 10; index++) expect((await preparations.prepare(owner.user.id, project.id, analysis.id, recipe([choice]))).state).toBe('ready');
    const target = createAnalysisSnapshotPreparationService(db, { ...provider, openVerifiedRead: () => { throw new Error('Replay/capacity cannot read original bytes'); } });
    await expect(target.prepare(owner.user.id, project.id, analysis.id, recipe([choice]))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_CAPACITY' });
    expect((await target.prepare(owner.user.id, project.id, analysis.id, input)).snapshotSha256).toBe(saved.snapshotSha256);
  });

  it('recovers actual ready and publish lost COMMIT acknowledgements before new writer/source checks', async () => {
    const item = await source(); await pin([item.reference]); const input = recipe([await direct(item)]); let ready = false, lost = false;
    const wrapped = await wrappedDatabase(async (client, sql, values) => { const result = await client.query(sql, values); if (sql.includes("SET state='ready'")) ready = true; if (ready && sql === 'COMMIT' && !lost) { lost = true; throw new Error('Embedding ready ACK lost'); } return result; });
    await expect(createAnalysisSnapshotPreparationService(wrapped, provider).prepare(owner.user.id, project.id, analysis.id, input)).rejects.toThrow(/ACK lost/);
    const saved = await preparations.getByRequest(owner.user.id, project.id, analysis.id, input.requestId), action = publishInput(saved); let published = false;
    const publicationDb = await wrappedDatabase(async (client, sql, values) => { const result = await client.query(sql, values); if (sql.startsWith('INSERT INTO research_analysis_snapshot_publications')) published = true; if (published && sql === 'COMMIT') { published = false; throw new Error('Embedding publication ACK lost'); } return result; });
    await expect(createAnalysisSnapshotPublicationService(publicationDb).publish(owner.user.id, project.id, analysis.id, action)).rejects.toThrow(/ACK lost/);
    await fs.unlink(provider.resolveKey(item.key)); await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    expect((await preparations.prepare(owner.user.id, project.id, analysis.id, input)).snapshotSha256).toBe(saved.snapshotSha256); expect((await publications.publish(owner.user.id, project.id, analysis.id, action)).replayed).toBe(true);
    await db.initSchema(); await db.initSchema(); expect((await db.query("SELECT schema_version FROM app_schema_contract WHERE schema_key='traceomics.runtime'")).rows[0].schema_version).toBe(20261032);
  });
});
