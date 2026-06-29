import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const dbmod = require('./database');
const {
  initDatabase, closeDatabase, createUser, createJobForUser, getJobForUser,
  listJobsForUser, cancelJobForUser, getWorkerJob, claimNextJob, reapExpiredJobs,
  setJobScheduling, createAnalysisObjectForUser, verifyAnalysisObjectOwner,
} = dbmod;

const worker = require('./jobWorker');
const { createJobWorker, generateWorkerId, DEFAULT_HANDLERS, UNSUPPORTED_JOB_TYPE } = worker;

// Deterministic UTC instants in SQLite's canonical 'YYYY-MM-DD HH:MM:SS' format.
const T0 = '2030-01-01 00:00:00';
const LATER = '2030-01-01 01:00:00'; // well past any 30s lease taken at T0

// A db wrapper that counts contract calls so tests can assert the worker actually
// claimed / heartbeated / completed / failed / reaped through the contract.
function spyDb(real) {
  const calls = { claim: 0, heartbeat: 0, complete: 0, fail: 0, reap: 0, log: 0 };
  return {
    ...real,
    _calls: calls,
    claimNextJob: (...a) => { calls.claim++; return real.claimNextJob(...a); },
    heartbeatJob: (...a) => { calls.heartbeat++; return real.heartbeatJob(...a); },
    completeJobByWorker: (...a) => { calls.complete++; return real.completeJobByWorker(...a); },
    failJobByWorker: (...a) => { calls.fail++; return real.failJobByWorker(...a); },
    reapExpiredJobs: (...a) => { calls.reap++; return real.reapExpiredJobs(...a); },
    appendJobLogByWorker: (...a) => { calls.log++; return real.appendJobLogByWorker(...a); },
  };
}

let alice;
let bob;

function newGenericJob(owner = alice) {
  return createJobForUser(owner.id, { jobType: 'generic' });
}

describe('job worker — lifecycle (claim / heartbeat / complete / fail)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    alice = createUser('alice@example.com', 'password123', 'Alice');
    bob = createUser('bob@example.com', 'password123', 'Bob');
  });
  afterEach(() => closeDatabase());

  it('runs one tick with no jobs and does nothing (idle no-op)', async () => {
    const w = createJobWorker({ db: dbmod, now: () => T0, logger: silentLogger() });
    const res = await w.runOnce();
    expect(res.status).toBe('idle');
    expect(res.reaped).toEqual({ requeued: [], failed: [] });
  });

  it('claims a queued supported job and completes it through the contract', async () => {
    const job = newGenericJob();
    const spy = spyDb(dbmod);
    const w = createJobWorker({ db: spy, now: () => T0, logger: silentLogger() });
    const res = await w.runOnce();

    expect(res.status).toBe('completed');
    expect(res.jobId).toBe(job.id);
    expect(res.jobType).toBe('generic');
    expect(res.result).toEqual({ ok: true, handled: 'generic', noop: true });

    expect(spy._calls.claim).toBe(1);
    expect(spy._calls.complete).toBe(1);
    expect(spy._calls.fail).toBe(0);

    const after = getJobForUser(job.id, alice.id);
    expect(after.status).toBe('completed');
    expect(after.completedAt).toBeTruthy();
  });

  it('heartbeats before/while processing (lease extended via contract)', async () => {
    newGenericJob();
    const spy = spyDb(dbmod);
    const w = createJobWorker({ db: spy, now: () => T0, logger: silentLogger() });
    await w.runOnce();
    // pre-handler heartbeat + the noop handler's cooperative ctx.heartbeat()
    expect(spy._calls.heartbeat).toBeGreaterThanOrEqual(1);
  });

  it('writes durable logs for claim, handler start, and completion', async () => {
    const job = newGenericJob();
    const w = createJobWorker({ db: dbmod, now: () => T0, logger: silentLogger() });
    await w.runOnce();
    const after = getJobForUser(job.id, alice.id);
    const messages = after.logs.map((l) => l.message);
    expect(messages.some((m) => /claimed by worker/i.test(m))).toBe(true);
    expect(messages.some((m) => /handler started/i.test(m))).toBe(true);
    expect(messages.some((m) => /handler completed/i.test(m))).toBe(true);
  });

  it('fails a handler error with durable error + logs (no resurrection)', async () => {
    const job = newGenericJob();
    const boom = async () => { throw new Error('handler exploded'); };
    const w = createJobWorker({
      db: dbmod, now: () => T0, logger: silentLogger(),
      handlers: { generic: boom },
    });
    const res = await w.runOnce();
    expect(res.status).toBe('failed');
    expect(res.error.code).toBe('HANDLER_ERROR');

    const after = getJobForUser(job.id, alice.id);
    expect(after.status).toBe('failed');
    expect(after.error).toBeTruthy();
    expect(after.error.code).toBe('HANDLER_ERROR');
    expect(after.error.message).toMatch(/handler exploded/);
    expect(after.logs.some((l) => /handler failed/i.test(l.message))).toBe(true);
  });

  it('does not expose claim_token through owner-facing job reads', async () => {
    const job = newGenericJob();
    const w = createJobWorker({ db: dbmod, now: () => T0, logger: silentLogger() });
    await w.runOnce();

    const owned = getJobForUser(job.id, alice.id);
    expect(owned).not.toHaveProperty('claimToken');
    expect(owned).not.toHaveProperty('claim_token');
    expect(JSON.stringify(owned)).not.toMatch(/wct_/); // claim-token prefix

    for (const j of listJobsForUser(alice.id)) {
      expect(j).not.toHaveProperty('claimToken');
      expect(JSON.stringify(j)).not.toMatch(/wct_/);
    }

    // The worker view DOES carry the token but is never wired to a client route;
    // after completion the token is cleared regardless.
    expect(getWorkerJob(job.id).claimToken).toBeNull();
  });
});

