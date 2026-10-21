import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { NOTEBOOK_DOCUMENT_SCHEMA, canonicalNotebookContent } from '../shared/notebookDocument.mjs';
import { importScriptDocument, copyScriptToNotebook } from '../shared/scriptDocument.mjs';

const db = require('./pgDatabase');
const config = require('./config');
const { createResearchAnalysisService } = require('./researchAnalyses');
const { createNotebookDocumentService, notebookDocumentRoutes } = require('./notebookDocuments');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const configured = config.hasPostgresConnection();
const content = (source = 'ncol(object)\r\n', extra = {}) => ({ schema: NOTEBOOK_DOCUMENT_SCHEMA, defaultLanguage: 'R',
  cells: [{ id: 'question', type: 'markdown', source: '# Scientific question\n' },
    { id: 'inspect-cell', type: 'code', language: 'R', source, metadata: { tags: ['inspection'] } }], ...extra });
const createBody = (extra = {}) => ({ requestId: randomUUID(), title: 'Treatment response', content: content(), ...extra });
const saveBody = (document, extra = {}) => ({ requestId: randomUUID(), expectedVersion: document.version, title: document.title, content: document.content, ...extra });
const sha = value => createHash('sha256').update(canonicalNotebookContent(value)).digest('hex');

describe.skipIf(!configured)('project notebook documents through actual HTTP and PostgreSQL', () => {
  let server, owner, analyst, viewer, outsider, project, otherProject, analysis, otherAnalysis, analyses;
  beforeAll(async () => { server = await startServer(); });
  beforeEach(async () => {
    await db.resetSchemaForTests();
    analyses = createResearchAnalysisService();
    owner = await createUserWithToken({ email: 'notebook-owner@example.test' });
    analyst = await createUserWithToken({ email: 'notebook-analyst@example.test' });
    viewer = await createUserWithToken({ email: 'notebook-viewer@example.test' });
    outsider = await createUserWithToken({ email: 'notebook-outsider@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Notebook lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Notebook study' });
    otherProject = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Different project' });
    await db.addProjectMember(project.id, analyst.user.id, 'analyst');
    await db.addProjectMember(project.id, viewer.user.id, 'viewer');
    analysis = (await analyses.create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Research question' })).analysis;
    otherAnalysis = (await analyses.create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Another question' })).analysis;
  });
  afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); await db.close(); });
  const endpoint = (selectedAnalysis = analysis, selectedProject = project) => `/api/projects/${selectedProject.id}/analyses/${selectedAnalysis.id}/documents`;
  const post = (body = createBody(), actor = owner) => api(server, endpoint(), { method: 'POST', token: actor.token, body });
  const put = (document, body = saveBody(document), actor = owner) => api(server, endpoint() + '/' + document.id, { method: 'PUT', token: actor.token, body });
  const count = async table => Number((await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n);

  it('creates explicitly project-shared source with exact IDs, checksums and an atomic retained version/receipt', async () => {
    const input = createBody(), response = await post(input);
    expect(response.status).toBe(201);
    const doc = response.data.document;
    expect(doc).toMatchObject({ projectId: project.id, analysisId: analysis.id, visibility: 'project', title: input.title,
      version: 1, sha256: sha(input.content), createdByUserId: owner.user.id, updatedByUserId: owner.user.id,
      cellCount: 2, codeCellCount: 1, defaultLanguage: 'R' });
    expect(doc.id).toMatch(/^doc_[a-f0-9]{24}$/); expect(doc.versionId).toMatch(/^dv_[a-f0-9]{24}$/);
    expect(doc.content.cells[1].source).toBe(input.content.cells[1].source);
    expect(doc.contentBytes).toBe(Buffer.byteLength(canonicalNotebookContent(input.content)));
    expect(response.data).toMatchObject({ replayed: false, currentHead: { id: doc.id, version: 1, versionId: doc.versionId },
      submission: { requestId: input.requestId, action: 'create', documentId: doc.id, versionId: doc.versionId, sha256: doc.sha256 } });
    expect(response.res.headers.get('cache-control')).toContain('no-store');
    expect(await count('research_documents')).toBe(1); expect(await count('research_document_revisions')).toBe(1); expect(await count('research_document_submissions')).toBe(1);
    const read = await api(server, endpoint() + '/' + doc.id, { token: viewer.token });
    expect(read.status).toBe(200); expect(read.data.document).toEqual(doc);
  });

  it('reopens several notebooks and returns bounded summaries without source or metadata', async () => {
    const ids = [];
    for (let index = 0; index < 5; index++) ids.push((await post(createBody({ title: `Notebook ${index}` }))).data.document.id);
    const found = []; let cursor;
    do {
      const response = await api(server, endpoint() + '?limit=2' + (cursor ? '&cursor=' + cursor : ''), { token: viewer.token });
      expect(response.status).toBe(200); expect(response.data.documents.length).toBeLessThanOrEqual(2);
      for (const doc of response.data.documents) { expect(doc).not.toHaveProperty('content'); expect(doc).not.toHaveProperty('metadata'); found.push(doc.id); }
      cursor = response.data.nextCursor;
    } while (cursor);
    expect(found).toHaveLength(5); expect(new Set(found)).toEqual(new Set(ids));
  });

  it('retains original content/title while edits, order and collapse create exact immutable versions', async () => {
    const original = (await post()).data.document;
    const cells = original.content.cells.map(cell => ({ ...cell }));
    cells.reverse(); cells[0].source = '  # β 🧬\r\n\tx <- "é"  \r\n'; cells[0].collapsed = true;
    const saved = await put(original, saveBody(original, { title: 'Revised title', content: { ...original.content, cells } }), analyst);
    expect(saved.status).toBe(200);
    const next = saved.data.document;
    expect(next).toMatchObject({ id: original.id, version: 2, title: 'Revised title', updatedByUserId: analyst.user.id });
    expect(next.versionId).not.toBe(original.versionId); expect(next.sha256).toBe(sha(next.content));
    expect(next.content.cells.map(cell => cell.id)).toEqual(['inspect-cell', 'question']);
    const old = await api(server, endpoint() + '/' + original.id + '/versions/' + original.versionId, { token: viewer.token });
    expect(old.status).toBe(200); expect(old.data.document).toEqual(original); expect(old.data.currentHead.version).toBe(2);
    const renamed = await put(next, saveBody(next, { title: 'Title only update' }));
    expect(renamed.data.document).toMatchObject({ version: 3, title: 'Title only update', sha256: next.sha256 });
    expect(renamed.data.document.versionId).not.toBe(next.versionId);
  });

  it('uses compare-and-swap for two project editors without losing either retained version', async () => {
    const original = (await post()).data.document;
    const replies = await Promise.all([put(original, saveBody(original, { content: content('owner_change()\n') })),
      put(original, saveBody(original, { content: content('analyst_change()\n') }), analyst)]);
    expect(replies.map(reply => reply.status).sort()).toEqual([200, 409]);
    const success = replies.find(reply => reply.status === 200).data;
    expect(replies.find(reply => reply.status === 409).data).toMatchObject({ code: 'NOTEBOOK_VERSION_CONFLICT', submittedExpectedVersion: 1,
      currentHead: { version: 2, versionId: success.document.versionId, sha256: success.document.sha256 } });
    expect(await count('research_document_revisions')).toBe(2);
    const originalRow = (await db.query('SELECT content_json FROM research_document_revisions WHERE id=$1', [original.versionId])).rows[0];
    expect(originalRow.content_json).toEqual(original.content);
  });

  it('keeps validated source-free script kind on summaries and exact historical versions after metadata conversion', async () => {
    const script = importScriptDocument({ filename: 'inspect.R', bytes: new TextEncoder().encode('  inspect()\r\n'), cellId: 'whole-script' });
    const original = (await post(createBody({ title: 'Imported script', content: script }))).data.document;
    expect(original.documentKind).toBe('script');
    const firstList = await api(server, endpoint(), { token: viewer.token });
    expect(firstList.data.documents[0]).toMatchObject({ id: original.id, documentKind: 'script' });
    expect(firstList.data.documents[0]).not.toHaveProperty('content');
    const converted = await put(original, saveBody(original, { content: copyScriptToNotebook(original.content) }));
    expect(converted.data).toMatchObject({ document: { documentKind: 'notebook', version: 2 }, currentHead: { documentKind: 'notebook' } });
    const exactOld = await api(server, endpoint() + '/' + original.id + '/versions/' + original.versionId, { token: viewer.token });
    expect(exactOld.data).toMatchObject({ document: { documentKind: 'script', version: 1 }, currentHead: { documentKind: 'notebook', version: 2 } });
    expect(exactOld.data.document.content.cells[0].source).toBe('  inspect()\r\n');
    const malformed = structuredClone(script); malformed.metadata.traceomics.script.language = 'python';
    const ordinary = await post(createBody({ title: 'Ordinary source with inert invalid marker', content: malformed }));
    expect(ordinary.status).toBe(201); expect(ordinary.data.document.documentKind).toBe('notebook');
    const finalList = await api(server, endpoint(), { token: viewer.token });
    expect(finalList.data.documents.every(item => item.documentKind === 'notebook' && !Object.hasOwn(item, 'content'))).toBe(true);
  });

  it('serializes repeated create UUIDs and replays the original version even after the head advances', async () => {
    const input = createBody();
    const responses = await Promise.all(Array.from({ length: 5 }, () => post(input)));
    expect(responses.filter(reply => reply.status === 201)).toHaveLength(1);
    expect(responses.filter(reply => reply.data.replayed)).toHaveLength(4);
    const original = responses[0].data.document;
    await put(original, saveBody(original, { title: 'Newer work' }));
    const replay = await post(input);
    expect(replay.status).toBe(200); expect(replay.data.document).toEqual(original);
    expect(replay.data).toMatchObject({ replayed: true, currentHead: { version: 2, title: 'Newer work' } });
    expect(await count('research_documents')).toBe(1); expect(await count('research_document_revisions')).toBe(2);
    expect((await post({ ...input, title: 'Changed request' })).data.code).toBe('NOTEBOOK_REQUEST_CONFLICT');
  });

  it('replays a save receipt before checking a now-stale CAS base and rejects changed-body UUID reuse', async () => {
    const original = (await post()).data.document, input = saveBody(original, { title: 'Saved second' });
    const replies = await Promise.all(Array.from({ length: 5 }, () => put(original, input)));
    expect(replies.every(reply => reply.status === 200)).toBe(true);
    expect(replies.filter(reply => reply.data.replayed)).toHaveLength(4);
    const second = replies[0].data.document;
    await put(second, saveBody(second, { title: 'Saved third' }), analyst);
    const replay = await put(original, input);
    expect(replay.data.document).toEqual(second); expect(replay.data.currentHead).toMatchObject({ version: 3, title: 'Saved third' });
    expect((await put(original, { ...input, expectedVersion: 3 })).data.code).toBe('NOTEBOOK_REQUEST_CONFLICT');
    expect((await put(original, { ...input, title: 'Different' })).status).toBe(409);
    expect(await count('research_document_revisions')).toBe(3);
  });

  it('keeps UUID receipts owner-scoped and rejects reusing one for a different document', async () => {
    const first = (await post()).data.document, second = (await post()).data.document;
    const input = saveBody(first);
    expect((await put(first, input)).status).toBe(200);
    expect((await put(second, { ...input, expectedVersion: second.version })).data.code).toBe('NOTEBOOK_REQUEST_CONFLICT');
    expect((await put(second, { ...input, expectedVersion: second.version }, analyst)).status).toBe(200);
  });

  it('enforces membership, role and project/analysis/version identity on all source reads and writes', async () => {
    const original = (await post()).data.document;
    expect((await post(createBody(), viewer)).status).toBe(403);
    expect((await put(original, saveBody(original), viewer)).status).toBe(403);
    for (const path of [endpoint(), endpoint() + '/' + original.id, endpoint() + '/' + original.id + '/versions/' + original.versionId]) {
      expect((await api(server, path, { token: outsider.token })).status).toBe(404);
      expect((await api(server, path)).status).toBe(401);
    }
    expect((await api(server, endpoint(otherAnalysis) + '/' + original.id, { token: owner.token })).status).toBe(404);
    expect((await api(server, endpoint(analysis, otherProject) + '/' + original.id, { token: owner.token })).status).toBe(404);
    const second = (await post()).data.document;
    expect((await api(server, endpoint() + '/' + original.id + '/versions/' + second.versionId, { token: owner.token })).status).toBe(404);
    await db.removeProjectMember(project.id, analyst.user.id, { userId: owner.user.id });
    expect((await put(original, saveBody(original), analyst)).status).toBe(404);
  });

  it('blocks new saves/creates after parent archive but preserves reads and matching historical recovery', async () => {
    const input = createBody(), original = (await post(input)).data.document;
    const savedInput = saveBody(original), second = (await put(original, savedInput)).data.document;
    await analyses.patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, status: 'archived' });
    expect((await post()).data.code).toBe('ANALYSIS_ARCHIVED');
    expect((await put(second, saveBody(second))).data.code).toBe('ANALYSIS_ARCHIVED');
    expect((await api(server, endpoint() + '/' + original.id, { token: viewer.token })).status).toBe(200);
    expect((await post(input)).data).toMatchObject({ replayed: true, document: { version: 1 }, currentHead: { version: 2 } });
    expect((await put(original, savedInput)).data).toMatchObject({ replayed: true, document: { version: 2 } });
    await analyses.patch(owner.user.id, project.id, analysis.id, { expectedVersion: 2, status: 'active' });
    expect((await put(second, saveBody(second))).status).toBe(200);
  });

  it('allows matching own receipt recovery after downgrade without admitting new writes', async () => {
    const input = createBody(), original = (await post(input, analyst)).data.document;
    const savedInput = saveBody(original), second = (await put(original, savedInput, analyst)).data.document;
    await db.updateProjectMemberRole(project.id, analyst.user.id, 'viewer', { userId: owner.user.id });
    expect((await post(input, analyst)).data.replayed).toBe(true);
    expect((await put(original, savedInput, analyst)).data.replayed).toBe(true);
    expect((await put(second, saveBody(second), analyst)).status).toBe(403);
    await db.removeProjectMember(project.id, analyst.user.id, { userId: owner.user.id });
    expect((await put(original, savedInput, analyst)).status).toBe(404);
  });

  it('holds parent and membership row locks through the write boundary', async () => {
    const original = (await post()).data.document, pool = await db.connect();
    let releaseGate, reached;
    const gate = new Promise(resolve => { releaseGate = resolve; });
    const ready = new Promise(resolve => { reached = resolve; });
    const paused = { connect: async () => ({ connect: async () => {
      const client = await pool.connect();
      return { query: async (text, values) => { const result = await client.query(text, values);
        if (text.startsWith('SELECT id,status FROM research_analyses')) { reached(); await gate; }
        return result;
      }, release: () => client.release() };
    } }) };
    const saving = createNotebookDocumentService(paused).save(analyst.user.id, project.id, analysis.id, original.id, saveBody(original));
    try {
      await ready;
      for (const [text, values] of [
        ['SELECT id FROM research_analyses WHERE id=$1 FOR UPDATE NOWAIT', [analysis.id]],
        ['SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR UPDATE NOWAIT', [project.id, analyst.user.id]],
      ]) {
        const client = await pool.connect();
        try { await client.query('BEGIN'); await expect(client.query(text, values)).rejects.toMatchObject({ code: '55P03' }); }
        finally { await client.query('ROLLBACK'); client.release(); }
      }
    } finally { releaseGate(); }
    expect((await saving).document.version).toBe(2);
  });

  it('uses actual database append-only protections and exact head foreign keys', async () => {
    const original = (await post()).data.document;
    for (const sql of [
      'UPDATE research_document_revisions SET title=\'Changed\' WHERE id=$1',
      'DELETE FROM research_document_revisions WHERE id=$1',
    ]) await expect(db.query(sql, [original.versionId])).rejects.toMatchObject({ code: '55000' });
    for (const sql of ["UPDATE research_document_submissions SET request_sha256=repeat('a',64) WHERE version_id=$1", 'DELETE FROM research_document_submissions WHERE version_id=$1']) {
      await expect(db.query(sql, [original.versionId])).rejects.toMatchObject({ code: '55000' });
    }
    await expect(db.query('UPDATE research_documents SET title=\'Changed\' WHERE id=$1', [original.id])).rejects.toMatchObject({ code: '55000' });
    const second = (await post()).data.document;
    await expect(db.query('UPDATE research_documents SET version=version+1,head_version_id=$2 WHERE id=$1', [original.id, second.versionId])).rejects.toMatchObject({ code: '23503' });
  });

  it('recovers a real committed create/save after the COMMIT reply is lost without duplicating revisions', async () => {
    const express = require('express'), pool = await db.connect();
    let dropped = false;
    const uncertain = { connect: async () => ({ connect: async () => {
      const client = await pool.connect(); let wrote = false;
      return { query: async (text, values) => { const result = await client.query(text, values);
        if (text.includes('INSERT INTO research_document_revisions')) wrote = true;
        if (text === 'COMMIT' && wrote && !dropped) { dropped = true; throw Object.assign(new Error('Private connection details'), { code: 'CONNECTION_LOST' }); }
        return result;
      }, release: () => client.release() };
    } }) };
    const app = express(); app.use((req, _res, next) => { req.user = owner.user; next(); });
    app.use('/api/projects/:projectId/analyses/:analysisId/documents', notebookDocumentRoutes({ database: uncertain, logger: { error() {} } }));
    const listener = await new Promise(resolve => { const active = app.listen(0, '127.0.0.1', () => resolve(active)); });
    try {
      const input = createBody();
      const lost = await api(listener, endpoint(), { method: 'POST', body: input });
      expect(lost.status).toBe(500); expect(lost.data.error).toMatch(/could not be confirmed/); expect(lost.data.error).not.toMatch(/Private|unchanged/);
      const recovered = await post(input); expect(recovered.status).toBe(200); expect(recovered.data.replayed).toBe(true);
      expect(await count('research_documents')).toBe(1); expect(await count('research_document_revisions')).toBe(1);
      dropped = false;
      const saveInput = saveBody(recovered.data.document, { title: 'Saved despite lost reply' });
      const lostSave = await api(listener, endpoint() + '/' + recovered.data.document.id, { method: 'PUT', body: saveInput });
      expect(lostSave.status).toBe(500);
      const retry = await put(recovered.data.document, saveInput);
      expect(retry.data).toMatchObject({ replayed: true, document: { version: 2, title: 'Saved despite lost reply' } });
      expect(await count('research_document_revisions')).toBe(2);
    } finally { await new Promise(resolve => listener.close(resolve)); }
  });

  it('reapplies schema upgrades without replacing exact retained notebook versions', async () => {
    const original = (await post()).data.document;
    const second = (await put(original, saveBody(original, { title: 'Retained second', content: content('exact_source()\r\n') }))).data.document;
    await db.initSchema({ force: true }); await db.initSchema({ force: true });
    expect((await api(server, endpoint() + '/' + original.id, { token: viewer.token })).data.document).toEqual(second);
    expect((await api(server, endpoint() + '/' + original.id + '/versions/' + original.versionId, { token: viewer.token })).data.document).toEqual(original);
    expect((await db.query("SELECT schema_version FROM app_schema_contract WHERE schema_key='traceomics.runtime'")).rows[0].schema_version).toBe(20261027);
  });

  it('deletes an expired guest notebook head/version/receipt cycle while preserving another project', async () => {
    const retained = (await post()).data.document;
    const guest = await db.createDemoGuest(`notebook-cleanup-${randomUUID()}@example.test`, 'password123', new Date(Date.now() + 3600000));
    const guestAnalysis = (await analyses.create(guest.user.id, guest.project.id, { requestId: randomUUID(), name: 'Guest question' })).analysis;
    const service = createNotebookDocumentService();
    const first = (await service.create(guest.user.id, guest.project.id, guestAnalysis.id, createBody())).document;
    await service.save(guest.user.id, guest.project.id, guestAnalysis.id, first.id, saveBody(first, { title: 'Guest second version' }));
    await db.query("UPDATE users SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [guest.user.id]);
    expect(await db.deleteExpiredDemoGuest(guest.user.id)).toBe(true);
    for (const table of ['research_documents', 'research_document_revisions', 'research_document_submissions']) {
      expect((await db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE project_id=$1`, [guest.project.id])).rows[0].n).toBe(0);
    }
    expect((await api(server, endpoint() + '/' + retained.id, { token: viewer.token })).data.document).toEqual(retained);
    await expect(db.query('DELETE FROM research_document_revisions WHERE id=$1', [retained.versionId])).rejects.toMatchObject({ code: '55000' });
  });

  it('accepts more than the default100KB only on notebook routes and preserves the global project parser limit', async () => {
    const cells = Array.from({ length: 1000 }, (_, index) => ({ id: `cell-${index}`, type: index % 5 ? 'code' : 'markdown',
      ...(index % 5 ? { language: index % 2 ? 'R' : 'python' } : {}), source: `# Unexecuted source ${index}\n` + 'x'.repeat(120) }));
    const input = createBody({ content: content('', { cells }) });
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(100 * 1024);
    const response = await post(input); expect(response.status).toBe(201); expect(response.data.document.cellCount).toBe(1000);
    const read = await api(server, endpoint() + '/' + response.data.document.id, { token: viewer.token });
    expect(read.data.document.content.cells).toHaveLength(1000);
    const unchangedGlobal = await api(server, `/api/projects/${project.id}/analyses`, { method: 'POST', token: owner.token,
      body: { requestId: randomUUID(), name: 'Too large ordinary metadata', description: 'x'.repeat(120 * 1024) } });
    expect(unchangedGlobal.status).toBe(413);
  });

  it('authenticates before large parsing and rejects malformed, compressed and oversized source requests safely', async () => {
    const huge = { padding: 'x'.repeat(2 * 1024 * 1024 + 100) };
    expect((await api(server, endpoint(), { method: 'POST', body: huge })).status).toBe(401);
    const oversize = await post(huge); expect(oversize.status).toBe(413); expect(oversize.data.error).toMatch(/2 MiB/);
    expect((await post(createBody({ content: content('x'.repeat(256 * 1024 + 1)) }))).status).toBe(413);
    expect((await api(server, endpoint(), { method: 'POST', token: owner.token, headers: { 'Content-Type': 'text/plain' }, body: createBody() })).status).toBe(415);
    expect((await api(server, endpoint(), { method: 'POST', token: owner.token, headers: { 'Content-Encoding': 'gzip' }, body: createBody() })).status).toBe(415);
    const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint()}`, { method: 'POST',
      headers: { Cookie: `${config.sessionCookieName()}=${owner.token}`, Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: '{"malformed"' });
    expect(response.status).toBe(400); expect((await response.json()).error).not.toContain('malformed');
    expect(await count('research_documents')).toBe(0);
  });

  it('rejects invalid source structure and cursor/identity inputs without altering saved evidence', async () => {
    const original = (await post()).data.document;
    for (const extra of [{ outputs: [] }, { ownerUserId: outsider.user.id }, { schema: 'unsupported' }]) {
      expect((await put(original, saveBody(original, { content: { ...original.content, ...extra } }))).status).toBe(400);
    }
    expect((await api(server, endpoint() + '?cursor=' + encodeURIComponent(JSON.stringify({ bad: true })), { token: owner.token })).status).toBe(400);
    expect((await api(server, endpoint() + '?limit=101', { token: owner.token })).status).toBe(400);
    expect((await api(server, endpoint() + '/not-a-document', { token: owner.token })).status).toBe(400);
    expect(await count('research_document_revisions')).toBe(1);
  });
});
