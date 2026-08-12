import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

const config = require('./config');
const dbmod = require('./pgDatabase');
const {
  createUser, createJobForUser, getJobForUser,
  listJobsForUser, cancelJobForUser, getWorkerJob, claimNextJob, reapExpiredJobs,
  setJobScheduling, createAnalysisObjectForUser, verifyAnalysisObjectOwner,
} = dbmod;

const CONFIGURED = config.hasPostgresConnection();

const worker = require('./jobWorker');
const { createJobWorker, generateWorkerId, DEFAULT_HANDLERS, UNSUPPORTED_JOB_TYPE } = worker;

// Deterministic UTC instants in canonical 'YYYY-MM-DD HH:MM:SS' format (accepted
// as a timestamp literal by Postgres too).
const T0 = '2030-01-01 00:00:00';
const LATER = '2030-01-01 01:00:00'; // well past any 30s lease taken at T0

// A db wrapper that counts contract calls so tests can assert the worker actually
// claimed / heartbeated / completed / failed / reaped through the contract. The
// wrappers forward the underlying (async) call's promise unchanged — the worker
// awaits it — while incrementing the counter synchronously.
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

afterAll(async () => {
  if (!CONFIGURED) return;
  await dbmod.close();
});

describe.skipIf(!CONFIGURED)('job worker — lifecycle (claim / heartbeat / complete / fail)', () => {
  beforeEach(async () => {
    await dbmod.resetSchemaForTests();
    alice = await createUser('alice@example.com', 'password123', 'Alice');
    bob = await createUser('bob@example.com', 'password123', 'Bob');
  });

  it('runs one tick with no jobs and does nothing (idle no-op)', async () => {
    const w = createJobWorker({ db: dbmod, now: () => T0, logger: silentLogger() });
    const res = await w.runOnce();
    expect(res.status).toBe('idle');
    expect(res.reaped).toEqual({ requeued: [], failed: [] });
  });

  it('claims a queued supported job and completes it through the contract', async () => {
    const job = await newGenericJob();
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

    const after = await getJobForUser(job.id, alice.id);
    expect(after.status).toBe('completed');
    expect(after.completedAt).toBeTruthy();
  });

  it('heartbeats before/while processing (lease extended via contract)', async () => {
    await newGenericJob();
    const spy = spyDb(dbmod);
    const w = createJobWorker({ db: spy, now: () => T0, logger: silentLogger() });
    await w.runOnce();
    // pre-handler heartbeat + the noop handler's cooperative ctx.heartbeat()
    expect(spy._calls.heartbeat).toBeGreaterThanOrEqual(1);
  });

  it('writes durable logs for claim, handler start, and completion', async () => {
    const job = await newGenericJob();
    const w = createJobWorker({ db: dbmod, now: () => T0, logger: silentLogger() });
    await w.runOnce();
    const after = await getJobForUser(job.id, alice.id);
    const messages = after.logs.map((l) => l.message);
    expect(messages.some((m) => /claimed by worker/i.test(m))).toBe(true);
    expect(messages.some((m) => /handler started/i.test(m))).toBe(true);
    expect(messages.some((m) => /handler completed/i.test(m))).toBe(true);
  });

  it('fails a handler error with durable error + logs (no resurrection)', async () => {
    const job = await newGenericJob();
    const boom = async () => { throw new Error('handler exploded'); };
    const w = createJobWorker({
      db: dbmod, now: () => T0, logger: silentLogger(),
      handlers: { generic: boom },
    });
    const res = await w.runOnce();
    expect(res.status).toBe('failed');
    expect(res.error.code).toBe('HANDLER_ERROR');

    const after = await getJobForUser(job.id, alice.id);
    expect(after.status).toBe('failed');
    expect(after.error).toBeTruthy();
    expect(after.error.code).toBe('HANDLER_ERROR');
    expect(after.error.message).toBe('Handler failed.');
    expect(after.logs.some((l) => /handler failed/i.test(l.message))).toBe(true);
  });

  it('never persists or logs raw details from an unknown handler failure', async () => {
    const job = await newGenericJob();
    const leaked = 'postgres://db.internal:5432/tenant secret=/vault/private/key constraint=users_email_key';
    const boom = async () => {
      throw Object.assign(new Error(leaked), { code: 'DB_FAILURE' });
    };
    const errors = [];
    const w = createJobWorker({
      db: dbmod,
      now: () => T0,
      logger: { info: () => {}, warn: () => {}, error: (message) => errors.push(message) },
      handlers: { generic: boom },
    });

    const res = await w.runOnce();
    const after = await getJobForUser(job.id, alice.id);
    expect(res).toMatchObject({
      status: 'failed',
      error: { code: 'HANDLER_ERROR', message: 'Handler failed.' },
    });
    expect(after.error).toEqual({ code: 'HANDLER_ERROR', message: 'Handler failed.' });
    const visible = JSON.stringify({ res, after, errors });
    for (const forbidden of ['db.internal', '/vault/private/key', 'users_email_key', 'secret=']) {
      expect(visible).not.toContain(forbidden);
    }
    expect(errors.some((message) => message.includes('DB_FAILURE'))).toBe(true);
  });

  it('does not expose claim_token through owner-facing job reads', async () => {
    const job = await newGenericJob();
    const w = createJobWorker({ db: dbmod, now: () => T0, logger: silentLogger() });
    await w.runOnce();

    const owned = await getJobForUser(job.id, alice.id);
    expect(owned).not.toHaveProperty('claimToken');
    expect(owned).not.toHaveProperty('claim_token');
    expect(JSON.stringify(owned)).not.toMatch(/wct_/); // claim-token prefix

    for (const j of await listJobsForUser(alice.id)) {
      expect(j).not.toHaveProperty('claimToken');
      expect(JSON.stringify(j)).not.toMatch(/wct_/);
    }

    // The worker view DOES carry the token but is never wired to a client route;
    // after completion the token is cleared regardless.
    expect((await getWorkerJob(job.id)).claimToken).toBeNull();
  });
});

