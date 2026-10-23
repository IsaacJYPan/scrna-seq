import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import { canonicalAnalysisSnapshotPackage } from '../shared/analysisSnapshotPreparation.mjs';
import { canonicalPublishAnalysisSnapshot, canonicalWithdrawAnalysisSnapshot } from '../shared/analysisSnapshotPublication.mjs';
import { importScriptDocument } from '../shared/scriptDocument.mjs';
import { validateSnapshotPublication, validateSnapshotPublicationList, validateSnapshotPublicationRequests, validateSnapshotPublicationReceipt, validateSnapshotAlreadyPublished } from '../src/analyses/snapshotPublicationValidation.js';
const db = require('./pgDatabase'), storage = require('./storage');
const { createAnalysisSnapshotPublicationService, projectSnapshotUsage } = require('./analysisSnapshotPublications');
const { createAnalysisSnapshotPreparationService } = require('./analysisSnapshotPreparations');
const { createArtifactVersionService } = require('./artifactVersions');
const { createAnalysisAttachmentService } = require('./analysisAttachments');
const { createResearchAnalysisService } = require('./researchAnalyses');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDm9bllj1W4jjkdEVtqqrEAADgAUUUV9HhP93h6L8j8wzH/AHyr/il+bP/Z', 'base64');
const csv = Buffer.from('sample,cells\ncontrol,12\ntreated,19\nthird,23\n');
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

