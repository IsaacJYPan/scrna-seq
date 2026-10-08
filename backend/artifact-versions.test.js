import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const db = require('./pgDatabase');
const storage = require('./storage');
const { createArtifactVersionService } = require('./artifactVersions');
const configured = Boolean(process.env.DATABASE_URL);
const settings = ['APP_DEPLOYMENT_MODE', 'STORAGE_ROOT'];
let directory, provider, service, server, http, user, token, project, savedSettings;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=', 'base64');

describe.skipIf(!configured)('immutable artifact versions with real HTTP/storage/PostgreSQL', () => {
  beforeAll(async () => {
    savedSettings = Object.fromEntries(settings.map(key => [key, process.env[key]]));
    directory = await mkdtemp(path.join(os.tmpdir(), 'traceomics-artifacts-test-'));
    Object.assign(process.env, { APP_DEPLOYMENT_MODE: 'private', STORAGE_ROOT: path.join(directory, 'storage') });
    provider = { ...storage.createLocalStorageProvider() }; service = createArtifactVersionService(db, provider);
    http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); process.env.APP_DEPLOYMENT_MODE = 'private';
    await db.resetSchemaForTests();
    ({ user, token } = await http.createUserWithToken({ email: 'artifact-owner@example.test', displayName: 'Artifact owner' }));
    const organization = await db.createOrganizationForUser(user.id, { name: 'Artifact lab' });
    project = await db.createProjectForUser(user.id, { organizationId: organization.id, name: 'Artifact study' });
  });
  afterAll(async () => {
    if (!configured) return;
    vi.restoreAllMocks();
    if (server) await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(savedSettings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await db.close(); await rm(directory, { recursive: true, force: true });
  });
  async function file(filename, bytes, options = {}, previousVersionId) {
    const source = path.join(directory, crypto.randomUUID()); await writeFile(source, bytes);
    return service.importFile(user.id, project.id, { path: source, originalFilename: filename, ...options }, previousVersionId);
  }
  const url = suffix => `/api/artifact-versions/${project.id}${suffix || ''}`;
  const get = suffix => http.api(server, url(suffix), { token });
  async function multipart(filename, bytes, { suffix = '', artifactType = 'auto', name, requestToken = token } = {}) {
    const body = new FormData(); body.append('file', new Blob([bytes]), filename); body.append('artifactType', artifactType); if (name) body.append('name', name);
    const cookie = require('./config').sessionCookieName();
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url(suffix)}`, { method: 'POST', headers: { Cookie: `${cookie}=${encodeURIComponent(requestToken)}`, Origin: 'http://localhost:5173', 'X-Traceomics-Csrf': '1' }, body });
    return { status: response.status, data: await response.json() };
  }

  it('imports a sample sheet through HTTP and exposes exact immutable metadata plus quoted table preview', async () => {
    const bytes = 'sample,condition,note\na,control,"one, two"\nb,treated,"line 1\nline 2"\n';
    const imported = await multipart('samples.csv', bytes, { artifactType: 'sample-sheet', name: 'Study samples' });
    expect(imported.status).toBe(201);
    const version = imported.data;
    expect(version).toMatchObject({ artifactId: expect.stringMatching(/^af_/), versionId: expect.stringMatching(/^av_/), type: 'sample-sheet', sha256: sha(bytes), sizeBytes: Buffer.byteLength(bytes), owner: { displayName: 'Artifact owner' }, sourceRunId: null, previews: ['table'] });
    expect(JSON.stringify(version)).not.toContain('storage_key'); expect(JSON.stringify(version)).not.toContain(directory);
    expect((await get('')).data.items.map(item => item.versionId)).toContain(version.versionId);
    const preview = await get(`/${version.versionId}/preview?limit=1`);
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({ integrityVerified: true, preview: { columns: ['sample', 'condition', 'note'], rows: [['a', 'control', 'one, two']], hasMore: true } });
    expect(Buffer.byteLength(JSON.stringify(preview.data))).toBeLessThan(256 * 1024);
    expect((await get(`/${version.versionId}/preview?offset=1&limit=1`)).data.preview.rows).toEqual([['b', 'treated', 'line 1\nline 2']]);
  });
  it('retains old bytes and stable artifact identity while concurrent replacements receive distinct versions', async () => {
    const first = await file('score.csv', 'gene,score\nA,1\n');
    const next = await Promise.all([file('score.csv', 'gene,score\nA,2\n', {}, first.versionId), file('score.csv', 'gene,score\nA,3\n', {}, first.versionId)]);
    expect(next.map(item => item.versionNumber).sort()).toEqual([2, 3]);
    expect(next.every(item => item.artifactId === first.artifactId && item.previousVersionId === first.versionId)).toBe(true);
    expect(new Set([first.versionId, ...next.map(item => item.versionId)]).size).toBe(3);
    expect((await service.preview(user.id, project.id, first.versionId)).preview.rows).toEqual([['A', '1']]);
    expect((await service.get(user.id, project.id, first.versionId)).sha256).toBe(first.sha256);
    await expect(file('score.json', '{}', {}, first.versionId)).rejects.toMatchObject({ code: 'ARTIFACT_FORMAT_CHANGED' });
  });
  it('rejects unsupported sample-sheet formats and oversized metadata before publishing a version', async () => {
    expect((await multipart('samples.unknown', 'sample,condition\na,control', { artifactType: 'sample-sheet' })).status).toBe(400);
    const headers = Array.from({ length: 100 }, (_, index) => 'column' + index + 'x'.repeat(1000)).join(',');
    const imported = await multipart('oversized-headers.csv', headers + '\n' + Array(100).fill('1').join(','));
    expect(imported).toMatchObject({ status: 413, data: { code: 'INVALID_ARTIFACT_FORMAT' } });
    expect((await get('')).data.items).toEqual([]);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM managed_artifact_versions')).rows[0].count).toBe(0);
  });
  it('verifies raster bytes and exposes metadata-only RDS/SVG without deserialization', async () => {
    const image = await file('histology.png', png);
    expect((await get(`/${image.versionId}/preview`)).data.preview).toMatchObject({ family: 'image', width: 1, height: 1 });
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url(`/${image.versionId}/image`)}`, { headers: { Cookie: `${require('./config').sessionCookieName()}=${token}` } });
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    const object = await file('untrusted.rds', Buffer.from('arbitrary serialization placeholder'));
    expect(object.previews).toEqual([]);
    expect((await service.preview(user.id, project.id, object.versionId)).preview.family).toBe('metadata');
    const svg = await file('active.svg', '<svg onload="alert(1)"></svg>');
    expect(svg.previews).toEqual([]); expect((await get(`/${svg.versionId}/image`)).status).toBe(404);
    await expect(file('fake.png', '<html>not a raster</html>')).rejects.toThrow(/supported PNG/);
  });
  it('blocks wrong-project and mismatched version references before actual-byte inspection', async () => {
    const version = await file('table.csv', 'gene,score\nA,1');
    const organization = await db.createOrganizationForUser(user.id, { name: 'Other lab' });
    const other = await db.createProjectForUser(user.id, { organizationId: organization.id, name: 'Other study' });
    const opened = vi.spyOn(provider, 'openVerifiedRead');
    await expect(service.resolveVerified(user.id, other.id, version.reference)).rejects.toMatchObject({ status: 404 });
    await expect(service.resolveVerified(user.id, project.id, { ...version.reference, sha256: 'a'.repeat(64) }, { purpose: 'execution' })).rejects.toMatchObject({ code: 'ARTIFACT_VERSION_CHANGED', status: 409 });
    expect(opened).not.toHaveBeenCalled();
  });
  it('rejects on-disk corruption before preview or executor access and preserves other versions', async () => {
    const old = await file('table.csv', 'gene,score\nA,1');
    const current = await file('table.csv', 'gene,score\nA,2', {}, old.versionId);
    const row = (await db.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [current.versionId])).rows[0];
    await writeFile(provider.resolveKey(row.storage_key), 'gene,score\nA,9');
    await expect(service.resolveVerified(user.id, project.id, current.reference, { purpose: 'execution' })).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_FAILED', status: 409 });
    expect((await get(`/${current.versionId}/preview`)).status).toBe(409);
    expect((await service.preview(user.id, project.id, old.versionId)).preview.rows).toEqual([['A', '1']]);
  });
  it('rechecks membership after hashing and closes the handle if access was revoked during verification', async () => {
    const owner = await http.createUserWithToken({ email: 'other-owner@example.test' });
    await db.addProjectMemberByEmail(project.id, owner.user.email, 'owner', { userId: user.id });
    const version = await file('table.csv', 'gene,score\nA,1');
    const open = provider.openVerifiedRead;
    let handle;
    vi.spyOn(provider, 'openVerifiedRead').mockImplementation(async (...args) => {
      const verified = await open(...args); handle = verified.handle;
      await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, user.id]);
      return verified;
    });
    await expect(service.resolveVerified(user.id, project.id, version.reference)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(handle.stat()).rejects.toThrow();
  });
  it('keeps managed imports private and forbids viewer/public-demo uploads', async () => {
    const version = await file('table.csv', 'gene,score\nA,1');
    const viewer = await http.createUserWithToken({ email: 'artifact-viewer@example.test' });
    await db.addProjectMemberByEmail(project.id, viewer.user.email, 'viewer', { userId: user.id });
    expect((await http.api(server, url(''), { token: viewer.token })).data.items).toEqual([]);
    expect((await http.api(server, url(`/${version.versionId}`), { token: viewer.token })).status).toBe(404);
    expect((await multipart('table.csv', 'a\n1', { requestToken: viewer.token })).status).toBe(403);
    process.env.APP_DEPLOYMENT_MODE = 'demo';
    expect((await multipart('table.csv', 'a\n1')).status).toBe(403);
  });
  it('paginates timestamp ties without losing microsecond records and bounds cursors', async () => {
    const base = await file('table.csv', 'gene,score\nA,1');
    const original=(await db.query('SELECT * FROM managed_artifact_versions WHERE id=$1',[base.versionId])).rows[0];
    const versions=[];
    for (let index=0;index<4;index++) {
      const versionId='av_'+crypto.randomBytes(12).toString('hex');
      const key=storage.projectStorageFileKey(project.id,'artifacts',versionId,'content.csv');await provider.copyVerified(original.storage_key,key,{checksumSha256:original.checksum_sha256,sizeBytes:original.size_bytes});
      await db.query(`INSERT INTO managed_artifact_versions(id,artifact_id,project_id,owner_user_id,name,version_number,artifact_type,format_json,mime_type,checksum_sha256,size_bytes,storage_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz)`,[versionId,original.artifact_id,project.id,user.id,original.name,index+2,original.artifact_type,original.format_json,original.mime_type,original.checksum_sha256,original.size_bytes,key,`2026-10-08T00:00:00.12300${index}Z`]);
      versions.push({versionId});
    }
    await db.query('DELETE FROM managed_artifact_versions WHERE id=$1',[base.versionId]);
    const collected = []; let before;
    do {
      const page = await service.list(user.id, project.id, { limit: 1, before });
      collected.push(...page.items.map(item => item.versionId)); before = page.nextCursor;
    } while (before);
    expect(new Set(collected)).toEqual(new Set(versions.map(item => item.versionId))); expect(collected.length).toBe(4);
    await expect(service.list(user.id, project.id, { before: 'x'.repeat(257) })).rejects.toMatchObject({ code: 'INVALID_ARTIFACT_PAGE' });
  });
  it('adapts an existing checkpoint without reading it into the shared R process', async () => {
    const object = await db.createProjectAnalysisObject(user.id, project.id, { objectType: 'seurat', displayName: 'Saved analysis' });
    const job = await db.createProjectJob(user.id, project.id, { jobType: 'generic', analysisObjectId: object.id });
    const key = storage.projectStorageFileKey(project.id, 'checkpoints', job.id, 'checkpoint.rds');
    const bytes = Buffer.from('opaque checkpoint placeholder'); await writeFile(provider.prepareWrite(key), bytes);
    const artifactId = db.genId('art');
    await db.query("INSERT INTO job_artifacts(id,project_id,job_id,created_by_user_id,artifact_type,result_analysis_object_id,storage_kind,storage_uri,checksum_sha256,size_bytes,status) VALUES($1,$2,$3,$4,'checkpoint',$5,'local_internal',$6,$7,$8,'available')", [artifactId, project.id, job.id, user.id, object.id, key, sha(bytes), bytes.length]);
    const version = await service.get(user.id, project.id, artifactId);
    expect(version).toMatchObject({ type: 'object', format: { id: 'org.traceomics.seurat-checkpoint' }, sourceRunId: job.id, previews: [] });
    const verified = await service.resolveVerified(user.id, project.id, version.reference, { purpose: 'execution' });
    expect(verified.checksumSha256).toBe(sha(bytes)); await verified.handle.close();
  });
});
