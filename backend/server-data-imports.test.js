import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const db = require('./pgDatabase');
const storage = require('./storage');
const { createServerDataImportService, openSelection } = require('./serverDataImports');
const { createArtifactVersionService } = require('./artifactVersions');
const configured = Boolean(process.env.DATABASE_URL);
const keys = ['APP_DEPLOYMENT_MODE', 'SERVER_DATA_IMPORT_ROOTS', 'STORAGE_ROOT', 'VAULT_ROOT', 'PRIVATE_R_MANAGED_QUOTA_BYTES', 'PRIVATE_R_TRANSFER_TIMEOUT_SECONDS', 'EXECUTION_SERVICE_LABEL'];
let directory, source, provider, service, artifacts, server, http, user, token, project, settings;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const url = suffix => `/api/server-data/${project.id}${suffix}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

describe.skipIf(!configured)('server data imports with PostgreSQL and immutable real filesystem snapshots', () => {
  beforeAll(async () => {
    settings = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'traceomics-server-data-test-')); source = path.join(directory, 'source');
    Object.assign(process.env, { APP_DEPLOYMENT_MODE: 'private', STORAGE_ROOT: path.join(directory, 'storage'), VAULT_ROOT: path.join(directory, 'private'), EXECUTION_SERVICE_LABEL: 'Study server' });
    await fs.mkdir(source); await fs.mkdir(process.env.STORAGE_ROOT);
    provider = storage.createLocalStorageProvider(); artifacts = createArtifactVersionService(db, provider);
    http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    await service?.waitForIdle(); vi.restoreAllMocks(); await db.resetSchemaForTests();
    process.env.APP_DEPLOYMENT_MODE = 'private'; delete process.env.PRIVATE_R_MANAGED_QUOTA_BYTES; delete process.env.PRIVATE_R_TRANSFER_TIMEOUT_SECONDS;
    await fs.rm(source, { recursive: true, force: true }); await fs.mkdir(source);
    ({ user, token } = await http.createUserWithToken({ email: 'server-data-owner@example.test', displayName: 'Server data owner' }));
    const organization = await db.createOrganizationForUser(user.id, { name: 'Server data lab' });
    project = await db.createProjectForUser(user.id, { organizationId: organization.id, name: 'Server data study' });
    process.env.SERVER_DATA_IMPORT_ROOTS = JSON.stringify([{ id: 'study', label: 'Authorized study data', path: source, grants: [{ projectId: project.id, ownerUserId: user.id }] }]);
    service = createServerDataImportService(db, provider);
  });
  afterAll(async () => {
    if (!configured) return;
    await service?.waitForIdle(); vi.restoreAllMocks(); if (server) await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(settings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await db.close(); await fs.rm(directory, { recursive: true, force: true });
  });
  async function selected(filename = 'cells.csv', bytes = 'cell,condition\na,control\n', value = service) {
    await fs.writeFile(path.join(source, filename), bytes);
    const listing = await value.list(user.id, project.id, 'study');
    return { requestId: crypto.randomUUID(), rootId: 'study', relativePath: filename, selectionToken: listing.items.find(item => item.name === filename).selectionToken, artifactType: 'auto' };
  }
  async function completed(request, value = service) {
    await value.start(user.id, project.id, request); await value.waitForIdle(); return value.get(user.id, project.id, request.requestId);
  }
  async function heldService() {
    const entered = deferred(), release = deferred(); let copies = 0;
    const wrapped = { ...provider, async putFileFromHandle(...args) { copies++; entered.resolve(); await release.promise; return provider.putFileFromHandle(...args); } };
    const value = createServerDataImportService(db, wrapped);
    return { value, entered, release, copies: () => copies };
  }

  it('snapshots server bytes, sample annotations, target identity and checksum without exposing host paths or changing the source', async () => {
    const bytes = 'sample,condition\na,control\n'; const request = await selected('samples.csv', bytes);
    request.artifactType = 'sample-sheet'; request.name = 'Study sample sheet'; request.sampleMetadata = { sampleId: 'donor-1', condition: 'control', tissue: 'lung' };
    const response = await completed(request); expect(response.status).toBe('succeeded');
    expect(response.version).toMatchObject({ type: 'sample-sheet', sha256: sha(bytes), sizeBytes: Buffer.byteLength(bytes), sourceImport: { rootId: 'study', relativePath: 'samples.csv', sha256: sha(bytes), serviceLabel: 'Study server', sampleMetadata: request.sampleMetadata } });
    expect(response.source.serviceId).toMatch(/^svc_[a-f0-9]{32}$/); expect(JSON.stringify(response)).not.toContain(directory);
    expect(await fs.readFile(path.join(source, 'samples.csv'), 'utf8')).toBe(bytes);
    await fs.writeFile(path.join(source, 'samples.csv'), 'sample,condition\nb,treated\n');
    expect((await artifacts.preview(user.id, project.id, response.version.versionId)).preview.rows).toEqual([['a', 'control']]);
    await expect(db.query("UPDATE server_data_imports SET relative_path='other.csv' WHERE request_id=$1", [request.requestId])).rejects.toThrow(/immutable/);
    await expect(db.query("UPDATE server_data_imports SET status='failed' WHERE request_id=$1", [request.requestId])).rejects.toThrow(/immutable/);
  });
  it('imports RDS larger than the browser upload ceiling with metadata-only inspection and bounded stream chunks', async () => {
    const filename = 'large.rds'; const handle = await fs.open(path.join(source, filename), 'w'); await handle.truncate(201 * 1024 ** 2); await handle.close();
    const listing = await service.list(user.id, project.id, 'study');
    const response = await completed({ requestId: crypto.randomUUID(), rootId: 'study', relativePath: filename, selectionToken: listing.items[0].selectionToken });
    expect(response).toMatchObject({ status: 'succeeded', version: { type: 'object', sizeBytes: 201 * 1024 ** 2, previews: [] } });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(8000);
    expect((await artifacts.preview(user.id, project.id, response.version.versionId)).preview.family).toBe('metadata');
  });
  it('retains exact idempotent receipts across connection loss and subsequent source changes', async () => {
    const held = await heldService(); service = held.value; const request = await selected('cells.csv', 'cell,n\na,1\n', service);
    const pending = await service.start(user.id, project.id, request); await held.entered.promise;
    expect(pending.status).toBe('pending'); expect((await service.start(user.id, project.id, request)).requestId).toBe(request.requestId);
    await expect(service.start(user.id, project.id, { ...request, name: 'Another import' })).rejects.toMatchObject({ code: 'SERVER_IMPORT_REQUEST_CONFLICT' });
    held.release.resolve(); await service.waitForIdle(); const result = await service.get(user.id, project.id, request.requestId);
    await fs.writeFile(path.join(source, 'cells.csv'), 'cell,n\nb,2\n');
    expect((await service.start(user.id, project.id, request)).version.versionId).toBe(result.version.versionId); expect(held.copies()).toBe(1);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM server_data_imports')).rows[0].count).toBe(1);
  });
  it('creates distinct replacement versions while preserving prior snapshots and format compatibility', async () => {
    const first = await completed(await selected('cells.csv', 'cell,n\na,1\n'));
    const replacement = await selected('cells.csv', 'cell,n\na,2\n'); replacement.previousVersionId = first.version.versionId;
    const next = await completed(replacement);
    expect(next.version).toMatchObject({ artifactId: first.version.artifactId, previousVersionId: first.version.versionId, versionNumber: 2 });
    expect((await artifacts.preview(user.id, project.id, first.version.versionId)).preview.rows).toEqual([['a', '1']]);
    const wrong = await selected('other.rds', 'opaque R serialization'); wrong.previousVersionId = first.version.versionId;
    await expect(service.start(user.id, project.id, wrong)).rejects.toMatchObject({ code: 'ARTIFACT_FORMAT_CHANGED' });
  });
  it('retains completed artifact bytes when the commit succeeds before the database response is lost', async () => {
    let commits = 0;
    const uncertainDb = { ...db, async connect() {
      const pool = await db.connect();
      return { async connect() {
        const client = await pool.connect();
        return { release: () => client.release(), async query(sql, ...args) {
          const result = await client.query(sql, ...args);
          if (sql === 'COMMIT' && ++commits === 2) throw new Error('Database response lost after successful commit');
          return result;
        } };
      } };
    } };
    service = createServerDataImportService(uncertainDb, provider);
    const bytes = 'cell,n\na,1\n'; const request = await selected('uncertain.csv', bytes, service);
    const response = await completed(request, service); expect(response.status).toBe('succeeded');
    const opened = await artifacts.resolveVerified(user.id, project.id, response.version.reference);
    try { expect(await opened.handle.readFile('utf8')).toBe(bytes); } finally { await opened.handle.close(); }
    expect((await service.start(user.id, project.id, request)).version.versionId).toBe(response.version.versionId);
  });
  it('requires exact account/project grants, signed selections and fresh write membership', async () => {
    const request = await selected(); const outsider = await db.createUser('other-server-data@example.test', 'password123', 'Other researcher');
    await db.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'analyst')", [project.id, outsider.id]);
    expect((await service.roots(outsider.id, project.id)).roots).toEqual([]);
    await expect(service.list(outsider.id, project.id, 'study')).rejects.toMatchObject({ code: 'SERVER_IMPORT_NOT_FOUND' });
    const configRoots = JSON.parse(process.env.SERVER_DATA_IMPORT_ROOTS); configRoots[0].grants.push({ projectId: project.id, ownerUserId: outsider.id }); process.env.SERVER_DATA_IMPORT_ROOTS = JSON.stringify(configRoots);
    await expect(service.start(outsider.id, project.id, request)).rejects.toMatchObject({ code: 'SERVER_IMPORT_SOURCE_CHANGED' });
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, user.id]);
    await expect(service.start(user.id, project.id, request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('rejects stale or tampered file selections before snapshot admission', async () => {
    const request = await selected(); await fs.writeFile(path.join(source, request.relativePath), 'cell,condition\nb,treated\n');
    await expect(service.start(user.id, project.id, request)).rejects.toMatchObject({ code: 'SERVER_IMPORT_SOURCE_CHANGED' });
    const fresh = (await service.list(user.id, project.id, 'study')).items[0];
    await expect(service.start(user.id, project.id, { ...request, selectionToken: fresh.selectionToken.replace(/^./, fresh.selectionToken[0] === 'a' ? 'b' : 'a') })).rejects.toMatchObject({ code: 'SERVER_IMPORT_SOURCE_CHANGED' });
    expect((await db.query('SELECT COUNT(*)::int AS count FROM server_data_imports')).rows[0].count).toBe(0);
  });
  it('rejects oversized table metadata before reserving capacity or copying a server file', async () => {
    const headers = Array.from({ length: 100 }, (_, index) => `column${index}${'x'.repeat(1000)}`).join(',');
    const copier = vi.fn(provider.putFileFromHandle); service = createServerDataImportService(db, { ...provider, putFileFromHandle: copier });
    const request = await selected('oversized-headers.csv', `${headers}\n${Array(100).fill('1').join(',')}\n`);
    await expect(service.start(user.id, project.id, request)).rejects.toMatchObject({ status: 413, code: 'INVALID_ARTIFACT_FORMAT' });
    expect(copier).not.toHaveBeenCalled();
    expect((await db.query('SELECT COUNT(*)::int AS count FROM server_data_imports')).rows[0].count).toBe(0);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM managed_artifact_versions')).rows[0].count).toBe(0);
  });
  it('rejects insufficient physical disk space before creating an import operation or snapshot', async () => {
    const copier = vi.fn(provider.putFileFromHandle); service = createServerDataImportService(db, { ...provider, putFileFromHandle: copier });
    const request = await selected();
    vi.spyOn(require('node:fs').promises, 'statfs').mockResolvedValue({ bavail: 0n, bsize: 4096n });
    await expect(service.start(user.id, project.id, request)).rejects.toMatchObject({ code: 'SERVER_IMPORT_STORAGE_PRESSURE' });
    expect(copier).not.toHaveBeenCalled();
    expect((await db.query('SELECT COUNT(*)::int AS count FROM server_data_imports')).rows[0].count).toBe(0);
  });
  it('bounds the combined UTF-8 source metadata before reserving capacity or copying bytes', async () => {
    const copier = vi.fn(provider.putFileFromHandle); service = createServerDataImportService(db, { ...provider, putFileFromHandle: copier });
    const relativeDirectory = Array.from({ length: 10 }, (_, index) => `${index}${'試'.repeat(80)}`).join('/');
    await fs.mkdir(path.join(source, relativeDirectory), { recursive: true });
    await fs.writeFile(path.join(source, relativeDirectory, 'cells.csv'), 'cell,n\na,1\n');
    const listing = await service.list(user.id, project.id, 'study', { path: relativeDirectory });
    const sampleMetadata = Object.fromEntries(['sampleId', 'condition', 'tissue', 'species', 'replicate'].map(key => [key, '試'.repeat(120)]));
    const request = { requestId: crypto.randomUUID(), rootId: 'study', relativePath: `${relativeDirectory}/cells.csv`, selectionToken: listing.items[0].selectionToken, sampleMetadata };
    await expect(service.start(user.id, project.id, request)).rejects.toMatchObject({ status: 413, code: 'SERVER_IMPORT_METADATA_INVALID' });
    expect(copier).not.toHaveBeenCalled();
    expect((await db.query('SELECT COUNT(*)::int AS count FROM server_data_imports')).rows[0].count).toBe(0);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM managed_artifact_versions')).rows[0].count).toBe(0);
  });
  it('uses the PostgreSQL JSONB byte bound when compact JSON would narrowly fit', async () => {
    const copier = vi.fn(provider.putFileFromHandle); service = createServerDataImportService(db, { ...provider, putFileFromHandle: copier });
    const relativeDirectory = Array.from({ length: 10 }, (_, index) => `${index}${'試'.repeat(67)}`).join('/');
    await fs.mkdir(path.join(source, relativeDirectory), { recursive: true });
    await fs.writeFile(path.join(source, relativeDirectory, 'cells.csv'), 'cell,n\na,1\n');
    const listing = await service.list(user.id, project.id, 'study', { path: relativeDirectory });
    const sampleMetadata = Object.fromEntries(['sampleId', 'condition', 'tissue', 'species', 'replicate'].map(key => [key, '試'.repeat(120)]));
    const request = { requestId: crypto.randomUUID(), rootId: 'study', relativePath: `${relativeDirectory}/cells.csv`, selectionToken: listing.items[0].selectionToken, sampleMetadata };
    const metadata = { root: { id: 'study', label: 'Authorized study data' }, relativePath: request.relativePath, serviceId: `svc_${'a'.repeat(32)}`, serviceLabel: 'Study server', sampleMetadata };
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThanOrEqual(4096);
    expect(Number((await db.query('SELECT octet_length($1::jsonb::text)::int AS bytes', [metadata])).rows[0].bytes)).toBeGreaterThan(4096);
    await expect(service.start(user.id, project.id, request)).rejects.toMatchObject({ status: 413, code: 'SERVER_IMPORT_METADATA_INVALID' });
    expect(copier).not.toHaveBeenCalled();
    expect((await db.query('SELECT COUNT(*)::int AS count FROM server_data_imports')).rows[0].count).toBe(0);
  });
  it('rejects traversal, hidden paths, hard links and directory junctions before opening outside data', async () => {
    const request = await selected(); await fs.writeFile(path.join(source, '.env'), 'private');
    const outside = path.join(directory, 'outside'); await fs.mkdir(outside, { recursive: true }); await fs.writeFile(path.join(outside, 'secret.csv'), 'secret,n\nx,1\n');
    await fs.symlink(outside, path.join(source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.link(path.join(outside, 'secret.csv'), path.join(source, 'linked.csv'));
    expect((await service.list(user.id, project.id, 'study')).items.map(item => item.name)).toEqual(['cells.csv']);
    for (const relativePath of ['../outside/secret.csv', '.env', 'escape/secret.csv', 'linked.csv']) await expect(service.start(user.id, project.id, { ...request, relativePath })).rejects.toMatchObject({ code: expect.stringMatching(/^SERVER_IMPORT_/) });
    await expect(openSelection({ path: source }, 'escape', true)).rejects.toMatchObject({ code: 'SERVER_IMPORT_PATH_UNSAFE' });
  });
  it('pages bounded immediate directory entries and rejects changed or forged cursors', async () => {
    for (let index = 0; index < 7; index++) await fs.writeFile(path.join(source, `sample-${index}.csv`), 'sample,n\na,1\n');
    await fs.mkdir(path.join(source, 'nested'));
    const first = await service.list(user.id, project.id, 'study', { limit: '3' }); expect(first.items).toHaveLength(3); expect(first.nextCursor).toBeTruthy();
    const second = await service.list(user.id, project.id, 'study', { limit: '3', cursor: first.nextCursor });
    expect(second.items).toHaveLength(3); expect(new Set([...first.items, ...second.items].map(item => item.name)).size).toBe(6);
    await expect(service.list(user.id, project.id, 'study', { cursor: `${first.nextCursor}x` })).rejects.toMatchObject({ code: 'SERVER_IMPORT_PAGE_INVALID' });
    await fs.writeFile(path.join(source, 'added.csv'), 'sample,n\nb,2\n');
    await expect(service.list(user.id, project.id, 'study', { cursor: first.nextCursor })).rejects.toMatchObject({ code: 'SERVER_IMPORT_PAGE_CHANGED' });
    await expect(service.list(user.id, project.id, 'study', { limit: 101 })).rejects.toMatchObject({ code: 'SERVER_IMPORT_PAGE_INVALID' });
  });
  it('rejects source changes during streaming and removes the incomplete snapshot', async () => {
    const wrapped = { ...provider, async putFileFromHandle(handle, key, options) {
      let modified = false;
      return provider.putFileFromHandle(handle, key, { ...options, onProgress: async bytes => {
        await options.onProgress(bytes); if (!modified) { modified = true; await fs.writeFile(path.join(source, 'changing.rds'), Buffer.alloc(2 * 1024 ** 2, 2)); }
      } });
    } };
    service = createServerDataImportService(db, wrapped); const request = await selected('changing.rds', Buffer.alloc(2 * 1024 ** 2, 1), service);
    const response = await completed(request, service);
    expect(response).toMatchObject({ status: 'failed', error: { code: 'SERVER_IMPORT_SOURCE_CHANGED' } });
    expect((await artifacts.list(user.id, project.id)).items).toEqual([]);
    const row = (await db.query('SELECT storage_key FROM server_data_imports WHERE request_id=$1', [request.requestId])).rows[0];
    await expect(fs.stat(provider.resolveKey(row.storage_key))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(`${provider.resolveKey(row.storage_key)}.import-partial`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reserves shared managed quota before copying and honors an already admitted reservation after a limit reduction', async () => {
    process.env.PRIVATE_R_MANAGED_QUOTA_BYTES = '40'; const held = await heldService(); service = held.value;
    const request = await selected('one.rds', Buffer.alloc(30), service); await service.start(user.id, project.id, request); await held.entered.promise;
    const second = await selected('two.rds', Buffer.alloc(30), service);
    await expect(service.start(user.id, project.id, second)).rejects.toMatchObject({ code: 'ARTIFACT_STORAGE_LIMIT' });
    process.env.PRIVATE_R_MANAGED_QUOTA_BYTES = '5'; held.release.resolve(); await service.waitForIdle();
    expect((await service.get(user.id, project.id, request.requestId)).status).toBe('succeeded');
  });
  it.each(['membership', 'root grant'])('fences completion when current %s access is revoked during a snapshot', async mode => {
    const held = await heldService(); service = held.value; const request = await selected(); await service.start(user.id, project.id, request); await held.entered.promise;
    if (mode === 'membership') await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, user.id]);
    else process.env.SERVER_DATA_IMPORT_ROOTS = '[]';
    held.release.resolve(); await service.waitForIdle();
    expect((await db.query('SELECT status FROM server_data_imports WHERE request_id=$1', [request.requestId])).rows[0].status).toBe('failed');
    expect((await db.query('SELECT COUNT(*)::int AS count FROM managed_artifact_versions')).rows[0].count).toBe(0);
  });
  it('expires interrupted requests durably without source replay or automatic replacement', async () => {
    process.env.PRIVATE_R_TRANSFER_TIMEOUT_SECONDS = '1'; const held = await heldService(); service = held.value;
    const request = await selected(); await service.start(user.id, project.id, request); await held.entered.promise;
    const recreated = createServerDataImportService(db, provider); expect((await recreated.get(user.id, project.id, request.requestId)).status).toBe('pending');
    await new Promise(resolve => setTimeout(resolve, 1150));
    expect(await recreated.get(user.id, project.id, request.requestId)).toMatchObject({ status: 'failed', error: { code: 'SERVER_IMPORT_INTERRUPTED' } });
    expect((await recreated.start(user.id, project.id, request)).status).toBe('failed');
    held.release.resolve(); await service.waitForIdle(); expect(held.copies()).toBe(1);
    expect((await artifacts.list(user.id, project.id)).items).toEqual([]);
  });
  it('serves authenticated bounded metadata through real HTTP and distinguishes missing receipts from revoked access', async () => {
    const request = await selected();
    const roots = await http.api(server, url('/roots'), { token }); expect(roots.status).toBe(200); expect(JSON.stringify(roots.data)).not.toContain(directory);
    const listing = await http.api(server, url('/roots/study/files'), { token }); expect(listing.status).toBe(200);
    request.selectionToken = listing.data.items[0].selectionToken;
    const start = await http.api(server, url('/imports'), { token, method: 'POST', body: request }); expect([200, 202]).toContain(start.status);
    let result;
    for (let attempt = 0; attempt < 50; attempt++) { result = await http.api(server, url(`/imports/${request.requestId}`), { token }); if (result.data.status !== 'pending') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    expect(result.data.status).toBe('succeeded'); expect(Buffer.byteLength(JSON.stringify(result.data))).toBeLessThan(8000);
    expect((await http.api(server, url(`/imports/${crypto.randomUUID()}`), { token })).data.code).toBe('SERVER_DATA_IMPORT_NOT_FOUND');
    expect((await http.api(server, url('/roots'))).status).toBe(401);
    await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, user.id]);
    expect((await http.api(server, url(`/imports/${request.requestId}`), { token })).data.code).toBe('NOT_FOUND');
  });
  it('rejects public demo imports and unexpected storage/identity/annotation request fields', async () => {
    const request = await selected();
    for (const value of [{ ...request, storageKey: 'outside' }, { ...request, ownerUserId: user.id }, { ...request, name: 'two\nlines' }, { ...request, sampleMetadata: { condition: 'x'.repeat(121) } }, { ...request, sampleMetadata: { storagePath: source } }]) await expect(service.start(user.id, project.id, value)).rejects.toMatchObject({ status: 400 });
    process.env.APP_DEPLOYMENT_MODE = 'demo'; await expect(service.roots(user.id, project.id)).rejects.toMatchObject({ code: 'SERVER_IMPORT_UNAVAILABLE' });
  });
});
