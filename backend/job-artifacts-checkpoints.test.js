import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbmod = require('./database');
const {
  initDatabase, closeDatabase, createUser,
  createOrganizationForUser, createProjectForUser, addProjectMemberByEmail,
  createJobForUser, createProjectJob, createProjectAnalysisObject, createDatasetForProject,
  getJobForUser, getProjectJob, getProjectAnalysisObject,
  verifyAnalysisObjectOwner,
  // worker coordination contract used to drive helpers directly
  claimNextJob,
  // artifact / checkpoint helpers under test
  createJobArtifactByWorker, createCheckpointForJobByWorker,
  listProjectArtifacts,
} = dbmod;

const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const { createJobWorker } = require('./jobWorker');

// Deterministic UTC instants in SQLite's canonical 'YYYY-MM-DD HH:MM:SS' format.
const T0 = '2030-01-01 00:00:00';

function silentLogger() { return { info() {}, warn() {}, error() {} }; }

// Run the worker once over whatever is queued, with a deterministic clock.
async function drainOnce(now = T0) {
  const w = createJobWorker({ db: dbmod, now: () => now, logger: silentLogger() });
  return w.runOnce();
}

// Claim a single queued job directly (server-tier) so we can call the worker-facing
// artifact/checkpoint helpers with a real (worker_id, claim_token).
function claim(workerId = 'worker_t', now = T0) {
  return claimNextJob(workerId, { now, leaseSeconds: 30 });
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Schema / migration (idempotent, additive)
// ════════════════════════════════════════════════════════════════════════════
describe('job artifacts — schema & migration', () => {
  function tmpDbPath() {
    return path.join(os.tmpdir(), `job_artifacts_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}.sqlite`);
  }
  function rmDb(p) {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(p + s); } catch { /* best-effort */ } }
  }

  const EXPECTED_COLUMNS = [
    'id', 'project_id', 'job_id', 'dataset_id', 'analysis_object_id', 'result_analysis_object_id',
    'provenance_id', 'figure_id', 'created_by_user_id', 'artifact_type', 'name', 'description',
    'mime_type', 'storage_kind', 'storage_uri', 'checksum_sha256', 'size_bytes', 'status',
    'metadata_json', 'created_at', 'updated_at'
  ];
  const EXPECTED_INDEXES = [
    'idx_job_artifacts_project', 'idx_job_artifacts_job', 'idx_job_artifacts_dataset',
    'idx_job_artifacts_analysis_object', 'idx_job_artifacts_result_object',
    'idx_job_artifacts_provenance', 'idx_job_artifacts_figure', 'idx_job_artifacts_type',
    'idx_job_artifacts_status', 'idx_job_artifacts_project_job', 'idx_job_artifacts_created'
  ];

  afterEach(() => { try { closeDatabase(); } catch { /* ignore */ } });

  it('creates the job_artifacts table with all columns on a fresh database', () => {
    initDatabase(':memory:');
    const cols = dbmod.getTableColumns('job_artifacts');
    for (const c of EXPECTED_COLUMNS) expect(cols, `column ${c}`).toContain(c);
  });

  it('creates all job_artifacts indexes on a fresh database', () => {
    initDatabase(':memory:');
    const idx = dbmod.getTableIndexes('job_artifacts');
    for (const i of EXPECTED_INDEXES) expect(idx, `index ${i}`).toContain(i);
  });

  it('migration is idempotent and additive on a pre-existing DB lacking job_artifacts', () => {
    const p = tmpDbPath();
    try {
      // Build a full, current-schema DB, then DROP job_artifacts to simulate a DB
      // created BEFORE this branch (everything else present, artifacts table absent).
      initDatabase(p);
      closeDatabase();
      const pre = new Database(p);
      pre.exec('DROP TABLE job_artifacts');
      expect(pre.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='job_artifacts'").get()).toBeUndefined();
      pre.close();

      // Re-init: recreates job_artifacts additively, leaving every other table intact.
      initDatabase(p);
      for (const c of EXPECTED_COLUMNS) expect(dbmod.getTableColumns('job_artifacts')).toContain(c);
      for (const i of EXPECTED_INDEXES) expect(dbmod.getTableIndexes('job_artifacts')).toContain(i);
      // The pre-existing jobs table is still there and usable.
      expect(dbmod.getTableColumns('jobs')).toContain('worker_id');
      closeDatabase();

      // Second re-init on the same file: a pure no-op (CREATE TABLE IF NOT EXISTS).
      initDatabase(p);
      for (const c of EXPECTED_COLUMNS) expect(dbmod.getTableColumns('job_artifacts')).toContain(c);
      for (const i of EXPECTED_INDEXES) expect(dbmod.getTableIndexes('job_artifacts')).toContain(i);
      closeDatabase();
    } finally {
      rmDb(p);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Artifact / checkpoint helpers (direct DB tier)
// ════════════════════════════════════════════════════════════════════════════
describe('job artifacts — worker-facing create helper', () => {
  let alice;
  beforeEach(() => {
    initDatabase(':memory:');
    alice = createUser('alice@example.com', 'password123', 'Alice');
  });
  afterEach(() => closeDatabase());

  function seedProject(ownerId, name = 'P') {
    const org = createOrganizationForUser(ownerId, { name: 'Acme' });
    return createProjectForUser(ownerId, { organizationId: org.id, name });
  }

  it('generates server-side art_ ids and ignores client-supplied identity/storage fields', () => {
    const proj = seedProject(alice.id);
    const job = createProjectJob(alice.id, proj.id, { jobType: 'checkpoint.noop' });
    const claimed = claim();
    const art = createJobArtifactByWorker(claimed.id, 'worker_t', claimed.claimToken, {
      artifactType: 'metrics',
      // Hostile/ignored fields — none of these may take effect:
      id: 'art_hacked',
      projectId: 'proj_evil',
      createdByUserId: 99999,
      storageUri: '/etc/passwd',
      path: '../../secret',
      internalStorageKey: 'vault/secret.rds',
      checksumSha256: 'deadbeef',
      sizeBytes: 123456,
    }, { now: T0 });

    expect(art.id).toMatch(/^art_[0-9a-f]+$/);
    expect(art.id).not.toBe('art_hacked');
    expect(art.projectId).toBe(proj.id);          // derived from the job, not the input
    expect(art.createdByUserId).toBe(alice.id);   // job owner, not the input
    expect(art.storageUri).toBeNull();            // server/worker-set only (none here)
    expect(art.checksumSha256).toBeNull();
    expect(art.sizeBytes).toBeNull();
    expect(art.storageKind).toBe('metadata_only');
    expect(art.status).toBe('available');
    expect(art.jobId).toBe(job.id);
  });

  it('rejects invalid artifactType / storageKind / status via the allowlists', () => {
    seedProject(alice.id);
    const proj2 = seedProject(alice.id, 'P2'); // ensure a project context for the job
    const job = createProjectJob(alice.id, proj2.id, { jobType: 'checkpoint.noop' });
    const c = claim();
    const base = { artifactType: 'metrics' };
    expect(() => createJobArtifactByWorker(c.id, 'worker_t', c.claimToken, { ...base, artifactType: 'totally_invalid' }, { now: T0 }))
      .toThrowError(/Invalid artifactType/);
    expect(() => createJobArtifactByWorker(c.id, 'worker_t', c.claimToken, { ...base, storageKind: 'object_storage' }, { now: T0 }))
      .toThrowError(/Invalid storageKind/);
    expect(() => createJobArtifactByWorker(c.id, 'worker_t', c.claimToken, { ...base, status: 'totally_invalid' }, { now: T0 }))
      .toThrowError(/Invalid status/);
    // object_storage is intentionally NOT accepted in this branch (no object storage).
    expect(job).toBeTruthy();
  });

  it('only the claim-holding worker can create an artifact (CLAIM_LOST otherwise)', () => {
    const proj = seedProject(alice.id);
    createProjectJob(alice.id, proj.id, { jobType: 'checkpoint.noop' });
    const c = claim('worker_a');
    // A different worker with a bogus token cannot write.
    expect(() => createJobArtifactByWorker(c.id, 'worker_b', 'wct_bogus', { artifactType: 'metrics' }, { now: T0 }))
      .toThrowError(/no longer holds a valid claim/);
    // The real holder can.
    const art = createJobArtifactByWorker(c.id, 'worker_a', c.claimToken, { artifactType: 'metrics' }, { now: T0 });
    expect(art.id).toMatch(/^art_/);
  });

  it('cannot reference another project\'s dataset/object through a project A job', () => {
    const projA = seedProject(alice.id, 'A');
    const projB = seedProject(alice.id, 'B'); // Alice belongs to BOTH
    const aoB = createProjectAnalysisObject(alice.id, projB.id, { objectType: 'seurat' });
    const dsB = createDatasetForProject(alice.id, projB.id, { fileType: 'seurat_rds' });

    createProjectJob(alice.id, projA.id, { jobType: 'checkpoint.noop' });
    const c = claim();
    expect(() => createJobArtifactByWorker(c.id, 'worker_t', c.claimToken, { artifactType: 'metrics', analysisObjectId: aoB.id }, { now: T0 }))
      .toThrowError(/Analysis object not found/);
    expect(() => createJobArtifactByWorker(c.id, 'worker_t', c.claimToken, { artifactType: 'metrics', datasetId: dsB.id }, { now: T0 }))
      .toThrowError(/Dataset not found/);
  });

  it('a legacy owner-scoped job creates a NULL-project artifact', () => {
    createJobForUser(alice.id, { jobType: 'checkpoint.noop' });
    const c = claim();
    const art = createJobArtifactByWorker(c.id, 'worker_t', c.claimToken, { artifactType: 'log' }, { now: T0 });
    expect(art.projectId).toBeNull();
    expect(art.createdByUserId).toBe(alice.id);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Checkpoint / result-object helper
// ════════════════════════════════════════════════════════════════════════════
describe('job checkpoints — result analysis object', () => {
  let alice;
  beforeEach(() => {
    initDatabase(':memory:');
    alice = createUser('alice@example.com', 'password123', 'Alice');
  });
  afterEach(() => closeDatabase());

  function seedProject(ownerId, name = 'P') {
    const org = createOrganizationForUser(ownerId, { name: 'Acme' });
    return createProjectForUser(ownerId, { organizationId: org.id, name });
  }

  it('creates exactly one immutable result object in the job\'s project, linked back', () => {
    const proj = seedProject(alice.id);
    const parent = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const job = createProjectJob(alice.id, proj.id, { jobType: 'checkpoint.noop', analysisObjectId: parent.id });
    const c = claim();

    const cp = createCheckpointForJobByWorker(c.id, 'worker_t', c.claimToken, {
      objectType: 'generic', metadata: { placeholder: true }
    }, { now: T0 });

    expect(cp.id).toMatch(/^ao_[0-9a-f]+$/);
    expect(cp.projectId).toBe(proj.id);             // same project as the job
    expect(cp.ownerUserId).toBe(alice.id);
    expect(cp.parentObjectId).toBe(parent.id);      // child of the job's input object
    expect(cp.lineageRootId).toBe(parent.id);       // lineage stays in-project
    expect(cp.id).not.toBe(parent.id);              // a NEW object, not the parent

    // The job now links the checkpoint as its result object.
    const after = getJobForUser(job.id, alice.id);
    expect(after.resultAnalysisObjectId).toBe(cp.id);

    // The parent object is untouched (immutable through the worker path): there is
    // no analysis-object update helper, and the checkpoint is a separate row.
    const parentNow = getProjectAnalysisObject(alice.id, proj.id, parent.id);
    expect(parentNow.id).toBe(parent.id);
    expect(parentNow.parentObjectId).toBeNull();
  });

  it('refuses a second checkpoint for the same job (CHECKPOINT_EXISTS)', () => {
    const proj = seedProject(alice.id);
    createProjectJob(alice.id, proj.id, { jobType: 'checkpoint.noop' });
    const c = claim();
    createCheckpointForJobByWorker(c.id, 'worker_t', c.claimToken, {}, { now: T0 });
    expect(() => createCheckpointForJobByWorker(c.id, 'worker_t', c.claimToken, {}, { now: T0 }))
      .toThrowError(/already has a result checkpoint/);
  });

  it('two workers cannot both create a result object for the same job', () => {
    const proj = seedProject(alice.id);
    createProjectJob(alice.id, proj.id, { jobType: 'checkpoint.noop' });
    const c = claim('worker_a');
    // Worker B never held the claim → CLAIM_LOST, no object created.
    expect(() => createCheckpointForJobByWorker(c.id, 'worker_b', 'wct_bogus', {}, { now: T0 }))
      .toThrowError(/no longer holds a valid claim/);
    // Worker A succeeds exactly once.
    const cp = createCheckpointForJobByWorker(c.id, 'worker_a', c.claimToken, {}, { now: T0 });
    expect(cp.id).toMatch(/^ao_/);
  });

  it('a cross-project parent/dataset is rejected (404 codes), keeping lineage in-project', () => {
    const projA = seedProject(alice.id, 'A');
    const projB = seedProject(alice.id, 'B');
    const aoB = createProjectAnalysisObject(alice.id, projB.id, { objectType: 'seurat' });
    const dsB = createDatasetForProject(alice.id, projB.id, { fileType: 'seurat_rds' });
    createProjectJob(alice.id, projA.id, { jobType: 'checkpoint.noop' });
    const c = claim();
    expect(() => createCheckpointForJobByWorker(c.id, 'worker_t', c.claimToken, { parentObjectId: aoB.id }, { now: T0 }))
      .toThrowError(/Parent analysis object not found/);
    expect(() => createCheckpointForJobByWorker(c.id, 'worker_t', c.claimToken, { datasetId: dsB.id }, { now: T0 }))
      .toThrowError(/Dataset not found/);
  });

  it('a failed (unsupported) job creates no result object', async () => {
    const proj = seedProject(alice.id);
    const job = createProjectJob(alice.id, proj.id, { jobType: 'normalize' }); // unsupported handler
    const res = await drainOnce();
    expect(res.status).toBe('unsupported');
    const after = getProjectJob(alice.id, proj.id, job.id);
    expect(after.status).toBe('failed');
    expect(after.resultAnalysisObjectId).toBeNull();
    expect(listProjectArtifacts(alice.id, proj.id)).toHaveLength(0);
  });

  it('a canceled job creates no result object', async () => {
    const proj = seedProject(alice.id);
    const job = createProjectJob(alice.id, proj.id, { jobType: 'checkpoint.noop' });
    dbmod.cancelProjectJob(alice.id, proj.id, job.id); // queued → canceled
    const res = await drainOnce();
    expect(res.status).toBe('idle'); // canceled job is not claimable
    const after = getProjectJob(alice.id, proj.id, job.id);
    expect(after.status).toBe('canceled');
    expect(after.resultAnalysisObjectId).toBeNull();
    expect(listProjectArtifacts(alice.id, proj.id)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Worker integration (checkpoint.noop end-to-end through the contract)
// ════════════════════════════════════════════════════════════════════════════
describe('job worker — checkpoint.noop handler', () => {
  let alice;
  beforeEach(() => {
    initDatabase(':memory:');
    alice = createUser('alice@example.com', 'password123', 'Alice');
  });
  afterEach(() => closeDatabase());

  function seedProject(ownerId, name = 'P') {
    const org = createOrganizationForUser(ownerId, { name: 'Acme' });
    return createProjectForUser(ownerId, { organizationId: org.id, name });
  }

  it('completes the job and records a metadata-only checkpoint + artifact', async () => {
    const proj = seedProject(alice.id);
    const job = createProjectJob(alice.id, proj.id, { jobType: 'checkpoint.noop' });
    const res = await drainOnce();

    expect(res.status).toBe('completed');
    expect(res.jobId).toBe(job.id);
    expect(res.result.handled).toBe('checkpoint.noop');
    expect(res.result.placeholder).toBe(true);

    const after = getProjectJob(alice.id, proj.id, job.id);
    expect(after.status).toBe('completed');
    expect(after.resultAnalysisObjectId).toMatch(/^ao_/);

    const arts = listProjectArtifacts(alice.id, proj.id);
    expect(arts).toHaveLength(1);
    expect(arts[0].artifactType).toBe('checkpoint');
    expect(arts[0].storageKind).toBe('metadata_only');
    expect(arts[0].resultAnalysisObjectId).toBe(after.resultAnalysisObjectId);
    // Metadata-only: no storage uri exposed and no checksum/size fabricated.
    expect(Object.prototype.hasOwnProperty.call(arts[0], 'storageUri')).toBe(false);
    expect(arts[0].checksumSha256).toBeNull();
    expect(arts[0].sizeBytes).toBeNull();
  });

  it('writes durable logs for checkpoint + artifact creation', async () => {
    const proj = seedProject(alice.id);
    const job = createProjectJob(alice.id, proj.id, { jobType: 'checkpoint.noop' });
    await drainOnce();
    const after = getProjectJob(alice.id, proj.id, job.id);
    const messages = after.logs.map((l) => l.message).join('\n');
    expect(messages).toMatch(/checkpoint\.noop handler/i);
    expect(messages).toMatch(/recorded checkpoint/i);
  });

  it('leaves `generic` a pure noop (no artifacts, no checkpoint)', async () => {
    const proj = seedProject(alice.id);
    const job = createProjectJob(alice.id, proj.id, { jobType: 'generic' });
    const res = await drainOnce();
    expect(res.status).toBe('completed');
    const after = getProjectJob(alice.id, proj.id, job.id);
    expect(after.resultAnalysisObjectId).toBeNull();
    expect(listProjectArtifacts(alice.id, proj.id)).toHaveLength(0);
  });

  it('still fails unsupported job types terminally (UNSUPPORTED_JOB_TYPE)', async () => {
    const proj = seedProject(alice.id);
    const job = createProjectJob(alice.id, proj.id, { jobType: 'pca' });
    const res = await drainOnce();
    expect(res.status).toBe('unsupported');
    const after = getProjectJob(alice.id, proj.id, job.id);
    expect(after.status).toBe('failed');
    expect(after.error.code).toBe('UNSUPPORTED_JOB_TYPE');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Project artifact read routes (HTTP) — authorization & exposure
// ════════════════════════════════════════════════════════════════════════════
describe('project artifact routes — authorization & exposure', () => {
  let server;
  beforeAll(async () => { server = await startServer(); });
  afterAll(() => { if (server) server.close(); });
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  function seedProject(ownerUserId, name = 'P') {
    const org = createOrganizationForUser(ownerUserId, { name: 'Acme' });
    return createProjectForUser(ownerUserId, { organizationId: org.id, name });
  }
  // Create a completed checkpoint.noop job (with one artifact) in `projectId`.
  async function seedArtifact(projectId, ownerId) {
    const job = createProjectJob(ownerId, projectId, { jobType: 'checkpoint.noop' });
    await drainOnce();
    const arts = listProjectArtifacts(ownerId, projectId);
    return { job, artifact: arts[0] };
  }

  it('rejects unauthenticated access on every artifact route', async () => {
    const routes = [
      ['GET', '/api/projects/proj_x/artifacts'],
      ['GET', '/api/projects/proj_x/artifacts/art_abc'],
      ['GET', '/api/projects/proj_x/jobs/job_abc/artifacts'],
    ];
    for (const [method, p] of routes) {
      const res = await api(server, p, { method });
      expect(res.status, `${method} ${p}`).toBe(401);
    }
  });

  it('there is NO public artifact create/mutate route — a client cannot create an artifact', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const proj = seedProject(alice.user.id);
    // POST / PATCH / DELETE on the artifact collection/item are simply not defined
    // (artifact creation is worker/helper-driven). Whatever the unmatched-route
    // fallback returns, none of these may CREATE an artifact or echo a 201/art_ id.
    for (const [method, p] of [
      ['POST', `/api/projects/${proj.id}/artifacts`],
      ['POST', `/api/projects/${proj.id}/jobs/job_abc/artifacts`],
      ['PATCH', `/api/projects/${proj.id}/artifacts/art_abc`],
      ['DELETE', `/api/projects/${proj.id}/artifacts/art_abc`],
    ]) {
      const res = await api(server, p, {
        method, token: alice.token,
        body: ['POST', 'PATCH'].includes(method) ? { artifactType: 'metrics' } : undefined
      });
      expect(res.status, `${method} ${p}`).not.toBe(201);
      // No artifact object is ever returned by these.
      if (res.data && typeof res.data === 'object') {
        expect(typeof res.data.id === 'string' && res.data.id.startsWith('art_')).toBe(false);
      }
    }
    // And nothing was created.
    expect(listProjectArtifacts(alice.user.id, proj.id)).toHaveLength(0);
  });

  it('every project member role (incl. viewer) can read artifact metadata', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const viewer = createUserWithToken({ email: 'viewer@example.com' });
    const analyst = createUserWithToken({ email: 'analyst@example.com' });
    const proj = seedProject(alice.user.id);
    addProjectMemberByEmail(proj.id, 'viewer@example.com', 'viewer', 'owner');
    addProjectMemberByEmail(proj.id, 'analyst@example.com', 'analyst', 'owner');
    const { job, artifact } = await seedArtifact(proj.id, alice.user.id);

    for (const m of [alice, viewer, analyst]) {
      const list = await api(server, `/api/projects/${proj.id}/artifacts`, { token: m.token });
      expect(list.status).toBe(200);
      expect(list.data).toHaveLength(1);

      const byJob = await api(server, `/api/projects/${proj.id}/jobs/${job.id}/artifacts`, { token: m.token });
      expect(byJob.status).toBe(200);
      expect(byJob.data).toHaveLength(1);

      const one = await api(server, `/api/projects/${proj.id}/artifacts/${artifact.id}`, { token: m.token });
      expect(one.status).toBe(200);
      expect(one.data.id).toBe(artifact.id);
    }
  });

  it('a non-member receives 404 (no existence leak)', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const dave = createUserWithToken({ email: 'dave@example.com' });
    const proj = seedProject(alice.user.id);
    const { job, artifact } = await seedArtifact(proj.id, alice.user.id);

    expect((await api(server, `/api/projects/${proj.id}/artifacts`, { token: dave.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/artifacts/${artifact.id}`, { token: dave.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/jobs/${job.id}/artifacts`, { token: dave.token })).status).toBe(404);
  });

  it('malformed artifact/job ids return 400; well-formed-but-unknown return 404', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const proj = seedProject(alice.user.id);

    expect((await api(server, `/api/projects/${proj.id}/artifacts/not-an-id`, { token: alice.token })).status).toBe(400);
    expect((await api(server, `/api/projects/${proj.id}/jobs/not-a-job/artifacts`, { token: alice.token })).status).toBe(400);
    expect((await api(server, `/api/projects/${proj.id}/artifacts/art_deadbeef`, { token: alice.token })).status).toBe(404);
    // well-formed but non-existent (or cross-project) job → 404
    expect((await api(server, `/api/projects/${proj.id}/jobs/job_deadbeef/artifacts`, { token: alice.token })).status).toBe(404);
  });

  it('artifact responses never expose storage uri / raw path / storage key / claim token / worker internals', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const proj = seedProject(alice.user.id);
    const { artifact } = await seedArtifact(proj.id, alice.user.id);
    const one = await api(server, `/api/projects/${proj.id}/artifacts/${artifact.id}`, { token: alice.token });
    expect(one.status).toBe(200);
    const blob = JSON.stringify(one.data);
    for (const forbidden of ['storageUri', 'storage_uri', 'internalStorageKey', 'internal_storage_key',
      'claimToken', 'claim_token', 'workerId', 'worker_id', 'leaseExpiresAt', 'vault/', '/etc/']) {
      expect(blob, forbidden).not.toContain(forbidden);
    }
    // Safe metadata IS present.
    expect(one.data.id).toBe(artifact.id);
    expect(one.data.artifactType).toBe('checkpoint');
    expect(one.data.status).toBe('available');
    expect(one.data.projectId).toBe(proj.id);
    expect(one.data.jobId).toBe(artifact.jobId);
    expect(one.data.createdByUserId).toBe(alice.user.id);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Cross-project & legacy isolation (no leakage)
// ════════════════════════════════════════════════════════════════════════════
describe('project artifacts — cross-project & legacy isolation', () => {
  let server;
  beforeAll(async () => { server = await startServer(); });
  afterAll(() => { if (server) server.close(); });
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  function seedProject(ownerUserId, name = 'P') {
    const org = createOrganizationForUser(ownerUserId, { name: 'Acme' });
    return createProjectForUser(ownerUserId, { organizationId: org.id, name });
  }

  it('artifacts from project A do not appear in project B routes, even for a two-project member', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const projA = seedProject(alice.user.id, 'A');
    const projB = seedProject(alice.user.id, 'B');
    // Seed one checkpoint artifact in A.
    createProjectJob(alice.user.id, projA.id, { jobType: 'checkpoint.noop' });
    await drainOnce();
    const artA = listProjectArtifacts(alice.user.id, projA.id)[0];

    // Project B lists nothing, and cannot read A's artifact by id (404).
    const listB = await api(server, `/api/projects/${projB.id}/artifacts`, { token: alice.token });
    expect(listB.status).toBe(200);
    expect(listB.data).toHaveLength(0);
    expect((await api(server, `/api/projects/${projB.id}/artifacts/${artA.id}`, { token: alice.token })).status).toBe(404);
  });

  it('legacy NULL-project (owner-scoped job) artifacts never leak into project routes', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const proj = seedProject(alice.user.id);
    // A legacy owner-scoped job produces a NULL-project artifact.
    createJobForUser(alice.user.id, { jobType: 'checkpoint.noop' });
    await drainOnce();
    // Project listing stays empty (the legacy artifact has project_id = NULL).
    const list = await api(server, `/api/projects/${proj.id}/artifacts`, { token: alice.token });
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. R object/state ownership boundary (unchanged by checkpoints/artifacts)
// ════════════════════════════════════════════════════════════════════════════
describe('checkpoints/artifacts — R object/state ownership unchanged', () => {
  let server;
  beforeAll(async () => { server = await startServer(); });
  afterAll(() => { if (server) server.close(); });
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  function seedProject(ownerUserId, name = 'P') {
    const org = createOrganizationForUser(ownerUserId, { name: 'Acme' });
    return createProjectForUser(ownerUserId, { organizationId: org.id, name });
  }

  it('a co-member who can read a checkpoint result object still cannot use it via /api/r/*', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const bob = createUserWithToken({ email: 'bob@example.com' });
    const proj = seedProject(alice.user.id);
    addProjectMemberByEmail(proj.id, 'bob@example.com', 'admin', 'owner'); // even an admin co-member

    // Alice's job produces a checkpoint result object owned by Alice.
    const job = createProjectJob(alice.user.id, proj.id, { jobType: 'checkpoint.noop' });
    await drainOnce();
    const after = getProjectJob(alice.user.id, proj.id, job.id);
    const checkpointId = after.resultAnalysisObjectId;
    expect(checkpointId).toMatch(/^ao_/);

    // Bob (admin) can READ the checkpoint metadata through the project route…
    const read = await api(server, `/api/projects/${proj.id}/analysis-objects/${checkpointId}`, { token: bob.token });
    expect(read.status).toBe(200);

    // …but R object ownership is still creator-keyed, NOT project-member-keyed.
    expect(verifyAnalysisObjectOwner(alice.user.id, checkpointId)).toBe(true);
    expect(verifyAnalysisObjectOwner(bob.user.id, checkpointId)).toBe(false);

    // Supplying the checkpoint id as an X-Object-ID is rejected before reaching R.
    const res = await api(server, '/api/r/health', { token: bob.token, headers: { 'X-Object-ID': checkpointId } });
    expect(res.status).toBe(404);
  });
});
