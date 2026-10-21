// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { canonicalRetainedWorkflowSnapshot } from '../shared/workflowSnapshot.mjs';
const db = require('./pgDatabase');
const storage = require('./storage');
const { EXPERT_R_PROFILE } = require('./expertR');
const { createWorkflowRuntime, digest } = require('./workflowRuntime');
const { createRetainedWorkflowSnapshotService } = require('./retainedWorkflowSnapshots');
const { createResearchAnalysisService } = require('./researchAnalyses');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const id = prefix => `${prefix}_${randomBytes(12).toString('hex')}`;
const method = () => ({ format: 'traceomics-workflow', schemaVersion: 1, id: 'retained-study', name: 'Captured study', version: '1.0.0',
  description: 'A captured ordinary R method', runtime: { language: 'r', profileId: EXPERT_R_PROFILE.id },
  files: { 'inspect.R': '  write_output("summary", list(cells = 12))\r\n' },
  steps: [{ id: 'inspect', label: 'Inspect', entry: 'inspect.R', inputs: { analysis: { from: 'input.analysis', type: 'rds' } },
    parameters: [], outputs: { summary: { type: 'metrics', label: 'Cells' } } }], tabs: [{ id: 'summary', label: 'Summary', step: 'inspect', plots: [] }] });

describe.skipIf(!process.env.DATABASE_URL)('retained workflow capture and safe reopening through actual PostgreSQL/HTTP', () => {
  let server, owner, colleague, outsider, project, otherProject, object, runtime, instance, saved, analyses, checkpoint;
  beforeAll(async () => { server = await startServer(); });
  beforeEach(async () => {
    await db.resetSchemaForTests(); analyses = createResearchAnalysisService(); runtime = createWorkflowRuntime(db);
    owner = await createUserWithToken({ email: 'capture-owner@example.test' }); colleague = await createUserWithToken({ email: 'capture-colleague@example.test' });
    outsider = await createUserWithToken({ email: 'capture-outsider@example.test' });
    const org = await db.createOrganizationForUser(owner.user.id, { name: 'Captured work lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: org.id, name: 'Saved study' });
    otherProject = await db.createProjectForUser(owner.user.id, { organizationId: org.id, name: 'Other project' });
    await db.addProjectMember(project.id, colleague.user.id, 'analyst');
    object = await db.createProjectAnalysisObject(owner.user.id, project.id, { objectType: 'seurat', displayName: 'Captured input' });
    const job = await db.createProjectJob(owner.user.id, project.id, { jobType: 'generic', analysisObjectId: object.id });
    await db.query("UPDATE jobs SET status='completed' WHERE id=$1", [job.id]);
    checkpoint = { id: id('art'), sha256: digest('opaque checkpoint fixture'), sizeBytes: 25,
      key: storage.projectStorageFileKey(project.id, 'checkpoints', job.id, 'source.rds') };
    await db.query(`INSERT INTO job_artifacts(id,project_id,job_id,created_by_user_id,artifact_type,result_analysis_object_id,storage_kind,storage_uri,checksum_sha256,size_bytes,status)
      VALUES($1,$2,$3,$4,'checkpoint',$5,'local_internal',$6,$7,$8,'available')`, [checkpoint.id, project.id, job.id, owner.user.id, object.id, checkpoint.key, checkpoint.sha256, checkpoint.sizeBytes]);
    instance = await runtime.open(owner.user.id, project.id, object.id, JSON.stringify(method()));
    saved = await runtime.save(owner.user.id, project.id, instance.id, 'Before exploration');
  });
  afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); await db.close(); });
  const base = (p = project) => `/api/projects/${p.id}/analyses`;
  const sourcePath = (snapshot = saved, p = project) => `${base(p)}/workflow-snapshots/${snapshot.id}`;
  const get = (actor = owner, query = '', snapshot = saved) => api(server, sourcePath(snapshot) + query, { token: actor.token });
  const catalog = (actor = owner, query = '') => api(server, base() + '/existing-work?kind=workflows' + query, { token: actor.token });
  const open = (body, actor = owner, snapshot = saved) => api(server, sourcePath(snapshot) + '/open', { method: 'POST', token: actor.token, body });
  const openBody = async (extra = {}) => {
    const snapshot = (await get()).data.snapshot, current = snapshot.workingInstance;
    return { requestId: randomUUID(), sha256: snapshot.sha256, expectedInstance: current ? { id: current.id, generation: current.generation } : null, replace: !!current, ...extra };
  };
  const reference = async () => ({ kind: 'workflow-snapshot', snapshotId: saved.id, sha256: (await get()).data.snapshot.sha256 });
  const count = async table => (await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;

  it('discovers bounded source-free capture metadata, then reads exact source/state without starting computation', async () => {
    const response = await catalog(); expect(response.status).toBe(200); expect(response.res.headers.get('cache-control')).toContain('no-store');
    expect(response.data.items).toHaveLength(1); expect(response.data.items[0]).toMatchObject({ id: saved.id, kind: 'workflow-snapshot',
      savedState: 'recorded', ownership: 'yours', support: { supported: true, execution: 'not-checked', integrity: 'recorded' },
      origin: { analysisObjectId: object.id, jobId: null, package: { id: 'retained-study', version: '1.0.0', digest: instance.packageDigest } } });
    expect(JSON.stringify(response.data)).not.toMatch(/write_output|state_json|package_json|storage_key|source\.rds/);
    const exact = await get(); expect(exact.status).toBe(200); expect(exact.res.headers.get('cache-control')).toContain('no-store');
    expect(exact.data.snapshot).toMatchObject({ schema: 'traceomics.workflow-snapshot.v1', visibility: 'private', ownerUserId: owner.user.id,
      projectId: project.id, analysisObjectId: object.id, package: method(), state: instance.state,
      workingInstance: { id: instance.id, generation: 0, active: false }, support: { supported: true }, canReopen: true });
    expect(exact.data.snapshot.package.files['inspect.R']).toBe(method().files['inspect.R']);
    expect(exact.data.snapshot.sha256).toBe(digest(canonicalRetainedWorkflowSnapshot(exact.data.snapshot)));
    expect((await get(owner, '?sha256=' + exact.data.snapshot.sha256)).data).toEqual(exact.data);
    expect((await get(owner, '?sha256=' + '0'.repeat(64))).data.code).toBe('WORKFLOW_SNAPSHOT_CONFLICT');
    expect(await count('jobs')).toBe(1); expect(await count('private_r_kernels')).toBe(0); expect(await count('research_documents')).toBe(0);
  });

  it('keeps owned captured source readable for a current reader while restricting shared references for colleagues', async () => {
    const ref = await reference(), adopted = await analyses.create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Continue capture', references: [ref] });
    expect((await analyses.get(colleague.user.id, project.id, adopted.analysis.id)).analysis.references).toEqual([{ reference: ref, access: 'restricted' }]);
    expect((await get(colleague)).status).toBe(404); expect((await catalog(colleague)).data.items).toEqual([]); expect((await get(outsider)).status).toBe(404);
    expect((await api(server, sourcePath())).status).toBe(401);
    expect((await api(server, sourcePath(saved, otherProject), { token: owner.token })).status).toBe(404);
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    expect((await get()).data.snapshot.package.files).toEqual(method().files); expect((await get()).data.snapshot.canReopen).toBe(false); expect((await catalog()).status).toBe(200);
    expect((await open(await openBody())).status).toBe(403);
    await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, owner.user.id]);
    expect((await get()).status).toBe(404); expect((await catalog()).status).toBe(404);
  });

  it('requires a deliberate exact working generation and never silently replaces active or changed work', async () => {
    const original = await openBody();
    expect((await open({ ...original, expectedInstance: null, replace: false })).data).toMatchObject({ code: 'WORKFLOW_WORKING_CONFLICT', workingInstance: { id: instance.id, generation: 0 } });
    expect((await open({ ...original, replace: false })).status).toBe(409);
    await db.query("UPDATE workflow_instances SET state_json=jsonb_set(state_json,'{generation}','2') WHERE id=$1", [instance.id]);
    expect((await open(original)).data.code).toBe('WORKFLOW_WORKING_CONFLICT');
    const active = { ...instance.state, generation: 2, active: { id: 'job_active' } };
    await db.query('UPDATE workflow_instances SET state_json=$2 WHERE id=$1', [instance.id, active]);
    const current = { ...original, expectedInstance: { id: instance.id, generation: 2 } };
    expect((await open(current)).data).toMatchObject({ code: 'WORKFLOW_WORKING_CONFLICT', workingInstance: { active: true } });
    expect((await db.query('SELECT state_json FROM workflow_instances WHERE id=$1', [instance.id])).rows[0].state_json).toEqual(active);
    expect(await count('workflow_restoration_receipts')).toBe(0);
    const legacy = await api(server, `/api/workflows/${project.id}/snapshots/${saved.id}/open`, { method: 'POST', token: owner.token, body: {} });
    expect(legacy.status).toBe(409); expect(legacy.data.code).toBe('WORKFLOW_RESTORE_CONFIRMATION_REQUIRED');
  });

  it('atomically reopens captured source and separates the accepted generation from a later working head on retry', async () => {
    const body = await openBody(), accepted = await open(body); expect(accepted.status).toBe(200);
    expect(accepted.data).toMatchObject({ replayed: false, canEditWorking: true, restoration: { requestId: body.requestId, snapshotId: saved.id, sha256: body.sha256,
      analysisObjectId: object.id, packageDigest: instance.packageDigest, instanceId: instance.id, generation: 1 }, currentInstance: { id: instance.id, package: instance.package, state: { generation: 1 } } });
    const later = { ...accepted.data.currentInstance.state, generation: 7, error: 'Later independent work' };
    await db.query('UPDATE workflow_instances SET state_json=$2 WHERE id=$1', [instance.id, later]);
    const retried = await open(body); expect(retried.data).toMatchObject({ replayed: true, restoration: { generation: 1 }, currentInstance: { state: later } });
    expect((await open({ ...body, expectedInstance: { id: instance.id, generation: 7 } })).data.code).toBe('WORKFLOW_RESTORATION_REQUEST_CONFLICT');
    expect(await count('workflow_restoration_receipts')).toBe(1);
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    expect((await open(body)).data).toMatchObject({ replayed: true, canEditWorking: false });
    expect((await open({ ...body, requestId: randomUUID() })).status).toBe(403);
  });

  it('refuses an overflowing next generation before changing current work or creating a receipt', async () => {
    await db.query("UPDATE workflow_instances SET state_json=jsonb_set(state_json,'{generation}','2147483645') WHERE id=$1", [instance.id]);
    const boundary = await open(await openBody());
    expect(boundary.status).toBe(200); expect(boundary.data.restoration.generation).toBe(2147483646);
    const current = boundary.data.currentInstance;
    const exceeded = await open(await openBody());
    expect(exceeded.status).toBe(409); expect(exceeded.data.code).toBe('WORKFLOW_GENERATION_EXHAUSTED');
    expect((await db.query('SELECT state_json FROM workflow_instances WHERE id=$1', [instance.id])).rows[0].state_json).toEqual(current.state);
    expect(await count('workflow_restoration_receipts')).toBe(1);
    const terminal = await runtime.save(owner.user.id, project.id, instance.id, 'Last supported working revision');
    await runtime.close(owner.user.id, project.id, instance.id);
    const snapshot = (await get(owner, '', terminal)).data.snapshot;
    expect(snapshot.support.supported).toBe(true);
    const noWorking = await open({ requestId: randomUUID(), sha256: snapshot.sha256, expectedInstance: null, replace: false }, owner, terminal);
    expect(noWorking.status).toBe(409); expect(noWorking.data.code).toBe('WORKFLOW_GENERATION_EXHAUSTED');
    expect(await count('workflow_instances')).toBe(0); expect(await count('workflow_restoration_receipts')).toBe(1);
  });

  it('replays a previously accepted closed instance explicitly without recreating it or overwriting a replacement instance', async () => {
    const body = await openBody(), accepted = await open(body);
    await runtime.close(owner.user.id, project.id, instance.id);
    expect((await open(body)).data).toMatchObject({ replayed: true, restoration: accepted.data.restoration, currentInstance: null });
    const next = await open(await openBody()); expect(next.status).toBe(200); expect(next.data.currentInstance.id).not.toBe(instance.id);
    expect((await open(body)).data.currentInstance).toBeNull(); expect(await count('workflow_instances')).toBe(1);
  });

  it('serializes duplicate reopen UUIDs and rejects competing stale decisions without extra generation changes', async () => {
    const body = await openBody(), replies = await Promise.all(Array.from({ length: 5 }, () => open(body)));
    expect(replies.every(reply => reply.status === 200)).toBe(true); expect(replies.filter(reply => reply.data.replayed)).toHaveLength(4);
    expect(replies.every(reply => reply.data.currentInstance.state.generation === 1)).toBe(true);
    expect((await open({ ...body, requestId: randomUUID() })).status).toBe(409);
    expect(await count('workflow_restoration_receipts')).toBe(1);
  });

  it('recovers an actually committed reopen whose COMMIT acknowledgement was lost', async () => {
    const body = await openBody(), pool = await db.connect(); let dropped = false;
    const uncertain = { connect: async () => ({ connect: async () => { const client = await pool.connect(); let wrote = false; return {
      query: async (sql, values) => { const result = await client.query(sql, values); if (sql.includes('INSERT INTO workflow_restoration_receipts')) wrote = true;
        if (sql === 'COMMIT' && wrote && !dropped) { dropped = true; throw Object.assign(new Error('Lost acknowledgement'), { code: 'CONNECTION_LOST' }); } return result; }, release: () => client.release(),
    }; } }) };
    await expect(createRetainedWorkflowSnapshotService(uncertain).open(owner.user.id, project.id, saved.id, body)).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    const result = await open(body); expect(result.data).toMatchObject({ replayed: true, restoration: { generation: 1 }, currentInstance: { state: { generation: 1 } } });
    expect(await count('workflow_restoration_receipts')).toBe(1);
    const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='workflow_restoration_receipts'")).rows.map(row => row.column_name);
    expect(columns).not.toContain('package_json'); expect(columns).not.toContain('state_json');
  });

  it('rolls back working replacement if its durable reopen receipt cannot be written', async () => {
    const body = await openBody(), pool = await db.connect();
    const broken = { connect: async () => ({ connect: async () => { const client = await pool.connect(); return {
      query: (sql, values) => { if (sql.includes('INSERT INTO workflow_restoration_receipts')) throw Object.assign(new Error('Receipt unavailable'), { code: 'TEST_RECEIPT' }); return client.query(sql, values); }, release: () => client.release(),
    }; } }) };
    await expect(createRetainedWorkflowSnapshotService(broken).open(owner.user.id, project.id, saved.id, body)).rejects.toMatchObject({ code: 'TEST_RECEIPT' });
    expect((await get()).data.snapshot.workingInstance.generation).toBe(0); expect(await count('workflow_restoration_receipts')).toBe(0);
  });

  it('retains captured source across historic analysis references and rejects body mutation/deletion', async () => {
    const ref = await reference(), adoption = await analyses.create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Pinned capture', references: [ref] });
    await analyses.patch(owner.user.id, project.id, adoption.analysis.id, { expectedVersion: 1, references: [] });
    await expect(runtime.removeSnapshot(owner.user.id, project.id, saved.id)).rejects.toMatchObject({ status: 409 });
    await expect(db.query('DELETE FROM workflow_snapshots WHERE id=$1', [saved.id])).rejects.toMatchObject({ code: '55000' });
    await expect(db.query("UPDATE workflow_snapshots SET name='Changed' WHERE id=$1", [saved.id])).rejects.toMatchObject({ code: '55000' });
    expect((await get()).data.snapshot.sha256).toBe(ref.sha256);
    await db.initSchema({ force: true }); expect((await get()).data.snapshot.sha256).toBe(ref.sha256);
  });

  it('serializes new adoption with snapshot deletion using the actual owner lock', async () => {
    const ref = await reference(), pool = await db.connect(); let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), inside = new Promise(resolve => { entered = resolve; });
    const guarded = { connect: async () => ({ connect: async () => { const client = await pool.connect(); return {
      query: async (sql, values) => { if (sql.includes('INSERT INTO research_analysis_revisions')) { entered(); await gate; } return client.query(sql, values); }, release: () => client.release(),
    }; } }) };
    let creating, deleting;
    try {
      creating = createResearchAnalysisService(guarded).create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Concurrent capture', references: [ref] });
      await inside; deleting = runtime.removeSnapshot(owner.user.id, project.id, saved.id).catch(error => error);
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) { blocked = (await db.query("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM users%FOR UPDATE%'")).rows[0].n > 0;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10)); }
      expect(blocked).toBe(true); release(); await creating; expect(await deleting).toMatchObject({ status: 409 });
      expect((await get()).status).toBe(200);
    } finally { release(); await creating?.catch(() => {}); await deleting; }
  });

  it('keeps analysis-retained captures outside the40 transient slots and bounds legacy metadata discovery', async () => {
    for (let index = 1; index < 40; index++) await runtime.save(owner.user.id, project.id, instance.id, `Transient ${index}`);
    await expect(runtime.save(owner.user.id, project.id, instance.id, 'Over limit')).rejects.toMatchObject({ status: 409 });
    await analyses.create(owner.user.id, project.id, { requestId: randomUUID(), name: 'Retained first capture', references: [await reference()] });
    await runtime.save(owner.user.id, project.id, instance.id, 'New transient'); expect(await count('workflow_snapshots')).toBe(41);
    const oldList = await api(server, `/api/workflows/${project.id}/snapshots?analysisObjectId=${object.id}`, { token: owner.token });
    expect(oldList.data).toHaveLength(40); expect(JSON.stringify(oldList.data)).not.toContain('write_output');
    const ids = []; let cursor;
    do { const response = await catalog(owner, '&limit=10' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')); expect(response.status).toBe(200);
      ids.push(...response.data.items.map(item => item.id)); cursor = response.data.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(41); expect(new Set(ids).size).toBe(41);
    expect((await catalog(owner, '&cursor=invalid')).status).toBe(400);
  });

  it('preserves unsupported legacy source for review and refuses reopening ambiguous or changed exact inputs', async () => {
    const malformedId = id('wfs');
    await db.query('INSERT INTO workflow_snapshots(id,owner_user_id,project_id,analysis_object_id,name,package_digest,package_json,state_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [malformedId, owner.user.id, project.id, object.id, 'Unsupported captured state', instance.packageDigest, instance.package, { active: null, results: {} }]);
    const malformed = await get(owner, '', { id: malformedId }); expect(malformed.status).toBe(200); expect(malformed.data.snapshot.support).toMatchObject({ supported: false, code: 'WORKFLOW_STATE_UNSUPPORTED' });
    expect((await open({ ...(await openBody()), sha256: malformed.data.snapshot.sha256 }, owner, { id: malformedId })).status).toBe(409);
    const job = await db.createProjectJob(owner.user.id, project.id, { jobType: 'generic', analysisObjectId: object.id });
    await db.query("UPDATE jobs SET status='completed' WHERE id=$1", [job.id]);
    await db.query(`INSERT INTO job_artifacts(id,project_id,job_id,created_by_user_id,artifact_type,result_analysis_object_id,storage_kind,storage_uri,checksum_sha256,size_bytes,status)
      VALUES($1,$2,$3,$4,'checkpoint',$5,'local_internal',$6,$7,$8,'available')`, [id('art'), project.id, job.id, owner.user.id, object.id,
      storage.projectStorageFileKey(project.id, 'checkpoints', job.id, 'another.rds'), checkpoint.sha256, checkpoint.sizeBytes]);
    expect((await get()).data.snapshot.support).toMatchObject({ supported: false, code: 'WORKFLOW_ROOT_UNAVAILABLE' });
    expect((await open(await openBody())).data.code).toBe('WORKFLOW_ROOT_UNAVAILABLE');
    expect((await get()).data.snapshot.state.root.id).toBe(checkpoint.id); expect(await count('workflow_restoration_receipts')).toBe(0);
  });

  it('rejects malformed output root flags, mismatched inputs and invalid captured environments without reinterpreting them', async () => {
    const job = await db.createProjectJob(owner.user.id, project.id, { jobType: 'generic', analysisObjectId: object.id });
    await db.query("UPDATE jobs SET status='completed' WHERE id=$1", [job.id]);
    const output = { id: id('eri'), sha256: digest('{"cells":12}'), sizeBytes: 12, type: 'metrics', profileId: EXPERT_R_PROFILE.id };
    await db.query('INSERT INTO workflow_artifacts(id,owner_user_id,project_id,job_id,descriptor_json,storage_key) VALUES($1,$2,$3,$4,$5,$6)',
      [output.id, owner.user.id, project.id, job.id, output, storage.projectStorageFileKey(project.id, 'artifacts', job.id, 'summary.json')]);
    const state = { ...instance.state, generation: 1, results: { inspect: { parameters: {}, seed: 1, producerKey: 'a'.repeat(64),
      inputs: { analysis: instance.state.root }, outputs: { summary: output } } } };
    async function captured(value) {
      const capturedId = id('wfs');
      await db.query('INSERT INTO workflow_snapshots(id,owner_user_id,project_id,analysis_object_id,name,package_digest,package_json,state_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [capturedId, owner.user.id, project.id, object.id, 'Recorded result', instance.packageDigest, instance.package, value]);
      return (await get(owner, '', { id: capturedId })).data.snapshot;
    }
    expect((await captured(state)).support.supported).toBe(true);
    const wrongOutput = structuredClone(state); wrongOutput.results.inspect.outputs.summary.root = true;
    expect((await captured(wrongOutput)).support).toMatchObject({ supported: false, code: 'WORKFLOW_STATE_UNSUPPORTED' });
    const wrongInput = structuredClone(state); wrongInput.results.inspect.inputs.analysis.root = false;
    expect((await captured(wrongInput)).support.supported).toBe(false);
    expect((await captured({ ...state, environment: { imageDigest: 'unrecorded' } })).support.supported).toBe(false);
    await db.query('DELETE FROM workflow_artifacts WHERE id=$1', [output.id]);
    expect((await captured(state)).support).toMatchObject({ supported: false, code: 'WORKFLOW_EVIDENCE_UNAVAILABLE' });
  });

  it('removes only expired demo captures and receipts through the deliberate cleanup path', async () => {
    const body = await openBody(); await open(body);
    const guest = await db.createDemoGuest(`snapshot-cleanup-${randomUUID()}@example.test`, 'password123', new Date(Date.now() + 3600000));
    const guestObject = await db.createProjectAnalysisObject(guest.user.id, guest.project.id, { objectType: 'seurat', displayName: 'Guest object' });
    await db.query('INSERT INTO workflow_snapshots(id,owner_user_id,project_id,analysis_object_id,name,package_digest,package_json,state_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [id('wfs'), guest.user.id, guest.project.id, guestObject.id, 'Guest capture', instance.packageDigest, instance.package, instance.state]);
    await db.query("UPDATE users SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [guest.user.id]);
    expect(await db.deleteExpiredDemoGuest(guest.user.id)).toBe(true);
    expect((await open(body)).data.replayed).toBe(true); expect((await get()).status).toBe(200);
    await expect(db.query('UPDATE workflow_restoration_receipts SET accepted_generation=9 WHERE project_id=$1', [project.id])).rejects.toMatchObject({ code: '55000' });
  });
});
