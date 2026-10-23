import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import { canonicalAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPackage, canonicalSnapshotJson } from '../shared/analysisSnapshotPreparation.mjs';
import { canonicalNotebookContent } from '../shared/notebookDocument.mjs';
import { validateSnapshotPreparation, validateSnapshotPreparationList, validateSnapshotPreparationOptions, decodeSnapshotPreparationTable, decodeSnapshotPreparationDocument } from '../src/analyses/snapshotPreparationValidation.js';
const db = require('./pgDatabase'), storage = require('./storage');
const { createAnalysisSnapshotPreparationService } = require('./analysisSnapshotPreparations');
const { createArtifactVersionService } = require('./artifactVersions');
const { createAnalysisAttachmentService } = require('./analysisAttachments');
const { createResearchAnalysisService } = require('./researchAnalyses');
const { createNotebookDocumentService } = require('./notebookDocuments');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const csv = Buffer.from('sample,cells\ncontrol,12\ntreated,19\nthird,23\n');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDm9bllj1W4jjkdEVtqqrEAADgAUUUV9HhP93h6L8j8wzH/AHyr/il+bP/Z', 'base64');
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

describe.skipIf(!process.env.DATABASE_URL)('private exact retained snapshot preparations', () => {
  let directory, provider, service, http, server, owner, colleague, project, analysis, serviceId, settings;
  beforeAll(async () => {
    settings = Object.fromEntries(['STORAGE_ROOT', 'VAULT_ROOT', 'APP_DEPLOYMENT_MODE'].map(key => [key, process.env[key]]));
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'traceomics-snapshot-preparation-'));
    Object.assign(process.env, { STORAGE_ROOT: path.join(directory, 'storage'), VAULT_ROOT: path.join(directory, 'private'), APP_DEPLOYMENT_MODE: 'private' });
    await fs.mkdir(process.env.STORAGE_ROOT); provider = storage.createLocalStorageProvider(); http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    await db.resetSchemaForTests(); process.env.APP_DEPLOYMENT_MODE = 'private';
    owner = await http.createUserWithToken({ email: 'snapshot-owner@example.test' }); colleague = await http.createUserWithToken({ email: 'snapshot-colleague@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Snapshot lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Snapshot study' });
    await db.addProjectMember(project.id, colleague.user.id, 'analyst');
    analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: crypto.randomUUID(), name: 'Exact outside evidence' })).analysis;
    serviceId = (await db.getServiceExecutionIdentity()).id; service = createAnalysisSnapshotPreparationService(db, provider);
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve)); await db.close();
    for (const [key, value] of Object.entries(settings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = (a = analysis) => `/api/projects/${project.id}/analyses/${a.id}/snapshot-preparations`;
  const api = (suffix = '', options = {}, actor = owner, a = analysis) => http.api(server, base(a) + suffix, { token: actor.token, ...options });
  const count = async table => Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
  const operation = value => ({ requestId: value.requestId, requestSha256: value.requestSha256 });
  async function result(filename = 'evidence.csv', bytes = csv, actor = owner) {
    const location = path.join(directory, crypto.randomUUID() + '-' + filename); await fs.writeFile(location, bytes);
    const version = await createArtifactVersionService(db, provider).importFile(actor.user.id, project.id, { path: location, originalFilename: filename, name: 'Retained evidence' });
    const attached = await createAnalysisAttachmentService(db, provider).create(actor.user.id, project.id, analysis.id, { requestId: crypto.randomUUID(),
      reference: { kind: 'artifact-version', versionId: version.versionId, sha256: version.sha256 }, caption: 'Exact saved evidence', suppliedOrigin: { origin: 'Supplied context' } });
    const revision = attached.acceptedRevision;
    return { version, revision, selection: { attachmentId: revision.attachmentId, revisionId: revision.id, reference: revision.reference,
      view: filename.endsWith('.csv') || filename.endsWith('.tsv') ? { family: 'table', offset: 0, limit: 2 } : { family: 'image' } } };
  }
  async function recipe(change = {}, selected) {
    const evidence = selected || await result();
    return { requestId: crypto.randomUUID(), serviceId, projectId: project.id, analysisId: analysis.id, ownerUserId: owner.user.id, analysisVersion: 1,
      results: [evidence.selection], documents: [], notes: { summary: 'Selected exact evidence', decisions: null, limitations: null },
      prerequisites: [{ kind: 'compute', label: 'Original runtime', detail: 'Not included in this private preparation.' }], ...change };
  }
  async function wrappedDatabase(intercept) {
    const pool = await db.connect(); return { ...db, connect: async () => ({ connect: async () => {
      const client = await pool.connect(); return { query: (sql, values) => intercept(client, sql, values), release: destroy => client.release(destroy) };
    } }) };
  }
  async function raw(suffix, actor = owner) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}` + base() + suffix, { headers: { Cookie: `${require('./config').sessionCookieName()}=${actor.token}` } });
    return { response, bytes: Buffer.from(await response.arrayBuffer()) };
  }

  it.each(['csv', 'tsv', 'png', 'jpeg'])('retains actual %s views with literal source and independent view/package hashes and no publication', async extension => {
    const bytes = extension === 'jpeg' ? jpeg : extension === 'png' ? PNG.sync.write(new PNG({ width: 32, height: 16 })) : extension === 'tsv' ? Buffer.from('sample\tcells\ncontrol\t12\ntreated\t19\n') : csv;
    const selected = await result('actual.' + extension, bytes), input = await recipe({}, selected), response = await api('', { method: 'POST', body: input });
    expect(response.status).toBe(201); expect(response.data).toMatchObject({ state: 'ready', recipe: input, canPrepare: true, canResume: false, canDelete: true,
      requestSha256: hash(canonicalAnalysisSnapshotPreparation(input)), availability: { status: 'available' } });
    const saved = response.data, item = saved.package.results[0];
    expect(await validateSnapshotPreparation(saved, { serviceId, projectId: project.id, analysisId: analysis.id, userId: owner.user.id }, input)).toEqual(saved);
    expect(saved.snapshotSha256).toBe(hash(canonicalAnalysisSnapshotPackage(saved.package))); expect(item.source.sha256).toBe(hash(bytes));
    expect(item.source.format).toEqual({ id: selected.version.format.id, version: '1' });
    const retained = await raw(`/${saved.preparationId}/views/${item.viewId}`); expect(retained.response.status).toBe(200);
    expect(retained.bytes.length).toBe(item.view.blobBytes); expect(hash(retained.bytes)).toBe(item.view.blobSha256);
    if (!['png', 'jpeg'].includes(extension)) expect((await decodeSnapshotPreparationTable(retained.bytes, item)).rows[0]).toEqual(['control', '12']);
    else { expect(retained.bytes).toEqual(bytes); expect(item.view.width).toBe(extension === 'png' ? 32 : 3); expect(retained.response.headers.get('content-type')).toBe(extension === 'png' ? 'image/png' : 'image/jpeg'); }
    expect(retained.response.headers.get('cache-control')).toContain('no-store'); expect(retained.response.headers.get('x-content-type-options')).toBe('nosniff');
    for (const table of ['jobs', 'private_r_kernels', 'private_r_executions', 'analysis_branches', 'project_audit_events']) expect(await count(table)).toBe(0);
    expect((await db.query('SELECT version FROM research_analyses WHERE id=$1', [analysis.id])).rows[0].version).toBe(1);
    expect((await api(`/${saved.preparationId}/views/${item.viewId}?offset=2`)).status).toBe(400);
  });

  it('pins historical caption, source and analysis revision, while separate fixed excerpts hash one original once', async () => {
    const selected = await result(), input = await recipe({ results: [selected.selection, { ...selected.selection, view: { family: 'table', offset: 2, limit: 1 } }] }, selected);
    await createAnalysisAttachmentService(db, provider).correct(owner.user.id, project.id, analysis.id, selected.revision.attachmentId, { requestId: crypto.randomUUID(), expectedHeadRevisionId: selected.revision.id,
      reference: selected.revision.reference, caption: 'A newer caption', suppliedOrigin: {} });
    await createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, name: 'A newer analysis name' });
    let opens = 0; const counted = { ...provider, openVerifiedRead: async (...args) => { opens++; return provider.openVerifiedRead(...args); } };
    const saved = await createAnalysisSnapshotPreparationService(db, counted).prepare(owner.user.id, project.id, analysis.id, input);
    expect(saved.state).toBe('ready'); expect(opens).toBe(1); expect(saved.package.analysis).toMatchObject({ version: 1, name: analysis.name });
    expect(saved.package.results[0].attachment.caption).toBe('Exact saved evidence'); expect(saved.package.results[0].attachment.revisionId).toBe(selected.revision.id);
    expect(JSON.parse((await service.readBlob(owner.user.id, project.id, analysis.id, saved.preparationId, saved.package.results[1].viewId, 'result')).bytes).rows).toEqual([['third', '23']]);
  });

  it('copies exact saved supporting source without drafts, newer title or invented producing execution', async () => {
    const content = { schema: 'traceomics.notebook.v1', defaultLanguage: 'R', cells: [{ id: 'source-cell', type: 'code', language: 'R', source: '# β 🧬\r\nx <- 1\n', collapsed: false }] };
    const docs = createNotebookDocumentService(), original = (await docs.create(owner.user.id, project.id, analysis.id, { requestId: crypto.randomUUID(), title: 'Supporting method', content })).document;
    await docs.save(owner.user.id, project.id, analysis.id, original.id, { requestId: crypto.randomUUID(), expectedVersion: 1, title: 'A newer method', content: { ...content, cells: [{ ...content.cells[0], source: 'x <- 99' }] } });
    const input = await recipe({ documents: [{ documentId: original.id, versionId: original.versionId, sha256: original.sha256 }] });
    const saved = await service.prepare(owner.user.id, project.id, analysis.id, input); expect(saved.state).toBe('ready');
    const item = saved.package.documents[0]; expect(item).toMatchObject({ versionId: original.versionId, version: 1, title: 'Supporting method', role: 'supporting-source', producingSource: 'not-established' });
    const retained = await raw(`/${saved.preparationId}/documents/${item.viewId}`); expect(retained.bytes.toString()).toBe(canonicalNotebookContent(content)); expect(hash(retained.bytes)).toBe(original.sha256);
    expect(await decodeSnapshotPreparationDocument(retained.bytes, item)).toEqual(JSON.parse(canonicalNotebookContent(content)));
    expect((await raw(`/${saved.preparationId}/views/${item.viewId}`)).response.status).toBe(404);
  });

  it('isolates private full/list/options/UUID/bytes from a second account and other analyses', async () => {
    const input = await recipe(), saved = (await api('', { method: 'POST', body: input })).data;
    const other = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: crypto.randomUUID(), name: 'Another analysis' })).analysis;
    expect((await api(`/${saved.preparationId}`, {}, colleague)).status).toBe(404); expect((await api(`/requests/${input.requestId}`, {}, colleague)).status).toBe(404);
    expect((await api('', {}, colleague)).data.items).toEqual([]); expect((await api('/options?kind=results', {}, colleague)).data.items).toEqual([]);
    expect((await raw(`/${saved.preparationId}/views/${saved.package.results[0].viewId}`, colleague)).response.status).toBe(404);
    expect((await api(`/${saved.preparationId}`, {}, owner, other)).status).toBe(404);
    expect((await api('', { method: 'POST', body: { ...input, analysisId: other.id } }, owner, other)).status).toBe(409);
    expect((await api('', { method: 'POST', body: { ...input, requestId: crypto.randomUUID(), ownerUserId: colleague.user.id } }, colleague)).status).toBe(409);
  });

  it('replays original ready identity before writer/source checks and permits reader/archived deletion with a permanent tombstone', async () => {
    const input = await recipe(), saved = await service.prepare(owner.user.id, project.id, analysis.id, input);
    const source = (await db.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [input.results[0].reference.versionId])).rows[0]; await fs.unlink(provider.resolveKey(source.storage_key));
    await createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, status: 'archived' });
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    const replay = await api('', { method: 'POST', body: input }); expect(replay.status).toBe(200); expect(replay.data).toMatchObject({ preparationId: saved.preparationId, state: 'ready', canPrepare: false, canDelete: true, availability: { status: 'available' } });
    const removed = await api(`/${saved.preparationId}`, { method: 'DELETE', body: operation(saved) }); expect(removed.status).toBe(200);
    expect(removed.data).toMatchObject({ state: 'deleted', recipe: null, package: null, snapshotSha256: saved.snapshotSha256, canDelete: false });
    expect(await count('research_analysis_snapshot_blobs')).toBe(0); expect((await api()).data.items).toEqual([]);
    expect((await api('', { method: 'POST', body: input })).data.state).toBe('deleted'); expect((await api(`/requests/${input.requestId}`)).data.state).toBe('deleted');
    expect((await db.query('SELECT reserved_bytes FROM research_analysis_snapshot_preparations WHERE id=$1', [saved.preparationId])).rows[0].reserved_bytes).toBe('0');
  });

  it('does not let a caption correction actor retain another researcher’s source', async () => {
    const selected = await result();
    const corrected = await createAnalysisAttachmentService().correct(colleague.user.id, project.id, analysis.id, selected.revision.attachmentId, { requestId: crypto.randomUUID(), expectedHeadRevisionId: selected.revision.id, reference: selected.revision.reference, caption: 'Colleague context', suppliedOrigin: {} });
    const input = await recipe({ ownerUserId: colleague.user.id, results: [{ ...selected.selection, revisionId: corrected.acceptedRevision.id }] }, selected);
    expect((await api('', { method: 'POST', body: input }, colleague)).status).toBe(409); expect(await count('research_analysis_snapshot_preparations')).toBe(0);
  });

  it('keeps admission/ready UUIDs unique through actual lost COMMIT acknowledgements', async () => {
    const input = await recipe(); let commits = 0, lost = false;
    const wrapped = await wrappedDatabase(async (client, sql, values) => { const result = await client.query(sql, values); if (sql === 'COMMIT' && ++commits === 1) { lost = true; throw new Error('Synthetic actual committed admission ACK loss'); } return result; });
    await expect(createAnalysisSnapshotPreparationService(wrapped, provider).prepare(owner.user.id, project.id, analysis.id, input)).rejects.toThrow(/ACK loss/); expect(lost).toBe(true);
    const pending = await service.getByRequest(owner.user.id, project.id, analysis.id, input.requestId); expect(pending.state).toBe('preparing'); expect(await count('research_analysis_snapshot_blobs')).toBe(0);
    const resumed = await service.resume(owner.user.id, project.id, analysis.id, pending.preparationId, operation(pending)); expect(resumed.state).toBe('ready');
    expect((await service.prepare(owner.user.id, project.id, analysis.id, input)).preparationId).toBe(pending.preparationId); expect(await count('research_analysis_snapshot_preparations')).toBe(1);
  });

  it('atomically fences a builder after deletion without blob or quota resurrection', async () => {
    const input = await recipe(), paused = gate(), release = gate(); let holding = false;
    const blocked = { ...provider, openVerifiedRead: async (...args) => { if (!holding) { holding = true; paused.release(); await release.promise; } return provider.openVerifiedRead(...args); } };
    const building = createAnalysisSnapshotPreparationService(db, blocked).prepare(owner.user.id, project.id, analysis.id, input); await paused.promise;
    const pending = await service.getByRequest(owner.user.id, project.id, analysis.id, input.requestId); expect(pending.state).toBe('preparing');
    const removed = await service.remove(owner.user.id, project.id, analysis.id, pending.preparationId, operation(pending)); expect(removed.state).toBe('deleted'); release.release();
    expect((await building).state).toBe('deleted'); expect(await count('research_analysis_snapshot_blobs')).toBe(0);
    expect((await db.query('SELECT reserved_bytes FROM research_analysis_snapshot_preparations')).rows[0].reserved_bytes).toBe('0');
  });

  it('returns metadata-only options and stable private paging without source reads or Web grants', async () => {
    const selected = await result(), input = await recipe({}, selected); await service.prepare(owner.user.id, project.id, analysis.id, input);
    await service.prepare(owner.user.id, project.id, analysis.id, { ...input, requestId: crypto.randomUUID() });
    const denied = { ...provider, inspect: () => { throw new Error('No stat/hash on list'); }, openVerifiedRead: () => { throw new Error('No source reads on options'); } };
    const read = createAnalysisSnapshotPreparationService(db, denied), first = await read.list(owner.user.id, project.id, analysis.id, { limit: '1' });
    const second = await read.list(owner.user.id, project.id, analysis.id, { limit: '1', cursor: first.nextCursor }); expect(first.items[0].preparationId).not.toBe(second.items[0].preparationId); expect(second.nextCursor).toBeNull();
    const options = await read.options(owner.user.id, project.id, analysis.id, { kind: 'results' }); expect(options.items[0]).toMatchObject({ revisionId: selected.revision.id, integrity: 'not-checked', source: { format: { id: 'org.ietf.csv', version: '1' } } });
    expect(JSON.stringify(options)).not.toMatch(/storage_key|storageRef|sourceImport|provenance|relativePath/);
    expect((await read.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-versions' })).items[0].version).toBe(1);
  });

  it('retains failed originals/reservations after source loss and resumes only on explicit original action', async () => {
    const selected = await result(), input = await recipe({}, selected); let failed = false;
    const unavailable = { ...provider, openVerifiedRead: async (...args) => { if (!failed) { failed = true; const fault = new Error('Unavailable'); fault.code = 'STORAGE_OBJECT_MISSING'; throw fault; } return provider.openVerifiedRead(...args); } };
    const saved = await createAnalysisSnapshotPreparationService(db, unavailable).prepare(owner.user.id, project.id, analysis.id, input); expect(saved.state).toBe('failed');
    expect(saved.package).toBeNull(); expect(saved.failure.code).toMatch(/^ANALYSIS_SNAPSHOT_/); expect((await db.query('SELECT reserved_bytes FROM research_analysis_snapshot_preparations')).rows[0].reserved_bytes).toBe('16777216');
    expect((await service.getByRequest(owner.user.id, project.id, analysis.id, input.requestId)).state).toBe('failed'); expect(await count('research_analysis_snapshot_blobs')).toBe(0);
    const resumed = await service.resume(owner.user.id, project.id, analysis.id, saved.preparationId, operation(saved)); expect(resumed.state).toBe('ready');
  });

  it('applies the current schema twice without mutating exact accepted package/blob hashes or earlier intake schemas', async () => {
    const input = await recipe(), saved = await service.prepare(owner.user.id, project.id, analysis.id, input); await db.initSchema(); await db.initSchema();
    const recovered = await service.get(owner.user.id, project.id, analysis.id, saved.preparationId); expect(recovered.package).toEqual(saved.package); expect(recovered.snapshotSha256).toBe(saved.snapshotSha256);
    expect(recovered.availability.status).toBe('available'); expect((await db.query("SELECT schema_version FROM app_schema_contract WHERE schema_key='traceomics.runtime'")).rows[0].schema_version).toBe(20261032);
    expect(hash(canonicalSnapshotJson(recovered.package))).toBe(saved.snapshotSha256);
  });

  it.each(['ready', 'deleted'])('recovers actual committed %s acknowledgement loss without a second package or partial blobs', async stage => {
    const input = await recipe(); let written = false, lost = false;
    const wrapped = await wrappedDatabase(async (client, sql, values) => {
      const result = await client.query(sql, values);
      if (sql.includes(`SET state='${stage}'`)) written = true;
      if (sql === 'COMMIT' && written && !lost) { lost = true; throw new Error('Synthetic committed outcome ACK loss'); }
      return result;
    });
    const target = createAnalysisSnapshotPreparationService(wrapped, provider);
    if (stage === 'ready') await expect(target.prepare(owner.user.id, project.id, analysis.id, input)).rejects.toThrow(/ACK loss/);
    else {
      const ready = await service.prepare(owner.user.id, project.id, analysis.id, input);
      await expect(target.remove(owner.user.id, project.id, analysis.id, ready.preparationId, operation(ready))).rejects.toThrow(/ACK loss/);
    }
    expect(lost).toBe(true);
    const original = await service.getByRequest(owner.user.id, project.id, analysis.id, input.requestId); expect(original.state).toBe(stage);
    const replay = await service.prepare(owner.user.id, project.id, analysis.id, input); expect(replay.preparationId).toBe(original.preparationId); expect(replay.snapshotSha256).toBe(original.snapshotSha256);
    expect(await count('research_analysis_snapshot_preparations')).toBe(1); expect(await count('research_analysis_snapshot_blobs')).toBe(stage === 'ready' ? 1 : 0);
  });

  it('serializes concurrent same-UUID admission and rejects changed original fields without copying twice', async () => {
    const input = await recipe();
    const replies = await Promise.all([service.prepare(owner.user.id, project.id, analysis.id, input), service.prepare(owner.user.id, project.id, analysis.id, input), service.prepare(owner.user.id, project.id, analysis.id, input)]);
    expect(new Set(replies.map(item => item.preparationId)).size).toBe(1); expect(await count('research_analysis_snapshot_preparations')).toBe(1); expect(await count('research_analysis_snapshot_blobs')).toBe(1);
    expect((await service.getByRequest(owner.user.id, project.id, analysis.id, input.requestId)).state).toBe('ready');
    expect((await api('', { method: 'POST', body: { ...input, notes: { ...input.notes, summary: 'Changed frozen request' } } })).status).toBe(409);
  });

  it('keeps ready identity after real retained blob loss and never repairs or substitutes its source', async () => {
    const input = await recipe(), saved = await service.prepare(owner.user.id, project.id, analysis.id, input), viewId = saved.package.results[0].viewId;
    const client = await (await db.connect()).connect();
    try { await client.query('BEGIN'); await client.query("SET LOCAL app.demo_cleanup='on'"); await client.query('DELETE FROM research_analysis_snapshot_blobs WHERE preparation_id=$1', [saved.preparationId]); await client.query('COMMIT'); }
    finally { client.release(); }
    const observed = await service.get(owner.user.id, project.id, analysis.id, saved.preparationId);
    expect(observed).toMatchObject({ state: 'ready', snapshotSha256: saved.snapshotSha256, availability: { status: 'unavailable', views: [{ viewId, status: 'unavailable' }] } });
    expect((await raw(`/${saved.preparationId}/views/${viewId}`)).response.status).toBe(409);
    expect((await service.resume(owner.user.id, project.id, analysis.id, saved.preparationId, operation(saved))).snapshotSha256).toBe(saved.snapshotSha256);
    expect(await count('research_analysis_snapshot_blobs')).toBe(0);
  });

  it('allows archive while original bytes are being verified, then refuses final adoption under the new current state', async () => {
    const input = await recipe(), reached = gate(), release = gate(); let held = false;
    const blocked = { ...provider, openVerifiedRead: async (...args) => { if (!held) { held = true; reached.release(); await release.promise; } return provider.openVerifiedRead(...args); } };
    const pending = createAnalysisSnapshotPreparationService(db, blocked).prepare(owner.user.id, project.id, analysis.id, input); await reached.promise;
    try {
      await createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, status: 'archived' });
      expect((await db.query('SELECT status FROM research_analyses WHERE id=$1', [analysis.id])).rows[0].status).toBe('archived');
    } finally { release.release(); }
    const observed = await pending; expect(observed.state).toBe('failed'); expect(observed.canResume).toBe(false); expect(await count('research_analysis_snapshot_blobs')).toBe(0);
  });

  it('rejects final source metadata changes after a genuine verified read', async () => {
    const selected = await result(), input = await recipe({}, selected); let verified = false;
    const changed = await wrappedDatabase(async (client, sql, values) => {
      const response = await client.query(sql, values);
      return verified && sql.startsWith('SELECT * FROM managed_artifact_versions') ? { ...response, rows: response.rows.map(value => ({ ...value, name: 'Changed final metadata adapter' })) } : response;
    });
    const changing = { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args); verified = true; return opened; } };
    const prepared = await createAnalysisSnapshotPreparationService(changed, changing).prepare(owner.user.id, project.id, analysis.id, input);
    expect(prepared.state).toBe('failed'); expect(prepared.failure.code).toBe('ANALYSIS_SNAPSHOT_SOURCE_CHANGED'); expect(await count('research_analysis_snapshot_blobs')).toBe(0);
  });

  it('bounds live preparations across analyses and releases their capacity only through atomic deletion', async () => {
    const selected = await result(), input = await recipe({}, selected), accepted = [];
    for (let index = 0; index < 10; index++) accepted.push(await service.prepare(owner.user.id, project.id, analysis.id, { ...input, requestId: crypto.randomUUID() }));
    expect((await api('', { method: 'POST', body: { ...input, requestId: crypto.randomUUID() } })).status).toBe(409);
    const replay = await service.prepare(owner.user.id, project.id, analysis.id, accepted[0].recipe); expect(replay.preparationId).toBe(accepted[0].preparationId);
    await service.remove(owner.user.id, project.id, analysis.id, accepted[0].preparationId, operation(accepted[0]));
    expect((await service.prepare(owner.user.id, project.id, analysis.id, { ...input, requestId: crypto.randomUUID() })).state).toBe('ready');
    expect(await count('research_analysis_snapshot_preparations')).toBe(11);
  });

  it('keeps conservative failed reservations atomic at the owner byte bound', async () => {
    const selected = await result(), input = await recipe({}, selected);
    const original = (await db.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [selected.version.versionId])).rows[0]; await fs.unlink(provider.resolveKey(original.storage_key));
    const failed = [];
    for (let index = 0; index < 8; index++) failed.push(await service.prepare(owner.user.id, project.id, analysis.id, { ...input, requestId: crypto.randomUUID() }));
    expect(failed.every(item => item.state === 'failed')).toBe(true);
    expect((await api('', { method: 'POST', body: { ...input, requestId: crypto.randomUUID() } })).status).toBe(409);
    expect(Number((await db.query('SELECT SUM(reserved_bytes) AS n FROM research_analysis_snapshot_preparations')).rows[0].n)).toBe(128 * 1024 * 1024);
    await service.remove(owner.user.id, project.id, analysis.id, failed[0].preparationId, operation(failed[0]));
    expect((await service.prepare(owner.user.id, project.id, analysis.id, { ...input, requestId: crypto.randomUUID() })).state).toBe('failed');
  });

  it('honors the2000 durable UUID bound including deleted tombstones while replay still precedes the limit', async () => {
    const input = await recipe(), saved = await service.prepare(owner.user.id, project.id, analysis.id, input);
    await db.query(`INSERT INTO research_analysis_snapshot_preparations(id,service_id,project_id,analysis_id,analysis_version,owner_user_id,request_id,request_sha256,object_plan_json,state,reserved_bytes)
      SELECT 'asp_'||substr(md5(i::text),1,24),$1,$2,$3,1,$4,('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,repeat('a',64),'[]','deleted',0 FROM generate_series(1,1999) i`, [serviceId, project.id, analysis.id, owner.user.id]);
    expect((await api('', { method: 'POST', body: { ...input, requestId: crypto.randomUUID() } })).status).toBe(409);
    expect((await service.prepare(owner.user.id, project.id, analysis.id, input)).snapshotSha256).toBe(saved.snapshotSha256);
  });

  it('rejects oversized combined retained raster bytes without inserting a partially ready package', async () => {
    const png = PNG.sync.write(new PNG({ width: 32, height: 16 })), padded = Buffer.concat([png, Buffer.alloc(3500 * 1024)]), results = [];
    for (let index = 0; index < 5; index++) results.push((await result(`large-${index}.png`, padded)).selection);
    const prepared = await service.prepare(owner.user.id, project.id, analysis.id, await recipe({ results }, { selection: results[0] }));
    expect(prepared.state).toBe('failed'); expect(prepared.package).toBeNull(); expect(await count('research_analysis_snapshot_blobs')).toBe(0);
    expect(Number((await db.query('SELECT reserved_bytes FROM research_analysis_snapshot_preparations')).rows[0].reserved_bytes)).toBe(16 * 1024 * 1024);
  });

  it('protects original request, ready metadata and blob bytes from mutation outside the deletion transition', async () => {
    const saved = await service.prepare(owner.user.id, project.id, analysis.id, await recipe());
    await expect(db.query("UPDATE research_analysis_snapshot_preparations SET recipe_json='{}' WHERE id=$1", [saved.preparationId])).rejects.toMatchObject({ code: '55000' });
    await expect(db.query("UPDATE research_analysis_snapshot_preparations SET package_json='{}' WHERE id=$1", [saved.preparationId])).rejects.toMatchObject({ code: '55000' });
    await expect(db.query("UPDATE research_analysis_snapshot_blobs SET content=content WHERE preparation_id=$1", [saved.preparationId])).rejects.toMatchObject({ code: '55000' });
    await expect(db.query('DELETE FROM research_analysis_snapshot_blobs WHERE preparation_id=$1', [saved.preparationId])).rejects.toMatchObject({ code: '55000' });
    await service.remove(owner.user.id, project.id, analysis.id, saved.preparationId, operation(saved));
    await expect(db.query("UPDATE research_analysis_snapshot_preparations SET state='preparing' WHERE id=$1", [saved.preparationId])).rejects.toMatchObject({ code: '55000' });
  });

  it('distinguishes absent original requests from a newer scope denial after an authorized GET was committed and held', async () => {
    const input = await recipe(), ready = await service.prepare(owner.user.id, project.id, analysis.id, input);
    expect((await api(`/requests/${crypto.randomUUID()}`)).data.code).toBe('ANALYSIS_SNAPSHOT_PREPARATION_NOT_FOUND');
    const committed = gate(), release = gate(); let held = false;
    const wrapped = await wrappedDatabase(async (client, sql, values) => {
      const result = await client.query(sql, values);
      if (sql === 'COMMIT' && !held) { held = true; committed.release(); await release.promise; }
      return result;
    });
    const late = createAnalysisSnapshotPreparationService(wrapped, provider).get(owner.user.id, project.id, analysis.id, ready.preparationId); await committed.promise;
    await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, owner.user.id]);
    const denied = await api(`/requests/${input.requestId}`); expect(denied.status).toBe(404); expect(denied.data.code).toBe('ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND'); release.release();
    // This was authorized before revocation. The distinct newer denial tells
    // the client to fence this older response rather than infer UUID absence.
    expect((await late).snapshotSha256).toBe(ready.snapshotSha256);
    expect((await api(`/${ready.preparationId}`)).data.code).toBe('ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND');
    expect((await raw(`/${ready.preparationId}/views/${ready.package.results[0].viewId}`)).response.status).toBe(404);
  });

  it('matches the strict current client full/list/options contracts on real source-bearing replies', async () => {
    const input = await recipe(), saved = (await api('', { method: 'POST', body: input })).data;
    const scope = { serviceId, projectId: project.id, analysisId: analysis.id, userId: owner.user.id };
    expect(await validateSnapshotPreparation(saved, scope, input)).toEqual(saved);
    const listed = (await api()).data; expect(validateSnapshotPreparationList(listed, scope)).toEqual(listed);
    for (const kind of ['results', 'documents', 'analysis-versions']) {
      const options = (await api('/options?kind=' + kind)).data; expect(validateSnapshotPreparationOptions(options, scope, kind)).toEqual(options);
    }
    const removed = (await api(`/${saved.preparationId}`, { method: 'DELETE', body: operation(saved) })).data;
    expect(await validateSnapshotPreparation(removed, scope, input)).toEqual(removed);
  });

  it('keeps the project-wide reservation bound atomic across owners while another genuine build is paused', async () => {
    const input = await recipe(), otherOwners = [colleague.user.id];
    for (let index = 0; index < 3; index++) otherOwners.push((await http.createUserWithToken({ email: `quota-owner-${index}@example.test` })).user.id);
    // Historical failed reservations are inert accounting fixtures; they do not
    // grant source reads or represent newly executed scientific work.
    for (let index = 0; index < 31; index++) {
      const accountId = otherOwners[Math.floor(index / 8)], frozen = { ...input, ownerUserId: accountId, requestId: crypto.randomUUID() };
      await db.query(`INSERT INTO research_analysis_snapshot_preparations(id,service_id,project_id,analysis_id,analysis_version,owner_user_id,request_id,request_sha256,recipe_json,analysis_snapshot_json,object_plan_json,state,failure_json,reserved_bytes)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,'[]','failed',$10,16777216)`, ['asp_' + crypto.randomBytes(12).toString('hex'), serviceId, project.id, analysis.id, accountId,
        frozen.requestId, hash(canonicalAnalysisSnapshotPreparation(frozen)), frozen, { name: analysis.name }, { code: 'ANALYSIS_SNAPSHOT_BUILD_FAILED', message: 'Historical incomplete retained preparation.' }]);
    }
    const reached = gate(), release = gate(); let held = false;
    const blocked = { ...provider, openVerifiedRead: async (...args) => { if (!held) { held = true; reached.release(); await release.promise; } return provider.openVerifiedRead(...args); } };
    const pending = createAnalysisSnapshotPreparationService(db, blocked).prepare(owner.user.id, project.id, analysis.id, input); await reached.promise;
    try {
      expect(Number((await db.query('SELECT SUM(reserved_bytes) AS n FROM research_analysis_snapshot_preparations')).rows[0].n)).toBe(512 * 1024 * 1024);
      const denied = await api('', { method: 'POST', body: { ...input, requestId: crypto.randomUUID() } }); expect(denied.status).toBe(409); expect(denied.data.error).toMatch(/project.*capacity/i);
    } finally { release.release(); }
    expect((await pending).state).toBe('ready');
    expect(Number((await db.query('SELECT SUM(reserved_bytes) AS n FROM research_analysis_snapshot_preparations')).rows[0].n)).toBeLessThan(512 * 1024 * 1024);
  });

  it('disables fresh guest preparation and deletes an expired guest’s retained bytes without touching another project', async () => {
    const retained = await service.prepare(owner.user.id, project.id, analysis.id, await recipe()), originalScope = { owner, project, analysis };
    let guest, guestInput, guestPreparation;
    try {
      owner = await http.createUserWithToken({ email: 'later-expired-owner@example.test' });
      const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Disposable lab' });
      project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Disposable study' });
      analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: crypto.randomUUID(), name: 'Disposable analysis' })).analysis;
      guestInput = await recipe(); guestPreparation = await service.prepare(owner.user.id, project.id, analysis.id, guestInput); guest = { ...owner, project, analysis };
      await db.query("UPDATE users SET is_demo_guest=TRUE,expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1", [owner.user.id]);
      const denied = await api('', { method: 'POST', body: { ...guestInput, requestId: crypto.randomUUID() } }); expect(denied.status).toBe(403); expect(denied.data.code).toBe('ANALYSIS_SNAPSHOT_WRITE_REQUIRED');
      expect((await service.prepare(owner.user.id, project.id, analysis.id, guestInput)).snapshotSha256).toBe(guestPreparation.snapshotSha256);
    } finally { ({ owner, project, analysis } = originalScope); }
    await db.query("UPDATE users SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [guest.user.id]);
    expect(await db.deleteExpiredDemoGuest(guest.user.id)).toBe(true);
    expect((await db.query('SELECT id FROM research_analysis_snapshot_preparations WHERE project_id=$1', [guest.project.id])).rowCount).toBe(0);
    expect((await db.query('SELECT id FROM research_analysis_snapshot_blobs WHERE preparation_id=$1', [guestPreparation.preparationId])).rowCount).toBe(0);
    expect((await service.get(owner.user.id, project.id, analysis.id, retained.preparationId)).snapshotSha256).toBe(retained.snapshotSha256);
  });

  it('preserves legitimate historical codepoint text without applying new UTF16 note limits to saved captions', async () => {
    await createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, name: '🧬'.repeat(160), description: '🧬'.repeat(8000) });
    const selected = await result(), changed = await createAnalysisAttachmentService().correct(owner.user.id, project.id, analysis.id, selected.revision.attachmentId, {
      requestId: crypto.randomUUID(), expectedHeadRevisionId: selected.revision.id, reference: selected.revision.reference, caption: '🧬'.repeat(2000), suppliedOrigin: { origin: '🧬'.repeat(2000) } });
    const input = await recipe({ analysisVersion: 2, results: [{ ...selected.selection, revisionId: changed.acceptedRevision.id }] }, selected);
    const response = await api('', { method: 'POST', body: input }); expect(response.status).toBe(201); expect(response.data.state).toBe('ready');
    expect(response.data.package.analysis.description).toBe('🧬'.repeat(8000)); expect(response.data.package.results[0].attachment.caption).toBe('🧬'.repeat(2000));
    expect(await validateSnapshotPreparation(response.data, { serviceId, projectId: project.id, analysisId: analysis.id, userId: owner.user.id }, input)).toEqual(response.data);
  });

  it('rejects malformed, array and cross-analysis paging cursors without treating them as current access denial', async () => {
    const input = await recipe(); await service.prepare(owner.user.id, project.id, analysis.id, input); await service.prepare(owner.user.id, project.id, analysis.id, { ...input, requestId: crypto.randomUUID() });
    const page = await service.list(owner.user.id, project.id, analysis.id, { limit: 1 });
    const other = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: crypto.randomUUID(), name: 'Another cursor scope' })).analysis;
    const crossed = await api('?limit=1&cursor=' + page.nextCursor, {}, owner, other); expect(crossed.status).toBe(400); expect(crossed.data.code).toBe('ANALYSIS_SNAPSHOT_INVALID_PAGE');
    for (const suffix of ['?limit[]=1', '?cursor=bad-json', '/options?kind=results&limit[]=1', '/options?kind=wrong']) expect((await api(suffix)).status).toBe(400);
  });

  it('reserves two builder slots before held pool acquisition and leaves a third explicit resume safely incomplete', async () => {
    const selected = await result(), pending = [];
    for (let index = 0; index < 3; index++) {
      const input = await recipe({}, selected); let lost = false;
      const interrupted = await wrappedDatabase(async (client, sql, values) => {
        const result = await client.query(sql, values);
        if (sql === 'COMMIT' && !lost) { lost = true; throw new Error('Committed admission without builder'); }
        return result;
      });
      await expect(createAnalysisSnapshotPreparationService(interrupted, provider).prepare(owner.user.id, project.id, analysis.id, input)).rejects.toThrow(/without builder/);
      pending.push(await service.getByRequest(owner.user.id, project.id, analysis.id, input.requestId));
    }
    const pool = await db.connect(), holders = await Promise.all(Array.from({ length: pool.options.max }, () => pool.connect()));
    const release = gate(), firstOperations = gate(); let commits = 0, opens = 0;
    const wrapped = await wrappedDatabase(async (client, sql, values) => {
      const result = await client.query(sql, values);
      if (sql === 'COMMIT' && ++commits === 3) firstOperations.release();
      return result;
    });
    const blocked = { ...provider, openVerifiedRead: async (...args) => { opens++; await release.promise; return provider.openVerifiedRead(...args); } };
    const target = createAnalysisSnapshotPreparationService(wrapped, blocked), tasks = pending.map(value => target.resume(owner.user.id, project.id, analysis.id, value.preparationId, operation(value)));
    let timeout, early;
    const bounded = promise => Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The held pool did not preserve the two-builder bound.')), 4000); })]).finally(() => clearTimeout(timeout));
    try {
      while (pool.waitingCount < 3) await new Promise(resolve => setImmediate(resolve));
      holders.pop().release();
      // One available connection first serves the three operation transactions;
      // their builder acquisitions then queue behind genuinely held pool slots.
      await bounded(firstOperations.promise);
      for (let index = 0; index < 3; index++) holders.pop().release();
      early = await bounded(Promise.any(tasks)); expect(early.state).toBe('preparing');
      expect(opens).toBeLessThanOrEqual(2);
    } finally {
      release.release(); for (const held of holders) held.release(); await Promise.allSettled(tasks);
    }
    expect(opens).toBe(2);
    expect(await count('research_analysis_snapshot_blobs')).toBe(2);
    const remaining = await service.get(owner.user.id, project.id, analysis.id, early.preparationId); expect(remaining.state).toBe('preparing');
    expect((await service.resume(owner.user.id, project.id, analysis.id, remaining.preparationId, operation(remaining))).state).toBe('ready');
    expect(await count('research_analysis_snapshot_blobs')).toBe(3);
  });

  it('discovers eligible older result revisions after a whole newer metadata page is rejected', async () => {
    const oldest = await result('older.csv'), middle = await result('middle.csv'), newer = await result('newer.csv');
    const client = await (await db.connect()).connect();
    try {
      await client.query('BEGIN'); await client.query('ALTER TABLE managed_artifact_versions DISABLE TRIGGER trg_managed_artifact_version_immutable');
      await client.query("UPDATE managed_artifact_versions SET artifact_id='invalid-'||id WHERE id=ANY($1::text[])", [[middle.version.versionId, newer.version.versionId]]);
      await client.query('ALTER TABLE managed_artifact_versions ENABLE TRIGGER trg_managed_artifact_version_immutable'); await client.query('COMMIT');
    } catch (failure) { await client.query('ROLLBACK'); throw failure; } finally { client.release(); }
    const options = await service.options(owner.user.id, project.id, analysis.id, { kind: 'results', limit: 1 });
    expect(options.items.map(item => item.revisionId)).toEqual([oldest.revision.id]); expect(options.nextCursor).toBeNull();
    expect(validateSnapshotPreparationOptions(options, { serviceId, projectId: project.id, analysisId: analysis.id, userId: owner.user.id }, 'results')).toEqual(options);
  });

  it('refuses to freeze a CSV changed in place after its original hash, including a restored modification time', async () => {
    const selected = await result(), input = await recipe({}, selected), reached = gate(), release = gate(); let held = false;
    const key = (await db.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [selected.version.versionId])).rows[0].storage_key;
    const location = provider.resolveKey(key), before = await fs.stat(location);
    const blocked = { ...provider, openVerifiedRead: async (...args) => {
      const opened = await provider.openVerifiedRead(...args), handle = opened.handle;
      return { ...opened, handle: { read: async (...readArgs) => { if (!held) { held = true; reached.release(); await release.promise; } return handle.read(...readArgs); },
        stat: () => handle.stat(), close: () => handle.close() } };
    } };
    const pending = createAnalysisSnapshotPreparationService(db, blocked).prepare(owner.user.id, project.id, analysis.id, input); await reached.promise;
    try { await fs.writeFile(location, csv.toString().replace('treated,19', 'treated,99')); await fs.utimes(location, before.atime, before.mtime); }
    finally { release.release(); }
    const observed = await pending; expect(observed.state).toBe('failed'); expect(observed.package).toBeNull(); expect(await count('research_analysis_snapshot_blobs')).toBe(0);
  });
});
