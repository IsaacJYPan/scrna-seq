/**
 * Postgres contract test — proves the hosted-service database foundation on a
 * REAL Postgres server (evidence label: "Postgres contract").
 *
 * It exercises backend/pgDatabase.js end-to-end against Postgres:
 *   - schema init from backend/pg/schema.sql,
 *   - auth (createUser + verifyUser, duplicate-email rejection),
 *   - project RBAC (org/project creation seeds an owner member; role reads),
 *   - server-generated ids (org_/proj_/ao_/job_/art_),
 *   - analysis object ownership scoping,
 *   - the job state machine (allowed vs rejected transitions, terminal jobs),
 *   - artifact result-checkpoint immutability (second checkpoint rejected),
 *   - public sanitization (claim_token/worker internals + storage_uri stripped).
 *
 * GATING: the whole suite is SKIPPED unless a Postgres connection is configured
 * (DATABASE_URL or PG* env). So the default local `npm run test:backend`
 * (SQLite, no Postgres) stays green, while CI — which provisions a Postgres
 * service and sets DATABASE_URL — runs it for real. If DATABASE_URL is set but
 * the server is unreachable, the suite FAILS loudly (a real misconfiguration),
 * rather than silently passing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const config = require('./config');
const pg = require('./pgDatabase');

const CONFIGURED = config.hasPostgresConnection();

describe.skipIf(!CONFIGURED)('Postgres contract (hosted-service database foundation)', () => {
  beforeAll(async () => {
    await pg.resetSchemaForTests();
  });

  afterAll(async () => {
    await pg.close();
  });

  it('initializes the schema and round-trips a user (auth contract)', async () => {
    const created = await pg.createUser('alice@example.com', 'password123', 'Alice');
    expect(created.error).toBeUndefined();
    expect(typeof created.id).toBe('number');

    const dup = await pg.createUser('alice@example.com', 'password123', 'Alice2');
    expect(dup.error).toMatch(/already exists/i);

    const good = await pg.verifyUser('alice@example.com', 'password123');
    expect(good.error).toBeUndefined();
    expect(good.email).toBe('alice@example.com');

    const bad = await pg.verifyUser('alice@example.com', 'wrong-password');
    expect(bad.error).toBeDefined();

    const missing = await pg.verifyUser('nobody@example.com', 'whatever');
    expect(missing.error).toBeDefined();
  });

  it('creates org/project with server ids and seeds an owner member (RBAC)', async () => {
    const owner = await pg.createUser('owner@example.com', 'password123', 'Owner');
    const org = await pg.createOrganization('Acme Lab', owner.id);
    expect(org.id).toMatch(/^org_[0-9a-f]+$/);

    const project = await pg.createProject(org.id, 'Project X', owner.id);
    expect(project.id).toMatch(/^proj_[0-9a-f]+$/);

    // Creator is auto-seeded as owner.
    expect(await pg.getProjectRole(project.id, owner.id)).toBe('owner');

    // A second member can be added with a constrained role; unknown roles reject.
    const analyst = await pg.createUser('analyst@example.com', 'password123', 'Analyst');
    await pg.addProjectMember(project.id, analyst.id, 'analyst');
    expect(await pg.getProjectRole(project.id, analyst.id)).toBe('analyst');
    await expect(pg.addProjectMember(project.id, analyst.id, 'superuser'))
      .rejects.toMatchObject({ code: 'INVALID_ROLE' });

    // A non-member has no role.
    const stranger = await pg.createUser('stranger@example.com', 'password123', 'Stranger');
    expect(await pg.getProjectRole(project.id, stranger.id)).toBeNull();
  });

  it('scopes analysis objects to their owner and generates server ids', async () => {
    const a = await pg.createUser('ao-a@example.com', 'password123', 'A');
    const b = await pg.createUser('ao-b@example.com', 'password123', 'B');

    const obj = await pg.createAnalysisObject(a.id, { objectType: 'seurat', displayName: 'obj1' });
    expect(obj.id).toMatch(/^ao_[0-9a-f]+$/);
    expect(obj.lineageRootId).toBe(obj.id); // root object is its own lineage root

    // Owner can read it; another user cannot (indistinguishable from not-found).
    expect(await pg.getAnalysisObjectForUser(obj.id, a.id)).not.toBeNull();
    expect(await pg.getAnalysisObjectForUser(obj.id, b.id)).toBeNull();

    await expect(pg.createAnalysisObject(a.id, { objectType: 'not-a-type' }))
      .rejects.toMatchObject({ code: 'INVALID_OBJECT_TYPE' });
  });

  it('enforces the job state machine and never exposes worker internals', async () => {
    const u = await pg.createUser('jobs@example.com', 'password123', 'J');
    const job = await pg.createJob(u.id, { jobType: 'generic' });
    expect(job.id).toMatch(/^job_[0-9a-f]+$/);
    expect(job.status).toBe('queued');

    // queued → running → completed is allowed.
    const running = await pg.transitionJobStatus(job.id, u.id, 'running');
    expect(running.status).toBe('running');
    const done = await pg.transitionJobStatus(job.id, u.id, 'completed');
    expect(done.status).toBe('completed');

    // Terminal job cannot transition further.
    await expect(pg.transitionJobStatus(job.id, u.id, 'running'))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    // Illegal edge from a fresh job (queued → completed) is rejected.
    const job2 = await pg.createJob(u.id, { jobType: 'generic' });
    await expect(pg.transitionJobStatus(job2.id, u.id, 'completed'))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    // Public projection strips claim_token / worker_id.
    const publicJob = pg.toPublicJob(done);
    expect(publicJob).not.toHaveProperty('claimToken');
    expect(publicJob).not.toHaveProperty('workerId');
    expect(publicJob.status).toBe('completed');
  });

  it('enforces one immutable result checkpoint per job and strips storage_uri', async () => {
    const u = await pg.createUser('art@example.com', 'password123', 'Art');
    const job = await pg.createJob(u.id, { jobType: 'checkpoint.noop' });

    const cp = await pg.createResultCheckpoint(job, {
      storageKind: 'local_internal',
      storageUri: '/vault/secret/internal-key.rds',
      checksumSha256: 'abc123',
      sizeBytes: 42
    });
    expect(cp.artifactType).toBe('result_checkpoint');

    // A second result checkpoint for the same job is rejected (immutability).
    await expect(pg.createResultCheckpoint(job, { storageUri: '/vault/other.rds' }))
      .rejects.toMatchObject({ code: 'CHECKPOINT_EXISTS' });

    // Public projection never exposes the internal storage path.
    const publicArtifact = pg.toPublicJobArtifact(cp);
    expect(publicArtifact).not.toHaveProperty('storageUri');
    expect(publicArtifact.checksumSha256).toBe('abc123'); // safe descriptive metadata kept
  });
});
