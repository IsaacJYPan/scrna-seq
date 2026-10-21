import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ANALYSIS_ATTACHMENT_SCHEMA, normalizeAnalysisAttachmentCreate, canonicalAnalysisAttachmentContent } from '../shared/analysisAttachment.mjs';

const db = require('./pgDatabase');
const storage = require('./storage');
const { createAnalysisAttachmentService } = require('./analysisAttachments');
const { createArtifactVersionService } = require('./artifactVersions');
const { createResearchAnalysisService } = require('./researchAnalyses');
let http;
const sha = value => createHash('sha256').update(value).digest('hex');
const id = prefix => `${prefix}_${randomBytes(12).toString('hex')}`;
const ref = { kind: 'artifact-version', versionId: 'av_' + 'a'.repeat(24), sha256: 'b'.repeat(64) };
// Synthetic 3x2 JPEG, also used by the notebook source-interchange acceptance.
const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDm9bllj1W4jjkdEVtqqrEAADgAUUUV9HhP93h6L8j8wzH/AHyr/il+bP/Z';
const body = (reference = ref, extra = {}) => ({ requestId: randomUUID(), reference, caption: 'Outside treatment scores',
  suppliedOrigin: { origin: 'Supplied by researcher; not verified execution', sourceReference: 'doi:example', documentReference: null, environmentReference: 'R supplied by author' }, ...extra });
const until = async (check, message) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(message);
};

