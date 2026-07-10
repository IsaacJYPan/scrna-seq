import { describe, it, expect, beforeEach, afterAll } from 'vitest';

const config = require('./config');
const dbmod = require('./pgDatabase');
const {
  createUser, createAnalysisObjectForUser,
  createJobForUser, getJobForUser, listJobsForUser, updateJobStatusForUser,
  cancelJobForUser, verifyJobOwner, verifyAnalysisObjectOwner, validateJobTransition,
  // worker coordination contract under test
  claimNextJob, heartbeatJob, completeJobByWorker, failJobByWorker, releaseJob,
  reapExpiredJobs, setJobScheduling, getWorkerJob, generateClaimToken,
  // project setup for the project-cancel interaction
  createOrganizationForUser, createProjectForUser, createProjectJob, cancelProjectJob, getProjectJob
} = dbmod;

const CONFIGURED = config.hasPostgresConnection();

// Deterministic UTC instants in canonical 'YYYY-MM-DD HH:MM:SS' format (accepted
// as a timestamp literal by Postgres). Worker helpers accept opts.now so lease
// timing never depends on the wall clock.
const T0 = '2030-01-01 00:00:00';
const T0_PLUS_10 = '2030-01-01 00:00:10';
const T0_PLUS_20 = '2030-01-01 00:00:20';
const LATER = '2030-01-01 01:00:00'; // well past any 30s lease taken at T0
const MUCH_LATER = '2030-01-01 02:00:00';

// NOTE: the SQLite-era "schema migration" describe (idempotent additive upgrade of
// a legacy .sqlite jobs table via better-sqlite3 + PRAGMA table_info) was removed
// with the Postgres migration. The Postgres schema is defined once in
// backend/pg/schema.sql and applied by initSchema — there is no legacy-file
// migration path to exercise. The worker-coordination *behavior* below is the
// durable contract and is fully retained.

afterAll(async () => {
  if (!CONFIGURED) return;
  await dbmod.close();
});

