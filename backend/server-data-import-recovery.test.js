import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { canonicalServerDataImportRequest, normalizeServerDataImportRequest } from '../shared/serverDataImport.mjs';

const db = require('./pgDatabase');
const storage = require('./storage');
const { createServerDataImportService } = require('./serverDataImports');
const { createResearchAnalysisService } = require('./researchAnalyses');
const { createAnalysisAttachmentService } = require('./analysisAttachments');
const keys = ['APP_DEPLOYMENT_MODE', 'SERVER_DATA_IMPORT_ROOTS', 'STORAGE_ROOT', 'VAULT_ROOT', 'PRIVATE_R_TRANSFER_TIMEOUT_SECONDS', 'EXECUTION_SERVICE_LABEL'];
const id = prefix => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const bytes = 'gene,score\nA,12\n';

describe.skipIf(!process.env.DATABASE_URL)('durable owner-private server import acceptance and discovery', () => {
  let settings, directory, source, provider, service, services = [], http, server, owner, analyst, viewer, outsider, project;
  const create = (database = db, target = provider) => { const value = createServerDataImportService(database, target); services.push(value); return value; };
  beforeAll(async () => {
    settings = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'traceomics-server-recovery-')); source = path.join(directory, 'sources');
    Object.assign(process.env, { APP_DEPLOYMENT_MODE: 'private', STORAGE_ROOT: path.join(directory, 'storage'), VAULT_ROOT: path.join(directory, 'private'), EXECUTION_SERVICE_LABEL: 'Recovery server' });
    await fs.mkdir(source); await fs.mkdir(process.env.STORAGE_ROOT); provider = storage.createLocalStorageProvider();
    http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    await Promise.all(services.map(value => value.waitForIdle())); services = [];
    await db.resetSchemaForTests(); process.env.APP_DEPLOYMENT_MODE = 'private'; delete process.env.PRIVATE_R_TRANSFER_TIMEOUT_SECONDS;
    await fs.rm(source, { recursive: true, force: true }); await fs.mkdir(source);
    owner = await http.createUserWithToken({ email: 'server-recovery-owner@example.test', displayName: 'Importing researcher' });
    analyst = await http.createUserWithToken({ email: 'server-recovery-analyst@example.test' }); viewer = await http.createUserWithToken({ email: 'server-recovery-viewer@example.test' });
    outsider = await http.createUserWithToken({ email: 'server-recovery-outsider@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Recovery lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Recovered evidence' });
    await db.addProjectMember(project.id, analyst.user.id, 'analyst'); await db.addProjectMember(project.id, viewer.user.id, 'viewer');
    grants([{ projectId: project.id, ownerUserId: owner.user.id }]); service = create();
  });
  afterAll(async () => {
    await Promise.all(services.map(value => value.waitForIdle()));
    if (server) await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(settings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await db.close(); await fs.rm(directory, { recursive: true, force: true });
  });
  function grants(values) { process.env.SERVER_DATA_IMPORT_ROOTS = JSON.stringify([{ id: 'study', label: 'Granted study data', path: source, grants: values }]); }
  async function selected(filename = 'private-result.csv', value = service, actor = owner, p = project) {
    await fs.writeFile(path.join(source, filename), bytes);
    const listing = await value.list(actor.user.id, p.id, 'study');
    return { requestId: crypto.randomUUID(), rootId: 'study', relativePath: filename, selectionToken: listing.items.find(item => item.name === filename).selectionToken,
      name: 'Saved outside result', artifactType: 'auto', sampleMetadata: { condition: ' treatment ' } };
  }
  async function completed(input, value = service, actor = owner, p = project) {
    await value.start(actor.user.id, p.id, input); await value.waitForIdle(); return value.get(actor.user.id, p.id, input.requestId);
  }
  const apiBase = (p = project) => `/api/server-data/${p.id}/imports`;
  const get = (requestId, actor = owner, p = project) => http.api(server, `${apiBase(p)}/${requestId}`, { token: actor.token });
  const list = (query = '', actor = owner, p = project) => http.api(server, apiBase(p) + query, { token: actor.token });
  const post = (value, actor = owner, p = project) => http.api(server, apiBase(p), { method: 'POST', token: actor.token, body: value });
  const count = async table => (await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
  async function wrappedDatabase(intercept, released = []) {
    const pool = await db.connect();
    return { ...db, connect: async () => ({ connect: async () => {
      const client = await pool.connect(); return { query: (sql, values) => intercept(client, sql, values), release(destroy) { released.push(destroy); client.release(destroy); } };
    } }) };
  }
  async function held() {
    const entered = gate(), release = gate(); let copies = 0;
    const value = create(db, { ...provider, async putFileFromHandle(...args) { copies++; entered.resolve(); await release.promise; return provider.putFileFromHandle(...args); } });
    return { value, entered, release, copies: () => copies };
  }
  async function seedFailed(total, actor = owner, p = project) {
    const identity = await db.getServiceExecutionIdentity();
    const rows = Array.from({ length: total }, (_, index) => {
      const input = { requestId: crypto.randomUUID(), rootId: 'study', relativePath: `historical-${index}.csv`, selectionToken: 'a'.repeat(64), name: `Failed import ${index}`, artifactType: 'auto' };
      return { id: id('sdi'), request_id: input.requestId, request_sha256: sha(canonicalServerDataImportRequest(input)), request_json: normalizeServerDataImportRequest(input),
        relative_path: input.relativePath, name: input.name, version_id: id('av'), artifact_id: id('af'), source_metadata_json: { root: { id: 'study', label: 'Past granted data' },
          relativePath: input.relativePath, serviceId: identity.id, serviceLabel: identity.label } };
    });
    await db.query(`INSERT INTO server_data_imports
      (id,project_id,owner_user_id,request_id,request_sha256,request_json,status,root_id,relative_path,name,artifact_type,version_id,artifact_id,storage_key,
       source_identity_json,source_metadata_json,reserved_bytes,process_id,expires_at,error_code,error_message,created_at,updated_at,completed_at)
      SELECT id,$1,$2,request_id,request_sha256,request_json,'failed','study',relative_path,name,'auto',version_id,artifact_id,
       'projects/'||$1||'/artifacts/'||version_id||'/content.csv','{}'::jsonb,source_metadata_json,16,$3,'2026-01-01T01:00:00Z',
       'SERVER_IMPORT_INTERRUPTED','Recorded historical interruption','2026-01-01T00:00:00Z','2026-01-01T00:01:00Z','2026-01-01T00:01:00Z'
      FROM jsonb_to_recordset($4::jsonb) AS x(id text,request_id uuid,request_sha256 text,request_json jsonb,relative_path text,name text,version_id text,artifact_id text,source_metadata_json jsonb)`,
    [p.id, actor.user.id, 'b'.repeat(64), JSON.stringify(rows)]);
    return rows;
  }

  it('records the exact original request and verified acceptance atomically and discovers it without file reads', async () => {
    const input = await selected(), result = await completed(input);
    expect(result).toMatchObject({ projectId: project.id, ownerUserId: owner.user.id, requestId: input.requestId,
      request: normalizeServerDataImportRequest(input), requestSha256: sha(canonicalServerDataImportRequest(input)), status: 'succeeded', canImport: true, replayed: true,
      acceptanceState: 'recorded', availability: 'recorded', acceptance: { versionId: result.version.versionId, artifactId: result.version.artifactId,
        versionNumber: 1, previousVersionId: null, sha256: sha(bytes), sizeBytes: Buffer.byteLength(bytes), createdAt: result.version.createdAt }, error: null, message: null });
    const row = (await db.query('SELECT request_json,acceptance_json FROM server_data_imports WHERE request_id=$1', [input.requestId])).rows[0];
    expect(row.request_json).toEqual(result.request); expect(row.acceptance_json).toEqual(result.acceptance);
    const metadataOnly = create(db, { resolveKey() { throw new Error('History may not inspect bytes'); } });
    const history = await metadataOnly.listImports(owner.user.id, project.id);
    expect(history.items).toHaveLength(1); expect(history.items[0]).toMatchObject({ id: result.id, requestId: input.requestId, acceptance: result.acceptance, availability: 'not-checked' });
    expect(JSON.stringify(history)).not.toContain(source); expect(JSON.stringify(history)).not.toContain('storage_key');
    for (const table of ['jobs', 'workflow_runs', 'private_r_executions']) expect(await count(table)).toBe(0);
  });

  it('preserves terminal acceptance after both managed row and bytes disappear', async () => {
    const input = await selected(), accepted = await completed(input), key = (await db.query('SELECT storage_key FROM server_data_imports WHERE request_id=$1', [input.requestId])).rows[0].storage_key;
    await fs.unlink(provider.resolveKey(key)); expect((await get(input.requestId)).data).toMatchObject({ status: 'succeeded', acceptanceState: 'recorded', acceptance: accepted.acceptance, availability: 'unavailable', version: null });
    await db.query('DELETE FROM managed_artifact_versions WHERE id=$1', [accepted.acceptance.versionId]);
    const recovered = await get(input.requestId); expect(recovered.status).toBe(200);
    expect(recovered.data).toMatchObject({ request: normalizeServerDataImportRequest(input), status: 'succeeded', acceptance: accepted.acceptance, availability: 'unavailable', version: null });
    expect((await service.start(owner.user.id, project.id, input)).acceptance).toEqual(accepted.acceptance);
    expect(await count('server_data_imports')).toBe(1); expect(await count('managed_artifact_versions')).toBe(0);
  });

  it('recovers as current owner reader before fresh policy, source grant, configuration or token validation', async () => {
    const input = await selected(), accepted = await completed(input); await fs.unlink(path.join(source, input.relativePath));
    process.env.SERVER_DATA_IMPORT_ROOTS = 'invalid current configuration';
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    const replay = await post(input); expect(replay.status).toBe(200); expect(replay.data).toMatchObject({ canImport: false, acceptance: accepted.acceptance, replayed: true });
    expect((await get(input.requestId)).data.acceptance).toEqual(accepted.acceptance); expect((await list()).data.items).toHaveLength(1);
    expect((await post({ ...input, name: 'Different meaning' })).data.code).toBe('SERVER_IMPORT_REQUEST_CONFLICT');
    expect((await post({ ...input, requestId: crypto.randomUUID() })).status).toBe(403);
    process.env.APP_DEPLOYMENT_MODE = 'demo';
    expect((await get(input.requestId)).data.canImport).toBe(false); expect((await post(input)).data.acceptance).toEqual(accepted.acceptance);
    expect((await list()).data.canImport).toBe(false);
    process.env.APP_DEPLOYMENT_MODE = 'private';
    await db.query("UPDATE project_members SET role='analyst' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    process.env.SERVER_DATA_IMPORT_ROOTS = '[]';
    expect((await service.get(owner.user.id, project.id, input.requestId)).canImport).toBe(true);
    expect((await service.start(owner.user.id, project.id, input)).acceptance).toEqual(accepted.acceptance);
    await expect(service.start(owner.user.id, project.id, { ...input, requestId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'SERVER_IMPORT_NOT_FOUND' });
  });

  it('keeps owner discovery, request source metadata and accepted versions private under current project membership', async () => {
    const input = await selected(), accepted = await completed(input);
    for (const actor of [analyst, viewer]) { expect((await list('', actor)).data.items).toEqual([]); expect((await get(input.requestId, actor)).status).toBe(404); }
    expect((await list('', outsider)).status).toBe(404); expect((await http.api(server, apiBase())).status).toBe(401);
    expect((await http.api(server, `/api/artifact-versions/${project.id}/${accepted.acceptance.versionId}/preview`, { token: analyst.token })).status).toBe(404);
    await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, owner.user.id]);
    for (const response of [await get(input.requestId), await list(), await post(input)]) { expect(response.status).toBe(404); expect(JSON.stringify(response.data)).not.toContain(input.relativePath); }
  });

  it('recovers an actual successful final COMMIT whose acknowledgement is lost and destroys the uncertain client', async () => {
    const released = []; let finalWrite = false, lost = false;
    const uncertain = await wrappedDatabase(async (client, sql, values) => {
      const result = await client.query(sql, values);
      if (sql.startsWith("UPDATE server_data_imports SET status='completed'")) finalWrite = true;
      if (sql === 'COMMIT' && finalWrite && !lost) { lost = true; throw Object.assign(new Error('Owned fixture loses final COMMIT acknowledgement'), { code: 'ECONNRESET' }); }
      return result;
    }, released);
    const value = create(uncertain), input = await selected('committed.csv', value), result = await completed(input, value);
    expect(lost).toBe(true); expect(released).toContain(true); expect(result.status).toBe('succeeded');
    const row = (await db.query('SELECT * FROM server_data_imports WHERE request_id=$1', [input.requestId])).rows[0];
    expect(row.status).toBe('completed'); expect(row.acceptance_json).toEqual(result.acceptance);
    expect(await fs.readFile(provider.resolveKey(row.storage_key), 'utf8')).toBe(bytes);
    expect((await create().get(owner.user.id, project.id, input.requestId)).acceptance).toEqual(result.acceptance);
    expect(await count('managed_artifact_versions')).toBe(1);
  });

  it('retains lost reservation acknowledgement without starting or automatically replaying source transfer', async () => {
    process.env.PRIVATE_R_TRANSFER_TIMEOUT_SECONDS = '1'; let inserted = false, lost = false, copies = 0;
    const uncertain = await wrappedDatabase(async (client, sql, values) => {
      const result = await client.query(sql, values);
      if (sql.includes('INSERT INTO server_data_imports')) inserted = true;
      if (sql === 'COMMIT' && inserted && !lost) { lost = true; throw Object.assign(new Error('Owned fixture loses reservation acknowledgement'), { code: 'ECONNRESET' }); }
      return result;
    });
    const value = create(uncertain, { ...provider, async putFileFromHandle(...args) { copies++; return provider.putFileFromHandle(...args); } });
    const input = await selected('reserved.csv', value);
    await expect(value.start(owner.user.id, project.id, input)).rejects.toMatchObject({ code: 'ECONNRESET' });
    const recreated = create(); expect((await recreated.get(owner.user.id, project.id, input.requestId)).status).toBe('pending');
    process.env.SERVER_DATA_IMPORT_ROOTS = '[]'; expect((await recreated.start(owner.user.id, project.id, input)).status).toBe('pending');
    await pause(1150); const failed = await recreated.get(owner.user.id, project.id, input.requestId);
    expect(failed).toMatchObject({ status: 'failed', acceptanceState: 'not-accepted', acceptance: null, availability: 'not-recorded', version: null,
      error: { code: 'SERVER_IMPORT_INTERRUPTED' } }); expect(copies).toBe(0); expect(await count('managed_artifact_versions')).toBe(0);
  });

  it('retries proven failed-copy cleanup on later authorized GET after the first cleanup query was unavailable', async () => {
    let firstCleanup = true;
    const unavailable = { ...db, query: async (sql, values) => {
      if (sql.includes('SELECT storage_key FROM server_data_imports operation') && firstCleanup) {
        firstCleanup = false; throw Object.assign(new Error('Owned fixture interrupts first cleanup check'), { code: 'ECONNRESET' });
      }
      return db.query(sql, values);
    } };
    const value = create(unavailable, { ...provider, async putFileFromHandle(...args) {
      await provider.putFileFromHandle(...args); throw new Error('Owned fixture fails after copying but before registration');
    } });
    const input = await selected('failed-copy.csv', value); await value.start(owner.user.id, project.id, input); await value.waitForIdle();
    const row = (await db.query('SELECT * FROM server_data_imports WHERE request_id=$1', [input.requestId])).rows[0];
    expect(row.status).toBe('failed'); expect(row.acceptance_json).toBeNull(); expect(await count('managed_artifact_versions')).toBe(0);
    expect(await fs.readFile(provider.resolveKey(row.storage_key), 'utf8')).toBe(bytes);
    expect((await value.get(owner.user.id, project.id, input.requestId)).status).toBe('failed');
    await expect(fs.readFile(provider.resolveKey(row.storage_key))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await value.get(owner.user.id, project.id, input.requestId)).error).toMatchObject({ code: 'SERVER_IMPORT_FAILED' });
  });

  it.each(['membership', 'root grant'])('records copy failure when current %s is revoked and still permits authorized terminal recovery', async mode => {
    const heldCopy = await held(), input = await selected('held.csv', heldCopy.value); await heldCopy.value.start(owner.user.id, project.id, input); await heldCopy.entered.promise;
    try {
      if (mode === 'membership') await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
      else process.env.SERVER_DATA_IMPORT_ROOTS = '[]';
    } finally { heldCopy.release.resolve(); }
    await heldCopy.value.waitForIdle(); const recovered = await get(input.requestId);
    expect(recovered.status).toBe(200); expect(recovered.data).toMatchObject({ status: 'failed', acceptance: null, acceptanceState: 'not-accepted', version: null });
    expect(await count('managed_artifact_versions')).toBe(0); expect(heldCopy.copies()).toBe(1);
    expect((await post(input)).data.status).toBe('failed'); expect((await list()).data.items[0].status).toBe('failed');
  });

  it('serializes same-UUID races into one physical copy and recovers accepted source even after the original file changes', async () => {
    const heldCopy = await held(), input = await selected('race.csv', heldCopy.value);
    const results = await Promise.all([heldCopy.value.start(owner.user.id, project.id, input), heldCopy.value.start(owner.user.id, project.id, input)]);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]); expect(await count('server_data_imports')).toBe(1); await heldCopy.entered.promise;
    heldCopy.release.resolve(); await heldCopy.value.waitForIdle(); const accepted = await heldCopy.value.get(owner.user.id, project.id, input.requestId);
    await fs.writeFile(path.join(source, input.relativePath), 'gene,score\nB,99\n'); process.env.SERVER_DATA_IMPORT_ROOTS = '[]';
    expect((await heldCopy.value.start(owner.user.id, project.id, input)).acceptance).toEqual(accepted.acceptance);
    await expect(heldCopy.value.start(owner.user.id, project.id, { ...input, name: 'Another interpretation' })).rejects.toMatchObject({ code: 'SERVER_IMPORT_REQUEST_CONFLICT' });
    expect(heldCopy.copies()).toBe(1); expect(await count('managed_artifact_versions')).toBe(1);
  });

  it('bounds retained operation metadata across fresh races while exact replay bypasses the history quota', async () => {
    const seeded = await seedFailed(1999), input = await selected('last-slot.csv'), other = { ...input, requestId: crypto.randomUUID() };
    const results = await Promise.allSettled([service.start(owner.user.id, project.id, input), service.start(owner.user.id, project.id, other)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason).toMatchObject({ code: 'SERVER_IMPORT_HISTORY_LIMIT' });
    await service.waitForIdle(); expect(await count('server_data_imports')).toBe(2000);
    const failedReplay = await service.start(owner.user.id, project.id, seeded[0].request_json); expect(failedReplay.status).toBe('failed'); expect(failedReplay.replayed).toBe(true);
    expect(await count('managed_artifact_versions')).toBe(1);
  });

  it('paginates bounded metadata by exact time/id with owner/project-scoped cursors and no source checks', async () => {
    const seeded = await seedFailed(5), other = await seedFailed(2, analyst);
    const noFiles = create(db, { resolveKey() { throw new Error('Discovery must not stat source files'); } });
    const first = await noFiles.listImports(owner.user.id, project.id, { limit: 2 }), second = await noFiles.listImports(owner.user.id, project.id, { limit: 2, cursor: first.nextCursor }), third = await noFiles.listImports(owner.user.id, project.id, { limit: 2, cursor: second.nextCursor });
    expect([...first.items, ...second.items, ...third.items].map(item => item.id)).toEqual(seeded.map(item => item.id).sort().reverse()); expect(third.nextCursor).toBeNull();
    expect((await service.listImports(analyst.user.id, project.id)).items.map(item => item.id).sort()).toEqual(other.map(item => item.id).sort());
    expect(first.items.every(item => item.availability === 'not-recorded' && !Object.hasOwn(item, 'version') && !Object.hasOwn(item, 'request'))).toBe(true);
    for (const query of ['?limit=31', '?limit=0', '?cursor=bad', '?unexpected=true']) expect((await list(query)).data.code).toBe('SERVER_IMPORT_PAGE_INVALID');
    expect((await list(`?cursor=${first.nextCursor}`, analyst)).status).toBe(400);
  });

  it('keeps normalized requests, acceptance and original terminal receipts immutable', async () => {
    const input = await selected(), accepted = await completed(input);
    for (const statement of ["request_json='{}'::jsonb", 'request_json=NULL', "acceptance_json='{}'::jsonb", 'acceptance_json=NULL', "status='failed'", "name='rewritten'"]) {
      await expect(db.query(`UPDATE server_data_imports SET ${statement} WHERE request_id=$1`, [input.requestId])).rejects.toMatchObject({ code: '55000' });
    }
    await expect(db.query('DELETE FROM server_data_imports WHERE request_id=$1', [input.requestId])).rejects.toMatchObject({ code: '55000' });
    expect((await get(input.requestId)).data.acceptance).toEqual(accepted.acceptance);
  });

  it('retains acceptance when profile labels are long, contain hidden controls or need a safe fallback', async () => {
    const rootConfig = JSON.parse(process.env.SERVER_DATA_IMPORT_ROOTS); rootConfig[0].label = 'Granted \u202estudy data';
    process.env.SERVER_DATA_IMPORT_ROOTS = JSON.stringify(rootConfig); process.env.EXECUTION_SERVICE_LABEL = '𝔖'.repeat(40);
    const input = await selected(), accepted = await completed(input);
    expect(accepted.version.sourceImport.serviceLabel).toBe(accepted.source.serviceLabel);
    expect(accepted.version.sourceImport.rootLabel).toBe('Granted  study data');
    expect(accepted.source.serviceLabel.length).toBeLessThanOrEqual(80);
    await db.query('UPDATE users SET display_name=$2 WHERE id=$1', [owner.user.id, 'r'.repeat(190)]);
    expect((await get(input.requestId)).data.version.owner.displayName).toBe('r'.repeat(190));
    await db.query('UPDATE users SET display_name=$2 WHERE id=$1', [owner.user.id, '  Researcher\n\u202e' + '🧬'.repeat(150)]);
    const displayName = (await get(input.requestId)).data.version.owner.displayName;
    expect(displayName.length).toBeLessThanOrEqual(200); expect(displayName.isWellFormed()).toBe(true); expect(displayName).not.toMatch(/[\p{Cc}\p{Cf}]/u); expect(displayName).toBe(displayName.trim());
    await db.query('UPDATE users SET display_name=$2 WHERE id=$1', [owner.user.id, '\n\t\u202e']);
    expect((await get(input.requestId)).data).toMatchObject({ acceptance: accepted.acceptance, version: { owner: { id: String(owner.user.id), displayName: 'Researcher' } } });
  });

  it('backfills v28 only from exact retained managed metadata, preserves local hashes and repeats safely', async () => {
    const first = await selected('retained.csv'), retained = await completed(first), second = await selected('removed.csv'), removed = await completed(second), third = await selected('mismatch.csv'); await completed(third);
    await db.query('DELETE FROM managed_artifact_versions WHERE id=$1', [removed.acceptance.versionId]);
    const analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: crypto.randomUUID(), name: 'Keep local intake' })).analysis;
    const localService = createAnalysisAttachmentService(db, provider), requestId = crypto.randomUUID(), local = { requestId, serviceId: retained.serviceId,
      importRequest: { schema: 'traceomics.artifact-import.v1', projectId: project.id, ownerUserId: owner.user.id, requestId, originalFilename: 'local.csv', name: 'Local evidence', artifactType: 'auto', previousVersionId: null, sha256: sha(bytes), sizeBytes: Buffer.byteLength(bytes) },
      attachment: { requestId: crypto.randomUUID(), action: 'create', attachmentId: null, expectedHeadRevisionId: null, caption: 'Keep original local context', suppliedOrigin: {} } };
    const localAccepted = await localService.admitLocalIntake(owner.user.id, project.id, analysis.id, local);
    await db.query('DROP TRIGGER trg_server_data_import_identity ON server_data_imports');
    await db.query('ALTER TABLE server_data_imports DROP COLUMN request_json, DROP COLUMN acceptance_json');
    await db.query("UPDATE server_data_imports SET name='No longer exact managed metadata' WHERE request_id=$1", [third.requestId]);
    await db.query("UPDATE app_schema_contract SET schema_version=20261028 WHERE schema_key='traceomics.runtime'");
    await db.initSchema({ force: true }); await db.initSchema({ force: true });
    const backfilled = await service.get(owner.user.id, project.id, first.requestId);
    expect(backfilled).toMatchObject({ request: null, status: 'succeeded', acceptanceState: 'recorded', acceptance: retained.acceptance, availability: 'recorded' });
    for (const input of [second, third]) expect(await service.get(owner.user.id, project.id, input.requestId)).toMatchObject({ request: null, status: 'succeeded', acceptanceState: 'legacy-unrecorded', acceptance: null, availability: 'unavailable', version: null });
    const localRecovered = await localService.getLocalIntake(owner.user.id, project.id, analysis.id, local.requestId);
    expect(localRecovered.requestSha256).toBe(localAccepted.requestSha256); expect(localRecovered.recipe).toEqual(localAccepted.recipe);
    expect((await db.query("SELECT schema_version FROM app_schema_contract WHERE schema_key='traceomics.runtime'")).rows[0].schema_version).toBe(20261031);
    await expect(db.query('DELETE FROM server_data_imports WHERE request_id=$1', [first.requestId])).rejects.toMatchObject({ code: '55000' });
  });

  it('exposes genuine authenticated source-free HTTP discovery and exact original status without accepting arbitrary paths', async () => {
    await fs.writeFile(path.join(source, 'http.csv'), bytes);
    const fileList = await http.api(server, `/api/server-data/${project.id}/roots/study/files`, { token: owner.token });
    const input = { requestId: crypto.randomUUID(), rootId: 'study', relativePath: 'http.csv', selectionToken: fileList.data.items.find(item => item.name === 'http.csv').selectionToken };
    expect((await post(input)).status).toBe(202);
    let result; for (let n = 0; n < 100; n++) { result = await get(input.requestId); if (result.data.status !== 'pending') break; await pause(10); }
    expect(result.status).toBe(200); expect(result.data.status).toBe('succeeded'); expect(result.res.headers.get('cache-control')).toContain('no-store');
    expect((await list()).data.items[0]).toMatchObject({ requestId: input.requestId, acceptance: result.data.acceptance, availability: 'not-checked' });
    expect((await get(crypto.randomUUID())).data.code).toBe('SERVER_DATA_IMPORT_NOT_FOUND');
    expect((await post({ ...input, requestId: crypto.randomUUID(), relativePath: '../private.csv' })).data.code).toBe('SERVER_IMPORT_PATH_INVALID');
    expect(await count('server_data_imports')).toBe(1);
  });

  it('deletes retained server receipts only through scoped expired-demo cleanup and keeps another owner intact', async () => {
    const input = await selected(), original = await completed(input);
    const organization = await db.createOrganizationForUser(analyst.user.id, { name: 'Persistent server lab' });
    const retainedProject = await db.createProjectForUser(analyst.user.id, { organizationId: organization.id, name: 'Retained imports' });
    grants([{ projectId: project.id, ownerUserId: owner.user.id }, { projectId: retainedProject.id, ownerUserId: analyst.user.id }]);
    const other = await selected('retained-owner.csv', service, analyst, retainedProject), retained = await completed(other, service, analyst, retainedProject);
    await db.query("UPDATE users SET is_demo_guest=TRUE,expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [owner.user.id]);
    expect(await db.deleteExpiredDemoGuest(owner.user.id)).toBe(true); expect(await count('server_data_imports')).toBe(1);
    expect((await service.get(analyst.user.id, retainedProject.id, other.requestId)).acceptance).toEqual(retained.acceptance);
    expect((await db.query('SELECT id FROM managed_artifact_versions WHERE id=$1', [original.acceptance.versionId])).rowCount).toBe(0);
  });
});
