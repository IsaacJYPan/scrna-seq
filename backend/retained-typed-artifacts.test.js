// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const db = require('./pgDatabase');
const storage = require('./storage');
const { createArtifactVersionService } = require('./artifactVersions');
const { validateWorkflowOutput } = require('./workflowOutputs');
const configured = Boolean(process.env.DATABASE_URL);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=', 'base64');
let directory, provider, service, server, http, user, token, project, previous;

describe.skipIf(!configured)('typed retained results through real PostgreSQL/storage/HTTP', () => {
  beforeAll(async () => {
    previous = { APP_DEPLOYMENT_MODE: process.env.APP_DEPLOYMENT_MODE, STORAGE_ROOT: process.env.STORAGE_ROOT };
    directory = await mkdtemp(path.join(os.tmpdir(), 'retained-typed-test-'));
    Object.assign(process.env, { APP_DEPLOYMENT_MODE: 'private', STORAGE_ROOT: path.join(directory, 'storage') });
    provider = { ...storage.createLocalStorageProvider() }; service = createArtifactVersionService(db, provider);
    http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); await db.resetSchemaForTests();
    ({ user, token } = await http.createUserWithToken({ email: 'typed-owner@example.test', displayName: 'Typed owner' }));
    const organization = await db.createOrganizationForUser(user.id, { name: 'Retained lab' });
    project = await db.createProjectForUser(user.id, { organizationId: organization.id, name: 'Typed study' });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (server) await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous || {})) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await db.close(); if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function retained(type, value, { validated = true, descriptorChanges = {} } = {}) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const job = await db.createProjectJob(user.id, project.id, { jobType: 'generic' });
    const id = 'eri_' + crypto.randomBytes(12).toString('hex');
    const key = storage.projectStorageFileKey(project.id, 'artifacts', job.id, id + '.data');
    const descriptor = { id, type, sha256: sha(bytes), sizeBytes: bytes.length, ...descriptorChanges };
    await writeFile(provider.prepareWrite(key), bytes);
    if (validated) await validateWorkflowOutput(provider, key, descriptor);
    // Retained-record fixture only: no scientific executor or completed run is claimed.
    await db.query('INSERT INTO workflow_artifacts(id,owner_user_id,project_id,job_id,descriptor_json,storage_key) VALUES($1,$2,$3,$4,$5,$6)', [id, user.id, project.id, job.id, descriptor, key]);
    return { id, key, bytes, descriptor };
  }
  const url = (id, suffix = '') => `/api/artifact-versions/${project.id}/${id}${suffix}`;
  const get = (id, suffix = '', requestToken = token) => http.api(server, url(id, suffix), { token: requestToken });

  it('binds exact trusted scalar metrics, retains zero/false/null/text, and never infers semantics from generic JSON', async () => {
    const record = await retained('metrics', { cells: 0, passed: false, absent: null, note: '<script>inert</script>' });
    const response = await get(record.id, '/preview');
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({ integrityVerified: true, version: { previews: ['metrics'] }, preview: {
      family: 'metrics', source: { artifactId: record.id, versionId: record.id, projectId: project.id, sha256: sha(record.bytes) }, semantics: { role: null, title: null },
      items: [{ key: 'cells', value: 0, label: null, unit: null }, { key: 'passed', value: false }, { key: 'absent', value: null }, { key: 'note', value: '<script>inert</script>' }],
    } });
    expect(JSON.stringify(response.data)).not.toContain(record.key);
    const source = path.join(directory, 'generic.json'); await writeFile(source, JSON.stringify({ cells: 0, x: [1], y: [2] }));
    const generic = await service.importFile(user.id, project.id, { path: source, originalFilename: 'generic.json' });
    expect((await get(generic.versionId, '/preview')).data.preview.family).not.toBe('metrics');
    expect((await get(record.id, '/preview?pointLimit=0')).status).toBe(400);
    expect((await get(record.id, '/preview?pointLimit=500&pointLimit=1000')).status).toBe(400);
    expect((await get(record.id, '/preview?pointLimit[]=500')).status).toBe(400);
    expect((await get(record.id, '/preview?pointLimit[value]=500')).status).toBe(400);
  });
  it('samples actual retained coordinates reproducibly within the whole HTTP envelope, including long source IDs', async () => {
    const count = 10000;
    const record = await retained('scatter', { x: Array.from({ length: count }, (_, i) => i), y: Array.from({ length: count }, (_, i) => i % 71),
      ids: Array.from({ length: count }, (_, i) => `source-${i}-` + 'x'.repeat(170)), groups: Array.from({ length: count }, (_, i) => i % 2 ? 'Group A' : 'Group B') });
    const first = await get(record.id, '/preview?pointLimit=5000'), second = await get(record.id, '/preview?pointLimit=5000');
    expect(first.status).toBe(200); expect(second.data).toEqual(first.data);
    const preview = first.data.preview;
    expect(preview).toMatchObject({ family: 'embedding', semantics: { entityType: null, axes: { x: { label: null, unit: null } } }, sampling: { method: 'sha256-priority-v1', sourceCount: count, sampled: true, budgetLimited: true, aggregated: false, stratified: false } });
    expect(preview.x.length).toBeGreaterThan(500); expect(preview.x.length).toBeLessThan(5000);
    expect(preview.sourceIndices.every((index, at) => preview.x[at] === index && preview.ids[at].startsWith(`source-${index}-`))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first.data))).toBeLessThanOrEqual(256 * 1024);
    const smaller = await get(record.id, '/preview?pointLimit=500');
    expect(smaller.data.preview.sourceIndices).toEqual(preview.sourceIndices.slice(0, 500));
  });
  it('retains private source permissions for members and wrong projects and denies changed bytes/descriptors', async () => {
    const record = await retained('metrics', { cells: 12 });
    const other = await http.createUserWithToken({ email: 'typed-viewer@example.test' });
    await db.addProjectMemberByEmail(project.id, other.user.email, 'admin', { userId: user.id });
    expect((await get(record.id, '/preview', other.token)).status).toBe(404);
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, user.id]);
    expect((await get(record.id, '/preview')).status).toBe(200);
    const organization = await db.createOrganizationForUser(other.user.id, { name: 'Other lab' });
    const unrelated = await db.createProjectForUser(other.user.id, { organizationId: organization.id, name: 'Other study' });
    expect((await http.api(server, `/api/artifact-versions/${unrelated.id}/${record.id}/preview`, { token: other.token })).status).toBe(404);
    await writeFile(provider.resolveKey(record.key), '{"cells":99}');
    expect((await get(record.id, '/preview')).status).toBe(409);
    await writeFile(provider.resolveKey(record.key), record.bytes);
    await db.query('UPDATE workflow_artifacts SET descriptor_json=$2 WHERE id=$1', [record.id, { ...record.descriptor, id: 'eri_' + 'f'.repeat(24) }]);
    expect((await get(record.id, '/preview')).status).toBe(409);
  });
  it('rechecks revocation during the actual bounded read and closes the handle before returning any projection', async () => {
    const record = await retained('metrics', { count: 12 });
    const open = provider.openVerifiedRead;
    let handle;
    vi.spyOn(provider, 'openVerifiedRead').mockImplementation(async (...args) => {
      const opened = await open(...args); handle = opened.handle;
      const read = handle.read.bind(handle); let revoked = false;
      handle.read = async (...parameters) => {
        const result = await read(...parameters);
        if (!revoked) { revoked = true; await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, user.id]); }
        return result;
      };
      return opened;
    });
    await expect(service.preview(user.id, project.id, record.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(handle.stat()).rejects.toThrow();
  });
  it('validates verified PNG dimensions on preview and direct image delivery, including oversized producer figures', async () => {
    const record = await retained('figure', png);
    expect((await get(record.id, '/preview')).data.preview).toMatchObject({ family: 'image', width: 1, height: 1 });
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url(record.id, '/image')}`, { headers: { Cookie: `${require('./config').sessionCookieName()}=${token}` } });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    // Synthetic header-only negative fixture: accepted legacy producer bounds,
    // deliberately exceeds current browser pixel limits; not a readable figure.
    const oversized = Buffer.from(png); oversized.writeUInt32BE(4000, 16); oversized.writeUInt32BE(4000, 20);
    const large = await retained('figure', oversized);
    expect((await get(large.id, '/preview')).data).toMatchObject({ integrityVerified: true, preview: { family: 'metadata' } });
    expect((await get(large.id, '/image')).status).toBe(413);
    const invalid = await retained('figure', Buffer.from('<html>not a raster</html>'), { validated: false });
    expect((await get(invalid.id, '/image')).status).toBe(400);
  });
  it('denies a source changed between verification and the typed byte snapshot', async () => {
    const record = await retained('metrics', { count: 12 });
    const open = provider.openVerifiedRead;
    vi.spyOn(provider, 'openVerifiedRead').mockImplementation(async (...args) => {
      const opened = await open(...args);
      await writeFile(provider.resolveKey(record.key), '{"count":99}');
      return opened;
    });
    await expect(service.preview(user.id, project.id, record.id)).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_FAILED', status: 409 });
  });
});
