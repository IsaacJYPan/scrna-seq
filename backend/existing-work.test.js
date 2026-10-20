// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const db = require('./pgDatabase');
const storage = require('./storage');
const { createResearchAnalysisService } = require('./researchAnalyses');
const { createWorkflowRuntime } = require('./workflowRuntime');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const id = prefix => prefix + '_' + randomBytes(12).toString('hex');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
describe.skipIf(!process.env.DATABASE_URL)('existing saved-work catalog through real PostgreSQL and HTTP', () => {
  let server, owner, colleague, outsider, project, object, service, directory, provider;
  beforeAll(async () => { server = await startServer(); directory = await mkdtemp(path.join(os.tmpdir(), 'traceomics-existing-')); });
  beforeEach(async () => {
    await db.resetSchemaForTests();
    owner = await createUserWithToken({ email: 'saved-work-owner@example.test' });
    colleague = await createUserWithToken({ email: 'saved-work-colleague@example.test' });
    outsider = await createUserWithToken({ email: 'saved-work-outsider@example.test' });
    const org = await db.createOrganizationForUser(owner.user.id, { name: 'Saved work lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: org.id, name: 'Established work' });
    await db.addProjectMember(project.id, colleague.user.id, 'analyst');
    object = await db.createProjectAnalysisObject(owner.user.id, project.id, { objectType: 'seurat', displayName: 'Original biological analysis' });
    service = createResearchAnalysisService(); provider = storage.createLocalStorageProvider({ root: path.join(directory, randomBytes(8).toString('hex')) });
  });
  afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); await db.close(); await rm(directory, { recursive: true, force: true }); });
  const base = () => `/api/projects/${project.id}/analyses`;
  const catalog = (query = '', actor = owner) => api(server, base() + '/existing-work' + query, { token: actor.token });
  async function checkpoint(target = object, actor = owner, extra = {}) {
    const job = await db.createProjectJob(actor.user.id, project.id, { jobType: 'generic', analysisObjectId: target.id });
    await db.query("UPDATE jobs SET status='completed' WHERE id=$1", [job.id]);
    const artifactId = id('art'), key = storage.projectStorageFileKey(project.id, 'checkpoints', job.id, 'source.rds'), bytes = Buffer.from('opaque source fixture');
    await db.query(`INSERT INTO job_artifacts(id,project_id,job_id,analysis_object_id,result_analysis_object_id,created_by_user_id,artifact_type,name,storage_kind,storage_uri,checksum_sha256,size_bytes,status)
      VALUES($1,$2,$3,$4,$4,$5,'checkpoint','Private checkpoint label','local_internal',$6,$7,$8,'available')`,
    [artifactId, project.id, job.id, target.id, actor.user.id, key, sha(bytes), bytes.length]);
    if (extra.key) await db.query('UPDATE job_artifacts SET storage_uri=$2 WHERE id=$1', [artifactId, extra.key]);
    return { job, artifactId, reference: { kind: 'analysis-object', analysisObjectId: target.id, checkpointVersionId: artifactId, sha256: sha(bytes) } };
  }
  async function workflowOutput() {
    const job = await db.createProjectJob(owner.user.id, project.id, { jobType: 'generic', analysisObjectId: object.id });
    await db.query("UPDATE jobs SET status='completed' WHERE id=$1", [job.id]);
    const instanceId = id('wfi'), packageDigest = 'd'.repeat(64);
    await db.query('INSERT INTO workflow_instances(id,owner_user_id,project_id,analysis_object_id,package_digest,package_json,state_json) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [instanceId, owner.user.id, project.id, object.id, packageDigest, { id: 'lab-method', version: '2.1.0' }, { results: {}, active: null }]);
    await db.query('INSERT INTO workflow_runs(job_id,instance_id,request_id,step_id,generation) VALUES($1,$2,$3,$4,1)', [job.id, instanceId, randomUUID(), 'summary']);
    const artifactId = id('eri'), key = storage.projectStorageFileKey(project.id, 'artifacts', artifactId, 'metrics.json'), bytes = Buffer.from('{"cells":12}');
    const filename = provider.prepareWrite(key); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes);
    await db.query('INSERT INTO workflow_artifacts(id,owner_user_id,project_id,job_id,descriptor_json,storage_key) VALUES($1,$2,$3,$4,$5,$6)',
      [artifactId, owner.user.id, project.id, job.id, { type: 'metrics', sha256: sha(bytes), sizeBytes: bytes.length }, key]);
    return { job, instanceId, artifactId, key, bytes, filename, packageDigest, reference: { kind: 'artifact-version', versionId: artifactId, sha256: sha(bytes) } };
  }
  it('offers exact newest saved object references with original run identity, without pretending to know live state or notebook code', async () => {
    await checkpoint(); const latest = await checkpoint();
    const response = await catalog(); expect(response.status).toBe(200); expect(response.res.headers.get('cache-control')).toContain('no-store');
    expect(response.data.items).toHaveLength(1); expect(response.data.items[0]).toMatchObject({ id: object.id, ownership: 'yours',
      savedState: 'recorded', reference: latest.reference, origin: { jobId: latest.job.id, analysisObjectId: object.id, package: null },
      liveState: 'not-checked', notebookSource: 'not-linked' });
    const adopted = await api(server, base(), { method: 'POST', token: owner.token, body: { requestId: randomUUID(), name: 'Continue donor study', references: [response.data.items[0].reference] } });
    expect(adopted.status).toBe(201); expect(adopted.data.analysis.references[0].reference).toEqual(latest.reference);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM research_documents')).rows[0].n).toBe(0);
    expect(JSON.stringify(response.data)).not.toMatch(/storage_uri|projects\//);
  });
  it('discloses only existing project object metadata to colleagues and never their private artifact IDs, checksums or filenames', async () => {
    const privateSource = await checkpoint();
    const response = await catalog('', colleague); expect(response.status).toBe(200);
    expect(response.data.items[0]).toMatchObject({ id: object.id, ownership: 'colleague', savedState: 'restricted', reference: null, origin: null });
    expect(JSON.stringify(response.data)).not.toContain(privateSource.artifactId); expect(JSON.stringify(response.data)).not.toContain(privateSource.reference.sha256);
    expect(JSON.stringify(response.data)).not.toContain('Private checkpoint label');
    expect((await catalog('?kind=results', colleague)).data.items).toEqual([]);
    expect((await catalog('', outsider)).status).toBe(404);
    await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, colleague.user.id]);
    expect((await catalog('', colleague)).status).toBe(404);
  });
  it('keeps unsaved and invalid/out-of-project saved source explicit', async () => {
    expect((await catalog()).data.items[0]).toMatchObject({ reference: null, savedState: 'not-recorded' });
    await checkpoint(object, owner, { key: 'projects/different-project/checkpoint.rds' });
    expect((await catalog()).data.items[0]).toMatchObject({ reference: null, savedState: 'not-recorded' });
    const result = await catalog('?kind=results'); expect(result.data.items[0].reference).toBeNull();
    expect(JSON.stringify(result.data)).not.toContain('different-project');
  });
  it('records exact workflow output/run/package pointers without serializing code or claiming a complete pipeline history', async () => {
    const output = await workflowOutput(); const response = await catalog('?kind=results');
    expect(response.data.items[0]).toMatchObject({ reference: output.reference,
      origin: { jobId: output.job.id, analysisObjectId: object.id, package: { id: 'lab-method', version: '2.1.0', digest: output.packageDigest } } });
    expect(JSON.stringify(response.data)).not.toMatch(/state_json|package_json|storage_key|script/);
    await db.query('DELETE FROM workflow_instances WHERE id=$1', [output.instanceId]);
    expect((await catalog('?kind=results')).data.items[0]).toMatchObject({ reference: output.reference, origin: { jobId: output.job.id, package: null } });
  });
  it('paginates deterministically and rejects malformed/cross-category cursors', async () => {
    for (let i = 0; i < 4; i++) await db.createProjectAnalysisObject(owner.user.id, project.id, { objectType: 'seurat', displayName: 'Metadata ' + i });
    const seen = []; let cursor;
    do { const response = await catalog('?limit=2' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')); expect(response.status).toBe(200);
      seen.push(...response.data.items.map(item => item.id)); cursor = response.data.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(5); expect(seen).toHaveLength(5);
    const first = await catalog('?limit=1');
    expect((await catalog('?kind=results&cursor=' + encodeURIComponent(first.data.nextCursor))).status).toBe(400);
    for (const query of ['?limit=51', '?limit=0', '?kind=unknown', '?kind=objects&kind=results', '?cursor=%5B%5D']) expect((await catalog(query)).status).toBe(400);
  });
  it('retains linked workflow bytes across close and an unlink in a newer analysis version while collecting actual orphans', async () => {
    const output = await workflowOutput(), orphanId = id('eri'), orphanKey = storage.projectStorageFileKey(project.id, 'artifacts', orphanId, 'orphan.json');
    const orphanPath = provider.prepareWrite(orphanKey); await mkdir(path.dirname(orphanPath), { recursive: true }); await writeFile(orphanPath, '{}');
    await db.query('INSERT INTO workflow_artifacts(id,owner_user_id,project_id,job_id,descriptor_json,storage_key) VALUES($1,$2,$3,$4,$5,$6)',
      [orphanId, owner.user.id, project.id, output.job.id, { type: 'metrics', sha256: sha('{}'), sizeBytes: 2 }, orphanKey]);
    const adopted = (await service.create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Retained evidence', references: [output.reference] })).analysis;
    await service.patch(owner.user.id, project.id, adopted.id, { expectedVersion: 1, references: [] });
    await db.query('DELETE FROM workflow_instances WHERE id=$1', [output.instanceId]);
    await createWorkflowRuntime(db, provider).cleanup(owner.user.id, project.id);
    expect(await readFile(output.filename)).toEqual(output.bytes); await expect(readFile(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await db.query('SELECT id FROM workflow_artifacts')).rows.map(row => row.id)).toEqual([output.artifactId]);
  });
  it('allows original accepted creation recovery after downgrade but never a fresh reader mutation', async () => {
    const source = await checkpoint(), input = { requestId: randomUUID(), name: 'Accepted adoption', references: [source.reference] };
    const created = await api(server, base(), { method: 'POST', token: owner.token, body: input }); expect(created.status).toBe(201);
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    const replay = await api(server, base(), { method: 'POST', token: owner.token, body: input });
    expect(replay.status).toBe(200); expect(replay.data.analysis.id).toBe(created.data.analysis.id);
    expect((await api(server, base(), { method: 'POST', token: owner.token, body: { ...input, requestId: randomUUID() } })).status).toBe(403);
    expect((await catalog()).status).toBe(200);
  });
  it('serializes source adoption with cleanup so an in-progress link cannot lose its bytes', async () => {
    const output = await workflowOutput(); let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), inside = new Promise(resolve => { entered = resolve; });
    const guarded = { ...db, connect: async () => {
      const pool = await db.connect();
      return { connect: async () => {
        const client = await pool.connect();
        return { release: () => client.release(), query: async (sql, values) => {
          if (typeof sql === 'string' && sql.startsWith('INSERT INTO research_analysis_revisions')) { entered(); await gate; }
          return client.query(sql, values);
        } };
      } };
    } };
    let creating, collecting;
    try {
      creating = createResearchAnalysisService(guarded).create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Concurrent retained evidence', references: [output.reference] });
      await inside; collecting = createWorkflowRuntime(db, provider).cleanup(owner.user.id, project.id);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = (await db.query("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1", ['%SELECT id FROM users WHERE id=%FOR UPDATE%'])).rows[0].n > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true); release(); await creating; await collecting;
      expect(await readFile(output.filename)).toEqual(output.bytes);
      expect((await db.query('SELECT COUNT(*)::int AS n FROM research_analysis_revisions')).rows[0].n).toBe(1);
    } finally { release(); if (creating) await creating.catch(() => {}); if (collecting) await collecting.catch(() => {}); }
  });
});
