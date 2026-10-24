import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalAnalysisSnapshotPackage, canonicalAnalysisSnapshotPreparation } from '../shared/analysisSnapshotPreparationDispatch.mjs';
import { validateSnapshotPreparation, validateSnapshotPreparationOptions, decodeSnapshotPreparationInert } from '../src/analyses/snapshotPreparationValidation.js';
import { validateSnapshotPublication, validateSnapshotPublicationReceipt } from '../src/analyses/snapshotPublicationValidation.js';
const db = require('./pgDatabase'), storage = require('./storage');
const { allocateExpertRInputStorageKey } = require('./expertR');
const { createResearchAnalysisService } = require('./researchAnalyses');
const { createArtifactVersionService } = require('./artifactVersions');
const { createAnalysisSnapshotPreparationService } = require('./analysisSnapshotPreparations');
const { createAnalysisSnapshotPublicationService, projectSnapshotUsage } = require('./analysisSnapshotPublications');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

describe.skipIf(!process.env.DATABASE_URL)('inert exact source prefixes and disclosure boundaries', () => {
  let directory, provider, preparations, publications, owner, reader, admin, project, analysis, serviceId, settings, http, server;
  beforeAll(async () => {
    settings = Object.fromEntries(['STORAGE_ROOT', 'VAULT_ROOT', 'APP_DEPLOYMENT_MODE'].map(key => [key, process.env[key]]));
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'traceomics-inert-snapshots-'));
    Object.assign(process.env, { STORAGE_ROOT: path.join(directory, 'storage'), VAULT_ROOT: path.join(directory, 'private'), APP_DEPLOYMENT_MODE: 'private' });
    await fs.mkdir(process.env.STORAGE_ROOT); provider = storage.createLocalStorageProvider(); http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    await db.resetSchemaForTests();
    owner = await http.createUserWithToken({ email: 'inert-owner@example.test' }); reader = await http.createUserWithToken({ email: 'inert-reader@example.test' }); admin = await http.createUserWithToken({ email: 'inert-admin@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Inert findings lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Exact source excerpts' }); await db.addProjectMember(project.id, reader.user.id, 'viewer'); await db.addProjectMember(project.id, admin.user.id, 'admin');
    analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: crypto.randomUUID(), name: 'Reviewed source text' })).analysis;
    serviceId = (await db.getServiceExecutionIdentity()).id; preparations = createAnalysisSnapshotPreparationService(db, provider); publications = createAnalysisSnapshotPublicationService();
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve)); await db.close();
    for (const [key, value] of Object.entries(settings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = () => `/api/projects/${project.id}/analyses/${analysis.id}`;
  const api = (suffix, options = {}, actor = owner) => http.api(server, base() + suffix, { token: actor.token, ...options });
  const scope = (actor = owner) => ({ serviceId, projectId: project.id, analysisId: analysis.id, userId: actor.user.id });
  const op = saved => ({ requestId: saved.requestId, requestSha256: saved.requestSha256 });
  const selection = (item, maxBytes = 16384) => ({ kind: 'inert-analysis-reference', reference: item.reference, caption: 'Deliberately included source prefix', view: { family: 'text', maxBytes }, includeSourceText: true });
  const recipe = (results, extra = {}) => ({ schema: 'traceomics.analysis-snapshot-preparation.v2', requestId: crypto.randomUUID(), serviceId, projectId: project.id, analysisId: analysis.id, ownerUserId: owner.user.id,
    analysisVersion: analysis.version, results, documents: [], notes: { summary: null, decisions: null, limitations: null }, prerequisites: [], ...extra });
  const action = saved => ({ requestId: crypto.randomUUID(), serviceId, projectId: project.id, analysisId: analysis.id, ownerUserId: owner.user.id, preparationId: saved.preparationId, snapshotSha256: saved.snapshotSha256 });
  const withdrawal = (accepted, actor = owner) => ({ requestId: crypto.randomUUID(), serviceId, projectId: project.id, analysisId: analysis.id, ownerUserId: actor.user.id, publicationId: accepted.acceptance.publicationId, snapshotSha256: accepted.acceptance.snapshotSha256 });
  async function pin(references, actor = owner) { analysis = (await createResearchAnalysisService().patch(actor.user.id, project.id, analysis.id, { expectedVersion: analysis.version, references })).analysis; }
  async function source({ family = 'av', extension = 'txt', bytes = Buffer.from('\uFEFF  recorded\r\n<script>no execution</script>\n'), actor = owner } = {}) {
    const filename = 'source.' + extension;
    if (family === 'av') {
      const file = path.join(directory, crypto.randomUUID() + filename); await fs.writeFile(file, bytes);
      const result = await createArtifactVersionService(db, provider).importFile(actor.user.id, project.id, { path: file, originalFilename: filename, name: filename });
      const key = (await db.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [result.versionId])).rows[0].storage_key;
      return { reference: { kind: 'artifact-version', versionId: result.versionId, sha256: result.sha256 }, bytes, key };
    }
    const id = db.genId(family), key = family === 'eri' ? allocateExpertRInputStorageKey(project.id, id, filename) : storage.projectStorageFileKey(project.id, 'artifacts', id, filename); await fs.writeFile(provider.prepareWrite(key), bytes);
    if (family === 'eri') {
      await db.setExpertRExecutorByEmail(actor.user.email, true);
      await db.createExpertRPrivateInput(actor.user.id, project.id, { id, originalFilename: filename, internalStorageKey: key, mimeType: extension === 'json' ? 'application/json' : 'text/plain', sizeBytes: bytes.length, checksumSha256: hash(bytes) });
    } else {
      const job = await db.createProjectJob(actor.user.id, project.id, { jobType: 'generic' }); await db.query("UPDATE jobs SET status='completed' WHERE id=$1", [job.id]);
      await db.query("INSERT INTO job_artifacts(id,project_id,job_id,created_by_user_id,artifact_type,name,mime_type,storage_kind,storage_uri,checksum_sha256,size_bytes,status) VALUES($1,$2,$3,$4,'expert_r_summary','Misleading JSON filename','application/json','local_internal',$5,$6,$7,'available')", [id, project.id, job.id, actor.user.id, key, hash(bytes), bytes.length]);
    }
    return { reference: { kind: 'artifact-version', versionId: id, sha256: hash(bytes) }, bytes, key };
  }
  async function ready(item = null, maxBytes = 16384, target = preparations) { item ||= await source(); await pin([item.reference]); const input = recipe([selection(item, maxBytes)]); return { item, input, saved: await target.prepare(owner.user.id, project.id, analysis.id, input) }; }
  async function raw(saved, index = 0, target = preparations) { return target.readBlob(owner.user.id, project.id, analysis.id, saved.preparationId, saved.package.results[index].viewId, 'result'); }
  async function body(saved, index = 0) { return decodeSnapshotPreparationInert((await raw(saved, index)).bytes, saved.package.results[index]); }
  async function wrappedDatabase(intercept) { const pool = await db.connect(); return { ...db, connect: async () => ({ connect: async () => { const client = await pool.connect(); return { query: (sql, values) => intercept(client, sql, values), release: destroy => client.release(destroy) }; } }) }; }

  it.each([['av', 'txt'], ['av', 'json'], ['eri', 'txt'], ['eri', 'json']])('retains exact owned %s/%s source spelling and serves only inert checked JSON to current colleagues', async (family, extension) => {
    const original = extension === 'json' ? Buffer.from('\uFEFF {"value":9007199254740993,"value":-0,"nested":[true,null,{"x":"λ"}]}\r\n') : Buffer.from('\uFEFF  print("literal source")\r\n<script>window.SOURCE_EXECUTED=true</script>\n');
    const { item, input, saved } = await ready(await source({ family, extension, bytes: original })); expect(saved.state).toBe('ready');
    expect(saved.requestSha256).toBe(hash(canonicalAnalysisSnapshotPreparation(input))); expect(saved.snapshotSha256).toBe(hash(canonicalAnalysisSnapshotPackage(saved.package)));
    const record = { ...saved }; delete record.created; expect(await validateSnapshotPreparation(record, scope(), input)).toEqual(record);
    const result = saved.package.results[0], decoded = await body(saved); expect(decoded.text).toBe(original.toString('utf8')); expect(decoded.includedSourceBytes).toBe(original.length); expect(decoded.truncated).toBe(false); expect(decoded.syntax).toBe('not-checked'); expect(result.view.schema).toBe('traceomics.fixed-result-view.v4');
    const request = action(saved), accepted = await publications.publish(owner.user.id, project.id, analysis.id, request), receipt = { ...accepted }; delete receipt.created;
    expect(await validateSnapshotPublicationReceipt(receipt, scope(), { action: 'publish', ...request })).toEqual(receipt);
    await fs.unlink(provider.resolveKey(item.key)); await preparations.remove(owner.user.id, project.id, analysis.id, saved.preparationId, op(saved));
    const viewed = await publications.get(reader.user.id, project.id, analysis.id, accepted.acceptance.publicationId);
    expect(await validateSnapshotPublication(viewed, scope(reader), { publicationId: accepted.acceptance.publicationId, snapshotSha256: saved.snapshotSha256 })).toEqual(viewed);
    const read = await publications.readBlob(reader.user.id, project.id, analysis.id, accepted.acceptance.publicationId, result.viewId, 'result'); expect(read.mimeType).toBe('application/json; charset=utf-8'); expect((await decodeSnapshotPreparationInert(read.bytes, result)).text).toBe(decoded.text);
    expect(JSON.stringify(viewed)).not.toMatch(/internalStorage|storage_key|sourceImport|SOURCE_EXECUTED|private-input/);
    await expect(createArtifactVersionService(db, provider).get(reader.user.id, project.id, item.reference.versionId)).rejects.toMatchObject({ code: 'ARTIFACT_VERSION_NOT_FOUND' });
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('preserves BOM/UTF8 cut and byte facts at a %i-byte bound without replacement characters', async maxBytes => {
    const original = Buffer.from('\uFEFF🧬λz'), { saved } = await ready(await source({ bytes: original }), maxBytes); expect(saved.state).toBe('ready');
    const decoded = await body(saved), expected = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original.subarray(0, maxBytes), { stream: true });
    expect(decoded.text).toBe(expected); expect(decoded.includedSourceBytes).toBe(Buffer.byteLength(expected)); expect(decoded.truncated).toBe(true); expect(Buffer.from(decoded.text).equals(original.subarray(0, decoded.includedSourceBytes))).toBe(true);
  });

  it.each([Buffer.alloc(0), Buffer.from('x'), Buffer.from('\uFEFF\r\n\t\0λ')])('retains an exact short/empty source and unnormalized controls %#', async bytes => {
    const { saved } = await ready(await source({ bytes })), decoded = await body(saved); expect(saved.state).toBe('ready'); expect(decoded.text).toBe(bytes.toString()); expect(decoded.includedSourceBytes).toBe(bytes.length); expect(decoded.truncated).toBe(false);
  });

  it.each([Buffer.from([0x61, 0xff, 0x62]), Buffer.from([0x61, 0xf0, 0x9f])])('rejects invalid interior or fully included ending UTF8 without accepting a replacement %#', async bytes => {
    const { saved } = await ready(await source({ bytes })); expect(saved.state).toBe('failed'); expect(saved.package).toBeNull(); expect(saved.canResume).toBe(true); expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
  });

  it('shares only the selected prefix without claiming valid omitted UTF8 or complete JSON syntax', async () => {
    const original = Buffer.concat([Buffer.from(' {"not":'), Buffer.from([255, 254])]), { saved } = await ready(await source({ extension: 'json', bytes: original }), 8), decoded = await body(saved);
    expect(decoded.text).toBe(' {"not":'); expect(decoded.syntax).toBe('not-checked'); expect(decoded.truncated).toBe(true); expect(decoded.includedSourceBytes).toBe(8);
  });

  it('stream-verifies a JSON source larger than the old full parser bound once and reads only the largest chosen prefix', async () => {
    const original = Buffer.from(' '.repeat(3 * 1024 * 1024) + 'UNSELECTED_PRIVATE_SUFFIX'), item = await source({ extension: 'json', bytes: original }); await pin([item.reference]);
    let opens = 0, readBytes = 0, maximumRead = 0;
    const tracked = { ...provider, openVerifiedRead: async (...args) => { opens++; const opened = await provider.openVerifiedRead(...args), read = opened.handle.read.bind(opened.handle); opened.handle.readFile = () => { throw new Error('Complete source buffering is forbidden'); }; opened.handle.read = async (...values) => { maximumRead = Math.max(maximumRead, values[2]); const result = await read(...values); readBytes += result.bytesRead; return result; }; return opened; } };
    const input = recipe([selection(item, 7), selection(item, 16384)]), saved = await createAnalysisSnapshotPreparationService(db, tracked).prepare(owner.user.id, project.id, analysis.id, input);
    expect(saved.state).toBe('ready'); expect(opens).toBe(1); expect(readBytes).toBe(16384); expect(maximumRead).toBe(16384); expect((await body(saved)).text).toBe(' '.repeat(7)); expect((await body(saved, 1)).text).toBe(' '.repeat(16384));
    expect(JSON.stringify(saved)).not.toContain('UNSELECTED_PRIVATE_SUFFIX'); expect((await db.query('SELECT details_json FROM project_audit_events')).rows.every(row => !JSON.stringify(row).includes('UNSELECTED_PRIVATE_SUFFIX'))).toBe(true);
  });

  it('offers metadata-only owned inert files with exact N/kind/account cursor bindings and no format or typed bypass', async () => {
    const first = await source(), second = await source({ extension: 'json' }), hidden = await source({ actor: admin }), opaque = await source({ extension: 'html' }), job = await source({ family: 'art', extension: 'json' });
    await pin([first.reference, second.reference, opaque.reference, job.reference]); await pin([first.reference, second.reference, opaque.reference, job.reference, hidden.reference], admin); const version = analysis.version;
    const guarded = createAnalysisSnapshotPreparationService(db, { ...provider, openVerifiedRead: () => { throw new Error('Options cannot read files'); } });
    const options = await guarded.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-inert-references', analysisVersion: version, limit: 1 }); expect(options.items[0].reference).toEqual(first.reference); expect(await validateSnapshotPreparationOptions(options, scope(), 'analysis-inert-references', version)).toEqual(options);
    const next = await guarded.options(owner.user.id, project.id, analysis.id, { kind: 'analysis-inert-references', analysisVersion: version, limit: 1, cursor: options.nextCursor }); expect(next.items[0].reference).toEqual(second.reference);
    await expect(guarded.options(admin.user.id, project.id, analysis.id, { kind: 'analysis-inert-references', analysisVersion: version, cursor: options.nextCursor })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_INVALID_PAGE' });
    for (const item of [hidden, opaque]) await expect(guarded.prepare(owner.user.id, project.id, analysis.id, recipe([selection(item)]))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_CHANGED' });
    await expect(guarded.prepare(owner.user.id, project.id, analysis.id, recipe([selection(job)]))).rejects.toMatchObject({ code: 'INVALID_ANALYSIS_SNAPSHOT_PREPARATION' });
    const typedId = db.genId('eri'), typedJob = await db.createProjectJob(owner.user.id, project.id, { jobType: 'generic' }), typedKey = storage.projectStorageFileKey(project.id, 'artifacts', typedJob.id, 'metrics.json'), typedBytes = Buffer.from('{"cells":12}');
    await db.query("UPDATE jobs SET status='completed' WHERE id=$1", [typedJob.id]); await fs.writeFile(provider.prepareWrite(typedKey), typedBytes);
    await db.query('INSERT INTO workflow_artifacts(id,owner_user_id,project_id,job_id,descriptor_json,storage_key) VALUES($1,$2,$3,$4,$5,$6)', [typedId, owner.user.id, project.id, typedJob.id, { id: typedId, type: 'metrics', sha256: hash(typedBytes), sizeBytes: typedBytes.length }, typedKey]);
    const typed = { reference: { kind: 'artifact-version', versionId: typedId, sha256: hash(typedBytes) } }; await pin([first.reference, typed.reference]);
    await expect(guarded.prepare(owner.user.id, project.id, analysis.id, recipe([selection(typed)]))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_CHANGED' });
    await pin([]); expect((await preparations.prepare(owner.user.id, project.id, analysis.id, recipe([selection(first)], { analysisVersion: version }))).state).toBe('ready');
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, recipe([selection(first)]))).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE' });
  });

  it('rejects missing/false consent and changed-bound UUID intent without copying new bytes', async () => {
    const item = await source(); await pin([item.reference]); const selected = selection(item, 5);
    for (const includeSourceText of [false, undefined]) { const chosen = { ...selected, includeSourceText }; if (includeSourceText === undefined) delete chosen.includeSourceText; await expect(preparations.prepare(owner.user.id, project.id, analysis.id, recipe([chosen]))).rejects.toMatchObject({ status: 400 }); }
    const input = recipe([selected]), saved = await preparations.prepare(owner.user.id, project.id, analysis.id, input);
    await expect(preparations.prepare(owner.user.id, project.id, analysis.id, { ...input, results: [selection(item, 6)] })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_REQUEST_CONFLICT' });
    expect((await preparations.getByRequest(owner.user.id, project.id, analysis.id, input.requestId)).snapshotSha256).toBe(saved.snapshotSha256);
  });

  it('does not freeze changed same-FD prefix bytes or accept a new private-input format after the checked reader closes', async () => {
    const item = await source({ family: 'eri', bytes: Buffer.from('original text') }); await pin([item.reference]); const input = recipe([selection(item)]); let changed = false;
    const corrupting = { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args); if (!changed) { changed = true; await fs.writeFile(provider.resolveKey(item.key), Buffer.from('replaced text')); } return opened; } };
    expect((await createAnalysisSnapshotPreparationService(db, corrupting).prepare(owner.user.id, project.id, analysis.id, input)).state).toBe('failed'); await fs.writeFile(provider.resolveKey(item.key), item.bytes);
    let closed = false; const replaced = { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args), close = opened.handle.close.bind(opened.handle); opened.handle.close = async () => { await close(); if (!closed) { closed = true; await db.query("UPDATE expert_r_private_inputs SET original_filename='changed.rds' WHERE id=$1", [item.reference.versionId]); } }; return opened; } };
    expect((await createAnalysisSnapshotPreparationService(db, replaced).prepare(owner.user.id, project.id, analysis.id, recipe([selection(item)]))).state).toBe('failed'); expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
  });

  it('never resurrects a removed held builder or retains its conservative quota', async () => {
    const item = await source(); await pin([item.reference]); const input = recipe([selection(item)]), reached = gate(), release = gate(); let held = false;
    const pending = createAnalysisSnapshotPreparationService(db, { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args); if (!held) { held = true; reached.release(); await release.promise; } return opened; } }).prepare(owner.user.id, project.id, analysis.id, input); await reached.promise;
    const admitted = await preparations.getByRequest(owner.user.id, project.id, analysis.id, input.requestId);
    try { await preparations.remove(owner.user.id, project.id, analysis.id, admitted.preparationId, op(admitted)); } finally { release.release(); }
    expect((await pending).state).toBe('deleted'); expect(await projectSnapshotUsage(db, project.id)).toBe(0);
  });

  it('rechecks actual current owner membership after held source I/O before any inert content is adopted', async () => {
    const item = await source(); await pin([item.reference]); const reached = gate(), release = gate(); let held = false;
    const pending = createAnalysisSnapshotPreparationService(db, { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args); if (!held) { held = true; reached.release(); await release.promise; } return opened; } }).prepare(owner.user.id, project.id, analysis.id, recipe([selection(item)])); await reached.promise;
    try { await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, owner.user.id]); } finally { release.release(); }
    await expect(pending).rejects.toMatchObject({ status: 404 }); expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
  });

  it('maps an authenticated production-route revocation during the owning reader to the exact global scope 404', async () => {
    const item = await source(); await pin([item.reference]); const reached = gate(), release = gate(); let held = false;
    const database = { ...db, requireProjectRole: async (...args) => { if (!held) { held = true; reached.release(); await release.promise; } return db.requireProjectRole(...args); } };
    const app = require('express')(); app.use(require('express').json());
    app.use('/api/projects/:projectId/analyses/:analysisId/snapshot-preparations', http.serverModule.requireAuth, require('./analysisSnapshotPreparations').analysisSnapshotPreparationRoutes({ database, logger: { error() {} } }));
    const routeServer = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    try {
      const pending = http.api(routeServer, base() + '/snapshot-preparations', { token: owner.token, method: 'POST', body: recipe([selection(item)]) });
      await Promise.race([reached.promise, pending.then(result => { throw new Error('The route returned before the held reader: ' + result.status); })]);
      try { await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, owner.user.id]); } finally { release.release(); }
      const result = await pending; expect(result.status).toBe(404); expect(result.data.code).toBe('ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND'); expect(result.res.headers.get('cache-control')).toContain('no-store');
      expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
    } finally { release.release(); routeServer.closeAllConnections(); await new Promise(resolve => routeServer.close(resolve)); }
  });

  it.each(['NOT_FOUND', 'FORBIDDEN', 'XX000'])('preserves an unexpected owning-reader %s fault by identity while current scope is authorized', async code => {
    const item = await source(); await pin([item.reference]); const failure = Object.assign(new Error('Unexpected reader fault'), { code });
    const target = createAnalysisSnapshotPreparationService(db, { ...provider, openVerifiedRead: async () => { throw failure; } });
    await expect(target.prepare(owner.user.id, project.id, analysis.id, recipe([selection(item)]))).rejects.toBe(failure); expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
  });

  it('keeps the final private-input owner/format row stable through ready COMMIT without holding it during source verification', async () => {
    const item = await source({ family: 'eri' }); await pin([item.reference]); let closed = false, locked = false;
    const tracked = { ...provider, openVerifiedRead: async (...args) => { const opened = await provider.openVerifiedRead(...args), close = opened.handle.close.bind(opened.handle); opened.handle.close = async () => { await close(); closed = true; }; return opened; } };
    const wrapped = await wrappedDatabase(async (client, sql, values) => { const result = await client.query(sql, values);
      if (closed && !locked && sql.startsWith('SELECT * FROM expert_r_private_inputs') && sql.endsWith(' FOR SHARE')) {
        locked = true; const competing = await (await db.connect()).connect();
        try { await competing.query('BEGIN'); await competing.query("SET LOCAL lock_timeout='100ms'"); await expect(competing.query("UPDATE expert_r_private_inputs SET original_filename='changed.json' WHERE id=$1", [item.reference.versionId])).rejects.toMatchObject({ code: '55P03' }); }
        finally { await competing.query('ROLLBACK'); competing.release(); }
      }
      return result;
    });
    const saved = await createAnalysisSnapshotPreparationService(wrapped, tracked).prepare(owner.user.id, project.id, analysis.id, recipe([selection(item)])); expect(saved.state).toBe('ready'); expect(locked).toBe(true);
  });

  it.each(['revoke', 'withdraw'])('fences held public source text after actual %s and grants no original/download/edit/execution access', async change => {
    const { item, saved } = await ready(), accepted = await publications.publish(owner.user.id, project.id, analysis.id, action(saved)), viewId = saved.package.results[0].viewId;
    for (const actor of [reader, admin]) { expect((await api(`/snapshot-preparations/${saved.preparationId}`, {}, actor)).status).toBe(404); await expect(createArtifactVersionService(db, provider).get(actor.user.id, project.id, item.reference.versionId)).rejects.toMatchObject({ code: 'ARTIFACT_VERSION_NOT_FOUND' }); await expect(createArtifactVersionService(db, provider).resolveVerified(actor.user.id, project.id, { artifactId: saved.package.results[0].source.artifactId, versionId: item.reference.versionId, projectId: project.id, sha256: item.reference.sha256 }, { purpose: 'execution' })).rejects.toThrow(); }
    expect((await http.api(server, `/api/projects/${project.id}/artifacts/${item.reference.versionId}/download`, { token: reader.token })).status).not.toBe(200);
    const replacement = path.join(directory, crypto.randomUUID() + '-replacement.txt'); await fs.writeFile(replacement, item.bytes);
    await expect(createArtifactVersionService(db, provider).importFile(admin.user.id, project.id, { path: replacement, originalFilename: 'replacement.txt', name: 'Cannot edit another researcher source' }, item.reference.versionId)).rejects.toMatchObject({ code: 'ARTIFACT_VERSION_NOT_FOUND' });
    const reached = gate(), release = gate(); let held = false; const wrapped = await wrappedDatabase(async (client, sql, values) => { const result = await client.query(sql, values); if (sql === 'COMMIT' && !held) { held = true; reached.release(); await release.promise; } return result; });
    const pending = createAnalysisSnapshotPublicationService(wrapped).readBlob(reader.user.id, project.id, analysis.id, accepted.acceptance.publicationId, viewId, 'result'); await reached.promise;
    try { if (change === 'revoke') await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, reader.user.id]); else await publications.withdraw(admin.user.id, project.id, analysis.id, withdrawal(accepted, admin)); } finally { release.release(); }
    await expect(pending).rejects.toMatchObject({ code: change === 'revoke' ? 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND' : 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN' });
  });

  it('returns exact inert HTTP JSON with closed queries/scope, and keeps archive/replay/lease lifetime independent of originals', async () => {
    const { saved, input } = await ready(), request = action(saved), accepted = await publications.publish(owner.user.id, project.id, analysis.id, request), id = accepted.acceptance.publicationId, viewId = saved.package.results[0].viewId;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${base()}/snapshot-publications/${id}/views/${viewId}`, { headers: { Cookie: `${require('./config').sessionCookieName()}=${reader.token}` } }); expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8'); expect(response.headers.get('x-content-type-options')).toBe('nosniff'); expect(hash(Buffer.from(await response.arrayBuffer()))).toBe(saved.package.results[0].view.blobSha256);
    for (const url of [`/snapshot-publications/${id}/views/${viewId}?maxBytes=16384`, `/snapshot-preparations/${saved.preparationId}/views/${viewId}?offset=1`]) expect((await api(url)).status).toBe(400);
    expect((await api(`/snapshot-publications/${id}/views/asv_${'a'.repeat(24)}`, {}, reader)).status).toBe(404);
    const other = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: crypto.randomUUID(), name: 'Other analysis' })).analysis; await expect(publications.readBlob(reader.user.id, project.id, other.id, id, viewId, 'result')).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Other source lab' }), otherProject = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Other source project' }); await db.addProjectMember(otherProject.id, reader.user.id, 'viewer');
    const foreignAnalysis = (await createResearchAnalysisService().create(owner.user.id, otherProject.id, { requestId: crypto.randomUUID(), name: 'Other source analysis' })).analysis;
    await expect(publications.readBlob(reader.user.id, otherProject.id, foreignAnalysis.id, id, viewId, 'result')).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND' });
    analysis = (await createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: analysis.version, status: 'archived' })).analysis; await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    expect((await preparations.prepare(owner.user.id, project.id, analysis.id, input)).snapshotSha256).toBe(saved.snapshotSha256); expect((await publications.publish(owner.user.id, project.id, analysis.id, request)).replayed).toBe(true);
    await preparations.remove(owner.user.id, project.id, analysis.id, saved.preparationId, op(saved)); expect((await publications.readBlob(reader.user.id, project.id, analysis.id, id, viewId, 'result')).bytes.length).toBe(saved.package.results[0].view.blobBytes);
    await publications.withdraw(admin.user.id, project.id, analysis.id, withdrawal(accepted, admin)); expect((await db.query('SELECT COUNT(*) AS n FROM research_analysis_snapshot_blobs')).rows[0].n).toBe('0');
  });

  it('recovers actual ready/publish COMMIT acknowledgement loss after source cleanup and reader downgrade', async () => {
    const item = await source(); await pin([item.reference]); const input = recipe([selection(item)]); let ready = false, lost = false;
    const wrapped = await wrappedDatabase(async (client, sql, values) => { const result = await client.query(sql, values); if (sql.includes("SET state='ready'")) ready = true; if (ready && sql === 'COMMIT' && !lost) { lost = true; throw new Error('Actual inert ready ACK lost'); } return result; });
    await expect(createAnalysisSnapshotPreparationService(wrapped, provider).prepare(owner.user.id, project.id, analysis.id, input)).rejects.toThrow(/ACK lost/);
    const saved = await preparations.getByRequest(owner.user.id, project.id, analysis.id, input.requestId), request = action(saved); let published = false;
    const publicationDb = await wrappedDatabase(async (client, sql, values) => { const result = await client.query(sql, values); if (sql.startsWith('INSERT INTO research_analysis_snapshot_publications')) published = true; if (published && sql === 'COMMIT') { published = false; throw new Error('Actual inert publish ACK lost'); } return result; });
    await expect(createAnalysisSnapshotPublicationService(publicationDb).publish(owner.user.id, project.id, analysis.id, request)).rejects.toThrow(/ACK lost/);
    await fs.unlink(provider.resolveKey(item.key)); await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    expect((await preparations.prepare(owner.user.id, project.id, analysis.id, input)).snapshotSha256).toBe(saved.snapshotSha256); expect((await publications.publish(owner.user.id, project.id, analysis.id, request)).replayed).toBe(true); await db.initSchema(); await db.initSchema();
    expect((await db.query("SELECT schema_version FROM app_schema_contract WHERE schema_key='traceomics.runtime'")).rows[0].schema_version).toBe(20261032);
  });

  it('charges actual escaped retained bytes once and preserves immutable acceptance after stored prefix corruption', async () => {
    const { item, saved } = await ready(await source({ bytes: Buffer.alloc(16384, 0) })), rawView = await raw(saved); expect(rawView.bytes.length).toBeGreaterThan(16384); expect(rawView.bytes.length).toBeLessThanOrEqual(256 * 1024);
    const before = await projectSnapshotUsage(db, project.id), accepted = await publications.publish(owner.user.id, project.id, analysis.id, action(saved)), metadata = Number((await db.query('SELECT metadata_bytes FROM research_analysis_snapshot_publications')).rows[0].metadata_bytes);
    expect(await projectSnapshotUsage(db, project.id)).toBe(before + metadata); await preparations.remove(owner.user.id, project.id, analysis.id, saved.preparationId, op(saved)); await fs.unlink(provider.resolveKey(item.key));
    // Explicit scoped legacy storage fault, not an allowed immutable-row update.
    const client = await (await db.connect()).connect(); try { await client.query('BEGIN'); await client.query('SET LOCAL session_replication_role=replica'); await client.query("UPDATE research_analysis_snapshot_blobs SET content=decode(repeat('00',size_bytes),'hex') WHERE preparation_id=$1", [saved.preparationId]); await client.query('COMMIT'); } finally { client.release(); }
    const current = await publications.get(reader.user.id, project.id, analysis.id, accepted.acceptance.publicationId); expect(current.snapshotSha256).toBe(saved.snapshotSha256); expect(current.availability.status).toBe('unavailable');
    await expect(publications.readBlob(reader.user.id, project.id, analysis.id, accepted.acceptance.publicationId, saved.package.results[0].viewId, 'result')).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_VIEW_UNAVAILABLE' });
    expect((await publications.getByRequest(owner.user.id, project.id, analysis.id, accepted.requestId)).acceptance).toEqual(accepted.acceptance);
  });

  it('applies the existing shared ten-live-candidate quota before file verification and keeps original inert replay available', async () => {
    const { input, saved } = await ready();
    for (let index = 1; index < 10; index++) expect((await preparations.prepare(owner.user.id, project.id, analysis.id, { ...input, requestId: crypto.randomUUID() })).state).toBe('ready');
    const target = createAnalysisSnapshotPreparationService(db, { ...provider, openVerifiedRead: () => { throw new Error('Quota and accepted replay cannot read originals'); } });
    await expect(target.prepare(owner.user.id, project.id, analysis.id, { ...input, requestId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'ANALYSIS_SNAPSHOT_CAPACITY' }); expect((await target.prepare(owner.user.id, project.id, analysis.id, input)).snapshotSha256).toBe(saved.snapshotSha256);
  });
});