describe('job worker — unsupported job types', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    alice = createUser('alice@example.com', 'password123', 'Alice');
  });
  afterEach(() => closeDatabase());

  it('claims then fails an unregistered job type with UNSUPPORTED_JOB_TYPE', async () => {
    // `normalize` is a valid DB job type but has NO registered handler in this branch.
    const job = createJobForUser(alice.id, { jobType: 'normalize' });
    const spy = spyDb(dbmod);
    const w = createJobWorker({ db: spy, now: () => T0, logger: silentLogger() });
    const res = await w.runOnce();

    expect(res.status).toBe('unsupported');
    expect(spy._calls.claim).toBe(1);
    expect(spy._calls.fail).toBe(1);

    const after = getJobForUser(job.id, alice.id);
    expect(after.status).toBe('failed');
    expect(after.error.code).toBe(UNSUPPORTED_JOB_TYPE);
    // A failed unsupported job is terminal — it is NOT re-queued / looped.
    expect(after.logs.some((l) => /unsupported job type/i.test(l.message))).toBe(true);
  });

  it('default registry supports `generic`, `checkpoint.noop`, `r.runtime.check`, and `r.object.inspect`', () => {
    // The real analytical job types remain deliberately unregistered (failed as
    // UNSUPPORTED_JOB_TYPE); only the noop, the metadata-only checkpoint placeholder,
    // and the two metadata-only R bridge operations are runnable in this branch.
    expect(Object.keys(DEFAULT_HANDLERS).sort()).toEqual(['checkpoint.noop', 'generic', 'r.object.inspect', 'r.runtime.check']);
  });
});

