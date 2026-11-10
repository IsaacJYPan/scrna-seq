/**
 * Slurm execution target (docs/spec.md phase 3), against a fake Slurm whose
 * sbatch/sacct/squeue/scancel/sinfo are shell scripts on PATH and whose
 * "cluster filesystem" is a local directory (SLURM_TRANSPORT=local). The real
 * job worker, Seurat handler, storage provider, and database are used.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const dbmod = require('./pgDatabase');
const storage = require('./storage');
const { installFakeSlurm } = require('./_fakeSlurm');
const { createJobWorker, createLanedJobWorker, slurmLaneCount } = require('./jobWorker');
const { createSlurmExecutor, slurmConfig, wallTime } = require('./executors/slurm');
const { silentLogger } = require('./_test-helpers');

const CONFIGURED = config.hasPostgresConnection();

let fake;
let storageRoot;
let provider;

beforeAll(() => { if (CONFIGURED) process.env.DISABLE_RATE_LIMIT = 'true'; });
afterAll(async () => { if (CONFIGURED) await dbmod.close(); });
beforeEach(async () => {
  if (!CONFIGURED) return;
  await dbmod.resetSchemaForTests();
  fake = installFakeSlurm();
  delete process.env.FAKE_SLURM_MODE;
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slurm-storage-'));
  provider = storage.createLocalStorageProvider({ root: storageRoot });
});
afterEach(() => {
  if (!CONFIGURED) return;
  fake.restore();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

async function seedSlurmJob({ executionTarget = 'slurm' } = {}) {
  const alice = await dbmod.createUser('alice@example.com', 'password123', 'Alice');
  const org = await dbmod.createOrganizationForUser(alice.id, { name: 'Org' });
  const proj = await dbmod.createProjectForUser(alice.id, { organizationId: org.id, name: 'Project' });
  const ds = await dbmod.createDatasetForProject(alice.id, proj.id, { fileType: 'tenx_h5', originalFilename: 'pbmc.h5' });
  const key = storage.projectStorageFileKey(proj.id, 'datasets', ds.id, 'pbmc.h5');
  fs.mkdirSync(path.dirname(provider.resolveKey(key)), { recursive: true });
  fs.writeFileSync(provider.resolveKey(key), 'fake-h5-bytes');
  const uploaded = await dbmod.markDatasetUploaded(proj.id, ds.id, { internalStorageKey: key, sha256: 'b'.repeat(64), fileSizeBytes: 13 });
  const input = await dbmod.createProjectAnalysisObject(alice.id, proj.id, {
    objectType: 'matrix', datasetId: uploaded.id, displayName: 'Raw', metadata: { source: 'dataset' },
  });
  const job = await dbmod.createProjectJob(alice.id, proj.id, {
    jobType: 'seurat.pipeline.v1', datasetId: uploaded.id, analysisObjectId: input.id,
    parameters: { clusterResolution: 0.5 }, executionTarget,
  });
  return { alice, proj, dataset: uploaded, input, job };
}

function drain() {
  return createJobWorker({ db: dbmod, logger: silentLogger(), storageProvider: provider,
    slurmExecutor: createSlurmExecutor({ db: dbmod }) }).runOnce();
}

describe.skipIf(!CONFIGURED)('Slurm target through the real worker', () => {
  it('stages, submits, polls, collects a verified checkpoint, and records the result', async () => {
    const { proj, job } = await seedSlurmJob();
    expect(job.executionTarget).toBe('slurm');
    await drain();
    const done = await dbmod.getProjectJob((await dbmod.query('SELECT owner_user_id FROM jobs')).rows[0].owner_user_id, proj.id, job.id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(done.resultAnalysisObjectId).toBeTruthy();
    expect(fake.sbatchCalls()).toHaveLength(1);

    const runDir = path.join(fake.remote, job.id);
    const script = fs.readFileSync(path.join(runDir, 'job.sh'), 'utf8');
    expect(script).toContain(`#SBATCH --job-name=tro-${job.id}`);
    expect(script).toContain('#SBATCH --partition=normal');
    expect(script).toContain('#SBATCH --account=lab01');
    expect(script).toContain('#SBATCH --mem=8192M');
    expect(script).toMatch(/exec Rscript .*hpc-runner\.R /);
    expect(fs.readFileSync(path.join(runDir, 'lib', 'seuratPipelineCore.R'), 'utf8')).toContain('run_seurat_pipeline_core');
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'params.json'), 'utf8')).clusterResolution).toBe(0.5);

    const artifact = (await dbmod.query("SELECT * FROM job_artifacts WHERE job_id = $1 AND artifact_type = 'checkpoint'", [job.id])).rows[0];
    const local = provider.resolveKey(artifact.storage_uri);
    expect(crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex')).toBe(artifact.checksum_sha256);
    const dispatch = (await dbmod.query('SELECT * FROM hpc_dispatches WHERE job_id = $1', [job.id])).rows[0];
    expect(dispatch).toMatchObject({ state: 'collected', target: 'slurm' });
    const logs = (await dbmod.query('SELECT logs_json FROM jobs WHERE id = $1', [job.id])).rows[0].logs_json;
    expect(logs).toMatch(/Submitted Slurm job \d+/);
  });

  it('fails the job with the Slurm state and output tail when the cluster job fails', async () => {
    process.env.FAKE_SLURM_MODE = 'fail';
    const { job } = await seedSlurmJob();
    await drain();
    const row = (await dbmod.query('SELECT status, error_json, logs_json FROM jobs WHERE id = $1', [job.id])).rows[0];
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.error_json).code).toBe('SLURM_JOB_FAILED');
    expect(row.logs_json).toContain('boom');
  });

  it('re-attaches to an already submitted job instead of submitting again', async () => {
    const { job } = await seedSlurmJob();
    const executor = createSlurmExecutor({ db: dbmod });
    // Simulate a crash after sbatch succeeded but before its id was recorded.
    const runDir = path.join(fake.remote, job.id);
    fs.mkdirSync(path.join(runDir, 'output'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'job.sh'), `#SBATCH --job-name=tro-${job.id}\n`);
    require('child_process').execFileSync('sbatch', ['--parsable', path.join(runDir, 'job.sh')], { env: process.env });
    await dbmod.query("INSERT INTO hpc_dispatches (job_id, target, remote_dir, state) VALUES ($1, 'slurm', $2, 'submitting')", [job.id, runDir]);
    await createJobWorker({ db: dbmod, logger: silentLogger(), storageProvider: provider, slurmExecutor: executor }).runOnce();
    expect(fake.sbatchCalls()).toHaveLength(1);
    expect((await dbmod.query('SELECT status FROM jobs WHERE id = $1', [job.id])).rows[0].status).toBe('completed');
  });

  it('rejects a checkpoint whose bytes do not match the recorded checksum', async () => {
    process.env.FAKE_SLURM_MODE = 'badsum';
    const { job } = await seedSlurmJob();
    await drain();
    const row = (await dbmod.query('SELECT status, error_json FROM jobs WHERE id = $1', [job.id])).rows[0];
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.error_json).code).toBe('CHECKPOINT_INTEGRITY_FAILED');
  });
});

describe.skipIf(!CONFIGURED)('Slurm executor', () => {
  it('sends scancel when cancellation is requested while the job runs', async () => {
    process.env.FAKE_SLURM_MODE = 'hold';
    const { job } = await seedSlurmJob();
    const executor = createSlurmExecutor({ db: dbmod });
    let polls = 0;
    const out = path.join(storageRoot, 'out.rds');
    await expect(executor.runSeurat({
      jobId: job.id, params: {}, inputs: [{ localPath: provider.resolveKey((await dbmod.query('SELECT internal_storage_key FROM datasets')).rows[0].internal_storage_key) }],
      resources: { cpus: 2, memoryMiB: 4096, maxWallSeconds: 600 }, checkpointPath: out,
      heartbeat: async () => {}, log: async () => {}, isCanceled: async () => (polls += 1) > 1,
    })).rejects.toMatchObject({ code: 'JOB_CANCELED' });
    expect(fake.scancels()).toHaveLength(1);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('cancels the cluster job when the worker loses its claim', async () => {
    process.env.FAKE_SLURM_MODE = 'hold';
    const { job } = await seedSlurmJob();
    const executor = createSlurmExecutor({ db: dbmod });
    let beats = 0;
    await expect(executor.runSeurat({
      jobId: job.id, params: {}, inputs: [{ localPath: provider.resolveKey((await dbmod.query('SELECT internal_storage_key FROM datasets')).rows[0].internal_storage_key) }],
      resources: { cpus: 1, memoryMiB: 1024, maxWallSeconds: 60 }, checkpointPath: path.join(storageRoot, 'x.rds'),
      heartbeat: async () => { beats += 1; if (beats > 1) throw Object.assign(new Error('claim lost'), { code: 'CLAIM_LOST' }); },
      log: async () => {}, isCanceled: async () => false,
    })).rejects.toMatchObject({ code: 'CLAIM_LOST' });
    expect(fake.scancels()).toHaveLength(1);
  });

  it('reports cluster status and rejects unsafe configuration', async () => {
    const status = await createSlurmExecutor({ db: dbmod }).status();
    expect(status).toMatchObject({ configured: true, available: true, partition: 'normal' });
    expect(status.partitions.map((p) => p.name)).toEqual(['normal', 'gpu']);
    expect(slurmConfig({ ...process.env, SLURM_PARTITION: 'normal; rm -rf /' }).enabled).toBe(false);
    expect(slurmConfig({ ...process.env, SLURM_RSCRIPT: 'Rscript $(id)' }).enabled).toBe(false);
    expect(slurmConfig({ SLURM_SSH_TARGET: 'user@login.example.edu', SLURM_REMOTE_ROOT: 'relative/path' }).enabled).toBe(false);
    expect(slurmConfig({ SLURM_SSH_TARGET: 'user@login.example.edu', SLURM_REMOTE_ROOT: '/scratch/u/tro' }).enabled).toBe(true);
    expect(wallTime(3600)).toBe('01:00:00');
    expect(wallTime(2 * 86400 + 61)).toBe('2-00:01:01');
  });

  it('refuses Slurm for unsupported jobs and when the target is not configured', async () => {
    const { alice, proj, input } = await seedSlurmJob({ executionTarget: 'local' });
    await expect(dbmod.createProjectJob(alice.id, proj.id, {
      jobType: 'checkpoint.save.v1', analysisObjectId: input.id, executionTarget: 'slurm',
    })).rejects.toMatchObject({ code: 'INVALID_PARAMETERS' });
    delete process.env.SLURM_REMOTE_ROOT;
    await expect(dbmod.createProjectJob(alice.id, proj.id, {
      jobType: 'seurat.pipeline.v1', datasetId: input.datasetId, analysisObjectId: input.id, executionTarget: 'slurm',
    })).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
  });
});

describe.skipIf(!CONFIGURED)('Slurm execution lane', () => {
  it('a running local job does not block Slurm jobs, and lanes only claim their own target', async () => {
    const { alice, proj, input, job: slurmJob } = await seedSlurmJob();
    const localJob = await dbmod.createProjectJob(alice.id, proj.id, {
      jobType: 'seurat.pipeline.v1', datasetId: input.datasetId, analysisObjectId: input.id, executionTarget: 'local',
    });
    const local = await dbmod.claimNextJob('w_local', { leaseSeconds: 60, executionTargets: ['local'] });
    expect(local.id).toBe(localJob.id);
    // The local slot is full, but that does not stop the Slurm lane.
    expect(await dbmod.claimNextJob('w_local2', { leaseSeconds: 60, executionTargets: ['local'] })).toBeNull();
    const remote = await dbmod.claimNextJob('w_slurm', { leaseSeconds: 60, executionTargets: ['slurm'] });
    expect(remote.id).toBe(slurmJob.id);
    // A running Slurm job does not hold the local slot either.
    expect(await dbmod.claimNextJob('w_slurm2', { leaseSeconds: 60, executionTargets: ['slurm'], maxConcurrentClaims: 1 })).toBeNull();
    await expect(dbmod.claimNextJob('w_bad', { executionTargets: ['gpu'] })).rejects.toMatchObject({ code: 'INVALID_WORKER_CAPABILITIES' });
  });

  it('starts Slurm worker loops only when the target is configured', () => {
    const created = [];
    const fakeCreate = (o) => { created.push(o); return { workerId: o.workerId || 'w_main', leaseSeconds: 30, runOnce: async () => ({}), start() {}, stop: async () => {}, isRunning: () => false }; };
    const laned = createLanedJobWorker({ db: dbmod }, { env: { ...process.env, SLURM_MAX_RUNNING: '2' }, create: fakeCreate });
    expect(created.map((o) => o.executionTargets)).toEqual([['local'], ['slurm'], ['slurm']]);
    expect(created[1]).toMatchObject({ workerId: 'w_main-slurm-1', maxConcurrentClaims: 2 });
    expect(laned.slurmWorkers).toHaveLength(2);
    created.length = 0;
    createLanedJobWorker({ db: dbmod }, { env: { PATH: process.env.PATH }, create: fakeCreate });
    expect(created).toHaveLength(1);
    expect(created[0].executionTargets).toBeUndefined();
    expect(slurmLaneCount({ ...process.env, SLURM_MAX_RUNNING: '0' })).toBe(0);
  });
});
