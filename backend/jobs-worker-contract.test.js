import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbmod = require('./database');
const {
  initDatabase, closeDatabase, createUser, createAnalysisObjectForUser,
  createJobForUser, getJobForUser, listJobsForUser, updateJobStatusForUser,
  cancelJobForUser, verifyJobOwner, verifyAnalysisObjectOwner, validateJobTransition,
  // worker coordination contract under test
  claimNextJob, heartbeatJob, completeJobByWorker, failJobByWorker, releaseJob,
  reapExpiredJobs, setJobScheduling, getWorkerJob, generateClaimToken,
  // project setup for the project-cancel interaction
  createOrganizationForUser, createProjectForUser, createProjectJob, cancelProjectJob, getProjectJob
} = dbmod;

// Deterministic UTC instants in SQLite's canonical 'YYYY-MM-DD HH:MM:SS' format.
// Worker helpers accept opts.now so lease timing never depends on the wall clock.
const T0 = '2030-01-01 00:00:00';
const T0_PLUS_10 = '2030-01-01 00:00:10';
const T0_PLUS_20 = '2030-01-01 00:00:20';
const LATER = '2030-01-01 01:00:00'; // well past any 30s lease taken at T0
const MUCH_LATER = '2030-01-01 02:00:00';

// ── Temp-file helpers (migration tests need a real file to close/reopen) ──────
function tmpDbPath() {
  return path.join(os.tmpdir(), `jobs_worker_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}.sqlite`);
}
function rmDb(p) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(p + suffix); } catch { /* best-effort */ }
  }
}
// The jobs table as it existed BEFORE this branch (current main: has project_id /
// dataset_id, but none of the worker-coordination columns). Used to prove the
// migration upgrades a pre-existing DB additively.
const LEGACY_JOBS_DDL = `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    owner_user_id INTEGER NOT NULL,
    project_id TEXT,
    analysis_object_id TEXT,
    result_analysis_object_id TEXT,
    dataset_id TEXT,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL,
    parameters_json TEXT NOT NULL DEFAULT '{}',
    logs_json TEXT NOT NULL DEFAULT '[]',
    error_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    canceled_at TEXT
  );
`;
const WORKER_COLUMNS = [
  'worker_id', 'claim_token', 'lease_expires_at', 'heartbeat_at', 'locked_at',
  'attempts', 'max_attempts', 'priority', 'last_worker_error'
];

