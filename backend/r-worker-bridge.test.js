import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// ════════════════════════════════════════════════════════════════════════════
// Minimal worker-to-R bridge (r.runtime.check)
//
// Proves the smallest safe seam: a worker can invoke the R backend through
// server-controlled code for ONE explicitly allowlisted, read-only, metadata-only
// operation, recording a metadata-only artifact — while arbitrary R, client-chosen
// endpoints/paths/code/state keys, downloads, object storage, checkpoints, and
// live-R object access all remain out of reach. See backend/rWorkerBridge.js.
// ════════════════════════════════════════════════════════════════════════════

const config = require('./config');
const dbmod = require('./pgDatabase');
const CONFIGURED = config.hasPostgresConnection();
const {
  createUser,
  createOrganizationForUser, createProjectForUser, addProjectMemberByEmail,
  createJobForUser, createProjectJob, createProjectAnalysisObject, createAnalysisObjectForUser,
  getJobForUser, verifyAnalysisObjectOwner,
  claimNextJob, reapExpiredJobs, setJobScheduling,
  listProjectArtifacts, getJobArtifactsByJobId,
  isValidJobType, isValidArtifactType,
} = dbmod;

const bridge = require('./rWorkerBridge');
const { runRBridgeOperation, isAllowedRBridgeOperation, R_BRIDGE_OPERATIONS, createDefaultRCaller, sanitizeRuntimeField } = bridge;

const worker = require('./jobWorker');
const { createJobWorker, DEFAULT_HANDLERS, rRuntimeCheckHandler } = worker;

const { startServer, createUserWithToken, api } = require('./_http-test-utils');

// Deterministic UTC instants in SQLite's canonical 'YYYY-MM-DD HH:MM:SS' format.
const T0 = '2030-01-01 00:00:00';
const LATER = '2030-01-01 01:00:00'; // well past any 30s lease taken at T0

function silentLogger() { return { info() {}, warn() {}, error() {} }; }

// A healthy R `/health` response (the only thing the bridge reads).
function healthyBody() { return { status: 'ok', timestamp: '2030-01-01T00:00:00+0000', mode: 'scRNA-seq Seurat Real' }; }

// An injectable R caller that records every request and returns a healthy response.
function recordingHealthyCaller(record) {
  return async (req) => { record.push(req); return { status: 200, body: healthyBody() }; };
}

