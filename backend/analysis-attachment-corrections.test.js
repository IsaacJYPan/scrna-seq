import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { canonicalAnalysisAttachmentContent,
  normalizeAnalysisAttachmentCorrection, canonicalAnalysisAttachmentCorrection } from '../shared/analysisAttachment.mjs';

const db = require('./pgDatabase');
const storage = require('./storage');
const { createAnalysisAttachmentService } = require('./analysisAttachments');
const { createArtifactVersionService } = require('./artifactVersions');
const { createResearchAnalysisService } = require('./researchAnalyses');
let http;
const sha = value => createHash('sha256').update(value).digest('hex');
const id = prefix => `${prefix}_${randomBytes(12).toString('hex')}`;
const reference = version => ({ kind: 'artifact-version', versionId: version.versionId, sha256: version.sha256 });
const notes = { origin: 'Supplied outside result', sourceReference: null, documentReference: 'Supplied DOI', environmentReference: null };
const createBody = (ref, extra = {}) => ({ requestId: randomUUID(), reference: ref, caption: 'Original result', suppliedOrigin: notes, ...extra });
const correctionBody = (head, extra = {}) => ({ requestId: randomUUID(), expectedHeadRevisionId: head.headRevisionId,
  reference: head.revision.reference, caption: 'Corrected caption', suppliedOrigin: head.revision.suppliedOrigin, ...extra });
const until = async (check, message) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(message);
};