// ════════════════════════════════════════════════════════════════════════════
// 1. Schema migration (idempotent, additive, non-destructive)
// ════════════════════════════════════════════════════════════════════════════
describe('jobs worker contract — schema migration', () => {
  it('creates all worker-coordination columns and indexes on a fresh database', () => {
    const p = tmpDbPath();
    try {
      initDatabase(p);
      closeDatabase();

      const raw = new Database(p, { readonly: true });
      try {
        const info = raw.prepare('PRAGMA table_info(jobs)').all();
        const names = info.map(c => c.name);
        for (const col of WORKER_COLUMNS) expect(names, `column ${col}`).toContain(col);

        const byName = Object.fromEntries(info.map(c => [c.name, c]));
        // NOT NULL with the documented defaults.
        expect(byName.attempts.notnull).toBe(1);
        expect(String(byName.attempts.dflt_value)).toBe('0');
        expect(byName.max_attempts.notnull).toBe(1);
        expect(String(byName.max_attempts.dflt_value)).toBe('1');
        expect(byName.priority.notnull).toBe(1);
        expect(String(byName.priority.dflt_value)).toBe('0');
        // Lease/claim columns are nullable.
        expect(byName.worker_id.notnull).toBe(0);
        expect(byName.claim_token.notnull).toBe(0);
        expect(byName.lease_expires_at.notnull).toBe(0);

        const idx = raw.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
        expect(idx).toContain('idx_jobs_claimable');
        expect(idx).toContain('idx_jobs_lease');
        expect(idx).toContain('idx_jobs_worker');
      } finally {
        raw.close();
      }
    } finally {
      rmDb(p);
    }
  });

  it('migrates a pre-existing jobs table that lacks the worker columns (additive, no backfill)', () => {
    const p = tmpDbPath();
    try {
      // Seed a legacy DB + a legacy job row with NO worker fields.
      const seed = new Database(p);
      seed.exec(LEGACY_JOBS_DDL);
      seed.prepare('INSERT INTO jobs (id, owner_user_id, job_type, status) VALUES (?,?,?,?)')
        .run('job_legacy_aaaaaaaaaaaaaaaa', 42, 'normalize', 'queued');
      seed.close();

      // Migrate.
      initDatabase(p);
      // Legacy row is still readable/listable through the existing helpers.
      const legacy = getJobForUser('job_legacy_aaaaaaaaaaaaaaaa', 42);
      expect(legacy).toBeTruthy();
      expect(legacy.status).toBe('queued'); // NOT backfilled into running
      expect(listJobsForUser(42)).toHaveLength(1);
      closeDatabase();

      // Worker columns now exist; the legacy row inherited the defaults.
      const raw = new Database(p, { readonly: true });
      try {
        const names = raw.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
        for (const col of WORKER_COLUMNS) expect(names, `column ${col}`).toContain(col);
        const row = raw.prepare('SELECT attempts, max_attempts, priority, worker_id, claim_token FROM jobs WHERE id=?')
          .get('job_legacy_aaaaaaaaaaaaaaaa');
        expect(row).toEqual({ attempts: 0, max_attempts: 1, priority: 0, worker_id: null, claim_token: null });
      } finally {
        raw.close();
      }
    } finally {
      rmDb(p);
    }
  });

  it('is idempotent — re-running initialization adds nothing and corrupts nothing', () => {
    const p = tmpDbPath();
    try {
      // Start from a legacy DB, then initialize three times.
      const seed = new Database(p);
      seed.exec(LEGACY_JOBS_DDL);
      seed.prepare('INSERT INTO jobs (id, owner_user_id, job_type, status) VALUES (?,?,?,?)')
        .run('job_legacy_bbbbbbbbbbbbbbbb', 7, 'pca', 'queued');
      seed.close();

      expect(() => { initDatabase(p); closeDatabase(); }).not.toThrow();
      expect(() => { initDatabase(p); closeDatabase(); }).not.toThrow();
      expect(() => { initDatabase(p); closeDatabase(); }).not.toThrow();

      const raw = new Database(p, { readonly: true });
      try {
        // Each worker column appears exactly once (no duplicate ALTERs).
        const names = raw.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
        for (const col of WORKER_COLUMNS) {
          expect(names.filter(n => n === col), `column ${col} count`).toHaveLength(1);
        }
        // The legacy row survived untouched.
        const row = raw.prepare('SELECT status, attempts FROM jobs WHERE id=?').get('job_legacy_bbbbbbbbbbbbbbbb');
        expect(row).toEqual({ status: 'queued', attempts: 0 });
      } finally {
        raw.close();
      }
    } finally {
      rmDb(p);
    }
  });

  it('a migrated legacy job is claimable through the new contract', () => {
    const p = tmpDbPath();
    try {
      const seed = new Database(p);
      seed.exec(LEGACY_JOBS_DDL);
      seed.prepare('INSERT INTO jobs (id, owner_user_id, job_type, status) VALUES (?,?,?,?)')
        .run('job_legacy_cccccccccccccccc', 9, 'umap', 'queued');
      seed.close();

      initDatabase(p);
      const claimed = claimNextJob('worker-legacy', { now: T0, leaseSeconds: 30 });
      expect(claimed.id).toBe('job_legacy_cccccccccccccccc');
      expect(claimed.status).toBe('running');
      expect(claimed.attempts).toBe(1);
      closeDatabase();
    } finally {
      rmDb(p);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Claim / lease / heartbeat / complete / fail / release behavior (in-memory)
// ════════════════════════════════════════════════════════════════════════════
describe('jobs worker contract — claim / lease / heartbeat', () => {
  let alice, bob;
  beforeEach(() => {
    initDatabase(':memory:');
    alice = createUser('alice@example.com', 'password123', 'Alice');
    bob = createUser('bob@example.com', 'password123', 'Bob');
  });
  afterEach(() => closeDatabase());

  function newJob(owner = alice, jobType = 'normalize') {
    return createJobForUser(owner.id, { jobType });
  }

  // ── Claim ──────────────────────────────────────────────────────────────────
  it('claims a single queued job, flips it to running, and sets the worker fields', () => {
    const job = newJob();
    const claimed = claimNextJob('worker-1', { now: T0, leaseSeconds: 30 });

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

  it('increments attempts on each claim', () => {
    const job = newJob();
    setJobScheduling(job.id, { maxAttempts: 5 });
    const c1 = claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(c1.attempts).toBe(1);
    // release refunds, re-claim bumps to 2 net of the refund → demonstrates the counter moves on claim
    releaseJob(c1.id, 'w1', c1.claimToken, { now: T0_PLUS_10 });
    const c2 = claimNextJob('w1', { now: T0_PLUS_20, leaseSeconds: 30 });
    expect(c2.attempts).toBe(1); // released (refunded to 0) then claimed again → 1
  });

  it('returns null when there is no claimable job', () => {
    expect(claimNextJob('w1', { now: T0 })).toBeNull();
  });

  it('is a single winner: two workers cannot both claim the same job', () => {
    newJob();
    const a = claimNextJob('worker-A', { now: T0, leaseSeconds: 30 });
    const b = claimNextJob('worker-B', { now: T0, leaseSeconds: 30 });
    expect(a).not.toBeNull();
    expect(a.status).toBe('running');
    expect(b).toBeNull(); // the job is already running with a live lease
  });

  it('a running job with an unexpired lease cannot be claimed by another worker', () => {
    newJob();
    const a = claimNextJob('worker-A', { now: T0, leaseSeconds: 30 });
    // T0+20 is still inside the 30s lease taken at T0.
    expect(claimNextJob('worker-B', { now: T0_PLUS_20 })).toBeNull();
    expect(getWorkerJob(a.id).workerId).toBe('worker-A');
  });

  it('orders claims by priority (desc), then created_at (asc), then id', () => {
    // Three jobs, same priority, distinct enqueue times → oldest first.
    const j1 = newJob(); setJobScheduling(j1.id, { createdAt: '2030-01-01 00:00:01' });
    const j2 = newJob(); setJobScheduling(j2.id, { createdAt: '2030-01-01 00:00:02' });
    const j3 = newJob(); setJobScheduling(j3.id, { createdAt: '2030-01-01 00:00:03' });
    // Raise j3's priority so it jumps the queue despite being newest.
    setJobScheduling(j3.id, { priority: 10 });

    expect(claimNextJob('w', { now: T0, leaseSeconds: 1 }).id).toBe(j3.id); // priority wins
    // Re-claim is blocked by the live lease, so claim the next two by created_at.
    expect(claimNextJob('w', { now: T0, leaseSeconds: 1 }).id).toBe(j1.id); // oldest of the rest
    expect(claimNextJob('w', { now: T0, leaseSeconds: 1 }).id).toBe(j2.id);
  });

  it('does not claim terminal jobs (completed / failed / canceled)', () => {
    // Completed (drive queued→running→completed via the owner status helper).
    const done = newJob();
    updateJobStatusForUser(alice.id, done.id, 'running');
    updateJobStatusForUser(alice.id, done.id, 'completed');
    // Failed.
    const failed = newJob();
    updateJobStatusForUser(alice.id, failed.id, 'running');
    updateJobStatusForUser(alice.id, failed.id, 'failed', { error: { message: 'x' } });
    // Canceled.
    const canceled = newJob();
    cancelJobForUser(alice.id, canceled.id);

    expect(claimNextJob('w', { now: T0 })).toBeNull();
  });

  it('does not claim a canceled job even with siblings present', () => {
    const canceled = newJob();
    cancelJobForUser(alice.id, canceled.id);
    const live = newJob();
    const claimed = claimNextJob('w', { now: T0, leaseSeconds: 30 });
    expect(claimed.id).toBe(live.id); // never the canceled one
    expect(claimNextJob('w', { now: T0 })).toBeNull();
  });

  // ── Expired-lease recovery ──────────────────────────────────────────────────
  it('reaps an expired lease to failed when the attempt budget is exhausted (default max_attempts=1)', () => {
    const job = newJob();
    claimNextJob('w1', { now: T0, leaseSeconds: 30 }); // attempts → 1, lease ends T0+30
    const result = reapExpiredJobs({ now: LATER });
    expect(result.failed).toContain(job.id);
    expect(result.requeued).toHaveLength(0);

    const after = getJobForUser(job.id, alice.id);
    expect(after.status).toBe('failed');
    expect(after.error.code).toBe('LEASE_EXPIRED');
    // Not reclaimable forever — it is terminal now.
    expect(claimNextJob('w2', { now: MUCH_LATER })).toBeNull();
  });

  it('reaps an expired lease back to queued when attempts remain, and it is then re-claimable', () => {
    const job = newJob();
    setJobScheduling(job.id, { maxAttempts: 3 });
    const c1 = claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(c1.attempts).toBe(1);

    const result = reapExpiredJobs({ now: LATER });
    expect(result.requeued).toContain(job.id);
    expect(result.failed).toHaveLength(0);

    const requeued = getWorkerJob(job.id);
    expect(requeued.status).toBe('queued');
    expect(requeued.workerId).toBeNull();
    expect(requeued.claimToken).toBeNull();
    expect(requeued.leaseExpiresAt).toBeNull();

    const c2 = claimNextJob('w2', { now: MUCH_LATER, leaseSeconds: 30 });
    expect(c2.id).toBe(job.id);
    expect(c2.workerId).toBe('w2');
    expect(c2.attempts).toBe(2); // second claim
  });

  it('honors max_attempts across the full requeue→claim→reap cycle', () => {
    const job = newJob();
    setJobScheduling(job.id, { maxAttempts: 2 });

    claimNextJob('w1', { now: T0, leaseSeconds: 30 });                  // attempts 1
    expect(reapExpiredJobs({ now: LATER }).requeued).toContain(job.id); // 1 < 2 → requeue
    claimNextJob('w2', { now: MUCH_LATER, leaseSeconds: 30 });          // attempts 2
    const final = reapExpiredJobs({ now: '2030-01-01 03:00:00' });      // 2 >= 2 → fail
    expect(final.failed).toContain(job.id);
    expect(getJobForUser(job.id, alice.id).status).toBe('failed');
  });

  // ── Heartbeat ───────────────────────────────────────────────────────────────
  it('heartbeat extends the lease and updates heartbeat_at for the owning worker', () => {
    newJob();
    const c = claimNextJob('w1', { now: T0, leaseSeconds: 30 }); // lease T0+30
    expect(c.leaseExpiresAt).toBe('2030-01-01 00:00:30');

    const hb = heartbeatJob(c.id, 'w1', c.claimToken, { now: T0_PLUS_10, leaseSeconds: 30 });
    expect(hb.heartbeatAt).toBe(T0_PLUS_10);
    expect(hb.leaseExpiresAt).toBe('2030-01-01 00:00:40'); // extended
    expect(hb.leaseExpiresAt > c.leaseExpiresAt).toBe(true);
  });

  it('heartbeat fails for a non-owning worker or a wrong claim token', () => {
    newJob();
    const c = claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(() => heartbeatJob(c.id, 'w2', c.claimToken, { now: T0_PLUS_10 }))
      .toThrow(/no longer holds/i);
    expect(() => heartbeatJob(c.id, 'w1', 'wct_wrongtoken', { now: T0_PLUS_10 }))
      .toThrow(/no longer holds/i);
    // The real holder still can.
    expect(heartbeatJob(c.id, 'w1', c.claimToken, { now: T0_PLUS_10 }).status).toBe('running');
  });

  it('heartbeat after the lease has already expired is rejected (claim lost)', () => {
    newJob();
    const c = claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(() => heartbeatJob(c.id, 'w1', c.claimToken, { now: LATER }))
      .toThrow(/no longer holds/i);
  });

  it('heartbeat on an unknown job is JOB_NOT_FOUND', () => {
    let code;
    try { heartbeatJob('job_does_not_exist', 'w1', 'wct_x', { now: T0 }); }
    catch (e) { code = e.code; }
    expect(code).toBe('JOB_NOT_FOUND');
  });

  // ── Complete / fail / release ownership ──────────────────────────────────────
  it('only the owning worker can complete, fail, or release a job', () => {
    newJob();
    const c = claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(() => completeJobByWorker(c.id, 'intruder', c.claimToken, { now: T0_PLUS_10 })).toThrow(/no longer holds/i);
    expect(() => failJobByWorker(c.id, 'intruder', c.claimToken, { message: 'x' }, { now: T0_PLUS_10 })).toThrow(/no longer holds/i);
    expect(() => releaseJob(c.id, 'intruder', c.claimToken, { now: T0_PLUS_10 })).toThrow(/no longer holds/i);
    // Wrong token, right worker → also rejected.
    expect(() => completeJobByWorker(c.id, 'w1', 'wct_nope', { now: T0_PLUS_10 })).toThrow(/no longer holds/i);
    // Still running and held by w1.
    expect(getWorkerJob(c.id).status).toBe('running');
  });

  it('completing a held job transitions running→completed and clears the live claim', () => {
    newJob();
    const c = claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    const done = completeJobByWorker(c.id, 'w1', c.claimToken, { now: T0_PLUS_10, log: 'finished' });
    expect(done.status).toBe('completed');
    expect(done.completedAt).toBe(T0_PLUS_10);
    expect(done.claimToken).toBeNull();
    expect(done.leaseExpiresAt).toBeNull();
    expect(done.logs.some(l => l.message === 'finished')).toBe(true);
    // A second completion is rejected (claim already cleared → not running/held).
    expect(() => completeJobByWorker(c.id, 'w1', c.claimToken, { now: T0_PLUS_20 })).toThrow(/no longer holds/i);
  });

  it('completing can link a result analysis object owned by the job owner, and rejects a foreign one', () => {
    const resultObj = createAnalysisObjectForUser(alice.id, { objectType: 'seurat' });
    const bobObj = createAnalysisObjectForUser(bob.id, { objectType: 'seurat' });
    newJob(); // owned by alice
    const c = claimNextJob('w1', { now: T0, leaseSeconds: 30 });

    expect(() => completeJobByWorker(c.id, 'w1', c.claimToken, { now: T0_PLUS_10, resultAnalysisObjectId: bobObj.id }))
      .toThrow(/result analysis object not found/i);
    const done = completeJobByWorker(c.id, 'w1', c.claimToken, { now: T0_PLUS_20, resultAnalysisObjectId: resultObj.id });
    expect(done.resultAnalysisObjectId).toBe(resultObj.id);
  });

  it('failing a held job records durable error information and clears the claim', () => {
    newJob();
    const c = claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    const failed = failJobByWorker(c.id, 'w1', c.claimToken, { message: 'Seurat error', code: 'R_ERROR' }, { now: T0_PLUS_10 });
    expect(failed.status).toBe('failed');
    expect(failed.error).toEqual({ message: 'Seurat error', code: 'R_ERROR' });
    expect(failed.lastWorkerError).toEqual({ message: 'Seurat error', code: 'R_ERROR' });
    expect(failed.completedAt).toBe(T0_PLUS_10);
    expect(failed.claimToken).toBeNull();
    // The user-facing error survives a re-read through the public helper.
    expect(getJobForUser(c.id, alice.id).error.code).toBe('R_ERROR');
  });

  it('failing always records an error even when none is supplied', () => {
    newJob();
    const c = claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    const failed = failJobByWorker(c.id, 'w1', c.claimToken, undefined, { now: T0_PLUS_10 });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBeTruthy();
    expect(typeof failed.error.message).toBe('string');
  });

  it('releasing returns the job to queued, refunds the attempt, and makes it re-claimable', () => {
    const job = newJob();
    const c = claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(c.attempts).toBe(1);
    const released = releaseJob(c.id, 'w1', c.claimToken, { now: T0_PLUS_10, log: 'handing back' });
    expect(released.status).toBe('queued');
    expect(released.attempts).toBe(0); // refunded
    expect(released.workerId).toBeNull();
    expect(released.claimToken).toBeNull();
    expect(released.leaseExpiresAt).toBeNull();

    const c2 = claimNextJob('w2', { now: T0_PLUS_20, leaseSeconds: 30 });
    expect(c2.id).toBe(job.id);
    expect(c2.workerId).toBe('w2');
    expect(c2.attempts).toBe(1);
  });

  // ── reap / setJobScheduling shapes & validation ──────────────────────────────
  it('reapExpiredJobs returns the affected ids and ignores live leases', () => {
    const live = newJob();
    claimNextJob('w1', { now: T0, leaseSeconds: 7200 }); // lease ends T0+2h, still live at LATER (T0+1h)
    const result = reapExpiredJobs({ now: LATER });
    expect(result.requeued).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(getWorkerJob(live.id).status).toBe('running');
  });

  it('setJobScheduling validates its inputs', () => {
    const job = newJob();
    expect(() => setJobScheduling(job.id, { priority: 1.5 })).toThrow(/priority/i);
    expect(() => setJobScheduling(job.id, { maxAttempts: 0 })).toThrow(/maxAttempts/i);
    expect(() => setJobScheduling(job.id, { createdAt: 'not-a-timestamp' })).toThrow(/createdAt/i);
    expect(() => setJobScheduling('job_missing', { priority: 1 })).toThrow(/not found/i);
  });

  it('rejects malformed worker input', () => {
    newJob();
    expect(() => claimNextJob('', { now: T0 })).toThrow(/worker id/i);
    expect(() => claimNextJob('bad id with spaces', { now: T0 })).toThrow(/worker id/i);
    expect(() => claimNextJob('w1', { now: 'bogus' })).toThrow(/timestamp/i);
    expect(() => claimNextJob('w1', { now: T0, leaseSeconds: 0 })).toThrow(/leaseSeconds/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Cancellation interaction with a live claim (owner + project routes)
// ════════════════════════════════════════════════════════════════════════════
describe('jobs worker contract — cancel makes worker behavior safe', () => {
  let alice;
  beforeEach(() => {
    initDatabase(':memory:');
    alice = createUser('alice@example.com', 'password123', 'Alice');
  });
  afterEach(() => closeDatabase());

  it('owner cancel of a claimed job makes future heartbeat/complete/fail deterministic (CLAIM_LOST)', () => {
    createJobForUser(alice.id, { jobType: 'normalize' });
    const c = claimNextJob('w1', { now: T0, leaseSeconds: 30 });

    const canceled = cancelJobForUser(alice.id, c.id);
    expect(canceled.status).toBe('canceled');
    expect(canceled.canceledAt).toBeTruthy();

    expect(() => heartbeatJob(c.id, 'w1', c.claimToken, { now: T0_PLUS_10 })).toThrow(/no longer holds/i);
    expect(() => completeJobByWorker(c.id, 'w1', c.claimToken, { now: T0_PLUS_10 })).toThrow(/no longer holds/i);
    expect(() => failJobByWorker(c.id, 'w1', c.claimToken, { message: 'x' }, { now: T0_PLUS_10 })).toThrow(/no longer holds/i);
    expect(() => releaseJob(c.id, 'w1', c.claimToken, { now: T0_PLUS_10 })).toThrow(/no longer holds/i);
    // Stays canceled — the worker can never resurrect it.
    expect(getJobForUser(c.id, alice.id).status).toBe('canceled');
  });

  it('project cancel of a claimed job also voids the claim (CLAIM_LOST afterwards)', () => {
    const org = createOrganizationForUser(alice.id, { name: 'Acme' });
    const proj = createProjectForUser(alice.id, { organizationId: org.id, name: 'P' });
    const created = createProjectJob(alice.id, proj.id, { jobType: 'pca' });
    const c = claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(c.id).toBe(created.id);

    const canceled = cancelProjectJob(alice.id, proj.id, created.id);
    expect(canceled.status).toBe('canceled');

    expect(() => heartbeatJob(created.id, 'w1', c.claimToken, { now: T0_PLUS_10 })).toThrow(/no longer holds/i);
    expect(() => completeJobByWorker(created.id, 'w1', c.claimToken, { now: T0_PLUS_10 })).toThrow(/no longer holds/i);
    expect(getProjectJob(alice.id, proj.id, created.id).status).toBe('canceled');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Transition allow-list, public-API compatibility, and the R/ownership boundary
// ════════════════════════════════════════════════════════════════════════════
describe('jobs worker contract — invariants preserved', () => {
  let alice, bob;
  beforeEach(() => {
    initDatabase(':memory:');
    alice = createUser('alice@example.com', 'password123', 'Alice');
    bob = createUser('bob@example.com', 'password123', 'Bob');
  });
  afterEach(() => closeDatabase());

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

  it('never exposes claim_token through the public job read helpers', () => {
    createJobForUser(alice.id, { jobType: 'normalize' });
    const claimed = claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(claimed.claimToken).toBeTruthy(); // worker view has it

    const pub = getJobForUser(claimed.id, alice.id);
    expect(Object.prototype.hasOwnProperty.call(pub, 'claimToken')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(pub, 'claim_token')).toBe(false);
    const listed = listJobsForUser(alice.id)[0];
    expect(Object.prototype.hasOwnProperty.call(listed, 'claimToken')).toBe(false);
  });

  it('the public job shape is unchanged by claiming (no worker fields leak in)', () => {
    const created = createJobForUser(alice.id, { jobType: 'normalize' });
    // The create response shape is exactly the historical public shape.
    expect(Object.keys(created).sort()).toEqual([
      'analysisObjectId', 'canceledAt', 'completedAt', 'createdAt', 'datasetId',
      'error', 'id', 'jobType', 'logs', 'ownerUserId', 'parameters', 'projectId',
      'resultAnalysisObjectId', 'startedAt', 'status', 'updatedAt'
    ]);
    // Claiming does not add worker keys to the public read shape.
    claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(Object.keys(getJobForUser(created.id, alice.id)).sort())
      .toEqual(Object.keys(created).sort());
  });

  it('a claimed job remains owner-scoped on the public read path (claim does not widen access)', () => {
    createJobForUser(alice.id, { jobType: 'normalize' });
    const c = claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    expect(getJobForUser(c.id, alice.id)).toBeTruthy();      // owner sees it
    expect(getJobForUser(c.id, bob.id)).toBeNull();           // another user cannot
    expect(verifyJobOwner(alice.id, c.id)).toBe(true);
    expect(verifyJobOwner(bob.id, c.id)).toBe(false);
  });

  it('claiming/completing a job never widens analysis-object (R) ownership', () => {
    const ao = createAnalysisObjectForUser(alice.id, { objectType: 'seurat' });
    createJobForUser(alice.id, { jobType: 'normalize', analysisObjectId: ao.id });
    const c = claimNextJob('w1', { now: T0, leaseSeconds: 30 });
    completeJobByWorker(c.id, 'w1', c.claimToken, { now: T0_PLUS_10 });
    // The R-adjacent object is still owned only by alice — worker activity on the
    // job row does not grant anyone (or any worker) ownership of the live object.
    expect(verifyAnalysisObjectOwner(alice.id, ao.id)).toBe(true);
    expect(verifyAnalysisObjectOwner(bob.id, ao.id)).toBe(false);
  });

  it('createJobForUser ignores client-style coordination fields and uses safe defaults', () => {
    // Even if a caller smuggles worker/scheduling fields, the create path ignores
    // them: the job is queued with attempts 0, max_attempts 1, priority 0.
    const created = createJobForUser(alice.id, {
      jobType: 'normalize',
      // none of these are read by createJobForUser:
      worker_id: 'evil', claim_token: 'wct_evil', attempts: 99, max_attempts: 99, priority: 99, status: 'running'
    });
    expect(created.status).toBe('queued');
    const view = getWorkerJob(created.id);
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
