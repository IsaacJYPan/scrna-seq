import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import { beginWorkflowRun, commitWorkflowRun } from '../shared/workflowState.mjs';
import { canonicalRetainedWorkflowSnapshot } from '../shared/workflowSnapshot.mjs';
import { canonicalAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPackage } from '../shared/analysisSnapshotPreparationDispatch.mjs';
import { canonicalAnalysisSnapshotWorkflowContextBinding, projectAnalysisSnapshotWorkflowContext } from '../shared/analysisSnapshotWorkflowContext.mjs';
import { validateSnapshotPreparation, validateSnapshotPreparationOptions, decodeSnapshotPreparationTyped } from '../src/analyses/snapshotPreparationValidation.js';
import { validateSnapshotPublicationReceipt } from '../src/analyses/snapshotPublicationValidation.js';
const db = require('./pgDatabase'), storage = require('./storage');
const { createResearchAnalysisService } = require('./researchAnalyses');
const { createWorkflowRuntime } = require('./workflowRuntime');
const { createAnalysisSnapshotPreparationService } = require('./analysisSnapshotPreparations');
const { createAnalysisSnapshotPublicationService } = require('./analysisSnapshotPublications');
const { environmentFixture } = require('./_r-environment-test-utils');
const { environmentBytes } = require('./rEnvironment');
const { EXPERT_R_PROFILE } = require('./expertR');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const off = () => ({ method: false, parameterKeys: [], seed: false, environment: false });

