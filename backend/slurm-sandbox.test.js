/**
 * Agent sandbox runs on the Slurm target, and target qualification.
 *
 * A fake Slurm runs each job script for real (FAKE_SLURM_MODE=exec), and a
 * stand-in for the sandbox container command plays the R process. The real
 * server, worker, Expert R handler, storage, and database are used.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const db = require('./pgDatabase');
const storage = require('./storage');
const { installFakeSlurm } = require('./_fakeSlurm');
const { createJobWorker } = require('./jobWorker');
const { createSlurmExecutor } = require('./executors/slurm');
const { qualifySlurmTarget, sandboxReadiness } = require('./executors/slurmQualification');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();
const CAPS = ['metadata.read', 'results.read', 'development.executeCandidate'];
const silentLogger = () => ({ info() {}, warn() {}, error() {} });
const provider = storage.createLocalStorageProvider();
const saved = {};
let server;
let fake;

beforeAll(async () => {
  if (!CONFIGURED) return;
  for (const key of ['DISABLE_RATE_LIMIT', 'EXPERT_R_ACCESS_POLICY', 'COMPUTE_TARGET_STATUS_TTL_MS']) saved[key] = process.env[key];
  process.env.DISABLE_RATE_LIMIT = 'true';
  process.env.COMPUTE_TARGET_STATUS_TTL_MS = '1';
  delete process.env.EXPERT_R_ACCESS_POLICY;
  server = await startServer();
});
afterAll(async () => {
  if (!CONFIGURED) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.close();
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
beforeEach(async () => {
  if (!CONFIGURED) return;
  await db.resetSchemaForTests();
  fake = installFakeSlurm();
  process.env.FAKE_SLURM_MODE = 'exec';
  process.env.SLURM_SANDBOX_EXEC = path.join(fake.base, 'bin', 'fake-sandbox');
  process.env.SLURM_SANDBOX_IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
  delete process.env.FAKE_PROBE_JSON;
});
afterEach(() => {
  if (!CONFIGURED) return;
  fake.restore();
  for (const key of ['FAKE_SLURM_MODE', 'SLURM_SANDBOX_EXEC', 'SLURM_SANDBOX_IMAGE_DIGEST', 'FAKE_PROBE_JSON']) delete process.env[key];
});

const qualify = () => qualifySlurmTarget({ db, executor: createSlurmExecutor({ db }), pollMs: 10, timeoutMs: 5000 });

async function setup() {
  const sponsor = await createUserWithToken({ email: 'hpc-sponsor@example.com', displayName: 'Sponsor' });
  const org = await db.createOrganizationForUser(sponsor.user.id, { name: 'Lab' });
  const project = await db.createProjectForUser(sponsor.user.id, { organizationId: org.id, name: 'Atlas' });
  const object = await db.createProjectAnalysisObject(sponsor.user.id, project.id, { objectType: 'seurat', displayName: 'Atlas' });
  // A real checkpoint file: it is copied to the cluster.
  const job = await db.createProjectJob(sponsor.user.id, project.id, { jobType: 'generic', analysisObjectId: object.id });
  const claim = await db.claimNextJob('seed', { allowedJobTypes: ['generic'], leaseSeconds: 30 });
  const key = `projects/${project.id}/checkpoints/${job.id}/checkpoint.rds`;
  const bytes = Buffer.from('checkpoint-bytes');
  fs.mkdirSync(path.dirname(provider.resolveKey(key)), { recursive: true });
  fs.writeFileSync(provider.resolveKey(key), bytes);
  await db.createCheckpointArtifactForJobByWorker(job.id, 'seed', claim.claimToken, {
    artifactType: 'checkpoint', resultAnalysisObjectId: object.id, internalStorageKey: key,
    checksumSha256: crypto.createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length,
  });
  await db.completeJobByWorker(job.id, 'seed', claim.claimToken);
  await db.setExpertRExecutorByEmail(sponsor.user.email, true);
  const base = `/api/projects/${project.id}`;
  const delegation = await api(server, `${base}/agent-delegations`, {
    method: 'POST', token: sponsor.token, body: { agentName: 'HPC agent', capabilities: CAPS, limits: { maxReservedCpuSeconds: 1000000 } },
  });
  const token = delegation.data.credential.token;
  const agent = (p, options = {}) => api(server, `/api/automation/v1/projects/${project.id}${p}`, {
    ...options, headers: { Authorization: `Bearer ${token}` },
  });
  const createSandbox = (body = {}) => api(server, `${base}/agent-sandboxes`, {
    method: 'POST', token: sponsor.token,
    body: { name: 'Cluster sandbox', analysisObjectIds: [object.id], executionTarget: 'slurm', cpusPerRun: 4, memoryGiBPerRun: 16, hoursPerRun: 2, ...body },
  });
  return { sponsor, project, object, base, agent, createSandbox };
}

function drain() {
  return createJobWorker({ db, logger: silentLogger(), storageProvider: provider, slurmExecutor: createSlurmExecutor({ db }) }).runOnce();
}

describe.skipIf(!CONFIGURED)('Slurm qualification', () => {
  it('passes on a target that isolates the sandbox, and records the evidence', async () => {
    const result = await qualify();
    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(fake.scancels()).toHaveLength(1);
    const readiness = await sandboxReadiness(db, createSlurmExecutor({ db }).config);
    expect(readiness).toMatchObject({ ready: true });
    // Probe files are removed from the cluster afterwards.
    expect(fs.readdirSync(fake.remote).filter((d) => d.startsWith('qualify-'))).toEqual([]);
  });

  it('fails when the sandbox can reach the network or submit jobs, and blocks cluster sandboxes', async () => {
    process.env.FAKE_PROBE_JSON = JSON.stringify({ network_blocked: false, submission_blocked: false, credentials_hidden: true, input_read_only: true, cpus_visible: 2 });
    const result = await qualify();
    expect(result.passed).toBe(false);
    expect(result.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual(['no-network', 'no-job-submission']);
    const ctx = await setup();
    const refused = await ctx.createSandbox();
    expect(refused.status).toBe(409);
    expect(refused.data).toMatchObject({ code: 'TARGET_UNQUALIFIED', error: 'The last qualification did not pass.' });
  });

  it('needs a new qualification when the container command changes', async () => {
    await qualify();
    process.env.SLURM_SANDBOX_EXEC = `${process.env.SLURM_SANDBOX_EXEC} --extra`;
    const readiness = await sandboxReadiness(db, createSlurmExecutor({ db }).config);
    expect(readiness).toMatchObject({ ready: false, reason: expect.stringMatching(/settings changed/) });
  });

  it('reports qualification with the compute targets', async () => {
    const directory = require('./executors/targets').createTargetDirectory({ db, ttlMs: 0 });
    const slurmTarget = async () => (await directory.list()).targets.find((t) => t.name === 'slurm');
    expect((await slurmTarget()).sandbox).toMatchObject({ ready: false, reason: expect.stringMatching(/not been qualified/) });
    await qualify();
    expect((await slurmTarget()).sandbox).toMatchObject({ ready: true, checks: expect.any(Array) });
  });
});

describe.skipIf(!CONFIGURED)('agent sandbox runs on Slurm', () => {
  it('runs the agent script on the cluster with the sandbox reservation and returns validated draft outputs', async () => {
    await qualify();
    const ctx = await setup();
    const created = await ctx.createSandbox();
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    expect(created.data.sandbox).toMatchObject({ executionTarget: 'slurm', perRun: { cpus: 4, memoryMiB: 16384, maxWallSeconds: 7200 }, cpuSecondsPerRun: 28800 });
    const submitted = await ctx.agent(`/sandboxes/${created.data.sandbox.id}/runs`, {
      method: 'POST', body: { requestId: 'req-hpc-00001', title: 'Clusters', script: '# ---- Count ----\nwrite_table(table(obj$seurat_clusters), "clusters.csv")\n' },
    });
    expect(submitted.status, JSON.stringify(submitted.data)).toBe(201);
    const job = (await db.query('SELECT execution_target, parameters_json FROM jobs WHERE id = (SELECT job_id FROM agent_sandbox_runs WHERE id = $1)', [submitted.data.run.id])).rows[0];
    expect(job.execution_target).toBe('slurm');
    expect(JSON.parse(job.parameters_json).environment).toBeUndefined();

    await drain();
    const run = (await ctx.agent(`/sandbox-runs/${submitted.data.run.id}`)).data.run;
    expect(run.state, JSON.stringify(run)).toBe('draft_ready');
    expect(run.files.map((f) => f.name).sort()).toEqual(['clusters.csv', 'umap.png']);
    expect(run.console.join('\n')).toContain('Running the agent script');
    const table = await ctx.agent(`/sandbox-runs/${run.id}/files/clusters.csv`);
    expect(table.data.text).toBe('cluster,n\n0,40\n1,80\n');
    const jobDir = fs.readdirSync(fake.remote).find((d) => d.startsWith('job_'));
    const script = fs.readFileSync(path.join(fake.remote, jobDir, 'job.sh'), 'utf8');
    expect(script).toContain('#SBATCH --cpus-per-task=4');
    expect(script).toContain('#SBATCH --mem=16384M');
    expect(script).toContain('#SBATCH --time=02:00:00');
    expect(script).toContain('fake-sandbox Rscript --vanilla');
    const result = await db.query("SELECT metadata_json FROM analysis_objects WHERE id = $1", [run.resultAnalysisObjectId]);
    expect(JSON.parse(result.rows[0].metadata_json)).toMatchObject({ resourcePolicyVersion: 'slurm-sandbox-policy.v1', sandboxImageDigest: `sha256:${'d'.repeat(64)}` });
  });

  it('records a failing script with the R console tail', async () => {
    await qualify();
    const ctx = await setup();
    const created = await ctx.createSandbox();
    const submitted = await ctx.agent(`/sandboxes/${created.data.sandbox.id}/runs`, {
      method: 'POST', body: { requestId: 'req-hpc-00002', title: 'Broken', script: 'stop("nope")\n' },
    });
    await drain();
    const run = (await ctx.agent(`/sandbox-runs/${submitted.data.run.id}`)).data.run;
    expect(run.state).toBe('failed');
    expect(run.console.join('\n')).toContain('boom');
  });

  it('rejects outputs with links or too many files', async () => {
    await qualify();
    const ctx = await setup();
    const created = await ctx.createSandbox();
    const submitted = await ctx.agent(`/sandboxes/${created.data.sandbox.id}/runs`, {
      method: 'POST', body: { requestId: 'req-hpc-00003', title: 'Link', script: 'x <- 1\n' },
    });
    // Replace the stand-in so this run leaves a symlink in its outputs.
    fs.writeFileSync(process.env.SLURM_SANDBOX_EXEC, '#!/bin/bash\nln -s /etc/passwd "$4/output/passwd.txt"\n', { mode: 0o755 });
    await drain();
    const run = (await ctx.agent(`/sandbox-runs/${submitted.data.run.id}`)).data.run;
    expect(run.state).toBe('failed');
    expect(run.files).toEqual([]);
  });
});