describe('analysis attachment plain source-free contract', () => {
  it('binds normalized content independently of UUID and preserves scientific Unicode and multiline notes', () => {
    const value = normalizeAnalysisAttachmentCreate(body(ref, { caption: '  β scores\r\nControl vs treatment  ',
      suppliedOrigin: { origin: '  supplied\r\nby author ', sourceReference: '', documentReference: null } }));
    expect(value).toMatchObject({ caption: 'β scores\nControl vs treatment', suppliedOrigin: {
      origin: 'supplied\nby author', sourceReference: null, documentReference: null, environmentReference: null } });
    expect(ANALYSIS_ATTACHMENT_SCHEMA).toBe('traceomics.analysis-attachment.v1');
    expect(canonicalAnalysisAttachmentContent(value)).toBe(canonicalAnalysisAttachmentContent({ ...value, requestId: randomUUID() }));
    expect(canonicalAnalysisAttachmentContent({ reference: value.reference, caption: value.caption, suppliedOrigin: value.suppliedOrigin }))
      .toBe(JSON.stringify({ reference: value.reference, caption: value.caption, suppliedOrigin: value.suppliedOrigin }));
    expect(normalizeAnalysisAttachmentCreate(body(ref, { caption: '🧬'.repeat(2000) })).caption).toHaveLength(4000);
  });
  it('rejects unknown fields, accessors, prototype objects, invalid identities and oversized or control notes without reading getters', () => {
    let accessed = false;
    const getter = { ...body() }; Object.defineProperty(getter, 'caption', { enumerable: true, get() { accessed = true; return 'unsafe'; } });
    for (const value of [getter, Object.assign(Object.create({ hidden: true }), body()), { ...body(), bytes: [1] },
      body({ ...ref, filename: 'private.csv' }), body({ ...ref, versionId: 'art_' + 'a'.repeat(24) }),
      body(ref, { requestId: 'bad' }), body(ref, { caption: '' }), body(ref, { caption: '\uD800' }), body(ref, { caption: 'a\0b' }),
      body(ref, { caption: 'x'.repeat(2001) }), body(ref, { suppliedOrigin: { origin: 'x'.repeat(2001) } }),
      body(ref, { suppliedOrigin: { verified: true } })]) expect(() => normalizeAnalysisAttachmentCreate(value)).toThrow();
    expect(accessed).toBe(false);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('analysis attachment PostgreSQL/HTTP/storage boundaries', () => {
  let directory, provider, service, server, owner, colleague, viewer, outsider, project, analysis, otherProject, oldRoot;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'traceomics-attachments-'));
    oldRoot = process.env.STORAGE_ROOT; process.env.STORAGE_ROOT = path.join(directory, 'storage');
    provider = storage.createLocalStorageProvider(); http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    await db.resetSchemaForTests(); service = createAnalysisAttachmentService(db, provider);
    owner = await http.createUserWithToken({ email: 'attachment-owner@example.test' });
    colleague = await http.createUserWithToken({ email: 'attachment-colleague@example.test' });
    viewer = await http.createUserWithToken({ email: 'attachment-reader@example.test' });
    outsider = await http.createUserWithToken({ email: 'attachment-outsider@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Outside results lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Attachment study' });
    otherProject = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Other study' });
    await db.addProjectMember(project.id, colleague.user.id, 'analyst'); await db.addProjectMember(project.id, viewer.user.id, 'viewer');
    analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Outside treatment' })).analysis;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (oldRoot === undefined) delete process.env.STORAGE_ROOT; else process.env.STORAGE_ROOT = oldRoot;
    await db.close(); await rm(directory, { recursive: true, force: true });
  });
  const base = (p = project, a = analysis) => `/api/projects/${p.id}/analyses/${a.id}/attachments`;
  const post = (value, actor = owner) => http.api(server, base(), { method: 'POST', token: actor.token, body: value });
  const get = (suffix = '', actor = owner) => http.api(server, base() + suffix, { token: actor.token });
  async function source(actor = owner, filename = 'private-original.csv', bytes = 'gene,score\nA,12\n', targetProject = project) {
    const sourcePath = path.join(directory, randomUUID()); await writeFile(sourcePath, bytes);
    return createArtifactVersionService(db, provider).importFile(actor.user.id, targetProject.id, {
      path: sourcePath, originalFilename: filename, name: 'Owner private filename.csv' });
  }
  const reference = value => ({ kind: 'artifact-version', versionId: value.versionId, sha256: value.sha256 });
  const count = async table => (await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
  async function appendForFutureCorrection(attachment, request) {
    const head = attachment.attachment;
    return (await service.correct(owner.user.id, project.id, analysis.id, head.id,
      { ...request, expectedHeadRevisionId: head.headRevisionId })).acceptedRevision.id;
  }

  it('adds a captioned exact owned result without changing analysis CAS or fabricating execution/provenance', async () => {
    const saved = await source(), value = body(reference(saved));
    const response = await post(value); expect(response.status).toBe(201);
    expect(response.data).toMatchObject({ projectId: project.id, analysisId: analysis.id, canWrite: true, replayed: false,
      requestId: value.requestId, requestSha256: sha(canonicalAnalysisAttachmentContent(value)), attachment: { sourceAccess: 'available' },
      acceptedRevision: { revisionNumber: 1, reference: reference(saved), caption: value.caption, suppliedOrigin: value.suppliedOrigin, createdByUserId: owner.user.id } });
    expect(response.data.acceptedRevision.id).toMatch(/^rar_[a-f0-9]{24}$/); expect(response.data.attachment.id).toMatch(/^raa_[a-f0-9]{24}$/);
    expect(response.data.attachment.headRevisionId).toBe(response.data.acceptedRevision.id);
    expect(response.data.attachment.revision).toEqual(response.data.acceptedRevision);
    expect((await createResearchAnalysisService().get(owner.user.id, project.id, analysis.id)).analysis).toEqual(analysis);
    expect(await count('research_analysis_revisions')).toBe(1);
    for (const table of ['jobs', 'private_r_executions', 'private_r_kernels', 'workflow_runs']) expect(await count(table)).toBe(0);
    expect(JSON.stringify(response.data)).not.toContain('private-original.csv'); expect(JSON.stringify(response.data)).not.toContain('storage_key');
    expect(response.res.headers.get('cache-control')).toContain('no-store');
    expect((await get(`/requests/${value.requestId}`)).data).toMatchObject({ acceptedRevision: response.data.acceptedRevision, replayed: true });
  });

  it('shares supplied captions and exact identities while keeping every other account source-private', async () => {
    const saved = await source(), value = body(reference(saved)); await post(value);
    const listed = await get('', viewer); expect(listed.status).toBe(200); expect(listed.data.canWrite).toBe(false);
    expect(listed.data.attachments[0]).toMatchObject({ revision: { reference: value.reference, caption: value.caption }, sourceAccess: 'restricted' });
    expect(JSON.stringify(listed.data)).not.toContain(saved.name); expect((await get('/options', colleague)).data.items).toEqual([]);
    expect((await get(`/requests/${value.requestId}`, colleague)).status).toBe(404);
    expect((await post(body(value.reference), colleague)).status).toBe(404);
    expect((await http.api(server, `/api/artifact-versions/${project.id}/${saved.versionId}/preview`, { token: viewer.token })).status).toBe(404);
    expect((await get('', outsider)).status).toBe(404); expect((await http.api(server, base())).status).toBe(401);
    expect((await http.api(server, base(otherProject), { token: owner.token })).status).toBe(404);
  });

  it('bounds and pages only supported owned source options and current attachment heads without duplicate cursors', async () => {
    const csv = await source(), tsv = await source(owner, 'table.tsv', 'gene\tscore\nA\t12\n');
    const png = await source(owner, 'figure.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7xkAAAAASUVORK5CYII=', 'base64'));
    const jpg = await source(owner, 'figure.jpeg', Buffer.from(jpeg, 'base64'));
    await source(owner, 'notes.txt', 'unverified supplied notes'); await source(colleague);
    const optionIds = []; let cursor;
    do {
      const response = await get('/options?limit=1' + (cursor ? `&cursor=${cursor}` : '')); expect(response.status).toBe(200);
      expect(response.data.items).toHaveLength(1); optionIds.push(response.data.items[0].reference.versionId); cursor = response.data.nextCursor;
      expect(response.data.items[0].format.version).toBe('1');
    } while (cursor);
    expect(new Set(optionIds)).toEqual(new Set([csv.versionId, tsv.versionId, png.versionId, jpg.versionId]));
    for (const image of [png, jpg]) {
      const accepted = await service.create(owner.user.id, project.id, analysis.id, body(reference(image)));
      expect(accepted.attachment.sourceAccess).toBe('available');
    }
    for (let n = 0; n < 3; n++) await post(body(reference(csv), { caption: `Outside result ${n}` }));
    const first = await get('?limit=2'), second = await get(`?limit=2&cursor=${first.data.nextCursor}`), third = await get(`?limit=2&cursor=${second.data.nextCursor}`);
    expect(first.data.attachments).toHaveLength(2); expect(second.data.attachments).toHaveLength(2); expect(third.data.attachments).toHaveLength(1); expect(third.data.nextCursor).toBeNull();
    expect(new Set([...first.data.attachments, ...second.data.attachments, ...third.data.attachments].map(item => item.id)).size).toBe(5);
    for (const suffix of ['?limit=31', '?limit=0', '?cursor=bad', '?extra=source', '/options?cursor=' + 'x'.repeat(257)]) expect((await get(suffix)).status).toBe(400);
  });

  it('verifies actual owned bytes and rejects wrong checksums, removed files and unsupported sources before admission', async () => {
    const saved = await source(), sourceRow = (await db.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [saved.versionId])).rows[0];
    expect((await post(body({ ...reference(saved), sha256: '0'.repeat(64) }))).status).toBe(404);
    const txt = await source(owner, 'notes.txt', 'plain text'); expect((await post(body(reference(txt)))).status).toBe(404);
    await writeFile(provider.resolveKey(sourceRow.storage_key), 'gene,score\nA,99\n');
    expect((await post(body(reference(saved)))).data.code).toBe('ANALYSIS_ATTACHMENT_SOURCE_UNAVAILABLE');
    await unlink(provider.resolveKey(sourceRow.storage_key)); expect((await post(body(reference(saved)))).status).toBe(409);
    expect(await count('research_analysis_attachments')).toBe(0); expect(await count('research_analysis_attachment_revisions')).toBe(0);
  });

  it('recovers exact accepted revision after a newer head, reader downgrade, archive and source deletion', async () => {
    const saved = await source(), value = body(reference(saved)), first = await post(value);
    const newer = await appendForFutureCorrection(first.data, body(value.reference, { caption: 'Later corrected caption' }));
    await createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, status: 'archived' });
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    const row = (await db.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [saved.versionId])).rows[0];
    await unlink(provider.resolveKey(row.storage_key));
    // Deliberate owned-fixture disaster setup bypasses the new normal retention
    // guard, so the original source-independent receipt remains covered.
    const cleanup = await (await db.connect()).connect();
    try {
      await cleanup.query('BEGIN'); await cleanup.query("SET LOCAL app.demo_cleanup='on'");
      await cleanup.query('DELETE FROM managed_artifact_versions WHERE id=$1', [saved.versionId]); await cleanup.query('COMMIT');
    } finally { cleanup.release(); }
    for (const response of [await post(value), await get(`/requests/${value.requestId}`)]) {
      expect(response.status).toBe(200); expect(response.data).toMatchObject({ canWrite: false, replayed: true,
        acceptedRevision: first.data.acceptedRevision, attachment: { headRevisionId: newer, sourceAccess: 'unavailable', revision: { revisionNumber: 2, caption: 'Later corrected caption' } } });
    }
    expect((await post(body(value.reference))).status).toBe(403);
    const conflict = await post({ ...value, caption: 'A different payload' }); expect(conflict.status).toBe(409); expect(conflict.data.code).toBe('ANALYSIS_ATTACHMENT_REQUEST_CONFLICT');
    await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, owner.user.id]);
    expect((await get(`/requests/${value.requestId}`)).status).toBe(404); expect((await post(value)).status).toBe(404);
  });

  it('retains source-free immutable revision history and never changes the wrong head through a dangling pointer', async () => {
    const first = await post(body(reference(await source()))), revisionId = first.data.acceptedRevision.id;
    await expect(db.query('UPDATE research_analysis_attachment_revisions SET caption=$2 WHERE id=$1', [revisionId, 'rewrite'])).rejects.toMatchObject({ code: '55000' });
    await expect(db.query('DELETE FROM research_analysis_attachment_revisions WHERE id=$1', [revisionId])).rejects.toMatchObject({ code: '55000' });
    await expect(db.query('DELETE FROM research_analysis_attachments WHERE id=$1', [first.data.attachment.id])).rejects.toMatchObject({ code: '55000' });
    await expect(db.query('UPDATE research_analysis_attachments SET head_revision_id=$2,revision_number=revision_number+1 WHERE id=$1', [first.data.attachment.id, id('rar')])).rejects.toMatchObject({ code: '23503' });
    expect((await get()).data.attachments[0].headRevisionId).toBe(revisionId);
  });

  it('serializes same-UUID races and preserves acceptance after actual COMMIT succeeds but acknowledgement is lost', async () => {
    const value = body(reference(await source())), pool = await db.connect(); let lose = true;
    const uncertain = { ...db, connect: async () => ({ connect: async () => {
      const client = await pool.connect(); return { query: async (sql, values) => {
        const response = await client.query(sql, values);
        if (sql === 'COMMIT' && lose) { lose = false; throw Object.assign(new Error('Acknowledgement lost after actual COMMIT'), { code: 'ECONNRESET' }); }
        return response;
      }, release: destroy => client.release(destroy) };
    } }) };
    await expect(createAnalysisAttachmentService(uncertain, provider).create(owner.user.id, project.id, analysis.id, value)).rejects.toMatchObject({ code: 'ECONNRESET' });
    const accepted = await get(`/requests/${value.requestId}`); expect(accepted.status).toBe(200);
    const race = await Promise.all([post(value), post(value), post({ ...value, caption: 'Different raced payload' })]);
    expect(race.map(result => result.status)).toEqual([200, 200, 409]); expect(await count('research_analysis_attachments')).toBe(1);
    expect(await count('research_analysis_attachment_revisions')).toBe(1);
    const fresh = body(value.reference), freshRace = await Promise.all([post(fresh), post(fresh)]);
    expect(freshRace.map(result => result.status).sort()).toEqual([200, 201]);
    expect(freshRace[0].data.acceptedRevision).toEqual(freshRace[1].data.acceptedRevision);
    expect(await count('research_analysis_attachments')).toBe(2); expect(await count('research_analysis_attachment_revisions')).toBe(2);
    expect((await get(`/requests/${randomUUID()}`)).data).toMatchObject({ code: 'ANALYSIS_ATTACHMENT_REQUEST_NOT_FOUND' });
  });

  it('fences archive while exact owned bytes are admitted and rejects later fresh writes in archived analyses', async () => {
    const value = body(reference(await source())); let reached, release;
    const entered = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const guarded = createAnalysisAttachmentService(db, { ...provider, openVerifiedRead: async (...args) => {
      reached(); await gate; return provider.openVerifiedRead(...args);
    } });
    const creating = guarded.create(owner.user.id, project.id, analysis.id, value); await entered;
    let finished = false;
    const archiving = createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, status: 'archived' }).finally(() => { finished = true; });
    try {
      await until(async () => (await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM research_analyses%FOR UPDATE'")).rowCount > 0, 'Archive did not wait for the real attachment analysis lock');
      expect(finished).toBe(false);
    } finally { release(); }
    expect((await creating).canWrite).toBe(true); await archiving;
    expect((await post(body(value.reference))).data.code).toBe('ANALYSIS_ARCHIVED');
    expect((await post(value)).data).toMatchObject({ canWrite: false, replayed: true });
  });

  it('atomically bounds concurrent admissions at 200 and does not let a full collection hide an exact receipt', async () => {
    const value = body(reference(await source()));
    // Seed retained prior history efficiently; the last two admissions exercise
    // the real service, SQL fence, quota count and immutable receipt together.
    const client = await (await db.connect()).connect();
    try {
      await client.query('BEGIN');
      for (let n = 0; n < 199; n++) {
        const attachmentId = id('raa'), revisionId = id('rar');
        await client.query('INSERT INTO research_analysis_attachments(id,project_id,analysis_id,created_by_user_id,head_revision_id,revision_number) VALUES($1,$2,$3,$4,$5,1)',
          [attachmentId, project.id, analysis.id, owner.user.id, revisionId]);
        await client.query(`INSERT INTO research_analysis_attachment_revisions
          (id,attachment_id,project_id,analysis_id,revision_number,actor_user_id,source_owner_user_id,request_id,request_sha256,reference_json,caption,supplied_origin_json)
          VALUES($1,$2,$3,$4,1,$5,$5,$6,$7,$8,$9,$10)`, [revisionId, attachmentId, project.id, analysis.id, owner.user.id, randomUUID(),
          sha(canonicalAnalysisAttachmentContent(value)), value.reference, value.caption, value.suppliedOrigin]);
      }
      await client.query('COMMIT');
    } catch (failure) { await client.query('ROLLBACK'); throw failure; } finally { client.release(); }
    const attempts = [body(value.reference), body(value.reference)], results = await Promise.all(attempts.map(input => post(input)));
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    expect(results.find(result => result.status === 409).data.code).toBe('ANALYSIS_ATTACHMENT_LIMIT');
    const acceptedIndex = results.findIndex(result => result.status === 201);
    expect((await post(attempts[acceptedIndex])).status).toBe(200); expect(await count('research_analysis_attachments')).toBe(200);
  });

  it('preserves accepted requests in demo policy but deletes expired guest attachment cycles only through scoped lifecycle', async () => {
    const value = body(reference(await source())); await post(value);
    const organization = await db.createOrganizationForUser(colleague.user.id, { name: 'Persistent lab' });
    const retainedProject = await db.createProjectForUser(colleague.user.id, { organizationId: organization.id, name: 'Persistent study' });
    const retainedAnalysis = (await createResearchAnalysisService().create(colleague.user.id, retainedProject.id, { requestId: randomUUID(), name: 'Keep result' })).analysis;
    const retainedSource = await source(colleague, 'retained.csv', 'gene,score\nB,2\n', retainedProject);
    const retainedBody = body(reference(retainedSource));
    await service.create(colleague.user.id, retainedProject.id, retainedAnalysis.id, retainedBody);
    await db.query("UPDATE users SET is_demo_guest=TRUE,expires_at=NOW()+INTERVAL '10 minutes' WHERE id=$1", [owner.user.id]);
    expect((await post(body(value.reference))).status).toBe(403); expect((await post(value)).data).toMatchObject({ canWrite: false, replayed: true });
    await db.query("UPDATE users SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [owner.user.id]);
    expect(await db.deleteExpiredDemoGuest(owner.user.id)).toBe(true);
    expect(await count('research_analysis_attachments')).toBe(1); expect(await count('research_analysis_attachment_revisions')).toBe(1);
    expect((await service.getRequest(colleague.user.id, retainedProject.id, retainedAnalysis.id, retainedBody.requestId)).canWrite).toBe(true);
    expect((await db.query("SELECT schema_version FROM app_schema_contract WHERE schema_key='traceomics.runtime'")).rows[0].schema_version).toBe(20261027);
  });
});
