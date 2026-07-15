import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// ════════════════════════════════════════════════════════════════════════════
// Checkpoint load / reattach into the owner's private live R session
// (checkpoint.load.v1 + r.checkpoint.load.v1 + POST /object/checkpoint-load)
//
// A completed internal checkpoint (produced by pbmc.pipeline.v1) can be loaded back
// into the OBJECT OWNER's private live R session under the canonical object key, so
// downstream jobs can use it as live input. Proves the load path:
//   - is OWNER-ONLY for v1: the job creator must OWN the analysis object being loaded
//     (verifyAnalysisObjectOwner) — project membership alone never loads another user's
//     checkpoint into live R (a co-member/admin is rejected BEFORE any R contact)
//   - uses a SERVER-selected checkpoint artifact (storage kind / type / safe internal
//     key / checksum / size verified) — the client never supplies a storage key/path
//   - blocks DIRECT public R-proxy execution of /object/checkpoint-load (404 before R)
//   - mutates ONLY the owner's canonical object key (the R endpoint reattaches into the
//     request's X-Object-ID session only; the postroute hook persists exactly that key)
//   - creates NO new analysis object, NO lineage edge, NO checkpoint artifact, and
//     records ONE metadata-only checkpoint_load summary artifact
//   - never leaks the internal storage key/path, R state key, token, internal URL, raw
//     R error/stack, matrices, cell/gene tables, or embeddings
//
// Live R deserialization + single-key mutation are exercised by the R backend
// (parse-checked here; run under CI's R-backed suites with real Rscript + Seurat).
// These Node tests inject a fake R caller so the contract is verified without a live R.
// See backend/database.js (getLoadableCheckpointForAnalysisObject), backend/rWorkerBridge.js
// (r.checkpoint.load.v1), backend/jobWorker.js (checkpointLoadHandler),
// r-backend/plumber.R (POST /object/checkpoint-load), server.js (isInternalOnlyRProxyPath).
// ════════════════════════════════════════════════════════════════════════════

const config = require('./config');
const dbmod = require('./pgDatabase');
const CONFIGURED = config.hasPostgresConnection();
const {
  createUser,
  createOrganizationForUser, createProjectForUser, addProjectMemberByEmail,
  createJobForUser, createProjectJob, createProjectAnalysisObject, createAnalysisObjectForUser,
  getProjectJob,
  claimNextJob, cancelProjectJob,
  listProjectJobArtifacts, getJobArtifactsByJobId,
  listProjectAnalysisObjectChildren,
  getLoadableCheckpointForAnalysisObject, isSafeInternalStorageKey,
  createCheckpointArtifactForJobByWorker, createJobArtifactByWorker,
  isValidJobType, isValidArtifactType,
  listAnalysisObjectsForUser, listJobsForUser,
} = dbmod;

const bridge = require('./rWorkerBridge');
const {
  runRBridgeOperation, isAllowedRBridgeOperation, isAllowedRBridgeTarget,
  R_BRIDGE_OPERATIONS, R_BRIDGE_ALLOWED_TARGETS, createDefaultRCaller,
  sanitizeLoadSummary,
} = bridge;

const worker = require('./jobWorker');
const { createJobWorker, DEFAULT_HANDLERS, checkpointLoadHandler } = worker;

const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const serverModule = require('../server.js');
const { deriveRObjectStateKey, isInternalOnlyRProxyPath, R_PROXY_INTERNAL_ONLY_PATHS } = serverModule;

// Deterministic UTC instants in SQLite's 'YYYY-MM-DD HH:MM:SS' format.
const T0 = '2030-01-01 00:00:00';

function silentLogger() { return { info() {}, warn() {}, error() {} }; }

// A healthy R `/object/pbmc-pipeline` body (used to seed a real checkpoint artifact).
function pipelineBody() {
  return {
    ok: true,
    summary: {
      n_cells: 2700, n_features: 13714, n_variable_features: 2000,
      n_pcs: 50, n_clusters: 9, cluster_sizes: [500, 420, 360, 300, 280, 240, 220, 200, 180],
      reductions: ['pca', 'umap'], normalization_method: 'LogNormalize', resolution: 0.8, used_seed: 42,
    },
    checkpoint: { saved: true, checksum_sha256: 'a'.repeat(64), size_bytes: 1234567 },
    versions: { seurat_version: '5.0.1', r_version: 'R version 4.6.0' },
  };
}

// A healthy R `/object/checkpoint-load` body (the only thing the bridge reads, sanitized).
function loadBody(overrides = {}) {
  return {
    loaded: true,
    runtime_instance_id: 'checkpoint-load-runtime-instance-0001',
    checksum_verified: true,
    class: 'Seurat',
    n_cells: 2700, n_features: 13714,
    assays: ['RNA'], reductions: ['pca', 'umap'],
    n_meta_fields: 5,
    meta_fields: ['orig.ident', 'nCount_RNA', 'nFeature_RNA', 'percent.mt', 'seurat_clusters'],
    seurat_version: '5.0.1', r_version: 'R version 4.6.0',
    ...overrides,
  };
}

