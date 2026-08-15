import { describe, it, expect, beforeEach, afterAll } from 'vitest';

const config = require('./config');
const dbmod = require('./pgDatabase');
const {
  createUser, createAnalysisObjectForUser, createProjectAnalysisObject,
  createJobForUser, getJobForUser, listJobsForUser, updateJobStatusForUser,
  cancelJobForUser, verifyJobOwner, verifyAnalysisObjectOwner, validateJobTransition,
  // worker coordination contract under test
  claimNextJob, heartbeatJob, completeJobByWorker, failJobByWorker,
  deferIndeterminateRTimeoutByWorker, markRDispatchStartedByWorker, releaseJob,
  reapExpiredJobs, setJobScheduling, getWorkerJob, generateClaimToken,
  createJobArtifactByWorker, getJobArtifactsByJobId,
  // project setup for the project-cancel interaction
  createOrganizationForUser, createProjectForUser, createProjectJob, cancelProjectJob, getProjectJob,
  addProjectMemberByEmail, updateProjectMemberRole, removeProjectMember
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

async function waitForBlockedPgQuery(client, queryFragment, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND position($1 in lower(query)) > 0
        LIMIT 1`,
      [String(queryFragment).toLowerCase()]
    );
    if (result.rows[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for blocked PostgreSQL query: ${queryFragment}`);
}

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

  it('cancels queued project jobs after creator demotion/removal and claims the next eligible job', async () => {
    const carol = await createUser('carol@example.com', 'password123', 'Carol');
    const org = await createOrganizationForUser(alice.id, { name: 'Lab' });
    const project = await createProjectForUser(alice.id, { organizationId: org.id, name: 'Study' });
    await addProjectMemberByEmail(project.id, bob.email, 'analyst', 'owner');
    await addProjectMemberByEmail(project.id, carol.email, 'analyst', 'owner');
    const demotedJob = await createProjectJob(bob.id, project.id, { jobType: 'generic' });
    const removedJob = await createProjectJob(carol.id, project.id, { jobType: 'generic' });
    const ownerJob = await createProjectJob(alice.id, project.id, { jobType: 'generic' });

    await updateProjectMemberRole(project.id, bob.id, 'viewer', { userId: alice.id });
    await removeProjectMember(project.id, carol.id, { userId: alice.id });

    const claimed = await claimNextJob('worker-access', { now: T0, leaseSeconds: 30 });
    expect(claimed.id).toBe(ownerJob.id);
    await expect(getProjectJob(alice.id, project.id, demotedJob.id)).resolves.toMatchObject({
      status: 'canceled',
      error: expect.objectContaining({ code: 'PROJECT_ACCESS_REVOKED' }),
    });
    await expect(getProjectJob(alice.id, project.id, removedJob.id)).resolves.toMatchObject({
      status: 'canceled',
      error: expect.objectContaining({ code: 'PROJECT_ACCESS_REVOKED' }),
    });
  });

  it('cancels a legacy projectless job that references a project object before claim', async () => {
    const org = await createOrganizationForUser(alice.id, { name: 'Lab' });
    const project = await createProjectForUser(alice.id, { organizationId: org.id, name: 'Study' });
    const projectObject = await createProjectAnalysisObject(alice.id, project.id, {
      objectType: 'seurat',
      displayName: 'Project object',
    });
    // Seed the shape an older compatibility route could create: projectless
    // descendants whose lineage root is still the project object.
    const legacyChild = await createAnalysisObjectForUser(alice.id, {
      objectType: 'seurat',
      parentObjectId: projectObject.id,
    });
    const legacyGrandchild = await createAnalysisObjectForUser(alice.id, {
      objectType: 'seurat',
      parentObjectId: legacyChild.id,
    });
    const invalid = await createJobForUser(alice.id, {
      jobType: 'r.object.inspect',
      analysisObjectId: legacyGrandchild.id,
    });
    const eligible = await createJobForUser(alice.id, { jobType: 'generic' });

    const claimed = await claimNextJob('worker-scope', { now: T0, leaseSeconds: 30 });
    expect(claimed.id).toBe(eligible.id);
    expect(await getWorkerJob(invalid.id)).toMatchObject({
      status: 'canceled',
      error: expect.objectContaining({ code: 'INVALID_PROJECT_SCOPE' }),
    });
  });

  it('preserves an already-running claim after member removal', async () => {
    const org = await createOrganizationForUser(alice.id, { name: 'Lab' });
    const project = await createProjectForUser(alice.id, { organizationId: org.id, name: 'Study' });
    await addProjectMemberByEmail(project.id, bob.email, 'analyst', 'owner');
    const job = await createProjectJob(bob.id, project.id, { jobType: 'generic' });
    const claimed = await claimNextJob('worker-running', { now: T0, leaseSeconds: 30 });
    expect(claimed.id).toBe(job.id);

    await removeProjectMember(project.id, bob.id, { userId: alice.id });
    await completeJobByWorker(job.id, 'worker-running', claimed.claimToken, { now: T0_PLUS_10 });

    await expect(getProjectJob(alice.id, project.id, job.id)).resolves.toMatchObject({ status: 'completed' });
  });

  it('is a single winner: two workers cannot both claim the same job', async () => {
    await newJob();
    const a = await claimNextJob('worker-A', { now: T0, leaseSeconds: 30 });
    const b = await claimNextJob('worker-B', { now: T0, leaseSeconds: 30 });
    expect(a).not.toBeNull();
    expect(a.status).toBe('running');
    expect(b).toBeNull(); // the job is already running with a live lease
  });

  it('is a single winner under genuinely concurrent claim attempts', async () => {
    const job = await newJob(alice, 'generic');
    const results = await Promise.all([
      claimNextJob('worker-concurrent-A', { now: T0, leaseSeconds: 30 }),
      claimNextJob('worker-concurrent-B', { now: T0, leaseSeconds: 30 }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean).id).toBe(job.id);
    expect((await getWorkerJob(job.id)).attempts).toBe(1);
  });

  it('admits only one live claim when workers race for different queued jobs', async () => {
    const first = await newJob(alice, 'generic');
    const second = await newJob(alice, 'generic');
    const claims = await Promise.all([
      claimNextJob('worker-gate-A', { now: T0, leaseSeconds: 30 }),
      claimNextJob('worker-gate-B', { now: T0, leaseSeconds: 30 }),
    ]);
    const liveClaims = claims.filter(Boolean);
    expect(liveClaims).toHaveLength(1);
    expect([first.id, second.id]).toContain(liveClaims[0].id);

    expect(await claimNextJob('worker-gate-C', {
      now: T0_PLUS_10,
      leaseSeconds: 30,
    })).toBeNull();

    const live = liveClaims[0];
    await completeJobByWorker(live.id, live.workerId, live.claimToken, { now: T0_PLUS_10 });
    const next = await claimNextJob('worker-gate-C', {
      now: T0_PLUS_20,
      leaseSeconds: 30,
    });
    expect([first.id, second.id]).toContain(next.id);
    expect(next.id).not.toBe(live.id);
  });

  it('admits two distinct live claims when the bounded pool size is two', async () => {
    const jobs = [
      await newJob(alice, 'generic'),
      await newJob(alice, 'generic'),
      await newJob(alice, 'generic'),
    ];
    const claims = await Promise.all([
      claimNextJob('pool-1:worker-A', {
        now: T0, leaseSeconds: 30, maxConcurrentClaims: 2,
      }),
      claimNextJob('pool-2:worker-B', {
        now: T0, leaseSeconds: 30, maxConcurrentClaims: 2,
      }),
    ]);

    expect(claims.every(Boolean)).toBe(true);
    expect(new Set(claims.map((claim) => claim.id)).size).toBe(2);
    expect(claims.every((claim) => jobs.some((job) => job.id === claim.id))).toBe(true);
    await expect(claimNextJob('pool-3:worker-C', {
      now: T0_PLUS_10, leaseSeconds: 30, maxConcurrentClaims: 2,
    })).resolves.toBeNull();

    await completeJobByWorker(
      claims[0].id,
      claims[0].workerId,
      claims[0].claimToken,
      { now: T0_PLUS_10 }
    );
    const third = await claimNextJob('pool-1:worker-D', {
      now: T0_PLUS_20, leaseSeconds: 30, maxConcurrentClaims: 2,
    });
    expect(third).not.toBeNull();
    expect(jobs.map((job) => job.id)).toContain(third.id);
    expect(claims.map((claim) => claim.id)).not.toContain(third.id);
  });

  it('rejects invalid bounded-pool claim limits', async () => {
    await newJob(alice, 'generic');
    for (const maxConcurrentClaims of [0, 9, 1.5, 'invalid']) {
      await expect(claimNextJob('pool-invalid', { now: T0, maxConcurrentClaims }))
        .rejects.toMatchObject({ code: 'INVALID_WORKER_POOL_SIZE' });
    }
  });

  it('applies a capability filter atomically without consuming an incompatible job', async () => {
    const incompatible = await newJob(alice, 'pca');
    await setJobScheduling(incompatible.id, { createdAt: '2029-12-31 23:59:58' });
    const compatible = await newJob(alice, 'generic');
    const claimed = await claimNextJob('worker-generic-only', {
      now: T0,
      leaseSeconds: 30,
      allowedJobTypes: ['generic'],
    });
    expect(claimed.id).toBe(compatible.id);
    expect((await getWorkerJob(incompatible.id)).status).toBe('queued');
    expect((await getWorkerJob(incompatible.id)).attempts).toBe(0);
    expect(await claimNextJob('worker-none', { now: T0, allowedJobTypes: [] })).toBeNull();
    await expect(claimNextJob('worker-invalid', { now: T0, allowedJobTypes: ['evil.dynamic.r'] }))
      .rejects.toMatchObject({ code: 'INVALID_WORKER_CAPABILITIES' });
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

    const c3 = await claimNextJob('w', { now: T0, leaseSeconds: 30 });
    expect(c3.id).toBe(j3.id); // priority wins
    await completeJobByWorker(c3.id, 'w', c3.claimToken, { now: T0_PLUS_10 });
    const c1 = await claimNextJob('w', { now: T0_PLUS_10, leaseSeconds: 30 });
    expect(c1.id).toBe(j1.id); // oldest of the rest
    await completeJobByWorker(c1.id, 'w', c1.claimToken, { now: T0_PLUS_20 });
    expect((await claimNextJob('w', { now: T0_PLUS_20, leaseSeconds: 30 })).id).toBe(j2.id);
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

  it('defers an indeterminate R timeout under the live claim for a bounded grace period', async () => {
    await newJob(alice, 'generic');
    const claim = await claimNextJob('worker-timeout', { now: T0, leaseSeconds: 30 });

    await expect(deferIndeterminateRTimeoutByWorker(
      claim.id, 'worker-intruder', claim.claimToken,
      { now: T0_PLUS_10, recoveryDelaySeconds: 30 }
    )).rejects.toThrow(/no longer holds/i);

    const deferred = await deferIndeterminateRTimeoutByWorker(
      claim.id, 'worker-timeout', claim.claimToken,
      { now: T0_PLUS_10, recoveryDelaySeconds: 30 }
    );
    expect(deferred).toMatchObject({
      status: 'running',
      workerId: 'worker-timeout',
      claimToken: claim.claimToken,
      leaseExpiresAt: '2030-01-01 00:00:40',
      lastWorkerError: expect.objectContaining({ code: dbmod.R_TIMEOUT_INDETERMINATE }),
    });
    expect(deferred.error).toBeNull();
  });

  it('turns a crashed side-effecting R dispatch into observation then recovery-only claim', async () => {
    const organization = await createOrganizationForUser(alice.id, { name: 'Dispatch recovery org' });
    const project = await createProjectForUser(alice.id, {
      organizationId: organization.id,
      name: 'Dispatch recovery project',
    });
    const source = await createProjectAnalysisObject(alice.id, project.id, {
      objectType: 'seurat', displayName: 'Dispatch source',
    });
    const job = await createProjectJob(alice.id, project.id, {
      jobType: 'pbmc.pipeline.v1', analysisObjectId: source.id,
    });
    const claim = await claimNextJob('worker-r-dispatch-crash', {
      now: T0,
      leaseSeconds: 30,
      allowedJobTypes: ['pbmc.pipeline.v1'],
    });

    await expect(markRDispatchStartedByWorker(
      job.id,
      'worker-intruder',
      claim.claimToken,
      { now: T0_PLUS_10 }
    )).rejects.toMatchObject({ code: 'CLAIM_LOST' });
    const marked = await markRDispatchStartedByWorker(
      job.id,
      'worker-r-dispatch-crash',
      claim.claimToken,
      { now: T0_PLUS_10 }
    );
    expect(marked.lastWorkerError).toMatchObject({ code: dbmod.R_DISPATCH_STARTED });

    // The process disappears here. Lease reaping must revoke that claim and
    // observe the separate R process for the full bounded grace, not queue a
    // second scientific execution immediately.
    const firstReap = await reapExpiredJobs({ now: LATER });
    expect(firstReap.requeued).not.toContain(job.id);
    expect(firstReap.failed).not.toContain(job.id);
    expect(await getWorkerJob(job.id)).toMatchObject({
      status: 'running',
      workerId: null,
      claimToken: null,
      leaseExpiresAt: '2030-01-01 01:05:00',
      lastWorkerError: expect.objectContaining({ code: dbmod.R_TIMEOUT_INDETERMINATE }),
    });
    await expect(heartbeatJob(
      job.id,
      'worker-r-dispatch-crash',
      claim.claimToken,
      { now: LATER, leaseSeconds: 30 }
    )).rejects.toMatchObject({ code: 'CLAIM_LOST' });
    await expect(claimNextJob('worker-must-not-rerun', {
      now: LATER,
      leaseSeconds: 30,
      allowedJobTypes: ['pbmc.pipeline.v1'],
    })).resolves.toBeNull();

    const afterObservation = '2030-01-01 01:05:00';
    expect((await reapExpiredJobs({ now: afterObservation })).requeued).toContain(job.id);
    const recovery = await claimNextJob('worker-receipt-only', {
      now: afterObservation,
      leaseSeconds: 30,
      allowedJobTypes: ['pbmc.pipeline.v1'],
    });
    expect(recovery).toMatchObject({
      id: job.id,
      attempts: 1,
      lastWorkerError: expect.objectContaining({ code: dbmod.R_TIMEOUT_RECOVERY_PENDING }),
    });
  });

  it('fences stale heartbeats after an indeterminate R outcome without blocking the recovery claimant', async () => {
    const job = await newJob(alice, 'generic');
    await setJobScheduling(job.id, { maxAttempts: 3 });
    const original = await claimNextJob('worker-timeout-fenced', {
      now: T0, leaseSeconds: 30,
    });
    await deferIndeterminateRTimeoutByWorker(
      job.id,
      'worker-timeout-fenced',
      original.claimToken,
      { now: T0_PLUS_10, recoveryDelaySeconds: 10 }
    );

    // A heartbeat already in flight when defer began must not shorten or extend
    // the fenced grace lease after the outcome became indeterminate.
    await expect(heartbeatJob(
      job.id,
      'worker-timeout-fenced',
      original.claimToken,
      { now: T0_PLUS_10, leaseSeconds: 30 }
    )).rejects.toMatchObject({ code: 'CLAIM_LOST' });
    expect((await getWorkerJob(job.id)).leaseExpiresAt).toBe(T0_PLUS_20);

    await reapExpiredJobs({ now: T0_PLUS_20 });
    const recovery = await claimNextJob('worker-timeout-recovery-fenced', {
      now: T0_PLUS_20, leaseSeconds: 30,
    });
    expect(recovery.lastWorkerError.code).toBe(dbmod.R_TIMEOUT_RECOVERY_PENDING);

    // The new claim has a different token and must be able to renew while it
    // verifies a potentially large receipt/output.
    await expect(heartbeatJob(
      job.id,
      'worker-timeout-recovery-fenced',
      recovery.claimToken,
      { now: T0_PLUS_20, leaseSeconds: 30 }
    )).resolves.toMatchObject({ leaseExpiresAt: '2030-01-01 00:00:50' });
  });

  it('preserves recovery-only authorization when a validly running creator is later removed', async () => {
    const organization = await createOrganizationForUser(alice.id, { name: 'Recovery authorization org' });
    const project = await createProjectForUser(alice.id, {
      organizationId: organization.id,
      name: 'Recovery authorization project',
    });
    await addProjectMemberByEmail(project.id, bob.email, 'analyst', { userId: alice.id });
    const job = await createProjectJob(bob.id, project.id, { jobType: 'generic' });
    const original = await claimNextJob('worker-authorized-before-demotion', {
      now: T0, leaseSeconds: 30,
    });
    expect(original.id).toBe(job.id);
    await deferIndeterminateRTimeoutByWorker(
      job.id,
      'worker-authorized-before-demotion',
      original.claimToken,
      { now: T0_PLUS_10, recoveryDelaySeconds: 10 }
    );

    await removeProjectMember(project.id, bob.id, { userId: alice.id });
    expect((await reapExpiredJobs({ now: T0_PLUS_20 })).requeued).toContain(job.id);

    // This claim may only run the worker's recovery-only receipt path. It must not
    // be canceled by the ordinary queued-job role sweep because the original R
      // execution was authorized while the creator still had analyst access.
    const recovery = await claimNextJob('worker-after-creator-removal', {
      now: T0_PLUS_20, leaseSeconds: 30,
    });
    expect(recovery).toMatchObject({
      id: job.id,
      status: 'running',
      lastWorkerError: expect.objectContaining({ code: dbmod.R_TIMEOUT_RECOVERY_PENDING }),
    });
    await expect(getProjectJob(alice.id, project.id, job.id)).resolves.toMatchObject({
      status: 'running',
    });
    await expect(getProjectJob(bob.id, project.id, job.id))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('converts a pre-marker retry to receipt-only recovery after creator demotion', async () => {
    const organization = await createOrganizationForUser(alice.id, { name: 'Legacy retry recovery org' });
    const project = await createProjectForUser(alice.id, {
      organizationId: organization.id,
      name: 'Legacy retry recovery project',
    });
    await addProjectMemberByEmail(project.id, bob.email, 'analyst', { userId: alice.id });
    const source = await createProjectAnalysisObject(bob.id, project.id, {
      objectType: 'seurat', displayName: 'Pre-marker source',
    });
    const job = await createProjectJob(bob.id, project.id, {
      jobType: 'pbmc.pipeline.v1', analysisObjectId: source.id,
    });
    await claimNextJob('worker-pre-marker-crash', {
      now: T0,
      leaseSeconds: 30,
      allowedJobTypes: ['pbmc.pipeline.v1'],
    });

    // Model a job created by an older worker that crashed before dispatch
    // markers existed. It has consumed an authorized attempt but has no DB rows;
    // a private signed receipt may still arrive from the separate R process.
    expect((await reapExpiredJobs({ now: LATER })).requeued).toContain(job.id);
    await updateProjectMemberRole(project.id, bob.id, 'viewer', { userId: alice.id });

    const recovery = await claimNextJob('worker-pre-marker-recovery', {
      now: LATER,
      leaseSeconds: 30,
      allowedJobTypes: ['pbmc.pipeline.v1'],
    });
    expect(recovery).toMatchObject({
      id: job.id,
      status: 'running',
      attempts: 2,
      lastWorkerError: expect.objectContaining({ code: dbmod.R_RETRY_RECOVERY_PENDING }),
    });
    await expect(getProjectJob(alice.id, project.id, job.id)).resolves.toMatchObject({
      status: 'running',
    });
    await expect(getProjectJob(bob.id, project.id, job.id)).resolves.toMatchObject({
      status: 'running',
    });
  });

  it('repeats no-R observation after a timeout without ever falling through to normal retries', async () => {
    const job = await newJob(alice, 'generic');
    await setJobScheduling(job.id, { maxAttempts: 3 });
    const claim = await claimNextJob('worker-timeout-first', { now: T0, leaseSeconds: 30 });
    await deferIndeterminateRTimeoutByWorker(
      job.id, 'worker-timeout-first', claim.claimToken,
      { now: T0_PLUS_10, recoveryDelaySeconds: 10 }
    );

    expect((await reapExpiredJobs({ now: T0_PLUS_20 })).requeued).toContain(job.id);
    const pending = await getWorkerJob(job.id);
    expect(pending).toMatchObject({
      status: 'queued',
      attempts: 0,
      lastWorkerError: expect.objectContaining({ code: dbmod.R_TIMEOUT_RECOVERY_PENDING }),
    });

    const recoveryClaim = await claimNextJob('worker-timeout-recovery', {
      now: T0_PLUS_20, leaseSeconds: 30,
    });
    expect(recoveryClaim).toMatchObject({
      id: job.id,
      attempts: 1,
      lastWorkerError: expect.objectContaining({ code: dbmod.R_TIMEOUT_RECOVERY_PENDING }),
    });

    const expiredRecovery = await reapExpiredJobs({ now: LATER });
    expect(expiredRecovery.failed).not.toContain(job.id);
    expect(expiredRecovery.requeued).not.toContain(job.id);
    expect(await getWorkerJob(job.id)).toMatchObject({
      status: 'running',
      workerId: null,
      claimToken: null,
      leaseExpiresAt: '2030-01-01 01:05:00',
      lastWorkerError: expect.objectContaining({ code: dbmod.R_TIMEOUT_INDETERMINATE }),
    });

    // A crashed recovery observer cannot prove the separate R process stopped.
    // After another bounded observation window it receives another no-R claim,
    // preserving eventual adoption of a late signed receipt.
    expect((await reapExpiredJobs({ now: '2030-01-01 01:05:00' })).requeued)
      .toContain(job.id);
    const nextObserver = await claimNextJob('worker-timeout-recovery-again', {
      now: '2030-01-01 01:05:00', leaseSeconds: 30,
    });
    expect(nextObserver.lastWorkerError.code).toBe(dbmod.R_TIMEOUT_RECOVERY_PENDING);
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
    expect(done.error).toBeNull();
    expect(done.lastWorkerError).toBeNull();
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

  it('cancel versus complete has exactly one terminal winner and never overwrites completion', async () => {
    const created = await createJobForUser(alice.id, { jobType: 'generic' });
    const claimed = await claimNextJob('worker-race', { now: T0, leaseSeconds: 30 });
    const settled = await Promise.allSettled([
      cancelJobForUser(alice.id, created.id),
      completeJobByWorker(created.id, 'worker-race', claimed.claimToken, { now: T0_PLUS_10 }),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const after = await getJobForUser(created.id, alice.id);
    expect(['completed', 'canceled']).toContain(after.status);
    if (after.status === 'completed') {
      await expect(cancelJobForUser(alice.id, created.id)).rejects.toMatchObject({ code: 'JOB_NOT_CANCELABLE' });
      expect((await getJobForUser(created.id, alice.id)).status).toBe('completed');
    } else {
      await expect(completeJobByWorker(created.id, 'worker-race', claimed.claimToken, { now: T0_PLUS_20 }))
        .rejects.toMatchObject({ code: 'CLAIM_LOST' });
    }
  });

  it('publication that owns the job lock forces later cancellation to observe its output', async () => {
    const created = await createJobForUser(alice.id, { jobType: 'r.runtime.check' });
    const claimed = await claimNextJob('worker-output-race', { now: T0, leaseSeconds: 30 });
    const pool = await dbmod.connect();
    const barrier = await pool.connect();
    const observer = await pool.connect();
    try {
      await barrier.query('BEGIN');
      await barrier.query('LOCK TABLE job_artifacts IN ACCESS EXCLUSIVE MODE');
      const publication = createJobArtifactByWorker(
        created.id,
        'worker-output-race',
        claimed.claimToken,
        { artifactType: 'r_runtime_check', storageKind: 'metadata_only', metadata: { ok: true } },
        { now: T0_PLUS_10 }
      );
      await waitForBlockedPgQuery(observer, 'insert into job_artifacts');
      const cancellation = cancelJobForUser(alice.id, created.id)
        .then((value) => ({ value }), (error) => ({ error }));
      await waitForBlockedPgQuery(observer, 'select * from jobs where id');
      await barrier.query('COMMIT');

      await expect(publication).resolves.toMatchObject({ jobId: created.id });
      const cancelOutcome = await cancellation;
      expect(cancelOutcome.error).toMatchObject({ code: 'JOB_NOT_CANCELABLE' });
      expect((await getJobArtifactsByJobId(created.id))).toHaveLength(1);
      expect((await getJobForUser(created.id, alice.id)).status).toBe('running');
      await expect(cancelJobForUser(alice.id, created.id))
        .rejects.toMatchObject({ code: 'JOB_NOT_CANCELABLE' });
      await completeJobByWorker(
        created.id, 'worker-output-race', claimed.claimToken, { now: T0_PLUS_20 }
      );
      expect((await getJobForUser(created.id, alice.id)).status).toBe('completed');
    } finally {
      await barrier.query('ROLLBACK').catch(() => {});
      barrier.release();
      observer.release();
    }
  });

  it('cancellation that owns the job lock makes a later publisher roll back', async () => {
    const created = await createJobForUser(alice.id, { jobType: 'r.runtime.check' });
    const claimed = await claimNextJob('worker-cancel-wins', { now: T0, leaseSeconds: 30 });
    const pool = await dbmod.connect();
    const barrier = await pool.connect();
    const observer = await pool.connect();
    try {
      await barrier.query('BEGIN');
      await barrier.query('LOCK TABLE job_artifacts IN ACCESS EXCLUSIVE MODE');
      const cancellation = cancelJobForUser(alice.id, created.id);
      await waitForBlockedPgQuery(observer, 'select 1 from job_artifacts');
      const publication = createJobArtifactByWorker(
        created.id,
        'worker-cancel-wins',
        claimed.claimToken,
        { artifactType: 'r_runtime_check', storageKind: 'metadata_only', metadata: { ok: true } },
        { now: T0_PLUS_10 }
      ).then((value) => ({ value }), (error) => ({ error }));
      await waitForBlockedPgQuery(observer, 'select * from jobs where id');
      await barrier.query('COMMIT');

      await expect(cancellation).resolves.toMatchObject({ status: 'canceled' });
      const publishOutcome = await publication;
      expect(publishOutcome.error).toMatchObject({ code: 'CLAIM_LOST' });
      expect((await getJobArtifactsByJobId(created.id))).toHaveLength(0);
      expect((await getJobForUser(created.id, alice.id)).status).toBe('canceled');
    } finally {
      await barrier.query('ROLLBACK').catch(() => {});
      barrier.release();
      observer.release();
    }
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
      'resultAnalysisObjectId', 'retryOfJobId', 'startedAt', 'status', 'updatedAt'
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
