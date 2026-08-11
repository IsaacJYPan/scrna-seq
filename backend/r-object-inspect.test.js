import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// ════════════════════════════════════════════════════════════════════════════
// Read-only worker-to-R object inspection (r.object.inspect)
//
// Proves a narrowly allowlisted, READ-ONLY worker→R bridge that inspects ONE
// existing live analysis object and records a sanitized, metadata-only artifact —
// while everything dangerous stays out of reach:
//   - object id is server-derived from the TRUSTED job row (never client passthrough)
//   - only the live-R object OWNER may inspect (project membership ≠ live R access)
//   - the X-Object-ID / R state key is SERVER-DERIVED, never client-provided
//   - inspection mutates NOTHING, creates NO checkpoint/result object
//   - it returns NO expression/cell/gene data, paths, state keys, or serialized object
//   - arbitrary R code / endpoint / method / path / state key are impossible
//   - failure / cancel / claim-loss finalize NO successful artifact
// See backend/rWorkerBridge.js (operation r.object.inspect), jobWorker.js
// (rObjectInspectHandler), r-backend/plumber.R (GET /object/inspect).
// ════════════════════════════════════════════════════════════════════════════

const config = require('./config');
const dbmod = require('./pgDatabase');
const CONFIGURED = config.hasPostgresConnection();
const {
  createUser,
  createOrganizationForUser, createProjectForUser, addProjectMemberByEmail,
  createJobForUser, createProjectJob, createProjectAnalysisObject, createAnalysisObjectForUser,
  getJobForUser, getAnalysisObjectForUser, verifyAnalysisObjectOwner,
  claimNextJob, reapExpiredJobs, setJobScheduling, cancelJobForUser,
  listProjectArtifacts, getJobArtifactsByJobId,
  isValidJobType, isValidArtifactType, createJobArtifactByWorker,
} = dbmod;

const bridge = require('./rWorkerBridge');
const {
  runRBridgeOperation, isAllowedRBridgeOperation, isAllowedRBridgeTarget,
  R_BRIDGE_OPERATIONS, R_BRIDGE_ALLOWED_TARGETS, createDefaultRCaller,
  sanitizeInspectionSummary, sanitizeCount, sanitizeNameList,
} = bridge;

const worker = require('./jobWorker');
const { createJobWorker, DEFAULT_HANDLERS, rObjectInspectHandler } = worker;

const { startServer, createUserWithToken, api } = require('./_http-test-utils');
// The canonical, server-only R state-key deriver. Injected into the worker exactly as
// server.js wires it in production, so tests exercise the REAL derivation (no drift).
const serverModule = require('../server.js');
const { deriveRObjectStateKey, deriveRStateKey } = serverModule;

// Deterministic UTC instants in SQLite's canonical 'YYYY-MM-DD HH:MM:SS' format.
const T0 = '2030-01-01 00:00:00';
const LATER = '2030-01-01 01:00:00'; // well past any 30s lease taken at T0

function silentLogger() { return { info() {}, warn() {}, error() {} }; }

// A healthy R `/object/inspect` body (the only thing the bridge reads — sanitized).
function inspectBody(overrides = {}) {
  return {
    exists: true,
    class: 'Seurat',
    n_cells: 2700,
    n_features: 13714,
    assays: ['RNA'],
    reductions: ['pca', 'umap'],
    n_meta_fields: 5,
    meta_fields: ['orig.ident', 'nCount_RNA', 'nFeature_RNA', 'percent.mt', 'seurat_clusters'],
    seurat_version: '5.0.1',
    r_version: 'R version 4.6.0',
    ...overrides,
  };
}

// Injectable R caller that records every request and returns a healthy inspect body.
function recordingInspectCaller(record, body = inspectBody()) {
  return async (req) => { record.push(req); return { status: 200, body }; };
}

// Run the worker once with an injected R caller + clock + the REAL state-key deriver.
async function drainInspect(callR, now = T0, opts = {}) {
  const w = createJobWorker({
    db: dbmod, now: () => now, logger: silentLogger(),
    callR, deriveRObjectStateKey, ...opts,
  });
  return w.runOnce();
}

