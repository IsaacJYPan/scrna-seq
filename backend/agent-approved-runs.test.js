/**
 * Approved workflow execution by delegated agents (docs/spec.md phase 2).
 *
 * Real Express + PostgreSQL. No R is contacted: tests observe admission,
 * the queued job, the worker's claim-time recheck, and simulate completion
 * by writing the job's terminal state the way a worker would.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

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

describe.skipIf(!CONFIGURED)('composed follow-on studies', () => {
  const markers = () => currentReleases().find((r) => r.key === 'seurat-markers');

  async function acceptedClustering(ctx) {
    const planned = await plan(ctx, { clusterResolution: 0.8 });
    const run = await submit(ctx, planned.data, 'run-req-0001');
    const { rows: [job] } = await db.query('SELECT id FROM jobs WHERE id = (SELECT job_id FROM agent_runs WHERE id = $1)', [run.data.run.id]);
    const resultId = await completeJob(job.id, ctx.project.id, ctx.sponsor.user.id);
    const accepted = await api(server, `${ctx.base}/agent-runs/${run.data.run.id}/accept`, {
      method: 'POST', token: ctx.sponsor.token, body: { expectedAcceptedRunId: null } });
    expect(accepted.status).toBe(200);
    return { runId: run.data.run.id, resultId };
  }

  async function approveMarkers(ctx) {
    const rel = markers();
    const ok = await api(server, `${ctx.base}/workflow-releases/${rel.id}/approve`, {
      method: 'POST', token: ctx.sponsor.token, body: { digest: rel.digest } });
    expect(ok.status).toBe(201);
    return rel;
  }

  const createFollowOn = (ctx, body) => api(server, `${ctx.base}/studies`, { method: 'POST', token: ctx.sponsor.token, body });

  it('runs the marker workflow on the accepted clustering and accepts its artifact result', async () => {
    const ctx = await setup();
    const rel = await approveMarkers(ctx);
    const early = await createFollowOn(ctx, { name: 'Markers', releaseId: rel.id, sourceStudyId: ctx.study.id });
    expect(early.data.code).toBe('SOURCE_NOT_ACCEPTED');

    const { runId: sourceRunId, resultId } = await acceptedClustering(ctx);
    expect((await createFollowOn(ctx, { name: 'Markers', releaseId: rel.id, datasetIds: [ctx.datasetId] })).status).toBe(400);
    const created = await createFollowOn(ctx, {
      name: 'Markers', releaseId: rel.id, sourceStudyId: ctx.study.id,
      variations: { logfcThreshold: [0.25, 0.5] }, maxTrials: 2,
    });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    expect(created.data).toMatchObject({ sourceStudyId: ctx.study.id,
      inputs: [{ analysisObjectId: resultId, sourceRunId, datasetId: ctx.datasetId }] });

    const followOn = { ...ctx, study: created.data };
    const planned = await plan(followOn, { logfcThreshold: 0.5 });
    expect(planned.status, JSON.stringify(planned.data)).toBe(201);
    expect(planned.data.plan.release.key).toBe('seurat-markers');
    expect(planned.data.plan.parameters).toMatchObject({ logfcThreshold: 0.5, groupBy: 'seurat_clusters' });
    const run = await submit(followOn, planned.data, 'run-req-0101');
    expect(run.status, JSON.stringify(run.data)).toBe(201);
    const { rows: [job] } = await db.query('SELECT * FROM jobs WHERE id = (SELECT job_id FROM agent_runs WHERE id = $1)', [run.data.run.id]);
    // Dataset provenance stays in the plan; object-only R receipts require null.
    expect(job).toMatchObject({ job_type: 'deg.find_markers.v1', analysis_object_id: resultId, dataset_id: null });
    expect(planned.data.plan.inputs.datasetId).toBe(ctx.datasetId);

    // Simulate the worker recording the marker summary artifact.
    await db.query(`UPDATE jobs SET status = 'completed', completed_at = now() WHERE id = $1`, [job.id]);
    const results0 = await agent(ctx, `/runs/${run.data.run.id}/results`);
    expect(results0.data.run.state).toBe('quarantined');
    await db.query(
      `INSERT INTO job_artifacts (id, project_id, job_id, created_by_user_id, artifact_type, name, storage_kind, metadata_json)
       VALUES ('art_markers1', $1, $2, $3, 'deg_summary', 'DEG summary', 'metadata_only', $4)`,
      [ctx.project.id, job.id, ctx.sponsor.user.id, JSON.stringify({ summary: { n_clusters: 9, n_markers: 90 } })]
    );
    const results = await agent(ctx, `/runs/${run.data.run.id}/results`);
    expect(results.data.result).toMatchObject({ artifactId: 'art_markers1', summary: { n_clusters: 9, n_markers: 90 } });
    const human = await api(server, `${ctx.base}/agent-runs`, { token: ctx.sponsor.token });
    expect(human.data.runs.find((r) => r.id === run.data.run.id).summary).toEqual({ n_clusters: 9, n_markers: 90 });

    const accepted = await api(server, `${ctx.base}/agent-runs/${run.data.run.id}/accept`, {
      method: 'POST', token: ctx.sponsor.token, body: { expectedAcceptedRunId: null } });
    expect(accepted.status, JSON.stringify(accepted.data)).toBe(200);
    const { rows: [acc] } = await db.query('SELECT * FROM result_acceptances WHERE run_id = $1', [run.data.run.id]);
    expect(acc).toMatchObject({ result_artifact_id: 'art_markers1', result_analysis_object_id: null });
  });

  it('refuses a source study of the wrong workflow and results the creator does not own', async () => {
    const ctx = await setup();
    const rel = await approveMarkers(ctx);
    await acceptedClustering(ctx);
    // A follow-on of a follow-on is not a clustering.
    const first = await createFollowOn(ctx, { name: 'Markers', releaseId: rel.id, sourceStudyId: ctx.study.id });
    const wrong = await createFollowOn(ctx, { name: 'Again', releaseId: rel.id, sourceStudyId: first.data.id });
    expect(wrong.data.code).toBe('INPUT_NOT_APPLICABLE');

    const other = await createUserWithToken({ email: 'analyst@example.com', displayName: 'Analyst' });
    await db.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'analyst')", [ctx.project.id, other.user.id]);
    const notMine = await api(server, `${ctx.base}/studies`, { method: 'POST', token: other.token,
      body: { name: 'Mine', releaseId: rel.id, sourceStudyId: ctx.study.id } });
    expect(notMine.status).toBe(403);
  });
});

describe.skipIf(!CONFIGURED)('study selection rules', () => {
  it('recommends the finished trial the declared rule ranks first, without accepting it', async () => {
    const ctx = await setup({ study: { selectionRule: { metric: 'nClusters', goal: 'max' } } });
    expect(ctx.study.selectionRule).toEqual({ metric: 'nClusters', goal: 'max' });
    const bad = await api(server, `${ctx.base}/studies`, { method: 'POST', token: ctx.sponsor.token,
      body: { name: 'Bad', releaseId: ctx.rel.id, datasetIds: [ctx.datasetId], selectionRule: { metric: 'x; drop', goal: 'max' } } });
    expect(bad.status).toBe(400);

    const ids = [];
    for (const [i, value] of [[1, 0.5], [2, 1.2]]) {
      const planned = await plan(ctx, { clusterResolution: value });
      const run = await submit(ctx, planned.data, `run-req-000${i}`);
      ids.push(run.data.run.id);
      const { rows: [job] } = await db.query('SELECT job_id FROM agent_runs WHERE id = $1', [run.data.run.id]);
      const resultId = `ao_${String(i).repeat(24)}`;
      await db.query(`INSERT INTO analysis_objects (id, owner_user_id, project_id, object_type, metadata_json) VALUES ($1, $2, $3, 'seurat', $4)`,
        [resultId, ctx.sponsor.user.id, ctx.project.id, JSON.stringify({ summary: { nClusters: i === 1 ? 7 : 11 } })]);
      await db.query(`UPDATE jobs SET status = 'completed', completed_at = now(), result_analysis_object_id = $2 WHERE id = $1`, [job.job_id, resultId]);
    }
    const study = await agent(ctx, `/studies/${ctx.study.id}`);
    expect(study.data.study.selection).toMatchObject({ runId: ids[1], value: 11, rule: { metric: 'nClusters', goal: 'max' } });
    expect(study.data.study.trials.map((t) => t.summary)).toEqual([{ nClusters: 7 }, { nClusters: 11 }]);
    expect(study.data.study.acceptedRunId).toBeNull();

    // Without results.read the agent sees the rule but not results or the pick.
    const limited = await api(server, `${ctx.base}/agent-delegations`, { method: 'POST', token: ctx.sponsor.token,
      body: { agentName: 'Planner', capabilities: ['workflow.plan'], limits: { maxOutstandingRuns: 1 } } });
    const view = await agent(ctx, `/studies/${ctx.study.id}`, {}, limited.data.credential.token);
    expect(view.data.study.selection).toEqual({ rule: { metric: 'nClusters', goal: 'max' } });
    expect(view.data.study.trials.every((t) => t.summary === null)).toBe(true);
  });
});

describe.skipIf(!CONFIGURED)('trusted method follow-on studies', () => {
  const crypto = require('crypto');
  const fs = require('fs');
  const { createJobWorker } = require('./jobWorker');
  const byKey = (key) => currentReleases().find((r) => r.key === key);
  const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

  async function acceptedClusteringWithCheckpoint(ctx) {
    const planned = await plan(ctx, { clusterResolution: 0.8 });
    const run = await submit(ctx, planned.data, 'run-req-0001');
    const { rows: [job] } = await db.query('SELECT id FROM jobs WHERE id = (SELECT job_id FROM agent_runs WHERE id = $1)', [run.data.run.id]);
    const resultId = await completeJob(job.id, ctx.project.id, ctx.sponsor.user.id);
    await db.query(
      `INSERT INTO job_artifacts (id, project_id, job_id, result_analysis_object_id, created_by_user_id, artifact_type,
         storage_kind, storage_uri, checksum_sha256, size_bytes, status, metadata_json)
       VALUES ('art_ckpt1', $1, $2, $3, $4, 'checkpoint', 'local_internal', $5, $6, 10, 'available', '{}')`,
      [ctx.project.id, job.id, resultId, ctx.sponsor.user.id,
        storage.projectStorageFileKey(ctx.project.id, 'checkpoints', job.id, 'checkpoint.rds'), 'e'.repeat(64)]
    );
    const accepted = await api(server, `${ctx.base}/agent-runs/${run.data.run.id}/accept`, {
      method: 'POST', token: ctx.sponsor.token, body: { expectedAcceptedRunId: null } });
    expect(accepted.status).toBe(200);
    return resultId;
  }

  async function approve(ctx, rel) {
    const ok = await api(server, `${ctx.base}/workflow-releases/${rel.id}/approve`, {
      method: 'POST', token: ctx.sponsor.token, body: { digest: rel.digest } });
    expect(ok.status).toBe(201);
  }

  // Stands in for the sandbox broker: writes each declared output where the
  // broker would and reports the descriptors the real broker returns.
  function fakeSandbox(metrics) {
    const provider = storage.createLocalStorageProvider();
    return async (input) => {
      const workflowFiles = Object.entries(input.workflowOutputs).map(([port, output]) => {
        const body = output.type === 'metrics' ? JSON.stringify(metrics)
          : output.type === 'table' ? JSON.stringify([{ value: 'singlet', cells: 900 }]) : `rds:${port}`;
        const storageKey = `${input.outputStorageKey}-${output.name}`;
        fs.writeFileSync(provider.prepareWrite(storageKey), body);
        return { name: output.name, storageKey, sizeBytes: Buffer.byteLength(body), checksumSha256: sha(body) };
      });
      return { ok: true, saved: true, workflowFiles, scriptSha256: sha(input.script), profileId: input.profileId,
        checkpointChecksumSha256: input.checkpointChecksumSha256, sandboxImageDigest: `sha256:${'d'.repeat(64)}`,
        resourcePolicyVersion: 'expert-r-sandbox-policy.v3' };
    };
  }

  it('fixes design choices, runs the pinned method, records a loadable result, and chains', async () => {
    const ctx = await setup();
    const sourceResult = await acceptedClusteringWithCheckpoint(ctx);
    const subset = byKey('subset-cells');
    await approve(ctx, subset);
    const create = (body) => api(server, `${ctx.base}/studies`, { method: 'POST', token: ctx.sponsor.token, body });

    const protectedVariation = await create({ name: 'Subset', releaseId: subset.id, sourceStudyId: ctx.study.id,
      variations: { column: ['seurat_clusters', 'cell_type'] } });
    expect(protectedVariation.data.code).toBe('PROTECTED_PARAMETER');
    const badText = await create({ name: 'Subset', releaseId: subset.id, sourceStudyId: ctx.study.id,
      fixedParameters: { values: 'singlet"); q("' } });
    expect(badText.data.code).toBe('INVALID_PARAMETER');

    const created = await create({ name: 'Remove doublets', releaseId: subset.id, sourceStudyId: ctx.study.id,
      fixedParameters: { column: 'scDblFinder.class', values: 'singlet', mode: 'keep', 'min-cells': 10 },
      maxTrials: 2, selectionRule: { metric: 'cells_after', goal: 'max' } });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const followOn = { ...ctx, study: created.data };
    const planned = await plan(followOn, {});
    expect(planned.status, JSON.stringify(planned.data)).toBe(201);
    expect(planned.data.plan.parameters).toMatchObject({ method: 'subset-cells', values: { 'min-cells': 10, values: 'singlet' } });
    const run = await submit(followOn, planned.data, 'run-req-0201');
    expect(run.status, JSON.stringify(run.data)).toBe(201);
    const { rows: [queued] } = await db.query('SELECT * FROM jobs WHERE id = (SELECT job_id FROM agent_runs WHERE id = $1)', [run.data.run.id]);
    expect(queued).toMatchObject({ job_type: 'trusted.method.v1', analysis_object_id: sourceResult });

    const runExpertSandbox = fakeSandbox({ cells_before: 1000, cells_after: 900, cells_removed: 100, fraction_kept: 0.9, values_not_found: 0 });
    const worker = createJobWorker({ db, runExpertSandbox, logger: { info() {}, warn() {}, error() {}, log() {} } });
    await worker.runOnce();
    const { rows: [done] } = await db.query('SELECT * FROM jobs WHERE id = $1', [queued.id]);
    expect(done.status, done.error_json).toBe('completed');
    const { rows: artifacts } = await db.query('SELECT artifact_type, result_analysis_object_id FROM job_artifacts WHERE job_id = $1 ORDER BY artifact_type', [queued.id]);
    expect(artifacts.map((a) => a.artifact_type)).toEqual(['checkpoint', 'trusted_method_output', 'trusted_method_output', 'trusted_method_summary']);
    expect(artifacts[0].result_analysis_object_id).toBe(done.result_analysis_object_id);

    const results = await agent(ctx, `/runs/${run.data.run.id}/results`);
    expect(results.data.run.state).toBe('candidate_ready');
    expect(results.data.result.summary).toEqual({ cells_after: 900, cells_removed: 100 });
    const study = await api(server, `${ctx.base}/studies/${created.data.id}`, { token: ctx.sponsor.token });
    expect(study.data.selection).toMatchObject({ runId: run.data.run.id, value: 900 });

    // Accepting the subset lets a second method build on it.
    const accepted = await api(server, `${ctx.base}/agent-runs/${run.data.run.id}/accept`, {
      method: 'POST', token: ctx.sponsor.token, body: { expectedAcceptedRunId: null } });
    expect(accepted.status, JSON.stringify(accepted.data)).toBe(200);
    const recluster = byKey('recluster-integrate');
    await approve(ctx, recluster);
    const next = await create({ name: 'Re-cluster', releaseId: recluster.id, sourceStudyId: created.data.id,
      variations: { resolution: [0.4, 0.8] } });
    expect(next.status, JSON.stringify(next.data)).toBe(201);
    expect(next.data.inputs[0].analysisObjectId).toBe(done.result_analysis_object_id);
  });

  it('will not run a job whose method bytes no longer match', async () => {
    const ctx = await setup();
    await acceptedClusteringWithCheckpoint(ctx);
    const subset = byKey('subset-cells');
    await approve(ctx, subset);
    const created = await api(server, `${ctx.base}/studies`, { method: 'POST', token: ctx.sponsor.token,
      body: { name: 'Subset', releaseId: subset.id, sourceStudyId: ctx.study.id } });
    const planned = await plan({ ...ctx, study: created.data }, {});
    const run = await submit({ ...ctx, study: created.data }, planned.data, 'run-req-0301');
    const { rows: [queued] } = await db.query('SELECT * FROM jobs WHERE id = (SELECT job_id FROM agent_runs WHERE id = $1)', [run.data.run.id]);
    const tampered = { ...JSON.parse(queued.parameters_json), methodSourceSha256: '0'.repeat(64) };
    await db.query('UPDATE jobs SET parameters_json = $2 WHERE id = $1', [queued.id, JSON.stringify(tampered)]);
    const runExpertSandbox = vi.fn();
    await createJobWorker({ db, runExpertSandbox, logger: { info() {}, warn() {}, error() {}, log() {} } }).runOnce();
    const { rows: [failed] } = await db.query('SELECT status FROM jobs WHERE id = $1', [queued.id]);
    expect(failed.status).toBe('failed');
    expect(runExpertSandbox).not.toHaveBeenCalled();
  });
});

describe.skipIf(!CONFIGURED)('multi-sample studies', () => {
  it('pins every sample, fixes the sheet, and plans only on the primary sample', async () => {
    const ctx = await setup();
    const second = 'ds_fedcba9876543210';
    await db.query(
      `INSERT INTO datasets (id, project_id, owner_user_id, created_by_user_id, original_filename, internal_storage_key,
         file_type, file_size_bytes, sha256, upload_status, validation_status)
       VALUES ($1, $2, $3, $3, 'case.h5', $4, 'tenx_h5', 100, $5, 'uploaded', 'valid')`,
      [second, ctx.project.id, ctx.sponsor.user.id, storage.projectStorageFileKey(ctx.project.id, 'datasets', second, 'case.h5'), 'c'.repeat(64)]
    );
    const rel = currentReleases().find((r) => r.key === 'seurat-multisample');
    await api(server, `${ctx.base}/workflow-releases/${rel.id}/approve`, { method: 'POST', token: ctx.sponsor.token, body: { digest: rel.digest } });
    const samples = [
      { datasetId: ctx.datasetId, sampleName: 'ctrl1', conditionName: 'control', donorCode: 'D1' },
      { datasetId: second, sampleName: 'case1', conditionName: 'disease', donorCode: 'D2' },
    ];
    const create = (body) => api(server, `${ctx.base}/studies`, { method: 'POST', token: ctx.sponsor.token, body });
    expect((await create({ name: 'Multi', releaseId: rel.id, datasetIds: [ctx.datasetId, second] })).status).toBe(400);
    expect((await create({ name: 'Multi', releaseId: rel.id, datasetIds: [ctx.datasetId], fixedParameters: { samples } })).status).toBe(400);
    expect((await create({ name: 'Multi', releaseId: rel.id, datasetIds: [ctx.datasetId, second],
      variations: { samples: [samples] } })).data.code).toBe('PROTECTED_PARAMETER');
    const created = await create({ name: 'Multi', releaseId: rel.id, datasetIds: [ctx.datasetId, second],
      fixedParameters: { samples }, variations: { clusterResolution: [0.5, 1] } });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const study = { ...ctx, study: created.data };
    const wrong = await agent(study, '/plans', { method: 'POST', body: { studyId: created.data.id, datasetId: second, choices: {} } });
    expect(wrong.data.code).toBe('STUDY_AMENDMENT_REQUIRED');
    const planned = await plan(study, { clusterResolution: 1 });
    expect(planned.status, JSON.stringify(planned.data)).toBe(201);
    expect(planned.data.plan.parameters.samples.map((s) => s.sampleName)).toEqual(['ctrl1', 'case1']);
    const run = await submit(study, planned.data, 'run-req-0401');
    expect(run.status, JSON.stringify(run.data)).toBe(201);
    const { rows: [job] } = await db.query('SELECT * FROM jobs WHERE id = (SELECT job_id FROM agent_runs WHERE id = $1)', [run.data.run.id]);
    expect(job).toMatchObject({ job_type: 'seurat.multisample.v1', dataset_id: ctx.datasetId });

    // A changed second sample blocks planning and admission of further trials.
    const pending = await plan(study, { clusterResolution: 0.5 });
    expect(pending.status).toBe(201);
    await db.query("UPDATE datasets SET sha256 = $2 WHERE id = $1", [second, 'f'.repeat(64)]);
    expect((await plan(study, { clusterResolution: 0.5 })).data.code).toBe('INPUT_CHANGED');
    expect((await submit(study, pending.data, 'run-req-0402')).data.code).toBe('INPUT_CHANGED');
  });
});