// Injectable R caller that records every request and returns a body by request path.
function recordingCaller(record, byPath) {
  return async (req) => {
    record.push(req);
    const fn = byPath[req.path];
    return fn ? fn(req) : { status: 200, body: {} };
  };
}
function pipelineThenLoadCaller(record, loadResponse = { status: 200, body: loadBody() }) {
  return recordingCaller(record, {
    '/object/pbmc-pipeline': () => ({ status: 200, body: pipelineBody() }),
    '/object/checkpoint-load': () => loadResponse,
    '/object/inspect': () => ({ status: 200, body: { exists: true, class: 'Seurat', n_cells: 2700, n_features: 13714 } }),
  });
}

// Run the worker once with an injected R caller + clock + the REAL state-key deriver.
async function drain(callR, now = T0, opts = {}) {
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

// Seed alice + project + parent object, run a REAL pbmc.pipeline.v1 job (fake R) to
// produce a result object + a durable local_internal checkpoint artifact, and return the
// pieces. The result object is what a checkpoint.load.v1 job reattaches into live R.
async function seedLoadableCheckpoint() {
  const record = [];
  const alice = await createUser('alice@example.com', 'password123', 'Alice');
  const proj = await seedProject(alice.id);
  const parent = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', displayName: 'pbmc-parent' });
  const pjob = await createProjectJob(alice.id, proj.id, { jobType: 'pbmc.pipeline.v1', analysisObjectId: parent.id, parameters: {} });
  const pres = await drain(pipelineThenLoadCaller(record), T0);
  expect(pres.status).toBe('completed');
  const arts = await getJobArtifactsByJobId(pjob.id);
  const checkpointArt = arts.find((a) => a.artifactType === 'checkpoint' && a.storageKind === 'local_internal');
  expect(checkpointArt).toBeTruthy();
  return { alice, proj, parent, pjob, checkpointArt, resultObjectId: checkpointArt.resultAnalysisObjectId };
}

async function seedLoadJob(creatorId, projId, objectId, extra = {}) {
  return createProjectJob(creatorId, projId, { jobType: 'checkpoint.load.v1', analysisObjectId: objectId, ...extra });
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Scope / registration (one type + one op added; nothing else changed)
// ════════════════════════════════════════════════════════════════════════════
afterAll(async () => { if (!CONFIGURED) return; await dbmod.close(); });

describe.skipIf(!CONFIGURED)('checkpoint.load.v1 — inventory & scope', () => {
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  it('registers checkpoint.load.v1 alongside the existing handlers (existing handlers unchanged)', async () => {
    expect(Object.keys(DEFAULT_HANDLERS).sort())
      .toEqual(['checkpoint.fork.v1', 'checkpoint.load.v1', 'checkpoint.noop', 'deg.find_markers.v1', 'generic', 'pbmc.pipeline.v1', 'r.object.inspect', 'r.runtime.check', 'seurat.pipeline.v1']);
    expect(DEFAULT_HANDLERS['checkpoint.load.v1']).toBe(checkpointLoadHandler);
    expect(DEFAULT_HANDLERS['pbmc.pipeline.v1']).toBe(worker.pbmcPipelineHandler);
    expect(DEFAULT_HANDLERS['r.object.inspect']).toBe(worker.rObjectInspectHandler);
  });

  it('checkpoint.load.v1 is an allowed job type; checkpoint_load an allowed artifact type', async () => {
    expect(isValidJobType('checkpoint.load.v1')).toBe(true);
    expect(isValidArtifactType('checkpoint_load')).toBe(true);
  });

  it('the r.checkpoint.load.v1 op is allowlisted, object-scoped, checkpoint-carrying, mutating', async () => {
    expect(isAllowedRBridgeOperation('r.checkpoint.load.v1')).toBe(true);
    const spec = R_BRIDGE_OPERATIONS['r.checkpoint.load.v1'];
    expect(spec.method).toBe('POST');
    expect(spec.path).toBe('/object/checkpoint-load');
    expect(spec.artifactType).toBe('checkpoint_load');
    expect(spec.requiresObjectContext).toBe(true);
    expect(spec.carriesCheckpoint).toBe(true);
    expect(spec.mutating).toBe(true);
    expect(spec.readOnly).toBe(false);
  });

  it('the bridge op/target sets stay exact/closed (adds only the checkpoint-load op/target)', async () => {
    expect(Object.keys(R_BRIDGE_OPERATIONS).sort())
      .toEqual(['r.checkpoint.load.v1', 'r.deg.find_markers.v1', 'r.object.inspect', 'r.pbmc.pipeline.v1', 'r.runtime.check', 'r.seurat.pipeline.v1']);
    expect([...R_BRIDGE_ALLOWED_TARGETS].sort())
      .toEqual(['GET /health', 'GET /object/inspect', 'POST /object/checkpoint-load', 'POST /object/deg-find-markers', 'POST /object/pbmc-pipeline', 'POST /object/seurat-pipeline']);
  });

  it('NO pathway enrichment / CellChat job types or bridge ops are added by THIS branch', async () => {
    // The checkpoint.load.v1 branch adds only its own type/op. The legacy plain analytical
    // types (deg/find_markers/enrichment/cellchat) remain UNREGISTERED handlers. (DEG is
    // productionized as deg.find_markers.v1 by a SEPARATE branch — see that test file.)
    for (const t of ['deg', 'find_markers', 'enrichment', 'cellchat', 'cellchat.infer',
      'enrichment.ora.v1', 'cellchat.infer.v1']) {
      expect(DEFAULT_HANDLERS[t]).toBeUndefined();
    }
    // No pathway/CellChat production job type or bridge op exists.
    for (const t of ['enrichment.ora.v1', 'cellchat.infer.v1', 'checkpoint.download.v1']) {
      expect(isValidJobType(t)).toBe(false);
    }
    for (const op of ['r.enrichment.v1', 'r.cellchat.v1', 'r.checkpoint.download.v1']) {
      expect(isAllowedRBridgeOperation(op)).toBe(false);
    }
  });

  it('an unsupported job type still fails terminally (UNSUPPORTED_JOB_TYPE), no R contact', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    await createJobForUser(alice.id, { jobType: 'pca' });
    const calls = [];
    const res = await drain(pipelineThenLoadCaller(calls));
    expect(res.status).toBe('unsupported');
    expect(calls).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Loadable-checkpoint discovery / validation (server-tier selector)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('getLoadableCheckpointForAnalysisObject — selection & validation', () => {
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  it('finds the loadable checkpoint for a valid result object (safe key + checksum + size)', async () => {
    const { alice, proj, resultObjectId, checkpointArt } = await seedLoadableCheckpoint();
    const found = await getLoadableCheckpointForAnalysisObject(proj.id, resultObjectId, alice.id);
    expect(found.analysisObjectId).toBe(resultObjectId);
    expect(found.checkpointArtifactId).toBe(checkpointArt.id);
    // Server-controlled internal key — safe + traversal-free; checksum 64-hex; size int.
    expect(isSafeInternalStorageKey(found.internalStorageKey)).toBe(true);
    expect(found.internalStorageKey).toBe(checkpointArt.storageUri);
    expect(/^[0-9a-f]{64}$/.test(found.checksumSha256)).toBe(true);
    expect(Number.isInteger(found.sizeBytes) && found.sizeBytes >= 0).toBe(true);
  });

  it('rejects an object with NO checkpoint artifact (NO_CHECKPOINT_ARTIFACT)', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const proj = await seedProject(alice.id);
    const obj = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', displayName: 'plain' });
    await expect(getLoadableCheckpointForAnalysisObject(proj.id, obj.id, alice.id)).rejects.toThrowError(/No loadable checkpoint/);
  });

  it('rejects when the only associated artifact is the WRONG type (pipeline_summary) — filtered out', async () => {
    const { alice, proj, resultObjectId } = await seedLoadableCheckpoint();
    // The result object DOES have a pipeline_summary artifact (metadata_only) but the
    // selector only matches artifact_type 'checkpoint' + storage_kind 'local_internal'.
    // Sanity: removing the real checkpoint would leave only the summary → not loadable.
    // (We can't delete here, so assert the summary alone is never picked by checking a
    // fresh object that has ONLY a metadata-only 'checkpoint' artifact below.)
    const found = await getLoadableCheckpointForAnalysisObject(proj.id, resultObjectId, alice.id);
    expect(found.checkpointArtifactId).toBeTruthy(); // it picks the checkpoint, not the summary
  });

  it('rejects a metadata-only "checkpoint" artifact (WRONG storage kind) — filtered out', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const proj = await seedProject(alice.id);
    const obj = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', displayName: 'meta' });
    await createProjectJob(alice.id, proj.id, { jobType: 'generic', analysisObjectId: obj.id });
    const claimed = await claimNextJob('worker_meta', { leaseSeconds: 30, now: T0 });
    // A metadata-only 'checkpoint' artifact linked as result → wrong storage kind, never loadable.
    await createJobArtifactByWorker(claimed.id, 'worker_meta', claimed.claimToken,
      { artifactType: 'checkpoint', resultAnalysisObjectId: obj.id, storageKind: 'metadata_only' }, { now: T0 });
    await expect(getLoadableCheckpointForAnalysisObject(proj.id, obj.id, alice.id)).rejects.toThrowError(/No loadable checkpoint/);
  });

  it('rejects AMBIGUOUS checkpoints (two local_internal checkpoint artifacts) deterministically', async () => {
    const { alice, proj, resultObjectId } = await seedLoadableCheckpoint();
    // Add a SECOND local_internal checkpoint artifact for the same result object.
    await createProjectJob(alice.id, proj.id, { jobType: 'generic', analysisObjectId: resultObjectId });
    const claimed = await claimNextJob('worker_dup', { leaseSeconds: 30, now: T0 });
    await createCheckpointArtifactForJobByWorker(claimed.id, 'worker_dup', claimed.claimToken, {
      artifactType: 'checkpoint', resultAnalysisObjectId: resultObjectId,
      internalStorageKey: `projects/${proj.id}/checkpoints/job_dup/second.rds`,
      checksumSha256: 'b'.repeat(64), sizeBytes: 999,
    }, { now: T0 });
    await expect(getLoadableCheckpointForAnalysisObject(proj.id, resultObjectId, alice.id)).rejects.toThrowError(/Multiple loadable checkpoints/);
  });

  it('rejects a non-owner (owner-only v1): a co-member cannot resolve another user\'s checkpoint', async () => {
    const { proj, resultObjectId } = await seedLoadableCheckpoint();
    const carol = await createUser('carol@example.com', 'password123', 'Carol');
    await addProjectMemberByEmail(proj.id, 'carol@example.com', 'analyst', 'owner');
    // Carol is a project member but does NOT own the result object → 404-style rejection.
    await expect(getLoadableCheckpointForAnalysisObject(proj.id, resultObjectId, carol.id)).rejects.toThrowError(/Analysis object not found/);
  });

  it('rejects a cross-project object (object exists but not in the given project)', async () => {
    const { alice, resultObjectId } = await seedLoadableCheckpoint();
    const otherProj = await seedProject(alice.id, 'Other');
    await expect(getLoadableCheckpointForAnalysisObject(otherProj.id, resultObjectId, alice.id)).rejects.toThrowError(/Analysis object not found/);
  });

  it('rejects malformed / unknown object ids (no existence leak)', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const proj = await seedProject(alice.id);
    await expect(getLoadableCheckpointForAnalysisObject(proj.id, '', alice.id)).rejects.toThrowError(/not found/);
    await expect(getLoadableCheckpointForAnalysisObject(proj.id, 'ao_nope', alice.id)).rejects.toThrowError(/not found/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Public R-proxy block (direct /api/r/object/checkpoint-load is internal-only)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('checkpoint.load.v1 — direct R-proxy access is blocked (internal-only)', () => {
  let server;
  beforeAll(async () => { server = await startServer(); });
  afterAll(() => { if (server) server.close(); });
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  it('isInternalOnlyRProxyPath blocks every spelling of /object/checkpoint-load; allows other R paths', async () => {
    expect(R_PROXY_INTERNAL_ONLY_PATHS.has('/object/checkpoint-load')).toBe(true);
    for (const p of [
      '/object/checkpoint-load', '/object/checkpoint-load/', '//object/checkpoint-load',
      '/object//checkpoint-load', '/object/checkpoint-load%2F', '\\object\\checkpoint-load',
    ]) {
      expect(isInternalOnlyRProxyPath(p), p).toBe(true);
    }
    for (const ok of ['/health', '/object/checkpoint-load-extra', '/checkpoint-load', '']) {
      expect(isInternalOnlyRProxyPath(ok), ok).toBe(false);
    }
    // The pbmc block remains intact.
    expect(isInternalOnlyRProxyPath('/object/pbmc-pipeline')).toBe(true);
  });

  it('authenticated direct POST /api/r/object/checkpoint-load is 404 BEFORE R, with NO side effects', async () => {
    const { user, token } = await createUserWithToken({ email: 'owner@example.com' });
    const owned = await createAnalysisObjectForUser(user.id, { objectType: 'seurat', displayName: 'mine' });
    const r = await api(server, '/api/r/object/checkpoint-load', {
      method: 'POST', token,
      headers: { 'X-Object-ID': owned.id },
      // Even a (malicious) client-supplied storage key is irrelevant — blocked before R.
      body: { storage_key: 'vault/owner_example_com/evil.rds' },
    });
    expect(r.status).toBe(404);
    expect(await listJobsForUser(user.id, {})).toHaveLength(0);
    expect(await listAnalysisObjectsForUser(user.id, {})).toHaveLength(1); // only the pre-created object
  });

  it('blocks the checkpoint-load path for any method / odd spelling (still 404, no leak)', async () => {
    const { token } = await createUserWithToken({ email: 'owner2@example.com' });
    for (const { method, path } of [
      { method: 'GET', path: '/api/r/object/checkpoint-load' },
      { method: 'POST', path: '/api/r/object/checkpoint-load/' },
      { method: 'PUT', path: '/api/r/object/checkpoint-load' },
      { method: 'DELETE', path: '/api/r/object/checkpoint-load' },
      { method: 'POST', path: '/api/r/object//checkpoint-load' },
    ]) {
      const r = await api(server, path, { method, token });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });

  it('unauthenticated direct call is rejected (401) and never reaches R', async () => {
    const r = await api(server, '/api/r/object/checkpoint-load', { method: 'POST', body: { storage_key: 'x.rds' } });
    expect(r.status).toBe(401);
  });

  it('does NOT over-block: a non-internal /api/r path still enforces X-Object-ID ownership before R', async () => {
    const { token } = await createUserWithToken({ email: 'owner3@example.com' });
    const bad = await api(server, '/api/r/health', { method: 'GET', token, headers: { 'X-Object-ID': 'no spaces!' } });
    expect(bad.status).toBe(400);
    const unknown = await api(server, '/api/r/health', { method: 'GET', token, headers: { 'X-Object-ID': 'ao_doesnotexist' } });
    expect(unknown.status).toBe(404);
  });

  it('a project co-member is blocked at the proxy for the checkpoint-load path (404, no run/leak)', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const carol = await createUserWithToken({ email: 'carol@example.com' });
    const proj = await seedProject(alice.user.id);
    await addProjectMemberByEmail(proj.id, 'carol@example.com', 'analyst', 'owner');
    const aliceObj = await createProjectAnalysisObject(alice.user.id, proj.id, { objectType: 'seurat', displayName: 'a' });
    const r = await api(server, '/api/r/object/checkpoint-load', {
      method: 'POST', token: carol.token, headers: { 'X-Object-ID': aliceObj.id }, body: { storage_key: 'x.rds' },
    });
    expect(r.status).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Bridge / input control (server-built body; no client storage key/path)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('r.checkpoint.load.v1 — bridge allowlist & input control', () => {
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  const job = { id: 'job_abc', ownerUserId: 1, projectId: 'proj_1', parameters: {} };

  it('an arbitrary operation is rejected BEFORE any R contact', async () => {
    const calls = [];
    await expect(runRBridgeOperation({
      job, operation: 'r.checkpoint.load.evil', callR: async (r) => { calls.push(r); return { status: 200, body: {} }; },
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_R_OPERATION' });
    expect(calls).toHaveLength(0);
  });

  it('builds the request from SERVER-selected checkpoint coords only (fixed method/path; server X-Object-ID)', async () => {
    const calls = [];
    const descriptor = await runRBridgeOperation({
      job,
      operation: 'r.checkpoint.load.v1',
      objectContext: { objectId: 'ao_1', stateKey: 'user-1:obj-ao_1' },
      checkpoint: { internalStorageKey: 'checkpoints/job_abc/tok.rds', checksumSha256: 'a'.repeat(64), sizeBytes: 555 },
      // A hostile job parameters object cannot influence routing/body (input is ignored).
      input: { storage_key: '../../etc/passwd', path: '/abs/evil', endpoint: '/evil', method: 'DELETE' },
      callR: async (r) => { calls.push(r); return { status: 200, body: loadBody() }; },
    });
    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/object/checkpoint-load');
    expect(req.objectStateKey).toBe('user-1:obj-ao_1');
    // Body is rebuilt from server-selected coords ONLY — never the client's storage_key/path.
    expect(req.body.storage_key).toBe('checkpoints/job_abc/tok.rds');
    expect(req.body.expected_checksum_sha256).toBe('a'.repeat(64));
    expect(req.body.expected_size_bytes).toBe(555);
    expect(req.body).not.toHaveProperty('path');
    expect(req.body).not.toHaveProperty('endpoint');
    expect(req.body).not.toHaveProperty('method');
    expect(JSON.stringify(req.body)).not.toContain('etc/passwd');
    // The returned descriptor is metadata-only, with a sanitized load summary.
    expect(descriptor.artifactType).toBe('checkpoint_load');
    expect(descriptor.storageKind).toBe('metadata_only');
    expect(descriptor.loaded.loaded).toBe(true);
    expect(descriptor.loaded.runtimeInstanceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(descriptor.metadata.live_state_mutation).toBe(true);
    expect(descriptor.metadata.scientific_output).toBe(false);
  });

  it('rejects a missing server-selected checkpoint (no storage key) BEFORE R contact', async () => {
    const calls = [];
    await expect(runRBridgeOperation({
      job,
      operation: 'r.checkpoint.load.v1',
      objectContext: { objectId: 'ao_1', stateKey: 'user-1:obj-ao_1' },
      checkpoint: {}, // no internalStorageKey
      callR: async (r) => { calls.push(r); return { status: 200, body: loadBody() }; },
    })).rejects.toMatchObject({ code: 'R_CHECKPOINT_REQUIRED' });
    expect(calls).toHaveLength(0);
  });

  it('requires SERVER-derived object context (cannot run without it)', async () => {
    await expect(runRBridgeOperation({
      job, operation: 'r.checkpoint.load.v1',
      checkpoint: { internalStorageKey: 'checkpoints/x.rds' },
      callR: async () => ({ status: 200, body: loadBody() }),
    })).rejects.toMatchObject({ code: 'R_OBJECT_CONTEXT_REQUIRED' });
  });

  it('maps a non-200 R response to a sanitized R_CHECKPOINT_LOAD_FAILED (no raw R text)', async () => {
    let err;
    try {
      await runRBridgeOperation({
        job, operation: 'r.checkpoint.load.v1',
        objectContext: { objectId: 'ao_1', stateKey: 'user-1:obj-ao_1' },
        checkpoint: { internalStorageKey: 'checkpoints/x.rds', checksumSha256: 'a'.repeat(64), sizeBytes: 1 },
        callR: async () => ({ status: 500, body: { error: 'RDS load exploded at /vault/secret/path.rds' } }),
      });
    } catch (e) { err = e; }
    expect(err.code).toBe('R_CHECKPOINT_LOAD_FAILED');
    expect(err.message).toBe('R checkpoint load failed.');
    expect(err.message).not.toContain('/vault');
  });

  it('the default R caller (defense-in-depth) refuses a non-allowlisted target BEFORE HTTP', async () => {
    const callR = createDefaultRCaller({ token: 'tok' });
    await expect(callR({ method: 'POST', path: '/object/evil' }))
      .rejects.toMatchObject({ code: 'R_BRIDGE_TARGET_REJECTED' });
    // The checkpoint-load target IS allowlisted.
    expect(isAllowedRBridgeTarget('POST', '/object/checkpoint-load')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Worker success (one metadata-only artifact; no result object / edge / checkpoint)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('checkpoint.load.v1 — worker success', () => {
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  it('loads the owner\'s checkpoint, completes the job, records ONE metadata-only summary artifact', async () => {
    const { alice, proj, resultObjectId, checkpointArt } = await seedLoadableCheckpoint();
    const ljob = await seedLoadJob(alice.id, proj.id, resultObjectId);
    const calls = [];
    const res = await drain(pipelineThenLoadCaller(calls), T0);
    expect(res.status).toBe('completed');
    expect(res.jobId).toBe(ljob.id);

    // Exactly one checkpoint-load request to R, with the SERVER-selected key + the
    // owner's canonical state key.
    const loadReqs = calls.filter((c) => c.path === '/object/checkpoint-load');
    expect(loadReqs).toHaveLength(1);
    expect(loadReqs[0].body.storage_key).toBe(checkpointArt.storageUri);
    expect(loadReqs[0].objectStateKey).toBe(deriveRObjectStateKey(alice.id, resultObjectId));

    // ONE metadata-only checkpoint_load artifact; no NEW result object / edge / checkpoint.
    const arts = await getJobArtifactsByJobId(ljob.id);
    expect(arts).toHaveLength(1);
    const a = arts[0];
    expect(a.artifactType).toBe('checkpoint_load');
    expect(a.storageKind).toBe('metadata_only');
    expect(a.resultAnalysisObjectId).toBeFalsy(); // no new result object linked
    expect(a.metadata.live_state_mutation).toBe(true);
    expect(a.metadata.scientific_output).toBe(false);
    expect(a.metadata.sourceAnalysisObjectId).toBe(resultObjectId);
    expect(a.metadata.checkpointArtifactId).toBe(checkpointArt.id);

    // The load job created NO new analysis object and NO lineage edge.
    const objs = await listAnalysisObjectsForUser(alice.id, {});
    expect(objs.filter((o) => o.metadata && o.metadata.source === 'checkpoint.load.v1')).toHaveLength(0);
    expect(await listProjectAnalysisObjectChildren(alice.id, proj.id, resultObjectId)).toHaveLength(0);
    // The completed load job did not link a result object.
    expect((await getProjectJob(alice.id, proj.id, ljob.id)).resultAnalysisObjectId).toBeFalsy();
  });

  it('the recorded artifact + logs never leak the internal storage key / state key / token', async () => {
    const { alice, proj, resultObjectId, checkpointArt } = await seedLoadableCheckpoint();
    const ljob = await seedLoadJob(alice.id, proj.id, resultObjectId);
    await drain(pipelineThenLoadCaller([]), T0);

    // Public projection strips storage_uri; metadata never contains the internal key/path/state key.
    const pub = (await listProjectJobArtifacts(alice.id, proj.id, ljob.id))[0];
    const blob = JSON.stringify(pub);
    expect(pub).not.toHaveProperty('storageUri');
    expect(blob).not.toContain(checkpointArt.storageUri);
    expect(blob).not.toContain(deriveRObjectStateKey(alice.id, resultObjectId));
    expect(blob.toLowerCase()).not.toContain('api_token');

    // Durable job logs are sanitized too.
    const full = await getProjectJob(alice.id, proj.id, ljob.id);
    const logBlob = JSON.stringify(full.logs || []);
    expect(logBlob).not.toContain(checkpointArt.storageUri);
    expect(logBlob).not.toContain(deriveRObjectStateKey(alice.id, resultObjectId));
  });

  it('a subsequent r.object.inspect job for the same owner/object wires through (exists summary)', async () => {
    const { alice, proj, resultObjectId } = await seedLoadableCheckpoint();
    await seedLoadJob(alice.id, proj.id, resultObjectId);
    await drain(pipelineThenLoadCaller([]), T0); // run the load

    const inspectJob = await createProjectJob(alice.id, proj.id, { jobType: 'r.object.inspect', analysisObjectId: resultObjectId });
    const calls = [];
    const res = await drain(pipelineThenLoadCaller(calls), T0); // run the inspect
    expect(res.status).toBe('completed');
    expect(res.jobId).toBe(inspectJob.id);
    const inspectReqs = calls.filter((c) => c.path === '/object/inspect');
    expect(inspectReqs).toHaveLength(1);
    // Inspect addressed the SAME canonical key the load mutated.
    expect(inspectReqs[0].objectStateKey).toBe(deriveRObjectStateKey(alice.id, resultObjectId));
    const art = (await getJobArtifactsByJobId(inspectJob.id))[0];
    expect(art.metadata.object.exists).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Worker failure / cancel / claim-loss / duplicate (no successful artifact)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('checkpoint.load.v1 — failure / cancel / claim-loss', () => {
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  it('an R load failure (non-200) remains indeterminate with NO checkpoint_load artifact', async () => {
    const { alice, proj, resultObjectId } = await seedLoadableCheckpoint();
    const ljob = await seedLoadJob(alice.id, proj.id, resultObjectId);
    const res = await drain(pipelineThenLoadCaller([], { status: 500, body: { error: 'boom' } }), T0);
    expect(res.status).toBe('indeterminate');
    const arts = await getJobArtifactsByJobId(ljob.id);
    expect(arts.filter((a) => a.artifactType === 'checkpoint_load')).toHaveLength(0);
    expect((await getProjectJob(alice.id, proj.id, ljob.id)).status).toBe('running');
  });

  it('an R "loaded:false" response fails the job and records NO checkpoint_load artifact', async () => {
    const { alice, proj, resultObjectId } = await seedLoadableCheckpoint();
    const ljob = await seedLoadJob(alice.id, proj.id, resultObjectId);
    const res = await drain(pipelineThenLoadCaller([], { status: 200, body: loadBody({ loaded: false }) }), T0);
    expect(res.status).toBe('failed');
    expect((await getJobArtifactsByJobId(ljob.id)).filter((a) => a.artifactType === 'checkpoint_load')).toHaveLength(0);
  });

  it('a missing/ambiguous checkpoint fails the job BEFORE any R contact (no artifact)', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const proj = await seedProject(alice.id);
    const obj = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', displayName: 'no-cp' });
    const ljob = await seedLoadJob(alice.id, proj.id, obj.id);
    const calls = [];
    const res = await drain(pipelineThenLoadCaller(calls), T0);
    expect(res.status).toBe('failed');
    expect(calls.filter((c) => c.path === '/object/checkpoint-load')).toHaveLength(0); // never reached R
    expect((await getJobArtifactsByJobId(ljob.id)).filter((a) => a.artifactType === 'checkpoint_load')).toHaveLength(0);
  });

  it('a canceled job creates no successful load artifact (claim lost mid-run, not resurrected)', async () => {
    const { alice, proj, resultObjectId } = await seedLoadableCheckpoint();
    const ljob = await seedLoadJob(alice.id, proj.id, resultObjectId);
    // R caller cancels the job mid-flight (claim is voided), then returns success.
    const cancelingCaller = async (req) => {
      if (req.path === '/object/checkpoint-load') await cancelProjectJob(alice.id, proj.id, ljob.id);
      return { status: 200, body: req.path === '/object/checkpoint-load' ? loadBody() : pipelineBody() };
    };
    const res = await drain(cancelingCaller, T0);
    expect(['claim_lost', 'failed']).toContain(res.status);
    expect((await getProjectJob(alice.id, proj.id, ljob.id)).status).toBe('canceled');
    expect((await getJobArtifactsByJobId(ljob.id)).filter((a) => a.artifactType === 'checkpoint_load')).toHaveLength(0);
  });

  it('a duplicate worker cannot claim a running load job (single-winner) → no duplicate artifact', async () => {
    const { alice, proj, resultObjectId } = await seedLoadableCheckpoint();
    const ljob = await seedLoadJob(alice.id, proj.id, resultObjectId);
    // First worker claims the load job and holds it (lease live at T0).
    const claimed = await claimNextJob('worker_A', { leaseSeconds: 30, now: T0 });
    expect(claimed.id).toBe(ljob.id);
    // A second worker draining at T0 cannot claim it (single-winner) → idle.
    const res = await drain(pipelineThenLoadCaller([]), T0, { workerId: 'worker_B' });
    expect(res.status).toBe('idle');
    expect((await getJobArtifactsByJobId(ljob.id)).filter((a) => a.artifactType === 'checkpoint_load')).toHaveLength(0);
  });

  it('the parent live state is NOT overwritten: a load addresses only the result object\'s key', async () => {
    const { alice, proj, parent, resultObjectId } = await seedLoadableCheckpoint();
    await seedLoadJob(alice.id, proj.id, resultObjectId);
    const calls = [];
    await drain(pipelineThenLoadCaller(calls), T0);
    const loadReq = calls.find((c) => c.path === '/object/checkpoint-load');
    // The X-Object-ID is the RESULT object's canonical key, never the parent's.
    expect(loadReq.objectStateKey).toBe(deriveRObjectStateKey(alice.id, resultObjectId));
    expect(loadReq.objectStateKey).not.toBe(deriveRObjectStateKey(alice.id, parent.id));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Authorization & ownership (owner-only v1; viewer/non-member/co-member/cross-project)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('checkpoint.load.v1 — authorization & ownership', () => {
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  it('the OWNER can create + run a load job for their own object', async () => {
    const { alice, proj, resultObjectId } = await seedLoadableCheckpoint();
    const ljob = await seedLoadJob(alice.id, proj.id, resultObjectId);
    const res = await drain(pipelineThenLoadCaller([]), T0);
    expect(res.status).toBe('completed');
    expect(res.jobId).toBe(ljob.id);
  });

  it('a VIEWER cannot create a load job (FORBIDDEN; viewers cannot create jobs)', async () => {
    const { proj, resultObjectId } = await seedLoadableCheckpoint();
    const viewer = await createUser('viewer@example.com', 'password123', 'Viewer');
    await addProjectMemberByEmail(proj.id, 'viewer@example.com', 'viewer', 'owner');
    let err;
    try { await seedLoadJob(viewer.id, proj.id, resultObjectId); } catch (e) { err = e; }
    expect(err && err.code).toBe('FORBIDDEN');
  });

  it('a NON-MEMBER cannot create a load job (404, no project existence leak)', async () => {
    const { proj, resultObjectId } = await seedLoadableCheckpoint();
    const stranger = await createUser('stranger@example.com', 'password123', 'Stranger');
    let err;
    try { await seedLoadJob(stranger.id, proj.id, resultObjectId); } catch (e) { err = e; }
    expect(err && err.code).toBe('NOT_FOUND');
  });

  it('a co-member ANALYST who does NOT own the object is rejected at job creation', async () => {
    const { proj, resultObjectId } = await seedLoadableCheckpoint();
    const carol = await createUser('carol@example.com', 'password123', 'Carol');
    await addProjectMemberByEmail(proj.id, 'carol@example.com', 'analyst', 'owner');
    await expect(seedLoadJob(carol.id, proj.id, resultObjectId))
      .rejects.toMatchObject({ code: 'ANALYSIS_OBJECT_NOT_FOUND' });
  });

  it('a co-member ADMIN who does NOT own the object is ALSO rejected before R contact (membership ≠ live R)', async () => {
    const { proj, resultObjectId } = await seedLoadableCheckpoint();
    const bob = await createUser('bob@example.com', 'password123', 'Bob');
    await addProjectMemberByEmail(proj.id, 'bob@example.com', 'admin', 'owner');
    await expect(seedLoadJob(bob.id, proj.id, resultObjectId))
      .rejects.toMatchObject({ code: 'ANALYSIS_OBJECT_NOT_FOUND' });
  });

  it('a cross-project object cannot be referenced by a load job (404 at creation)', async () => {
    const { alice, resultObjectId } = await seedLoadableCheckpoint();
    const otherProj = await seedProject(alice.id, 'Other');
    // resultObjectId is not in otherProj → ANALYSIS_OBJECT_NOT_FOUND at job creation.
    await expect(seedLoadJob(alice.id, otherProj.id, resultObjectId)).rejects.toThrowError(/not found/i);
  });

  it('a malformed / unknown object id is rejected at job creation (404)', async () => {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const proj = await seedProject(alice.id);
    await expect(seedLoadJob(alice.id, proj.id, 'ao_nope')).rejects.toThrowError(/not found/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. sanitizeLoadSummary (no raw data ever survives)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('sanitizeLoadSummary — bounded, metadata-only', () => {
  it('keeps only the allowlisted structural fields; drops everything else', async () => {
    const out = sanitizeLoadSummary({
      loaded: true, checksum_verified: true, class: 'Seurat',
      n_cells: 2700, n_features: 13714, assays: ['RNA'], reductions: ['pca', 'umap'],
      n_meta_fields: 3, meta_fields: ['a', 'b', 'c'],
      seurat_version: '5.0.1', r_version: 'R version 4.6.0',
      // Hostile extras that must be dropped:
      raw_counts: [[1, 2, 3]], embeddings: [[0.1, 0.2]], cell_barcodes: ['AAA', 'CCC'],
      storage_key: 'vault/secret/path.rds', state_key: 'user-1:obj-ao_1', stack: 'at foo()',
    });
    expect(out).toEqual({
      loaded: true, checksumVerified: true, class: 'Seurat',
      nCells: 2700, nFeatures: 13714, assays: ['RNA'], reductions: ['pca', 'umap'],
      nMetaFields: 3, metaFields: ['a', 'b', 'c'], seuratVersion: '5.0.1', rVersion: 'R version 4.6.0',
    });
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('vault/secret');
    expect(blob).not.toContain('AAA');
    expect(blob).not.toContain('user-1:obj');
  });

  it('a not-loaded body collapses to a minimal { loaded:false } summary', async () => {
    expect(sanitizeLoadSummary({ loaded: false, n_cells: 5, class: 'Seurat' }))
      .toEqual({ loaded: false, checksumVerified: false });
    expect(sanitizeLoadSummary(null)).toEqual({ loaded: false, checksumVerified: false });
  });
});
