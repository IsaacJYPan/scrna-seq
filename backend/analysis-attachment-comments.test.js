import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeAnalysisAttachmentComment, canonicalAnalysisAttachmentComment } from '../shared/analysisAttachmentComment.mjs';

const db = require('./pgDatabase');
const storage = require('./storage');
const { createAnalysisAttachmentService } = require('./analysisAttachments');
const { createArtifactVersionService } = require('./artifactVersions');
const { createResearchAnalysisService } = require('./researchAnalyses');
let http;
const sha = text => createHash('sha256').update(text).digest('hex');
const id = prefix => `${prefix}_${randomBytes(12).toString('hex')}`;
const input = (body = 'Please retain the filtering rationale.') => ({ requestId: randomUUID(), body });
const until = async (check, message) => {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(message);
};

describe('plain exact-revision comment contract', () => {
  const attachmentId = 'raa_' + 'a'.repeat(24), revisionId = 'rar_' + 'b'.repeat(24);
  it('normalizes scientific Unicode and multiline text while binding exact target/action independently of UUID', () => {
    const value = input('  β scores\r\n\twhy this subset?  '), parsed = normalizeAnalysisAttachmentComment(value);
    expect(parsed.body).toBe('β scores\n\twhy this subset?');
    expect(canonicalAnalysisAttachmentComment(attachmentId, revisionId, value)).toBe(`{"action":"comment","attachmentId":"${attachmentId}","revisionId":"${revisionId}","body":"β scores\\n\\twhy this subset?"}`);
    expect(canonicalAnalysisAttachmentComment(attachmentId, revisionId, { body: parsed.body })).toBe(canonicalAnalysisAttachmentComment(attachmentId, revisionId, value));
    expect(canonicalAnalysisAttachmentComment(attachmentId, revisionId, { ...value, requestId: randomUUID() })).toBe(canonicalAnalysisAttachmentComment(attachmentId, revisionId, value));
    expect(canonicalAnalysisAttachmentComment(attachmentId, 'rar_' + 'c'.repeat(24), value)).not.toBe(canonicalAnalysisAttachmentComment(attachmentId, revisionId, value));
    expect(normalizeAnalysisAttachmentComment(input('🧬'.repeat(4000))).body).toHaveLength(8000);
  });
  it('rejects caller contributor/time/targets, getter/prototype tricks, hidden controls and malformed or excessive text', () => {
    let read = false;
    const getter = input(); Object.defineProperty(getter, 'body', { enumerable: true, get() { read = true; return 'hidden'; } });
    for (const value of [getter, Object.assign(Object.create({ inherited: true }), input()), { ...input(), authorUserId: 2 }, { ...input(), createdAt: 'today' },
      { ...input(), revisionId }, { requestId: 'bad', body: 'Text' }, input(''), input('x'.repeat(4001)), input('\uD800'), input('Text\0other'), input('x\u202ey'), input('x\ufeffy')]) {
      expect(() => normalizeAnalysisAttachmentComment(value)).toThrow();
    }
    expect(read).toBe(false); expect(() => canonicalAnalysisAttachmentComment('bad', revisionId, input())).toThrow();
  });
});