describe.skipIf(!process.env.DATABASE_URL)('exact captured workflow findings and recorded context', () => {
  let directory, provider, preparations, publications, runtime, method, instance, sources, owner, colleague, project, analysis, serviceId, server, http, settings;
  beforeAll(async () => {
    settings = Object.fromEntries(['STORAGE_ROOT', 'VAULT_ROOT', 'APP_DEPLOYMENT_MODE'].map(key => [key, process.env[key]]));
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'traceomics-captured-findings-'));
    Object.assign(process.env, { STORAGE_ROOT: path.join(directory, 'storage'), VAULT_ROOT: path.join(directory, 'private'), APP_DEPLOYMENT_MODE: 'private' });
    await fs.mkdir(process.env.STORAGE_ROOT); provider = storage.createLocalStorageProvider(); http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    await db.resetSchemaForTests();
    owner = await http.createUserWithToken({ email: 'captured-owner@example.test' }); colleague = await http.createUserWithToken({ email: 'captured-colleague@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Captured finding lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Captured finding study' }); await db.addProjectMember(project.id, colleague.user.id, 'analyst');
    const object = await db.createProjectAnalysisObject(owner.user.id, project.id, { objectType: 'seurat', displayName: 'Private starting object' });
    const job = await db.createProjectJob(owner.user.id, project.id, { jobType: 'generic', analysisObjectId: object.id }); await db.query("UPDATE jobs SET status='completed' WHERE id=$1", [job.id]);
    const checkpoint = Buffer.from('opaque starting checkpoint'), checkpointId = db.genId('art'), key = storage.projectStorageFileKey(project.id, 'checkpoints', job.id, 'input.rds'); await fs.writeFile(provider.prepareWrite(key), checkpoint);
    await db.query("INSERT INTO job_artifacts(id,project_id,job_id,created_by_user_id,artifact_type,result_analysis_object_id,storage_kind,storage_uri,checksum_sha256,size_bytes,status) VALUES($1,$2,$3,$4,'checkpoint',$5,'local_internal',$6,$7,$8,'available')", [checkpointId, project.id, job.id, owner.user.id, object.id, key, hash(checkpoint), checkpoint.length]);
    method = { format: 'traceomics-workflow', schemaVersion: 1, id: 'captured-method', name: 'Recorded method', version: '1.0.0', description: 'Saved selected results', runtime: { language: 'r', profileId: EXPERT_R_PROFILE.id },
      files: { 'inspect.R': '# Private method source and private source paths must never be shared.\nwrite_output("summary", list(cells = 12))' },
      steps: [{ id: 'inspect', label: 'Inspect recorded results', entry: 'inspect.R', inputs: { analysis: { from: 'input.analysis', type: 'rds' } },
        parameters: [{ key: 'count', label: 'Applied count', type: 'integer', default: 42 }, { key: 'enabled', label: 'Enabled', type: 'boolean', default: true },
          { key: 'mode', label: 'Mode', type: 'choice', default: 'fast', options: ['fast', 'slow'] }, { key: 'private-text', label: 'Private text', type: 'text', default: '/private/input.csv' },
          { key: 'path-choice', label: 'Private path choice', type: 'choice', default: '/private/other', options: ['/private/other'] }, { key: 'missing', label: 'Legacy missing setting', type: 'number', default: 5 }],
        outputs: Object.fromEntries(['table', 'metrics', 'figure', 'rds', 'scatter'].map(type => [type, { type, label: 'Recorded ' + type, ...(type === 'rds' || type === 'scatter' ? {} : { semantics: { role: 'primary', title: 'Recorded ' + type } }) }])) }],
      tabs: [{ id: 'results', label: 'Results', step: 'inspect', plots: [] }] };
    runtime = createWorkflowRuntime(db, provider); instance = await runtime.open(owner.user.id, project.id, object.id, JSON.stringify(method)); sources = {};
    for (const type of ['table', 'metrics', 'figure', 'rds', 'scatter']) sources[type] = await source(type);
    analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: crypto.randomUUID(), name: 'Exact captured findings' })).analysis;
    serviceId = (await db.getServiceExecutionIdentity()).id; preparations = createAnalysisSnapshotPreparationService(db, provider); publications = createAnalysisSnapshotPublicationService();
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve)); await db.close();
    for (const [key, value] of Object.entries(settings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const scope = () => ({ serviceId, projectId: project.id, analysisId: analysis.id, userId: owner.user.id });
  const base = () => `/api/projects/${project.id}/analyses/${analysis.id}/snapshot-preparations`;
  const api = (suffix = '', options = {}, actor = owner) => http.api(server, base() + suffix, { token: actor.token, ...options });
  const operation = value => ({ requestId: value.requestId, requestSha256: value.requestSha256 });
  async function source(type) {
    const bytes = type === 'figure' ? PNG.sync.write(new PNG({ width: 16, height: 8 })) : type === 'rds' ? Buffer.from('opaque RDS; no deserialization')
      : Buffer.from(JSON.stringify(type === 'table' ? [{ cells: 0, called: false }, { cells: 12, called: true }] : type === 'metrics' ? { cells: 12 } : { x: [1], y: [2], ids: ['cell-1'] }));
    const id = db.genId('eri'), key = storage.projectStorageFileKey(project.id, 'artifacts', id, 'content.' + (type === 'figure' ? 'png' : type === 'rds' ? 'rds' : 'json')); await fs.writeFile(provider.prepareWrite(key), bytes);
    const job = await db.createProjectJob(owner.user.id, project.id, { jobType: 'generic' }); await db.query("UPDATE jobs SET status='completed' WHERE id=$1", [job.id]);
    const descriptor = { id, type, sha256: hash(bytes), sizeBytes: bytes.length, profileId: EXPERT_R_PROFILE.id, ...(method.steps[0].outputs[type].semantics ? { semantics: method.steps[0].outputs[type].semantics } : {}) };
    await db.query('INSERT INTO workflow_artifacts(id,owner_user_id,project_id,job_id,descriptor_json,storage_key) VALUES($1,$2,$3,$4,$5,$6)', [id, owner.user.id, project.id, job.id, descriptor, key]);
    return { descriptor, bytes, key, jobId: job.id, reference: { kind: 'artifact-version', versionId: id, sha256: hash(bytes) } };
  }
  async function environment(character = 'a') {
    const exact = environmentFixture(character), bytes = environmentBytes(exact.manifest), id = db.genId('art'), job = await db.createProjectJob(owner.user.id, project.id, { jobType: 'generic' });
    await db.query("UPDATE jobs SET status='completed' WHERE id=$1", [job.id]); const key = storage.projectStorageFileKey(project.id, 'artifacts', job.id, 'environment.json'); await fs.writeFile(provider.prepareWrite(key), bytes);
    await db.query("INSERT INTO job_artifacts(id,project_id,job_id,created_by_user_id,artifact_type,storage_kind,storage_uri,checksum_sha256,size_bytes,status,metadata_json) VALUES($1,$2,$3,$4,'expert_r_environment','local_internal',$5,$6,$7,'available',$8)", [id, project.id, job.id, owner.user.id, key, hash(bytes), bytes.length, JSON.stringify({ environment: exact.reference })]);
    return { ...exact, bytes, key, id, jobId: job.id, runtime: { profileId: EXPERT_R_PROFILE.id, environment: exact.reference, environmentArtifact: { id, checksumSha256: hash(bytes), sizeBytes: bytes.length } } };
  }
  async function capture({ parameters = {}, env = null, missing = false, legacyOutputChanges = {} } = {}) {
    const running = beginWorkflowRun(method, instance.state, { id: crypto.randomUUID(), stepId: 'inspect', parameters: { count: 0, enabled: false, mode: 'fast', ...parameters }, seed: 0 });
    const state = commitWorkflowRun(method, running, { id: running.active.id, generation: running.generation, outputs: Object.fromEntries(Object.entries(sources).map(([type, item]) => [type, item.descriptor])), producerKey: hash(crypto.randomUUID()), ...(env ? { runtime: env.runtime } : {}) });
    if (missing) delete state.results.inspect.parameters.missing; // Explicit legacy partial recorded state; never substitute defaults.
    for (const [port, changes] of Object.entries(legacyOutputChanges)) state.results.inspect.outputs[port] = { ...state.results.inspect.outputs[port], ...changes }; // Explicit newly saved legacy malformed fixture, no immutable source mutation.
    await db.query('UPDATE workflow_instances SET state_json=$2 WHERE id=$1', [instance.id, state]); instance = { ...instance, state };
    const saved = await runtime.save(owner.user.id, project.id, instance.id, 'Recorded selected outputs');
    const row = (await db.query('SELECT * FROM workflow_snapshots WHERE id=$1', [saved.id])).rows[0];
    return { kind: 'workflow-snapshot', snapshotId: saved.id, sha256: hash(canonicalRetainedWorkflowSnapshot({ projectId: project.id, ownerUserId: owner.user.id, analysisObjectId: row.analysis_object_id, packageDigest: row.package_digest, package: row.package_json, state: row.state_json })) };
  }
  async function pin(references) { analysis = (await createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: analysis.version, references })).analysis; return analysis.version; }
  async function choices(reference, version = analysis.version, target = preparations, extra = {}) { return target.options(owner.user.id, project.id, analysis.id, { kind: 'captured-workflow-outputs', analysisVersion: version, snapshotId: reference.snapshotId, snapshotSha256: reference.sha256, ...extra }); }
  function selection(reference, item, contextSelection = off(), version = analysis.version) {
    const context = projectAnalysisSnapshotWorkflowContext({ snapshotReference: reference, stepId: item.stepId, port: item.port, offer: item.contextOffer, selection: contextSelection });
    const contextSha256 = hash(canonicalAnalysisSnapshotWorkflowContextBinding({ serviceId, projectId: project.id, analysisId: analysis.id, ownerUserId: owner.user.id, analysisVersion: version, context }));
    return { kind: 'captured-workflow-output', snapshotReference: reference, stepId: item.stepId, port: item.port, reference: item.reference, descriptorSha256: item.descriptorSha256,
      caption: 'Supplied captured finding', view: item.viewFamily === 'table' ? { family: 'table', offset: 0, limit: 1 } : { family: item.viewFamily }, contextSelection, contextSha256 };
  }
  const recipe = (results, change = {}) => ({ schema: 'traceomics.analysis-snapshot-preparation.v2', requestId: crypto.randomUUID(), serviceId, projectId: project.id, analysisId: analysis.id, ownerUserId: owner.user.id,
    analysisVersion: analysis.version, results, documents: [], notes: { summary: null, decisions: null, limitations: null }, prerequisites: [], ...change });
  const prerequisite = (snapshotReference, item) => ({ kind: 'captured-workflow-reference', snapshotReference, stepId: item.stepId, port: item.port, reference: item.reference, label: 'Original prerequisite', detail: null });
  async function wrappedDatabase(intercept) {
    const pool = await db.connect(); return { ...db, connect: async () => ({ connect: async () => { const client = await pool.connect(); return { query: (sql, values) => intercept(client, sql, values), release: destroy => client.release(destroy) }; } }) };
  }

  it.each(['table', 'metrics', 'figure'])('shares actual captured %s with reviewed context and original-source loss without exposing private method or environment', async type => {
    const env = await environment(), ref = await capture({ env, missing: true }); await pin([ref]); const page = await choices(ref);
    expect(await validateSnapshotPreparationOptions(page, scope(), 'captured-workflow-outputs', analysis.version, ref)).toEqual(page);
    const item = page.items.find(value => value.port === type); expect(item.contextOffer.parameters.map(value => value.key)).toEqual(['count', 'enabled', 'mode']);
    const input = recipe([selection(ref, item, { method: true, parameterKeys: ['enabled', 'count', 'mode'], seed: true, environment: true })]);
    const reply = await api('', { method: 'POST', body: input }); expect(reply.status).toBe(201); const saved = reply.data;
    expect(saved.state).toBe('ready'); expect(saved.requestSha256).toBe(hash(canonicalAnalysisSnapshotPreparation(input))); expect(saved.snapshotSha256).toBe(hash(canonicalAnalysisSnapshotPackage(saved.package)));
    expect(await validateSnapshotPreparation(saved, scope(), input)).toEqual(saved);
    const result = saved.package.results[0]; expect(result.origin.context.parameters.map(value => value.value)).toEqual([false, 0, 'fast']); expect(result.origin.context.seed).toBe(0);
    expect(result.origin.contextEvidence).toEqual({ capture: 'fingerprint-checked', environment: 'manifest-checked' });
    expect(JSON.stringify(saved.package)).not.toMatch(/private-text|path-choice|private\/|write_output|files|internalStorage|environmentArtifact|systemPackages/);
    const action = { requestId: crypto.randomUUID(), serviceId, projectId: project.id, analysisId: analysis.id, ownerUserId: owner.user.id, preparationId: saved.preparationId, snapshotSha256: saved.snapshotSha256 };
    const publication = await publications.publish(owner.user.id, project.id, analysis.id, action), receipt = { ...publication }; delete receipt.created;
    expect(await validateSnapshotPublicationReceipt(receipt, scope(), { action: 'publish', ...action })).toEqual(receipt);
    await fs.unlink(provider.resolveKey(sources[type].key)); await fs.unlink(provider.resolveKey(env.key)); await runtime.close(owner.user.id, project.id, instance.id);
    const original = await publications.get(colleague.user.id, project.id, analysis.id, publication.acceptance.publicationId); expect(original.package).toEqual(saved.package);
    const raw = await publications.readBlob(colleague.user.id, project.id, analysis.id, publication.acceptance.publicationId, result.viewId, 'result');
    if (type === 'figure') expect(raw.bytes).toEqual(sources.figure.bytes); else expect((await decodeSnapshotPreparationTyped(raw.bytes, result)).family).toBe(type);
    expect((await api(`/${saved.preparationId}`, {}, colleague)).status).toBe(404);
    await preparations.remove(owner.user.id, project.id, analysis.id, saved.preparationId, operation(saved)); expect((await publications.readBlob(colleague.user.id, project.id, analysis.id, publication.acceptance.publicationId, result.viewId, 'result')).bytes).toEqual(raw.bytes);
  });

  it('records later equal-output reuse settings and environment without assigning its older output job as producing evidence', async () => {
    const firstEnv = await environment('a'), first = await capture({ parameters: { count: 3 }, env: firstEnv }); await pin([first]);
    const originalId = instance.state.results.inspect.outputs.metrics.id, secondEnv = await environment('b'), second = await capture({ parameters: { count: 9 }, env: secondEnv });
    expect(instance.state.results.inspect.outputs.metrics.id).toBe(originalId); expect(secondEnv.jobId).not.toBe(sources.metrics.jobId); await pin([first, second]);
    const item = (await choices(second)).items.find(value => value.port === 'metrics'), input = recipe([selection(second, item, { ...off(), parameterKeys: ['count'], environment: true })]);
    const saved = await preparations.prepare(owner.user.id, project.id, analysis.id, input); expect(saved.state).toBe('ready');
    expect(saved.package.results[0].origin.context).toMatchObject({ relation: 'recorded-in-capture', parameters: [{ key: 'count', value: 9 }], environment: { id: secondEnv.reference.id } });
    expect(saved.package.reproduction.producingSource).toBe('not-established');
  });

  it('keeps one intact output usable after unrelated root/output loss and records exact opaque/unsupported/missing/foreign output prerequisites', async () => {
    const ref = await capture(); await pin([ref]);
    await db.query("DELETE FROM job_artifacts WHERE artifact_type='checkpoint' AND project_id=$1", [project.id]);
    await db.query('DELETE FROM workflow_artifacts WHERE id=$1', [sources.figure.reference.versionId]);
    await db.query('UPDATE workflow_artifacts SET owner_user_id=$2 WHERE id=$1', [sources.table.reference.versionId, colleague.user.id]);
    let opens = 0; const target = createAnalysisSnapshotPreparationService(db, { ...provider, openVerifiedRead: (...args) => { opens++; return provider.openVerifiedRead(...args); } });
    const page = await choices(ref, analysis.version, target);
    expect(page.items.find(value => value.port === 'rds')).toMatchObject({ referenceOnlyReason: 'opaque', descriptor: null, contextOffer: null });
    expect(page.items.find(value => value.port === 'scatter')).toMatchObject({ viewFamily: 'embedding', referenceOnlyReason: null });
    for (const port of ['table', 'figure']) expect(page.items.find(value => value.port === port)).toMatchObject({ viewFamily: null, descriptor: null, referenceOnlyReason: 'restricted-or-unavailable' });
    expect(opens).toBe(0); const item = page.items.find(value => value.port === 'metrics');
    const input = recipe([selection(ref, item)], { prerequisites: page.items.filter(value => value.port !== 'metrics').map(value => prerequisite(ref, value)) });
    const saved = await target.prepare(owner.user.id, project.id, analysis.id, input); expect(saved.state).toBe('ready'); expect(opens).toBe(1);
    expect(saved.package.prerequisites.items.every(value => value.role === 'reference-only' && value.integrity === 'not-checked' && value.dataAccess === 'not-granted' && !value.context)).toBe(true);
  });

  it('binds old analysis N, capture/step/port/descriptor and selected context; rejects default substitution and whole-capture identity guessing', async () => {
    const ref = await capture({ missing: true }); await pin([ref]); const version = analysis.version, item = (await choices(ref)).items.find(value => value.port === 'metrics'), selected = selection(ref, item, off(), version); await pin([]);
    expect((await preparations.prepare(owner.user.id, project.id, analysis.id, recipe([selected], { analysisVersion: version }))).state).toBe('ready');
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, recipe([selected]))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE' });
    for (const changed of [{ ...selected, stepId: 'absent' }, { ...selected, port: 'table' }, { ...selected, contextSha256: 'a'.repeat(64) }, { ...selected, descriptorSha256: 'b'.repeat(64) }, { ...selected, contextSelection: { ...off(), parameterKeys: ['missing'] } }]) {
      await expect(preparations.prepare(owner.user.id, project.id, analysis.id, recipe([changed], { analysisVersion: version }))).rejects.toMatchObject({ status: 409 });
    }
    expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_preparations')).rows[0].n).toBe('1');
    expect((await api(`/options?kind=captured-workflow-outputs&analysisVersion=${version}&snapshotId=${ref.snapshotId}&snapshotSha256=${ref.sha256}`, {}, colleague)).status).toBe(409);
  });

  it('preserves valid exact legacy output identities as unsupported prerequisites when captured type, size or declared meaning is malformed', async () => {
    const ref = await capture({ legacyOutputChanges: { metrics: { type: 'table', sizeBytes: -1 }, figure: { semantics: { role: 'primary', title: 'A mismatched captured title' } } } }); await pin([ref]);
    const page = await choices(ref);
    for (const port of ['metrics', 'figure']) expect(page.items.find(value => value.port === port)).toMatchObject({ reference: sources[port].reference, referenceOnlyReason: 'unsupported-view', descriptor: null, contextOffer: null });
    const input = recipe([selection(ref, page.items.find(value => value.port === 'table'))], { prerequisites: page.items.filter(value => ['metrics', 'figure'].includes(value.port)).map(value => prerequisite(ref, value)) });
    const saved = await preparations.prepare(owner.user.id, project.id, analysis.id, input); expect(saved.state).toBe('ready');
    expect(saved.package.prerequisites.items.map(value => value.reason)).toEqual(['unsupported-view', 'unsupported-view']);
    expect(saved.package.prerequisites.items.every(value => !value.context && value.integrity === 'not-checked')).toBe(true);
  });

  it('does not coerce legacy singleton-array output ids or checksums into saved reference identities', async () => {
    const ref = await capture({ legacyOutputChanges: { metrics: { id: [sources.metrics.descriptor.id] }, figure: { sha256: [sources.figure.descriptor.sha256] } } }); await pin([ref]);
    const page = await choices(ref); expect(page.items.some(value => ['metrics', 'figure'].includes(value.port))).toBe(false);
    expect(await validateSnapshotPreparationOptions(page, scope(), 'captured-workflow-outputs', analysis.version, ref)).toEqual(page);
    const table = page.items.find(value => value.port === 'table'), input = recipe([selection(ref, table)]);
    expect((await preparations.prepare(owner.user.id, project.id, analysis.id, input)).state).toBe('ready');
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, recipe([selection(ref, table)], { prerequisites: [{ kind: 'captured-workflow-reference', snapshotReference: ref,
      stepId: 'inspect', port: 'metrics', reference: sources.metrics.reference, label: 'Cannot adopt a coerced recorded identity', detail: null }] }))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE' });
  });

  it('uses exact metadata-only paged capture options without treating a current source failure as global scope loss', async () => {
    const ref = await capture(); await pin([ref]); const denied = { ...provider, openVerifiedRead: () => { throw new Error('No file work for options.'); } }, target = createAnalysisSnapshotPreparationService(db, denied);
    const all = await choices(ref, analysis.version, target), page = await choices(ref, analysis.version, target, { limit: 2 }), next = await choices(ref, analysis.version, target, { limit: 2, cursor: page.nextCursor });
    // Port order is the actual persisted package's JSONB object order, not an
    // insertion order reconstructed from this fixture's pre-save JavaScript.
    expect(page.items.map(value => value.port)).toEqual(all.items.slice(0, 2).map(value => value.port)); expect(next.items.map(value => value.port)).toEqual(all.items.slice(2, 4).map(value => value.port));
    const other = await capture(); await pin([ref, other]);
    await expect(choices(other, analysis.version, target, { cursor: page.nextCursor })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_INVALID_PAGE' });
    expect((await api('/options?kind=captured-workflow-outputs&analysisVersion[]=2')).status).toBe(400);
    expect((await api(`/options?kind=captured-workflow-outputs&analysisVersion=${analysis.version}&snapshotId[]=${ref.snapshotId}&snapshotSha256=${ref.sha256}`)).status).toBe(400);
  });

  it('requires selected exact environment ownership, bytes and relationship but permits deliberate omission after environment loss', async () => {
    const env = await environment(), ref = await capture({ env }); await pin([ref]); const item = (await choices(ref)).items.find(value => value.port === 'metrics');
    const input = recipe([selection(ref, item, { ...off(), environment: true })]); await fs.writeFile(provider.resolveKey(env.key), Buffer.alloc(env.bytes.length, 32));
    const failed = await preparations.prepare(owner.user.id, project.id, analysis.id, input); expect(failed.state).toBe('failed'); expect(failed.package).toBeNull();
    expect((await preparations.prepare(owner.user.id, project.id, analysis.id, recipe([selection(ref, item)]))).state).toBe('ready');
    await fs.writeFile(provider.resolveKey(env.key), env.bytes); await db.query('UPDATE job_artifacts SET created_by_user_id=$2 WHERE id=$1', [env.id, colleague.user.id]);
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, recipe([selection(ref, item, { ...off(), environment: true })]))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE' });
  });

  it.each(['json', 'package-url', 'runtime-primitive'])('records malformed legacy environment %s as a recoverable source failure even when its original byte checksum matches', async kind => {
    const env = await environment();
    const invalidManifest = structuredClone(env.manifest);
    if (kind === 'runtime-primitive') invalidManifest.runtime.imageDigest = { toString: 'not callable' };
    else invalidManifest.packages[0].source.url = 'not a valid absolute URL';
    const malformed = kind === 'json' ? Buffer.from('{"schema":') : environmentBytes(invalidManifest);
    // Explicit legacy corrupt manifest fixture: all recorded byte identities
    // match these actual malformed bytes, so pure manifest interpretation is the failing gate.
    const checksum = hash(malformed), recorded = { ...env.reference, id: 'renv_' + checksum, manifestSha256: checksum };
    await fs.writeFile(provider.resolveKey(env.key), malformed);
    await db.query('UPDATE job_artifacts SET checksum_sha256=$2,size_bytes=$3,metadata_json=$4 WHERE id=$1', [env.id, checksum, malformed.length, JSON.stringify({ environment: recorded })]);
    const legacy = { ...env, runtime: { ...env.runtime, environment: recorded, environmentArtifact: { id: env.id, checksumSha256: checksum, sizeBytes: malformed.length } } };
    const ref = await capture({ env: legacy }); await pin([ref]); const item = (await choices(ref)).items.find(value => value.port === 'metrics');
    const input = recipe([selection(ref, item, { ...off(), environment: true })]);
    const saved = await preparations.prepare(owner.user.id, project.id, analysis.id, input);
    expect(saved.state).toBe('failed'); expect(saved.canResume).toBe(true); expect(saved.failure.code).toBe('ANALYSIS_SNAPSHOT_SOURCE_CONTEXT_CHANGED');
    expect((await preparations.getByRequest(owner.user.id, project.id, analysis.id, input.requestId)).requestSha256).toBe(saved.requestSha256);
    expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
    expect((await preparations.prepare(owner.user.id, project.id, analysis.id, recipe([selection(ref, item)]))).state).toBe('ready');
  });

  it('fences actual selected descriptor mutation during held byte verification and preserves current immutable capture triggers', async () => {
    const ref = await capture(); await pin([ref]); const item = (await choices(ref)).items.find(value => value.port === 'metrics'), input = recipe([selection(ref, item)]), reached = gate(), release = gate(); let held = false;
    const blocked = { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args); if (!held) { held = true; reached.release(); await release.promise; } return opened; } };
    const pending = createAnalysisSnapshotPreparationService(db, blocked).prepare(owner.user.id, project.id, analysis.id, input); await reached.promise;
    try { await db.query("UPDATE workflow_artifacts SET descriptor_json=jsonb_set(descriptor_json,'{semantics,title}','\"Changed after capture\"') WHERE id=$1", [sources.metrics.reference.versionId]); }
    finally { release.release(); }
    expect((await pending).state).toBe('failed');
    await expect(db.query("UPDATE workflow_snapshots SET name='Changed' WHERE id=$1", [ref.snapshotId])).rejects.toMatchObject({ code: '55000' });
    await expect(db.query('DELETE FROM workflow_snapshots WHERE id=$1', [ref.snapshotId])).rejects.toMatchObject({ code: '55000' });
    expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
  });

  it('rejects scoped legacy capture loss after verified output reads without altering immutable captured source', async () => {
    const ref = await capture(); await pin([ref]); const input = recipe([selection(ref, (await choices(ref)).items.find(value => value.port === 'metrics'))]); let read = false;
    const tracked = { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args), close = opened.handle.close.bind(opened.handle);
      opened.handle.close = async () => { await close(); read = true; }; return opened; } };
    const faulty = await wrappedDatabase(async (client, sql, values) => { const result = await client.query(sql, values);
      // Scoped legacy/missing-row adapter fault. Supported DELETE/UPDATE remain
      // guarded and no durable scientific record is modified by this injection.
      return read && sql.includes('FROM workflow_snapshots WHERE owner_user_id') ? { ...result, rows: [], rowCount: 0 } : result; });
    const saved = await createAnalysisSnapshotPreparationService(faulty, tracked).prepare(owner.user.id, project.id, analysis.id, input);
    expect(saved.state).toBe('failed'); expect(saved.failure.code).toBe('ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE');
    expect((await db.query('SELECT COUNT(*) AS n FROM workflow_snapshots WHERE id=$1', [ref.snapshotId])).rows[0].n).toBe('1');
    expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
  });

  it('holds exact selected environment metadata through the ready COMMIT and rejects a changed environment owner under existing expert policy', async () => {
    const env = await environment(), ref = await capture({ env }); await pin([ref]); const item = (await choices(ref)).items.find(value => value.port === 'metrics'), input = recipe([selection(ref, item, { ...off(), environment: true })]);
    let outputRead = false, checked = false;
    const tracking = { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args), close = opened.handle.close.bind(opened.handle);
      opened.handle.close = async () => { await close(); if (args[0] === sources.metrics.key) outputRead = true; }; return opened; } };
    const guarded = await wrappedDatabase(async (client, sql, values) => { const result = await client.query(sql, values);
      if (outputRead && !checked && sql.includes('SELECT artifact.* FROM job_artifacts') && sql.includes('FOR SHARE OF artifact')) {
        checked = true; const competing = await (await db.connect()).connect();
        try { await competing.query('BEGIN'); await competing.query("SET LOCAL lock_timeout='100ms'"); await expect(competing.query("UPDATE job_artifacts SET storage_uri=storage_uri||'.changed' WHERE id=$1", [env.id])).rejects.toMatchObject({ code: '55P03' }); }
        finally { await competing.query('ROLLBACK'); competing.release(); }
      } return result; });
    expect((await createAnalysisSnapshotPreparationService(guarded, tracking).prepare(owner.user.id, project.id, analysis.id, input)).state).toBe('ready'); expect(checked).toBe(true);
    await db.query("UPDATE jobs SET job_type='expert.r.v1',owner_user_id=$2 WHERE id=$1", [env.jobId, colleague.user.id]);
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, recipe([selection(ref, item, { ...off(), environment: true })]))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE' });
  });

  it('atomically fences a held captured builder after deletion and permits no environment or result resurrection', async () => {
    const env = await environment(), ref = await capture({ env }); await pin([ref]); const input = recipe([selection(ref, (await choices(ref)).items.find(value => value.port === 'metrics'), { ...off(), environment: true })]);
    const reached = gate(), release = gate(); let held = false;
    const blocked = { ...provider, openVerifiedRead: async (...args) => { if (!held) { held = true; reached.release(); await release.promise; } return provider.openVerifiedRead(...args); } };
    const pending = createAnalysisSnapshotPreparationService(db, blocked).prepare(owner.user.id, project.id, analysis.id, input); await reached.promise;
    const original = await preparations.getByRequest(owner.user.id, project.id, analysis.id, input.requestId);
    await preparations.remove(owner.user.id, project.id, analysis.id, original.preparationId, operation(original)); release.release(); expect((await pending).state).toBe('deleted');
    expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
    expect((await db.query('SELECT reserved_bytes FROM research_analysis_snapshot_preparations WHERE id=$1', [original.preparationId])).rows[0].reserved_bytes).toBe('0');
  });

  it('recovers original committed ready acknowledgement loss before current writer/capture/source checks and keeps schema32', async () => {
    const ref = await capture(); await pin([ref]); const input = recipe([selection(ref, (await choices(ref)).items.find(value => value.port === 'metrics'))]), pool = await db.connect(); let ready = false, lost = false;
    const wrapped = { ...db, connect: async () => ({ connect: async () => { const client = await pool.connect(); return { query: async (sql, values) => { const result = await client.query(sql, values); if (sql.includes("SET state='ready'")) ready = true;
      if (sql === 'COMMIT' && ready && !lost) { lost = true; throw new Error('Actual captured ready ACK lost'); } return result; }, release: destroy => client.release(destroy) }; } }) };
    await expect(createAnalysisSnapshotPreparationService(wrapped, provider).prepare(owner.user.id, project.id, analysis.id, input)).rejects.toThrow(/ACK lost/);
    const saved = await preparations.getByRequest(owner.user.id, project.id, analysis.id, input.requestId); expect(saved.state).toBe('ready');
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]); await fs.unlink(provider.resolveKey(sources.metrics.key));
    expect(await preparations.prepare(owner.user.id, project.id, analysis.id, input)).toMatchObject({ preparationId: saved.preparationId, snapshotSha256: saved.snapshotSha256, canPrepare: false });
    await db.initSchema(); await db.initSchema(); expect((await db.query("SELECT schema_version FROM app_schema_contract WHERE schema_key='traceomics.runtime'")).rows[0].schema_version).toBe(20261032);
  });
});
