import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import { canonicalAnalysisSnapshotPackage, canonicalAnalysisSnapshotPreparation } from '../shared/analysisSnapshotPreparationDispatch.mjs';
import { canonicalAnalysisSnapshotTypedDescriptor } from '../shared/analysisSnapshotTypedResult.mjs';
import { validateSnapshotPreparation, validateSnapshotPreparationOptions, decodeSnapshotPreparationTable, decodeSnapshotPreparationTyped } from '../src/analyses/snapshotPreparationValidation.js';
import { validateSnapshotPublicationReceipt } from '../src/analyses/snapshotPublicationValidation.js';
const db = require('./pgDatabase'), storage = require('./storage');
const { createResearchAnalysisService } = require('./researchAnalyses');
const { createArtifactVersionService } = require('./artifactVersions');
const { createAnalysisAttachmentService } = require('./analysisAttachments');
const { createAnalysisSnapshotPreparationService } = require('./analysisSnapshotPreparations');
const { createAnalysisSnapshotPublicationService } = require('./analysisSnapshotPublications');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

describe.skipIf(!process.env.DATABASE_URL)('exact direct typed retained findings', () => {
  let directory, provider, preparations, publications, owner, colleague, project, analysis, serviceId, settings, http, server;
  beforeAll(async () => {
    settings = Object.fromEntries(['STORAGE_ROOT', 'VAULT_ROOT', 'APP_DEPLOYMENT_MODE'].map(key => [key, process.env[key]]));
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'traceomics-typed-snapshots-'));
    Object.assign(process.env, { STORAGE_ROOT: path.join(directory, 'storage'), VAULT_ROOT: path.join(directory, 'private'), APP_DEPLOYMENT_MODE: 'private' });
    await fs.mkdir(process.env.STORAGE_ROOT); provider = storage.createLocalStorageProvider(); http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    await db.resetSchemaForTests();
    owner = await http.createUserWithToken({ email: 'typed-owner@example.test' }); colleague = await http.createUserWithToken({ email: 'typed-colleague@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Typed result lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Typed result study' }); await db.addProjectMember(project.id, colleague.user.id, 'analyst');
    analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: crypto.randomUUID(), name: 'Exact typed findings' })).analysis;
    serviceId = (await db.getServiceExecutionIdentity()).id; preparations = createAnalysisSnapshotPreparationService(db, provider); publications = createAnalysisSnapshotPublicationService();
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve)); await db.close();
    for (const [key, value] of Object.entries(settings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = () => `/api/projects/${project.id}/analyses/${analysis.id}/snapshot-preparations`;
  const api = (suffix = '', options = {}, actor = owner) => http.api(server, base() + suffix, { token: actor.token, ...options });
  const scope = () => ({ serviceId, projectId: project.id, analysisId: analysis.id, userId: owner.user.id });
  const operation = saved => ({ requestId: saved.requestId, requestSha256: saved.requestSha256 });
  async function pin(references, actor = owner) {
    analysis = (await createResearchAnalysisService().patch(actor.user.id, project.id, analysis.id, { expectedVersion: analysis.version, references })).analysis;
    return analysis.version;
  }
  async function source(type = 'table', options = {}) {
    const actor = options.actor || owner;
    const bytes = options.bytes || (type === 'figure' ? PNG.sync.write(new PNG({ width: 24, height: 12 })) : Buffer.from(JSON.stringify(type === 'metrics'
      ? { cells: 12, fraction: 0.125, called: false, missing: null, label: 'χ' }
      : [{ gene: 'A', cells: 0, called: false, missing: null, label: '' }, { gene: 'B', cells: 19, called: true, missing: 'null', label: 'χ' }, { gene: 'C', cells: 23, called: false, missing: null, label: 'γ' }])));
    const id = db.genId('eri'), key = storage.projectStorageFileKey(project.id, 'artifacts', id, type === 'figure' ? 'figure.png' : 'content.json');
    await fs.writeFile(provider.prepareWrite(key), bytes);
    const job = await db.createProjectJob(actor.user.id, project.id, { jobType: 'generic' });
    await db.updateJobStatusForUser(actor.user.id, job.id, 'running'); await db.updateJobStatusForUser(actor.user.id, job.id, 'completed');
    const descriptor = { id, type, sha256: hash(bytes), sizeBytes: bytes.length, profileId: 'recorded-r-profile', semantics: options.semantics || (type === 'metrics'
      ? { role: 'diagnostic', title: 'Recorded scalar metrics', metrics: { cells: { label: 'Cell count', unit: 'cells' }, fraction: { label: 'Fraction', unit: null } } }
      : { role: 'primary', title: 'Recorded typed finding' }) };
    await db.query('INSERT INTO workflow_artifacts(id,owner_user_id,project_id,job_id,descriptor_json,storage_key) VALUES($1,$2,$3,$4,$5,$6)', [id, actor.user.id, project.id, job.id, descriptor, key]);
    return { reference: { kind: 'artifact-version', versionId: id, sha256: hash(bytes) }, bytes, key, descriptor };
  }
  async function selected(item, view = null) {
    const choices = await preparations.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-typed-references', analysisVersion: analysis.version });
    const choice = choices.items.find(value => value.reference.versionId === item.reference.versionId);
    return { kind: 'typed-analysis-reference', reference: item.reference, descriptorSha256: choice.descriptorSha256, caption: 'Supplied typed caption',
      view: view || (item.descriptor.type === 'table' ? { family: 'table', offset: 0, limit: 2 } : { family: item.descriptor.type === 'figure' ? 'image' : 'metrics' }) };
  }
  const recipe = (results, change = {}) => ({ schema: 'traceomics.analysis-snapshot-preparation.v2', requestId: crypto.randomUUID(), serviceId, projectId: project.id, analysisId: analysis.id,
    ownerUserId: owner.user.id, analysisVersion: analysis.version, results, documents: [], notes: { summary: 'Deliberately selected typed findings', decisions: null, limitations: null }, prerequisites: [], ...change });
  async function wrappedDatabase(intercept) {
    const pool = await db.connect(); return { ...db, connect: async () => ({ connect: async () => {
      const client = await pool.connect(); return { query: (sql, values) => intercept(client, sql, values), release: destroy => client.release(destroy) };
    } }) };
  }

  it.each(['table', 'metrics', 'figure'])('retains actual %s meaning and checked bytes, then serves only fixed findings to a colleague', async type => {
    const item = await source(type); await pin([item.reference]); const input = recipe([await selected(item)]);
    const reply = await api('', { method: 'POST', body: input }); expect(reply.status).toBe(201); const saved = reply.data;
    expect(saved.state).toBe('ready'); expect(saved.requestSha256).toBe(hash(canonicalAnalysisSnapshotPreparation(input)));
    expect(saved.snapshotSha256).toBe(hash(canonicalAnalysisSnapshotPackage(saved.package)));
    expect(await validateSnapshotPreparation(saved, scope(), input)).toEqual(saved);
    const result = saved.package.results[0]; expect(result.view).toMatchObject({ schema: 'traceomics.fixed-result-view.v3', descriptorSha256: input.results[0].descriptorSha256 });
    expect(result.view.semantics.title).toBe(item.descriptor.semantics.title);
    const raw = await fetch(`http://127.0.0.1:${server.address().port}${base()}/${saved.preparationId}/views/${result.viewId}`, { headers: { Cookie: `${require('./config').sessionCookieName()}=${owner.token}` } });
    const bytes = Buffer.from(await raw.arrayBuffer()); expect(raw.status).toBe(200); expect(hash(bytes)).toBe(result.view.blobSha256);
    expect(raw.headers.get('content-type')).toBe(type === 'figure' ? 'image/png' : 'application/json; charset=utf-8');
    if (type === 'figure') expect(bytes).toEqual(item.bytes);
    else {
      const body = await decodeSnapshotPreparationTyped(bytes, result);
      if (type === 'table') { expect(body.rows[0]).toEqual(['A', 0, false, null, '']); expect(body.totalRows).toBe(3); expect(body.hasMore).toBe(true); expect(await decodeSnapshotPreparationTable(bytes, result)).toEqual(body); }
      else expect(body.items[0]).toEqual({ key: 'cells', value: 12, label: 'Cell count', unit: 'cells' });
    }
    const action = { requestId: crypto.randomUUID(), serviceId, projectId: project.id, analysisId: analysis.id, ownerUserId: owner.user.id, preparationId: saved.preparationId, snapshotSha256: saved.snapshotSha256 };
    const accepted = await publications.publish(owner.user.id, project.id, analysis.id, action), receipt = { ...accepted }; delete receipt.created;
    expect(await validateSnapshotPublicationReceipt(receipt, scope(), { action: 'publish', ...action })).toEqual(receipt);
    const publishedId = accepted.acceptance.publicationId;
    await fs.unlink(provider.resolveKey(item.key));
    expect((await publications.get(colleague.user.id, project.id, analysis.id, publishedId)).snapshotSha256).toBe(saved.snapshotSha256);
    const finding = await publications.readBlob(colleague.user.id, project.id, analysis.id, publishedId, result.viewId, 'result');
    expect(finding.bytes).toEqual(bytes); expect(finding.mimeType).toBe(type === 'figure' ? 'image/png' : 'application/json; charset=utf-8');
    await expect(createArtifactVersionService(db, provider).get(colleague.user.id, project.id, item.reference.versionId)).rejects.toMatchObject({ code: 'ARTIFACT_VERSION_NOT_FOUND' });
    await preparations.remove(owner.user.id, project.id, analysis.id, saved.preparationId, operation(saved));
    expect((await publications.readBlob(colleague.user.id, project.id, analysis.id, publishedId, result.viewId, 'result')).bytes).toEqual(bytes);
    await publications.withdraw(owner.user.id, project.id, analysis.id, { requestId: crypto.randomUUID(), serviceId, projectId: project.id, analysisId: analysis.id, ownerUserId: owner.user.id, publicationId: publishedId, snapshotSha256: saved.snapshotSha256 });
    await expect(publications.readBlob(colleague.user.id, project.id, analysis.id, publishedId, result.viewId, 'result')).rejects.toThrow();
    expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
  });

  it('keeps typed options metadata-only, independently hashable, eligible-only and version/account/cursor scoped', async () => {
    const first = await source(), hidden = await source('table', { actor: colleague }), second = await source('metrics');
    await pin([first.reference, second.reference]); await pin([hidden.reference, first.reference, second.reference], colleague); const version = analysis.version;
    const guarded = { ...provider, openVerifiedRead: () => { throw new Error('No source I/O on chooser.'); } }, target = createAnalysisSnapshotPreparationService(db, guarded);
    const page = await target.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-typed-references', analysisVersion: version, limit: 1 });
    expect(page.items).toHaveLength(1); expect(page.items[0].reference).toEqual(first.reference);
    expect(page.items[0].descriptorSha256).toBe(hash(canonicalAnalysisSnapshotTypedDescriptor(page.items[0].descriptor)));
    expect(await validateSnapshotPreparationOptions(page, scope(), 'analysis-typed-references', version)).toEqual(page);
    const next = await target.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-typed-references', analysisVersion: version, limit: 1, cursor: page.nextCursor });
    expect(next.items[0].reference).toEqual(second.reference); expect(next.nextCursor).toBeNull();
    expect(JSON.stringify(page)).not.toMatch(/storage_key|storageKey|sourceImport|private|environment|jobId/);
    const foreignDescriptor = { schema: 'traceomics.retained-output-descriptor.v1', ...hidden.descriptor };
    const foreignSelection = { kind: 'typed-analysis-reference', reference: hidden.reference, descriptorSha256: hash(canonicalAnalysisSnapshotTypedDescriptor(foreignDescriptor)), caption: 'Known expected identity is no grant', view: { family: 'table', offset: 0, limit: 1 } };
    await expect(target.prepare(owner.user.id, project.id, analysis.id, recipe([foreignSelection]))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_CHANGED' });
    expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_preparations')).rows[0].n).toBe('0');
    for (const actor of [colleague]) await expect(target.options(actor.user.id, project.id, analysis.id, { kind: 'analysis-typed-references', analysisVersion: version, cursor: page.nextCursor })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_INVALID_PAGE' });
    await pin([second.reference]);
    await expect(target.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-typed-references', analysisVersion: analysis.version, cursor: page.nextCursor })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_INVALID_PAGE' });
    expect((await api('/options?kind=analysis-typed-references')).status).toBe(400);
  });

  it('does not infer typed metrics from an arbitrary owned JSON body or client-supplied descriptor', async () => {
    const file = path.join(directory, crypto.randomUUID() + '.json'); await fs.writeFile(file, '{"cells":12}');
    const version = await createArtifactVersionService(db, provider).importFile(owner.user.id, project.id, { path: file, originalFilename: 'ordinary.json', name: 'Ordinary JSON' });
    const reference = { kind: 'artifact-version', versionId: version.versionId, sha256: version.sha256 }; await pin([reference]);
    const options = await preparations.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-typed-references', analysisVersion: analysis.version }); expect(options.items).toEqual([]);
    const descriptor = { schema: 'traceomics.retained-output-descriptor.v1', id: version.versionId, type: 'metrics', sha256: version.sha256, sizeBytes: version.sizeBytes, profileId: null, semantics: {} };
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, recipe([{ kind: 'typed-analysis-reference', reference,
      descriptorSha256: hash(canonicalAnalysisSnapshotTypedDescriptor(descriptor)), caption: 'Cannot declare authority from the client', view: { family: 'metrics' } }]))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_CHANGED' });
    expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_preparations')).rows[0].n).toBe('0');
  });

  it('binds the exact selected old analysis revision and rejects changed descriptor intent before admission or source reads', async () => {
    const item = await source(); await pin([item.reference]); const version = analysis.version, choice = await selected(item); await pin([]);
    expect((await preparations.prepare(owner.user.id, project.id, analysis.id, recipe([choice], { analysisVersion: version }))).state).toBe('ready');
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, recipe([choice]))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE' });
    await db.query("UPDATE workflow_artifacts SET descriptor_json=jsonb_set(descriptor_json,'{semantics,title}','\"Changed declared meaning\"') WHERE id=$1", [item.reference.versionId]);
    let opens = 0; const target = createAnalysisSnapshotPreparationService(db, { ...provider, openVerifiedRead: (...args) => { opens++; return provider.openVerifiedRead(...args); } });
    await expect(target.prepare(owner.user.id, project.id, analysis.id, recipe([choice], { analysisVersion: version }))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_CHANGED' });
    expect(opens).toBe(0); expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_preparations')).rows[0].n).toBe('1');
  });

  it('groups distinct fixed excerpts of one verified typed table and retains an empty table without invented columns', async () => {
    const item = await source(), empty = await source('table', { bytes: Buffer.from('[]') }); await pin([item.reference, empty.reference]);
    const first = await selected(item), second = await selected(item, { family: 'table', offset: 2, limit: 1 }); let opens = 0;
    const target = createAnalysisSnapshotPreparationService(db, { ...provider, openVerifiedRead: (...args) => { opens++; return provider.openVerifiedRead(...args); } });
    const saved = await target.prepare(owner.user.id, project.id, analysis.id, recipe([first, second, await selected(empty)])); expect(saved.state).toBe('ready'); expect(opens).toBe(2);
    const last = saved.package.results[2], raw = await target.readBlob(owner.user.id, project.id, analysis.id, saved.preparationId, last.viewId, 'result');
    expect(await decodeSnapshotPreparationTable(raw.bytes, last)).toMatchObject({ columns: [], rows: [], totalRows: 0, hasMore: false });
    const excerpt = saved.package.results[1], bytes = (await target.readBlob(owner.user.id, project.id, analysis.id, saved.preparationId, excerpt.viewId, 'result')).bytes;
    expect((await decodeSnapshotPreparationTable(bytes, excerpt)).rows[0][0]).toBe('C');
  });

  it('retains raw numeric-looking column order and mixes typed, C1 and original literal preparation branches', async () => {
    const item = await source('table', { bytes: Buffer.from('[{"2":0,"1":false,"gene":null},{"2":1,"1":true,"gene":"A"}]') });
    const file = path.join(directory, crypto.randomUUID() + '.csv'); await fs.writeFile(file, 'gene,value\nA,2\nB,3\n');
    const flat = await createArtifactVersionService(db, provider).importFile(owner.user.id, project.id, { path: file, originalFilename: 'flat.csv', name: 'Flat finding' });
    const reference = { kind: 'artifact-version', versionId: flat.versionId, sha256: flat.sha256 }; await pin([reference, item.reference]);
    const attached = (await createAnalysisAttachmentService(db, provider).create(owner.user.id, project.id, analysis.id, { requestId: crypto.randomUUID(), reference, caption: 'Original literal context', suppliedOrigin: {} })).acceptedRevision;
    const legacy = recipe([{ attachmentId: attached.attachmentId, revisionId: attached.id, reference, view: { family: 'table', offset: 0, limit: 1 } }]); delete legacy.schema;
    const old = await preparations.prepare(owner.user.id, project.id, analysis.id, legacy);
    const input = recipe([{ kind: 'analysis-reference', reference, caption: 'Existing C1 context', view: { family: 'table', offset: 0, limit: 1 } }, await selected(item)]);
    const saved = await preparations.prepare(owner.user.id, project.id, analysis.id, input); expect(saved.state).toBe('ready');
    const response = { ...saved }; delete response.created; expect(await validateSnapshotPreparation(response, scope(), input)).toEqual(response);
    const result = saved.package.results[1], bytes = (await preparations.readBlob(owner.user.id, project.id, analysis.id, saved.preparationId, result.viewId, 'result')).bytes;
    const body = await decodeSnapshotPreparationTyped(bytes, result); expect(body.columns).toEqual(['2', '1', 'gene']); expect(body.rows[0]).toEqual([0, false, null]);
    expect(saved.package.results[0].view.schema).toBe('traceomics.fixed-result-view.v2');
    expect((await preparations.getByRequest(owner.user.id, project.id, analysis.id, legacy.requestId)).snapshotSha256).toBe(old.snapshotSha256);
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, { ...input, requestId: legacy.requestId })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_REQUEST_CONFLICT' });
  });

  it('fails invalid UTF-8 as a recoverable original failed preparation without publishing a replacement', async () => {
    const item = await source('metrics', { bytes: Buffer.from([123, 34, 110, 34, 58, 34, 255, 34, 125]) });
    const saved = await preparations.prepare(owner.user.id, project.id, analysis.id, recipe([await selectedAfterPin(item)]));
    expect(saved.state).toBe('failed'); expect(saved.canResume).toBe(true); expect(saved.package).toBeNull();
    expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
  });

  it('holds the current typed descriptor through the final ready transaction, without holding it during source I/O', async () => {
    const item = await source('metrics'), input = recipe([await selectedAfterPin(item)]); let readerClosed = false, lockChecked = false;
    const tracking = { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args), close = opened.handle.close.bind(opened.handle);
      opened.handle.close = async () => { await close(); readerClosed = true; }; return opened; } };
    const wrapped = await wrappedDatabase(async (client, sql, values) => {
      const result = await client.query(sql, values);
      if (readerClosed && !lockChecked && sql.startsWith('SELECT * FROM workflow_artifacts') && sql.endsWith(' FOR SHARE')) {
        lockChecked = true; const competing = await (await db.connect()).connect();
        try {
          await competing.query('BEGIN'); await competing.query("SET LOCAL lock_timeout='100ms'");
          await expect(competing.query("UPDATE workflow_artifacts SET descriptor_json=jsonb_set(descriptor_json,'{semantics,title}','\"Concurrent final change\"') WHERE id=$1", [item.reference.versionId])).rejects.toMatchObject({ code: '55P03' });
        } finally { await competing.query('ROLLBACK'); competing.release(); }
      }
      return result;
    });
    const saved = await createAnalysisSnapshotPreparationService(wrapped, tracking).prepare(owner.user.id, project.id, analysis.id, input);
    expect(saved.state).toBe('ready'); expect(lockChecked).toBe(true); expect(saved.package.results[0].view.descriptorSha256).toBe(input.results[0].descriptorSha256);
  });

  it.each(['[{"n":9007199254740993}]', '[{"n":1e400}]', '[{"n":1e-4000}]', '[{"n":-0}]', '[{"n":1,"n":2}]', '[{"n":{"nested":1}}]', '[{"n":1},{"other":2}]'])('keeps unsafe scalar source %s failed without silently freezing altered values', async text => {
    const item = await source('table', { bytes: Buffer.from(text) }); await pin([item.reference]);
    const input = recipe([await selected(item)]), saved = await preparations.prepare(owner.user.id, project.id, analysis.id, input);
    expect(saved.state).toBe('failed'); expect(saved.package).toBeNull(); expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
    expect((await preparations.getByRequest(owner.user.id, project.id, analysis.id, input.requestId)).requestSha256).toBe(saved.requestSha256);
  });

  it('rejects actual descriptor mutation while verified source bytes are held and allows no final adoption', async () => {
    const item = await source('metrics'); await pin([item.reference]); const input = recipe([await selected(item)]), reached = gate(), release = gate(); let held = false;
    const blocked = { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args); if (!held) { held = true; reached.release(); await release.promise; } return opened; } };
    const pending = createAnalysisSnapshotPreparationService(db, blocked).prepare(owner.user.id, project.id, analysis.id, input); await reached.promise;
    try { await db.query("UPDATE workflow_artifacts SET descriptor_json=jsonb_set(descriptor_json,'{semantics,title}','\"Changed during verified read\"') WHERE id=$1", [item.reference.versionId]); }
    finally { release.release(); }
    expect((await pending).state).toBe('failed'); expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
  });

  it('detects same-FD byte mutation after original hash and rechecks final descriptor after the checked reader closes', async () => {
    const item = await source(), choice = await selectedAfterPin(item); let changed = false;
    const corrupting = { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args); if (!changed) { changed = true; await fs.writeFile(provider.resolveKey(item.key), Buffer.from(item.bytes.toString().replace('19', '91'))); } return opened; } };
    const bad = await createAnalysisSnapshotPreparationService(db, corrupting).prepare(owner.user.id, project.id, analysis.id, recipe([choice])); expect(bad.state).toBe('failed');
    await fs.writeFile(provider.resolveKey(item.key), item.bytes); let closed = false;
    const changing = { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args), close = opened.handle.close.bind(opened.handle);
      opened.handle.close = async () => { await close(); if (!closed) { closed = true; await db.query("UPDATE workflow_artifacts SET descriptor_json=jsonb_set(descriptor_json,'{semantics,title}','\"Changed after checked projection\"') WHERE id=$1", [item.reference.versionId]); } }; return opened; } };
    const final = await createAnalysisSnapshotPreparationService(db, changing).prepare(owner.user.id, project.id, analysis.id, recipe([choice])); expect(final.state).toBe('failed');
    expect(final.failure.code).toBe('ANALYSIS_SNAPSHOT_SOURCE_CHANGED'); expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
  });
  async function selectedAfterPin(item) { await pin([item.reference]); return selected(item); }

  it('replays actual committed ready ACK loss before writer/source checks and preserves schema32 and shared UUID identity', async () => {
    const item = await source('metrics'), choice = await selectedAfterPin(item), input = recipe([choice]); let ready = false, lost = false;
    const wrapped = await wrappedDatabase(async (client, sql, values) => { const result = await client.query(sql, values); if (sql.includes("SET state='ready'")) ready = true;
      if (sql === 'COMMIT' && ready && !lost) { lost = true; throw new Error('Actual typed ready COMMIT acknowledgement lost'); } return result; });
    await expect(createAnalysisSnapshotPreparationService(wrapped, provider).prepare(owner.user.id, project.id, analysis.id, input)).rejects.toThrow(/acknowledgement lost/);
    const saved = await preparations.getByRequest(owner.user.id, project.id, analysis.id, input.requestId); expect(saved.state).toBe('ready');
    await fs.unlink(provider.resolveKey(item.key)); await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    expect(await preparations.prepare(owner.user.id, project.id, analysis.id, input)).toMatchObject({ preparationId: saved.preparationId, snapshotSha256: saved.snapshotSha256, canPrepare: false });
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, { ...input, notes: { ...input.notes, summary: 'Changed frozen request' } })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_REQUEST_CONFLICT' });
    await db.initSchema(); await db.initSchema(); expect((await preparations.get(owner.user.id, project.id, analysis.id, saved.preparationId)).availability.status).toBe('available');
    expect((await db.query("SELECT schema_version FROM app_schema_contract WHERE schema_key='traceomics.runtime'")).rows[0].schema_version).toBe(20261032);
  });

  it('fences a held typed builder on private delete and current writer downgrade without quota resurrection', async () => {
    const item = await source(), input = recipe([await selectedAfterPin(item)]), reached = gate(), release = gate(); let holding = false;
    const blocked = { ...provider, openVerifiedRead: async (...args) => { if (!holding) { holding = true; reached.release(); await release.promise; } return provider.openVerifiedRead(...args); } };
    const pending = createAnalysisSnapshotPreparationService(db, blocked).prepare(owner.user.id, project.id, analysis.id, input); await reached.promise;
    const saved = await preparations.getByRequest(owner.user.id, project.id, analysis.id, input.requestId);
    await preparations.remove(owner.user.id, project.id, analysis.id, saved.preparationId, operation(saved)); release.release();
    expect((await pending).state).toBe('deleted'); expect((await db.query('SELECT SUM(reserved_bytes) AS bytes FROM research_analysis_snapshot_preparations')).rows[0].bytes).toBe('0');
    const next = recipe([input.results[0]]); holding = false; const reachedAgain = gate(), releaseAgain = gate();
    const downgrade = { ...provider, openVerifiedRead: async (...args) => { if (!holding) { holding = true; reachedAgain.release(); await releaseAgain.promise; } return provider.openVerifiedRead(...args); } };
    const building = createAnalysisSnapshotPreparationService(db, downgrade).prepare(owner.user.id, project.id, analysis.id, next); await reachedAgain.promise;
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]); releaseAgain.release();
    expect((await building).state).toBe('failed'); expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
  });
});
