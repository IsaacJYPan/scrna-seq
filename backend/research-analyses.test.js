import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { normalizeResearchAnalysisCreate, normalizeResearchAnalysisPatch, validateResearchAnalysisReference,
  RESERVED_RESEARCH_REFERENCE_KINDS } from '../shared/researchAnalysis.mjs';

const db = require('./pgDatabase');
const config = require('./config');
const storage = require('./storage');
const { createResearchAnalysisService, researchAnalysisRoutes } = require('./researchAnalyses');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const configured = config.hasPostgresConnection();
const createBody = (extra = {}) => ({ requestId: randomUUID(), name: 'Treatment response', description: 'Does treatment change the response?\n\nRetain sample-level context.', ...extra });
const hash = 'a'.repeat(64);
const versionId = 'av_' + 'b'.repeat(24);

describe('research analysis contract', () => {
  it('preserves multiline questions, normalizes a name and requires exact draft version', () => {
    expect(normalizeResearchAnalysisCreate(createBody({ name: '  A study  ' }))).toMatchObject({ name: 'A study', references: [], studyDesignRef: null });
    expect(normalizeResearchAnalysisPatch({ expectedVersion: 3, description: 'First\n\nSecond' })).toEqual({ expectedVersion: 3, description: 'First\n\nSecond' });
    for (const expectedVersion of [undefined, '1', 0, 1.5, 2147483647]) expect(() => normalizeResearchAnalysisPatch({ expectedVersion, name: 'Changed' })).toThrow();
  });
  it('rejects identities, secrets, paths and bytes in typed source references', () => {
    for (const extra of [{ id: 'client-picked' }, { ownerUserId: 123 }, { status: 'completed' }, { createdAt: new Date().toISOString() }]) {
      expect(() => normalizeResearchAnalysisCreate(createBody(extra))).toThrow();
    }
    const ref = { kind: 'artifact-version', versionId, sha256: hash };
    expect(validateResearchAnalysisReference(ref)).toEqual(ref);
    for (const extra of [{ path: '/private/object.rds' }, { token: 'secret' }, { bytes: [1, 2] }, { access: 'available' }]) {
      expect(() => validateResearchAnalysisReference({ ...ref, ...extra })).toThrow();
    }
    for (const extra of [{ versionId: [versionId] }, { sha256: [hash] }]) expect(() => validateResearchAnalysisReference({ ...ref, ...extra })).toThrow();
    expect(() => normalizeResearchAnalysisCreate(createBody({ requestId: [randomUUID()] }))).toThrow(/request UUID/);
    expect(() => validateResearchAnalysisReference({ kind: 'analysis-object', analysisObjectId: 'ao_' + 'a'.repeat(24) })).toThrow(/exact saved checkpoint/);
  });
  it('reserves future references without claiming to resolve documents or study designs', () => {
    for (const kind of RESERVED_RESEARCH_REFERENCE_KINDS) expect(() => validateResearchAnalysisReference({ kind, id: 'unimplemented' })).toThrow(/not available yet/);
    expect(() => normalizeResearchAnalysisCreate(createBody({ studyDesignRef: { id: 'unimplemented', version: 1 } }))).toThrow(/not available yet/);
  });
  it('bounds text and references while accepting Unicode and ordinary scientific notes', () => {
    expect(normalizeResearchAnalysisCreate(createBody({ name: '细胞 response 🧬', description: 'n_cells\t=\t320\nDonor is the replication unit.' })).name).toBe('细胞 response 🧬');
    for (const change of [{ name: 'x'.repeat(161) }, { name: 'A\nB' }, { description: 'x'.repeat(8001) }, { description: 'A\0B' }, { references: Array(51).fill({}) }, { requestId: 'not-a-uuid' }]) {
      expect(() => normalizeResearchAnalysisCreate(createBody(change))).toThrow();
    }
    const ref = { kind: 'artifact-version', versionId, sha256: hash };
    expect(() => normalizeResearchAnalysisCreate(createBody({ references: [ref, ref] }))).toThrow(/duplicate/);
    expect(() => normalizeResearchAnalysisPatch({ expectedVersion: 1 })).toThrow(/at least one/);
  });
});

