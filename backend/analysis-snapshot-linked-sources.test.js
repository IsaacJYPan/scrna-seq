import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import { canonicalAnalysisSnapshotPackage, canonicalAnalysisSnapshotPreparation } from '../shared/analysisSnapshotPreparationDispatch.mjs';
import { validateSnapshotPreparation, validateSnapshotPreparationList, validateSnapshotPreparationOptions, decodeSnapshotPreparationTable } from '../src/analyses/snapshotPreparationValidation.js';
import { validateSnapshotPublicationReceipt } from '../src/analyses/snapshotPublicationValidation.js';
const db = require('./pgDatabase'), storage = require('./storage');
const { createResearchAnalysisService } = require('./researchAnalyses');
const { createArtifactVersionService } = require('./artifactVersions');
const { createAnalysisAttachmentService } = require('./analysisAttachments');
const { createAnalysisSnapshotPreparationService } = require('./analysisSnapshotPreparations');
const { createAnalysisSnapshotPublicationService } = require('./analysisSnapshotPublications');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDm9bllj1W4jjkdEVtqqrEAADgAUUUV9HhP93h6L8j8wzH/AHyr/il+bP/Z', 'base64');
const csv = Buffer.from('gene,score\nA,12\nB,19\nC,23\n');

describe.skipIf(!process.env.DATABASE_URL)('exact linked flat result preparation and publication', () => {
  let directory, provider, preparations, publications, owner, colleague, project, analysis, identity, settings, http, server;
  beforeAll(async () => {
    settings = Object.fromEntries(['STORAGE_ROOT', 'VAULT_ROOT', 'APP_DEPLOYMENT_MODE'].map(key => [key, process.env[key]]));
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'traceomics-linked-results-'));
    Object.assign(process.env, { STORAGE_ROOT: path.join(directory, 'storage'), VAULT_ROOT: path.join(directory, 'private'), APP_DEPLOYMENT_MODE: 'private' });
    await fs.mkdir(process.env.STORAGE_ROOT); provider = storage.createLocalStorageProvider(); http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    await db.resetSchemaForTests();
    owner = await http.createUserWithToken({ email: 'linked-owner@example.test' }); colleague = await http.createUserWithToken({ email: 'linked-colleague@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Linked result lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Linked result study' }); await db.addProjectMember(project.id, colleague.user.id, 'analyst');
    analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: crypto.randomUUID(), name: 'Selected result versions' })).analysis;
    identity = (await db.getServiceExecutionIdentity()).id; preparations = createAnalysisSnapshotPreparationService(db, provider); publications = createAnalysisSnapshotPublicationService();
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve)); await db.close();
    for (const [key, value] of Object.entries(settings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = () => `/api/projects/${project.id}/analyses/${analysis.id}/snapshot-preparations`;
  const api = (suffix = '', options = {}, actor = owner) => http.api(server, base() + suffix, { token: actor.token, ...options });
  async function source(family = 'av', extension = 'csv', actor = owner) {
    const bytes = extension === 'jpeg' ? jpeg : extension === 'png' ? PNG.sync.write(new PNG({ width: 32, height: 16 })) : extension === 'tsv' ? Buffer.from('gene\tscore\nA\t12\nB\t19\n') : extension === 'rds' ? Buffer.from('opaque RDS; never deserialize') : csv;
    const filename = 'result.' + extension;
    if (family === 'av') {
      const file = path.join(directory, crypto.randomUUID() + filename); await fs.writeFile(file, bytes);
      const version = await createArtifactVersionService(db, provider).importFile(actor.user.id, project.id, { path: file, originalFilename: filename, name: filename });
      return { reference: { kind: 'artifact-version', versionId: version.versionId, sha256: version.sha256 }, bytes, version };
    }
    const versionId = db.genId(family), key = storage.projectStorageFileKey(project.id, 'artifacts', versionId, filename); await fs.writeFile(provider.prepareWrite(key), bytes);
    if (family === 'eri') await db.query(`INSERT INTO expert_r_private_inputs(id,project_id,owner_user_id,original_filename,internal_storage_key,mime_type,file_size_bytes,sha256)
      VALUES($1,$2,$3,$4,$5,'text/csv',$6,$7)`, [versionId, project.id, actor.user.id, 'C:\\private\\' + filename, key, bytes.length, hash(bytes)]);
    else {
      const job = await db.createProjectJob(actor.user.id, project.id, { jobType: 'generic' });
      await db.updateJobStatusForUser(actor.user.id, job.id, 'running'); await db.updateJobStatusForUser(actor.user.id, job.id, 'completed');
      await db.query(`INSERT INTO job_artifacts(id,project_id,job_id,created_by_user_id,artifact_type,storage_kind,storage_uri,checksum_sha256,size_bytes,status)
        VALUES($1,$2,$3,$4,'deg_markers','local_internal',$5,$6,$7,'available')`, [versionId, project.id, job.id, actor.user.id, key, hash(bytes), bytes.length]);
    }
    return { reference: { kind: 'artifact-version', versionId, sha256: hash(bytes) }, bytes, key };
  }
  async function pin(references, actor = owner) {
    analysis = (await createResearchAnalysisService().patch(actor.user.id, project.id, analysis.id, { expectedVersion: analysis.version, references })).analysis;
    return analysis.version;
  }
  const recipe = (reference, change = {}) => ({ schema: 'traceomics.analysis-snapshot-preparation.v2', requestId: crypto.randomUUID(), serviceId: identity, projectId: project.id,
    analysisId: analysis.id, ownerUserId: owner.user.id, analysisVersion: analysis.version, results: [{ kind: 'analysis-reference', reference, caption: 'Deliberately selected finding', view: { family: 'table', offset: 0, limit: 2 } }],
    documents: [], notes: { summary: 'Exact selected references', decisions: null, limitations: null }, prerequisites: [], ...change });

  it.each([['av', 'csv'], ['av', 'tsv'], ['av', 'png'], ['av', 'jpeg'], ['eri', 'csv'], ['eri', 'png'], ['eri', 'jpeg'], ['art', 'csv']])('retains actual owned %s/%s linked bytes through the owning resolver and publishes without expanding source permissions', async (family, extension) => {
    const selected = await source(family, extension); await pin([selected.reference]);
    const input = recipe(selected.reference, { results: [{ kind: 'analysis-reference', reference: selected.reference, caption: 'Supplied caption', view: ['png', 'jpeg'].includes(extension) ? { family: 'image' } : { family: 'table', offset: 0, limit: 2 } }] });
    const response = await api('', { method: 'POST', body: input }); expect(response.status).toBe(201); const saved = response.data;
    expect(saved).toMatchObject({ state: 'ready', requestSha256: hash(canonicalAnalysisSnapshotPreparation(input)), recipe: input, package: { schema: 'traceomics.analysis-snapshot-package.v2' } });
    expect(saved.snapshotSha256).toBe(hash(canonicalAnalysisSnapshotPackage(saved.package)));
    const scope = { serviceId: identity, projectId: project.id, analysisId: analysis.id, userId: owner.user.id };
    expect(await validateSnapshotPreparation(saved, scope, input)).toEqual(saved);
    const result = saved.package.results[0]; expect(result.origin).toMatchObject({ kind: 'analysis-reference', reference: selected.reference, captionOrigin: 'user-supplied', analysisVersion: analysis.version });
    expect(result.source.ownerUserId).toBe(owner.user.id); expect(result.source.name).not.toMatch(/[\\/]/); expect(JSON.stringify(saved)).not.toContain('C:\\private');
    const retained = await preparations.readBlob(owner.user.id, project.id, analysis.id, saved.preparationId, result.viewId, 'result'); expect(hash(retained.bytes)).toBe(result.view.blobSha256);
    if (['png', 'jpeg'].includes(extension)) expect(retained.bytes).toEqual(selected.bytes); else expect((await decodeSnapshotPreparationTable(retained.bytes, result)).rows[0]).toEqual(['A', '12']);
    const action = { requestId: crypto.randomUUID(), serviceId: identity, projectId: project.id, analysisId: analysis.id, ownerUserId: owner.user.id, preparationId: saved.preparationId, snapshotSha256: saved.snapshotSha256 };
    const published = await publications.publish(owner.user.id, project.id, analysis.id, action);
    const receipt = { ...published }; delete receipt.created;
    expect(await validateSnapshotPublicationReceipt(receipt, scope, { action: 'publish', ...action })).toEqual(receipt);
    expect((await publications.get(colleague.user.id, project.id, analysis.id, published.acceptance.publicationId)).package).toEqual(saved.package);
    expect(hash((await publications.readBlob(colleague.user.id, project.id, analysis.id, published.acceptance.publicationId, result.viewId, 'result')).bytes)).toBe(result.view.blobSha256);
    await expect(createArtifactVersionService(db, provider).get(colleague.user.id, project.id, selected.reference.versionId)).rejects.toThrow();
  });

  it('requires membership in the selected historical saved version and does not follow a later analysis head', async () => {
    const old = await source(), newer = await source(); await pin([old.reference]); const selectedVersion = analysis.version; await pin([newer.reference]);
    const saved = await preparations.prepare(owner.user.id, project.id, analysis.id, recipe(old.reference, { analysisVersion: selectedVersion })); expect(saved.state).toBe('ready');
    expect(saved.package.analysis.version).toBe(selectedVersion);
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, recipe(old.reference))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE' });
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, recipe(newer.reference, { analysisVersion: selectedVersion }))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE' });
  });

  it('keeps expert-job visibility authoritative for caller-client metadata, including mismatched legacy artifact creators', async () => {
    const selected = await source('art', 'csv'); await pin([selected.reference]);
    const jobId = (await db.query('SELECT job_id FROM job_artifacts WHERE id=$1', [selected.reference.versionId])).rows[0].job_id;
    // Exercise legitimate historical/anomalous metadata without claiming that
    // this generic fixture executed R: artifact creator and job owner can differ.
    await db.query("UPDATE jobs SET job_type='expert.r.v1',owner_user_id=$2 WHERE id=$1", [jobId, colleague.user.id]);
    const client = await (await db.connect()).connect();
    try {
      await client.query('BEGIN');
      expect(await db.getProjectArtifactInternal(owner.user.id, project.id, selected.reference.versionId)).toBeNull();
      expect(await db.getProjectArtifactInternal(owner.user.id, project.id, selected.reference.versionId, { client })).toBeNull();
      await expect(createArtifactVersionService(db, provider).snapshotSourceMetadata(client, owner.user.id, project.id, selected.reference)).rejects.toMatchObject({ code: 'ARTIFACT_VERSION_NOT_FOUND' });
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    let opens = 0;
    const counted = { ...provider, openVerifiedRead: (...args) => { opens++; return provider.openVerifiedRead(...args); } };
    const target = createAnalysisSnapshotPreparationService(db, counted);
    const restricted = await target.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-references', analysisVersion: analysis.version });
    expect(restricted.items[0]).toEqual({ reference: selected.reference, label: 'Saved reference', viewFamily: null, referenceOnlyReason: 'restricted-or-unavailable', integrity: 'not-checked', availability: 'not-checked' });
    await expect(target.prepare(owner.user.id, project.id, analysis.id, recipe(selected.reference))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE' });
    expect(opens).toBe(0); expect((await target.list(owner.user.id, project.id, analysis.id)).items).toHaveLength(0);

    await db.query('UPDATE jobs SET owner_user_id=$2 WHERE id=$1', [jobId, owner.user.id]);
    expect(await db.getProjectArtifactInternal(owner.user.id, project.id, selected.reference.versionId)).toMatchObject({ id: selected.reference.versionId });
    expect((await target.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-references', analysisVersion: analysis.version })).items[0]).toMatchObject({ viewFamily: 'table', referenceOnlyReason: null });
    expect((await target.prepare(owner.user.id, project.id, analysis.id, recipe(selected.reference))).state).toBe('ready');

    const result = await db.createProjectAnalysisObject(colleague.user.id, project.id, { objectType: 'seurat', displayName: 'Existing explicitly shared expert result' });
    await db.query('UPDATE jobs SET owner_user_id=$2,result_analysis_object_id=$3 WHERE id=$1', [jobId, colleague.user.id, result.id]);
    expect(await db.getProjectArtifactInternal(owner.user.id, project.id, selected.reference.versionId)).toBeNull();
    const branches = require('./analysisBranches');
    const branch = await branches.createBranch(colleague.user.id, project.id, { name: 'Existing expert result visibility', baseAnalysisObjectId: result.id });
    await branches.publishBranch(colleague.user.id, project.id, branch.id);
    expect(await db.getProjectArtifactInternal(owner.user.id, project.id, selected.reference.versionId)).toMatchObject({ id: selected.reference.versionId });
    expect((await target.prepare(owner.user.id, project.id, analysis.id, recipe(selected.reference))).state).toBe('ready');
    // Existing project visibility is still insufficient to republish bytes
    // owned by somebody else, even when that member is the expert job owner.
    expect((await target.options(colleague.user.id, project.id, analysis.id, { kind: 'analysis-references', analysisVersion: analysis.version })).items[0]).toMatchObject({ label: 'Saved reference', viewFamily: null, referenceOnlyReason: 'restricted-or-unavailable' });
  });

  it('mixes exact historical attachment and linked results while keeping original v1 recipe/package hashes', async () => {
    const outside = await source(), linked = await source(); await pin([linked.reference]);
    const attachment = (await createAnalysisAttachmentService(db, provider).create(owner.user.id, project.id, analysis.id, { requestId: crypto.randomUUID(), reference: outside.reference, caption: 'Original attached caption', suppliedOrigin: {} })).acceptedRevision;
    const legacy = { requestId: crypto.randomUUID(), serviceId: identity, projectId: project.id, analysisId: analysis.id, ownerUserId: owner.user.id, analysisVersion: analysis.version,
      results: [{ attachmentId: attachment.attachmentId, revisionId: attachment.id, reference: attachment.reference, view: { family: 'table', offset: 0, limit: 1 } }], documents: [], notes: { summary: null, decisions: null, limitations: null }, prerequisites: [] };
    const old = await preparations.prepare(owner.user.id, project.id, analysis.id, legacy);
    const mixed = recipe(linked.reference); mixed.results.unshift({ kind: 'attachment-revision', ...legacy.results[0] });
    const current = await preparations.prepare(owner.user.id, project.id, analysis.id, mixed); expect(current.state).toBe('ready');
    expect(current.package.results[0].origin).toMatchObject({ kind: 'attachment-revision', attachment: { revisionId: attachment.id, caption: 'Original attached caption' } });
    expect((await preparations.getByRequest(owner.user.id, project.id, analysis.id, legacy.requestId)).snapshotSha256).toBe(old.snapshotSha256);
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, { ...mixed, requestId: legacy.requestId })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_REQUEST_CONFLICT' });
    expect((await preparations.list(owner.user.id, project.id, analysis.id)).items).toHaveLength(2); await db.initSchema(); await db.initSchema();
    expect((await preparations.getByRequest(owner.user.id, project.id, analysis.id, mixed.requestId)).snapshotSha256).toBe(current.snapshotSha256);
    expect((await db.query("SELECT schema_version FROM app_schema_contract WHERE schema_key='traceomics.runtime'")).rows[0].schema_version).toBe(20261032);
  });

  it('retains safe opaque and foreign-owned prerequisites without hashing or exposing their private metadata', async () => {
    const actual = await source(), opaque = await source('av', 'rds'), foreign = await source('av', 'csv', colleague);
    await pin([actual.reference, opaque.reference]); await pin([actual.reference, opaque.reference, foreign.reference], colleague);
    const choices = (await api(`/options?kind=analysis-references&analysisVersion=${analysis.version}`)).data;
    expect(validateSnapshotPreparationOptions(choices, { serviceId: identity, projectId: project.id, analysisId: analysis.id, userId: owner.user.id }, 'analysis-references', analysis.version)).toEqual(choices);
    expect(choices.items).toHaveLength(3); expect(choices.items[1]).toMatchObject({ viewFamily: null, referenceOnlyReason: 'opaque', integrity: 'not-checked', availability: 'not-checked' });
    expect(choices.items[2]).toMatchObject({ label: 'Saved reference', viewFamily: null, referenceOnlyReason: 'restricted-or-unavailable' });
    let opens = 0; const counted = { ...provider, openVerifiedRead: (...args) => { opens++; return provider.openVerifiedRead(...args); } };
    const input = recipe(actual.reference, { prerequisites: [opaque, foreign].map(item => ({ kind: 'analysis-reference', reference: item.reference, label: 'Original source access', detail: null })) });
    const saved = await createAnalysisSnapshotPreparationService(db, counted).prepare(owner.user.id, project.id, analysis.id, input);
    expect(saved.state).toBe('ready'); expect(opens).toBe(1); expect(saved.package.prerequisites.items.map(item => item.reason)).toEqual(['opaque', 'restricted-or-unavailable']);
    expect(saved.package.prerequisites.items.every(item => item.dataAccess === 'not-granted' && item.integrity === 'not-checked')).toBe(true);
    expect(saved.package.prerequisites.items[1]).not.toHaveProperty('source');
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, recipe(foreign.reference))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE' });
  });

  it('keeps stable saved-reference options paging bound to the selected version without source I/O', async () => {
    const first = await source(), second = await source(); await pin([first.reference, second.reference]); const version = analysis.version;
    const guarded = { ...provider, openVerifiedRead: () => { throw new Error('No bytes on options.'); }, inspect: () => { throw new Error('No FS stat on options.'); } };
    const target = createAnalysisSnapshotPreparationService(db, guarded), options = await target.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-references', analysisVersion: version, limit: 1 });
    expect(options.items[0].reference).toEqual(first.reference);
    const next = await target.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-references', analysisVersion: version, limit: 1, cursor: options.nextCursor });
    expect(next.items[0].reference).toEqual(second.reference); expect(next.nextCursor).toBeNull();
    await pin([second.reference]);
    await expect(target.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-references', analysisVersion: analysis.version, cursor: options.nextCursor })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_INVALID_PAGE' });
    await expect(target.options(colleague.user.id, project.id, analysis.id, { kind: 'analysis-references', analysisVersion: version, cursor: options.nextCursor })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_INVALID_PAGE' });
    for (const suffix of ['/options?kind=analysis-references', '/options?kind=analysis-references&analysisVersion[]=2', '/options?kind=results&analysisVersion=2']) expect((await api(suffix)).status).toBe(400);
  });

  it('defers declared workflow figure semantics without dropping meaning and permits a no-semantics legacy flat figure', async () => {
    const actual = await source(), bytes = PNG.sync.write(new PNG({ width: 8, height: 4 })), job = await db.createProjectJob(owner.user.id, project.id, { jobType: 'generic' });
    await db.updateJobStatusForUser(owner.user.id, job.id, 'running'); await db.updateJobStatusForUser(owner.user.id, job.id, 'completed');
    const references = [];
    for (const declared of [true, false]) {
      const id = db.genId('eri'), key = storage.projectStorageFileKey(project.id, 'artifacts', id, 'figure.png'); await fs.writeFile(provider.prepareWrite(key), bytes);
      const descriptor = { id, type: 'figure', sha256: hash(bytes), sizeBytes: bytes.length, ...(declared ? { semantics: { title: 'Declared biological meaning' } } : {}) };
      await db.query('INSERT INTO workflow_artifacts(id,owner_user_id,project_id,job_id,descriptor_json,storage_key) VALUES($1,$2,$3,$4,$5,$6)', [id, owner.user.id, project.id, job.id, descriptor, key]);
      references.push({ kind: 'artifact-version', versionId: id, sha256: hash(bytes) });
    }
    await pin([actual.reference, ...references]);
    const choices = await preparations.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-references', analysisVersion: analysis.version });
    expect(choices.items[1]).toMatchObject({ viewFamily: null, referenceOnlyReason: 'unsupported-view' }); expect(choices.items[2]).toMatchObject({ viewFamily: 'image', referenceOnlyReason: null });
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, recipe(references[0], { results: [{ kind: 'analysis-reference', reference: references[0], caption: 'Figure', view: { family: 'image' } }] }))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE' });
    const saved = await preparations.prepare(owner.user.id, project.id, analysis.id, recipe(references[1], { results: [{ kind: 'analysis-reference', reference: references[1], caption: 'Legacy flat figure', view: { family: 'image' } }], prerequisites: [{ kind: 'analysis-reference', reference: references[0], label: 'Typed figure context', detail: 'Requires the later meaning adapter.' }] }));
    expect(saved.state).toBe('ready'); expect(saved.package.prerequisites.items[0].reason).toBe('unsupported-view');
  });

  it('preserves v2 original outcomes across actual committed ready ACK loss, reader downgrade and private deletion', async () => {
    const selected = await source(); await pin([selected.reference]); const input = recipe(selected.reference), pool = await db.connect(); let lost = false;
    const wrapped = { ...db, connect: async () => ({ connect: async () => {
      const client = await pool.connect(); return { query: async (sql, values) => {
        const result = await client.query(sql, values);
        if (sql === 'COMMIT' && !lost && (await db.query("SELECT COUNT(*) AS n FROM research_analysis_snapshot_preparations WHERE state='ready'")).rows[0].n === '1') { lost = true; throw new Error('Actual v2 ready ACK loss'); }
        return result;
      }, release: destroy => client.release(destroy) };
    } }) };
    await expect(createAnalysisSnapshotPreparationService(wrapped, provider).prepare(owner.user.id, project.id, analysis.id, input)).rejects.toThrow(/ACK loss/);
    const saved = await preparations.getByRequest(owner.user.id, project.id, analysis.id, input.requestId); expect(saved.state).toBe('ready');
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    const replay = await preparations.prepare(owner.user.id, project.id, analysis.id, input); expect(replay).toMatchObject({ preparationId: saved.preparationId, snapshotSha256: saved.snapshotSha256, canPrepare: false });
    const observed = { ...replay }; delete observed.created;
    expect(await validateSnapshotPreparation(observed, { serviceId: identity, projectId: project.id, analysisId: analysis.id, userId: owner.user.id }, input)).toMatchObject({ state: 'ready' });
    const removed = await preparations.remove(owner.user.id, project.id, analysis.id, saved.preparationId, { requestId: saved.requestId, requestSha256: saved.requestSha256 });
    expect(removed).toMatchObject({ state: 'deleted', recipe: null, package: null, requestSha256: saved.requestSha256 });
    const listed = await preparations.list(owner.user.id, project.id, analysis.id); expect(validateSnapshotPreparationList(listed, { serviceId: identity, projectId: project.id, analysisId: analysis.id, userId: owner.user.id })).toEqual(listed);
  });
});