describe.skipIf(!process.env.DATABASE_URL)('exact project finding publications', () => {
  let directory, provider, service, preparations, http, server, owner, colleague, project, analysis, serviceId, settings;
  beforeAll(async () => {
    settings = Object.fromEntries(['STORAGE_ROOT', 'VAULT_ROOT', 'APP_DEPLOYMENT_MODE'].map(key => [key, process.env[key]]));
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'traceomics-snapshot-publication-'));
    Object.assign(process.env, { STORAGE_ROOT: path.join(directory, 'storage'), VAULT_ROOT: path.join(directory, 'private'), APP_DEPLOYMENT_MODE: 'private' });
    await fs.mkdir(process.env.STORAGE_ROOT); provider = storage.createLocalStorageProvider(); http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    await db.resetSchemaForTests(); process.env.APP_DEPLOYMENT_MODE = 'private';
    owner = await http.createUserWithToken({ email: 'publication-owner@example.test' }); colleague = await http.createUserWithToken({ email: 'publication-reader@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Publication lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Publication study' });
    await db.addProjectMember(project.id, colleague.user.id, 'viewer');
    analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: crypto.randomUUID(), name: 'Fixed research findings' })).analysis;
    serviceId = (await db.getServiceExecutionIdentity()).id; service = createAnalysisSnapshotPublicationService(); preparations = createAnalysisSnapshotPreparationService(db, provider);
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve)); await db.close();
    for (const [key, value] of Object.entries(settings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = () => `/api/projects/${project.id}/analyses/${analysis.id}/snapshot-publications`;
  const api = (suffix = '', options = {}, actor = owner) => http.api(server, base() + suffix, { token: actor.token, ...options });
  const count = async table => Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
  const remove = value => preparations.remove(owner.user.id, project.id, analysis.id, value.preparationId, { requestId: value.requestId, requestSha256: value.requestSha256 });
  async function ready(extension = 'csv', overrides = {}) {
    const bytes = extension === 'jpeg' ? jpeg : extension === 'png' ? PNG.sync.write(new PNG({ width: 32, height: 16 })) : extension === 'tsv' ? Buffer.from('sample\tcells\ncontrol\t12\ntreated\t19\n') : csv;
    const location = path.join(directory, crypto.randomUUID() + '.' + extension); await fs.writeFile(location, bytes);
    const version = await createArtifactVersionService(db, provider).importFile(owner.user.id, project.id, { path: location, originalFilename: 'result.' + extension, name: 'Selected finding' });
    const attached = await createAnalysisAttachmentService(db, provider).create(owner.user.id, project.id, analysis.id, { requestId: crypto.randomUUID(),
      reference: { kind: 'artifact-version', versionId: version.versionId, sha256: version.sha256 }, caption: 'Exact retained result', suppliedOrigin: {} });
    const revision = attached.acceptedRevision;
    return preparations.prepare(owner.user.id, project.id, analysis.id, { requestId: crypto.randomUUID(), serviceId, projectId: project.id, analysisId: analysis.id,
      ownerUserId: owner.user.id, analysisVersion: 1, results: [{ attachmentId: revision.attachmentId, revisionId: revision.id, reference: revision.reference,
        view: ['png', 'jpeg'].includes(extension) ? { family: 'image' } : { family: 'table', offset: 0, limit: 2 } }], documents: [], notes: { summary: 'Fixed finding', decisions: null, limitations: null }, prerequisites: [], ...overrides });
  }
  const publish = candidate => ({ requestId: crypto.randomUUID(), serviceId, projectId: project.id, analysisId: analysis.id, ownerUserId: owner.user.id,
    preparationId: candidate.preparationId, snapshotSha256: candidate.snapshotSha256 });
  const withdraw = (receipt, actor = owner) => ({ requestId: crypto.randomUUID(), serviceId, projectId: project.id, analysisId: analysis.id, ownerUserId: actor.user.id,
    publicationId: receipt.acceptance.publicationId, snapshotSha256: receipt.acceptance.snapshotSha256 });
  async function wrappedDatabase(intercept) {
    const pool = await db.connect(); return { ...db, connect: async () => ({ connect: async () => {
      const client = await pool.connect(); return { query: (sql, values) => intercept(client, sql, values), release: destroy => client.release(destroy) };
    } }) };
  }
  async function raw(publication, viewId, kind = 'views', actor = colleague, query = '') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${base()}/${publication}/${kind}/${viewId}${query}`, { headers: { Cookie: `${require('./config').sessionCookieName()}=${actor.token}` } });
    return { response, bytes: Buffer.from(await response.arrayBuffer()) };
  }

  it.each(['csv', 'tsv', 'png', 'jpeg'])('explicitly publishes actual %s fixed bytes to a second current reader without granting private source access', async extension => {
    const candidate = await ready(extension), input = publish(candidate), response = await api('', { method: 'POST', body: input });
    expect(response.status).toBe(201); const saved = response.data;
    expect(await validateSnapshotPublicationReceipt(saved, { serviceId, projectId: project.id, analysisId: analysis.id, userId: owner.user.id }, { action: 'publish', ...input })).toEqual(saved);
    expect(saved).toMatchObject({ replayed: false, actorUserId: owner.user.id, requestSha256: hash(canonicalPublishAnalysisSnapshot(input)),
      acceptance: { action: 'publish', snapshotSha256: candidate.snapshotSha256, acceptedPolicyVersion: 1 }, current: { publisherUserId: owner.user.id, publisherLabel: expect.any(String), package: candidate.package, availability: { status: 'available' } } });
    expect(hash(canonicalAnalysisSnapshotPackage(saved.current.package))).toBe(candidate.snapshotSha256);
    const viewed = await api('/' + saved.acceptance.publicationId, {}, colleague); expect(viewed.status).toBe(200);
    expect(viewed.data).toMatchObject({ viewerUserId: colleague.user.id, canPublish: false, canWithdraw: false, package: candidate.package });
    expect(await validateSnapshotPublication(viewed.data, { serviceId, projectId: project.id, analysisId: analysis.id, userId: colleague.user.id }, { publicationId: saved.acceptance.publicationId, snapshotSha256: candidate.snapshotSha256 })).toEqual(viewed.data);
    expect(viewed.data).not.toHaveProperty('requestId'); expect(viewed.data).not.toHaveProperty('requestSha256');
    const item = candidate.package.results[0], retained = await raw(saved.acceptance.publicationId, item.viewId);
    expect(retained.response.status).toBe(200); expect(hash(retained.bytes)).toBe(item.view.blobSha256);
    expect(retained.response.headers.get('cache-control')).toContain('no-store'); expect(retained.response.headers.get('x-content-type-options')).toBe('nosniff');
    if (!['png', 'jpeg'].includes(extension)) expect(JSON.parse(retained.bytes).rows[0]).toEqual(['control', '12']);
    expect((await raw(saved.acceptance.publicationId, item.viewId, 'views', colleague, '?offset=20')).response.status).toBe(400);
    await expect(createArtifactVersionService(db, provider).get(colleague.user.id, project.id, item.source.versionId)).rejects.toThrow();
    expect(await count('research_analysis_snapshot_blobs')).toBe(1);
    for (const table of ['jobs', 'private_r_kernels', 'private_r_executions', 'analysis_branches']) expect(await count(table)).toBe(0);
    const listed = (await api()).data; expect(listed.items).toHaveLength(1);
    expect(validateSnapshotPublicationList(listed, { serviceId, projectId: project.id, analysisId: analysis.id, userId: owner.user.id })).toEqual(listed);
  });

  it('retains shared bytes after private deletion, then frees them atomically on withdrawal with immutable acceptance', async () => {
    const candidate = await ready(), input = publish(candidate), saved = await service.publish(owner.user.id, project.id, analysis.id, input);
    const firstUsage = await projectSnapshotUsage(db, project.id), blobBytes = candidate.package.results[0].view.blobBytes;
    const removed = await remove(candidate); expect(removed).toMatchObject({ state: 'deleted', recipe: null, package: null });
    expect(await count('research_analysis_snapshot_blobs')).toBe(1);
    expect((await db.query('SELECT reserved_bytes FROM research_analysis_snapshot_preparations')).rows[0].reserved_bytes).toBe('0');
    expect(await projectSnapshotUsage(db, project.id)).toBeLessThan(firstUsage);
    expect((await raw(saved.acceptance.publicationId, candidate.package.results[0].viewId)).response.status).toBe(200);
    const action = withdraw(saved), withdrawal = await service.withdraw(owner.user.id, project.id, analysis.id, action);
    expect(withdrawal).toMatchObject({ replayed: false, acceptance: { action: 'withdraw', acceptedPolicyVersion: 2 }, current: { policy: { state: 'withdrawn', version: 2 }, package: null, availability: null } });
    expect(await count('research_analysis_snapshot_blobs')).toBe(0); expect(await count('research_analysis_snapshot_publication_blobs')).toBe(0);
    expect(await projectSnapshotUsage(db, project.id)).toBe(Number((await db.query('SELECT metadata_bytes FROM research_analysis_snapshot_publications')).rows[0].metadata_bytes));
    expect((await raw(saved.acceptance.publicationId, candidate.package.results[0].viewId)).response.status).toBe(409);
    expect((await service.publish(owner.user.id, project.id, analysis.id, input)).current.policy.state).toBe('withdrawn');
    expect((await service.getByRequest(owner.user.id, project.id, analysis.id, action.requestId)).acceptance).toEqual(withdrawal.acceptance);
    expect(await projectSnapshotUsage(db, project.id)).toBeLessThan(firstUsage - blobBytes);
  });

  it('does not duplicate an active publication or invent acceptance and permits deliberate republish only from ready A', async () => {
    const candidate = await ready(), input = publish(candidate), saved = await service.publish(owner.user.id, project.id, analysis.id, input);
    const duplicate = await api('', { method: 'POST', body: publish(candidate) }); expect(duplicate.status).toBe(409);
    expect(duplicate.data).toMatchObject({ code: 'ANALYSIS_SNAPSHOT_ALREADY_PUBLISHED', publication: { publicationId: saved.acceptance.publicationId, snapshotSha256: candidate.snapshotSha256 } });
    expect(validateSnapshotAlreadyPublished(duplicate.data, { serviceId, projectId: project.id, analysisId: analysis.id, userId: owner.user.id }, { preparationId: candidate.preparationId, snapshotSha256: candidate.snapshotSha256 })).toEqual(duplicate.data);
    expect(await count('research_analysis_snapshot_publications')).toBe(1); expect(await count('research_analysis_snapshot_publication_requests')).toBe(1);
    await service.withdraw(owner.user.id, project.id, analysis.id, withdraw(saved)); expect(await count('research_analysis_snapshot_blobs')).toBe(1);
    const republished = await service.publish(owner.user.id, project.id, analysis.id, publish(candidate));
    expect(republished.acceptance.publicationId).not.toBe(saved.acceptance.publicationId); expect(await count('research_analysis_snapshot_blobs')).toBe(1);
    await remove(candidate); await service.withdraw(owner.user.id, project.id, analysis.id, withdraw(republished));
    await expect(service.publish(owner.user.id, project.id, analysis.id, publish(candidate))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE' });
  });

  it('recovers exact original publication before current writer, candidate and original source checks', async () => {
    const candidate = await ready(), input = publish(candidate), saved = await service.publish(owner.user.id, project.id, analysis.id, input);
    await remove(candidate); await createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, status: 'archived' });
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    expect((await api('', { method: 'POST', body: input })).data).toMatchObject({ replayed: true, acceptance: saved.acceptance, current: { canPublish: false, canWithdraw: true } });
    expect((await api('/requests')).data.items).toMatchObject([{ requestId: input.requestId, requestSha256: saved.requestSha256, acceptance: saved.acceptance }]);
    expect((await api('/requests', {}, colleague)).data.items).toEqual([]);
    const action = withdraw(saved), done = (await api('/' + saved.acceptance.publicationId + '/withdrawals', { method: 'POST', body: action })).data;
    expect(done.current.policy.state).toBe('withdrawn');
    expect(await validateSnapshotPublicationReceipt(done, { serviceId, projectId: project.id, analysisId: analysis.id, userId: owner.user.id }, { action: 'withdraw', ...action })).toEqual(done);
    const rediscovered = await api('/requests'); expect(rediscovered.data.items).toHaveLength(2); expect(rediscovered.data.items.every(item => item.currentPolicy.state === 'withdrawn')).toBe(true);
    expect(await validateSnapshotPublicationRequests(rediscovered.data, { serviceId, projectId: project.id, analysisId: analysis.id, userId: owner.user.id })).toEqual(rediscovered.data);
    expect((await api('/requests/' + input.requestId, {}, colleague)).status).toBe(404);
  });

  it('commits effects, receipt and one audit atomically despite an actually lost publish COMMIT acknowledgement', async () => {
    const candidate = await ready(), input = publish(candidate); let lost = false;
    const wrapped = await wrappedDatabase(async (client, sql, values) => {
      const result = await client.query(sql, values);
      if (sql === 'COMMIT' && !lost && (await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_publications')).rows[0].n === '1') { lost = true; throw new Error('Actual committed publish ACK loss'); }
      return result;
    });
    await expect(createAnalysisSnapshotPublicationService(wrapped).publish(owner.user.id, project.id, analysis.id, input)).rejects.toThrow(/ACK loss/);
    const recovered = await service.getByRequest(owner.user.id, project.id, analysis.id, input.requestId); expect(recovered.replayed).toBe(true);
    expect((await service.publish(owner.user.id, project.id, analysis.id, input)).acceptance).toEqual(recovered.acceptance);
    expect(await count('research_analysis_snapshot_publications')).toBe(1); expect(await count('research_analysis_snapshot_publication_requests')).toBe(1); expect(await count('project_audit_events')).toBe(1);
    await expect(service.publish(owner.user.id, project.id, analysis.id, { ...input, snapshotSha256: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_REQUEST_CONFLICT' });
  });

  it('recovers committed withdrawal without resurrecting byte leases and rejects losing new UUIDs', async () => {
    const candidate = await ready(), saved = await service.publish(owner.user.id, project.id, analysis.id, publish(candidate)); await remove(candidate);
    const action = withdraw(saved); let lost = false;
    const wrapped = await wrappedDatabase(async (client, sql, values) => {
      const result = await client.query(sql, values);
      if (sql === 'COMMIT' && !lost && (await db.query("SELECT COUNT(*) AS n FROM research_analysis_snapshot_publications WHERE state='withdrawn'")).rows[0].n === '1') { lost = true; throw new Error('Actual committed withdraw ACK loss'); }
      return result;
    });
    await expect(createAnalysisSnapshotPublicationService(wrapped).withdraw(owner.user.id, project.id, analysis.id, action)).rejects.toThrow(/ACK loss/);
    const recovered = await service.withdraw(owner.user.id, project.id, analysis.id, action);
    expect(recovered).toMatchObject({ replayed: true, requestSha256: hash(canonicalWithdrawAnalysisSnapshot(action)), current: { policy: { state: 'withdrawn' }, package: null } });
    expect(await count('research_analysis_snapshot_blobs')).toBe(0); expect(await count('project_audit_events')).toBe(2);
    await expect(service.withdraw(owner.user.id, project.id, analysis.id, withdraw(saved))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_ALREADY_WITHDRAWN' });
    expect(await count('research_analysis_snapshot_publication_requests')).toBe(2);
  });

  it('enforces original publisher/current reader or project admin withdrawal and current membership on every read', async () => {
    const candidate = await ready(), saved = await service.publish(owner.user.id, project.id, analysis.id, publish(candidate));
    await expect(service.withdraw(colleague.user.id, project.id, analysis.id, withdraw(saved, colleague))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_WITHDRAW_REQUIRED' });
    await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, owner.user.id]);
    expect((await api('/' + saved.acceptance.publicationId, {}, colleague)).status).toBe(200);
    expect((await api('/requests/' + saved.requestId)).data.code).toBe('ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND');
    await db.query("UPDATE project_members SET role='admin' WHERE project_id=$1 AND user_id=$2", [project.id, colleague.user.id]);
    const action = withdraw(saved, colleague), response = await api('/' + saved.acceptance.publicationId + '/withdrawals', { method: 'POST', body: action }, colleague), removed = response.data;
    expect(response.status).toBe(200);
    expect(await validateSnapshotPublicationReceipt(removed, { serviceId, projectId: project.id, analysisId: analysis.id, userId: colleague.user.id }, { action: 'withdraw', ...action })).toEqual(removed);
    expect(removed).toMatchObject({ actorUserId: colleague.user.id, current: { publisherUserId: owner.user.id, policy: { withdrawnByUserId: colleague.user.id } } });
  });

  it('fences a held retained read after actual membership revocation and after withdrawal', async () => {
    const candidate = await ready(), saved = await service.publish(owner.user.id, project.id, analysis.id, publish(candidate));
    async function heldRead(action) {
      const paused = gate(), release = gate(); let captured = false;
      const wrapped = await wrappedDatabase(async (client, sql, values) => {
        const result = await client.query(sql, values);
        if (!captured && sql === 'COMMIT') { captured = true; paused.release(); await release.promise; }
        return result;
      });
      const pending = createAnalysisSnapshotPublicationService(wrapped).readBlob(colleague.user.id, project.id, analysis.id, saved.acceptance.publicationId, candidate.package.results[0].viewId, 'result');
      await paused.promise; await action(); release.release(); return pending;
    }
    await expect(heldRead(() => db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, colleague.user.id]))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND' });
    await db.addProjectMember(project.id, colleague.user.id, 'viewer');
    await expect(heldRead(() => service.withdraw(owner.user.id, project.id, analysis.id, withdraw(saved)))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN' });
  });

  it('publishes retained old supporting source and fixed results without original files or newer heads', async () => {
    const { createNotebookDocumentService } = require('./notebookDocuments'), docs = createNotebookDocumentService();
    const exactSource = '# Exact supporting method\r\nx <- 12\n', content = importScriptDocument({ filename: 'supporting.R', bytes: new TextEncoder().encode(exactSource), cellId: 'whole-script' });
    const original = (await docs.create(owner.user.id, project.id, analysis.id, { requestId: crypto.randomUUID(), title: 'Original source', content })).document;
    const candidate = await ready('csv', { documents: [{ documentId: original.id, versionId: original.versionId, sha256: original.sha256 }] });
    await docs.save(owner.user.id, project.id, analysis.id, original.id, { requestId: crypto.randomUUID(), expectedVersion: 1, title: 'Newer method', content: { ...content, cells: [{ ...content.cells[0], source: 'x <- 999\n' }] } });
    await createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, name: 'Newer analysis name' });
    const source = (await db.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [candidate.package.results[0].source.versionId])).rows[0]; await fs.unlink(provider.resolveKey(source.storage_key));
    const saved = await service.publish(owner.user.id, project.id, analysis.id, publish(candidate));
    expect(saved.current.package.analysis).toMatchObject({ name: 'Fixed research findings', version: 1 });
    expect(saved.current.package.reproduction).toMatchObject({ producingSource: 'not-established', runtime: 'not-included', dataAccess: 'not-granted' });
    const descriptor = saved.current.package.documents[0], retained = await raw(saved.acceptance.publicationId, descriptor.viewId, 'documents');
    expect(retained.response.status).toBe(200); expect(hash(retained.bytes)).toBe(original.sha256); expect(JSON.parse(retained.bytes).cells[0].source).toBe(exactSource);
    expect(descriptor).toMatchObject({ title: 'Original source', versionId: original.versionId, role: 'supporting-source', producingSource: 'not-established' });
    expect((await raw(saved.acceptance.publicationId, descriptor.viewId)).response.status).toBe(404);
  });

  it('prevents adoption when private DELETE wins after retained verification without holding analysis locks', async () => {
    const candidate = await ready(), input = publish(candidate), paused = gate(), release = gate(); let captured = false, held = false;
    const wrapped = await wrappedDatabase(async (client, sql, values) => {
      const result = await client.query(sql, values);
      if (sql.includes('SELECT blob.*') && !sql.includes('lease')) captured = true;
      if (sql === 'COMMIT' && captured && !held) { held = true; paused.release(); await release.promise; }
      return result;
    });
    const pending = createAnalysisSnapshotPublicationService(wrapped).publish(owner.user.id, project.id, analysis.id, input); await paused.promise;
    try { expect((await remove(candidate)).state).toBe('deleted'); } finally { release.release(); }
    await expect(pending).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE' });
    expect(await count('research_analysis_snapshot_publications')).toBe(0); expect(await count('research_analysis_snapshot_publication_blobs')).toBe(0); expect(await count('research_analysis_snapshot_blobs')).toBe(0);
  });

  it('serializes different fresh publish UUIDs into one active finding and same withdrawal UUID into one acceptance', async () => {
    const candidate = await ready(), first = publish(candidate), second = publish(candidate);
    const outcomes = await Promise.allSettled([service.publish(owner.user.id, project.id, analysis.id, first), service.publish(owner.user.id, project.id, analysis.id, second)]);
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1); expect(outcomes.find(item => item.status === 'rejected').reason.code).toBe('ANALYSIS_SNAPSHOT_ALREADY_PUBLISHED');
    const saved = outcomes.find(item => item.status === 'fulfilled').value, action = withdraw(saved);
    const withdrawals = await Promise.all([service.withdraw(owner.user.id, project.id, analysis.id, action), service.withdraw(owner.user.id, project.id, analysis.id, action)]);
    expect(withdrawals[0].acceptance).toEqual(withdrawals[1].acceptance); expect(withdrawals.map(item => item.replayed).sort()).toEqual([false, true]);
    expect(await count('research_analysis_snapshot_publications')).toBe(1); expect(await count('research_analysis_snapshot_publication_requests')).toBe(2); expect(await count('project_audit_events')).toBe(2);
    await expect(service.withdraw(owner.user.id, project.id, analysis.id, { ...action, requestId: saved.requestId })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_REQUEST_CONFLICT' });
  });

  it('preserves immutable manifests/receipts and FK-protects active bytes after private deletion', async () => {
    const candidate = await ready(), saved = await service.publish(owner.user.id, project.id, analysis.id, publish(candidate)); await remove(candidate);
    await expect(db.query("UPDATE research_analysis_snapshot_publications SET package_json='{}' WHERE id=$1", [saved.acceptance.publicationId])).rejects.toMatchObject({ code: '55000' });
    await expect(db.query('UPDATE research_analysis_snapshot_publication_requests SET request_sha256=request_sha256')).rejects.toMatchObject({ code: '55000' });
    await expect(db.query('DELETE FROM research_analysis_snapshot_publication_blobs WHERE publication_id=$1', [saved.acceptance.publicationId])).rejects.toMatchObject({ code: '55000' });
    await expect(db.query('DELETE FROM research_analysis_snapshot_blobs WHERE preparation_id=$1', [candidate.preparationId])).rejects.toMatchObject({ code: '23503' });
    await service.withdraw(owner.user.id, project.id, analysis.id, withdraw(saved));
    await expect(db.query("UPDATE research_analysis_snapshot_publications SET state='published',policy_version=1,withdrawn_at=NULL,withdrawn_by_user_id=NULL WHERE id=$1", [saved.acceptance.publicationId])).rejects.toMatchObject({ code: '55000' });
    await expect(db.query(`INSERT INTO research_analysis_snapshot_publications(id,service_id,project_id,analysis_id,publisher_user_id,preparation_id,request_id,request_sha256,package_json,snapshot_sha256,metadata_bytes)
      SELECT $2,service_id,project_id,analysis_id,publisher_user_id,preparation_id,$3,request_sha256,package_json,snapshot_sha256,metadata_bytes FROM research_analysis_snapshot_publications WHERE id=$1`,
    [saved.acceptance.publicationId, 'aspub_' + crypto.randomBytes(12).toString('hex'), crypto.randomUUID()])).rejects.toMatchObject({ code: '55000' });
    expect((await service.get(owner.user.id, project.id, analysis.id, saved.acceptance.publicationId)).package).toBeNull();
  });

  it('keeps accepted identity unavailable after damaged retained reads and never adopts corrupted fresh bytes', async () => {
    const candidate = await ready(), input = publish(candidate);
    const damaged = await wrappedDatabase(async (client, sql, values) => {
      const result = await client.query(sql, values);
      if (sql.includes('SELECT blob.*')) return { ...result, rows: result.rows.map(blob => ({ ...blob, content: Buffer.alloc(blob.content.length, 120) })) };
      return result;
    });
    await expect(createAnalysisSnapshotPublicationService(damaged).publish(owner.user.id, project.id, analysis.id, input)).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_VIEW_UNAVAILABLE' });
    expect(await count('research_analysis_snapshot_publications')).toBe(0);
    const saved = await service.publish(owner.user.id, project.id, analysis.id, input), changed = await createAnalysisSnapshotPublicationService(damaged).get(colleague.user.id, project.id, analysis.id, saved.acceptance.publicationId);
    expect(changed).toMatchObject({ snapshotSha256: candidate.snapshotSha256, package: candidate.package, availability: { status: 'unavailable' } });
    await expect(createAnalysisSnapshotPublicationService(damaged).readBlob(colleague.user.id, project.id, analysis.id, saved.acceptance.publicationId, candidate.package.results[0].viewId, 'result')).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_VIEW_UNAVAILABLE' });
    expect((await service.get(colleague.user.id, project.id, analysis.id, saved.acceptance.publicationId)).availability.status).toBe('available');
  });

  it('pages public identity and private accepted requests independently without reading retained bodies', async () => {
    const candidate = await ready(), first = await service.publish(owner.user.id, project.id, analysis.id, publish(candidate));
    await service.withdraw(owner.user.id, project.id, analysis.id, withdraw(first)); await service.publish(owner.user.id, project.id, analysis.id, publish(candidate));
    const guarded = await wrappedDatabase(async (client, sql, values) => {
      if (sql.includes('research_analysis_snapshot_blobs') || sql.includes('SELECT blob.*')) throw new Error('Publication metadata discovery must not read payloads.');
      return client.query(sql, values);
    });
    const reader = createAnalysisSnapshotPublicationService(guarded), publicFirst = await reader.list(colleague.user.id, project.id, analysis.id, { limit: 1 });
    const publicSecond = await reader.list(colleague.user.id, project.id, analysis.id, { limit: 1, cursor: publicFirst.nextCursor });
    expect(publicFirst.items[0].publicationId).not.toBe(publicSecond.items[0].publicationId); expect(publicSecond.nextCursor).toBeNull(); expect(publicSecond.items[0].selection).toBeNull();
    const privateFirst = await reader.listRequests(owner.user.id, project.id, analysis.id, { limit: 1 }), ids = [privateFirst.items[0].requestId]; let cursor = privateFirst.nextCursor;
    while (cursor) { const next = await reader.listRequests(owner.user.id, project.id, analysis.id, { limit: 1, cursor }); ids.push(next.items[0].requestId); cursor = next.nextCursor; }
    expect(new Set(ids).size).toBe(3); expect((await reader.listRequests(colleague.user.id, project.id, analysis.id)).items).toEqual([]);
    await expect(reader.list(owner.user.id, project.id, analysis.id, { cursor: publicFirst.nextCursor })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_INVALID_PAGE' });
    await expect(reader.listRequests(owner.user.id, project.id, analysis.id, { cursor: publicFirst.nextCursor })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_INVALID_PAGE' });
    for (const suffix of ['?limit[]=1', '?cursor=bad-json', '/requests?limit=0', '/requests?unknown=1']) expect((await api(suffix)).status).toBe(400);
  });

  it('uses current bounded safe publisher labels outside the unchanged package digest', async () => {
    await db.query('UPDATE users SET display_name=$2 WHERE id=$1', [owner.user.id, '🧬'.repeat(100)]);
    const candidate = await ready(), saved = await service.publish(owner.user.id, project.id, analysis.id, publish(candidate));
    expect(saved.current.publisherLabel).toBe('🧬'.repeat(100));
    await db.query('UPDATE users SET display_name=$2 WHERE id=$1', [owner.user.id, '\u0001\u200b  Legacy\nProfile  ' + '🧬'.repeat(110)]);
    const next = await service.get(colleague.user.id, project.id, analysis.id, saved.acceptance.publicationId);
    expect(next.publisherLabel.length).toBeLessThanOrEqual(200); expect(next.publisherLabel).toMatch(/^Legacy Profile/); expect(next.publisherLabel).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(next.snapshotSha256).toBe(candidate.snapshotSha256); expect(next.package).toEqual(candidate.package);
  });

  it('applies schema32 twice while accepted publication/private data and exact blob identities survive', async () => {
    const candidate = await ready(), saved = await service.publish(owner.user.id, project.id, analysis.id, publish(candidate)); await db.initSchema(); await db.initSchema();
    expect((await db.query("SELECT schema_version FROM app_schema_contract WHERE schema_key='traceomics.runtime'")).rows[0].schema_version).toBe(20261032);
    expect((await service.getByRequest(owner.user.id, project.id, analysis.id, saved.requestId)).acceptance).toEqual(saved.acceptance);
    expect((await service.get(colleague.user.id, project.id, analysis.id, saved.acceptance.publicationId)).package).toEqual(candidate.package);
    expect((await preparations.get(owner.user.id, project.id, analysis.id, candidate.preparationId)).package).toEqual(candidate.package);
    expect(await count('research_analysis_snapshot_blobs')).toBe(1);
  });

  it('shares A and B project capacity while guaranteeing withdrawal at exhausted payload capacity', async () => {
    const candidate = await ready(), other = await ready(), saved = await service.publish(owner.user.id, project.id, analysis.id, publish(candidate));
    const historicalOwners = [colleague.user.id];
    for (let index = 0; index < 3; index++) historicalOwners.push((await http.createUserWithToken({ email: `historical-publication-reservation-${index}@example.test` })).user.id);
    // Inert historical incomplete reservations exercise aggregate accounting;
    // they do not grant original source reads or execute scientific work.
    await db.query(`INSERT INTO research_analysis_snapshot_preparations(id,service_id,project_id,analysis_id,analysis_version,owner_user_id,request_id,request_sha256,recipe_json,analysis_snapshot_json,object_plan_json,state,failure_json,reserved_bytes)
      SELECT 'asp_'||substr(md5(i::text),1,24),$1,$2,$3,1,($4::bigint[])[((i-1)/8)+1],('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,repeat('a',64),'{}','{}','[]','failed',
      '{"code":"ANALYSIS_SNAPSHOT_BUILD_FAILED","message":"Historical incomplete reservation."}',16777216 FROM generate_series(1,32) i`, [serviceId, project.id, analysis.id, historicalOwners]);
    expect(await projectSnapshotUsage(db, project.id)).toBeGreaterThan(512 * 1024 * 1024);
    await expect(service.publish(owner.user.id, project.id, analysis.id, publish(other))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_CAPACITY' });
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, { ...candidate.recipe, requestId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_CAPACITY' });
    const receipt = await service.withdraw(owner.user.id, project.id, analysis.id, withdraw(saved)); expect(receipt.current.policy.state).toBe('withdrawn');
    expect((await service.getByRequest(owner.user.id, project.id, analysis.id, saved.requestId)).acceptance).toEqual(saved.acceptance);
  });

  it('bounds project-ever publication history without blocking a reserved first withdrawal or original replay', async () => {
    const candidate = await ready(), other = await ready(), input = publish(candidate), saved = await service.publish(owner.user.id, project.id, analysis.id, input);
    // Immutable historical withdrawn metadata contains no active grant or new
    // payload. Keep real selected package literals for bounded-history proof.
    await db.query(`INSERT INTO research_analysis_snapshot_publications(id,service_id,project_id,analysis_id,publisher_user_id,preparation_id,request_id,request_sha256,package_json,snapshot_sha256,metadata_bytes,state,policy_version,withdrawn_at,withdrawn_by_user_id)
      SELECT 'aspub_'||substr(md5(i::text),1,24),$1,$2,$3,$4,$5,('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,repeat('a',64),$6,$7,8192,'withdrawn',2,clock_timestamp(),$4 FROM generate_series(1,1999) i`,
    [serviceId, project.id, analysis.id, owner.user.id, candidate.preparationId, candidate.package, candidate.snapshotSha256]);
    expect(await count('research_analysis_snapshot_publications')).toBe(2000);
    await expect(service.publish(owner.user.id, project.id, analysis.id, publish(other))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_CAPACITY' });
    expect((await service.publish(owner.user.id, project.id, analysis.id, input)).acceptance).toEqual(saved.acceptance);
    expect((await service.withdraw(owner.user.id, project.id, analysis.id, withdraw(saved))).current.policy.state).toBe('withdrawn');
  });

  it('reserves two publication verifier slots before genuinely held pool acquisition without losing their tokens', async () => {
    const candidates = [await ready(), await ready(), await ready()], inputs = candidates.map(publish), pool = await db.connect();
    const holders = await Promise.all(Array.from({ length: pool.options.max }, () => pool.connect())), released = gate(), initial = gate(); let commits = 0, reads = 0;
    const wrapped = await wrappedDatabase(async (client, sql, values) => {
      const result = await client.query(sql, values);
      if (sql === 'COMMIT' && ++commits === 3) initial.release();
      if (sql.includes('SELECT blob.*') && !sql.includes('lease')) { reads++; await released.promise; }
      return result;
    });
    const target = createAnalysisSnapshotPublicationService(wrapped), tasks = inputs.map(input => target.publish(owner.user.id, project.id, analysis.id, input));
    const outcomes = tasks.map(task => task.then(value => ({ value }), failure => ({ failure }))); let timeout;
    const bounded = promise => Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Held publication pool failed to respect bounded verification.')), 5000); })]).finally(() => clearTimeout(timeout));
    let first;
    try {
      while (pool.waitingCount < 3) await new Promise(resolve => setImmediate(resolve));
      holders.pop().release(); await bounded(initial.promise); holders.pop().release();
      first = await bounded(Promise.race(outcomes)); expect(first.failure?.code).toBe('ANALYSIS_SNAPSHOT_BUSY'); expect(reads).toBeLessThanOrEqual(2);
    } finally { released.release(); for (const holder of holders) holder.release(); await Promise.all(outcomes); }
    expect(reads).toBe(2); expect(await count('research_analysis_snapshot_publications')).toBe(2);
    // Discover the actual unaccepted original; no automatic new UUID was made.
    const accepted = new Set((await service.listRequests(owner.user.id, project.id, analysis.id)).items.map(item => item.requestId));
    const original = inputs.find(input => !accepted.has(input.requestId)); expect(original).toBeTruthy();
    expect((await service.publish(owner.user.id, project.id, analysis.id, original)).replayed).toBe(false); expect(await count('research_analysis_snapshot_publications')).toBe(3);
  });

  it('cleans an expired guest project publication and shared bytes without touching another project', async () => {
    const retained = await ready(), saved = await service.publish(owner.user.id, project.id, analysis.id, publish(retained)), original = { owner, project, analysis };
    let disposable;
    try {
      owner = await http.createUserWithToken({ email: 'disposable-publication-owner@example.test' });
      const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Disposable publication lab' });
      project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Disposable publication study' });
      analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: crypto.randomUUID(), name: 'Disposable findings' })).analysis;
      const candidate = await ready(), accepted = await service.publish(owner.user.id, project.id, analysis.id, publish(candidate)); await remove(candidate);
      disposable = { owner, project, accepted, candidate };
      await db.query("UPDATE users SET is_demo_guest=TRUE,expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1", [owner.user.id]);
      await expect(service.publish(owner.user.id, project.id, analysis.id, { ...publish(candidate), requestId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_WRITE_REQUIRED' });
    } finally { ({ owner, project, analysis } = original); }
    await db.query("UPDATE users SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [disposable.owner.user.id]);
    expect(await db.deleteExpiredDemoGuest(disposable.owner.user.id)).toBe(true);
    expect((await db.query('SELECT id FROM research_analysis_snapshot_publications WHERE project_id=$1', [disposable.project.id])).rowCount).toBe(0);
    expect((await db.query('SELECT id FROM research_analysis_snapshot_blobs WHERE preparation_id=$1', [disposable.candidate.preparationId])).rowCount).toBe(0);
    expect((await service.get(owner.user.id, project.id, analysis.id, saved.acceptance.publicationId)).snapshotSha256).toBe(retained.snapshotSha256);
  });
});