describe('job worker — duplicate workers, cancel, reap', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    alice = createUser('alice@example.com', 'password123', 'Alice');
  });
  afterEach(() => closeDatabase());

  it('two workers do not both complete the same job', async () => {
    const job = newGenericJob();
    const a = createJobWorker({ db: dbmod, workerId: 'worker_a', now: () => T0, logger: silentLogger() });
    const b = createJobWorker({ db: dbmod, workerId: 'worker_b', now: () => T0, logger: silentLogger() });

    const resA = await a.runOnce();
    const resB = await b.runOnce();

    const outcomes = [resA.status, resB.status].sort();
    expect(outcomes).toEqual(['completed', 'idle']); // exactly one winner
    expect(getJobForUser(job.id, alice.id).status).toBe('completed');
  });

  it('a second worker cannot claim a job already claimed by another', () => {
    newGenericJob();
    const first = claimNextJob('worker_a', { now: T0, leaseSeconds: 30 });
    expect(first).not.toBeNull();
    const second = claimNextJob('worker_b', { now: T0, leaseSeconds: 30 });
    expect(second).toBeNull();
  });

  it('a canceled queued job is never claimed', async () => {
    const job = newGenericJob();
    cancelJobForUser(alice.id, job.id);
    const w = createJobWorker({ db: dbmod, now: () => T0, logger: silentLogger() });
    const res = await w.runOnce();
    expect(res.status).toBe('idle');
    expect(getJobForUser(job.id, alice.id).status).toBe('canceled');
  });

  it('cancel during handler makes completion a claim-loss no-op (not resurrected)', async () => {
    const job = newGenericJob();
    // Handler simulates a user canceling the job while it runs.
    const cancelMidRun = async (ctx) => {
      cancelJobForUser(alice.id, ctx.job.id);
      return { result: { ok: true } };
    };
    const w = createJobWorker({
      db: dbmod, now: () => T0, logger: silentLogger(),
      handlers: { generic: cancelMidRun },
    });
    const res = await w.runOnce();
    expect(res.status).toBe('claim_lost');
    // The job stays canceled — the worker must NOT flip it to completed.
    expect(getJobForUser(job.id, alice.id).status).toBe('canceled');
  });

  it('an expired running job is reaped (requeued) then processed in the same tick', async () => {
    const job = newGenericJob();
    setJobScheduling(job.id, { maxAttempts: 2 }); // allow a re-claim after expiry
    const stale = claimNextJob('worker_stale', { now: T0, leaseSeconds: 30 });
    expect(stale.id).toBe(job.id);

    const w = createJobWorker({ db: dbmod, now: () => LATER, logger: silentLogger() });
    const res = await w.runOnce();

    expect(res.reaped.requeued).toContain(job.id);
    expect(res.status).toBe('completed');
    expect(getJobForUser(job.id, alice.id).status).toBe('completed');
  });

  it('an expired running job with no attempts left is reaped to failed', async () => {
    const job = newGenericJob(); // default max_attempts = 1
    const stale = claimNextJob('worker_stale', { now: T0, leaseSeconds: 30 });
    expect(stale.id).toBe(job.id);

    const w = createJobWorker({ db: dbmod, now: () => LATER, logger: silentLogger() });
    const res = await w.runOnce();

    expect(res.reaped.failed).toContain(job.id);
    expect(res.status).toBe('idle'); // nothing left claimable
    const after = getJobForUser(job.id, alice.id);
    expect(after.status).toBe('failed');
    expect(after.error.code).toBe('LEASE_EXPIRED');
  });

  it('a stale worker cannot complete after its lease is reaped', () => {
    const job = newGenericJob();
    setJobScheduling(job.id, { maxAttempts: 2 });
    const stale = claimNextJob('worker_stale', { now: T0, leaseSeconds: 30 });

    reapExpiredJobs({ now: LATER }); // requeues, clearing the stale claim
    expect(() =>
      dbmod.completeJobByWorker(job.id, 'worker_stale', stale.claimToken, { now: LATER })
    ).toThrow(/claim/i); // CLAIM_LOST
    // The job is back in the queue, not completed.
    expect(getJobForUser(job.id, alice.id).status).toBe('queued');
  });

  it('does not touch a live (unexpired) lease during reap', async () => {
    const job = newGenericJob();
    claimNextJob('worker_live', { now: T0, leaseSeconds: 30 });
    // Reap at a time still inside the lease window: no recovery.
    const w = createJobWorker({ db: dbmod, now: () => '2030-01-01 00:00:10', logger: silentLogger() });
    const res = await w.runOnce();
    expect(res.reaped.requeued).toEqual([]);
    expect(res.reaped.failed).toEqual([]);
    expect(res.status).toBe('idle'); // job is owned by worker_live, not claimable
    expect(getJobForUser(job.id, alice.id).status).toBe('running');
  });
});