describe.skipIf(!CONFIGURED)('job worker — unsupported job types', () => {
  beforeEach(async () => {
    await dbmod.resetSchemaForTests();
    alice = await createUser('alice@example.com', 'password123', 'Alice');
  });

  it('claims then fails an unregistered job type with UNSUPPORTED_JOB_TYPE', async () => {
    // `normalize` is a valid DB job type but has NO registered handler in this branch.
    const job = await createJobForUser(alice.id, { jobType: 'normalize' });
    const spy = spyDb(dbmod);
    const w = createJobWorker({ db: spy, now: () => T0, logger: silentLogger() });
    const res = await w.runOnce();

    expect(res.status).toBe('unsupported');
    expect(spy._calls.claim).toBe(1);
    expect(spy._calls.fail).toBe(1);

    const after = await getJobForUser(job.id, alice.id);
    expect(after.status).toBe('failed');
    expect(after.error.code).toBe(UNSUPPORTED_JOB_TYPE);
    // A failed unsupported job is terminal — it is NOT re-queued / looped.
    expect(after.logs.some((l) => /unsupported job type/i.test(l.message))).toBe(true);
  });

  it('default registry contains only reviewed durable worker handlers', () => {
    // The OTHER analytical job types remain deliberately unregistered (failed as
    // UNSUPPORTED_JOB_TYPE); only the noop, the metadata-only checkpoint placeholder,
    // the two metadata-only R bridge operations, and the first real pipeline
    // (pbmc.pipeline.v1) are runnable in this branch.
    expect(Object.keys(DEFAULT_HANDLERS).sort()).toEqual(['cellchat.infer.v1', 'checkpoint.fork.v1', 'checkpoint.load.v1', 'checkpoint.noop', 'checkpoint.save.v1', 'condition.pseudobulk_de.v1', 'deg.find_markers.v1', 'enrichment.gsea.v1', 'expert.r.v1', 'explore.summarize.v1', 'generic', 'pbmc.pipeline.v1', 'r.object.inspect', 'r.runtime.check', 'seurat.multisample.v1', 'seurat.pipeline.v1', 'spatial.seurat.v1']);
  });
});

