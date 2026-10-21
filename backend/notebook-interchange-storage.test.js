// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalNotebookContent, normalizeNotebookContent, normalizeNotebookCreate, normalizeNotebookSave } from '../shared/notebookDocument.mjs';
import { importNotebookFile, exportNotebookFile } from '../shared/notebookInterchange.mjs';
import { canonicalNotebookDraftSnapshot, normalizeNotebookDraft } from '../shared/notebookDraft.mjs';
import { canonicalNotebookPendingRequest } from '../shared/notebookPending.mjs';

const db = require('./pgDatabase');
const config = require('./config');
const { createNotebookDocumentService } = require('./notebookDocuments');
const { createResearchAnalysisService } = require('./researchAnalyses');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const legacy = () => ({ schema: 'traceomics.notebook.v1', defaultLanguage: 'R', metadata: { z: 2, a: { b: true, a: 'β' } },
  cells: [{ id: 'study', type: 'markdown', source: '# Question\r\n' },
    { id: 'inspect', type: 'code', language: 'R', source: '  ncol(object)\r\n\n', metadata: { tags: ['inspection'] } }] });
const notebookFile = () => ({ nbformat: 4, nbformat_minor: 5,
  metadata: { kernelspec: { name: 'ir', display_name: 'R', language: 'R' }, language_info: { name: 'R', version: '4.4.0' },
    custom: { retained: true, projectId: 'outside-project', kernelId: 'outside-kernel' } },
  cells: [
    { id: 'notes', cell_type: 'markdown', source: ['# Imported study\r\n', '![caption](attachment:figure.svg)\n'], metadata: { tags: ['context'] },
      attachments: { 'figure.svg': { 'image/svg+xml': '<svg onload="untrusted()"><script>untrusted()</script></svg>' } } },
    { id: 'inspect', cell_type: 'code', source: ['  ncol(object)\r\n', '# exact trailing spaces  \n'], metadata: { collapsed: true, custom: { output: 'historical' } }, execution_count: 9,
      outputs: [{ output_type: 'execute_result', execution_count: 9, metadata: { custom: 'retain' },
        data: { 'text/plain': ['historical count: ', '12'], 'text/html': '<script>globalThis.importedExecution = true</script>',
          'application/javascript': 'globalThis.importedExecution = true', 'application/json': { cells: 12, original: true } } },
      { output_type: 'stream', name: 'stdout', text: ['old output\r\n', 'not rerun\n'] }] },
    { id: 'raw', cell_type: 'raw', source: '\\begin{equation} x=1 \\end{equation}\r\n', metadata: { format: 'text/latex', custom: ['keep'] } },
  ] });
const imported = () => importNotebookFile({ filename: 'Historical study.ipynb', source: JSON.stringify(notebookFile()) }).content;

describe('v2 document normalization preserves existing saved request identities', () => {
  it('retains the literal v1 canonical text and its previously captured checksum', () => {
    const canonical = canonicalNotebookContent(legacy());
    expect(canonical).toBe('{"schema":"traceomics.notebook.v1","defaultLanguage":"R","cells":[{"id":"study","type":"markdown","source":"# Question\\r\\n","metadata":{},"collapsed":false},{"id":"inspect","type":"code","language":"R","source":"  ncol(object)\\r\\n\\n","metadata":{"tags":["inspection"]},"collapsed":false}],"metadata":{"a":{"a":"β","b":true},"z":2}}');
    expect(hash(canonical)).toBe('4333fbd581d3052eba3a7eb72fba615eb37709ec56da075300791aca5e2b724e');
  });

  it('admits exact raw source and historical imported data through create/save/draft/pending contracts', () => {
    const content = imported(), requestId = randomUUID(), canonical = canonicalNotebookContent(content);
    expect(normalizeNotebookContent(JSON.parse(canonical))).toEqual(content);
    expect(normalizeNotebookCreate({ requestId, title: 'Imported', content }).content).toEqual(content);
    expect(normalizeNotebookSave({ requestId, expectedVersion: 1, title: 'Imported', content }).content).toEqual(content);
    const draft = normalizeNotebookDraft({ requestId, expectedDraftVersion: 0, baseVersion: 1, baseVersionId: 'dv_' + 'a'.repeat(24),
      title: 'Imported', content, uiState: { activeCellId: 'raw', scrollTop: 120 } });
    expect(JSON.parse(canonicalNotebookDraftSnapshot(draft)).content).toEqual(content);
    const pending = JSON.parse(canonicalNotebookPendingRequest({ action: 'create', projectId: 'project', analysisId: 'analysis', payload: { requestId, title: 'Imported', content } }));
    expect(pending.content).toEqual(content);
    expect(content.cells[2]).toMatchObject({ type: 'raw', source: notebookFile().cells[2].source });
    expect(content.cells[1].imported.outputs[0].data['application/javascript']).toContain('importedExecution');
    expect(globalThis.importedExecution).toBeUndefined();
  });

  it('never reads accessor schema fields when dispatching to a document version', () => {
    let reads = 0;
    const content = { ...imported() };
    Object.defineProperty(content, 'schema', { enumerable: true, get() { reads++; return 'traceomics.notebook.v2'; } });
    expect(() => normalizeNotebookContent(content)).toThrow(expect.objectContaining({ code: 'INVALID_NOTEBOOK_DOCUMENT', status: 400 }));
    expect(reads).toBe(0);
  });
});