describe.skipIf(!process.env.DATABASE_URL)('revision discussion PostgreSQL/HTTP and private-source boundaries', () => {
  let directory, provider, service, server, owner, colleague, viewer, outsider, project, analysis, artifact, head, oldRoot;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'traceomics-revision-comments-'));
    oldRoot = process.env.STORAGE_ROOT; process.env.STORAGE_ROOT = path.join(directory, 'storage');
    provider = storage.createLocalStorageProvider(); http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    await db.resetSchemaForTests(); service = createAnalysisAttachmentService(db, provider);
    owner = await http.createUserWithToken({ email: 'discussion-owner@example.test', displayName: 'Evidence author' });
    colleague = await http.createUserWithToken({ email: 'discussion-colleague@example.test', displayName: 'Collaborating researcher' });
    viewer = await http.createUserWithToken({ email: 'discussion-viewer@example.test', displayName: 'Reviewing colleague' });
    outsider = await http.createUserWithToken({ email: 'discussion-outsider@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Discussion lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Exact evidence' });
    await db.addProjectMember(project.id, colleague.user.id, 'analyst'); await db.addProjectMember(project.id, viewer.user.id, 'viewer');
    analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Discuss treatment' })).analysis;
    artifact = await source(owner, project); head = (await service.create(owner.user.id, project.id, analysis.id, attachmentBody(artifact.reference))).attachment;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (oldRoot === undefined) delete process.env.STORAGE_ROOT; else process.env.STORAGE_ROOT = oldRoot;
    await db.close(); await rm(directory, { recursive: true, force: true });
  });
  const attachmentBody = reference => ({ requestId: randomUUID(), reference, caption: 'Outside evidence', suppliedOrigin: {} });
  async function source(actor, p) {
    const filename = path.join(directory, randomUUID()); await writeFile(filename, 'gene,score\nA,12\n');
    const version = await createArtifactVersionService(db, provider).importFile(actor.user.id, p.id, { path: filename, originalFilename: 'private-sensitive-source.csv', name: 'Private filename should not be shared' });
    const row = (await db.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [version.versionId])).rows[0];
    return { version, key: row.storage_key, reference: { kind: 'artifact-version', versionId: version.versionId, sha256: version.sha256 } };
  }
  const base = (a = analysis, p = project) => `/api/projects/${p.id}/analyses/${a.id}/attachments`;
  const pathFor = (target = head, revisionId = target.headRevisionId) => `${base()}/${target.id}/revisions/${revisionId}/comments`;
  const post = (value = input(), actor = viewer, target = head, revisionId = target.headRevisionId) => http.api(server, pathFor(target, revisionId), { method: 'POST', token: actor.token, body: value });
  const get = (suffix = '', actor = viewer, target = head, revisionId = target.headRevisionId) => http.api(server, pathFor(target, revisionId) + suffix, { token: actor.token });
  const receipt = (requestId, actor = viewer) => http.api(server, `${base()}/comment-requests/${requestId}`, { token: actor.token });
  const count = async table => (await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
  const correct = target => service.correct(owner.user.id, project.id, analysis.id, target.id, { ...attachmentBody(target.revision.reference),
    expectedHeadRevisionId: target.headRevisionId, caption: 'Corrected supplied context' });
  async function wrappedDatabase(intercept) {
    const pool = await db.connect();
    return { ...db, connect: async () => ({ connect: async () => {
      const client = await pool.connect(); return { query: (sql, values) => intercept(client, sql, values), release: destroy => client.release(destroy) };
    } }) };
  }
  async function seedComments(targets, lengths, author = viewer) {
    const rows = [];
    targets.forEach((target, index) => {
      for (let n = 0; n < lengths[index]; n++) {
        const body = `Retained discussion ${index}-${n}`;
        rows.push({ id: id('rac'), attachment_id: target.id, revision_id: target.headRevisionId, body, request_id: randomUUID(),
          request_sha256: sha(canonicalAnalysisAttachmentComment(target.id, target.headRevisionId, { body })) });
      }
    });
    await db.query(`INSERT INTO research_analysis_attachment_comments
      (id,project_id,analysis_id,attachment_id,revision_id,author_user_id,author_display_name,body,request_id,request_sha256,created_at)
      SELECT id,$1,$2,attachment_id,revision_id,$3,'Captured contributor',body,request_id,request_sha256,'2026-01-01T00:00:00Z'
      FROM jsonb_to_recordset($4::jsonb) AS c(id text,attachment_id text,revision_id text,body text,request_id uuid,request_sha256 text)`,
    [project.id, analysis.id, author.user.id, JSON.stringify(rows)]);
    return rows;
  }

  it('allows current viewers to discuss private evidence without source reads, edit authority or scientific dispatch', async () => {
    const value = input('<img src="https://invalid.example/x" onerror="alert(1)">\nPlain supplied text'), response = await post(value);
    expect(response.status).toBe(201); expect(response.data).toMatchObject({ projectId: project.id, analysisId: analysis.id, attachmentId: head.id,
      revisionId: head.headRevisionId, headRevisionId: head.headRevisionId, canComment: true, replayed: false, requestId: value.requestId,
      requestSha256: sha(canonicalAnalysisAttachmentComment(head.id, head.headRevisionId, value)), comment: { body: value.body, authorUserId: viewer.user.id, authorDisplayName: 'Reviewing colleague' } });
    expect(response.data.comment.id).toMatch(/^rac_[a-f0-9]{24}$/); expect(response.res.headers.get('cache-control')).toContain('no-store');
    const noFiles = createAnalysisAttachmentService(db, { resolveKey: () => { throw new Error('Discussion must not inspect private bytes'); } });
    expect((await noFiles.addComment(viewer.user.id, project.id, analysis.id, head.id, head.headRevisionId, input())).canComment).toBe(true);
    expect((await http.api(server, `/api/artifact-versions/${project.id}/${artifact.version.versionId}/preview`, { token: viewer.token })).status).toBe(404);
    expect((await service.history(viewer.user.id, project.id, analysis.id, head.id)).canWrite).toBe(false);
    expect((await createResearchAnalysisService().get(owner.user.id, project.id, analysis.id)).analysis).toEqual(analysis);
    for (const table of ['jobs', 'private_r_executions', 'private_r_kernels', 'workflow_runs']) expect(await count(table)).toBe(0);
    const audit = (await db.query("SELECT * FROM project_audit_events WHERE action='attachment.commented' ORDER BY created_at,id")).rows;
    expect(audit).toHaveLength(2); expect(audit[0]).toMatchObject({ target_type: 'attachment_revision', target_id: head.headRevisionId, details_json: '{}' });
    expect(JSON.stringify(audit)).not.toContain(value.body); expect(JSON.stringify(response.data)).not.toContain('Private filename');
  });

  it('keeps comments on their original revision after corrections, with captured contributor labels and missing private bytes', async () => {
    const value = input(), first = await post(value), original = head.headRevisionId;
    const updated = await correct(head); head = updated.attachment;
    expect((await get()).data.comments).toEqual([]);
    expect((await get('', owner, head, original)).data).toMatchObject({ headRevisionId: head.headRevisionId, comments: [first.data.comment] });
    expect((await post(input('Comment intentionally on earlier evidence'), viewer, head, original)).status).toBe(201);
    await db.query("UPDATE users SET display_name='Changed later' WHERE id=$1", [viewer.user.id]); await unlink(provider.resolveKey(artifact.key));
    const accepted = await receipt(value.requestId); expect(accepted.data).toMatchObject({ headRevisionId: head.headRevisionId, canComment: true,
      comment: { ...first.data.comment, revisionId: original, authorDisplayName: 'Reviewing colleague' } });
    expect((await post(input('Discuss caption even if source is gone'))).status).toBe(201);
    expect((await receipt(value.requestId, colleague)).status).toBe(404);
  });

  it('serializes same-UUID submissions and binds body and exact revision across every target in the analysis', async () => {
    const value = input(), race = await Promise.all([post(value), post(value)]);
    expect(race.map(response => response.status).sort()).toEqual([200, 201]); expect(race[0].data.comment).toEqual(race[1].data.comment);
    expect(await count('research_analysis_attachment_comments')).toBe(1); expect(await count('project_audit_events')).toBe(1);
    expect((await post({ ...value, body: 'Different text' })).data.code).toBe('ANALYSIS_ATTACHMENT_COMMENT_REQUEST_CONFLICT');
    const updated = await correct(head);
    expect((await post(value, viewer, updated.attachment)).data.code).toBe('ANALYSIS_ATTACHMENT_COMMENT_REQUEST_CONFLICT');
    const other = (await service.create(owner.user.id, project.id, analysis.id, attachmentBody(artifact.reference))).attachment;
    expect((await post(value, viewer, other)).data.code).toBe('ANALYSIS_ATTACHMENT_COMMENT_REQUEST_CONFLICT');
    expect((await post(value, colleague)).status).toBe(201); expect(await count('research_analysis_attachment_comments')).toBe(2);
    expect((await receipt(randomUUID())).data.code).toBe('ANALYSIS_ATTACHMENT_COMMENT_REQUEST_NOT_FOUND');
  });

  it('checks current membership and exact target identity while accepted recovery precedes archive and deployment write policy', async () => {
    const value = input(), first = await post(value);
    expect((await post(input(), outsider)).status).toBe(404); expect((await http.api(server, pathFor())).status).toBe(401);
    const other = (await service.create(owner.user.id, project.id, analysis.id, attachmentBody(artifact.reference))).attachment;
    expect((await get('', viewer, other, head.headRevisionId)).status).toBe(404);
    const unrelatedAnalysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Other context' })).analysis;
    expect((await http.api(server, `${base(unrelatedAnalysis)}/comment-requests/${value.requestId}`, { token: viewer.token })).status).toBe(404);
    await createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, status: 'archived' });
    expect((await get()).data.canComment).toBe(false); expect((await post(input())).data.code).toBe('ANALYSIS_ARCHIVED');
    expect((await post(value)).data).toMatchObject({ replayed: true, canComment: false, comment: first.data.comment });
    const oldMode = process.env.APP_DEPLOYMENT_MODE; process.env.APP_DEPLOYMENT_MODE = 'demo';
    try { expect((await service.getCommentRequest(viewer.user.id, project.id, analysis.id, value.requestId)).canComment).toBe(false); }
    finally { if (oldMode === undefined) delete process.env.APP_DEPLOYMENT_MODE; else process.env.APP_DEPLOYMENT_MODE = oldMode; }
    await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, viewer.user.id]);
    for (const response of [await get(), await receipt(value.requestId), await post(value)]) expect(response.status).toBe(404);
  });

  it('returns a bounded newest-first discussion with stable same-timestamp pagination and scoped cursors', async () => {
    const seeded = await seedComments([head], [7]);
    const ids = []; let cursor;
    do {
      const response = await get('?limit=3' + (cursor ? '&cursor=' + cursor : '')); expect(response.status).toBe(200);
      expect(response.data.comments).toHaveLength(cursor ? Math.min(3, 7 - ids.length) : 3);
      ids.push(...response.data.comments.map(comment => comment.id)); cursor = response.data.nextCursor;
    } while (cursor);
    expect(ids).toEqual(seeded.map(row => row.id).sort().reverse()); expect(new Set(ids).size).toBe(7);
    const page = await get('?limit=2'), updated = await correct(head);
    expect((await get('?cursor=' + page.data.nextCursor, viewer, updated.attachment)).status).toBe(400);
    for (const query of ['?limit=31', '?limit=0', '?cursor=broken', '?cursor=' + 'x'.repeat(257), '?body=all']) expect((await get(query)).status).toBe(400);
  });

  it('keeps every comment field immutable and enforces exact revision/scope foreign keys', async () => {
    const first = await post(), row = first.data.comment;
    for (const field of ['body', 'author_user_id', 'revision_id', 'request_sha256', 'created_at']) {
      await expect(db.query(`UPDATE research_analysis_attachment_comments SET ${field}=${field} WHERE id=$1`, [row.id])).rejects.toMatchObject({ code: '55000' });
    }
    await expect(db.query('DELETE FROM research_analysis_attachment_comments WHERE id=$1', [row.id])).rejects.toMatchObject({ code: '55000' });
    const other = (await service.create(owner.user.id, project.id, analysis.id, attachmentBody(artifact.reference))).attachment;
    await expect(db.query(`INSERT INTO research_analysis_attachment_comments
      (id,project_id,analysis_id,attachment_id,revision_id,author_user_id,author_display_name,body,request_id,request_sha256)
      VALUES($1,$2,$3,$4,$5,$6,'Author','Wrong target',$7,$8)`, [id('rac'), project.id, analysis.id, other.id, head.headRevisionId, viewer.user.id, randomUUID(), 'a'.repeat(64)])).rejects.toMatchObject({ code: '23503' });
  });

  it('recovers an actual committed comment after a lost COMMIT acknowledgement without duplicate comment or audit', async () => {
    const value = input(); let lose = true;
    const uncertain = await wrappedDatabase(async (client, sql, values) => {
      const result = await client.query(sql, values);
      if (sql === 'COMMIT' && lose) { lose = false; throw Object.assign(new Error('Comment COMMIT acknowledgement lost'), { code: 'ECONNRESET' }); }
      return result;
    });
    await expect(createAnalysisAttachmentService(uncertain, provider).addComment(viewer.user.id, project.id, analysis.id, head.id, head.headRevisionId, value)).rejects.toMatchObject({ code: 'ECONNRESET' });
    const accepted = await receipt(value.requestId); expect(accepted.status).toBe(200);
    expect((await post(value)).data.comment).toEqual(accepted.data.comment);
    expect(await count('research_analysis_attachment_comments')).toBe(1); expect(await count('project_audit_events')).toBe(1);
  });

  it('rolls back comment and receipt if its audit cannot be committed, keeping explicit same-request retry possible', async () => {
    const value = input(), failing = await wrappedDatabase(async (client, sql, values) => {
      if (sql.includes('INSERT INTO project_audit_events')) throw Object.assign(new Error('Owned audit fixture rejects insert'), { code: 'TEST_AUDIT_FAILURE' });
      return client.query(sql, values);
    });
    await expect(createAnalysisAttachmentService(failing, provider).addComment(viewer.user.id, project.id, analysis.id, head.id, head.headRevisionId, value)).rejects.toMatchObject({ code: 'TEST_AUDIT_FAILURE' });
    expect(await count('research_analysis_attachment_comments')).toBe(0); expect(await count('project_audit_events')).toBe(0);
    expect((await receipt(value.requestId)).data.code).toBe('ANALYSIS_ATTACHMENT_COMMENT_REQUEST_NOT_FOUND'); expect((await post(value)).status).toBe(201);
  });

  it('fences archive until an admitted comment finishes and reports fresh authority separately on recovery', async () => {
    let reached, release;
    const entered = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const guarded = await wrappedDatabase(async (client, sql, values) => {
      if (sql.includes('INSERT INTO project_audit_events')) { reached(); await gate; }
      return client.query(sql, values);
    });
    const value = input(), pending = createAnalysisAttachmentService(guarded, provider).addComment(viewer.user.id, project.id, analysis.id, head.id, head.headRevisionId, value); await entered;
    let finished = false;
    const archiving = createResearchAnalysisService().patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, status: 'archived' }).finally(() => { finished = true; });
    try {
      await until(async () => (await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM research_analyses%FOR UPDATE'")).rowCount > 0, 'Archive did not wait on the actual discussion analysis lock');
      expect(finished).toBe(false);
    } finally { release(); }
    expect((await pending).canComment).toBe(true); await archiving; expect((await receipt(value.requestId)).data.canComment).toBe(false);
  });

  it('bounds concurrent per-revision and per-analysis additions while preserving exact accepted replay at both limits', async () => {
    await seedComments([head], [199]); const requests = [input('One final question'), input('Another final question')];
    const race = await Promise.all(requests.map(value => post(value))); expect(race.map(response => response.status).sort()).toEqual([201, 409]);
    expect(race.find(response => response.status === 409).data.code).toBe('ANALYSIS_ATTACHMENT_COMMENT_LIMIT');
    expect((await post(requests[race.findIndex(response => response.status === 201)])).status).toBe(200);
    analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Discussion capacity' })).analysis;
    head = (await service.create(owner.user.id, project.id, analysis.id, attachmentBody(artifact.reference))).attachment;
    const targets = [head]; for (let n = 0; n < 10; n++) targets.push((await correct(targets.at(-1))).attachment);
    await seedComments(targets, [...Array(10).fill(199), 9]);
    const values = [input('Last analysis comment A'), input('Last analysis comment B')];
    const total = await Promise.all([post(values[0], viewer, targets[0]), post(values[1], viewer, targets.at(-1))]);
    expect(total.map(response => response.status).sort()).toEqual([201, 409]); expect(total.find(response => response.status === 409).data.code).toBe('ANALYSIS_ATTACHMENT_COMMENT_LIMIT');
    const acceptedIndex = total.findIndex(response => response.status === 201);
    expect((await post(values[acceptedIndex], viewer, acceptedIndex === 0 ? targets[0] : targets.at(-1))).status).toBe(200);
  });

  it('captures bounded plain contributor labels and keeps demo fresh writes separate from accepted outcomes', async () => {
    await db.query('UPDATE users SET display_name=$2 WHERE id=$1', [viewer.user.id, 'a'.repeat(159) + ' boundary tail']);
    expect((await post()).data.comment.authorDisplayName).toBe('a'.repeat(159));
    await db.query('UPDATE users SET display_name=$2 WHERE id=$1', [viewer.user.id, '  β reviewer\n\u202e' + '🧬'.repeat(170)]);
    const accepted = await post(); expect(accepted.status).toBe(201); expect([...accepted.data.comment.authorDisplayName].length).toBe(160);
    expect(accepted.data.comment.authorDisplayName).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    await db.query('UPDATE users SET display_name=$2 WHERE id=$1', [viewer.user.id, '\n\t\u202e']);
    expect((await post()).data.comment.authorDisplayName).toBe('Researcher');
    await db.query("UPDATE users SET is_demo_guest=TRUE,expires_at=NOW()+INTERVAL '10 minutes' WHERE id=$1", [viewer.user.id]);
    expect((await post()).status).toBe(403); expect((await receipt(accepted.data.requestId)).data).toMatchObject({ canComment: false, comment: accepted.data.comment });
    const oldMode = process.env.APP_DEPLOYMENT_MODE; process.env.APP_DEPLOYMENT_MODE = 'demo';
    try {
      await expect(service.addComment(colleague.user.id, project.id, analysis.id, head.id, head.headRevisionId, input())).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await service.listComments(colleague.user.id, project.id, analysis.id, head.id, head.headRevisionId)).canComment).toBe(false);
    } finally { if (oldMode === undefined) delete process.env.APP_DEPLOYMENT_MODE; else process.env.APP_DEPLOYMENT_MODE = oldMode; }
  });

  it('adds the discussion schema idempotently without changing existing correction receipts, source ownership or retention', async () => {
    const corrected = await correct(head), revision = corrected.acceptedRevision;
    await db.query('DROP TABLE research_analysis_attachment_comments'); await db.query("UPDATE app_schema_contract SET schema_version=20261026 WHERE schema_key='traceomics.runtime'");
    await db.initSchema({ force: true }); await db.initSchema({ force: true });
    expect((await service.getRequest(owner.user.id, project.id, analysis.id, corrected.requestId)).acceptedRevision).toEqual(revision);
    await expect(db.query('DELETE FROM managed_artifact_versions WHERE id=$1', [artifact.version.versionId])).rejects.toMatchObject({ code: '55000' });
    expect((await post(input(), viewer, corrected.attachment)).status).toBe(201);
    expect((await db.query("SELECT schema_version FROM app_schema_contract WHERE schema_key='traceomics.runtime'")).rows[0].schema_version).toBe(20261032);
  });

  it('removes discussion/receipt/audit cycles only through scoped expired-demo cleanup while retaining another project', async () => {
    await post(); const corrected = await correct(head); await post(input('On corrected evidence'), owner, corrected.attachment);
    const organization = await db.createOrganizationForUser(colleague.user.id, { name: 'Persistent discussion lab' });
    const retainedProject = await db.createProjectForUser(colleague.user.id, { organizationId: organization.id, name: 'Retained project' });
    const retainedAnalysis = (await createResearchAnalysisService().create(colleague.user.id, retainedProject.id, { requestId: randomUUID(), name: 'Keep comments' })).analysis;
    const saved = await source(colleague, retainedProject), retainedHead = (await service.create(colleague.user.id, retainedProject.id, retainedAnalysis.id, attachmentBody(saved.reference))).attachment;
    const value = input('Keep this exact discussion'), accepted = await service.addComment(colleague.user.id, retainedProject.id, retainedAnalysis.id, retainedHead.id, retainedHead.headRevisionId, value);
    await db.query("UPDATE users SET is_demo_guest=TRUE,expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [owner.user.id]);
    expect(await db.deleteExpiredDemoGuest(owner.user.id)).toBe(true);
    expect(await count('research_analysis_attachment_comments')).toBe(1); expect(await count('project_audit_events')).toBe(1);
    expect((await service.getCommentRequest(colleague.user.id, retainedProject.id, retainedAnalysis.id, value.requestId)).comment).toEqual(accepted.comment);
  });
});
