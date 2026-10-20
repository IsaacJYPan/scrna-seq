// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { canonicalNotebookPendingRequest } from '../shared/notebookPending.mjs';

const db = require('./pgDatabase');
const config = require('./config');
const { createResearchAnalysisService } = require('./researchAnalyses');
const { createNotebookDocumentService } = require('./notebookDocuments');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const source = text => ({ schema: 'traceomics.notebook.v1', defaultLanguage: 'R',
  cells: [{ id: 'inspect', type: 'code', language: 'R', source: text }] });

describe.skipIf(!config.hasPostgresConnection())('exact pending source journal through PostgreSQL and HTTP', () => {
  let server, owner, analyst, viewer, outsider, project, otherProject, analysis, otherAnalysis, document, service, analyses;
  beforeAll(async () => { server = await startServer(); });
  beforeEach(async () => {
    await db.resetSchemaForTests(); service = createNotebookDocumentService(); analyses = createResearchAnalysisService();
    owner = await createUserWithToken({ email: 'pending-owner@example.test' });
    analyst = await createUserWithToken({ email: 'pending-analyst@example.test' });
    viewer = await createUserWithToken({ email: 'pending-viewer@example.test' });
    outsider = await createUserWithToken({ email: 'pending-outsider@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Pending lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Source study' });
    otherProject = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Other project' });
    await db.addProjectMember(project.id, analyst.user.id, 'analyst'); await db.addProjectMember(project.id, viewer.user.id, 'viewer');
    analysis = (await analyses.create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Question' })).analysis;
    otherAnalysis = (await analyses.create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Other question' })).analysis;
    document = (await service.create(owner.user.id, project.id, analysis.id, { requestId: randomUUID(), title: 'Shared source', content: source('saved()\r\n') })).document;
  });
  afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); await db.close(); });
  const base = (a = analysis, p = project) => `/api/projects/${p.id}/analyses/${a.id}/documents`;
  const path = (doc = null) => base() + (doc ? '/' + doc.id + '/pending' : '/pending/create');
  const input = (doc = null, extra = {}) => ({ expectedJournalVersion: 0, confirmedDraftVersion: null,
    payload: { requestId: randomUUID(), title: 'Pending private source', content: source('  private("β")\r\n'), ...(doc ? { expectedVersion: 1 } : {}) }, ...extra });
  const admit = (body, doc = null, actor = owner) => api(server, path(doc), { method: 'PUT', token: actor.token, body });
  const get = (doc = null, actor = owner) => api(server, path(doc), { token: actor.token });
  const submit = (journal, doc = null, actor = owner) => api(server, path(doc) + '/submit', { method: 'POST', token: actor.token,
    body: { requestId: journal.requestId, admittedVersion: journal.admittedVersion } });
  const list = (actor = owner, suffix = '') => api(server, base() + '/pending' + suffix, { token: actor.token });
  const count = async table => (await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;

  it('admits one exact private create before any shared write and discovers source-free metadata', async () => {
    expect((await get()).data).toMatchObject({ journal: null, journalVersion: 0 });
    const body = input(), accepted = await admit(body);
    expect(accepted.status).toBe(200); expect(accepted.res.headers.get('cache-control')).toContain('no-store');
    const hash = createHash('sha256').update(canonicalNotebookPendingRequest({ action: 'create', projectId: project.id, analysisId: analysis.id, payload: body.payload })).digest('hex');
    expect(accepted.data).toMatchObject({ journalVersion: 1, replayed: false, journal: { visibility: 'private', ownerUserId: owner.user.id,
      projectId: project.id, analysisId: analysis.id, documentId: null, action: 'create', state: 'pending', admittedVersion: 1,
      requestId: body.payload.requestId, requestSha256: hash, payload: { title: body.payload.title } }, admission: { state: 'pending', requestSha256: hash } });
    expect(accepted.data.journal.payload.content.cells[0].source).toBe(body.payload.content.cells[0].source);
    expect((await get()).data.journal).toEqual(accepted.data.journal);
    const discovered = await list(); expect(discovered.data.journals).toHaveLength(1);
    expect(discovered.data.journals[0]).not.toHaveProperty('payload'); expect(JSON.stringify(discovered.data)).not.toContain('private(');
    const ordinary = await api(server, base(), { token: analyst.token }); expect(JSON.stringify(ordinary.data)).not.toContain(body.payload.title);
    expect(await count('research_documents')).toBe(1); expect(await count('research_document_revisions')).toBe(1);
  });

  it('serializes duplicate admissions and competing windows without replacing an unresolved request', async () => {
    const body = input(), replies = await Promise.all(Array.from({ length: 5 }, () => admit(body)));
    expect(replies.every(reply => reply.status === 200)).toBe(true); expect(replies.filter(reply => reply.data.replayed)).toHaveLength(4);
    expect(await count('research_document_pending_requests')).toBe(1);
    const competing = await admit(input(null, { expectedJournalVersion: 1 }));
    expect(competing.status).toBe(409); expect(competing.data).toMatchObject({ code: 'NOTEBOOK_PENDING_CONFLICT', currentJournalVersion: 1 });
    expect(competing.data.currentJournal.payload.requestId).toBe(body.payload.requestId);
    expect((await admit({ ...body, payload: { ...body.payload, title: 'Changed body' } })).data.code).toBe('NOTEBOOK_PENDING_REQUEST_CONFLICT');
    const first = input(document), second = input(document);
    const saves = await Promise.all([admit(first, document), admit(second, document)]);
    expect(saves.map(reply => reply.status).sort()).toEqual([200, 409]);
    expect((await get(document)).data.journal.requestId).toBe(saves.find(reply => reply.status === 200).data.journal.requestId);
  });

  it('submits the stored create atomically and replays its exact old revision with a distinct newer head', async () => {
    const admitted = (await admit(input())).data.journal;
    const results = await Promise.all(Array.from({ length: 4 }, () => submit(admitted)));
    expect(results.every(reply => reply.status === 200)).toBe(true);
    expect(results.map(reply => reply.data.result.document.id).every(id => id === results[0].data.result.document.id)).toBe(true);
    const saved = results[0].data.result.document;
    expect(results[0].data).toMatchObject({ journalVersion: 2, journal: { state: 'succeeded', payload: null,
      outcome: { documentId: saved.id, versionId: saved.versionId, version: 1, sha256: saved.sha256 } } });
    expect(await count('research_documents')).toBe(2); expect(await count('research_document_revisions')).toBe(2);
    await service.save(analyst.user.id, project.id, analysis.id, saved.id, { requestId: randomUUID(), expectedVersion: 1, title: 'Newer source', content: source('newer()') });
    const replay = await submit(admitted);
    expect(replay.data.result).toMatchObject({ replayed: true, document: { id: saved.id, version: 1, content: saved.content }, currentHead: { version: 2 } });
    expect((await list()).data.journals[0]).toMatchObject({ state: 'succeeded', outcome: { versionId: saved.versionId } });
    expect((await db.query('SELECT payload_json FROM research_document_pending')).rows[0].payload_json).toBeNull();
  });

  it('retains captured private cleanup identity and never changes a newer owner-private working copy', async () => {
    const checkpoint = async (version, text) => service.putDraft(owner.user.id, project.id, analysis.id, document.id, {
      requestId: randomUUID(), expectedDraftVersion: version, baseVersion: 1, baseVersionId: document.versionId,
      title: 'Pending private source', content: source(text), uiState: {} });
    await checkpoint(0, '  private("β")\r\n');
    const admitted = (await admit(input(document, { confirmedDraftVersion: 1 }), document)).data.journal;
    await checkpoint(1, 'newer_private()');
    const saved = await submit(admitted, document); expect(saved.data).toMatchObject({ journal: { state: 'succeeded', confirmedDraftVersion: 1 }, result: { document: { version: 2 } } });
    const working = await service.getDraft(owner.user.id, project.id, analysis.id, document.id);
    expect(working).toMatchObject({ draftVersion: 2, draft: { content: source('newer_private()') } });
    await expect(service.clearDraft(owner.user.id, project.id, analysis.id, document.id, { requestId: randomUUID(), expectedDraftVersion: 1 }))
      .rejects.toMatchObject({ code: 'NOTEBOOK_DRAFT_CONFLICT' });
  });

  it('records a definitive shared CAS rejection with recoverable private body and fences delayed legacy dispatch', async () => {
    const body = input(document), admitted = (await admit(body, document)).data.journal;
    await service.save(analyst.user.id, project.id, analysis.id, document.id, { requestId: randomUUID(), expectedVersion: 1, title: 'Colleague', content: source('colleague()') });
    const rejected = await submit(admitted, document);
    expect(rejected.status).toBe(200); expect(rejected.data).toMatchObject({ journalVersion: 2, journal: { state: 'rejected', payload: { title: body.payload.title },
      failure: { code: 'NOTEBOOK_VERSION_CONFLICT', submittedExpectedVersion: 1, currentHead: { version: 2 } } }, admission: { state: 'rejected', failure: { code: 'NOTEBOOK_VERSION_CONFLICT' } } });
    expect(rejected.data).not.toHaveProperty('result'); expect((await get(document)).data.journal.payload.content).toMatchObject(body.payload.content);
    const delayed = await api(server, base() + '/' + document.id, { method: 'PUT', token: owner.token, body: body.payload });
    expect(delayed.data.code).toBe('NOTEBOOK_VERSION_CONFLICT'); expect(await count('research_document_revisions')).toBe(2);
    const retry = await submit(admitted, document); expect(retry.data.admission.state).toBe('rejected'); expect(retry.data.replayed).toBe(true);
  });

  it('keeps old admission/submit outcomes separate from a newer explicitly admitted slot', async () => {
    const oldInput = input(), admitted = (await admit(oldInput)).data.journal;
    const saved = (await submit(admitted)).data.result.document;
    expect((await admit(input(null, { expectedJournalVersion: 1 }))).data.code).toBe('NOTEBOOK_PENDING_CONFLICT');
    const nextInput = input(null, { expectedJournalVersion: 2 }), next = (await admit(nextInput)).data.journal;
    expect(next.journalVersion).toBe(3); expect(next.state).toBe('pending');
    const oldAdmission = await admit(oldInput), oldSubmit = await submit(admitted);
    for (const reply of [oldAdmission, oldSubmit]) {
      expect(reply.data).toMatchObject({ journal: { requestId: next.requestId, journalVersion: 3, state: 'pending' },
        admission: { requestId: admitted.requestId, admittedVersion: 1, state: 'succeeded' }, result: { document: { id: saved.id } } });
    }
    expect((await get()).data.journal).toEqual(next);
    expect((await api(server, path() + '/submit', { method: 'POST', token: owner.token, body: { requestId: next.requestId, admittedVersion: 1 } })).status).toBe(404);
  });

  it('isolates current owner membership and permits read-authorized successful recovery after archive/downgrade', async () => {
    const body = input(), admitted = (await admit(body, null, analyst)).data.journal;
    expect((await get()).data.journal).toBeNull(); expect((await list()).data.journals).toEqual([]);
    expect((await get(null, viewer)).data.journal).toBeNull(); expect((await admit(input(), null, viewer)).status).toBe(403);
    expect((await get(null, outsider)).status).toBe(404); expect((await api(server, path())).status).toBe(401);
    await db.updateProjectMemberRole(project.id, analyst.user.id, 'viewer', { userId: owner.user.id });
    expect((await submit(admitted, null, analyst)).status).toBe(403); expect((await get(null, analyst)).data.journal.state).toBe('pending');
    expect((await admit(body, null, analyst)).data.replayed).toBe(true);
    await db.updateProjectMemberRole(project.id, analyst.user.id, 'analyst', { userId: owner.user.id });
    await analyses.patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, status: 'archived' });
    expect((await submit(admitted, null, analyst)).data.code).toBe('ANALYSIS_ARCHIVED');
    await analyses.patch(owner.user.id, project.id, analysis.id, { expectedVersion: 2, status: 'active' });
    const saved = await submit(admitted, null, analyst); expect(saved.data.journal.state).toBe('succeeded');
    await db.updateProjectMemberRole(project.id, analyst.user.id, 'viewer', { userId: owner.user.id });
    await analyses.patch(owner.user.id, project.id, analysis.id, { expectedVersion: 3, status: 'archived' });
    const replay = await submit(admitted, null, analyst); expect(replay.status).toBe(200); expect(replay.data.result.document.id).toBe(saved.data.result.document.id);
    await db.removeProjectMember(project.id, analyst.user.id, { userId: owner.user.id });
    expect((await get(null, analyst)).status).toBe(404); expect((await submit(admitted, null, analyst)).status).toBe(404);
  });

  it('checks actual source UUID reservations on legacy routes and recovers an already legacy-committed request', async () => {
    const body = input(), admitted = (await admit(body)).data.journal;
    expect((await api(server, base(), { method: 'POST', token: owner.token, body: { ...body.payload, title: 'Changed body' } })).data.code).toBe('NOTEBOOK_REQUEST_CONFLICT');
    const legacy = await api(server, base(), { method: 'POST', token: owner.token, body: body.payload }); expect(legacy.status).toBe(201);
    const resolved = await submit(admitted); expect(resolved.data).toMatchObject({ journal: { state: 'succeeded' }, result: { document: { id: legacy.data.document.id }, replayed: true } });
    const secondBody = input(null, { expectedJournalVersion: 2 });
    const secondLegacy = await service.create(owner.user.id, project.id, analysis.id, secondBody.payload);
    await analyses.patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, status: 'archived' });
    const recovered = await admit(secondBody); expect(recovered.status).toBe(200);
    expect(recovered.data).toMatchObject({ journal: { state: 'succeeded', payload: null }, result: { document: { id: secondLegacy.document.id } } });
    expect(await count('research_documents')).toBe(3);
  });

  it('recovers real admission and source COMMIT acknowledgements lost after durable transaction completion', async () => {
    const pool = await db.connect();
    const uncertain = marker => { let dropped = false; return { connect: async () => ({ connect: async () => {
      const client = await pool.connect(); let wrote = false;
      return { query: async (text, values) => { const result = await client.query(text, values);
        if (text.includes(marker)) wrote = true;
        if (text === 'COMMIT' && wrote && !dropped) { dropped = true; throw Object.assign(new Error('Lost commit acknowledgement'), { code: 'CONNECTION_LOST' }); }
        return result;
      }, release: () => client.release() };
    } }) }; };
    const body = input();
    await expect(createNotebookDocumentService(uncertain('INSERT INTO research_document_pending_requests')).admitPending(owner.user.id, project.id, analysis.id, null, body))
      .rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    const admitted = (await get()).data.journal; expect(admitted.requestId).toBe(body.payload.requestId);
    expect((await admit(body)).data.replayed).toBe(true); expect(await count('research_documents')).toBe(1);
    await expect(createNotebookDocumentService(uncertain('INSERT INTO research_document_submissions')).submitPending(owner.user.id, project.id, analysis.id, null,
      { requestId: admitted.requestId, admittedVersion: admitted.admittedVersion })).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect((await get()).data.journal.state).toBe('succeeded');
    const retry = await submit(admitted); expect(retry.data.result.replayed).toBe(true); expect(await count('research_documents')).toBe(2);
    const saveInput = input(document), saveJournal = (await admit(saveInput, document)).data.journal;
    await expect(createNotebookDocumentService(uncertain('INSERT INTO research_document_submissions')).submitPending(owner.user.id, project.id, analysis.id, document.id,
      { requestId: saveJournal.requestId, admittedVersion: saveJournal.admittedVersion })).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect((await submit(saveJournal, document)).data.result).toMatchObject({ replayed: true, document: { version: 2 } });
    expect(await count('research_document_revisions')).toBe(3);
  });

  it('rolls back the shared save when terminal journal transition fails', async () => {
    const journal = (await admit(input())).data.journal, pool = await db.connect();
    const broken = { connect: async () => ({ connect: async () => { const client = await pool.connect(); return {
      query: async (text, values) => { if (text.includes('UPDATE research_document_pending SET')) throw Object.assign(new Error('Journal transition failed'), { code: 'TEST_TRANSITION' }); return client.query(text, values); },
      release: () => client.release(),
    }; } }) };
    await expect(createNotebookDocumentService(broken).submitPending(owner.user.id, project.id, analysis.id, null,
      { requestId: journal.requestId, admittedVersion: journal.admittedVersion })).rejects.toMatchObject({ code: 'TEST_TRANSITION' });
    expect(await count('research_documents')).toBe(1); expect((await get()).data.journal.state).toBe('pending');
    expect((await submit(journal)).data.journal.state).toBe('succeeded');
  });

  it('bounds discovery pages and bodies and rejects cross-scope source or submit injection', async () => {
    await admit(input()); await admit(input(document), document);
    const first = await list(owner, '?limit=1'); expect(first.data.journals[0].action).toBe('create'); expect(first.data.nextCursor).toBeTruthy();
    const next = await list(owner, '?limit=1&cursor=' + first.data.nextCursor); expect(next.data.journals[0].documentId).toBe(document.id); expect(next.data.nextCursor).toBeNull();
    for (const suffix of ['?limit=0', '?limit=101', '?cursor=invalid']) expect((await list(owner, suffix)).status).toBe(400);
    for (const other of [base(otherAnalysis), base(analysis, otherProject)]) {
      expect((await api(server, other + '/' + document.id + '/pending', { token: owner.token })).status).toBe(404);
    }
    const journal = (await get()).data.journal;
    expect((await api(server, path() + '/submit', { method: 'POST', token: owner.token,
      body: { requestId: journal.requestId, admittedVersion: 1, payload: input().payload } })).status).toBe(400);
    expect((await admit({ padding: 'x'.repeat(2 * 1024 * 1024 + 1) })).status).toBe(413);
    expect((await api(server, path(), { method: 'PUT', body: { padding: 'x'.repeat(2 * 1024 * 1024 + 1) } })).status).toBe(401);
    expect((await list()).data.journals.every(item => !Object.hasOwn(item, 'payload'))).toBe(true);
  });

  it('retains pending source through idempotent schema reapply and cleans only expired demo-owned journals', async () => {
    const retained = (await admit(input())).data.journal;
    await db.initSchema({ force: true }); expect((await get()).data.journal).toEqual(retained);
    const guest = await db.createDemoGuest(`pending-cleanup-${randomUUID()}@example.test`, 'password123', new Date(Date.now() + 3600000));
    const guestAnalysis = (await analyses.create(guest.user.id, guest.project.id, { requestId: randomUUID(), name: 'Guest question' })).analysis;
    await service.admitPending(guest.user.id, guest.project.id, guestAnalysis.id, null, input());
    await db.query("UPDATE users SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [guest.user.id]);
    expect(await db.deleteExpiredDemoGuest(guest.user.id)).toBe(true);
    expect((await get()).data.journal).toEqual(retained);
    for (const table of ['research_document_pending', 'research_document_pending_requests']) {
      expect((await db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE project_id=$1`, [guest.project.id])).rows[0].n).toBe(0);
    }
    await expect(db.query('UPDATE research_document_pending SET owner_user_id=$1 WHERE project_id=$2', [analyst.user.id, project.id]))
      .rejects.toMatchObject({ code: '55000' });
    await expect(db.query("UPDATE research_document_pending_requests SET request_sha256=$1 WHERE project_id=$2", ['a'.repeat(64), project.id]))
      .rejects.toMatchObject({ code: '55000' });
  });
});