// Run the worker once over whatever is queued, with an injected R caller + clock.
async function drainR(callR, now = T0, opts = {}) {
  const w = createJobWorker({ db: dbmod, now: () => now, logger: silentLogger(), callR, ...opts });
  return w.runOnce();
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Bridge unit behavior (pure function; injected caller — no real R, no DB)
// ════════════════════════════════════════════════════════════════════════════
afterAll(async () => { if (!CONFIGURED) return; await dbmod.close(); });

describe.skipIf(!CONFIGURED)('rWorkerBridge — operation allowlist & request derivation', () => {
  it('exposes the r.runtime.check operation (read-only, no object access)', async () => {
    // The allowlist now also contains r.object.inspect (covered in r-object-inspect.test.js);
    // r.runtime.check remains exactly as before — read-only /health, no object context.
    expect(Object.keys(R_BRIDGE_OPERATIONS)).toContain('r.runtime.check');
    const spec = R_BRIDGE_OPERATIONS['r.runtime.check'];
    expect(spec.method).toBe('GET');
    expect(spec.path).toBe('/health');
    expect(spec.artifactType).toBe('r_runtime_check');
    expect(spec.touchesAnalysisObject).toBe(false);
    expect(spec.requiresObjectContext).toBe(false);
    expect(isAllowedRBridgeOperation('r.runtime.check')).toBe(true);
  });

  it('runs the allowlisted op by issuing ONLY the server-defined GET /health request', async () => {
    const calls = [];
    const descriptor = await runRBridgeOperation({
      job: { id: 'job_abc', ownerUserId: 1, projectId: null },
      operation: 'r.runtime.check',
      callR: recordingHealthyCaller(calls),
      logger: silentLogger(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].path).toBe('/health');
    // The request the bridge issues carries NO client/code/endpoint/state-key field.
    expect(Object.keys(calls[0]).sort()).toEqual(['method', 'path', 'timeoutMs']);

    expect(descriptor.artifactType).toBe('r_runtime_check');
    expect(descriptor.storageKind).toBe('metadata_only');
    expect(descriptor.metadata.operation).toBe('r.runtime.check');
    expect(descriptor.metadata.kind).toBe('operational');
    expect(descriptor.metadata.scientific_output).toBe(false);
    expect(descriptor.metadata.runtime).toEqual({ status: 'ok', mode: 'scRNA-seq Seurat Real' });
  });

  it('IGNORES caller input entirely: smuggled code/path/endpoint/method/stateKey do nothing', async () => {
    const calls = [];
    await runRBridgeOperation({
      job: { id: 'job_abc', ownerUserId: 1 },
      operation: 'r.runtime.check',
      input: {
        operation: 'r.exec.arbitrary',
        code: 'system("rm -rf /")',
        rCode: 'q()',
        path: '/load-rds',
        endpoint: 'http://evil.example/secret',
        url: 'http://evil.example/secret',
        method: 'POST',
        stateKey: 'user-999',
        objectId: 'ao_deadbeef',
      },
      callR: recordingHealthyCaller(calls),
      logger: silentLogger(),
    });
    // Still exactly the server-defined GET /health — nothing from input leaks through.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].path).toBe('/health');
    expect(calls[0]).not.toHaveProperty('code');
    expect(calls[0]).not.toHaveProperty('endpoint');
    expect(calls[0]).not.toHaveProperty('url');
    expect(calls[0]).not.toHaveProperty('stateKey');
    expect(calls[0]).not.toHaveProperty('objectId');
  });

  it('rejects an arbitrary / non-allowlisted operation name WITHOUT contacting R', async () => {
    const calls = [];
    await expect(runRBridgeOperation({
      job: { id: 'job_abc', ownerUserId: 1 },
      operation: 'r.exec.arbitrary',
      callR: recordingHealthyCaller(calls),
      logger: silentLogger(),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_R_OPERATION' });
    expect(calls).toHaveLength(0); // never reached R
  });

  it('treats a missing/invalid caller as misconfigured (no silent no-op)', async () => {
    await expect(runRBridgeOperation({
      job: { id: 'job_abc', ownerUserId: 1 },
      operation: 'r.runtime.check',
      logger: silentLogger(),
    })).rejects.toMatchObject({ code: 'R_BRIDGE_MISCONFIGURED' });
  });
});

describe.skipIf(!CONFIGURED)('rWorkerBridge — error & metadata sanitization (no leaks)', () => {
  it('sanitizes a transport error: a raw URL/host message never escapes', async () => {
    const leakyCaller = async () => {
      throw new Error('connect ECONNREFUSED http://127.0.0.1:8000/health (internal stack at /srv/app/x.js:1)');
    };
    let thrown;
    try {
      await runRBridgeOperation({ job: { id: 'job_x', ownerUserId: 1 }, operation: 'r.runtime.check', callR: leakyCaller, logger: silentLogger() });
    } catch (e) { thrown = e; }
    expect(thrown).toBeTruthy();
    expect(thrown.message).toBe('R bridge operation failed.');
    for (const forbidden of ['ECONNREFUSED', 'http://', '127.0.0.1', '8000', '/srv/app', '.js:']) {
      expect(thrown.message).not.toContain(forbidden);
    }
  });

  it('maps a coded timeout to a safe, stable message', async () => {
    const timeoutCaller = async () => { const e = new Error('socket hang up http://127.0.0.1:8000'); e.code = 'R_TIMEOUT'; throw e; };
    let thrown;
    try {
      await runRBridgeOperation({ job: { id: 'job_x', ownerUserId: 1 }, operation: 'r.runtime.check', callR: timeoutCaller, logger: silentLogger() });
    } catch (e) { thrown = e; }
    expect(thrown.code).toBe('R_TIMEOUT');
    expect(thrown.message).toBe('R runtime did not respond before the timeout.');
    expect(thrown.message).not.toContain('127.0.0.1');
  });

  it('fails (without echoing the raw body) when R returns a non-200', async () => {
    const errorCaller = async () => ({ status: 500, body: { error: 'R Error: internal /vault/path blew up at line 42' } });
    let thrown;
    try {
      await runRBridgeOperation({ job: { id: 'job_x', ownerUserId: 1 }, operation: 'r.runtime.check', callR: errorCaller, logger: silentLogger() });
    } catch (e) { thrown = e; }
    expect(thrown.code).toBe('R_RUNTIME_CHECK_FAILED');
    expect(thrown.message).toBe('R runtime check failed.');
    expect(thrown.message).not.toContain('/vault');
  });

  it('sanitizes runtime metadata fields: garbage/oversized/non-safe values are dropped', async () => {
    const nastyCaller = async () => ({
      status: 200,
      body: {
        status: 'ok',
        mode: 'scRNA-seq Seurat Real',
        // Hostile extra fields the bridge must NOT carry into artifact metadata:
        secret: 'TOKEN=abcdef',
        path: '/vault/user_x/obj.rds',
        url: 'http://127.0.0.1:8000/health',
      },
    });
    const descriptor = await runRBridgeOperation({ job: { id: 'job_x', ownerUserId: 1 }, operation: 'r.runtime.check', callR: nastyCaller, logger: silentLogger() });
    // Only the known, sanitized fields survive.
    expect(descriptor.metadata.runtime).toEqual({ status: 'ok', mode: 'scRNA-seq Seurat Real' });
    const blob = JSON.stringify(descriptor.metadata);
    for (const forbidden of ['TOKEN=', '/vault', 'http://', '127.0.0.1', '8000']) {
      expect(blob).not.toContain(forbidden);
    }
  });

  it('sanitizeRuntimeField strips unsafe chars and caps length; drops non-scalars', async () => {
    expect(sanitizeRuntimeField('ok')).toBe('ok');
    expect(sanitizeRuntimeField('a/b\\c<d>e')).toBe('abcde');
    expect(sanitizeRuntimeField('x'.repeat(500)).length).toBe(64);
    expect(sanitizeRuntimeField({ a: 1 })).toBeNull();
    expect(sanitizeRuntimeField('')).toBeNull();
  });

  it('createDefaultRCaller returns a function and never accepts caller-chosen R code', async () => {
    const callR = createDefaultRCaller({ port: 8000, token: 't' });
    expect(typeof callR).toBe('function');
    // The bridge module surface is pure helpers — NO express app/router/route was added.
    for (const k of ['app', 'router', 'middleware', 'handler', 'routes']) {
      expect(bridge).not.toHaveProperty(k);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Scope / registration (exactly one new type; existing behavior unchanged)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('r-bridge — scope & registration', () => {
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  it('registers the r.runtime.check bridge handler; generic & checkpoint.noop unchanged', async () => {
    // The registry also contains r.object.inspect (covered in r-object-inspect.test.js);
    // here we assert r.runtime.check and the pre-existing handlers are intact.
    expect(Object.keys(DEFAULT_HANDLERS)).toContain('r.runtime.check');
    expect(typeof DEFAULT_HANDLERS['r.runtime.check']).toBe('function');
    expect(DEFAULT_HANDLERS['r.runtime.check']).toBe(rRuntimeCheckHandler);
    // The pure noop / placeholder handlers were not swapped out.
    expect(DEFAULT_HANDLERS.generic).toBe(worker.genericNoopHandler);
    expect(DEFAULT_HANDLERS['checkpoint.noop']).toBe(worker.checkpointNoopHandler);
  });

  it('r.runtime.check is an allowed job type and r_runtime_check an allowed artifact type', async () => {
    expect(isValidJobType('r.runtime.check')).toBe(true);
    expect(isValidArtifactType('r_runtime_check')).toBe(true);
  });

  it('a still-unregistered analytical job type remains a terminal UNSUPPORTED_JOB_TYPE failure', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const job = await createJobForUser(alice.id, { jobType: 'normalize' });
    const calls = [];
    const res = await drainR(recordingHealthyCaller(calls));
    expect(res.status).toBe('unsupported');
    expect(calls).toHaveLength(0); // unsupported types never reach the R bridge
    const after = await getJobForUser(job.id, alice.id);
    expect(after.status).toBe('failed');
    expect(after.error.code).toBe('UNSUPPORTED_JOB_TYPE');
  });

  it('the generic noop still neither calls R nor creates artifacts', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const job = await createJobForUser(alice.id, { jobType: 'generic' });
    const calls = [];
    const res = await drainR(recordingHealthyCaller(calls));
    expect(res.status).toBe('completed');
    expect(res.result).toEqual({ ok: true, handled: 'generic', noop: true });
    expect(calls).toHaveLength(0);
    expect((await getJobForUser(job.id, alice.id)).resultAnalysisObjectId).toBeFalsy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Worker integration (claim → bridge → artifact through the contract)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('r-bridge — worker integration', () => {
  let alice;
  beforeEach(async () => {
    await dbmod.resetSchemaForTests();
    alice = await createUser('alice@example.com', 'password123', 'Alice');
  });


  it('completes a r.runtime.check job and records EXACTLY one metadata-only artifact (no checkpoint)', async () => {
    const job = await createJobForUser(alice.id, { jobType: 'r.runtime.check' });
    const calls = [];
    const res = await drainR(recordingHealthyCaller(calls));

    expect(res.status).toBe('completed');
    expect(res.result).toMatchObject({ ok: true, handled: 'r.runtime.check', operation: 'r.runtime.check' });

    // Exactly one allowlisted call to R.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/health' });

    const after = await getJobForUser(job.id, alice.id);
    expect(after.status).toBe('completed');
    // NON-mutating inspection: no checkpoint / result analysis object created.
    expect(after.resultAnalysisObjectId).toBeFalsy();

    // Exactly one metadata-only artifact of the allowlisted type.
    const arts = await getJobArtifactsByJobId(job.id);
    expect(arts).toHaveLength(1);
    expect(arts[0].id).toBe(res.result.artifactId);
    expect(res.result.artifactId).toMatch(/^art_/);
    expect(arts[0].artifactType).toBe('r_runtime_check');
    expect(arts[0].storageKind).toBe('metadata_only');
    expect(arts[0].resultAnalysisObjectId).toBeFalsy();
    expect(arts[0].metadata.scientific_output).toBe(false);

    // Durable, sanitized logs.
    const messages = after.logs.map((l) => l.message);
    expect(messages.some((m) => /r\.runtime\.check handler/i.test(m))).toBe(true);
    expect(messages.some((m) => /metadata-only artifact/i.test(m))).toBe(true);
  });

  it('operation input is SERVER-DERIVED: job parameters cannot redirect the R call', async () => {
    await createJobForUser(alice.id, {
      jobType: 'r.runtime.check',
      parameters: { operation: 'r.exec', code: 'system("rm -rf /")', path: '/load-rds', endpoint: 'http://evil', method: 'POST' },
    });
    const calls = [];
    const res = await drainR(recordingHealthyCaller(calls));
    expect(res.status).toBe('completed');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].path).toBe('/health');
  });

  it('a failed bridge call fails the job with a sanitized error and NO successful artifact', async () => {
    const job = await createJobForUser(alice.id, { jobType: 'r.runtime.check' });
    const leakyCaller = async () => { throw new Error('connect ECONNREFUSED http://127.0.0.1:8000/health'); };
    const res = await drainR(leakyCaller);

    expect(res.status).toBe('failed');
    expect(res.error.code).toBe('HANDLER_ERROR');

    const after = await getJobForUser(job.id, alice.id);
    expect(after.status).toBe('failed');
    // Sanitized: no raw URL/host/ECONNREFUSED in the durable error or logs.
    const blob = JSON.stringify(after);
    for (const forbidden of ['ECONNREFUSED', 'http://', '127.0.0.1', '8000']) {
      expect(blob).not.toContain(forbidden);
    }
    // No artifact was created for the failed job.
    expect(await getJobArtifactsByJobId(job.id)).toHaveLength(0);
  });

  it('cancellation during the bridge handler is a claim-loss no-op (no artifact, not resurrected)', async () => {
    const job = await createJobForUser(alice.id, { jobType: 'r.runtime.check' });
    // The R call "succeeds", but the user cancels mid-run, so the subsequent
    // claim-guarded artifact write must fail with CLAIM_LOST and finalize nothing.
    const cancelMidCall = async (req) => {
      dbmod.cancelJobForUser(alice.id, job.id);
      return { status: 200, body: healthyBody() };
    };
    const res = await drainR(cancelMidCall);

    expect(res.status).toBe('claim_lost');
    const after = await getJobForUser(job.id, alice.id);
    expect(after.status).toBe('canceled'); // NOT completed
    expect(await getJobArtifactsByJobId(job.id)).toHaveLength(0);
  });

  it('claim loss (reaped lease) before artifact write prevents finalizing any artifact', async () => {
    const job = await createJobForUser(alice.id, { jobType: 'r.runtime.check' });
    await setJobScheduling(job.id, { maxAttempts: 2 });
    // A stale worker claims at T0; its lease is reaped at LATER inside the handler.
    const stale = await claimNextJob('worker_stale', { now: T0, leaseSeconds: 30 });
    expect(stale.id).toBe(job.id);
    await reapExpiredJobs({ now: LATER }); // clears the stale claim → back to queued

    // The stale worker now tries to write an artifact directly: it must be refused.
    await expect(dbmod.createJobArtifactByWorker(job.id, 'worker_stale', stale.claimToken,
        { artifactType: 'r_runtime_check', storageKind: 'metadata_only', metadata: {} }, { now: LATER })).rejects.toThrow(/claim/i);
    expect(await getJobArtifactsByJobId(job.id)).toHaveLength(0);
  });

  it('two workers cannot create duplicate artifacts for the same r.runtime.check job', async () => {
    const job = await createJobForUser(alice.id, { jobType: 'r.runtime.check' });
    const callsA = []; const callsB = [];
    const a = createJobWorker({ db: dbmod, workerId: 'worker_a', now: () => T0, logger: silentLogger(), callR: recordingHealthyCaller(callsA) });
    const b = createJobWorker({ db: dbmod, workerId: 'worker_b', now: () => T0, logger: silentLogger(), callR: recordingHealthyCaller(callsB) });

    const resA = await a.runOnce();
    const resB = await b.runOnce();

    expect([resA.status, resB.status].sort()).toEqual(['completed', 'idle']); // exactly one winner
    expect((await getJobForUser(job.id, alice.id)).status).toBe('completed');
    // Exactly one artifact total for the job (the loser created none).
    expect(await getJobArtifactsByJobId(job.id)).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Artifact public exposure (project-scoped HTTP reads; no leaks)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('r-bridge — artifact public exposure', () => {
  let server;
  beforeAll(async () => { server = await startServer(); });
  afterAll(() => { if (server) server.close(); });
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  async function seedProject(ownerUserId, name = 'P') {
    const org = await createOrganizationForUser(ownerUserId, { name: 'Acme' });
    return createProjectForUser(ownerUserId, { organizationId: org.id, name });
  }

  // Drive a project r.runtime.check job to completion with an injected healthy caller.
  async function seedRArtifact(projectId, ownerUserId) {
    const job = await createProjectJob(ownerUserId, projectId, { jobType: 'r.runtime.check' });
    const res = await drainR(recordingHealthyCaller([]));
    const arts = await listProjectArtifacts(ownerUserId, projectId);
    return { job, artifact: arts[0], res };
  }

  it('shares object-free project operational artifacts with project viewers', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const viewer = await createUserWithToken({ email: 'viewer@example.com' });
    const proj = await seedProject(alice.user.id);
    await addProjectMemberByEmail(proj.id, 'viewer@example.com', 'viewer', 'owner');
    const { job, artifact } = await seedRArtifact(proj.id, alice.user.id);

    expect(artifact.artifactType).toBe('r_runtime_check');

    for (const m of [alice, viewer]) {
      const list = await api(server, `/api/projects/${proj.id}/artifacts`, { token: m.token });
      expect(list.status).toBe(200);
      expect(list.data).toHaveLength(1);

      const one = await api(server, `/api/projects/${proj.id}/artifacts/${artifact.id}`, { token: m.token });
      expect(one.status).toBe(200);
      expect(one.data.id).toBe(artifact.id);
      expect(one.data.artifactType).toBe('r_runtime_check');
      expect(one.data.metadata.kind).toBe('operational');
      expect(one.data.metadata.scientific_output).toBe(false);

      const byJob = await api(server, `/api/projects/${proj.id}/jobs/${job.id}/artifacts`, { token: m.token });
      expect(byJob.status).toBe(200);
      expect(byJob.data).toHaveLength(1);
    }
  });

  it('a non-member receives 404 (no existence leak)', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const dave = await createUserWithToken({ email: 'dave@example.com' });
    const proj = await seedProject(alice.user.id);
    const { job, artifact } = await seedRArtifact(proj.id, alice.user.id);

    expect((await api(server, `/api/projects/${proj.id}/artifacts`, { token: dave.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/artifacts/${artifact.id}`, { token: dave.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/jobs/${job.id}/artifacts`, { token: dave.token })).status).toBe(404);
  });

  it('the public artifact response omits storage uri / paths / state keys / worker internals / R URLs', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const proj = await seedProject(alice.user.id);
    const { artifact } = await seedRArtifact(proj.id, alice.user.id);

    const one = await api(server, `/api/projects/${proj.id}/artifacts/${artifact.id}`, { token: alice.token });
    expect(one.status).toBe(200);
    const blob = JSON.stringify(one.data);
    for (const forbidden of [
      'storageUri', 'storage_uri', 'downloadUrl', 'download_url',
      'internalStorageKey', 'internal_storage_key', 'stateKey', 'state_key',
      'claimToken', 'claim_token', 'workerId', 'worker_id', 'leaseExpiresAt',
      'vault/', '/etc/', 'http://', '127.0.0.1', 'X-API-Token', 'API_TOKEN',
    ]) {
      expect(blob, forbidden).not.toContain(forbidden);
    }
    // Safe operational metadata IS present.
    expect(one.data.metadata.operation).toBe('r.runtime.check');
    expect(one.data.metadata.runtime).toBeTruthy();
    // No download surface: artifact has no usable storage/URL field.
    expect(one.data).not.toHaveProperty('storageUri');
    expect(one.data).not.toHaveProperty('downloadUrl');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Ownership / live-R boundary (membership ≠ live R object access)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('r-bridge — R ownership boundary unchanged', () => {
  let server;
  beforeAll(async () => { server = await startServer(); });
  afterAll(() => { if (server) server.close(); });
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  async function seedProject(ownerUserId, name = 'P') {
    const org = await createOrganizationForUser(ownerUserId, { name: 'Acme' });
    return createProjectForUser(ownerUserId, { organizationId: org.id, name });
  }

  it('r.runtime.check does NOT inspect or mutate any analysis object or create a checkpoint', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const obj = await createAnalysisObjectForUser(alice.id, { objectType: 'seurat', name: 'aliceObj' });
    const job = await createJobForUser(alice.id, { jobType: 'r.runtime.check' });

    const calls = [];
    const res = await drainR(recordingHealthyCaller(calls));
    expect(res.status).toBe('completed');

    // The R call targeted /health only — never an object/load/inspect route, and it
    // carried no object id / R state key.
    expect(calls[0].path).toBe('/health');
    expect(calls[0]).not.toHaveProperty('objectId');
    expect(calls[0]).not.toHaveProperty('stateKey');

    // Object ownership unchanged; no result/checkpoint object was produced.
    expect(await verifyAnalysisObjectOwner(alice.id, obj.id)).toBe(true);
    expect((await getJobForUser(job.id, alice.id)).resultAnalysisObjectId).toBeFalsy();
  });

  it('running an r.runtime.check job does NOT widen R object access for a project co-member', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const bob = await createUserWithToken({ email: 'bob@example.com' });
    const proj = await seedProject(alice.user.id);
    await addProjectMemberByEmail(proj.id, 'bob@example.com', 'admin', 'owner'); // even an admin co-member

    // Alice owns a live analysis object in the project.
    const obj = await createProjectAnalysisObject(alice.user.id, proj.id, { objectType: 'seurat', name: 'aliceObj' });

    // Run a bridge job in the project.
    await createProjectJob(alice.user.id, proj.id, { jobType: 'r.runtime.check' });
    const res = await drainR(recordingHealthyCaller([]));
    expect(res.status).toBe('completed');

    // R object ownership is still creator-keyed, NOT project-member-keyed.
    expect(await verifyAnalysisObjectOwner(alice.user.id, obj.id)).toBe(true);
    expect(await verifyAnalysisObjectOwner(bob.user.id, obj.id)).toBe(false);

    // Bob supplying Alice's object id as X-Object-ID is still rejected before reaching R.
    const r = await api(server, '/api/r/health', { token: bob.token, headers: { 'X-Object-ID': obj.id } });
    expect(r.status).toBe(404);
  });
});