describe.skipIf(!configured)('durable project research analyses on PostgreSQL', () => {
  let server, owner, analyst, viewer, outsider, project, object;
  let service;
  beforeAll(async () => { server = await startServer(); });
  beforeEach(async () => {
    await db.resetSchemaForTests();
    service = createResearchAnalysisService();
    owner = await createUserWithToken({ email: 'research-owner@example.test' });
    analyst = await createUserWithToken({ email: 'research-analyst@example.test' });
    viewer = await createUserWithToken({ email: 'research-viewer@example.test' });
    outsider = await createUserWithToken({ email: 'research-outsider@example.test' });
    const org = await db.createOrganizationForUser(owner.user.id, { name: 'Research lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: org.id, name: 'Research study' });
    await db.addProjectMember(project.id, analyst.user.id, 'analyst');
    await db.addProjectMember(project.id, viewer.user.id, 'viewer');
    object = await db.createProjectAnalysisObject(owner.user.id, project.id, { objectType: 'seurat', displayName: 'Saved cell analysis' });
  });
  afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); await db.close(); });
  const endpoint = () => `/api/projects/${project.id}/analyses`;
  const post = (body = createBody(), actor = owner) => api(server, endpoint(), { method: 'POST', token: actor.token, body });
  const patch = (analysis, body, actor = owner) => api(server, endpoint() + '/' + analysis.id, { method: 'PATCH', token: actor.token, body });
  async function managed(actor = owner, targetProject = project) {
    const id = 'av_' + randomBytes(12).toString('hex');
    const artifactId = 'af_' + randomBytes(12).toString('hex');
    const key = storage.projectStorageFileKey(targetProject.id, 'artifacts', id, 'private-input.csv');
    await db.query(`INSERT INTO managed_artifact_versions(id,artifact_id,project_id,owner_user_id,name,version_number,artifact_type,format_json,mime_type,checksum_sha256,size_bytes,storage_key)
      VALUES($1,$2,$3,$4,'Private filename must remain private.csv',1,'table',$5,'text/csv',$6,7,$7)`,
    [id, artifactId, targetProject.id, actor.user.id, { id: 'org.ietf.csv', version: '1' }, hash, key]);
    return { kind: 'artifact-version', versionId: id, sha256: hash };
  }
  it('creates a project-readable draft with a server identity and retained initial revision', async () => {
    const response = await post();
    expect(response.status).toBe(201);
    expect(response.data.analysis).toMatchObject({ projectId: project.id, createdByUserId: owner.user.id, version: 1, status: 'active', references: [] });
    expect(response.data.analysis.id).toMatch(/^ra_[a-f0-9]{24}$/);
    expect(response.data.analysis.description).toContain('\n\n');
    const read = await api(server, endpoint() + '/' + response.data.analysis.id, { token: viewer.token });
    expect(read.status).toBe(200);
    expect(read.data).toEqual(response.data);
    const revisions = (await db.query('SELECT * FROM research_analysis_revisions WHERE analysis_id=$1', [response.data.analysis.id])).rows;
    expect(revisions).toHaveLength(1);
    expect(revisions[0].snapshot_json).toMatchObject({ version: 1, name: 'Treatment response' });
    expect(response.res.headers.get('cache-control')).toContain('no-store');
  });
  it('admits one analysis for concurrent identical create requests and preserves UUID identity after edits', async () => {
    const input = createBody();
    const responses = await Promise.all(Array.from({ length: 6 }, () => post(input)));
    expect(responses.filter(item => item.status === 201)).toHaveLength(1);
    expect(responses.filter(item => item.status === 200)).toHaveLength(5);
    const ids = new Set(responses.map(item => item.data.analysis.id));
    expect(ids.size).toBe(1);
    const original = responses[0].data.analysis;
    await patch(original, { expectedVersion: 1, name: 'Updated question' });
    const recovered = await post(input);
    expect(recovered.data.analysis).toMatchObject({ id: original.id, version: 2, name: 'Updated question' });
    expect((await post({ ...input, name: 'Different create content' })).status).toBe(409);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM research_analyses')).rows[0].n).toBe(1);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM research_analysis_revisions')).rows[0].n).toBe(2);
  });
  it('uses compare-and-swap and retains both writers versions without overwriting scientific sources', async () => {
    const { analysis } = (await post()).data;
    const responses = await Promise.all([
      patch(analysis, { expectedVersion: 1, description: 'Owner hypothesis' }),
      patch(analysis, { expectedVersion: 1, description: 'Analyst hypothesis' }, analyst),
    ]);
    expect(responses.map(item => item.status).sort()).toEqual([200, 409]);
    const saved = responses.find(item => item.status === 200).data.analysis;
    const conflict = responses.find(item => item.status === 409).data;
    expect(conflict).toMatchObject({ code: 'ANALYSIS_VERSION_CONFLICT', submittedExpectedVersion: 1, analysis: { id: analysis.id, version: 2, description: saved.description } });
    const history = (await db.query('SELECT version,snapshot_json FROM research_analysis_revisions WHERE analysis_id=$1 ORDER BY version', [analysis.id])).rows;
    expect(history.map(item => item.version)).toEqual([1, 2]);
    expect(history[0].snapshot_json.description).toBe(analysis.description);
    expect((await db.getProjectAnalysisObject(owner.user.id, project.id, object.id)).id).toBe(object.id);
  });
  it('reports uncertainty after a lost commit reply and recovers the original create without duplication', async () => {
    const express = require('express');
    const pool = await db.connect();
    let dropped = false;
    const uncertainDatabase = { connect: async () => ({ connect: async () => {
      const client = await pool.connect();
      return { query: async (text, parameters) => {
        const result = await client.query(text, parameters);
        if (text === 'COMMIT' && !dropped) {
          dropped = true;
          throw Object.assign(new Error('Private commit connection detail'), { code: 'CONNECTION_LOST' });
        }
        return result;
      }, release: () => client.release() };
    } }) };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = owner.user; next(); });
    app.use('/api/projects/:projectId/analyses', researchAnalysisRoutes({ database: uncertainDatabase, logger: { error() {} } }));
    const uncertainServer = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const input = createBody();
    try {
      const response = await api(uncertainServer, endpoint(), { method: 'POST', body: input });
      expect(response.status).toBe(500);
      expect(response.data.error).toMatch(/could not be confirmed/);
      expect(response.data.error).not.toMatch(/unchanged|Private commit/);
      const recovered = await post(input);
      expect(recovered.status).toBe(200);
      expect(recovered.data.analysis).toMatchObject({ name: input.name, version: 1 });
      expect((await db.query('SELECT COUNT(*)::int AS n FROM research_analyses')).rows[0].n).toBe(1);
      expect((await db.query('SELECT COUNT(*)::int AS n FROM research_analysis_revisions')).rows[0].n).toBe(1);
    } finally { await new Promise(resolve => uncertainServer.close(resolve)); }
  });
  it('permits analyst/admin edits, viewer reads and denies nonmembers without revealing project contents', async () => {
    const { analysis } = (await post()).data;
    expect((await patch(analysis, { expectedVersion: 1, name: 'Analyst edit' }, analyst)).status).toBe(200);
    await db.updateProjectMemberRole(project.id, analyst.user.id, 'admin', { userId: owner.user.id });
    expect((await patch(analysis, { expectedVersion: 2, name: 'Admin edit' }, analyst)).status).toBe(200);
    expect((await patch(analysis, { expectedVersion: 3, name: 'Viewer edit' }, viewer)).status).toBe(403);
    expect((await post(createBody(), viewer)).status).toBe(403);
    for (const path of [endpoint(), endpoint() + '/' + analysis.id, endpoint() + '/reference-options']) {
      expect((await api(server, path, { token: outsider.token })).status).toBe(404);
      expect((await api(server, path)).status).toBe(401);
    }
    expect((await post(createBody(), outsider)).status).toBe(404);
    expect((await patch(analysis, { expectedVersion: 3, name: 'Outsider edit' }, outsider)).status).toBe(404);
    await db.removeProjectMember(project.id, analyst.user.id, { userId: owner.user.id });
    expect((await api(server, endpoint() + '/' + analysis.id, { token: analyst.token })).status).toBe(404);
  });
  it('paginates stable creation order and exposes archive/restore under exact versions', async () => {
    const records = [];
    for (let index = 0; index < 5; index++) records.push((await post(createBody({ name: 'Analysis ' + index }))).data.analysis);
    const found = [];
    let cursor;
    do {
      const response = await api(server, endpoint() + '?limit=2' + (cursor ? '&cursor=' + cursor : ''), { token: viewer.token });
      expect(response.status).toBe(200); expect(response.data.analyses.length).toBeLessThanOrEqual(2);
      found.push(...response.data.analyses.map(item => item.id)); cursor = response.data.nextCursor;
    } while (cursor);
    expect(new Set(found).size).toBe(5);
    expect(new Set(found)).toEqual(new Set(records.map(item => item.id)));
    const changed = (await patch(records[0], { expectedVersion: 1, status: 'archived' })).data.analysis;
    expect((await api(server, endpoint(), { token: owner.token })).data.analyses).toHaveLength(4);
    expect((await api(server, endpoint() + '?status=archived', { token: owner.token })).data.analyses.map(item => item.id)).toEqual([changed.id]);
    expect((await patch(changed, { expectedVersion: 2, status: 'active' })).data.analysis.version).toBe(3);
    for (const query of ['limit=1000', 'limit=0', 'cursor=garbage', 'status=completed']) expect((await api(server, endpoint() + '?' + query, { token: owner.token })).status).toBe(400);
  });
  it('accepts exact owned artifacts without granting container readers private-source access', async () => {
    const ref = await managed();
    const response = await post(createBody({ references: [ref] }));
    expect(response.status).toBe(201);
    expect(response.data.analysis.references).toEqual([{ reference: ref, access: 'available' }]);
    const read = await api(server, endpoint() + '/' + response.data.analysis.id, { token: viewer.token });
    expect(read.data.analysis.references).toEqual([{ reference: ref, access: 'restricted' }]);
    expect(JSON.stringify(read.data)).not.toMatch(/Private filename|storage_key|private-input\.csv|projects\//);
    expect((await post(createBody({ references: [ref] }), analyst)).status).toBe(404);
    expect((await post(createBody({ references: [{ ...ref, sha256: 'b'.repeat(64) }] }))).status).toBe(404);
    // Editing shared notes does not require private input ownership when the
    // existing exact reference stays unchanged, and never creates a source grant.
    const changed = await patch(response.data.analysis, { expectedVersion: 1, description: 'Collaborator interpretation', references: [ref] }, analyst);
    expect(changed.status).toBe(200);
    expect(changed.data.analysis.references[0].access).toBe('restricted');
    const options = await api(server, endpoint() + '/reference-options', { token: owner.token });
    expect(options.status).toBe(200);
    expect(options.data.options[0]).toMatchObject({ reference: ref, type: 'table' });
    expect((await api(server, endpoint() + '/reference-options', { token: viewer.token })).data.options).toEqual([]);
  });
  it('binds an analysis object only to its exact completed saved checkpoint', async () => {
    const job = await db.createProjectJob(owner.user.id, project.id, { jobType: 'checkpoint.noop', analysisObjectId: object.id });
    await db.updateJobStatusForUser(owner.user.id, job.id, 'running');
    const completed = await db.updateJobStatusForUser(owner.user.id, job.id, 'completed', { resultAnalysisObjectId: object.id });
    const artifact = await db.createArtifact(completed, { artifactType: 'checkpoint', resultAnalysisObjectId: object.id,
      storageKind: 'local_internal', storageUri: storage.projectStorageFileKey(project.id, 'checkpoints', job.id, 'state.rds'), checksumSha256: hash, sizeBytes: 12 });
    const ref = { kind: 'analysis-object', analysisObjectId: object.id, checkpointVersionId: artifact.id, sha256: hash };
    expect((await post(createBody({ references: [ref] }))).status).toBe(201);
    const other = await db.createProjectAnalysisObject(owner.user.id, project.id, { objectType: 'seurat' });
    expect((await post(createBody({ references: [{ ...ref, analysisObjectId: other.id }] }))).status).toBe(404);
    const options = (await api(server, endpoint() + '/reference-options', { token: owner.token })).data.options;
    expect(options.some(item => JSON.stringify(item.reference) === JSON.stringify(ref))).toBe(true);
    await db.query("UPDATE jobs SET status='running' WHERE id=$1", [job.id]);
    expect((await post(createBody({ references: [ref] }))).status).toBe(404);
  });
  it('offers round-trippable exact references for every existing owned artifact source family', async () => {
    await managed();
    const inputId = 'eri_' + randomBytes(12).toString('hex');
    await db.query(`INSERT INTO expert_r_private_inputs(id,project_id,owner_user_id,original_filename,internal_storage_key,mime_type,file_size_bytes,sha256)
      VALUES($1,$2,$3,'original.csv',$4,'text/csv',7,$5)`,
    [inputId, project.id, owner.user.id, storage.projectStorageFileKey(project.id, 'artifacts', inputId, 'original.csv'), hash]);
    const job = await db.createProjectJob(owner.user.id, project.id, { jobType: 'generic', analysisObjectId: object.id });
    await db.updateJobStatusForUser(owner.user.id, job.id, 'running');
    const completed = await db.updateJobStatusForUser(owner.user.id, job.id, 'completed');
    const outputId = 'eri_' + randomBytes(12).toString('hex');
    await db.query('INSERT INTO workflow_artifacts(id,owner_user_id,project_id,job_id,descriptor_json,storage_key) VALUES($1,$2,$3,$4,$5,$6)',
      [outputId, owner.user.id, project.id, job.id, { type: 'metrics', sha256: hash, sizeBytes: 7 }, storage.projectStorageFileKey(project.id, 'artifacts', outputId, 'metrics.json')]);
    await db.createArtifact(completed, { artifactType: 'deg_markers', storageKind: 'local_internal', checksumSha256: hash, sizeBytes: 7,
      storageUri: storage.projectStorageFileKey(project.id, 'artifacts', job.id, 'markers.csv') });
    const options = [];
    let cursor;
    do {
      const response = await api(server, endpoint() + '/reference-options?limit=2' + (cursor ? '&cursor=' + cursor : ''), { token: owner.token });
      expect(response.status).toBe(200); options.push(...response.data.options); cursor = response.data.nextCursor;
    } while (cursor);
    expect(options).toHaveLength(4);
    for (const option of options) {
      expect(validateResearchAnalysisReference(option.reference)).toEqual(option.reference);
      expect((await post(createBody({ references: [option.reference] }))).status).toBe(201);
    }
    expect(JSON.stringify(options)).not.toMatch(/storage_key|internal_storage_key|projects\//);
    const malformed = Buffer.from(JSON.stringify([new Date().toISOString(), [inputId]])).toString('base64url');
    expect((await api(server, endpoint() + '/reference-options?cursor=' + malformed, { token: owner.token })).status).toBe(400);
  });
  it('rejects cross-project references and unsupported document/design pointers atomically', async () => {
    const otherOrg = await db.createOrganizationForUser(owner.user.id, { name: 'Other lab' });
    const otherProject = await db.createProjectForUser(owner.user.id, { organizationId: otherOrg.id, name: 'Other project' });
    const ref = await managed(owner, otherProject);
    expect((await post(createBody({ references: [ref] }))).status).toBe(404);
    for (const extra of [{ references: [{ kind: 'document-version', documentId: 'doc_1', version: 1 }] }, { studyDesignRef: { id: 'study_1', version: 1 } }]) {
      const response = await post(createBody(extra));
      expect(response.status).toBe(400); expect(response.data.code).toBe('ANALYSIS_REFERENCE_UNSUPPORTED');
    }
    expect((await db.query('SELECT COUNT(*)::int AS n FROM research_analyses')).rows[0].n).toBe(0);
  });
  it('makes revision history append-only and rolls back the head if revision persistence fails', async () => {
    const { analysis } = (await post()).data;
    await expect(db.query('UPDATE research_analysis_revisions SET snapshot_json=$2 WHERE analysis_id=$1', [analysis.id, {}])).rejects.toMatchObject({ code: '55000' });
    await expect(db.query('DELETE FROM research_analysis_revisions WHERE analysis_id=$1', [analysis.id])).rejects.toMatchObject({ code: '55000' });
    await db.query('ALTER TABLE research_analysis_revisions ADD CONSTRAINT test_no_second_revision CHECK(version<2)');
    try {
      await expect(service.patch(owner.user.id, project.id, analysis.id, { expectedVersion: 1, name: 'Should roll back' })).rejects.toMatchObject({ code: '23514' });
      expect((await service.get(owner.user.id, project.id, analysis.id)).analysis).toMatchObject({ version: 1, name: analysis.name });
    } finally { await db.query('ALTER TABLE research_analysis_revisions DROP CONSTRAINT test_no_second_revision'); }
  });
  it('waits for an in-flight membership revocation then rejects the edit', async () => {
    const { analysis } = (await post()).data;
    const client = await (await db.connect()).connect();
    let pending;
    try {
      await client.query('BEGIN');
      await client.query('UPDATE project_members SET role=$3 WHERE project_id=$1 AND user_id=$2', [project.id, analyst.user.id, 'viewer']);
      pending = service.patch(analyst.user.id, project.id, analysis.id, { expectedVersion: 1, name: 'Revoked edit' });
      pending.catch(() => {});
      // Wait for PostgreSQL to observe the pending membership lock rather than
      // relying on a sleep as evidence that the permission read happened.
      let waiting = false;
      for (let attempt = 0; attempt < 50 && !waiting; attempt++) {
        const result = await client.query('SELECT EXISTS(SELECT 1 FROM pg_locks waiting_lock WHERE NOT waiting_lock.granted AND pg_backend_pid()=ANY(pg_blocking_pids(waiting_lock.pid))) AS waiting');
        waiting = result.rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await client.query('COMMIT');
      await expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await service.get(owner.user.id, project.id, analysis.id)).analysis.version).toBe(1);
    } finally { await client.query('ROLLBACK'); client.release(); if (pending) await pending.catch(() => {}); }
  });
  it('applies the schema upgrade idempotently and retains existing analysis revisions', async () => {
    const { analysis } = (await post()).data;
    await db.query("UPDATE app_schema_contract SET schema_version=20261016 WHERE schema_key='traceomics.runtime'");
    await db.initSchema({ force: true });
    await db.initSchema({ force: true });
    expect((await db.query("SELECT schema_version FROM app_schema_contract WHERE schema_key='traceomics.runtime'")).rows[0].schema_version).toBe(20261023);
    expect((await service.get(owner.user.id, project.id, analysis.id)).analysis.version).toBe(1);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM research_analysis_revisions')).rows[0].n).toBe(1);
  });
  it('removes expired demo analyses and revision history through the deliberate lifecycle cleanup', async () => {
    const guest = await db.createDemoGuest('research-demo@example.test', 'password123', new Date(Date.now() + 3600000));
    const result = await service.create(guest.user.id, guest.project.id, createBody());
    await service.patch(guest.user.id, guest.project.id, result.analysis.id, { expectedVersion: 1, name: 'Demo revised' });
    await db.query('UPDATE users SET expires_at=now()-interval \'1 hour\' WHERE id=$1', [guest.user.id]);
    expect(await db.deleteExpiredDemoGuest(guest.user.id)).toBe(true);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM research_analyses WHERE id=$1', [result.analysis.id])).rows[0].n).toBe(0);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM research_analysis_revisions WHERE analysis_id=$1', [result.analysis.id])).rows[0].n).toBe(0);
  });
});
