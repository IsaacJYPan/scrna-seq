/**
 * Approved workflow execution by delegated agents (docs/spec.md phase 2).
 *
 * Real Express + PostgreSQL. No R is contacted: tests observe admission,
 * the queued job, the worker's claim-time recheck, and simulate completion
 * by writing the job's terminal state the way a worker would.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const storage = require('./storage');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const { currentReleases, buildRelease } = require('./workflowTrust/catalog');

const CONFIGURED = config.hasPostgresConnection();
const ALL_CAPS = ['metadata.read', 'results.read', 'workflow.plan', 'workflow.executeApproved', 'run.cancelOwn'];

let server;
const savedEnv = {};

beforeAll(async () => {
  if (!CONFIGURED) return;
  for (const key of ['DISABLE_RATE_LIMIT', 'AGENT_MAX_OUTSTANDING_RUNS', 'AGENT_MAX_OUTSTANDING_RUNS_PER_SPONSOR']) savedEnv[key] = process.env[key];
  process.env.DISABLE_RATE_LIMIT = 'true';
  server = await startServer();
});

afterAll(async () => {
  if (!CONFIGURED) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

beforeEach(async () => {
  if (!CONFIGURED) return;
  delete process.env.AGENT_MAX_OUTSTANDING_RUNS;
  delete process.env.AGENT_MAX_OUTSTANDING_RUNS_PER_SPONSOR;
  await db.resetSchemaForTests();
});

const release = () => currentReleases()[0];

async function setup({ limits = { maxOutstandingRuns: 2 }, study = {} } = {}) {
  const sponsor = await createUserWithToken({ email: 'sponsor@example.com', displayName: 'Sponsor' });
  const org = await db.createOrganization('Lab', sponsor.user.id);
  const project = await db.createProject(org.id, 'PBMC', sponsor.user.id);
  const datasetId = 'ds_0123456789abcdef';
  await db.query(
    `INSERT INTO datasets (id, project_id, owner_user_id, created_by_user_id, original_filename, internal_storage_key,
       file_type, file_size_bytes, sha256, upload_status, validation_status)
     VALUES ($1, $2, $3, $3, 'pbmc.h5', $4, 'tenx_h5', 100, $5, 'uploaded', 'valid')`,
    [datasetId, project.id, sponsor.user.id, storage.projectStorageFileKey(project.id, 'datasets', datasetId, 'pbmc.h5'), 'b'.repeat(64)]
  );
  const base = `/api/projects/${project.id}`;
  const rel = release();
  const approved = await api(server, `${base}/workflow-releases/${rel.id}/approve`, {
    method: 'POST', token: sponsor.token, body: { digest: rel.digest, note: 'Reviewed QC pipeline.' },
  });
  expect(approved.status).toBe(201);
  const created = await api(server, `${base}/studies`, {
    method: 'POST', token: sponsor.token,
    body: {
      name: 'Resolution sweep', releaseId: rel.id, datasetIds: [datasetId],
      fixedParameters: { minCells: 3, normalizationMethod: 'LogNormalize' },
      variations: { clusterResolution: [0.5, 0.8, 1.2] },
      maxTrials: 3, maxOutstandingRuns: 2, ...study,
    },
  });
  expect(created.status, JSON.stringify(created.data)).toBe(201);
  const delegation = await api(server, `${base}/agent-delegations`, {
    method: 'POST', token: sponsor.token, body: { agentName: 'Runner', capabilities: ALL_CAPS, limits },
  });
  expect(delegation.status).toBe(201);
  return {
    sponsor, project, base, datasetId, rel, study: created.data, approval: approved.data.approval,
    delegation: delegation.data.delegation, token: delegation.data.credential.token,
  };
}

function agent(ctx, path, options = {}, token = ctx.token) {
  return api(server, `/api/automation/v1/projects/${ctx.project.id}${path}`, {
    ...options, headers: { Authorization: `Bearer ${token}` },
  });
}

async function plan(ctx, choices = { clusterResolution: 0.5 }, token) {
  return agent(ctx, '/plans', { method: 'POST', body: { studyId: ctx.study.id, datasetId: ctx.datasetId, choices } }, token);
}

async function submit(ctx, planned, requestId, token) {
  return agent(ctx, '/runs', { method: 'POST', body: { planId: planned.id, planDigest: planned.digest, requestId } }, token);
}

async function completeJob(jobId, projectId, ownerId) {
  const resultId = `ao_${'c'.repeat(24)}`;
  await db.query(
    `INSERT INTO analysis_objects (id, owner_user_id, project_id, object_type, metadata_json)
     VALUES ($1, $2, $3, 'seurat', $4)`,
    [resultId, ownerId, projectId, JSON.stringify({ summary: { cells: 2638, clusters: 9, note: 'x'.repeat(200) }, secretPath: '/vault/x' })]
  );
  await db.query(`UPDATE jobs SET status = 'completed', completed_at = now(), result_analysis_object_id = $2 WHERE id = $1`, [jobId, resultId]);
  return resultId;
}

describe.skipIf(!CONFIGURED)('approved workflow journey', () => {
  it('plans, admits once, recovers a lost reply, and accepts the exact candidate', async () => {
    const ctx = await setup();
    const workflows = await agent(ctx, '/workflows');
    expect(workflows.data.releases.map((r) => r.id)).toEqual([ctx.rel.id]);
    const studies = await agent(ctx, '/studies');
    expect(studies.data.studies[0].variations).toEqual({ clusterResolution: [0.5, 0.8, 1.2] });

    const planned = await plan(ctx, { clusterResolution: 0.8 });
    expect(planned.status, JSON.stringify(planned.data)).toBe(201);
    expect(planned.data.plan.parameters).toMatchObject({ clusterResolution: 0.8, minCells: 3, normalizationMethod: 'LogNormalize' });
    expect(planned.data.plan.actor).toMatchObject({ kind: 'agent', delegationId: ctx.delegation.id });
    expect(planned.data.digest).toMatch(/^[0-9a-f]{64}$/);

    const first = await submit(ctx, planned.data, 'run-req-0001');
    expect(first.status, JSON.stringify(first.data)).toBe(201);
    expect(first.data.run).toMatchObject({ state: 'queued', trialNumber: 1, acceptance: 'none' });
    // A lost reply is recovered with the same requestId: no second admission.
    const replay = await submit(ctx, planned.data, 'run-req-0001');
    expect(replay.status).toBe(200);
    expect(replay.data).toMatchObject({ replayed: true, run: { id: first.data.run.id } });
    // A new requestId cannot reuse the plan to get a second run.
    const again = await submit(ctx, planned.data, 'run-req-0002');
    expect(again.data.code).toBe('PLAN_ALREADY_SUBMITTED');

    const { rows: jobs } = await db.query('SELECT * FROM jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ job_type: 'seurat.pipeline.v1', status: 'queued', owner_user_id: String(ctx.sponsor.user.id) });
    expect(JSON.parse(jobs[0].parameters_json)).toEqual(planned.data.plan.parameters);
    expect(jobs[0].analysis_object_id).toBe(ctx.study.inputs[0].analysisObjectId);

    expect((await agent(ctx, `/runs/${first.data.run.id}/results`)).data.result).toBeNull();
    const resultId = await completeJob(jobs[0].id, ctx.project.id, ctx.sponsor.user.id);
    const results = await agent(ctx, `/runs/${first.data.run.id}/results`);
    expect(results.data.run.state).toBe('candidate_ready');
    expect(results.data.result).toMatchObject({ analysisObjectId: resultId, summary: { cells: 2638, clusters: 9 } });
    expect(JSON.stringify(results.data)).not.toContain('/vault/x');
    expect(results.data.result.summary.note).toBeUndefined();
    const humanRuns = await api(server, `${ctx.base}/agent-runs`, { token: ctx.sponsor.token });
    expect(humanRuns.data.runs[0].summary).toEqual({ cells: 2638, clusters: 9 });

    const accept = (body) => api(server, `${ctx.base}/agent-runs/${first.data.run.id}/accept`, { method: 'POST', token: ctx.sponsor.token, body });
    const accepted = await accept({ expectedAcceptedRunId: null, note: 'Looks right.' });
    expect(accepted.status, JSON.stringify(accepted.data)).toBe(200);
    expect(accepted.data.acceptance).toBe('accepted');
    const stale = await accept({ expectedAcceptedRunId: null });
    expect(stale.status).toBe(409);
    expect(stale.data.code).toBe('BASELINE_CHANGED');

    const audit = await api(server, `${ctx.base}/automation-audit`, { token: ctx.sponsor.token });
    const kinds = Object.fromEntries(audit.data.events.map((e) => [e.action, e.actor.kind]));
    expect(kinds).toMatchObject({ 'workflow.approved': 'human', 'plan.created': 'agent', 'run.admitted': 'agent', 'result.accepted': 'human' });
  });

  it('keeps study, plan, and run records immutable', async () => {
    const ctx = await setup();
    const planned = await plan(ctx);
    await submit(ctx, planned.data, 'run-req-0001');
    await expect(db.query(`UPDATE study_envelopes SET max_trials = 99`)).rejects.toThrow(/immutable/);
    await expect(db.query(`UPDATE execution_plans SET digest = $1`, ['0'.repeat(64)])).rejects.toThrow(/immutable/);
    await expect(db.query(`UPDATE agent_runs SET trial_number = 9`)).rejects.toThrow(/immutable/);
    await expect(db.query('DELETE FROM agent_runs')).rejects.toThrow(/retained/);
  });
});

describe.skipIf(!CONFIGURED)('scientific scope', () => {
  it('refuses variations outside the study and arbitrary parameters', async () => {
    const ctx = await setup();
    expect((await plan(ctx, { clusterResolution: 2 })).data.code).toBe('STUDY_AMENDMENT_REQUIRED');
    expect((await plan(ctx, { minCells: 10 })).data.code).toBe('STUDY_AMENDMENT_REQUIRED');
    expect((await plan(ctx, { script: 'system("id")' })).data.code).toBe('STUDY_AMENDMENT_REQUIRED');
    const extra = await agent(ctx, '/plans', { method: 'POST', body: { studyId: ctx.study.id, datasetId: ctx.datasetId, jobType: 'expert.r.v1' } });
    expect(extra.data.code).toBe('UNKNOWN_FIELD');
    const otherDataset = await agent(ctx, '/plans', { method: 'POST', body: { studyId: ctx.study.id, datasetId: 'ds_other' } });
    expect(otherDataset.data.code).toBe('STUDY_AMENDMENT_REQUIRED');
    expect((await db.query('SELECT COUNT(*)::int AS n FROM execution_plans')).rows[0].n).toBe(0);
  });

  it('rejects individually valid values that violate a joint constraint', async () => {
    const ctx = await setup({ study: { variations: { minFeaturesFilter: [200, 3000] }, fixedParameters: { maxFeaturesFilter: 2500 } } });
    expect((await plan(ctx, { minFeaturesFilter: 200 })).status).toBe(201);
    const bad = await plan(ctx, { minFeaturesFilter: 3000 });
    expect(bad.status).toBe(409);
    expect(bad.data.code).toBe('STUDY_CONSTRAINT_VIOLATION');
  });

  it('refuses inputs whose pinned version changed', async () => {
    const ctx = await setup();
    const planned = await plan(ctx);
    await db.query('UPDATE datasets SET sha256 = $1', ['d'.repeat(64)]);
    expect((await submit(ctx, planned.data, 'run-req-0001')).data.code).toBe('INPUT_CHANGED');
    expect((await plan(ctx)).data.code).toBe('INPUT_CHANGED');
  });

  it('only lets owners/admins approve releases, and only people', async () => {
    const ctx = await setup();
    const analyst = await createUserWithToken({ email: 'analyst@example.com' });
    await db.addProjectMember(ctx.project.id, analyst.user.id, 'analyst');
    await api(server, `${ctx.base}/workflow-approvals/${ctx.approval.id}/revoke`, { method: 'POST', token: ctx.sponsor.token, body: {} });
    const denied = await api(server, `${ctx.base}/workflow-releases/${ctx.rel.id}/approve`, { method: 'POST', token: analyst.token, body: {} });
    expect(denied.status).toBe(403);
    const byAgent = await api(server, `${ctx.base}/workflow-releases/${ctx.rel.id}/approve`, {
      method: 'POST', headers: { Authorization: `Bearer ${ctx.token}` }, body: {},
    });
    expect(byAgent.data.code).toBe('AGENT_ROUTE_NOT_ADAPTED');
    const acceptByAgent = await api(server, `${ctx.base}/agent-runs/run_${'0'.repeat(24)}/accept`, {
      method: 'POST', headers: { Authorization: `Bearer ${ctx.token}` }, body: {},
    });
    expect(acceptByAgent.data.code).toBe('AGENT_ROUTE_NOT_ADAPTED');
  });

  it('treats changed workflow bytes as a different, unapproved release', () => {
    const real = release();
    const changed = buildRelease({
      key: real.key, version: real.version, title: real.title, jobType: real.jobType,
      handlerFiles: ['backend/seuratPipeline.js'], inputs: [], outputs: [], parameterSchema: {}, resources: {}, validation: [],
    });
    expect(changed.digest).not.toBe(real.digest);
    expect(changed.id).not.toBe(real.id);
  });
});

describe.skipIf(!CONFIGURED)('budgets and concurrency', () => {
  it('bounds trials per study regardless of new plans or request ids', async () => {
    const ctx = await setup({ study: { maxTrials: 1 } });
    expect((await submit(ctx, (await plan(ctx)).data, 'run-req-0001')).status).toBe(201);
    const second = await submit(ctx, (await plan(ctx, { clusterResolution: 0.8 })).data, 'run-req-0002');
    expect(second.status).toBe(429);
    expect(second.data).toMatchObject({ code: 'BUDGET_EXCEEDED', details: { budget: 'study-trials' } });
  });

  it('applies delegation outstanding and compute budgets', async () => {
    const ctx = await setup({ limits: { maxOutstandingRuns: 1 } });
    expect((await submit(ctx, (await plan(ctx)).data, 'run-req-0001')).status).toBe(201);
    const blocked = await submit(ctx, (await plan(ctx, { clusterResolution: 0.8 })).data, 'run-req-0002');
    expect(blocked.data.details.budget).toBe('delegation');
  });

  it('enforces a compute budget smaller than one run', async () => {
    const ctx = await setup({ limits: { maxOutstandingRuns: 2, maxReservedCpuSeconds: 100 } });
    const res = await submit(ctx, (await plan(ctx)).data, 'run-req-0001');
    expect(res.data.details.budget).toBe('delegation-compute');
    expect((await db.query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
  });

  it("admits at most the sponsor's limit when two agents race", async () => {
    process.env.AGENT_MAX_OUTSTANDING_RUNS_PER_SPONSOR = '1';
    const ctx = await setup();
    const second = await api(server, `${ctx.base}/agent-delegations`, {
      method: 'POST', token: ctx.sponsor.token, body: { agentName: 'Runner 2', capabilities: ALL_CAPS, limits: { maxOutstandingRuns: 2 } },
    });
    const otherToken = second.data.credential.token;
    const [p1, p2] = [(await plan(ctx)).data, (await plan(ctx, { clusterResolution: 0.8 }, otherToken)).data];
    const results = await Promise.all([submit(ctx, p1, 'run-req-a001'), submit(ctx, p2, 'run-req-b001', otherToken)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 429]);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM agent_runs')).rows[0].n).toBe(1);
  });

  it('admits concurrent identical submissions once', async () => {
    const ctx = await setup();
    const planned = (await plan(ctx)).data;
    const results = await Promise.all(Array.from({ length: 5 }, () => submit(ctx, planned, 'run-req-same')));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n).toBe(1);
  });
});

describe.skipIf(!CONFIGURED)('revocation, dispatch recheck, and cancellation', () => {
  it('blocks admission after the approval is revoked', async () => {
    const ctx = await setup();
    const planned = (await plan(ctx)).data;
    await api(server, `${ctx.base}/workflow-approvals/${ctx.approval.id}/revoke`, { method: 'POST', token: ctx.sponsor.token, body: {} });
    expect((await submit(ctx, planned, 'run-req-0001')).data.code).toBe('RELEASE_NOT_APPROVED');
    expect((await agent(ctx, '/workflows')).data.releases).toEqual([]);
  });

  it('blocks admission when the sponsor loses write access after planning', async () => {
    const ctx = await setup();
    const planned = (await plan(ctx)).data;
    await db.query("UPDATE project_members SET role = 'viewer' WHERE user_id = $1", [ctx.sponsor.user.id]);
    expect((await submit(ctx, planned, 'run-req-0001')).data.code).toBe('SCOPE_DENIED');
  });

  it('cancels a queued agent job at claim time when authority is gone', async () => {
    for (const revoke of ['delegation', 'study', 'release']) {
      await db.resetSchemaForTests();
      const ctx = await setup();
      const run = (await submit(ctx, (await plan(ctx)).data, 'run-req-0001')).data.run;
      if (revoke === 'delegation') {
        await api(server, `${ctx.base}/agent-delegations/${ctx.delegation.id}/revoke`, { method: 'POST', token: ctx.sponsor.token, body: {} });
      } else if (revoke === 'study') {
        await api(server, `${ctx.base}/studies/${ctx.study.id}/close`, { method: 'POST', token: ctx.sponsor.token, body: {} });
      } else {
        await db.query(`UPDATE workflow_releases SET status = 'superseded', superseded_at = now()`);
      }
      const claimed = await db.claimNextJob('worker_agent_test', { leaseSeconds: 30 });
      expect(claimed, revoke).toBeNull();
      const { rows } = await db.query('SELECT status, error_json FROM jobs');
      expect(rows[0].status, revoke).toBe('canceled');
      expect(JSON.parse(rows[0].error_json).code).toBe('AGENT_AUTHORITY_REVOKED');
      const human = await api(server, `${ctx.base}/agent-runs`, { token: ctx.sponsor.token });
      expect(human.data.runs[0]).toMatchObject({ id: run.id, state: 'canceled' });
    }
  });

  it('cancels its own queued run, retains the reservation, and quarantines late output', async () => {
    const ctx = await setup();
    const queued = (await submit(ctx, (await plan(ctx)).data, 'run-req-0001')).data.run;
    const canceled = await agent(ctx, `/runs/${queued.id}/cancel`, { method: 'POST', body: {} });
    expect(canceled.data.run).toMatchObject({ state: 'canceled', reservation: { cpuSeconds: 3600 } });

    const running = (await submit(ctx, (await plan(ctx, { clusterResolution: 0.8 })).data, 'run-req-0002')).data.run;
    const { rows: [job] } = await db.query('SELECT id FROM jobs WHERE id <> (SELECT job_id FROM agent_runs WHERE id = $1)', [queued.id]);
    await db.query(`UPDATE jobs SET status = 'running', started_at = now() WHERE id = $1`, [job.id]);
    expect((await agent(ctx, `/runs/${running.id}/cancel`, { method: 'POST', body: {} })).data.run.state).toBe('cancel_requested');
    await completeJob(job.id, ctx.project.id, ctx.sponsor.user.id);
    expect((await agent(ctx, `/runs/${running.id}`)).data.run.state).toBe('quarantined');
    const accept = await api(server, `${ctx.base}/agent-runs/${running.id}/accept`, {
      method: 'POST', token: ctx.sponsor.token, body: { expectedAcceptedRunId: null },
    });
    expect(accept.data.code).toBe('RESULT_NOT_ACCEPTABLE');
    // Trials and compute stay counted after cancellation.
    const study = await api(server, `${ctx.base}/studies/${ctx.study.id}`, { token: ctx.sponsor.token });
    expect(study.data.trials.map((t) => t.chosenParameters.clusterResolution)).toEqual([0.5, 0.8]);
  });

  it("does not let an agent see or cancel another agent's run", async () => {
    const ctx = await setup();
    const run = (await submit(ctx, (await plan(ctx)).data, 'run-req-0001')).data.run;
    const other = await api(server, `${ctx.base}/agent-delegations`, {
      method: 'POST', token: ctx.sponsor.token, body: { agentName: 'Other', capabilities: ALL_CAPS },
    });
    const token = other.data.credential.token;
    expect((await agent(ctx, `/runs/${run.id}/cancel`, { method: 'POST', body: {} }, token)).status).toBe(404);
    expect((await agent(ctx, `/runs/${run.id}`, {}, token)).status).toBe(404);
  });
});

describe.skipIf(!CONFIGURED)('agent CLI journey', () => {
  it('lists, plans, submits twice without duplicating, and reads status', async () => {
    const { run, EXIT } = await import('../cli/traceomics.mjs');
    const ctx = await setup();
    const env = { TRACEOMICS_AGENT_TOKEN: ctx.token, TRACEOMICS_URL: `http://127.0.0.1:${server.address().port}` };
    const invoke = async (argv) => {
      let out = '';
      const code = await run(argv, { env, stdout: { write: (c) => { out += c; return true; } }, stderr: { write: () => true } });
      return { code, data: out ? JSON.parse(out) : null };
    };
    const p = ['--project', ctx.project.id];
    expect((await invoke(['workflows', 'list', ...p])).data.releases).toHaveLength(1);
    const planned = await invoke(['plans', 'create', ...p, '--study', ctx.study.id, '--dataset', ctx.datasetId, '--choice', 'clusterResolution=1.2']);
    expect(planned.code).toBe(EXIT.OK);
    const submitArgs = ['runs', 'submit', ...p, '--plan', planned.data.id, '--digest', planned.data.digest];
    const first = await invoke(submitArgs);
    const rerun = await invoke(submitArgs);
    expect(rerun.data).toMatchObject({ replayed: true, run: { id: first.data.run.id } });
    expect((await invoke(['runs', 'status', ...p, first.data.run.id])).data.run.state).toBe('queued');
    expect((await invoke(['runs', 'list', ...p, '--mine'])).data.runs).toHaveLength(1);
    const outside = await invoke(['plans', 'create', ...p, '--study', ctx.study.id, '--dataset', ctx.datasetId, '--choice', 'clusterResolution=3']);
    expect(outside.code).toBe(EXIT.CONFLICT);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n).toBe(1);
  });
});

describe.skipIf(!CONFIGURED)('Slurm target routing', () => {
  it('routes an agent run in a Slurm study to the cluster target and reports targets', async () => {
    const { installFakeSlurm } = require('./_fakeSlurm');
    const fake = installFakeSlurm();
    try {
      const ctx = await setup({ study: { executionTarget: 'slurm' } });
      expect(ctx.study.executionTarget).toBe('slurm');
      const planned = (await plan(ctx)).data;
      expect(planned.plan.executionTarget).toBe('slurm');
      const run = (await submit(ctx, planned, 'run-req-slurm1')).data.run;
      expect(run.executionTarget).toBe('slurm');
      expect((await db.query('SELECT execution_target FROM jobs')).rows[0].execution_target).toBe('slurm');

      const human = await api(server, `${ctx.base}/compute-targets`, { token: ctx.sponsor.token });
      expect(human.data.targets.map((t) => [t.name, t.available])).toEqual([['local', true], ['slurm', true]]);
      const agentView = await agent(ctx, '/targets');
      expect(agentView.data.targets[1].partitions.map((p) => p.name)).toContain('normal');
    } finally { fake.restore(); }
  });

  it('rejects a Slurm study when the target is unavailable', async () => {
    const ctx = await setup();
    const res = await api(server, `${ctx.base}/studies`, {
      method: 'POST', token: ctx.sponsor.token,
      body: { name: 'HPC', releaseId: ctx.rel.id, datasetIds: [ctx.datasetId], executionTarget: 'slurm' },
    });
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('TARGET_UNAVAILABLE');
  });
});