describe.skipIf(!CONFIGURED)('job worker — duplicate workers, cancel, reap', () => {
  beforeEach(async () => {
    await dbmod.resetSchemaForTests();
    alice = await createUser('alice@example.com', 'password123', 'Alice');
  });

  it('two workers do not both complete the same job', async () => {
    const job = await newGenericJob();
    const a = createJobWorker({ db: dbmod, workerId: 'worker_a', now: () => T0, logger: silentLogger() });
    const b = createJobWorker({ db: dbmod, workerId: 'worker_b', now: () => T0, logger: silentLogger() });

    const resA = await a.runOnce();
    const resB = await b.runOnce();

    const outcomes = [resA.status, resB.status].sort();
    expect(outcomes).toEqual(['completed', 'idle']); // exactly one winner
    expect((await getJobForUser(job.id, alice.id)).status).toBe('completed');
  });

  it('a second worker cannot claim a job already claimed by another', async () => {
    await newGenericJob();
    const first = await claimNextJob('worker_a', { now: T0, leaseSeconds: 30 });
    expect(first).not.toBeNull();
    const second = await claimNextJob('worker_b', { now: T0, leaseSeconds: 30 });
    expect(second).toBeNull();
  });

  it('a canceled queued job is never claimed', async () => {
    const job = await newGenericJob();
    await cancelJobForUser(alice.id, job.id);
    const w = createJobWorker({ db: dbmod, now: () => T0, logger: silentLogger() });
    const res = await w.runOnce();
    expect(res.status).toBe('idle');
    expect((await getJobForUser(job.id, alice.id)).status).toBe('canceled');
  });

  it('cancel during handler makes completion a claim-loss no-op (not resurrected)', async () => {
    const job = await newGenericJob();
    // Handler simulates a user canceling the job while it runs.
    const cancelMidRun = async (ctx) => {
      await cancelJobForUser(alice.id, ctx.job.id);
      return { result: { ok: true } };
    };
    const w = createJobWorker({
      db: dbmod, now: () => T0, logger: silentLogger(),
      handlers: { generic: cancelMidRun },
    });
    const res = await w.runOnce();
    expect(res.status).toBe('claim_lost');
    // The job stays canceled — the worker must NOT flip it to completed.
    expect((await getJobForUser(job.id, alice.id)).status).toBe('canceled');
  });

  it('an expired running job is reaped (requeued) then processed in the same tick', async () => {
    const job = await newGenericJob();
    await setJobScheduling(job.id, { maxAttempts: 2 }); // allow a re-claim after expiry
    const stale = await claimNextJob('worker_stale', { now: T0, leaseSeconds: 30 });
    expect(stale.id).toBe(job.id);

    const w = createJobWorker({ db: dbmod, now: () => LATER, logger: silentLogger() });
    const res = await w.runOnce();

    expect(res.reaped.requeued).toContain(job.id);
    expect(res.status).toBe('completed');
    expect((await getJobForUser(job.id, alice.id)).status).toBe('completed');
  });

  it('an expired running job with no attempts left is reaped to failed', async () => {
    const job = await newGenericJob(); // default max_attempts = 1
    const stale = await claimNextJob('worker_stale', { now: T0, leaseSeconds: 30 });
    expect(stale.id).toBe(job.id);

    const w = createJobWorker({ db: dbmod, now: () => LATER, logger: silentLogger() });
    const res = await w.runOnce();

    expect(res.reaped.failed).toContain(job.id);
    expect(res.status).toBe('idle'); // nothing left claimable
    const after = await getJobForUser(job.id, alice.id);
    expect(after.status).toBe('failed');
    expect(after.error.code).toBe('LEASE_EXPIRED');
  });

  it('a stale worker cannot complete after its lease is reaped', async () => {
    const job = await newGenericJob();
    await setJobScheduling(job.id, { maxAttempts: 2 });
    const stale = await claimNextJob('worker_stale', { now: T0, leaseSeconds: 30 });

    await reapExpiredJobs({ now: LATER }); // requeues, clearing the stale claim
    await expect(
      dbmod.completeJobByWorker(job.id, 'worker_stale', stale.claimToken, { now: LATER })
    ).rejects.toThrow(/claim/i); // CLAIM_LOST
    // The job is back in the queue, not completed.
    expect((await getJobForUser(job.id, alice.id)).status).toBe('queued');
  });

  it('does not touch a live (unexpired) lease during reap', async () => {
    const job = await newGenericJob();
    await claimNextJob('worker_live', { now: T0, leaseSeconds: 30 });
    // Reap at a time still inside the lease window: no recovery.
    const w = createJobWorker({ db: dbmod, now: () => '2030-01-01 00:00:10', logger: silentLogger() });
    const res = await w.runOnce();
    expect(res.reaped.requeued).toEqual([]);
    expect(res.reaped.failed).toEqual([]);
    expect(res.status).toBe('idle'); // job is owned by worker_live, not claimable
    expect((await getJobForUser(job.id, alice.id)).status).toBe('running');
  });
});