describe.skipIf(!config.hasPostgresConnection())('imported notebook source, private draft and pending storage through PostgreSQL/HTTP', () => {
  let server, service, owner, analyst, project, analysis, document;
  beforeAll(async () => { server = await startServer(); });
  beforeEach(async () => {
    await db.resetSchemaForTests(); service = createNotebookDocumentService();
    owner = await createUserWithToken({ email: 'interchange-owner@example.test' });
    analyst = await createUserWithToken({ email: 'interchange-analyst@example.test' });
    const org = await db.createOrganizationForUser(owner.user.id, { name: 'Interchange lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: org.id, name: 'Imported study' });
    await db.addProjectMember(project.id, analyst.user.id, 'analyst');
    analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Historical notebook review' })).analysis;
    document = (await service.create(owner.user.id, project.id, analysis.id, { requestId: randomUUID(), title: 'Original source', content: legacy() })).document;
  });
  afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); await db.close(); });
  const base = () => `/api/projects/${project.id}/analyses/${analysis.id}/documents`;
  const scope = () => [owner.user.id, project.id, analysis.id];
  const count = async table => (await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
  const noExecution = async () => {
    for (const table of ['jobs', 'private_r_kernels', 'private_r_executions', 'managed_artifact_versions']) expect(await count(table)).toBe(0);
  };

  it('creates and edits retained imported source as ordinary versions without promoting old outputs into executions', async () => {
    const content = imported(), payload = { requestId: randomUUID(), title: 'Imported study', content };
    const created = await api(server, base(), { method: 'POST', token: owner.token, body: payload });
    expect(created.status).toBe(201); expect(created.data.document.content).toEqual(content);
    expect(created.data.document).toMatchObject({ documentKind: 'notebook', cellCount: 3, codeCellCount: 1,
      sha256: hash(canonicalNotebookContent(content)), contentBytes: Buffer.byteLength(canonicalNotebookContent(content)) });
    const edited = structuredClone(content); edited.cells[1].source += 'new_inspection()\r\n';
    const saved = await service.save(...scope(), created.data.document.id, { requestId: randomUUID(), expectedVersion: 1, title: payload.title, content: edited });
    expect(saved.document.version).toBe(2); expect(saved.document.content.cells[1].imported).toEqual(content.cells[1].imported);
    expect((await service.get(...scope(), saved.document.id, created.data.document.versionId)).document.content).toEqual(content);
    expect((await service.create(...scope(), payload)).document.content).toEqual(content);
    const changedOutput = structuredClone(content); changedOutput.cells[1].imported.executionCount = 10;
    await expect(service.create(...scope(), { ...payload, content: changedOutput })).rejects.toMatchObject({ code: 'NOTEBOOK_REQUEST_CONFLICT' });
    const exported = JSON.parse(exportNotebookFile(saved.document.content).text);
    expect(exported.cells[1].outputs).toEqual(content.cells[1].imported.outputs);
    expect(exported.cells[2].cell_type).toBe('raw'); expect(exported.cells[2].source).toBe(notebookFile().cells[2].source);
    expect(exported.metadata).toEqual(notebookFile().metadata);
    await noExecution();
  });

  it('preserves a newer private imported draft when an older confirmed checkpoint is submitted', async () => {
    const content = imported(), draftInput = { requestId: randomUUID(), expectedDraftVersion: 0, baseVersion: 1, baseVersionId: document.versionId,
      title: 'Private imported edit', content, uiState: { activeCellId: 'raw', scrollTop: 125 } };
    const draft = await service.putDraft(...scope(), document.id, draftInput);
    expect(draft.draft.content).toEqual(content);
    const payload = { requestId: randomUUID(), expectedVersion: 1, title: draftInput.title, content };
    const admitted = await service.admitPending(...scope(), document.id, { expectedJournalVersion: 0, confirmedDraftVersion: 1, payload });
    expect(admitted.journal.payload.content).toEqual(content);
    const newer = structuredClone(content); newer.cells[2].source += '\nnewer private raw text';
    await service.putDraft(...scope(), document.id, { ...draftInput, requestId: randomUUID(), expectedDraftVersion: 1, content: newer });
    const submitted = await service.submitPending(...scope(), document.id, { requestId: payload.requestId, admittedVersion: 1 });
    expect(submitted.result.document.content).toEqual(content); expect(submitted.journal).toMatchObject({ state: 'succeeded', payload: null });
    expect((await service.getDraft(...scope(), document.id)).draft).toMatchObject({ draftVersion: 2, content: newer });
    expect((await service.getDraft(analyst.user.id, project.id, analysis.id, document.id)).draft).toBeNull();
    expect((await service.getPending(analyst.user.id, project.id, analysis.id, document.id)).journal).toBeNull();
    expect((await service.get(analyst.user.id, project.id, analysis.id, document.id)).document.content).toEqual(content);
    expect(JSON.stringify(await service.listPending(...scope()))).not.toContain('importedExecution');
    expect(JSON.stringify(await service.list(...scope()))).not.toContain('figure.svg');
    expect((await service.get(...scope(), document.id, document.versionId)).document.sha256).toBe('4333fbd581d3052eba3a7eb72fba615eb37709ec56da075300791aca5e2b724e');
    await noExecution();
  });

  it('recovers an imported create after its actual source transaction commits but its acknowledgement is lost', async () => {
    const payload = { requestId: randomUUID(), title: 'Pending imported source', content: imported() };
    const admitted = await service.admitPending(...scope(), null, { expectedJournalVersion: 0, confirmedDraftVersion: null, payload });
    const pool = await db.connect(); let lost = false;
    const uncertain = { connect: async () => ({ connect: async () => { const client = await pool.connect(); let wrote = false; return {
      query: async (sql, values) => { const result = await client.query(sql, values); if (sql.includes('INSERT INTO research_document_revisions')) wrote = true;
        if (sql === 'COMMIT' && wrote && !lost) { lost = true; throw Object.assign(new Error('Lost source acknowledgement'), { code: 'CONNECTION_LOST' }); } return result; },
      release: () => client.release(),
    }; } }) };
    const submit = { requestId: payload.requestId, admittedVersion: admitted.admission.admittedVersion };
    await expect(createNotebookDocumentService(uncertain).submitPending(...scope(), null, submit)).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    const recovered = await service.getPending(...scope()); expect(recovered.journal).toMatchObject({ state: 'succeeded', payload: null });
    const replay = await service.submitPending(...scope(), null, submit);
    expect(replay.replayed).toBe(true); expect(replay.result.document.content).toEqual(payload.content);
    expect(replay.result.submission.sha256).toBe(hash(canonicalNotebookContent(payload.content)));
    expect(await count('research_documents')).toBe(2); expect(await count('research_document_revisions')).toBe(2);
    await noExecution();
  });

  it('returns useful bounded interchange errors without mutating existing source, drafts or pending slots', async () => {
    const malformed = imported(); malformed.cells[1].imported.executionCount = 'not a count';
    const response = await api(server, base(), { method: 'POST', token: owner.token,
      body: { requestId: randomUUID(), title: 'Invalid imported source', content: malformed } });
    expect(response.status).toBe(400); expect(response.data).toMatchObject({ code: 'INVALID_NOTEBOOK_INTERCHANGE' });
    const large = imported(); large.cells[1].imported.outputs[0].data['text/html'] = 'x'.repeat(1024 * 1024 + 1);
    const oversized = await api(server, base() + '/' + document.id + '/pending', { method: 'PUT', token: owner.token,
      body: { expectedJournalVersion: 0, confirmedDraftVersion: null,
        payload: { requestId: randomUUID(), expectedVersion: 1, title: 'Too much imported source', content: large } } });
    expect(oversized.status).toBe(413); expect(oversized.data).toMatchObject({ code: 'NOTEBOOK_INTERCHANGE_TOO_LARGE' });
    expect((await service.get(...scope(), document.id)).document.content).toEqual(normalizeNotebookContent(legacy()));
    expect(await count('research_documents')).toBe(1); expect(await count('research_document_revisions')).toBe(1);
    expect(await count('research_document_pending')).toBe(0); expect(await count('research_document_drafts')).toBe(0);
    await noExecution();
  });
});