// ════════════════════════════════════════════════════════════════════════════
// Claim / lease / heartbeat / complete / fail / release behavior
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('jobs worker contract — claim / lease / heartbeat', () => {
  let alice, bob;
  beforeEach(async () => {
    await dbmod.resetSchemaForTests();
    alice = await createUser('alice@example.com', 'password123', 'Alice');
    bob = await createUser('bob@example.com', 'password123', 'Bob');
  });

  function newJob(owner = alice, jobType = 'normalize') {
    return createJobForUser(owner.id, { jobType });
  }

  // ── Claim ──────────────────────────────────────────────────────────────────
  it('claims a single queued job, flips it to running, and sets the worker fields', async () => {
    const job = await newJob();
    const claimed = await claimNextJob('worker-1', { now: T0, leaseSeconds: 30 });

    expect(claimed.id).toBe(job.id);
    expect(claimed.status).toBe('running');
    expect(claimed.workerId).toBe('worker-1');
    expect(claimed.claimToken).toMatch(/^wct_[0-9a-f]+$/);
    expect(claimed.lockedAt).toBe(T0);
    expect(claimed.heartbeatAt).toBe(T0);
    expect(claimed.leaseExpiresAt).toBe('2030-01-01 00:00:30');
    expect(claimed.startedAt).toBe(T0);
    expect(claimed.attempts).toBe(1);
  });

  it('increments attempts on each claim', async () => {
    const job = await newJob();
    await setJobScheduling(job.id, { maxAttempts: 5 });
    const c1 = await claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(c1.attempts).toBe(1);
    // release refunds, re-claim bumps to 2 net of the refund → demonstrates the counter moves on claim
    await releaseJob(c1.id, 'w1', c1.claimToken, { now: T0_PLUS_10 });
    const c2 = await claimNextJob('w1', { now: T0_PLUS_20, leaseSeconds: 30 });
    expect(c2.attempts).toBe(1); // released (refunded to 0) then claimed again → 1
  });

  it('returns null when there is no claimable job', async () => {
    expect(await claimNextJob('w1', { now: T0 })).toBeNull();
  });

  it('is a single winner: two workers cannot both claim the same job', async () => {
    await newJob();
    const a = await claimNextJob('worker-A', { now: T0, leaseSeconds: 30 });
    const b = await claimNextJob('worker-B', { now: T0, leaseSeconds: 30 });
    expect(a).not.toBeNull();
    expect(a.status).toBe('running');
    expect(b).toBeNull(); // the job is already running with a live lease
  });

  it('a running job with an unexpired lease cannot be claimed by another worker', async () => {
    await newJob();
    const a = await claimNextJob('worker-A', { now: T0, leaseSeconds: 30 });
    // T0+20 is still inside the 30s lease taken at T0.
    expect(await claimNextJob('worker-B', { now: T0_PLUS_20 })).toBeNull();
    expect((await getWorkerJob(a.id)).workerId).toBe('worker-A');
  });

  it('orders claims by priority (desc), then created_at (asc), then id', async () => {
    // Three jobs, same priority, distinct enqueue times → oldest first.
    const j1 = await newJob(); await setJobScheduling(j1.id, { createdAt: '2030-01-01 00:00:01' });
    const j2 = await newJob(); await setJobScheduling(j2.id, { createdAt: '2030-01-01 00:00:02' });
    const j3 = await newJob(); await setJobScheduling(j3.id, { createdAt: '2030-01-01 00:00:03' });
    // Raise j3's priority so it jumps the queue despite being newest.
    await setJobScheduling(j3.id, { priority: 10 });

    expect((await claimNextJob('w', { now: T0, leaseSeconds: 1 })).id).toBe(j3.id); // priority wins
    // Re-claim is blocked by the live lease, so claim the next two by created_at.
    expect((await claimNextJob('w', { now: T0, leaseSeconds: 1 })).id).toBe(j1.id); // oldest of the rest
    expect((await claimNextJob('w', { now: T0, leaseSeconds: 1 })).id).toBe(j2.id);
  });

  it('does not claim terminal jobs (completed / failed / canceled)', async () => {
    // Completed (drive queued→running→completed via the owner status helper).
    const done = await newJob();
    await updateJobStatusForUser(alice.id, done.id, 'running');
    await updateJobStatusForUser(alice.id, done.id, 'completed');
    // Failed.
    const failed = await newJob();
    await updateJobStatusForUser(alice.id, failed.id, 'running');
    await updateJobStatusForUser(alice.id, failed.id, 'failed', { error: { message: 'x' } });
    // Canceled.
    const canceled = await newJob();
    await cancelJobForUser(alice.id, canceled.id);

    expect(await claimNextJob('w', { now: T0 })).toBeNull();
  });

  it('does not claim a canceled job even with siblings present', async () => {
    const canceled = await newJob();
    await cancelJobForUser(alice.id, canceled.id);
    const live = await newJob();
    const claimed = await claimNextJob('w', { now: T0, leaseSeconds: 30 });
    expect(claimed.id).toBe(live.id); // never the canceled one
    expect(await claimNextJob('w', { now: T0 })).toBeNull();
  });

  // ── Expired-lease recovery ──────────────────────────────────────────────────
  it('reaps an expired lease to failed when the attempt budget is exhausted (default max_attempts=1)', async () => {
    const job = await newJob();
    await claimNextJob('w1', { now: T0, leaseSeconds: 30 }); // attempts → 1, lease ends T0+30
    const result = await reapExpiredJobs({ now: LATER });
    expect(result.failed).toContain(job.id);
    expect(result.requeued).toHaveLength(0);

    const after = await getJobForUser(job.id, alice.id);
    expect(after.status).toBe('failed');
    expect(after.error.code).toBe('LEASE_EXPIRED');
    // Not reclaimable forever — it is terminal now.
    expect(await claimNextJob('w2', { now: MUCH_LATER })).toBeNull();
  });

  it('reaps an expired lease back to queued when attempts remain, and it is then re-claimable', async () => {
    const job = await newJob();
    await setJobScheduling(job.id, { maxAttempts: 3 });
    const c1 = await claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(c1.attempts).toBe(1);

    const result = await reapExpiredJobs({ now: LATER });
    expect(result.requeued).toContain(job.id);
    expect(result.failed).toHaveLength(0);

    const requeued = await getWorkerJob(job.id);
    expect(requeued.status).toBe('queued');
    expect(requeued.workerId).toBeNull();
    expect(requeued.claimToken).toBeNull();
    expect(requeued.leaseExpiresAt).toBeNull();

    const c2 = await claimNextJob('w2', { now: MUCH_LATER, leaseSeconds: 30 });
    expect(c2.id).toBe(job.id);
    expect(c2.workerId).toBe('w2');
    expect(c2.attempts).toBe(2); // second claim
  });

  it('requeue clears worker/claim/lease AND locked_at/heartbeat_at consistently (like releaseJob)', async () => {
    const job = await newJob();
    await setJobScheduling(job.id, { maxAttempts: 3 });
    const c1 = await claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    // After claim, the lease fields are populated.
    expect(c1.lockedAt).toBe(T0);
    expect(c1.heartbeatAt).toBe(T0);

    expect((await reapExpiredJobs({ now: LATER })).requeued).toContain(job.id);

    const requeued = await getWorkerJob(job.id);
    expect(requeued.status).toBe('queued');
    expect(requeued.workerId).toBeNull();
    expect(requeued.claimToken).toBeNull();
    expect(requeued.leaseExpiresAt).toBeNull();
    // The fix: locked_at is cleared and heartbeat_at is stamped to the reap instant —
    // no stale claim metadata is left on the requeued row.
    expect(requeued.lockedAt).toBeNull();
    expect(requeued.heartbeatAt).toBe(LATER);
  });

  it('expired→failed clears claim/lease/token and stamps heartbeat (terminal-row convention)', async () => {
    const job = await newJob(); // default max_attempts = 1
    await claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect((await reapExpiredJobs({ now: LATER })).failed).toContain(job.id);

    const failed = await getWorkerJob(job.id);
    expect(failed.status).toBe('failed');
    expect(failed.claimToken).toBeNull();
    expect(failed.leaseExpiresAt).toBeNull();
    expect(failed.heartbeatAt).toBe(LATER);
    // worker_id and locked_at are retained as diagnostics on the terminal row, exactly
    // like failJobByWorker/completeJobByWorker.
    expect(failed.workerId).toBe('w1');
    expect(failed.lockedAt).toBe(T0);
  });

  it('honors max_attempts across the full requeue→claim→reap cycle', async () => {
    const job = await newJob();
    await setJobScheduling(job.id, { maxAttempts: 2 });

    await claimNextJob('w1', { now: T0, leaseSeconds: 30 });                  // attempts 1
    expect((await reapExpiredJobs({ now: LATER })).requeued).toContain(job.id); // 1 < 2 → requeue
    await claimNextJob('w2', { now: MUCH_LATER, leaseSeconds: 30 });          // attempts 2
    const final = await reapExpiredJobs({ now: '2030-01-01 03:00:00' });      // 2 >= 2 → fail
    expect(final.failed).toContain(job.id);
    expect((await getJobForUser(job.id, alice.id)).status).toBe('failed');
  });

  // ── Heartbeat ───────────────────────────────────────────────────────────────
  it('heartbeat extends the lease and updates heartbeat_at for the owning worker', async () => {
    await newJob();
    const c = await claimNextJob('w1', { now: T0, leaseSeconds: 30 }); // lease T0+30
    expect(c.leaseExpiresAt).toBe('2030-01-01 00:00:30');

    const hb = await heartbeatJob(c.id, 'w1', c.claimToken, { now: T0_PLUS_10, leaseSeconds: 30 });
    expect(hb.heartbeatAt).toBe(T0_PLUS_10);
    expect(hb.leaseExpiresAt).toBe('2030-01-01 00:00:40'); // extended
    expect(hb.leaseExpiresAt > c.leaseExpiresAt).toBe(true);
  });

  it('heartbeat fails for a non-owning worker or a wrong claim token', async () => {
    await newJob();
    const c = await claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    await expect(heartbeatJob(c.id, 'w2', c.claimToken, { now: T0_PLUS_10 }))
      .rejects.toThrow(/no longer holds/i);
    await expect(heartbeatJob(c.id, 'w1', 'wct_wrongtoken', { now: T0_PLUS_10 }))
      .rejects.toThrow(/no longer holds/i);
    // The real holder still can.
    expect((await heartbeatJob(c.id, 'w1', c.claimToken, { now: T0_PLUS_10 })).status).toBe('running');
  });

  it('heartbeat after the lease has already expired is rejected (claim lost)', async () => {
    await newJob();
    const c = await claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    await expect(heartbeatJob(c.id, 'w1', c.claimToken, { now: LATER }))
      .rejects.toThrow(/no longer holds/i);
  });

  it('heartbeat on an unknown job is JOB_NOT_FOUND', async () => {
    let code;
    try { await heartbeatJob('job_does_not_exist', 'w1', 'wct_x', { now: T0 }); }
    catch (e) { code = e.code; }
    expect(code).toBe('JOB_NOT_FOUND');
  });

  // ── Complete / fail / release ownership ──────────────────────────────────────
  it('only the owning worker can complete, fail, or release a job', async () => {
    await newJob();
    const c = await claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    await expect(completeJobByWorker(c.id, 'intruder', c.claimToken, { now: T0_PLUS_10 })).rejects.toThrow(/no longer holds/i);
    await expect(failJobByWorker(c.id, 'intruder', c.claimToken, { message: 'x' }, { now: T0_PLUS_10 })).rejects.toThrow(/no longer holds/i);
    await expect(releaseJob(c.id, 'intruder', c.claimToken, { now: T0_PLUS_10 })).rejects.toThrow(/no longer holds/i);
    // Wrong token, right worker → also rejected.
    await expect(completeJobByWorker(c.id, 'w1', 'wct_nope', { now: T0_PLUS_10 })).rejects.toThrow(/no longer holds/i);
    // Still running and held by w1.
    expect((await getWorkerJob(c.id)).status).toBe('running');
  });

  it('completing a held job transitions running→completed and clears the live claim', async () => {
    await newJob();
    const c = await claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    const done = await completeJobByWorker(c.id, 'w1', c.claimToken, { now: T0_PLUS_10, log: 'finished' });
    expect(done.status).toBe('completed');
    expect(done.completedAt).toBe(T0_PLUS_10);
    expect(done.claimToken).toBeNull();
    expect(done.leaseExpiresAt).toBeNull();
    expect(done.logs.some(l => l.message === 'finished')).toBe(true);
    // A second completion is rejected (claim already cleared → not running/held).
    await expect(completeJobByWorker(c.id, 'w1', c.claimToken, { now: T0_PLUS_20 })).rejects.toThrow(/no longer holds/i);
  });

  it('completing can link a result analysis object owned by the job owner, and rejects a foreign one', async () => {
    const resultObj = await createAnalysisObjectForUser(alice.id, { objectType: 'seurat' });
    const bobObj = await createAnalysisObjectForUser(bob.id, { objectType: 'seurat' });
    await newJob(); // owned by alice
    const c = await claimNextJob('w1', { now: T0, leaseSeconds: 30 });

    await expect(completeJobByWorker(c.id, 'w1', c.claimToken, { now: T0_PLUS_10, resultAnalysisObjectId: bobObj.id }))
      .rejects.toThrow(/result analysis object not found/i);
    const done = await completeJobByWorker(c.id, 'w1', c.claimToken, { now: T0_PLUS_20, resultAnalysisObjectId: resultObj.id });
    expect(done.resultAnalysisObjectId).toBe(resultObj.id);
  });

  it('failing a held job records durable error information and clears the claim', async () => {
    await newJob();
    const c = await claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    const failed = await failJobByWorker(c.id, 'w1', c.claimToken, { message: 'Seurat error', code: 'R_ERROR' }, { now: T0_PLUS_10 });
    expect(failed.status).toBe('failed');
    expect(failed.error).toEqual({ message: 'Seurat error', code: 'R_ERROR' });
    expect(failed.lastWorkerError).toEqual({ message: 'Seurat error', code: 'R_ERROR' });
    expect(failed.completedAt).toBe(T0_PLUS_10);
    expect(failed.claimToken).toBeNull();
    // The user-facing error survives a re-read through the public helper.
    expect((await getJobForUser(c.id, alice.id)).error.code).toBe('R_ERROR');
  });

  it('failing always records an error even when none is supplied', async () => {
    await newJob();
    const c = await claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    const failed = await failJobByWorker(c.id, 'w1', c.claimToken, undefined, { now: T0_PLUS_10 });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBeTruthy();
    expect(typeof failed.error.message).toBe('string');
  });

  it('releasing returns the job to queued, refunds the attempt, and makes it re-claimable', async () => {
    const job = await newJob();
    const c = await claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(c.attempts).toBe(1);
    const released = await releaseJob(c.id, 'w1', c.claimToken, { now: T0_PLUS_10, log: 'handing back' });
    expect(released.status).toBe('queued');
    expect(released.attempts).toBe(0); // refunded
    expect(released.workerId).toBeNull();
    expect(released.claimToken).toBeNull();
    expect(released.leaseExpiresAt).toBeNull();

    const c2 = await claimNextJob('w2', { now: T0_PLUS_20, leaseSeconds: 30 });
    expect(c2.id).toBe(job.id);
    expect(c2.workerId).toBe('w2');
    expect(c2.attempts).toBe(1);
  });

  // ── reap / setJobScheduling shapes & validation ──────────────────────────────
  it('reapExpiredJobs returns the affected ids and ignores live leases', async () => {
    const live = await newJob();
    await claimNextJob('w1', { now: T0, leaseSeconds: 7200 }); // lease ends T0+2h, still live at LATER (T0+1h)
    const result = await reapExpiredJobs({ now: LATER });
    expect(result.requeued).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect((await getWorkerJob(live.id)).status).toBe('running');
  });

  it('setJobScheduling validates its inputs', async () => {
    const job = await newJob();
    await expect(setJobScheduling(job.id, { priority: 1.5 })).rejects.toThrow(/priority/i);
    await expect(setJobScheduling(job.id, { maxAttempts: 0 })).rejects.toThrow(/maxAttempts/i);
    await expect(setJobScheduling(job.id, { createdAt: 'not-a-timestamp' })).rejects.toThrow(/createdAt/i);
    await expect(setJobScheduling('job_missing', { priority: 1 })).rejects.toThrow(/not found/i);
  });

  it('rejects malformed worker input', async () => {
    await newJob();
    await expect(claimNextJob('', { now: T0 })).rejects.toThrow(/worker id/i);
    await expect(claimNextJob('bad id with spaces', { now: T0 })).rejects.toThrow(/worker id/i);
    await expect(claimNextJob('w1', { now: 'bogus' })).rejects.toThrow(/timestamp/i);
    await expect(claimNextJob('w1', { now: T0, leaseSeconds: 0 })).rejects.toThrow(/leaseSeconds/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Cancellation interaction with a live claim (owner + project routes)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('jobs worker contract — cancel makes worker behavior safe', () => {
  let alice;
  beforeEach(async () => {
    await dbmod.resetSchemaForTests();
    alice = await createUser('alice@example.com', 'password123', 'Alice');
  });

  it('owner cancel of a claimed job makes future heartbeat/complete/fail deterministic (CLAIM_LOST)', async () => {
    await createJobForUser(alice.id, { jobType: 'normalize' });
    const c = await claimNextJob('w1', { now: T0, leaseSeconds: 30 });

    const canceled = await cancelJobForUser(alice.id, c.id);
    expect(canceled.status).toBe('canceled');
    expect(canceled.canceledAt).toBeTruthy();

    await expect(heartbeatJob(c.id, 'w1', c.claimToken, { now: T0_PLUS_10 })).rejects.toThrow(/no longer holds/i);
    await expect(completeJobByWorker(c.id, 'w1', c.claimToken, { now: T0_PLUS_10 })).rejects.toThrow(/no longer holds/i);
    await expect(failJobByWorker(c.id, 'w1', c.claimToken, { message: 'x' }, { now: T0_PLUS_10 })).rejects.toThrow(/no longer holds/i);
    await expect(releaseJob(c.id, 'w1', c.claimToken, { now: T0_PLUS_10 })).rejects.toThrow(/no longer holds/i);
    // Stays canceled — the worker can never resurrect it.
    expect((await getJobForUser(c.id, alice.id)).status).toBe('canceled');
  });

  it('project cancel of a claimed job also voids the claim (CLAIM_LOST afterwards)', async () => {
    const org = await createOrganizationForUser(alice.id, { name: 'Acme' });
    const proj = await createProjectForUser(alice.id, { organizationId: org.id, name: 'P' });
    const created = await createProjectJob(alice.id, proj.id, { jobType: 'pca' });
    const c = await claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(c.id).toBe(created.id);

    const canceled = await cancelProjectJob(alice.id, proj.id, created.id);
    expect(canceled.status).toBe('canceled');

    await expect(heartbeatJob(created.id, 'w1', c.claimToken, { now: T0_PLUS_10 })).rejects.toThrow(/no longer holds/i);
    await expect(completeJobByWorker(created.id, 'w1', c.claimToken, { now: T0_PLUS_10 })).rejects.toThrow(/no longer holds/i);
    expect((await getProjectJob(alice.id, proj.id, created.id)).status).toBe('canceled');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Transition allow-list, public-API compatibility, and the R/ownership boundary
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('jobs worker contract — invariants preserved', () => {
  let alice, bob;
  beforeEach(async () => {
    await dbmod.resetSchemaForTests();
    alice = await createUser('alice@example.com', 'password123', 'Alice');
    bob = await createUser('bob@example.com', 'password123', 'Bob');
  });

  it('adds only the running→queued worker re-queue edge; existing edges & terminals unchanged', () => {
    // New edge.
    expect(validateJobTransition('running', 'queued')).toBe(true);
    // Existing valid edges still valid.
    expect(validateJobTransition('created', 'queued')).toBe(true);
    expect(validateJobTransition('queued', 'running')).toBe(true);
    expect(validateJobTransition('running', 'completed')).toBe(true);
    expect(validateJobTransition('running', 'failed')).toBe(true);
    expect(validateJobTransition('running', 'canceled')).toBe(true);
    // Terminals remain terminal.
    for (const t of ['completed', 'failed', 'canceled']) {
      for (const to of ['queued', 'running', 'completed', 'failed', 'canceled']) {
        expect(validateJobTransition(t, to), `${t}->${to}`).toBe(false);
      }
    }
    // Still-invalid edges.
    expect(validateJobTransition('queued', 'completed')).toBe(false);
    expect(validateJobTransition('created', 'running')).toBe(false);
  });

  it('never exposes claim_token through the public job read helpers', async () => {
    await createJobForUser(alice.id, { jobType: 'normalize' });
    const claimed = await claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(claimed.claimToken).toBeTruthy(); // worker view has it

    const pub = await getJobForUser(claimed.id, alice.id);
    expect(Object.prototype.hasOwnProperty.call(pub, 'claimToken')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(pub, 'claim_token')).toBe(false);
    const listed = (await listJobsForUser(alice.id))[0];
    expect(Object.prototype.hasOwnProperty.call(listed, 'claimToken')).toBe(false);
  });

  it('the public job shape is unchanged by claiming (no worker fields leak in)', async () => {
    const created = await createJobForUser(alice.id, { jobType: 'normalize' });
    // The create response shape is exactly the historical public shape.
    expect(Object.keys(created).sort()).toEqual([
      'analysisObjectId', 'canceledAt', 'completedAt', 'createdAt', 'datasetId',
      'error', 'id', 'jobType', 'logs', 'ownerUserId', 'parameters', 'projectId',
      'resultAnalysisObjectId', 'startedAt', 'status', 'updatedAt'
    ]);
    // Claiming does not add worker keys to the public read shape.
    await claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(Object.keys(await getJobForUser(created.id, alice.id)).sort())
      .toEqual(Object.keys(created).sort());
  });

  it('a claimed job remains owner-scoped on the public read path (claim does not widen access)', async () => {
    await createJobForUser(alice.id, { jobType: 'normalize' });
    const c = await claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(await getJobForUser(c.id, alice.id)).toBeTruthy();      // owner sees it
    expect(await getJobForUser(c.id, bob.id)).toBeNull();           // another user cannot
    expect(await verifyJobOwner(alice.id, c.id)).toBe(true);
    expect(await verifyJobOwner(bob.id, c.id)).toBe(false);
  });

  it('claiming/completing a job never widens analysis-object (R) ownership', async () => {
    const ao = await createAnalysisObjectForUser(alice.id, { objectType: 'seurat' });
    await createJobForUser(alice.id, { jobType: 'normalize', analysisObjectId: ao.id });
    const c = await claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    await completeJobByWorker(c.id, 'w1', c.claimToken, { now: T0_PLUS_10 });
    // The R-adjacent object is still owned only by alice — worker activity on the
    // job row does not grant anyone (or any worker) ownership of the live object.
    expect(await verifyAnalysisObjectOwner(alice.id, ao.id)).toBe(true);
    expect(await verifyAnalysisObjectOwner(bob.id, ao.id)).toBe(false);
  });

  it('createJobForUser ignores client-style coordination fields and uses safe defaults', async () => {
    // Even if a caller smuggles worker/scheduling fields, the create path ignores
    // them: the job is queued with attempts 0, max_attempts 1, priority 0.
    const created = await createJobForUser(alice.id, {
      jobType: 'normalize',
      // none of these are read by createJobForUser:
      worker_id: 'evil', claim_token: 'wct_evil', attempts: 99, max_attempts: 99, priority: 99, status: 'running'
    });
    expect(created.status).toBe('queued');
    const view = await getWorkerJob(created.id);
    expect(view.attempts).toBe(0);
    expect(view.maxAttempts).toBe(1);
    expect(view.priority).toBe(0);
    expect(view.workerId).toBeNull();
    expect(view.claimToken).toBeNull();
  });

  it('generateClaimToken produces distinct header-safe tokens', () => {
    const a = generateClaimToken();
    const b = generateClaimToken();
    expect(a).toMatch(/^wct_[0-9a-f]+$/);
    expect(a).not.toBe(b);
  });
});
