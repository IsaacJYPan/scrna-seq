// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const db = require('./pgDatabase');
const storage = require('./storage');
const { createArtifactVersionService } = require('./artifactVersions');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const bytes = 'gene,score\r\nA,12\r\n';
const until = async (check, message) => {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(message);
};

describe.skipIf(!process.env.DATABASE_URL)('durable local artifact import receipts and cleanup through PostgreSQL/HTTP/storage', () => {
  let directory, provider, service, server, http, owner, colleague, project, otherProject, oldRoot;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'traceomics-local-import-'));
    oldRoot = process.env.STORAGE_ROOT; process.env.STORAGE_ROOT = path.join(directory, 'storage');
    provider = storage.createLocalStorageProvider(); http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    await db.resetSchemaForTests(); service = createArtifactVersionService(db, provider);
    owner = await http.createUserWithToken({ email: 'local-import-owner@example.test' });
    colleague = await http.createUserWithToken({ email: 'local-import-colleague@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Import receipt lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Outside results' });
    otherProject = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Other results' });
    await db.addProjectMember(project.id, colleague.user.id, 'analyst');
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (oldRoot === undefined) delete process.env.STORAGE_ROOT; else process.env.STORAGE_ROOT = oldRoot;
    await db.close(); await rm(directory, { recursive: true, force: true });
  });
  const base = (p = project) => `/api/artifact-versions/${p.id}`;
  const receiptPath = requestId => `${base()}/imports/${requestId}`;
  const get = (requestId, actor = owner) => http.api(server, receiptPath(requestId), { token: actor.token });
  const count = async table => (await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
  async function file(input = {}, value = bytes, database = db, previousVersionId = null) {
    const filename = path.join(directory, crypto.randomUUID()); await writeFile(filename, value);
    return createArtifactVersionService(database, provider).importFile(owner.user.id, project.id,
      { path: filename, originalFilename: 'scores.csv', name: 'Outside scores', ...input }, previousVersionId);
  }
  async function multipart(requestId, value = bytes, { name = 'Outside scores', actor = owner, previousVersionId, originalFilename = 'scores.csv', expectedRequestSha256 } = {}) {
    const body = new FormData(); body.append('file', new Blob([value]), originalFilename); body.append('artifactType', 'auto'); body.append('name', name);
    if (requestId !== undefined) body.append('requestId', requestId);
    if (expectedRequestSha256 !== undefined) body.append('expectedRequestSha256', expectedRequestSha256);
    const response = await fetch(`http://127.0.0.1:${server.address().port}${base()}${previousVersionId ? `/${previousVersionId}/versions` : ''}`, {
      method: 'POST', headers: { Cookie: `${require('./config').sessionCookieName()}=${encodeURIComponent(actor.token)}`,
        Origin: 'http://localhost:5173', 'X-Traceomics-Csrf': '1' }, body });
    return { status: response.status, data: await response.json() };
  }

  it('binds explicit UUIDs to complete copied bytes and settings while preserving legacy multipart callers', async () => {
    const requestId = crypto.randomUUID(), created = await multipart(requestId.toUpperCase());
    expect(created.status).toBe(201); expect(created.data).toMatchObject({ sha256: sha(bytes), sourceRunId: null,
      importRequest: { requestId, status: 'succeeded', canImport: true, replayed: false, availability: 'recorded' } });
    const binding = { schema: 'traceomics.artifact-import.v1', projectId: project.id, ownerUserId: owner.user.id, requestId,
      originalFilename: 'scores.csv', name: 'Outside scores', artifactType: 'auto', previousVersionId: null, sha256: sha(bytes), sizeBytes: Buffer.byteLength(bytes) };
    expect(created.data.importRequest.request).toEqual(binding); expect(created.data.importRequest.requestSha256).toBe(sha(JSON.stringify(binding)));
    const replay = await multipart(requestId); expect(replay.status).toBe(200); expect(replay.data.versionId).toBe(created.data.versionId);
    expect(replay.data.importRequest).toMatchObject({ requestId, replayed: true });
    for (const changed of [await multipart(requestId, 'gene,score\r\nA,13\r\n'), await multipart(requestId, bytes, { name: 'Different meaning' }),
      await multipart(requestId, bytes, { previousVersionId: created.data.versionId })]) {
      expect(changed).toMatchObject({ status: 409, data: { code: 'ARTIFACT_IMPORT_REQUEST_CONFLICT' } });
    }
    expect(await count('managed_artifact_versions')).toBe(1); expect(await count('managed_artifact_import_receipts')).toBe(1);
    const accepted = await get(requestId); expect(accepted.status).toBe(200); expect(accepted.data).toMatchObject({ requestId,
      status: 'succeeded', availability: 'recorded', acceptance: { versionId: created.data.versionId, sha256: sha(bytes) }, version: { versionId: created.data.versionId } });
    expect(accepted.res.headers.get('cache-control')).toContain('no-store'); expect(JSON.stringify(accepted.data)).not.toContain(directory);
    expect(JSON.stringify(accepted.data)).not.toContain('storage_key');
    const legacy = await multipart(); expect(legacy.status).toBe(201); expect(legacy.data).not.toHaveProperty('importRequest');
    expect(await count('managed_artifact_import_receipts')).toBe(1);
    expect((await multipart('invalid UUID')).status).toBe(400);
    const unicode = await multipart(crypto.randomUUID(), bytes, { originalFilename: 'β scores.csv', name: 'β supplied result' });
    expect(unicode.status).toBe(201); expect(unicode.data.importRequest.request).toMatchObject({ originalFilename: 'β scores.csv', name: 'β supplied result' });
  });

  it('permits owner-reader recovery but keeps fresh writes, other owners, projects and revoked memberships fenced', async () => {
    const requestId = crypto.randomUUID(); await file({ requestId });
    expect((await get(requestId, colleague)).status).toBe(404);
    expect((await http.api(server, `${base(otherProject)}/imports/${requestId}`, { token: owner.token })).status).toBe(404);
    expect((await http.api(server, receiptPath(requestId))).status).toBe(401);
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    expect((await get(requestId)).data).toMatchObject({ status: 'succeeded', canImport: false, version: { sha256: sha(bytes) } });
    expect((await multipart(requestId)).status).toBe(403); expect((await multipart(crypto.randomUUID())).status).toBe(403);
    await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, owner.user.id]);
    expect((await get(requestId)).status).toBe(404); expect(await count('managed_artifact_versions')).toBe(1);
  });

  it('requires the actual uploaded bytes and settings to match an optional client-confirmed request hash', async () => {
    const requestId = crypto.randomUUID(), binding = { schema: 'traceomics.artifact-import.v1', projectId: project.id, ownerUserId: owner.user.id, requestId,
      originalFilename: 'scores.csv', name: 'Outside scores', artifactType: 'auto', previousVersionId: null, sha256: sha(bytes), sizeBytes: Buffer.byteLength(bytes) };
    const expectedRequestSha256 = sha(JSON.stringify(binding));
    const changed = await multipart(requestId, 'gene,score\r\nA,13\r\n', { expectedRequestSha256 });
    expect(changed).toMatchObject({ status: 409, data: { code: 'ARTIFACT_IMPORT_SOURCE_CHANGED' } });
    expect(await count('managed_artifact_versions')).toBe(0); expect(await count('managed_artifact_import_receipts')).toBe(0);
    const accepted = await multipart(requestId, bytes, { expectedRequestSha256 }); expect(accepted.status).toBe(201);
    expect(accepted.data.importRequest.requestSha256).toBe(expectedRequestSha256);
    expect((await multipart(requestId, 'gene,score\r\nA,13\r\n', { expectedRequestSha256 })).data.code).toBe('ARTIFACT_IMPORT_REQUEST_CONFLICT');
  });

  it('retains immutable acceptance after version or bytes disappear without claiming verified contents', async () => {
    const requestId = crypto.randomUUID(), created = await file({ requestId });
    const original = (await get(requestId)).data;
    const row = (await db.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [created.versionId])).rows[0];
    await unlink(provider.resolveKey(row.storage_key));
    expect((await get(requestId)).data).toEqual({ ...original, availability: 'unavailable', version: null });
    await db.query('DELETE FROM managed_artifact_versions WHERE id=$1', [created.versionId]);
    expect((await get(requestId)).data).toEqual({ ...original, availability: 'unavailable', version: null });
    const replay = await file({ requestId }); expect(replay).toMatchObject({ version: null, importRequest: { status: 'succeeded', replayed: true,
      availability: 'unavailable', acceptance: original.acceptance } });
    await expect(file({ requestId, name: 'Different supplied meaning' })).rejects.toMatchObject({ code: 'ARTIFACT_IMPORT_REQUEST_CONFLICT' });
    expect(await count('managed_artifact_versions')).toBe(0); expect(await count('managed_artifact_import_receipts')).toBe(1);
    await expect(db.query('UPDATE managed_artifact_import_receipts SET size_bytes=1 WHERE request_id=$1', [requestId])).rejects.toMatchObject({ code: '55000' });
    await expect(db.query('DELETE FROM managed_artifact_import_receipts WHERE request_id=$1', [requestId])).rejects.toMatchObject({ code: '55000' });
  });

  it('keeps committed bytes after a lost COMMIT acknowledgement and recovers one exact version by receipt', async () => {
    const requestId = crypto.randomUUID(), pool = await db.connect(); let lost = false;
    const uncertain = { ...db, connect: async () => ({ connect: async () => { const client = await pool.connect(); let wrote = false; return {
      query: async (sql, values) => { const result = await client.query(sql, values); if (sql.includes('INSERT INTO managed_artifact_import_receipts')) wrote = true;
        if (sql === 'COMMIT' && wrote && !lost) { lost = true; throw Object.assign(new Error('Lost original commit acknowledgement'), { code: 'ECONNRESET' }); } return result; },
      release: () => client.release(),
    }; } }) };
    await expect(file({ requestId }, bytes, uncertain)).rejects.toMatchObject({ code: 'ECONNRESET', message: 'Lost original commit acknowledgement' });
    const recovered = (await get(requestId)).data; expect(recovered).toMatchObject({ status: 'succeeded', availability: 'recorded', version: { sha256: sha(bytes) } });
    expect((await service.preview(owner.user.id, project.id, recovered.acceptance.versionId)).preview.rows).toEqual([['A', '12']]);
    expect((await file({ requestId })).versionId).toBe(recovered.acceptance.versionId);
    expect(await count('managed_artifact_versions')).toBe(1); expect(await count('managed_artifact_import_receipts')).toBe(1);
  });

  it('recovers an accepted replacement even after its former source versions were removed', async () => {
    const prior = await file(), requestId = crypto.randomUUID();
    const accepted = await file({ requestId }, bytes, db, prior.versionId);
    await db.query('DELETE FROM managed_artifact_versions WHERE id=$1', [accepted.versionId]);
    await db.query('DELETE FROM managed_artifact_versions WHERE id=$1', [prior.versionId]);
    const replay = await file({ requestId }, bytes, db, prior.versionId);
    expect(replay).toMatchObject({ version: null, importRequest: { status: 'succeeded', replayed: true,
      availability: 'unavailable', acceptance: { versionId: accepted.versionId, previousVersionId: prior.versionId } } });
    expect(await count('managed_artifact_versions')).toBe(0); expect(await count('managed_artifact_import_receipts')).toBe(1);
    await expect(file({ requestId: crypto.randomUUID() }, bytes, db, prior.versionId)).rejects.toMatchObject({ status: 404 });
  });

  it.each(['accepted', 'timeout'])('waits on the actual advisory lock and keeps uncertain bytes on %s cleanup outcome', async outcome => {
    const requestId = crypto.randomUUID(), pool = await db.connect(); let held, inserted, released;
    const releaseReached = new Promise(resolve => { released = resolve; }); let connection = 0;
    const delayed = { ...db, connect: async () => ({ connect: async () => {
      const client = await pool.connect(); if (connection++ > 0) return client;
      let uncertain = false;
      return { query: async (sql, values) => {
        if (sql === 'COMMIT') { uncertain = true; throw Object.assign(new Error('The original commit outcome is still unknown'), { code: 'ECONNRESET' }); }
        if (sql === 'ROLLBACK' && uncertain) return { rows: [], rowCount: 0 };
        const result = await client.query(sql, values); if (sql.startsWith('INSERT INTO managed_artifact_versions')) inserted = result.rows[0]; return result;
      }, release: () => { held = client; released(); } };
    } }) };
    const importing = file({ requestId }, bytes, delayed).then(() => null, error => error);
    try {
      await releaseReached;
      await until(async () => (await db.query("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'")).rows[0].n > 0,
        'The fresh cleanup transaction did not wait for the original transaction advisory lock.');
      expect(await readFile(provider.resolveKey(inserted.storage_key))).toEqual(Buffer.from(bytes));
      if (outcome === 'timeout') {
        expect(await importing).toMatchObject({ code: 'ECONNRESET' });
        expect(await readFile(provider.resolveKey(inserted.storage_key))).toEqual(Buffer.from(bytes));
        return;
      }
      await held.query('COMMIT'); held.release(); held = null;
      expect(await importing).toMatchObject({ code: 'ECONNRESET' });
      expect((await get(requestId)).data).toMatchObject({ status: 'succeeded', availability: 'recorded' });
      expect(await readFile(provider.resolveKey(inserted.storage_key))).toEqual(Buffer.from(bytes));
    } finally {
      if (held) { await held.query('ROLLBACK'); held.release(); held = null; }
      await importing;
    }
  });

  it('rolls back source and cleans only its unretained attempt when the atomic receipt insert fails', async () => {
    const existing = await file({ requestId: crypto.randomUUID() });
    const pool = await db.connect(); let attemptKey;
    const rejected = { ...db, connect: async () => ({ connect: async () => { const client = await pool.connect(); return {
      query: async (sql, values) => {
        if (sql.includes('INSERT INTO managed_artifact_import_receipts')) throw Object.assign(new Error('Receipt insert rejected'), { code: 'TEST_RECEIPT_REJECTED' });
        const result = await client.query(sql, values); if (sql.startsWith('INSERT INTO managed_artifact_versions')) attemptKey = result.rows[0].storage_key; return result;
      }, release: () => client.release(),
    }; } }) };
    await expect(file({ requestId: crypto.randomUUID() }, bytes, rejected)).rejects.toMatchObject({ code: 'TEST_RECEIPT_REJECTED' });
    await expect(readFile(provider.resolveKey(attemptKey))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await service.preview(owner.user.id, project.id, existing.versionId)).preview.rows).toEqual([['A', '12']]);
    expect(await count('managed_artifact_versions')).toBe(1); expect(await count('managed_artifact_import_receipts')).toBe(1);
  });

  it('keeps the exact owned file when a failed write cannot obtain a fresh cleanup proof', async () => {
    const pool = await db.connect(); let attempts = 0, attemptKey;
    const unavailable = { ...db, connect: async () => ({ connect: async () => {
      if (attempts++ > 0) throw new Error('The cleanup database is unavailable');
      const client = await pool.connect();
      return { query: async (sql, values) => {
        if (sql.includes('INSERT INTO managed_artifact_import_receipts')) throw Object.assign(new Error('The original receipt write failed'), { code: 'TEST_ORIGINAL_FAILURE' });
        const result = await client.query(sql, values); if (sql.startsWith('INSERT INTO managed_artifact_versions')) attemptKey = result.rows[0].storage_key; return result;
      }, release: () => client.release() };
    } }) };
    await expect(file({ requestId: crypto.randomUUID() }, bytes, unavailable)).rejects.toMatchObject({ code: 'TEST_ORIGINAL_FAILURE' });
    expect(await count('managed_artifact_versions')).toBe(0); expect(await count('managed_artifact_import_receipts')).toBe(0);
    expect(await readFile(provider.resolveKey(attemptKey))).toEqual(Buffer.from(bytes));
  });

  it('deletes expired demo receipts only through the deliberate scoped lifecycle cleanup', async () => {
    await file({ requestId: crypto.randomUUID() });
    const organization = await db.createOrganizationForUser(colleague.user.id, { name: 'Persistent outside lab' });
    const retainedProject = await db.createProjectForUser(colleague.user.id, { organizationId: organization.id, name: 'Persistent outside study' });
    const source = path.join(directory, crypto.randomUUID()); await writeFile(source, bytes);
    const requestId = crypto.randomUUID();
    const retained = await service.importFile(colleague.user.id, retainedProject.id, { path: source, originalFilename: 'retained.csv', requestId });
    await db.query("UPDATE users SET is_demo_guest=TRUE,expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [owner.user.id]);
    expect(await db.deleteExpiredDemoGuest(owner.user.id)).toBe(true);
    expect(await count('managed_artifact_import_receipts')).toBe(1);
    expect((await service.getImportReceipt(colleague.user.id, retainedProject.id, requestId)).acceptance.versionId).toBe(retained.versionId);
  });
});
