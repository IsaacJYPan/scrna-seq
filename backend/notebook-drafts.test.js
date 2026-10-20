import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NOTEBOOK_DRAFT_LIMITS } from '../shared/notebookDraft.mjs';

const db = require('./pgDatabase');
const config = require('./config');
const { createResearchAnalysisService } = require('./researchAnalyses');
const { createNotebookDocumentService } = require('./notebookDocuments');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const configured = config.hasPostgresConnection();
const source = text => ({ schema: 'traceomics.notebook.v1', defaultLanguage: 'R',
  cells: [{ id: 'inspect', type: 'code', language: 'R', source: text }] });

describe.skipIf(!configured)('owner-private notebook autosave through actual PostgreSQL and HTTP', () => {
  let server, owner, analyst, viewer, outsider, project, otherProject, analysis, otherAnalysis, document, service, analyses;
  beforeAll(async () => { server = await startServer(); });
  beforeEach(async () => {
    await db.resetSchemaForTests(); service = createNotebookDocumentService(); analyses = createResearchAnalysisService();
    owner = await createUserWithToken({ email: 'draft-owner@example.test' });
    analyst = await createUserWithToken({ email: 'draft-analyst@example.test' });
    viewer = await createUserWithToken({ email: 'draft-viewer@example.test' });
    outsider = await createUserWithToken({ email: 'draft-outsider@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Private working-copy lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Shared study' });
    otherProject = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Other scope' });
    await db.addProjectMember(project.id, analyst.user.id, 'analyst'); await db.addProjectMember(project.id, viewer.user.id, 'viewer');
    analysis = (await analyses.create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Question' })).analysis;
    otherAnalysis = (await analyses.create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Other question' })).analysis;
    document = (await service.create(owner.user.id, project.id, analysis.id, { requestId: randomUUID(), title: 'Shared source', content: source('saved_source()\r\n') })).document;
  });
  afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); await db.close(); });
  const base = (selectedAnalysis = analysis, selectedProject = project) => `/api/projects/${selectedProject.id}/analyses/${selectedAnalysis.id}/documents`;
  const path = () => base() + '/' + document.id + '/draft';
  const body = (extra = {}) => ({ requestId: randomUUID(), expectedDraftVersion: 0, baseVersion: document.version,
    baseVersionId: document.versionId, title: 'Private alternative', content: source('  private_source("β")\r\n'),
    uiState: { activeCellId: 'inspect', scrollTop: 123.5 }, ...extra });
  const put = (input = body(), actor = owner) => api(server, path(), { method: 'PUT', token: actor.token, body: input });
  const get = (actor = owner) => api(server, path(), { token: actor.token });
  const clear = (expectedDraftVersion, actor = owner, requestId = randomUUID()) => api(server, path(), {
    method: 'DELETE', token: actor.token, body: { requestId, expectedDraftVersion } });

  it('autosaves exact source/view state privately without appending or changing shared source', async () => {
    expect((await get()).data).toMatchObject({ draft: null, draftVersion: 0, currentHead: { version: 1 } });
    const input = body(), saved = await put(input);
    expect(saved.status).toBe(200); expect(saved.res.headers.get('cache-control')).toContain('no-store');
    expect(saved.data).toMatchObject({ replayed: false, draftVersion: 1, draft: { visibility: 'private', ownerUserId: owner.user.id,
      documentId: document.id, projectId: project.id, analysisId: analysis.id, title: input.title, draftVersion: 1,
      baseVersion: 1, baseVersionId: document.versionId, uiState: input.uiState },
    checkpoint: { requestId: input.requestId, draftVersion: 1, action: 'update', cleared: false } });
    expect(saved.data.draft.content.cells[0].source).toBe(input.content.cells[0].source);
    expect(saved.data.draft.sha256).toMatch(/^[a-f0-9]{64}$/); expect((await get()).data.draft).toEqual(saved.data.draft);
    expect((await api(server, base() + '/' + document.id, { token: viewer.token })).data.document).toEqual(document);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM research_document_revisions')).rows[0].n).toBe(1);
    const list = await api(server, base(), { token: analyst.token });
    expect(JSON.stringify(list.data)).not.toContain('private_source'); expect(JSON.stringify(list.data)).not.toContain(input.title);
  });

  it('isolates private source by authenticated owner even from project administrators and readers', async () => {
    await put(); const own = await get();
    for (const actor of [analyst, viewer]) {
      expect((await get(actor)).data).toMatchObject({ draft: null, draftVersion: 0 });
      expect(JSON.stringify((await get(actor)).data)).not.toContain(own.data.draft.title);
    }
    const independent = await put(body({ title: 'Analyst private copy' }), analyst);
    expect(independent.status).toBe(200); expect(independent.data.draft.ownerUserId).toBe(analyst.user.id);
    expect((await get()).data.draft.title).toBe('Private alternative');
    expect((await put(body(), viewer)).status).toBe(403);
    expect((await get(outsider)).status).toBe(404); expect((await api(server, path())).status).toBe(401);
  });

  it('uses actual private draft CAS between two windows and never accepts last-write-wins replacement', async () => {
    const initial = (await put()).data.draft;
    const replies = await Promise.all([put(body({ expectedDraftVersion: 1, title: 'Window A' })), put(body({ expectedDraftVersion: 1, title: 'Window B' }))]);
    expect(replies.map(reply => reply.status).sort()).toEqual([200, 409]);
    const latest = replies.find(reply => reply.status === 200).data.draft;
    expect(replies.find(reply => reply.status === 409).data).toMatchObject({ code: 'NOTEBOOK_DRAFT_CONFLICT', currentDraftVersion: 2,
      currentDraft: { draftVersion: 2, title: latest.title, sha256: latest.sha256 } });
    expect(replies.find(reply => reply.status === 409).data.currentDraft).not.toHaveProperty('content');
    expect((await get()).data.draft).toEqual(latest); expect(latest.sha256).not.toBe(initial.sha256);
  });

  it('serializes duplicate first-checkpoint UUIDs and reports older accepted metadata alongside the newer private copy', async () => {
    const firstInput = body(), first = await Promise.all(Array.from({ length: 5 }, () => put(firstInput)));
    expect(first.every(reply => reply.status === 200)).toBe(true); expect(first.filter(reply => reply.data.replayed)).toHaveLength(4);
    expect(first.every(reply => reply.data.draftVersion === 1)).toBe(true);
    const newer = (await put(body({ expectedDraftVersion: 1, title: 'Newer window snapshot' }))).data.draft;
    const replay = await put(firstInput);
    expect(replay.data).toMatchObject({ replayed: true, draftVersion: 2, draft: newer, checkpoint: { draftVersion: 1, sha256: first[0].data.draft.sha256 } });
    expect((await put({ ...firstInput, title: 'Changed original request' })).data.code).toBe('NOTEBOOK_DRAFT_REQUEST_CONFLICT');
  });

  it('scopes draft request UUIDs to actor/analysis and rejects their changed document reuse', async () => {
    const input = body(); await put(input);
    const second = (await service.create(owner.user.id, project.id, analysis.id, { requestId: randomUUID(), title: 'Second', content: source('second()') })).document;
    const reused = await api(server, base() + '/' + second.id + '/draft', { method: 'PUT', token: owner.token,
      body: { ...input, baseVersionId: second.versionId } });
    expect(reused.status).toBe(409); expect(reused.data.code).toBe('NOTEBOOK_DRAFT_REQUEST_CONFLICT');
    expect((await put(input, analyst)).status).toBe(200);
  });

  it('fences downgrade/archive/revocation while allowing the current reader to recover only their existing private copy and receipt', async () => {
    const input = body(), saved = await put(input, analyst);
    await db.updateProjectMemberRole(project.id, analyst.user.id, 'viewer', { userId: owner.user.id });
    expect((await get(analyst)).data.draft).toEqual(saved.data.draft);
    expect((await put(input, analyst)).data.replayed).toBe(true);
    expect((await put(body({ expectedDraftVersion: 1 }), analyst)).status).toBe(403);
    expect((await clear(1, analyst)).status).toBe(403);
    await db.removeProjectMember(project.id, analyst.user.id, { userId: owner.user.id });
    expect((await get(analyst)).status).toBe(404); expect((await put(input, analyst)).status).toBe(404);
    const ownerInput = body(), ownSaved = await put(ownerInput);
    await analyses.patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, status: 'archived' });
    expect((await get()).data.draft).toEqual(ownSaved.data.draft); expect((await put(ownerInput)).data.replayed).toBe(true);
    expect((await put(body({ expectedDraftVersion: 1 }))).data.code).toBe('ANALYSIS_ARCHIVED');
    expect((await clear(1)).data.code).toBe('ANALYSIS_ARCHIVED');
  });

  it('rejects cross-project/analysis/version bases without leaking or moving private source', async () => {
    await put();
    for (const other of [base(otherAnalysis), base(analysis, otherProject)]) {
      expect((await api(server, other + '/' + document.id + '/draft', { token: owner.token })).status).toBe(404);
    }
    const second = (await service.create(owner.user.id, project.id, analysis.id, { requestId: randomUUID(), title: 'Second', content: source('second()') })).document;
    expect((await put(body({ expectedDraftVersion: 1, baseVersionId: second.versionId }))).status).toBe(404);
    expect((await put(body({ expectedDraftVersion: 1, baseVersion: 2 }))).data.code).toBe('INVALID_NOTEBOOK_DRAFT_BASE');
    expect((await get()).data.draftVersion).toBe(1);
  });

  it('preserves the exact older shared base when a colleague saves a newer shared source', async () => {
    const first = (await put()).data.draft;
    const shared = (await service.save(analyst.user.id, project.id, analysis.id, document.id, { requestId: randomUUID(), expectedVersion: 1,
      title: 'Colleague saved source', content: source('colleague()') })).document;
    const next = await put(body({ expectedDraftVersion: 1, title: 'Still based on original' }));
    expect(next.data).toMatchObject({ draft: { baseVersion: 1, baseVersionId: first.baseVersionId }, currentHead: { version: 2, versionId: shared.versionId } });
    expect((await get()).data.draft.baseVersionId).toBe(document.versionId);
  });

  it('clears only the confirmed private version and keeps a CAS tombstone against delayed writes', async () => {
    const firstInput = body(); await put(firstInput);
    const newerInput = body({ expectedDraftVersion: 1, title: 'Newer private edits' }); await put(newerInput);
    expect((await clear(1)).data.code).toBe('NOTEBOOK_DRAFT_CONFLICT');
    expect((await get()).data.draft.title).toBe('Newer private edits');
    const clearId = randomUUID(), erased = await clear(2, owner, clearId);
    expect(erased.data).toMatchObject({ draft: null, draftVersion: 3, checkpoint: { action: 'clear', cleared: true, draftVersion: 3, sha256: null } });
    expect((await clear(2, owner, clearId)).data).toMatchObject({ replayed: true, draft: null, draftVersion: 3 });
    expect((await put(body({ expectedDraftVersion: 0 }))).data.code).toBe('NOTEBOOK_DRAFT_CONFLICT');
    const oldReplay = await put(firstInput); expect(oldReplay.data).toMatchObject({ replayed: true, draft: null, draftVersion: 3, checkpoint: { draftVersion: 1 } });
    expect((await get()).data).toMatchObject({ draft: null, draftVersion: 3 });
    expect((await put(body({ expectedDraftVersion: 3 }))).data.draftVersion).toBe(4);
  });

  it('recovers a real committed checkpoint after the COMMIT acknowledgement is lost', async () => {
    const pool = await db.connect(); let dropped = false;
    const uncertain = { connect: async () => ({ connect: async () => {
      const client = await pool.connect(); let wrote = false;
      return { query: async (text, values) => { const result = await client.query(text, values);
        if (text.includes('INSERT INTO research_document_draft_receipts')) wrote = true;
        if (text === 'COMMIT' && wrote && !dropped) { dropped = true; throw Object.assign(new Error('Connection lost after commit'), { code: 'CONNECTION_LOST' }); }
        return result;
      }, release: () => client.release() };
    } }) };
    const input = body();
    await expect(createNotebookDocumentService(uncertain).putDraft(owner.user.id, project.id, analysis.id, document.id, input)).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect((await get()).data.draftVersion).toBe(1);
    expect((await put(input)).data).toMatchObject({ replayed: true, draftVersion: 1 });
    expect((await db.query('SELECT COUNT(*)::int AS n FROM research_document_draft_receipts')).rows[0].n).toBe(1);
  });

  it('bounds source-free receipts without allowing an expired retry to overwrite the latest private copy', async () => {
    const first = body(); await service.putDraft(owner.user.id, project.id, analysis.id, document.id, first);
    for (let version = 1; version <= NOTEBOOK_DRAFT_LIMITS.receipts; version++) {
      await service.putDraft(owner.user.id, project.id, analysis.id, document.id, body({ expectedDraftVersion: version, title: 'Checkpoint ' + version }));
    }
    expect((await db.query('SELECT COUNT(*)::int AS n FROM research_document_draft_receipts')).rows[0].n).toBe(NOTEBOOK_DRAFT_LIMITS.receipts);
    expect((await put(first)).data.code).toBe('NOTEBOOK_DRAFT_CONFLICT');
    expect((await get()).data.draft.title).toBe('Checkpoint ' + NOTEBOOK_DRAFT_LIMITS.receipts);
    const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='research_document_draft_receipts'")).rows.map(row => row.column_name);
    expect(columns).not.toContain('content_json'); expect(columns).not.toContain('title');
  });

  it('uses parent/member locks and exact database base foreign keys for private checkpoints', async () => {
    const pool = await db.connect(); let releaseGate, reached;
    const gate = new Promise(resolve => { releaseGate = resolve; }), ready = new Promise(resolve => { reached = resolve; });
    const paused = { connect: async () => ({ connect: async () => {
      const client = await pool.connect(); return { query: async (text, values) => { const result = await client.query(text, values);
        if (text.startsWith('SELECT id,status FROM research_analyses')) { reached(); await gate; } return result;
      }, release: () => client.release() };
    } }) };
    const writing = createNotebookDocumentService(paused).putDraft(analyst.user.id, project.id, analysis.id, document.id, body());
    try {
      await ready;
      for (const [text, values] of [['SELECT id FROM research_analyses WHERE id=$1 FOR UPDATE NOWAIT', [analysis.id]],
        ['SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR UPDATE NOWAIT', [project.id, analyst.user.id]]]) {
        const client = await pool.connect();
        try { await client.query('BEGIN'); await expect(client.query(text, values)).rejects.toMatchObject({ code: '55P03' }); }
        finally { await client.query('ROLLBACK'); client.release(); }
      }
    } finally { releaseGate(); }
    expect((await writing).draftVersion).toBe(1);
    await expect(db.query('UPDATE research_document_drafts SET draft_version=draft_version+1,base_version=3 WHERE document_id=$1', [document.id])).rejects.toMatchObject({ code: '23503' });
    await expect(db.query('UPDATE research_document_drafts SET owner_user_id=$2 WHERE document_id=$1', [document.id, owner.user.id])).rejects.toMatchObject({ code: '55000' });
  });

  it('retains private drafts through schema reapply and removes only an expired guest project copies/receipts', async () => {
    const retained = (await put()).data.draft;
    await db.initSchema({ force: true }); expect((await get()).data.draft).toEqual(retained);
    const guest = await db.createDemoGuest(`draft-cleanup-${randomUUID()}@example.test`, 'password123', new Date(Date.now() + 3600000));
    const guestAnalysis = (await analyses.create(guest.user.id, guest.project.id, { requestId: randomUUID(), name: 'Guest question' })).analysis;
    const guestDoc = (await service.create(guest.user.id, guest.project.id, guestAnalysis.id, { requestId: randomUUID(), title: 'Guest', content: source('guest()') })).document;
    await service.putDraft(guest.user.id, guest.project.id, guestAnalysis.id, guestDoc.id,
      body({ baseVersion: guestDoc.version, baseVersionId: guestDoc.versionId }));
    await db.query("UPDATE users SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [guest.user.id]);
    expect(await db.deleteExpiredDemoGuest(guest.user.id)).toBe(true);
    expect((await get()).data.draft).toEqual(retained);
    for (const table of ['research_document_drafts', 'research_document_draft_receipts']) {
      expect((await db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE project_id=$1`, [guest.project.id])).rows[0].n).toBe(0);
    }
  });

  it('enforces bounded bodies, notebook source and inert view state on authenticated private routes', async () => {
    expect((await put(body({ content: source('x'.repeat(256 * 1024 + 1)) }))).status).toBe(413);
    expect((await put(body({ uiState: { source: 'not view state' } }))).status).toBe(400);
    expect((await put({ padding: 'x'.repeat(2 * 1024 * 1024 + 1) })).status).toBe(413);
    const huge = await api(server, path(), { method: 'PUT', body: { padding: 'x'.repeat(2 * 1024 * 1024 + 1) } });
    expect(huge.status).toBe(401);
    const cells = Array.from({ length: 1000 }, (_, index) => ({ id: 'cell-' + index, type: 'code', language: 'R', source: '# unexecuted\n' + 'x'.repeat(120) }));
    const large = body({ content: { schema: 'traceomics.notebook.v1', defaultLanguage: 'R', cells }, uiState: {} });
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(100 * 1024); expect((await put(large)).status).toBe(200);
    expect((await get()).data.draft.content.cells).toHaveLength(1000);
    const shared = await api(server, base() + '/' + document.id, { token: owner.token }); expect(shared.data.document).toEqual(document);
  });
});