describe('immutable attachment correction contract', () => {
  const ref = { kind: 'artifact-version', versionId: 'av_' + 'a'.repeat(24), sha256: 'b'.repeat(64) };
  const attachmentId = 'raa_' + 'c'.repeat(24), expected = 'rar_' + 'd'.repeat(24);
  it('preserves literal v1 create canonical bytes and binds correction action, target and expected head separately', () => {
    const value = createBody(ref, { caption: '  β scores\r\nControl  ', suppliedOrigin: {} });
    const literal = `{"reference":{"kind":"artifact-version","versionId":"${ref.versionId}","sha256":"${ref.sha256}"},"caption":"β scores\\nControl","suppliedOrigin":{"origin":null,"sourceReference":null,"documentReference":null,"environmentReference":null}}`;
    expect(canonicalAnalysisAttachmentContent(value)).toBe(literal);
    const input = { ...value, expectedHeadRevisionId: expected }, normalized = normalizeAnalysisAttachmentCorrection(input);
    expect(normalized.caption).toBe('β scores\nControl');
    expect(canonicalAnalysisAttachmentCorrection(attachmentId, input)).toBe(`{"action":"correct","attachmentId":"${attachmentId}","expectedHeadRevisionId":"${expected}",${literal.slice(1)}`);
    expect(canonicalAnalysisAttachmentCorrection(attachmentId, { ...input, requestId: randomUUID() })).toBe(canonicalAnalysisAttachmentCorrection(attachmentId, input));
    for (const changed of [canonicalAnalysisAttachmentCorrection('raa_' + 'e'.repeat(24), input),
      canonicalAnalysisAttachmentCorrection(attachmentId, { ...input, expectedHeadRevisionId: 'rar_' + 'e'.repeat(24) }), canonicalAnalysisAttachmentContent(value)]) {
      expect(sha(changed)).not.toBe(sha(canonicalAnalysisAttachmentCorrection(attachmentId, input)));
    }
  });
  it('rejects caller ownership, missing predecessors, accessors and unknown server fields before reading getters', () => {
    let read = false;
    const input = { ...createBody(ref), expectedHeadRevisionId: expected };
    const getter = { ...input }; Object.defineProperty(getter, 'expectedHeadRevisionId', { enumerable: true, get() { read = true; return expected; } });
    for (const value of [{ ...input, expectedHeadRevisionId: null }, { ...input, expectedHeadRevisionId: 'not-a-revision' },
      { ...input, sourceOwnerUserId: 3 }, { ...input, previousRevisionId: expected }, { ...input, action: 'correct' }, getter,
      Object.assign(Object.create({ prototype: true }), input)]) expect(() => normalizeAnalysisAttachmentCorrection(value)).toThrow();
    expect(read).toBe(false);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('attachment corrections/history against PostgreSQL and actual managed storage', () => {
  let directory, provider, service, server, owner, colleague, viewer, project, analysis, oldRoot;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'traceomics-attachment-corrections-'));
    oldRoot = process.env.STORAGE_ROOT; process.env.STORAGE_ROOT = path.join(directory, 'storage');
    provider = storage.createLocalStorageProvider(); http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    await db.resetSchemaForTests(); service = createAnalysisAttachmentService(db, provider);
    owner = await http.createUserWithToken({ email: 'correction-owner@example.test' });
    colleague = await http.createUserWithToken({ email: 'correction-colleague@example.test' });
    viewer = await http.createUserWithToken({ email: 'correction-viewer@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Correction lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Retained evidence' });
    await db.addProjectMember(project.id, colleague.user.id, 'analyst'); await db.addProjectMember(project.id, viewer.user.id, 'viewer');
    analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Treatment comparison' })).analysis;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (oldRoot === undefined) delete process.env.STORAGE_ROOT; else process.env.STORAGE_ROOT = oldRoot;
    await db.close(); await rm(directory, { recursive: true, force: true });
  });
  const base = (a = analysis, p = project) => `/api/projects/${p.id}/analyses/${a.id}/attachments`;
  const endpoint = attachmentId => `${base()}/${attachmentId}/revisions`;
  const post = (attachmentId, input, actor = owner) => http.api(server, endpoint(attachmentId), { token: actor.token, method: 'POST', body: input });
  const get = (attachmentId, suffix = '', actor = owner) => http.api(server, endpoint(attachmentId) + suffix, { token: actor.token });
  const receipt = (requestId, actor = owner) => http.api(server, `${base()}/requests/${requestId}`, { token: actor.token });
  async function source(actor = owner, bytes = 'gene,score\nA,12\n', p = project) {
    const filename = path.join(directory, randomUUID()); await writeFile(filename, bytes);
    const version = await createArtifactVersionService(db, provider).importFile(actor.user.id, p.id, { path: filename, originalFilename: 'private-scientific-file.csv', name: 'Private file name must not leak' });
    const row = (await db.query('SELECT * FROM managed_artifact_versions WHERE id=$1', [version.versionId])).rows[0];
    return { version, reference: reference(version), key: row.storage_key, bytes };
  }
  async function initial(saved = null) {
    const s = saved || await source(), input = createBody(s.reference);
    return { source: s, input, result: await service.create(owner.user.id, project.id, analysis.id, input) };
  }
  const count = async table => (await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;

  async function seedHistory(lengths, ref) {
    const heads = [], rows = [];
    for (const length of lengths) {
      const attachmentId = id('raa'); let previous = null;
      for (let n = 1; n <= length; n++) {
        const revisionId = id('rar'), requestId = randomUUID(), input = createBody(ref, { requestId, caption: `Retained revision ${n}` });
        rows.push({ id: revisionId, attachment_id: attachmentId, revision_number: n, request_id: requestId,
          request_sha256: sha(n === 1 ? canonicalAnalysisAttachmentContent(input) : canonicalAnalysisAttachmentCorrection(attachmentId, { ...input, expectedHeadRevisionId: previous })),
          action: n === 1 ? 'create' : 'correct', expected_head_revision_id: previous, caption: input.caption });
        previous = revisionId;
      }
      heads.push({ id: attachmentId, head_revision_id: previous, revision_number: length });
    }
    const client = await (await db.connect()).connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO research_analysis_attachments(id,project_id,analysis_id,created_by_user_id,head_revision_id,revision_number)
        SELECT id,$1,$2,$3,head_revision_id,revision_number FROM jsonb_to_recordset($4::jsonb) AS h(id text,head_revision_id text,revision_number integer)`,
      [project.id, analysis.id, owner.user.id, JSON.stringify(heads)]);
      await client.query(`INSERT INTO research_analysis_attachment_revisions(id,attachment_id,project_id,analysis_id,revision_number,actor_user_id,source_owner_user_id,
        request_id,request_sha256,action,expected_head_revision_id,reference_json,caption,supplied_origin_json)
        SELECT id,attachment_id,$1,$2,revision_number,$3,$3,request_id,request_sha256,action,expected_head_revision_id,$5,caption,$6
        FROM jsonb_to_recordset($4::jsonb) AS r(id text,attachment_id text,revision_number integer,request_id uuid,request_sha256 text,action text,expected_head_revision_id text,caption text)`,
      [project.id, analysis.id, owner.user.id, JSON.stringify(rows), ref, notes]);
      await client.query('COMMIT');
    } catch (failure) { await client.query('ROLLBACK'); throw failure; } finally { client.release(); }
    return heads.map(head => ({ id: head.id, headRevisionId: head.head_revision_id, revision: { reference: ref, suppliedOrigin: notes } }));
  }

  it('appends exact predecessors and owned replacement bytes while leaving the analysis draft and original evidence unchanged', async () => {
    const first = await initial(), replacement = await source(owner, 'gene,score\nA,13\n');
    const input = correctionBody(first.result.attachment, { reference: replacement.reference, caption: 'Corrected measured values' });
    const response = await post(first.result.attachment.id, input); expect(response.status).toBe(201);
    expect(response.data).toMatchObject({ replayed: false, canWrite: true, acceptedSourceAccess: 'available',
      requestSha256: sha(canonicalAnalysisAttachmentCorrection(first.result.attachment.id, input)),
      acceptedRevision: { revisionNumber: 2, previousRevisionId: first.result.acceptedRevision.id, reference: replacement.reference, caption: input.caption } });
    const exact = await get(first.result.attachment.id, '/' + first.result.acceptedRevision.id);
    expect(exact.data).toMatchObject({ headRevisionId: response.data.acceptedRevision.id, revision: first.result.acceptedRevision, sourceAccess: 'available' });
    expect(await readFile(provider.resolveKey(first.source.key), 'utf8')).toBe(first.source.bytes);
    expect(await readFile(provider.resolveKey(replacement.key), 'utf8')).toBe(replacement.bytes);
    expect((await createResearchAnalysisService().get(owner.user.id, project.id, analysis.id)).analysis).toEqual(analysis);
    for (const table of ['jobs', 'workflow_runs', 'private_r_executions', 'private_r_kernels']) expect(await count(table)).toBe(0);
  });

  it('keeps source owner separate from collaborator caption authors, including unavailable bytes and changed owned sources', async () => {
    const first = await initial(), attachmentId = first.result.attachment.id;
    const contextOnly = await post(attachmentId, correctionBody(first.result.attachment), colleague);
    expect(contextOnly.status).toBe(201); expect(contextOnly.data).toMatchObject({ acceptedSourceAccess: 'restricted',
      acceptedRevision: { createdByUserId: colleague.user.id }, attachment: { sourceAccess: 'restricted' } });
    expect((await get(attachmentId)).data.revisions[0].sourceAccess).toBe('available');
    expect((await db.query('SELECT source_owner_user_id FROM research_analysis_attachment_revisions WHERE id=$1', [contextOnly.data.acceptedRevision.id])).rows[0].source_owner_user_id).toBe(String(owner.user.id));
    await unlink(provider.resolveKey(first.source.key));
    const noBytes = await post(attachmentId, correctionBody(contextOnly.data.attachment, { caption: 'Context clarified despite missing source' }), colleague);
    expect(noBytes.status).toBe(201); expect((await get(attachmentId)).data.revisions[0].sourceAccess).toBe('unavailable');
    const ownSource = await source(colleague, 'gene,score\nB,4\n');
    const changed = await post(attachmentId, correctionBody(noBytes.data.attachment, { reference: ownSource.reference }), colleague);
    expect(changed.status).toBe(201); expect(changed.data.acceptedSourceAccess).toBe('available');
    const ownerRead = await get(attachmentId); expect(ownerRead.data.revisions[0].sourceAccess).toBe('restricted');
    expect(ownerRead.data.revisions.slice(1).every(row => row.sourceAccess === 'unavailable')).toBe(true);
    expect(JSON.stringify(ownerRead.data)).not.toContain('Private file name must not leak'); expect(JSON.stringify(ownerRead.data)).not.toContain('storage_key');
    const denied = await post(attachmentId, correctionBody(changed.data.attachment, { reference: ownSource.reference, caption: 'Same foreign reference retains owner' }));
    expect(denied.status).toBe(201); expect(denied.data.acceptedSourceAccess).toBe('restricted');
  });

  it('requires exact owned verified bytes for a changed reference, including a collaborator trying another private file', async () => {
    const first = await initial(), alternate = await source(owner, 'gene,score\nZ,7\n'), attachmentId = first.result.attachment.id;
    expect((await post(attachmentId, correctionBody(first.result.attachment, { reference: alternate.reference }), colleague)).status).toBe(404);
    await writeFile(provider.resolveKey(alternate.key), 'gene,score\nZ,8\n');
    expect((await post(attachmentId, correctionBody(first.result.attachment, { reference: alternate.reference }))).data.code).toBe('ANALYSIS_ATTACHMENT_SOURCE_UNAVAILABLE');
    expect(await count('research_analysis_attachment_revisions')).toBe(1);
  });

  it('serializes competing heads, binds the shared UUID namespace to action/target/body and never replays onto a newer head', async () => {
    const first = await initial(), attachmentId = first.result.attachment.id, input = correctionBody(first.result.attachment);
    const same = await Promise.all([post(attachmentId, input), post(attachmentId, input)]);
    expect(same.map(response => response.status).sort()).toEqual([200, 201]); expect(same[0].data.acceptedRevision).toEqual(same[1].data.acceptedRevision);
    const current = same[0].data.attachment, competing = [correctionBody(current, { caption: 'Version A' }), correctionBody(current, { caption: 'Version B' })];
    const race = await Promise.all(competing.map(value => post(attachmentId, value)));
    expect(race.map(response => response.status).sort()).toEqual([201, 409]);
    const conflict = race.find(response => response.status === 409), accepted = race.find(response => response.status === 201);
    expect(conflict.data).toMatchObject({ code: 'ANALYSIS_ATTACHMENT_HEAD_CONFLICT', submittedExpectedHeadRevisionId: current.headRevisionId,
      attachment: accepted.data.attachment });
    const replay = await post(attachmentId, input); expect(replay.data).toMatchObject({ acceptedRevision: same[0].data.acceptedRevision,
      attachment: accepted.data.attachment, replayed: true });
    const other = await initial(first.source);
    for (const [target, value] of [[attachmentId, { ...input, caption: 'Different' }], [attachmentId, { ...input, expectedHeadRevisionId: accepted.data.acceptedRevision.id }],
      [other.result.attachment.id, input], [attachmentId, { ...input, requestId: first.input.requestId }]]) {
      expect((await post(target, value)).data.code).toBe('ANALYSIS_ATTACHMENT_REQUEST_CONFLICT');
    }
    expect((await http.api(server, base(), { token: owner.token, method: 'POST', body: { ...createBody(first.source.reference), requestId: input.requestId } })).data.code)
      .toBe('ANALYSIS_ATTACHMENT_REQUEST_CONFLICT');
  });

  it('recovers original acceptance and its own source access after a newer owner-private head, downgrade, archive and missing bytes', async () => {
    const first = await initial(), attachmentId = first.result.attachment.id, input = correctionBody(first.result.attachment);
    const second = await post(attachmentId, input), foreign = await source(colleague, 'gene,score\nC,22\n');
    const third = await post(attachmentId, correctionBody(second.data.attachment, { reference: foreign.reference }), colleague);
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    await createResearchAnalysisService().patch(colleague.user.id, project.id, analysis.id, { expectedVersion: 1, status: 'archived' });
    await unlink(provider.resolveKey(first.source.key));
    for (const response of [await post(attachmentId, input), await receipt(input.requestId)]) {
      expect(response.status).toBe(200); expect(response.data).toMatchObject({ acceptedRevision: second.data.acceptedRevision,
        canWrite: false, acceptedSourceAccess: 'unavailable', attachment: { headRevisionId: third.data.acceptedRevision.id, sourceAccess: 'restricted' } });
    }
    expect((await post(attachmentId, correctionBody(third.data.attachment))).status).toBe(403);
    expect((await receipt(input.requestId, colleague)).status).toBe(404);
    expect((await get(attachmentId, '/' + second.data.acceptedRevision.id, viewer)).data).toMatchObject({ sourceAccess: 'restricted', canWrite: false });
    await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, owner.user.id]);
    for (const response of [await get(attachmentId), await get(attachmentId, '/' + second.data.acceptedRevision.id), await receipt(input.requestId), await post(attachmentId, input)]) expect(response.status).toBe(404);
  });

  it('pages coherent newest-first exact history, rejects cross-attachment cursors/versions and never exposes private source metadata', async () => {
    const first = await initial(), attachmentId = first.result.attachment.id; let current = first.result.attachment;
    for (let n = 2; n <= 5; n++) current = (await post(attachmentId, correctionBody(current, { caption: `Revision ${n}` }))).data.attachment;
    const revisions = []; let cursor;
    do {
      const response = await get(attachmentId, '?limit=2' + (cursor ? `&cursor=${cursor}` : ''), viewer); expect(response.status).toBe(200);
      expect(response.data.headRevisionId).toBe(current.headRevisionId); expect(response.data.revisions.every(row => row.sourceAccess === 'restricted')).toBe(true);
      revisions.push(...response.data.revisions.map(row => row.revision)); cursor = response.data.nextCursor;
    } while (cursor);
    expect(revisions.map(row => row.revisionNumber)).toEqual([5, 4, 3, 2, 1]);
    for (let n = 0; n < revisions.length - 1; n++) expect(revisions[n].previousRevisionId).toBe(revisions[n + 1].id);
    expect(revisions.at(-1).previousRevisionId).toBeNull();
    const other = await initial(first.source), page = await get(attachmentId, '?limit=2');
    expect((await get(other.result.attachment.id, '?cursor=' + page.data.nextCursor)).status).toBe(400);
    expect((await get(other.result.attachment.id, '/' + first.result.acceptedRevision.id)).status).toBe(404);
    for (const query of ['?limit=31', '?limit=0', '?cursor=garbage', '?cursor=' + 'x'.repeat(257), '?bytes=all']) expect((await get(attachmentId, query)).status).toBe(400);
  });

  it('retains current and earlier referenced managed rows, permits independent unreferenced cleanup and keeps all revision metadata immutable', async () => {
    const first = await initial(), next = await source(owner, 'gene,score\nD,9\n'), unused = await source(owner, 'gene,score\nUnused,0\n');
    await post(first.result.attachment.id, correctionBody(first.result.attachment, { reference: next.reference }));
    for (const value of [first.source, next]) {
      await expect(db.query('DELETE FROM managed_artifact_versions WHERE id=$1', [value.version.versionId])).rejects.toMatchObject({ code: '55000' });
      expect(await readFile(provider.resolveKey(value.key), 'utf8')).toBe(value.bytes);
    }
    expect((await db.query('DELETE FROM managed_artifact_versions WHERE id=$1', [unused.version.versionId])).rowCount).toBe(1);
    for (const sql of ['UPDATE research_analysis_attachment_revisions SET source_owner_user_id=actor_user_id WHERE id=$1',
      'UPDATE research_analysis_attachment_revisions SET expected_head_revision_id=NULL WHERE id=$1', 'DELETE FROM research_analysis_attachment_revisions WHERE id=$1']) {
      await expect(db.query(sql, [first.result.acceptedRevision.id])).rejects.toMatchObject({ code: '55000' });
    }
  });

  it('blocks a real source deletion waiting on new admission, then sees the newly committed retention reference', async () => {
    const saved = await source(); let entered, release;
    const reached = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const guarded = createAnalysisAttachmentService(db, { ...provider, openVerifiedRead: async (...args) => { entered(); await gate; return provider.openVerifiedRead(...args); } });
    const pending = guarded.create(owner.user.id, project.id, analysis.id, createBody(saved.reference)); await reached;
    const deleting = db.query('DELETE FROM managed_artifact_versions WHERE id=$1', [saved.version.versionId]).then(result => ({ result }), error => ({ error }));
    try { await until(async () => (await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'DELETE FROM managed_artifact_versions%'")).rowCount > 0, 'Delete did not wait on actual source admission lock'); }
    finally { release(); }
    expect((await pending).attachment.sourceAccess).toBe('available'); expect((await deleting).error).toMatchObject({ code: '55000' });
    expect(await readFile(provider.resolveKey(saved.key), 'utf8')).toBe(saved.bytes);
  });

  it('refuses admission when a real source deletion commits first, without appending a dangling attachment', async () => {
    const saved = await source(), client = await (await db.connect()).connect(); let pending;
    try {
      await client.query('BEGIN'); await client.query('DELETE FROM managed_artifact_versions WHERE id=$1', [saved.version.versionId]);
      pending = service.create(owner.user.id, project.id, analysis.id, createBody(saved.reference)).then(result => ({ result }), error => ({ error }));
      await until(async () => (await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM managed_artifact_versions%FOR KEY SHARE'")).rowCount > 0, 'Admission did not wait on actual deleted source row');
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await pending).error).toMatchObject({ code: 'ANALYSIS_ATTACHMENT_SOURCE_UNAVAILABLE', status: 404 }); expect(await count('research_analysis_attachments')).toBe(0);
  });

  it('recovers a correction whose actual COMMIT succeeded but acknowledgement was lost, without repeating it', async () => {
    const first = await initial(), input = correctionBody(first.result.attachment), pool = await db.connect(); let lose = true;
    const uncertain = { ...db, connect: async () => ({ connect: async () => {
      const client = await pool.connect(); return { query: async (sql, values) => {
        const response = await client.query(sql, values);
        if (sql === 'COMMIT' && lose) { lose = false; throw Object.assign(new Error('Actual correction COMMIT acknowledgement lost'), { code: 'ECONNRESET' }); }
        return response;
      }, release: destroy => client.release(destroy) };
    } }) };
    await expect(createAnalysisAttachmentService(uncertain, provider).correct(owner.user.id, project.id, analysis.id, first.result.attachment.id, input)).rejects.toMatchObject({ code: 'ECONNRESET' });
    const accepted = await receipt(input.requestId); expect(accepted.status).toBe(200); expect(accepted.data.acceptedRevision.revisionNumber).toBe(2);
    expect((await post(first.result.attachment.id, input)).data.acceptedRevision).toEqual(accepted.data.acceptedRevision);
    expect(await count('research_analysis_attachment_revisions')).toBe(2);
  });

  it('bounds both per-attachment and total retained history atomically while allowing exact accepted replay at the limit', async () => {
    const saved = await source(), [head] = await seedHistory([199], saved.reference), input = correctionBody(head);
    const atLimit = await post(head.id, input); expect(atLimit.status).toBe(201); expect(atLimit.data.acceptedRevision.revisionNumber).toBe(200);
    expect((await post(head.id, correctionBody(atLimit.data.attachment))).data.code).toBe('ANALYSIS_ATTACHMENT_HISTORY_LIMIT');
    expect((await post(head.id, input)).status).toBe(200);
    // A distinct analysis isolates its total-history bound from the first head.
    analysis = (await createResearchAnalysisService().create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Total retained history' })).analysis;
    const heads = await seedHistory([...Array(10).fill(199), 4, 5], saved.reference);
    const a = correctionBody(heads.at(-2)), b = correctionBody(heads.at(-1));
    const race = await Promise.all([post(heads.at(-2).id, a), post(heads.at(-1).id, b)]);
    expect(race.map(response => response.status).sort()).toEqual([201, 409]); expect(race.find(response => response.status === 409).data.code).toBe('ANALYSIS_ATTACHMENT_HISTORY_LIMIT');
    expect((await service.create(owner.user.id, project.id, analysis.id, createBody(saved.reference)).catch(error => error)).code).toBe('ANALYSIS_ATTACHMENT_HISTORY_LIMIT');
  });

  it('migrates existing v1 creation receipts without rewriting identity/content/hash and restores strict runtime immutability', async () => {
    const first = await initial(), before = (await db.query('SELECT * FROM research_analysis_attachment_revisions WHERE id=$1', [first.result.acceptedRevision.id])).rows[0];
    const client = await (await db.connect()).connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE research_analysis_attachment_revisions DROP COLUMN source_owner_user_id CASCADE, DROP COLUMN action CASCADE, DROP COLUMN expected_head_revision_id CASCADE');
      await client.query("UPDATE app_schema_contract SET schema_version=20261025 WHERE schema_key='traceomics.runtime'");
      await client.query('COMMIT');
    } catch (failure) { await client.query('ROLLBACK'); throw failure; } finally { client.release(); }
    await db.initSchema({ force: true }); await db.initSchema({ force: true });
    const after = (await db.query('SELECT * FROM research_analysis_attachment_revisions WHERE id=$1', [before.id])).rows[0];
    for (const key of ['id', 'request_id', 'request_sha256', 'reference_json', 'caption', 'supplied_origin_json', 'created_at', 'actor_user_id']) expect(after[key]).toEqual(before[key]);
    expect(after.source_owner_user_id).toBe(before.actor_user_id); expect(after.action).toBe('create'); expect(after.expected_head_revision_id).toBeNull();
    expect((await service.create(owner.user.id, project.id, analysis.id, first.input)).acceptedRevision).toEqual(first.result.acceptedRevision);
    await expect(db.query('UPDATE research_analysis_attachment_revisions SET source_owner_user_id=actor_user_id WHERE id=$1', [before.id])).rejects.toMatchObject({ code: '55000' });
    expect((await db.query("SELECT schema_version FROM app_schema_contract WHERE schema_key='traceomics.runtime'")).rows[0].schema_version).toBe(20261029);
  });

  it('deletes full correction/predecessor/source-owner cycles only in scoped expired-demo cleanup', async () => {
    const first = await initial(), next = await source(owner, 'gene,score\nE,5\n');
    await post(first.result.attachment.id, correctionBody(first.result.attachment, { reference: next.reference }));
    const organization = await db.createOrganizationForUser(colleague.user.id, { name: 'Persistent lab' });
    const retainedProject = await db.createProjectForUser(colleague.user.id, { organizationId: organization.id, name: 'Keep context' });
    const retainedAnalysis = (await createResearchAnalysisService().create(colleague.user.id, retainedProject.id, { requestId: randomUUID(), name: 'Keep evidence' })).analysis;
    const retained = await source(colleague, 'gene,score\nK,1\n', retainedProject), retainedInput = createBody(retained.reference);
    const accepted = await service.create(colleague.user.id, retainedProject.id, retainedAnalysis.id, retainedInput);
    await db.query("UPDATE users SET is_demo_guest=TRUE,expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [owner.user.id]);
    expect(await db.deleteExpiredDemoGuest(owner.user.id)).toBe(true);
    expect(await count('research_analysis_attachments')).toBe(1); expect(await count('research_analysis_attachment_revisions')).toBe(1);
    expect((await service.getRequest(colleague.user.id, retainedProject.id, retainedAnalysis.id, retainedInput.requestId)).acceptedRevision).toEqual(accepted.acceptedRevision);
  });
});