describe.skipIf(!CONFIGURED)('job worker — R boundary (project membership does not widen R ownership)', () => {
  beforeEach(async () => {
    await dbmod.resetSchemaForTests();
    alice = await createUser('alice@example.com', 'password123', 'Alice');
    bob = await createUser('bob@example.com', 'password123', 'Bob');
  });

  it('processing a job does not grant another user ownership of an R object', async () => {
    const obj = await createAnalysisObjectForUser(alice.id, { objectType: 'seurat', name: 'aliceObj' });
    const job = await newGenericJob();
    const w = createJobWorker({ db: dbmod, now: () => T0, logger: silentLogger() });
    await w.runOnce();

    // The worker ran with no R access at all; object ownership is unchanged and
    // remains keyed to the owner — bob (a would-be co-member) cannot claim it.
    expect(await verifyAnalysisObjectOwner(alice.id, obj.id)).toBe(true);
    expect(await verifyAnalysisObjectOwner(bob.id, obj.id)).toBe(false);
    expect((await getJobForUser(job.id, alice.id)).status).toBe('completed');
  });
});

describe.skipIf(!CONFIGURED)('job worker — start/stop lifecycle (fake timers, no leaks)', () => {
  beforeEach(async () => {
    await dbmod.resetSchemaForTests();
    alice = await createUser('alice@example.com', 'password123', 'Alice');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() then stop() runs ticks then leaves no live timer', async () => {
    // Under fake timers the real Postgres driver's async substrate is frozen, so a real
    // claim could never settle inside advanceTimersByTimeAsync. This test only exercises
    // the worker's timer loop (start schedules ticks; stop cancels them, leaving no live
    // timer), so a microtask-resolvable stub db with an idle claim is sufficient and
    // deterministic — real claim/heartbeat SQL is covered by jobs-worker-contract.
    vi.useFakeTimers();
    const stub = {
      reapExpiredJobs: async () => ({ requeued: [], failed: [] }),
      claimNextJob: async () => null,
    };
    const spy = spyDb(stub);
    const w = createJobWorker({ db: spy, pollIntervalMs: 1000, now: () => T0, logger: silentLogger() });

    expect(w.isRunning()).toBe(false);
    w.start();
    expect(w.isRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(1); // run the first tick (a claim attempt)
    expect(spy._calls.claim).toBeGreaterThanOrEqual(1);

    await w.stop();
    expect(w.isRunning()).toBe(false);

    // After stop, advancing time must NOT trigger any further claims.
    const claimsAtStop = spy._calls.claim;
    await vi.advanceTimersByTimeAsync(5000);
    expect(spy._calls.claim).toBe(claimsAtStop);
  });

  it('start() is idempotent and stop() is safe to call twice', async () => {
    // Timers are never advanced here (the scheduled tick never fires), so this only
    // asserts start()/stop() bookkeeping — no db work happens.
    vi.useFakeTimers();
    const w = createJobWorker({ db: dbmod, pollIntervalMs: 1000, now: () => T0, logger: silentLogger() });
    w.start();
    w.start(); // no throw, still single loop
    expect(w.isRunning()).toBe(true);
    await w.stop();
    await w.stop(); // no throw
    expect(w.isRunning()).toBe(false);
  });

  it('never overlaps two claims inside one worker process while a handler is pending', async () => {
    vi.useFakeTimers();
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    let claims = 0;
    const stub = {
      reapExpiredJobs: async () => ({ requeued: [], failed: [] }),
      claimNextJob: async () => {
        claims += 1;
        return claims === 1 ? {
          id: 'job_first', jobType: 'generic', ownerUserId: alice.id,
          claimToken: 'wct_first', projectId: null, status: 'running',
        } : {
          id: 'job_second', jobType: 'generic', ownerUserId: alice.id,
          claimToken: 'wct_second', projectId: null, status: 'running',
        };
      },
      appendJobLogByWorker: async () => ({}),
      heartbeatJob: async () => ({ status: 'running' }),
      completeJobByWorker: async () => ({ status: 'completed' }),
      failJobByWorker: async () => ({ status: 'failed' }),
    };
    const w = createJobWorker({
      db: stub,
      pollIntervalMs: 10,
      handlers: { generic: async () => { await pending; return { result: { ok: true } }; } },
      logger: silentLogger(),
    });
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(claims).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(claims).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await w.stop();
    expect(claims).toBe(1);
  });
});

describe.skipIf(!CONFIGURED)('job worker — startup config (disabled by default)', () => {
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

// Lease renewal while a long R bridge call is in flight. Real Seurat/DEG/checkpoint
// R calls run tens of seconds to minutes — longer than the lease — so the worker must
// renew the claim from a timer while the awaited call is pending. Without this the
// lease expires mid-run and the job is reaped/retried into failure. Mocked-callR unit
// tests (which return instantly) can never exercise this, so it is asserted directly
// here with fake timers and a controllable bridge call.
describe.skipIf(!CONFIGURED)('job worker — lease renewal during a long R bridge call', () => {
  beforeEach(async () => {
    await dbmod.resetSchemaForTests();
    alice = await createUser('alice@example.com', 'password123', 'Alice');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('heartbeats repeatedly (renewing the lease) while a slow R call is awaited', async () => {
    // Under fake timers the real Postgres driver's async substrate is frozen, so a real
    // claim/heartbeat could never settle inside advanceTimersByTimeAsync. This test
    // isolates the worker's lease-renewal TIMER behaviour, so a microtask-resolvable stub
    // db (an already-claimed job) is sufficient and deterministic — the renewal simply
    // calls db.heartbeatJob on its interval, which the spy counts.
    vi.useFakeTimers();
    const claimed = {
      id: 'job_lease', jobType: 'generic', ownerUserId: alice.id,
      claimToken: 'wct_lease', projectId: null, analysisObjectId: null, status: 'running',
    };
    const stubDb = {
      reapExpiredJobs: async () => ({ requeued: [], failed: [] }),
      claimNextJob: async () => claimed,
      appendJobLogByWorker: async () => ({}),
      heartbeatJob: async () => ({ status: 'running' }),
      completeJobByWorker: async () => ({ status: 'completed' }),
      failJobByWorker: async () => ({ status: 'failed' }),
    };

    // A bridge whose runRBridgeOperation blocks until we release it, so we can advance
    // fake time (firing the renewal interval) while the handler is inside the call.
    let releaseBridge;
    const bridgePending = new Promise((resolve) => { releaseBridge = () => resolve({ ok: true }); });
    const fakeBridge = { runRBridgeOperation: () => bridgePending };

    const handlers = {
      generic: async (ctx) => {
        await ctx.runRBridgeOperation({ operation: 'r.runtime.check' });
        return { result: { ok: true } };
      },
    };

    const spy = spyDb(stubDb);
    const w = createJobWorker({
      db: spy,
      rBridge: fakeBridge,
      callR: () => {},
      handlers,
      leaseSeconds: 10, // exact accepted floor; renewal must fire every third-lease window
      now: () => T0,
      logger: silentLogger(),
    });

    const runPromise = w.runOnce();
    // Reach the awaited bridge call and register the interval.
    await vi.advanceTimersByTimeAsync(0);
    const beforeRenewals = spy._calls.heartbeat; // 1 pre-handler heartbeat
    // Two renewal windows fire while the call is still pending.
    await vi.advanceTimersByTimeAsync(3333);
    await vi.advanceTimersByTimeAsync(3333);
    expect(spy._calls.heartbeat).toBeGreaterThanOrEqual(beforeRenewals + 2);

    releaseBridge();
    const res = await runPromise;
    expect(res.status).toBe('completed');
  });

  it('keeps renewing while committed-output storage validation is pending', async () => {
    vi.useFakeTimers();
    const claimed = {
      id: 'job_recovery_lease', jobType: 'generic', ownerUserId: alice.id,
      claimToken: 'wct_recovery_lease', projectId: null, analysisObjectId: null,
      status: 'running',
    };
    let heartbeatCalls = 0;
    let handlerCalls = 0;
    let inspectionStarted = false;
    let releaseInspection;
    const inspectionPending = new Promise((resolve) => {
      releaseInspection = () => resolve({ ok: true });
    });
    const stubDb = {
      reapExpiredJobs: async () => ({ requeued: [], failed: [] }),
      claimNextJob: async () => claimed,
      appendJobLogByWorker: async () => ({}),
      heartbeatJob: async () => { heartbeatCalls += 1; return { status: 'running' }; },
      resumeCommittedJobByWorker: async (_id, _wid, _token, opts) => {
        await opts.inspectStorageObject('projects/proj_x/checkpoints/job_x/checkpoint.rds', {});
        return { resumed: true, committedOutput: true };
      },
      completeJobByWorker: async () => ({ status: 'completed' }),
      failJobByWorker: async () => ({ status: 'failed' }),
    };
    const worker = createJobWorker({
      db: stubDb,
      handlers: { generic: async () => { handlerCalls += 1; return {}; } },
      storageProvider: {
        inspect: () => {
          inspectionStarted = true;
          return inspectionPending;
        },
        remove: () => true,
      },
      leaseSeconds: 10,
      now: () => T0,
      logger: silentLogger(),
    });

    const run = worker.runOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(inspectionStarted).toBe(true);
    const beforeRenewals = heartbeatCalls;
    await vi.advanceTimersByTimeAsync(3333);
    await vi.advanceTimersByTimeAsync(3333);
    expect(heartbeatCalls).toBeGreaterThanOrEqual(beforeRenewals + 2);

    releaseInspection();
    await expect(run).resolves.toMatchObject({ status: 'completed', recovered: true });
    expect(handlerCalls).toBe(0);
  });

  it('keeps renewing after a transient heartbeat failure and stops only on claim loss', async () => {
    vi.useFakeTimers();
    const claimed = {
      id: 'job_transient_lease', jobType: 'generic', ownerUserId: alice.id,
      claimToken: 'wct_transient', projectId: null, analysisObjectId: null, status: 'running',
    };
    let heartbeatCalls = 0;
    const stubDb = {
      reapExpiredJobs: async () => ({ requeued: [], failed: [] }),
      claimNextJob: async () => claimed,
      appendJobLogByWorker: async () => ({}),
      heartbeatJob: async () => {
        heartbeatCalls += 1;
        if (heartbeatCalls === 2) throw Object.assign(new Error('temporary database outage'), { code: 'ECONNRESET' });
        return { status: 'running' };
      },
      completeJobByWorker: async () => ({ status: 'completed' }),
      failJobByWorker: async () => ({ status: 'failed' }),
    };
    let releaseBridge;
    const bridgePending = new Promise((resolve) => { releaseBridge = () => resolve({ ok: true }); });
    const w = createJobWorker({
      db: stubDb,
      rBridge: { runRBridgeOperation: () => bridgePending },
      callR: () => {},
      handlers: {
        generic: async (ctx) => {
          await ctx.runRBridgeOperation({ operation: 'r.runtime.check' });
          return { result: { ok: true } };
        },
      },
      leaseSeconds: 30,
      logger: silentLogger(),
    });
    const run = w.runOnce();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10000); // transient failure
    await vi.advanceTimersByTimeAsync(10000); // successful later renewal
    expect(heartbeatCalls).toBeGreaterThanOrEqual(3); // pre-handler + two timer attempts
    releaseBridge();
    await expect(run).resolves.toMatchObject({ status: 'completed' });
  });

  it('stops and awaits an in-flight renewal before writing the indeterminate grace lease', async () => {
    vi.useFakeTimers();
    const claimed = {
      id: 'job_timeout_lease_fence', jobType: 'generic', ownerUserId: alice.id,
      claimToken: 'wct_timeout_lease_fence', projectId: null,
      analysisObjectId: null, status: 'running',
    };
    const events = [];
    let heartbeatCalls = 0;
    let resolveRenewal;
    const renewalPending = new Promise((resolve) => { resolveRenewal = resolve; });
    const stubDb = {
      reapExpiredJobs: async () => ({ requeued: [], failed: [] }),
      claimNextJob: async () => claimed,
      appendJobLogByWorker: async () => ({}),
      heartbeatJob: async () => {
        heartbeatCalls += 1;
        if (heartbeatCalls === 2) {
          events.push('renewal-started');
          await renewalPending;
          events.push('renewal-finished');
        }
        return { status: 'running' };
      },
      deferIndeterminateRTimeoutByWorker: async () => {
        events.push('deferred');
        return { status: 'running' };
      },
      failJobByWorker: async () => ({ status: 'failed' }),
      completeJobByWorker: async () => ({ status: 'completed' }),
    };
    let rejectBridge;
    const bridgePending = new Promise((_resolve, reject) => {
      rejectBridge = () => reject(Object.assign(new Error('timeout'), { code: 'R_TIMEOUT' }));
    });
    const worker = createJobWorker({
      db: stubDb,
      rBridge: { runRBridgeOperation: () => bridgePending },
      callR: () => {},
      handlers: {
        generic: async (ctx) => {
          await ctx.runRBridgeOperation({ operation: 'r.runtime.check' });
          return {};
        },
      },
      leaseSeconds: 10,
      logger: silentLogger(),
    });

    const run = worker.runOnce();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3333);
    expect(events).toEqual(['renewal-started']);
    rejectBridge();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['renewal-started']);

    resolveRenewal();
    await expect(run).resolves.toMatchObject({ status: 'indeterminate' });
    expect(events).toEqual(['renewal-started', 'renewal-finished', 'deferred']);
  });
});

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}