async function seedProject(ownerUserId, name = 'P') {
  const org = await createOrganizationForUser(ownerUserId, { name: 'Acme' });
  return createProjectForUser(ownerUserId, { organizationId: org.id, name });
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Scope / registration (exactly one new type added; nothing else changed)
// ════════════════════════════════════════════════════════════════════════════
afterAll(async () => { if (!CONFIGURED) return; await dbmod.close(); });

describe.skipIf(!CONFIGURED)('r.object.inspect — scope & registration', () => {
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  it('registers r.object.inspect; generic / checkpoint.noop / r.runtime.check unchanged', async () => {
    expect(Object.keys(DEFAULT_HANDLERS).sort())
      .toEqual(['cellchat.infer.v1', 'checkpoint.fork.v1', 'checkpoint.load.v1', 'checkpoint.noop', 'condition.pseudobulk_de.v1', 'deg.find_markers.v1', 'enrichment.gsea.v1', 'expert.r.v1', 'explore.summarize.v1', 'generic', 'pbmc.pipeline.v1', 'r.object.inspect', 'r.runtime.check', 'seurat.pipeline.v1', 'spatial.seurat.v1']);
    expect(DEFAULT_HANDLERS['r.object.inspect']).toBe(rObjectInspectHandler);
    // Pre-existing handlers are the exact same functions (not swapped out).
    expect(DEFAULT_HANDLERS.generic).toBe(worker.genericNoopHandler);
    expect(DEFAULT_HANDLERS['checkpoint.noop']).toBe(worker.checkpointNoopHandler);
    expect(DEFAULT_HANDLERS['r.runtime.check']).toBe(worker.rRuntimeCheckHandler);
  });

  it('r.object.inspect is an allowed job type and r_object_inspection an allowed artifact type', async () => {
    expect(isValidJobType('r.object.inspect')).toBe(true);
    expect(isValidArtifactType('r_object_inspection')).toBe(true);
  });

  it('the r.object.inspect operation is allowlisted, read-only, object-scoped', async () => {
    expect(isAllowedRBridgeOperation('r.object.inspect')).toBe(true);
    const spec = R_BRIDGE_OPERATIONS['r.object.inspect'];
    expect(spec.method).toBe('GET');
    expect(spec.path).toBe('/object/inspect');
    expect(spec.artifactType).toBe('r_object_inspection');
    expect(spec.touchesAnalysisObject).toBe(true);
    expect(spec.requiresObjectContext).toBe(true);
    expect(spec.readOnly).toBe(true);
  });

  it('r.runtime.check is still allowlisted and unchanged (no object context)', async () => {
    expect(isAllowedRBridgeOperation('r.runtime.check')).toBe(true);
    const spec = R_BRIDGE_OPERATIONS['r.runtime.check'];
    expect(spec.method).toBe('GET');
    expect(spec.path).toBe('/health');
    expect(spec.requiresObjectContext).toBe(false);
  });

  it('an unsupported analytical job type still fails terminally (UNSUPPORTED_JOB_TYPE), no R contact', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const job = await createJobForUser(alice.id, { jobType: 'pca' });
    const calls = [];
    const res = await drainInspect(recordingInspectCaller(calls));
    expect(res.status).toBe('unsupported');
    expect(calls).toHaveLength(0);
    const after = await getJobForUser(job.id, alice.id);
    expect(after.status).toBe('failed');
    expect(after.error.code).toBe('UNSUPPORTED_JOB_TYPE');
  });

  it('the bridge module exposes NO express route/app (no public R bridge / download route)', async () => {
    for (const k of ['app', 'router', 'middleware', 'handler', 'routes', 'download']) {
      expect(bridge).not.toHaveProperty(k);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Bridge allowlist & input control (pure function; injected caller)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('r.object.inspect — bridge allowlist & input control', () => {
  const job = { id: 'job_abc', ownerUserId: 7, projectId: null, analysisObjectId: 'ao_1' };
  const objectContext = { objectId: 'ao_1', stateKey: 'user-7:obj-ao_1' };

  it('issues ONLY the server-defined GET /object/inspect with the server-derived X-Object-ID', async () => {
    const calls = [];
    const descriptor = await runRBridgeOperation({
      job, operation: 'r.object.inspect', objectContext,
      callR: recordingInspectCaller(calls), logger: silentLogger(),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].path).toBe('/object/inspect');
    expect(calls[0].objectStateKey).toBe('user-7:obj-ao_1');
    // Only these fields are ever issued — no code/endpoint/url/header passthrough.
    expect(Object.keys(calls[0]).sort()).toEqual(['method', 'objectStateKey', 'path', 'timeoutMs']);

    expect(descriptor.artifactType).toBe('r_object_inspection');
    expect(descriptor.storageKind).toBe('metadata_only');
    expect(descriptor.metadata.operation).toBe('r.object.inspect');
    expect(descriptor.metadata.kind).toBe('inspection');
    expect(descriptor.metadata.scientific_output).toBe(false);
    expect(descriptor.metadata.read_only).toBe(true);
    expect(descriptor.metadata.object).toMatchObject({
      exists: true, class: 'Seurat', nCells: 2700, nFeatures: 13714,
      assays: ['RNA'], reductions: ['pca', 'umap'],
    });
  });

  it('IGNORES caller input: smuggled code/path/endpoint/method/stateKey/objectContext do nothing', async () => {
    const calls = [];
    await runRBridgeOperation({
      job, operation: 'r.object.inspect',
      // The REAL, server-derived object context:
      objectContext,
      // Hostile input that must be ignored entirely:
      input: {
        operation: 'r.exec.arbitrary', code: 'system("rm -rf /")', rCode: 'q()',
        path: '/load-rds', endpoint: 'http://evil.example', url: 'http://evil.example',
        method: 'POST', stateKey: 'user-999:obj-ao_evil', objectId: 'ao_evil',
        objectContext: { objectId: 'ao_evil', stateKey: 'user-999:obj-ao_evil' },
      },
      callR: recordingInspectCaller(calls), logger: silentLogger(),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].path).toBe('/object/inspect');
    // The server-derived state key wins; the smuggled one never reaches R.
    expect(calls[0].objectStateKey).toBe('user-7:obj-ao_1');
    for (const f of ['code', 'rCode', 'endpoint', 'url', 'objectId']) {
      expect(calls[0]).not.toHaveProperty(f);
    }
  });

  it('rejects an arbitrary / non-allowlisted operation name WITHOUT contacting R', async () => {
    const calls = [];
    await expect(runRBridgeOperation({
      job, operation: 'r.exec.arbitrary', objectContext,
      callR: recordingInspectCaller(calls), logger: silentLogger(),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_R_OPERATION' });
    expect(calls).toHaveLength(0);
  });

  it('rejects object inspection with MISSING/malformed object context BEFORE contacting R', async () => {
    const calls = [];
    for (const bad of [undefined, {}, { objectId: 'ao_1' }, { stateKey: 'user-7:obj-ao_1' },
      { objectId: '', stateKey: '' }, { objectId: 'ao_1', stateKey: '' }]) {
      await expect(runRBridgeOperation({
        job, operation: 'r.object.inspect', objectContext: bad,
        callR: recordingInspectCaller(calls), logger: silentLogger(),
      })).rejects.toMatchObject({ code: 'R_OBJECT_CONTEXT_REQUIRED' });
    }
    expect(calls).toHaveLength(0);
  });

  it('createDefaultRCaller (defense-in-depth) refuses any non-allowlisted target BEFORE HTTP', async () => {
    const callR = createDefaultRCaller({ port: 8000, token: 't' });
    // Only the reviewed bridge targets exist; this set remains exact/closed.
    expect([...R_BRIDGE_ALLOWED_TARGETS].sort()).toEqual(['GET /health', 'GET /object/inspect', 'POST /object/cellchat-infer', 'POST /object/checkpoint-load', 'POST /object/condition-pseudobulk-de', 'POST /object/deg-find-markers', 'POST /object/enrichment-gsea', 'POST /object/explore-summary', 'POST /object/pbmc-pipeline', 'POST /object/seurat-pipeline', 'POST /object/spatial-seurat-pipeline']);
    expect(isAllowedRBridgeTarget('GET', '/object/inspect')).toBe(true);
    expect(isAllowedRBridgeTarget('GET', '/health')).toBe(true);
    expect(isAllowedRBridgeTarget('POST', '/object/inspect')).toBe(false);
    expect(isAllowedRBridgeTarget('GET', '/load-rds')).toBe(false);

    // Arbitrary path / mutating method / arbitrary endpoint are refused with a coded,
    // generic error — no HTTP is attempted (so no R_UNREACHABLE/host leak).
    for (const bad of [
      { method: 'GET', path: '/load-rds' },
      { method: 'POST', path: '/object/inspect' },
      { method: 'GET', path: '/object-info' },
      { method: 'DELETE', path: '/object/inspect' },
    ]) {
      await expect(callR(bad)).rejects.toMatchObject({ code: 'R_BRIDGE_TARGET_REJECTED' });
    }
  });

  it('sanitizes a transport error: raw URL/host/stack never escapes (object inspect)', async () => {
    const leaky = async () => { throw new Error('connect ECONNREFUSED http://127.0.0.1:8000/object/inspect (at /srv/app/x.js:1)'); };
    let thrown;
    try {
      await runRBridgeOperation({ job, operation: 'r.object.inspect', objectContext, callR: leaky, logger: silentLogger() });
    } catch (e) { thrown = e; }
    expect(thrown).toBeTruthy();
    expect(thrown.message).toBe('R bridge operation failed.');
    for (const f of ['ECONNREFUSED', 'http://', '127.0.0.1', '8000', '/srv/app', '.js:']) {
      expect(thrown.message).not.toContain(f);
    }
  });

  it('maps a coded timeout, and a non-200, to safe stable messages (no body leak)', async () => {
    const timeoutCaller = async () => { const e = new Error('socket hang up http://127.0.0.1:8000'); e.code = 'R_TIMEOUT'; throw e; };
    await expect(runRBridgeOperation({ job, operation: 'r.object.inspect', objectContext, callR: timeoutCaller, logger: silentLogger() }))
      .rejects.toMatchObject({ code: 'R_TIMEOUT', message: 'R runtime did not respond before the timeout.' });

    const errorCaller = async () => ({ status: 500, body: { error: 'R Error: /vault/u/obj.rds blew up at line 42' } });
    let thrown;
    try {
      await runRBridgeOperation({ job, operation: 'r.object.inspect', objectContext, callR: errorCaller, logger: silentLogger() });
    } catch (e) { thrown = e; }
    expect(thrown.code).toBe('R_OBJECT_INSPECT_FAILED');
    expect(thrown.message).toBe('R object inspection failed.');
    expect(thrown.message).not.toContain('/vault');
  });

  it('sanitizes the inspection summary: only the bounded allowlist of fields survives', async () => {
    const nasty = async () => ({
      status: 200,
      body: {
        exists: true, class: 'Seurat', n_cells: 10, n_features: 20,
        assays: ['RNA', 'SCT'], reductions: ['pca'], n_meta_fields: 2, meta_fields: ['a', 'b'],
        // Hostile / forbidden extras the bridge MUST drop:
        expression: [[1, 2], [3, 4]],
        cells: ['cell_1', 'cell_2'],
        genes: ['GENE1', 'GENE2'],
        embeddings: [[0.1, 0.2]],
        path: '/vault/u/obj.rds',
        state_key: 'user-7:obj-ao_1',
        token: 'API_TOKEN=secret',
        serialized: 'RAW_RDS_BLOB',
      },
    });
    const descriptor = await runRBridgeOperation({ job, operation: 'r.object.inspect', objectContext, callR: nasty, logger: silentLogger() });
    const summary = descriptor.metadata.object;
    expect(Object.keys(summary).sort()).toEqual(['assays', 'class', 'exists', 'metaFields', 'nCells', 'nFeatures', 'nMetaFields', 'reductions']);
    const blob = JSON.stringify(descriptor.metadata);
    for (const f of ['expression', 'GENE1', 'embeddings', '/vault', 'state_key', 'user-7:obj-', 'API_TOKEN', 'RAW_RDS_BLOB', 'cell_1']) {
      expect(blob, f).not.toContain(f);
    }
  });

  it('a missing/unloaded live object is reported safely as exists:false (still read-only)', async () => {
    const calls = [];
    const descriptor = await runRBridgeOperation({
      job, operation: 'r.object.inspect', objectContext,
      callR: recordingInspectCaller(calls, { exists: false }), logger: silentLogger(),
    });
    expect(descriptor.metadata.object).toEqual({ exists: false });
    expect(descriptor.metadata.read_only).toBe(true);
  });

  it('the summary sanitizers cap counts and name lists and drop unsafe values', async () => {
    expect(sanitizeCount(2700)).toBe(2700);
    expect(sanitizeCount(-1)).toBeNull();
    expect(sanitizeCount('5')).toBeNull();
    expect(sanitizeCount(Infinity)).toBeNull();
    expect(sanitizeNameList(['RNA', 'SCT'])).toEqual(['RNA', 'SCT']);
    expect(sanitizeNameList('not-an-array')).toEqual([]);
    expect(sanitizeNameList(Array.from({ length: 200 }, (_, i) => `f${i}`)).length).toBe(64);
    expect(sanitizeInspectionSummary({ exists: false, n_cells: 5 })).toEqual({ exists: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Object / project / owner validation (live-R ownership boundary)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('r.object.inspect — object/project/owner validation', () => {
  let server;
  beforeAll(async () => { server = await startServer(); });
  afterAll(() => { if (server) server.close(); });
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  it('the live-R object OWNER can inspect their own object (server-derived state key)', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const obj = await createAnalysisObjectForUser(alice.id, { objectType: 'seurat', displayName: 'aliceObj' });
    const job = await createJobForUser(alice.id, { jobType: 'r.object.inspect', analysisObjectId: obj.id });

    const calls = [];
    const res = await drainInspect(recordingInspectCaller(calls));
    expect(res.status).toBe('completed');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/object/inspect' });
    // The X-Object-ID is the SERVER-derived key — identical to what /api/r/* would send.
    expect(calls[0].objectStateKey).toBe(deriveRObjectStateKey(alice.id, obj.id));

    const arts = await getJobArtifactsByJobId(job.id);
    expect(arts).toHaveLength(1);
    expect(arts[0].artifactType).toBe('r_object_inspection');
  });

  it('a project co-member (analyst) CANNOT inspect another user\'s live object — fails before R', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    await createUserWithToken({ email: 'carol@example.com' });
    const proj = await seedProject(alice.user.id);
    await addProjectMemberByEmail(proj.id, 'carol@example.com', 'analyst', 'owner');
    const carol = await dbmod.getUserByEmail('carol@example.com');

    // Alice owns a live analysis object in the project.
    const aliceObj = await createProjectAnalysisObject(alice.user.id, proj.id, { objectType: 'seurat', displayName: 'aliceObj' });
    // Carol (analyst co-member) creates a project inspect job against ALICE's object.
    await createProjectJob(carol.id, proj.id, { jobType: 'r.object.inspect', analysisObjectId: aliceObj.id });

    const calls = [];
    const res = await drainInspect(recordingInspectCaller(calls));
    expect(res.status).toBe('failed');
    expect(res.error.message).toBe('Analysis object not found.'); // 404-style, no existence leak
    expect(calls).toHaveLength(0); // never reached R
    // No successful artifact for the rejected job.
    const jobs = await dbmod.listJobsForUser(carol.id, { jobType: 'r.object.inspect' });
    expect(await getJobArtifactsByJobId(jobs[0].id)).toHaveLength(0);
  });

  it('a project ADMIN co-member also cannot inspect another user\'s live object', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    await createUserWithToken({ email: 'bob@example.com' });
    const proj = await seedProject(alice.user.id);
    await addProjectMemberByEmail(proj.id, 'bob@example.com', 'admin', 'owner'); // even an admin
    const bob = await dbmod.getUserByEmail('bob@example.com');

    const aliceObj = await createProjectAnalysisObject(alice.user.id, proj.id, { objectType: 'seurat', displayName: 'aliceObj' });
    await createProjectJob(bob.id, proj.id, { jobType: 'r.object.inspect', analysisObjectId: aliceObj.id });

    const calls = [];
    const res = await drainInspect(recordingInspectCaller(calls));
    expect(res.status).toBe('failed');
    expect(calls).toHaveLength(0);
    // Ownership is still creator-keyed, not project-member-keyed.
    expect(await verifyAnalysisObjectOwner(alice.user.id, aliceObj.id)).toBe(true);
    expect(await verifyAnalysisObjectOwner(bob.id, aliceObj.id)).toBe(false);
  });

  it('a VIEWER cannot create/trigger an inspect job (403 by job policy)', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const viewer = await createUserWithToken({ email: 'viewer@example.com' });
    const proj = await seedProject(alice.user.id);
    await addProjectMemberByEmail(proj.id, 'viewer@example.com', 'viewer', 'owner');
    const obj = await createProjectAnalysisObject(alice.user.id, proj.id, { objectType: 'seurat', displayName: 'o' });

    const r = await api(server, `/api/projects/${proj.id}/jobs`, {
      method: 'POST', token: viewer.token,
      body: { jobType: 'r.object.inspect', analysisObjectId: obj.id },
    });
    expect(r.status).toBe(403);
  });

  it('a cross-project object reference is rejected with 404', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const projA = await seedProject(alice.user.id, 'A');
    const objA = await createProjectAnalysisObject(alice.user.id, projA.id, { objectType: 'seurat', displayName: 'a' });
    const orgB = await createOrganizationForUser(alice.user.id, { name: 'B' });
    const projB = await createProjectForUser(alice.user.id, { organizationId: orgB.id, name: 'B' });

    const r = await api(server, `/api/projects/${projB.id}/jobs`, {
      method: 'POST', token: alice.token,
      body: { jobType: 'r.object.inspect', analysisObjectId: objA.id },
    });
    expect(r.status).toBe(404);
  });

  it('a legacy owner-scoped object cannot be referenced by a project inspect job (404)', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const proj = await seedProject(alice.user.id);
    const legacyObj = await createAnalysisObjectForUser(alice.user.id, { objectType: 'seurat', displayName: 'legacy' }); // no project

    const r = await api(server, `/api/projects/${proj.id}/jobs`, {
      method: 'POST', token: alice.token,
      body: { jobType: 'r.object.inspect', analysisObjectId: legacyObj.id },
    });
    expect(r.status).toBe(404);
  });

  it('a malformed object ID is rejected with 400; an unknown well-formed one with 404', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const proj = await seedProject(alice.user.id);

    const malformed = await api(server, `/api/projects/${proj.id}/jobs`, {
      method: 'POST', token: alice.token,
      body: { jobType: 'r.object.inspect', analysisObjectId: 'not-an-object-id' },
    });
    expect(malformed.status).toBe(400);

    const unknown = await api(server, `/api/projects/${proj.id}/jobs`, {
      method: 'POST', token: alice.token,
      body: { jobType: 'r.object.inspect', analysisObjectId: 'ao_deadbeefdeadbeefdeadbeef' },
    });
    expect(unknown.status).toBe(404);
  });

  it('an inspect job WITHOUT an analysis object fails safely BEFORE R contact', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const job = await createJobForUser(alice.id, { jobType: 'r.object.inspect' }); // no analysisObjectId
    const calls = [];
    const res = await drainInspect(recordingInspectCaller(calls));
    expect(res.status).toBe('failed');
    expect(calls).toHaveLength(0);
    expect(await getJobArtifactsByJobId(job.id)).toHaveLength(0);
  });

  it('client-supplied object/state/owner/project overrides in parameters are ignored', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const obj = await createAnalysisObjectForUser(alice.id, { objectType: 'seurat', displayName: 'o' });
    await createJobForUser(alice.id, {
      jobType: 'r.object.inspect',
      analysisObjectId: obj.id,
      parameters: {
        objectId: 'ao_evil', stateKey: 'user-999:obj-ao_evil', ownerEmail: 'evil@x',
        ownerUserId: 999, projectId: 'proj_evil', userId: 999,
        endpoint: 'http://evil', path: '/load-rds', method: 'POST', token: 'evil',
      },
    });
    const calls = [];
    const res = await drainInspect(recordingInspectCaller(calls));
    expect(res.status).toBe('completed');
    // The R call used the SERVER-derived key for alice's real object — not the smuggled one.
    expect(calls).toHaveLength(1);
    expect(calls[0].objectStateKey).toBe(deriveRObjectStateKey(alice.id, obj.id));
    expect(calls[0].path).toBe('/object/inspect');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Read-only / mutation safety
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('r.object.inspect — read-only / no mutation', () => {
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  it('inspection creates NO result analysis object / checkpoint and does not mutate the object', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const obj = await createAnalysisObjectForUser(alice.id, { objectType: 'seurat', displayName: 'o' });
    const before = await getAnalysisObjectForUser(obj.id, alice.id);
    const job = await createJobForUser(alice.id, { jobType: 'r.object.inspect', analysisObjectId: obj.id });

    const res = await drainInspect(recordingInspectCaller([]));
    expect(res.status).toBe('completed');

    const after = await getJobForUser(job.id, alice.id);
    expect(after.resultAnalysisObjectId).toBeFalsy(); // no checkpoint / result object

    // The inspected object is byte-for-byte unchanged (status/lineage/metadata/etc.).
    expect(await getAnalysisObjectForUser(obj.id, alice.id)).toEqual(before);
  });

  it('only ever calls the read-only GET /object/inspect target (never a mutating endpoint)', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const obj = await createAnalysisObjectForUser(alice.id, { objectType: 'seurat', displayName: 'o' });
    await createJobForUser(alice.id, { jobType: 'r.object.inspect', analysisObjectId: obj.id });
    const calls = [];
    await drainInspect(recordingInspectCaller(calls));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].path).toBe('/object/inspect');
  });

  it('repeated inspection does not change object state (object stable across two jobs)', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const obj = await createAnalysisObjectForUser(alice.id, { objectType: 'seurat', displayName: 'o' });
    const before = await getAnalysisObjectForUser(obj.id, alice.id);

    const job1 = await createJobForUser(alice.id, { jobType: 'r.object.inspect', analysisObjectId: obj.id });
    expect((await drainInspect(recordingInspectCaller([]))).status).toBe('completed');
    const job2 = await createJobForUser(alice.id, { jobType: 'r.object.inspect', analysisObjectId: obj.id });
    expect((await drainInspect(recordingInspectCaller([]))).status).toBe('completed');

    expect(await getAnalysisObjectForUser(obj.id, alice.id)).toEqual(before);
    // Each job recorded exactly one artifact; neither created a checkpoint.
    expect(await getJobArtifactsByJobId(job1.id)).toHaveLength(1);
    expect(await getJobArtifactsByJobId(job2.id)).toHaveLength(1);
    expect((await getJobForUser(job1.id, alice.id)).resultAnalysisObjectId).toBeFalsy();
    expect((await getJobForUser(job2.id, alice.id)).resultAnalysisObjectId).toBeFalsy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Worker integration (claim → bridge → exactly-one artifact through contract)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('r.object.inspect — worker integration', () => {
  let alice, obj;
  beforeEach(async () => {
    await dbmod.resetSchemaForTests();
    alice = await createUser('alice@example.com', 'password123', 'Alice');
    obj = await createAnalysisObjectForUser(alice.id, { objectType: 'seurat', displayName: 'o' });
  });


  it('a successful inspection completes through the worker contract with EXACTLY one metadata-only artifact', async () => {
    const job = await createJobForUser(alice.id, { jobType: 'r.object.inspect', analysisObjectId: obj.id });
    const calls = [];
    const res = await drainInspect(recordingInspectCaller(calls));

    expect(res.status).toBe('completed');
    expect(res.result).toMatchObject({ ok: true, handled: 'r.object.inspect', operation: 'r.object.inspect' });

    const after = await getJobForUser(job.id, alice.id);
    expect(after.status).toBe('completed');
    expect(after.resultAnalysisObjectId).toBeFalsy();

    const arts = await getJobArtifactsByJobId(job.id);
    expect(arts).toHaveLength(1);
    expect(arts[0].id).toBe(res.result.artifactId);
    expect(arts[0].artifactType).toBe('r_object_inspection');
    expect(arts[0].storageKind).toBe('metadata_only');
    expect(arts[0].resultAnalysisObjectId).toBeFalsy();
    expect(arts[0].metadata.kind).toBe('inspection');
    expect(arts[0].metadata.read_only).toBe(true);
    expect(arts[0].metadata.scientific_output).toBe(false);

    // Durable, sanitized logs (no state key in them).
    const messages = after.logs.map((l) => l.message);
    expect(messages.some((m) => /r\.object\.inspect handler/i.test(m))).toBe(true);
    expect(messages.some((m) => /metadata-only artifact/i.test(m))).toBe(true);
    expect(JSON.stringify(after.logs)).not.toContain(deriveRObjectStateKey(alice.id, obj.id));
  });

  it('a failed R call fails the job with a sanitized error and NO successful artifact', async () => {
    const job = await createJobForUser(alice.id, { jobType: 'r.object.inspect', analysisObjectId: obj.id });
    const leaky = async () => { throw new Error('connect ECONNREFUSED http://127.0.0.1:8000/object/inspect'); };
    const res = await drainInspect(leaky);

    expect(res.status).toBe('failed');
    const after = await getJobForUser(job.id, alice.id);
    expect(after.status).toBe('failed');
    const blob = JSON.stringify(after);
    for (const f of ['ECONNREFUSED', 'http://', '127.0.0.1', '8000']) expect(blob).not.toContain(f);
    expect(await getJobArtifactsByJobId(job.id)).toHaveLength(0);
  });

  it('a canceled job (mid-call) finalizes NO artifact and is not resurrected', async () => {
    const job = await createJobForUser(alice.id, { jobType: 'r.object.inspect', analysisObjectId: obj.id });
    const cancelMidCall = async () => { await cancelJobForUser(alice.id, job.id); return { status: 200, body: inspectBody() }; };
    const res = await drainInspect(cancelMidCall);

    expect(res.status).toBe('claim_lost');
    expect((await getJobForUser(job.id, alice.id)).status).toBe('canceled');
    expect(await getJobArtifactsByJobId(job.id)).toHaveLength(0);
  });

  it('claim loss (reaped lease) before the artifact write prevents finalizing any artifact', async () => {
    const job = await createJobForUser(alice.id, { jobType: 'r.object.inspect', analysisObjectId: obj.id });
    await setJobScheduling(job.id, { maxAttempts: 2 });
    const stale = await claimNextJob('worker_stale', { now: T0, leaseSeconds: 30 });
    expect(stale.id).toBe(job.id);
    await reapExpiredJobs({ now: LATER });

    await expect(createJobArtifactByWorker(job.id, 'worker_stale', stale.claimToken,
        { artifactType: 'r_object_inspection', storageKind: 'metadata_only', metadata: {} }, { now: LATER })).rejects.toThrow(/claim/i);
    expect(await getJobArtifactsByJobId(job.id)).toHaveLength(0);
  });

  it('two workers cannot create duplicate artifacts for the same inspect job', async () => {
    const job = await createJobForUser(alice.id, { jobType: 'r.object.inspect', analysisObjectId: obj.id });
    const a = createJobWorker({ db: dbmod, workerId: 'worker_a', now: () => T0, logger: silentLogger(), callR: recordingInspectCaller([]), deriveRObjectStateKey });
    const b = createJobWorker({ db: dbmod, workerId: 'worker_b', now: () => T0, logger: silentLogger(), callR: recordingInspectCaller([]), deriveRObjectStateKey });

    const resA = await a.runOnce();
    const resB = await b.runOnce();
    expect([resA.status, resB.status].sort()).toEqual(['completed', 'idle']);
    expect((await getJobForUser(job.id, alice.id)).status).toBe('completed');
    expect(await getJobArtifactsByJobId(job.id)).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Artifact public exposure (project-scoped HTTP reads; no leaks)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('r.object.inspect — artifact public exposure', () => {
  let server;
  beforeAll(async () => { server = await startServer(); });
  afterAll(() => { if (server) server.close(); });
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  // Drive a project inspect job (owned by the object owner) to completion.
  async function seedInspectArtifact(projectId, ownerUserId) {
    const obj = await createProjectAnalysisObject(ownerUserId, projectId, { objectType: 'seurat', displayName: 'o' });
    const job = await createProjectJob(ownerUserId, projectId, { jobType: 'r.object.inspect', analysisObjectId: obj.id });
    const res = await drainInspect(recordingInspectCaller([]));
    const arts = await listProjectArtifacts(ownerUserId, projectId);
    return { obj, job, artifact: arts[0], res };
  }

  it('every project member role (incl. viewer) can read the r_object_inspection metadata', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const viewer = await createUserWithToken({ email: 'viewer@example.com' });
    const proj = await seedProject(alice.user.id);
    await addProjectMemberByEmail(proj.id, 'viewer@example.com', 'viewer', 'owner');
    const { job, artifact, res } = await seedInspectArtifact(proj.id, alice.user.id);
    expect(res.status).toBe('completed');
    expect(artifact.artifactType).toBe('r_object_inspection');

    for (const m of [alice, viewer]) {
      const list = await api(server, `/api/projects/${proj.id}/artifacts`, { token: m.token });
      expect(list.status).toBe(200);
      expect(list.data).toHaveLength(1);

      const one = await api(server, `/api/projects/${proj.id}/artifacts/${artifact.id}`, { token: m.token });
      expect(one.status).toBe(200);
      expect(one.data.artifactType).toBe('r_object_inspection');
      expect(one.data.metadata.kind).toBe('inspection');
      expect(one.data.metadata.read_only).toBe(true);
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
    const { job, artifact } = await seedInspectArtifact(proj.id, alice.user.id);

    expect((await api(server, `/api/projects/${proj.id}/artifacts`, { token: dave.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/artifacts/${artifact.id}`, { token: dave.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/jobs/${job.id}/artifacts`, { token: dave.token })).status).toBe(404);
  });

  it('the public artifact response exposes NO raw R output / state key / path / URL / token / worker internals / stacks', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const proj = await seedProject(alice.user.id);
    const { obj, artifact } = await seedInspectArtifact(proj.id, alice.user.id);

    const one = await api(server, `/api/projects/${proj.id}/artifacts/${artifact.id}`, { token: alice.token });
    expect(one.status).toBe(200);
    const blob = JSON.stringify(one.data);
    for (const f of [
      'storageUri', 'storage_uri', 'downloadUrl', 'download_url',
      'internalStorageKey', 'stateKey', 'state_key',
      deriveRObjectStateKey(alice.user.id, obj.id), // the actual R state key string
      'claimToken', 'claim_token', 'workerId', 'worker_id', 'leaseExpiresAt',
      'vault/', '/etc/', 'http://', '127.0.0.1', 'X-API-Token', 'API_TOKEN',
      'ECONNREFUSED', '.js:',
    ]) {
      expect(blob, f).not.toContain(f);
    }
    // Safe, bounded inspection metadata IS present.
    expect(one.data.metadata.operation).toBe('r.object.inspect');
    expect(one.data.metadata.object.exists).toBe(true);
    expect(one.data).not.toHaveProperty('storageUri');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. R boundary regression (deriveRStateKey / verifyRObjectOwnership / /api/r/*)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('r.object.inspect — R boundary unchanged', () => {
  let server;
  beforeAll(async () => { server = await startServer(); });
  afterAll(() => { if (server) server.close(); });
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  it('deriveRStateKey stays server-derived: the new helper matches the session-facing wrapper', async () => {
    for (const [id, objId] of [[5, 'ao_abc'], [42, null], [7, 'ao_deadbeef']]) {
      expect(deriveRObjectStateKey(id, objId)).toBe(deriveRStateKey({ id }, objId));
    }
    // No-object form is exactly the user prefix (unchanged behavior).
    expect(deriveRObjectStateKey(5)).toBe('user-5');
  });

  it('verifyRObjectOwnership remains owner-verifying (membership ≠ ownership)', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const bob = await createUser('bob@example.com', 'password123', 'Bob');
    const obj = await createAnalysisObjectForUser(alice.id, { objectType: 'seurat', displayName: 'o' });
    expect(await verifyAnalysisObjectOwner(alice.id, obj.id)).toBe(true);
    expect(await verifyAnalysisObjectOwner(bob.id, obj.id)).toBe(false);
  });

  it('/api/r/* still rejects a project co-member supplying another user\'s object id (404, before R)', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const bob = await createUserWithToken({ email: 'bob@example.com' });
    const org = await createOrganizationForUser(alice.user.id, { name: 'Acme' });
    const proj = await createProjectForUser(alice.user.id, { organizationId: org.id, name: 'P' });
    await addProjectMemberByEmail(proj.id, 'bob@example.com', 'admin', 'owner');
    const aliceObj = await createProjectAnalysisObject(alice.user.id, proj.id, { objectType: 'seurat', displayName: 'o' });

    // Bob is a project admin, but Alice's live R object is still not his to address.
    const r = await api(server, '/api/r/health', { token: bob.token, headers: { 'X-Object-ID': aliceObj.id } });
    expect(r.status).toBe(404);
  });
});
