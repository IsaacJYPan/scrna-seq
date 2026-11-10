/**
 * Agent sandboxes (isolated development) and agent-drafted reports.
 *
 * Real Express + PostgreSQL. The Expert R broker is a stub that only reports
 * its environment; tests complete sandbox jobs the way the worker does, with a
 * real tar.gz output bundle in durable storage.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const config = require('./config');
const db = require('./pgDatabase');
const storage = require('./storage');
const { EXPERT_R_PROFILE, allocateExpertRBundleStorageKey } = require('./expertR');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const { environmentFixture } = require('./_r-environment-test-utils');
const { environmentBytes } = require('./rEnvironment');

const CONFIGURED = config.hasPostgresConnection();
const ENV_KEYS = ['APP_DEPLOYMENT_MODE', 'EXPERT_R_ENABLED', 'EXPERT_R_SANDBOX_URL', 'EXPERT_R_SANDBOX_TOKEN',
  'EXPERT_R_ACCESS_POLICY', 'DISABLE_RATE_LIMIT'];
const saved = {};
const CAPS = ['metadata.read', 'results.read', 'development.executeCandidate', 'report.write', 'run.cancelOwn'];
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d60000000049454e44ae426082', 'hex');
const SCRIPT = `# ---- Load ----
stopifnot(inherits(obj, "Seurat"))
# ---- Cluster ----
obj <- tryCatch(FindClusters(obj, resolution = 0.5), error = function(e) stop(e))
write_table(data.frame(cluster = 1:2), "clusters.csv")
save_figure(DimPlot(obj), "umap.png")
`;

let server;
let broker;
const provider = storage.createLocalStorageProvider();

beforeAll(async () => {
  if (!CONFIGURED) return;
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  broker = http.createServer((req, res) => {
    if (req.url === '/environment' && req.headers.authorization === `Bearer ${'a'.repeat(64)}`) {
      res.end(JSON.stringify(environmentFixture('f').manifest));
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((resolve) => broker.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, {
    APP_DEPLOYMENT_MODE: 'private', EXPERT_R_ENABLED: 'true',
    EXPERT_R_SANDBOX_URL: `http://127.0.0.1:${broker.address().port}`, EXPERT_R_SANDBOX_TOKEN: 'a'.repeat(64),
    DISABLE_RATE_LIMIT: 'true',
  });
  delete process.env.EXPERT_R_ACCESS_POLICY;
  server = await startServer();
});

afterAll(async () => {
  if (!CONFIGURED) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (broker) await new Promise((resolve) => broker.close(resolve));
  await db.close();
  for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

beforeEach(async () => {
  if (!CONFIGURED) return;
  await db.resetSchemaForTests();
});

async function seedCheckpoint(userId, projectId, objectId) {
  const job = await db.createProjectJob(userId, projectId, { jobType: 'generic', analysisObjectId: objectId });
  const claim = await db.claimNextJob('seed-worker', { allowedJobTypes: ['generic'], leaseSeconds: 30 });
  const artifact = await db.createCheckpointArtifactForJobByWorker(job.id, 'seed-worker', claim.claimToken, {
    artifactType: 'checkpoint', resultAnalysisObjectId: objectId,
    internalStorageKey: `projects/${projectId}/checkpoints/${job.id}/checkpoint.rds`,
    checksumSha256: 'c'.repeat(64), sizeBytes: 2048,
  });
  await db.completeJobByWorker(job.id, 'seed-worker', claim.claimToken);
  return artifact;
}

async function setup({ caps = CAPS, limits = { maxOutstandingRuns: 2 }, sandbox = {} } = {}) {
  const sponsor = await createUserWithToken({ email: 'sponsor@example.com', displayName: 'Sponsor' });
  const org = await db.createOrganizationForUser(sponsor.user.id, { name: 'Lab' });
  const project = await db.createProjectForUser(sponsor.user.id, { organizationId: org.id, name: 'PBMC' });
  const object = await db.createProjectAnalysisObject(sponsor.user.id, project.id, { objectType: 'seurat', displayName: 'Clustered PBMC' });
  await seedCheckpoint(sponsor.user.id, project.id, object.id);
  await db.setExpertRExecutorByEmail(sponsor.user.email, true);
  const base = `/api/projects/${project.id}`;
  const created = await api(server, `${base}/agent-sandboxes`, {
    method: 'POST', token: sponsor.token,
    body: { name: 'Marker exploration', objective: 'Find marker genes', analysisObjectIds: [object.id], maxRuns: 3, ...sandbox },
  });
  expect(created.status, JSON.stringify(created.data)).toBe(201);
  const delegation = await api(server, `${base}/agent-delegations`, {
    method: 'POST', token: sponsor.token, body: { agentName: 'Analyst agent', capabilities: caps, limits },
  });
  expect(delegation.status, JSON.stringify(delegation.data)).toBe(201);
  const token = delegation.data.credential.token;
  const agent = (p, options = {}) => api(server, `/api/automation/v1/projects/${project.id}${p}`, {
    ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  return { sponsor, project, object, base, sandbox: created.data.sandbox, agent, delegation: delegation.data.delegation };
}

function submit(ctx, requestId = 'req-sandbox-0001', extra = {}) {
  return ctx.agent(`/sandboxes/${ctx.sandbox.id}/runs`, {
    method: 'POST', body: { requestId, title: 'Cluster and plot', script: SCRIPT, ...extra },
  });
}

// Completes a claimed sandbox job like the worker: real tar.gz bundle in storage.
async function completeSandboxJob(ctx, jobId, files) {
  const claim = await db.claimNextJob('sandbox-worker', { allowedJobTypes: ['expert.r.v1'], leaseSeconds: 30 });
  expect(claim?.id).toBe(jobId);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  const archive = path.join(dir, '..', `${path.basename(dir)}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', dir, '.']);
  const key = allocateExpertRBundleStorageKey(ctx.project.id, jobId);
  const stored = await provider.putFileFromPath(archive, key);
  const listed = Object.entries(files).map(([name, content]) => ({
    name, sizeBytes: Buffer.byteLength(content), checksumSha256: crypto.createHash('sha256').update(content).digest('hex'),
  }));
  const checkpoint = await db.resolveCheckpointArtifact(ctx.object.id, ctx.project.id);
  const provenance = { environment: claim.parameters.environment, packageProfileId: EXPERT_R_PROFILE.id,
    sandboxImageDigest: claim.parameters.environment.imageDigest,
    resourcePolicyVersion: 'expert-r-sandbox-policy.v3', scriptSha256: claim.parameters.scriptSha256,
    input: { analysisObjectId: ctx.object.id, checkpointArtifactId: checkpoint.checkpointArtifactId,
      checkpointChecksumSha256: checkpoint.checksumSha256, checkpointSizeBytes: checkpoint.sizeBytes, privateInputs: [] } };
  const environment = claim.parameters.environment;
  const environmentKey = `${key}.environment.json`;
  const environmentFile = path.join(dir, '..', `${path.basename(dir)}.env.json`);
  fs.writeFileSync(environmentFile, environmentBytes(environmentFixture('f').manifest));
  const storedEnvironment = await provider.putFileFromPath(environmentFile, environmentKey);
  fs.rmSync(environmentFile, { force: true });
  const completion = await db.completeExpertRResultByWorker(jobId, 'sandbox-worker', claim.claimToken, {
    environmentArtifact: { artifactType: 'expert_r_environment', storageKind: 'local_internal', internalStorageKey: environmentKey,
      checksumSha256: storedEnvironment.checksumSha256, sizeBytes: storedEnvironment.sizeBytes, metadata: { environment } },
    result: { objectType: 'generic', displayName: 'Expert R result', metadata: { analysisKind: 'expert_r', ...provenance,
      outputBundleChecksumSha256: stored.checksumSha256, nFiles: listed.length } },
    bundleArtifact: {
      artifactType: 'expert_r_bundle', storageKind: 'local_internal', internalStorageKey: key,
      checksumSha256: stored.checksumSha256, sizeBytes: stored.sizeBytes,
      metadata: { ...provenance, nFiles: listed.length, outputBytes: listed.reduce((n, f) => n + f.sizeBytes, 0), files: listed },
    },
    summaryArtifact: { artifactType: 'expert_r_summary', storageKind: 'metadata_only', metadata: { ...provenance, files: listed,
      nFiles: listed.length, outputBundleChecksumSha256: stored.checksumSha256, outputBundleSizeBytes: stored.sizeBytes, downloadable: false } },
  });
  await db.completeJobByWorker(jobId, 'sandbox-worker', claim.claimToken, { resultAnalysisObjectId: completion.resultObject.id });
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(archive, { force: true });
  return completion;
}

async function jobIdOf(runId) {
  return (await db.query('SELECT job_id FROM agent_sandbox_runs WHERE id = $1', [runId])).rows[0].job_id;
}

describe.skipIf(!CONFIGURED)('agent sandboxes', () => {
  it('runs an agent script on a read-only pinned input and keeps the output as a draft until promoted', async () => {
    const ctx = await setup();
    const listed = await ctx.agent('/sandboxes');
    expect(listed.status).toBe(200);
    expect(listed.data.sandboxes[0]).toMatchObject({ id: ctx.sandbox.id, runtime: { network: 'none' } });

    const first = await submit(ctx);
    expect(first.status, JSON.stringify(first.data)).toBe(201);
    expect(first.data.run).toMatchObject({ state: 'queued', runNumber: 1, inputAnalysisObjectId: ctx.object.id });
    expect(first.data.run.steps.map((s) => s.title)).toEqual(['Load', 'Cluster']);
    expect(first.data.run.steps[1].readable).toBe(
      'obj <- FindClusters(obj, resolution = 0.5)\nwrite_table(data.frame(cluster = 1:2), "clusters.csv")\nsave_figure(DimPlot(obj), "umap.png")');
    const replay = await submit(ctx);
    expect(replay.status).toBe(200);
    expect(replay.data).toMatchObject({ replayed: true, run: { id: first.data.run.id } });
    const conflict = await submit(ctx, 'req-sandbox-0001', { title: 'Something else' });
    expect(conflict.data.code).toBe('IDEMPOTENCY_CONFLICT');

    // The job is an ordinary one-shot Expert R job owned by the sponsor, with the
    // environment pinned and the script retained as source.
    const jobId = await jobIdOf(first.data.run.id);
    const job = (await db.query('SELECT * FROM jobs WHERE id = $1', [jobId])).rows[0];
    expect(job).toMatchObject({ job_type: 'expert.r.v1', analysis_object_id: ctx.object.id, max_attempts: 1 });
    expect(Number(job.owner_user_id)).toBe(Number(ctx.sponsor.user.id));
    expect(JSON.parse(job.parameters_json).environment).toBeTruthy();

    const completion = await completeSandboxJob(ctx, jobId, { 'clusters.csv': 'cluster\n1\n2\n', 'umap.png': PNG });
    const run = await ctx.agent(`/sandbox-runs/${first.data.run.id}`);
    expect(run.data.run).toMatchObject({ state: 'draft_ready', review: { state: 'draft' }, resultAnalysisObjectId: completion.resultObject.id });
    expect(run.data.run.files.map((f) => [f.name, f.kind])).toEqual([['clusters.csv', 'text'], ['umap.png', 'image']]);

    const table = await ctx.agent(`/sandbox-runs/${first.data.run.id}/files/clusters.csv`);
    expect(table.data).toMatchObject({ kind: 'text', text: 'cluster\n1\n2\n' });
    const image = await ctx.agent(`/sandbox-runs/${first.data.run.id}/files/umap.png`);
    expect(Buffer.from(image.data.base64, 'base64').equals(PNG)).toBe(true);
    expect((await ctx.agent(`/sandbox-runs/${first.data.run.id}/files/missing.csv`)).status).toBe(404);
    expect((await ctx.agent(`/sandbox-runs/${first.data.run.id}/files/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);

    // The input object is unchanged and the draft is not visible to a collaborator.
    const collaborator = await createUserWithToken({ email: 'collab@example.com' });
    await db.addProjectMemberByEmail(ctx.project.id, collaborator.user.email, 'analyst', { userId: ctx.sponsor.user.id });
    expect(await db.getProjectAnalysisObject(collaborator.user.id, ctx.project.id, completion.resultObject.id)).toBeNull();
    expect((await api(server, `${ctx.base}/agent-sandboxes/${ctx.sandbox.id}`, { token: collaborator.token })).status).toBe(404);

    // The sponsor reviews: sees the file and promotes.
    const raw = await api(server, `${ctx.base}/agent-sandbox-runs/${first.data.run.id}/files/umap.png`, { token: ctx.sponsor.token });
    expect(raw.status).toBe(200);
    expect(raw.res.headers.get('content-type')).toBe('image/png');
    const review = await api(server, `${ctx.base}/agent-sandbox-runs/${first.data.run.id}/review`, {
      method: 'POST', token: ctx.sponsor.token, body: { decision: 'promoted', note: 'Clusters look right.' },
    });
    expect(review.status, JSON.stringify(review.data)).toBe(200);
    expect(review.data.run.review).toMatchObject({ state: 'promoted', branchId: expect.stringMatching(/^br_/) });
    expect(await db.getProjectAnalysisObject(collaborator.user.id, ctx.project.id, completion.resultObject.id)).toBeTruthy();
    const again = await api(server, `${ctx.base}/agent-sandbox-runs/${first.data.run.id}/review`, {
      method: 'POST', token: ctx.sponsor.token, body: { decision: 'discarded' },
    });
    expect(again.data.code).toBe('ALREADY_REVIEWED');

    const audit = await db.query('SELECT action, actor_kind FROM automation_audit_events ORDER BY created_at, id');
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['sandbox.created', 'sandbox-run.admitted', 'sandbox-run.promoted']));
  });

  it('enforces capability, sandbox budgets, and input pinning', async () => {
    const ctx = await setup({ sandbox: { maxRuns: 1 } });
    const other = await submit(ctx, 'req-sandbox-0002', { inputAnalysisObjectId: 'obj_not_in_sandbox' });
    expect(other.data.code).toBe('STUDY_AMENDMENT_REQUIRED');
    expect((await submit(ctx)).status).toBe(201);
    const over = await submit(ctx, 'req-sandbox-0003', { title: 'Second' });
    expect(over.status).toBe(429);
    expect(over.data.details.budget).toBe('sandbox-runs');

    const busy = await setup2(ctx, { maxOutstandingRuns: 1 });
    expect((await busy.submit('req-sandbox-0006')).status).toBe(201);
    expect((await busy.submit('req-sandbox-0007')).data.details.budget).toBe('sponsor');

    const readOnly = await setupSecondAgent(ctx, ['metadata.read', 'results.read']);
    expect((await readOnly(`/sandboxes`)).status).toBe(403);
    expect((await readOnly(`/sandboxes/${ctx.sandbox.id}/runs`, {
      method: 'POST', body: { requestId: 'req-sandbox-0005', title: 'x', script: 'print(1)' },
    })).data.code).toBe('SCOPE_DENIED');
  });

  it('cancels a queued run before any R contact when the delegation is revoked or the sandbox closes', async () => {
    const ctx = await setup();
    const run = (await submit(ctx)).data.run;
    await api(server, `${ctx.base}/agent-sandboxes/${ctx.sandbox.id}/close`, { method: 'POST', token: ctx.sponsor.token });
    expect(await db.claimNextJob('w', { allowedJobTypes: ['expert.r.v1'], leaseSeconds: 30 })).toBeNull();
    const job = (await db.query('SELECT status FROM jobs WHERE id = $1', [await jobIdOf(run.id)])).rows[0];
    expect(job.status).toBe('canceled');
    expect((await submit(ctx, 'req-sandbox-0009', { title: 'After close' })).data.code).toBe('SANDBOX_CLOSED');
  });

  it('refuses a sandbox whose input has no saved version, or that the person does not own', async () => {
    const ctx = await setup();
    const bare = await db.createProjectAnalysisObject(ctx.sponsor.user.id, ctx.project.id, { objectType: 'seurat', displayName: 'Unsaved' });
    const refused = await api(server, `${ctx.base}/agent-sandboxes`, {
      method: 'POST', token: ctx.sponsor.token, body: { name: 'x', analysisObjectIds: [bare.id] },
    });
    expect(refused.data.code).toBe('INPUT_NOT_APPLICABLE');
    const collaborator = await createUserWithToken({ email: 'collab2@example.com' });
    await db.addProjectMemberByEmail(ctx.project.id, collaborator.user.email, 'analyst', { userId: ctx.sponsor.user.id });
    const notMine = await api(server, `${ctx.base}/agent-sandboxes`, {
      method: 'POST', token: collaborator.token, body: { name: 'x', analysisObjectIds: [ctx.object.id] },
    });
    expect(notMine.status).toBe(404);
  });

  // A second sandbox with room for runs and a second agent with its own limits.
  async function setup2(ctx, limits) {
    const sandbox = await api(server, `${ctx.base}/agent-sandboxes`, {
      method: 'POST', token: ctx.sponsor.token, body: { name: 'Second', analysisObjectIds: [ctx.object.id], maxRuns: 5, maxOutstandingRuns: 5 },
    });
    const delegation = await api(server, `${ctx.base}/agent-delegations`, {
      method: 'POST', token: ctx.sponsor.token, body: { agentName: 'Busy', capabilities: CAPS, limits },
    });
    const token = delegation.data.credential.token;
    return {
      submit: (requestId) => api(server, `/api/automation/v1/projects/${ctx.project.id}/sandboxes/${sandbox.data.sandbox.id}/runs`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: { requestId, title: requestId, script: SCRIPT },
      }),
    };
  }

  async function setupSecondAgent(ctx, caps) {
    const delegation = await api(server, `${ctx.base}/agent-delegations`, {
      method: 'POST', token: ctx.sponsor.token, body: { agentName: 'Reader', capabilities: caps },
    });
    const token = delegation.data.credential.token;
    return (p, options = {}) => api(server, `/api/automation/v1/projects/${ctx.project.id}${p}`, {
      ...options, headers: { Authorization: `Bearer ${token}` },
    });
  }
});

describe.skipIf(!CONFIGURED)('agent reports', () => {
  it('drafts sections with sandbox figures, takes review feedback, and finalizes only when every section is approved', async () => {
    const ctx = await setup();
    const run = (await submit(ctx)).data.run;
    await completeSandboxJob(ctx, await jobIdOf(run.id), { 'umap.png': PNG, 'clusters.csv': 'cluster\n1\n' });

    const report = await ctx.agent('/reports', { method: 'POST', body: { requestId: 'req-report-0001', title: 'PBMC clustering' } });
    expect(report.status, JSON.stringify(report.data)).toBe(201);
    const reportId = report.data.report.id;
    const write = (requestId, body) => ctx.agent(`/reports/${reportId}/sections`, { method: 'POST', body: { requestId, ...body } });
    const methods = await write('req-section-0001', { key: 'methods', heading: 'Methods', body: 'Clustered with Seurat.' });
    expect(methods.status, JSON.stringify(methods.data)).toBe(201);
    const results = await write('req-section-0002', {
      key: 'results', heading: 'Results', body: 'Two clusters.',
      figures: [{ sandboxRunId: run.id, file: 'umap.png', caption: 'UMAP of clusters' }],
    });
    expect(results.data.section).toMatchObject({ position: 1, version: 1, status: 'awaiting_review',
      figures: [{ sandboxRunId: run.id, file: 'umap.png', scriptSha256: run.scriptSha256 }] });
    const badFigure = await write('req-section-0003', { key: 'extra', heading: 'Extra', body: 'x',
      figures: [{ sandboxRunId: run.id, file: 'nope.png' }] });
    expect(badFigure.status).toBe(404);

    const reviewUrl = `${ctx.base}/agent-reports/${reportId}/reviews`;
    await api(server, reviewUrl, { method: 'POST', token: ctx.sponsor.token,
      body: { sectionId: methods.data.section.id, decision: 'approved' } });
    const change = await api(server, reviewUrl, { method: 'POST', token: ctx.sponsor.token,
      body: { sectionId: results.data.section.id, decision: 'changes_requested', comment: 'Report cluster sizes.' } });
    expect(change.status).toBe(201);
    const blocked = await api(server, `${ctx.base}/agent-reports/${reportId}/finalize`, { method: 'POST', token: ctx.sponsor.token, body: {} });
    expect(blocked.data).toMatchObject({ code: 'REVIEW_INCOMPLETE', details: { sections: ['results'] } });

    // The agent sees the feedback and revises; the new version needs its own review.
    const seen = await ctx.agent(`/reports/${reportId}`);
    const resultsSection = seen.data.report.sections.find((s) => s.key === 'results');
    expect(resultsSection.reviews[0]).toMatchObject({ decision: 'changes_requested', comment: 'Report cluster sizes.' });
    const revised = await write('req-section-0004', { key: 'results', heading: 'Results', body: 'Two clusters of 10 and 12 cells.',
      figures: [{ sandboxRunId: run.id, file: 'umap.png', caption: 'UMAP of clusters' }] });
    expect(revised.data.section).toMatchObject({ version: 2, position: 1, status: 'awaiting_review' });
    await api(server, reviewUrl, { method: 'POST', token: ctx.sponsor.token, body: { sectionId: revised.data.section.id, decision: 'approved' } });
    const finalized = await api(server, `${ctx.base}/agent-reports/${reportId}/finalize`, { method: 'POST', token: ctx.sponsor.token, body: {} });
    expect(finalized.status, JSON.stringify(finalized.data)).toBe(200);
    expect(finalized.data.report.status).toBe('finalized');
    expect((await write('req-section-0005', { key: 'discussion', heading: 'Discussion', body: 'x' })).data.code).toBe('REPORT_FINALIZED');

    const exported = await api(server, `${ctx.base}/agent-reports/${reportId}/export`, { token: ctx.sponsor.token });
    const markdown = exported.data;
    expect(markdown).toContain('# PBMC clustering');
    expect(markdown).toContain('## Results\n\nTwo clusters of 10 and 12 cells.');
    expect(markdown).toContain(`![UMAP of clusters](figures/${run.id}/umap.png)`);
    expect(markdown.indexOf('## Methods')).toBeLessThan(markdown.indexOf('## Results'));
  });

  it('keeps report history append-only in the database', async () => {
    const ctx = await setup();
    const report = await ctx.agent('/reports', { method: 'POST', body: { requestId: 'req-report-0002', title: 'T' } });
    await ctx.agent(`/reports/${report.data.report.id}/sections`, { method: 'POST',
      body: { requestId: 'req-section-0010', key: 'intro', heading: 'Intro', body: 'Hello' } });
    await expect(db.query("UPDATE agent_report_sections SET body_markdown = 'changed'")).rejects.toMatchObject({ code: '55000' });
    await expect(db.query('DELETE FROM agent_reports')).rejects.toMatchObject({ code: '55000' });
  });
});