describe('job worker — R boundary (project membership does not widen R ownership)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    alice = createUser('alice@example.com', 'password123', 'Alice');
    bob = createUser('bob@example.com', 'password123', 'Bob');
  });
  afterEach(() => closeDatabase());

  it('processing a job does not grant another user ownership of an R object', async () => {
    const obj = createAnalysisObjectForUser(alice.id, { objectType: 'seurat', name: 'aliceObj' });
    const job = newGenericJob();
    const w = createJobWorker({ db: dbmod, now: () => T0, logger: silentLogger() });
    await w.runOnce();

    // The worker ran with no R access at all; object ownership is unchanged and
    // remains keyed to the owner — bob (a would-be co-member) cannot claim it.
    expect(verifyAnalysisObjectOwner(alice.id, obj.id)).toBe(true);
    expect(verifyAnalysisObjectOwner(bob.id, obj.id)).toBe(false);
    expect(getJobForUser(job.id, alice.id).status).toBe('completed');
  });
});

describe('job worker — start/stop lifecycle (fake timers, no leaks)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    alice = createUser('alice@example.com', 'password123', 'Alice');
  });
  afterEach(() => {
    vi.useRealTimers();
    closeDatabase();
  });

  it('start() then stop() runs ticks then leaves no live timer', async () => {
    vi.useFakeTimers();
    newGenericJob();
    const spy = spyDb(dbmod);
    const w = createJobWorker({ db: spy, pollIntervalMs: 1000, now: () => T0, logger: silentLogger() });

    expect(w.isRunning()).toBe(false);
    w.start();
    expect(w.isRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(1); // run the first tick (claims + completes)
    expect(spy._calls.claim).toBeGreaterThanOrEqual(1);

    await w.stop();
    expect(w.isRunning()).toBe(false);

    // After stop, advancing time must NOT trigger any further claims.
    const claimsAtStop = spy._calls.claim;
    await vi.advanceTimersByTimeAsync(5000);
    expect(spy._calls.claim).toBe(claimsAtStop);
  });

  it('start() is idempotent and stop() is safe to call twice', async () => {
    vi.useFakeTimers();
    const w = createJobWorker({ db: dbmod, pollIntervalMs: 1000, now: () => T0, logger: silentLogger() });
    w.start();
    w.start(); // no throw, still single loop
    expect(w.isRunning()).toBe(true);
    await w.stop();
    await w.stop(); // no throw
    expect(w.isRunning()).toBe(false);
  });
});

describe('job worker — startup config (disabled by default)', () => {
  const ORIGINAL = process.env.ENABLE_JOB_WORKER;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ENABLE_JOB_WORKER;
    else process.env.ENABLE_JOB_WORKER = ORIGINAL;
  });

  it('generateWorkerId produces a distinct header-safe id', () => {
    const a = generateWorkerId();
    const b = generateWorkerId();
    expect(a).toMatch(/^worker_[0-9a-f]+$/);
    expect(a).not.toBe(b);
  });

  it('createJobWorker rejects an invalid pollIntervalMs', () => {
    expect(() => createJobWorker({ db: dbmod, pollIntervalMs: -1 })).toThrow(/pollIntervalMs/);
  });
});

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}
