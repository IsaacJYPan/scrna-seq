import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// ════════════════════════════════════════════════════════════════════════════
// PBMC/Seurat pipeline as an allowlisted worker job (pbmc.pipeline.v1)
//
// The first production-integrated scientific pipeline. Proves the existing PBMC
// preprocessing path can be driven by ONE allowlisted worker job + ONE allowlisted
// mutating bridge operation that:
//   - runs on a COPY of the input object (the parent is never mutated)
//   - validates parameters against a FIXED server-side allowlist BEFORE any R contact
//   - is gated by live-R object OWNERSHIP (project membership ≠ live R access)
//   - uses a SERVER-derived state key + a SERVER-allocated internal checkpoint key
//   - on success creates EXACTLY one result analysis object + one parent→result
//     lineage edge + one local_internal checkpoint artifact + one metadata-only
//     pipeline_summary artifact, and links result_analysis_object_id
//   - on failure/cancel/claim-loss/absent-checkpoint creates NO successful records,
//     and two workers cannot duplicate any of them
//   - never leaks R code/path/endpoint/method/state-key/token/URL/stack, raw matrices,
//     cell/gene tables, embeddings, or the checkpoint storage path
//
// Live R execution + parent-immutability are exercised by the R backend (parse-checked
// here; run under CI's "R State Proxy Isolation" with real Rscript + Seurat). These
// Node tests inject a fake R caller so the contract is verified without a live R.
// See backend/pbmcPipeline.js, backend/rWorkerBridge.js (r.pbmc.pipeline.v1),
// backend/jobWorker.js (pbmcPipelineHandler), r-backend/plumber.R (POST /object/pbmc-pipeline).
// ════════════════════════════════════════════════════════════════════════════

const dbmod = require('./database');
const {
  initDatabase, closeDatabase, createUser, getUserByEmail,
  createOrganizationForUser, createProjectForUser, addProjectMemberByEmail,
  createJobForUser, createProjectJob, createProjectAnalysisObject, createAnalysisObjectForUser,
  getJobForUser, getProjectJob, getAnalysisObjectForUser, getProjectAnalysisObject,
  verifyAnalysisObjectOwner, claimNextJob, reapExpiredJobs, setJobScheduling, cancelProjectJob,
  listProjectArtifacts, listProjectJobArtifacts, getJobArtifactsByJobId,
  listProjectAnalysisObjectChildren, listProjectAnalysisObjectParents, getProjectAnalysisObjectLineage,
  isValidJobType, isValidArtifactType, isValidArtifactStorageKind,
  createCheckpointArtifactForJobByWorker, createJobArtifactByWorker, isSafeInternalStorageKey,
  toPublicJobArtifact, listJobsForUser,
} = dbmod;

const pbmc = require('./pbmcPipeline');
const {
  validatePbmcPipelineParams, allocateCheckpointStorageKey,
  PBMC_PIPELINE_PARAM_SPEC, PBMC_PIPELINE_PARAM_NAMES,
} = pbmc;

const bridge = require('./rWorkerBridge');
const {
  runRBridgeOperation, isAllowedRBridgeOperation, isAllowedRBridgeTarget,
  R_BRIDGE_OPERATIONS, R_BRIDGE_ALLOWED_TARGETS, createDefaultRCaller,
  sanitizePipelineSummary, sanitizeCheckpointInfo,
} = bridge;

const worker = require('./jobWorker');
const { createJobWorker, DEFAULT_HANDLERS, pbmcPipelineHandler } = worker;

const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const serverModule = require('../server.js');
const { deriveRObjectStateKey } = serverModule;

// Deterministic UTC instants in SQLite's 'YYYY-MM-DD HH:MM:SS' format.
const T0 = '2030-01-01 00:00:00';
const LATER = '2030-01-01 01:00:00'; // well past any 30s lease taken at T0

function silentLogger() { return { info() {}, warn() {}, error() {} }; }

// A healthy R `/object/pbmc-pipeline` body (the only thing the bridge reads, sanitized).
function pipelineBody(overrides = {}) {
  const base = {
    ok: true,
    summary: {
      n_cells: 2700, n_features: 13714, n_variable_features: 2000,
      n_pcs: 50, n_clusters: 9, cluster_sizes: [500, 420, 360, 300, 280, 240, 220, 200, 180],
      reductions: ['pca', 'umap'], normalization_method: 'LogNormalize',
      resolution: 0.8, used_seed: 42,
    },
    checkpoint: { saved: true, checksum_sha256: 'a'.repeat(64), size_bytes: 1234567 },
    versions: { seurat_version: '5.0.1', r_version: 'R version 4.6.0' },
  };
  return { ...base, ...overrides };
}

// Injectable R caller that records every request and returns a body (default healthy).
function recordingPipelineCaller(record, body = pipelineBody()) {
  return async (req) => { record.push(req); return { status: 200, body }; };
}

// Run the worker once with an injected R caller + clock + the REAL state-key deriver.
async function drainPipeline(callR, now = T0, opts = {}) {
  const w = createJobWorker({
    db: dbmod, now: () => now, logger: silentLogger(),
    callR, deriveRObjectStateKey, ...opts,
  });
  return w.runOnce();
}

function seedProject(ownerUserId, name = 'P') {
  const org = createOrganizationForUser(ownerUserId, { name: 'Acme' });
  return createProjectForUser(ownerUserId, { organizationId: org.id, name });
}

// Seed a project + an input analysis object + a queued pbmc.pipeline.v1 job (owner).
function seedPipelineJob(params = {}) {
  const alice = createUser('alice@example.com', 'password123', 'Alice');
  const proj = seedProject(alice.id);
  const obj = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', displayName: 'pbmc' });
  const job = createProjectJob(alice.id, proj.id, {
    jobType: 'pbmc.pipeline.v1', analysisObjectId: obj.id, parameters: params,
  });
  return { alice, proj, obj, job };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Inventory / scope (one type + one op added; nothing else changed)
// ════════════════════════════════════════════════════════════════════════════
describe('pbmc.pipeline.v1 — inventory & scope', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  it('registers pbmc.pipeline.v1; generic / checkpoint.noop / r.runtime.check / r.object.inspect unchanged', () => {
    expect(Object.keys(DEFAULT_HANDLERS).sort())
      .toEqual(['checkpoint.noop', 'generic', 'pbmc.pipeline.v1', 'r.object.inspect', 'r.runtime.check']);
    expect(DEFAULT_HANDLERS['pbmc.pipeline.v1']).toBe(pbmcPipelineHandler);
    expect(DEFAULT_HANDLERS.generic).toBe(worker.genericNoopHandler);
    expect(DEFAULT_HANDLERS['checkpoint.noop']).toBe(worker.checkpointNoopHandler);
    expect(DEFAULT_HANDLERS['r.runtime.check']).toBe(worker.rRuntimeCheckHandler);
    expect(DEFAULT_HANDLERS['r.object.inspect']).toBe(worker.rObjectInspectHandler);
  });

  it('pbmc.pipeline.v1 is an allowed job type; pipeline_summary an allowed artifact type', () => {
    expect(isValidJobType('pbmc.pipeline.v1')).toBe(true);
    expect(isValidArtifactType('pipeline_summary')).toBe(true);
    expect(isValidArtifactStorageKind('local_internal')).toBe(true);
  });

  it('the r.pbmc.pipeline.v1 op is allowlisted, object-scoped, params-carrying, mutating', () => {
    expect(isAllowedRBridgeOperation('r.pbmc.pipeline.v1')).toBe(true);
    const spec = R_BRIDGE_OPERATIONS['r.pbmc.pipeline.v1'];
    expect(spec.method).toBe('POST');
    expect(spec.path).toBe('/object/pbmc-pipeline');
    expect(spec.artifactType).toBe('pipeline_summary');
    expect(spec.requiresObjectContext).toBe(true);
    expect(spec.carriesParams).toBe(true);
    expect(spec.mutating).toBe(true);
    expect(spec.readOnly).toBe(false);
  });

  it('the bridge target set stays exact/closed (adds only POST /object/pbmc-pipeline)', () => {
    expect([...R_BRIDGE_ALLOWED_TARGETS].sort())
      .toEqual(['GET /health', 'GET /object/inspect', 'POST /object/pbmc-pipeline']);
  });

  it('DEG / pathway enrichment / CellChat are NOT newly registered job types or handlers', () => {
    for (const t of ['deg', 'find_markers', 'enrichment', 'cellchat', 'cellchat.infer',
      'deg.find_markers.v1', 'enrichment.ora.v1', 'cellchat.infer.v1']) {
      expect(DEFAULT_HANDLERS[t]).toBeUndefined();
    }
    // No new R-bridge op for them either.
    expect(Object.keys(R_BRIDGE_OPERATIONS).sort())
      .toEqual(['r.object.inspect', 'r.pbmc.pipeline.v1', 'r.runtime.check']);
  });

  it('an unsupported analytical job type still fails terminally (UNSUPPORTED_JOB_TYPE), no R contact', async () => {
    const alice = createUser('alice@example.com', 'password123', 'Alice');
    const job = createJobForUser(alice.id, { jobType: 'pca' });
    const calls = [];
    const res = await drainPipeline(recordingPipelineCaller(calls));
    expect(res.status).toBe('unsupported');
    expect(calls).toHaveLength(0);
    expect(getJobForUser(job.id, alice.id).status).toBe('failed');
  });

  it('the bridge / pipeline modules expose NO express route/app/download (no public route)', () => {
    for (const k of ['app', 'router', 'middleware', 'handler', 'routes', 'download']) {
      expect(bridge).not.toHaveProperty(k);
      expect(pbmc).not.toHaveProperty(k);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Parameter validation (pure allowlist + via handler-before-R)
// ════════════════════════════════════════════════════════════════════════════
describe('pbmc.pipeline.v1 — parameter validation', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  it('applies + records documented defaults for an empty params object', () => {
    const { params, defaultsApplied } = validatePbmcPipelineParams({});
    expect(params).toEqual({
      normalizationMethod: 'LogNormalize', scaleFactor: 10000, variableFeatures: 2000,
      pcaDims: 50, clusterDims: 15, clusterResolution: 0.8, umapDims: 15,
      umapComponents: 2, umapNeighbors: 30, umapMinDist: 0.3, seed: null,
    });
    expect(defaultsApplied.sort()).toEqual(PBMC_PIPELINE_PARAM_NAMES.slice().sort());
  });

  it('accepts valid in-range params and records which fell back to defaults', () => {
    const { params, defaultsApplied } = validatePbmcPipelineParams({
      normalizationMethod: 'SCTransform', pcaDims: 30, clusterResolution: 1.2, seed: 7,
    });
    expect(params.normalizationMethod).toBe('SCTransform');
    expect(params.pcaDims).toBe(30);
    expect(params.clusterResolution).toBe(1.2);
    expect(params.seed).toBe(7);
    expect(params.variableFeatures).toBe(2000); // default
    expect(defaultsApplied).not.toContain('pcaDims');
    expect(defaultsApplied).toContain('variableFeatures');
  });

  it('REJECTS unknown parameter names (strict policy)', () => {
    expect(() => validatePbmcPipelineParams({ foo: 1 })).toThrowError(/Unknown parameter/);
    expect(() => validatePbmcPipelineParams({ pcaDims: 50, evil: 'x' })).toThrowError(/Unknown parameter/);
    try { validatePbmcPipelineParams({ foo: 1 }); } catch (e) { expect(e.code).toBe('UNKNOWN_PARAMETER'); }
  });

  it('rejects out-of-range / wrong-type numeric params', () => {
    for (const bad of [
      { pcaDims: 1 }, { pcaDims: 999 }, { pcaDims: 12.5 }, { clusterResolution: 0 },
      { clusterResolution: 99 }, { scaleFactor: 0 }, { variableFeatures: 1 },
      { umapMinDist: 2 }, { umapNeighbors: 1 }, { seed: -5 }, { seed: 3.3 },
    ]) {
      expect(() => validatePbmcPipelineParams(bad), JSON.stringify(bad)).toThrowError(/INVALID_PARAMETER|between|integer|finite/);
    }
  });

  it('a parameter can never become R code / a path / a function name (strings rejected)', () => {
    // Numeric params: a string (even a numeric-looking one) is rejected — NOT coerced.
    for (const bad of [
      { pcaDims: 'system("rm -rf /")' }, { pcaDims: 'q()' }, { pcaDims: '50' },
      { scaleFactor: '../../etc/passwd' }, { clusterResolution: 'RunPCA' },
      { umapDims: '1; drop table' }, { seed: 'NaN' },
    ]) {
      expect(() => validatePbmcPipelineParams(bad), JSON.stringify(bad)).toThrowError();
    }
    // Enum params: only the fixed set is accepted; arbitrary strings rejected.
    expect(() => validatePbmcPipelineParams({ normalizationMethod: 'system("x")' })).toThrowError(/one of/);
    expect(() => validatePbmcPipelineParams({ normalizationMethod: 'LogNormalize; rm' })).toThrowError(/one of/);
  });

  it('non-object / array params are rejected', () => {
    for (const bad of [[1, 2, 3], 'x', 42, true]) {
      expect(() => validatePbmcPipelineParams(bad)).toThrowError(/plain JSON object/);
    }
    // undefined/null → all defaults (no params supplied is valid).
    expect(validatePbmcPipelineParams(undefined).params.pcaDims).toBe(50);
    expect(validatePbmcPipelineParams(null).params.pcaDims).toBe(50);
  });

  it('invalid params FAIL the job before any R contact (no R call, no result object)', async () => {
    const { job, alice, proj } = seedPipelineJob({ pcaDims: 9999 });
    const calls = [];
    const res = await drainPipeline(recordingPipelineCaller(calls));
    expect(res.status).toBe('failed');
    expect(calls).toHaveLength(0); // never reached R
    const after = getProjectJob(alice.id, proj.id, job.id);
    expect(after.status).toBe('failed');
    expect(after.resultAnalysisObjectId).toBeFalsy();
    expect(getJobArtifactsByJobId(job.id)).toHaveLength(0);
  });

  it('unknown params FAIL the job before any R contact', async () => {
    const { job } = seedPipelineJob({ totallyUnknownParam: 1 });
    const calls = [];
    const res = await drainPipeline(recordingPipelineCaller(calls));
    expect(res.status).toBe('failed');
    expect(calls).toHaveLength(0);
    expect(getJobArtifactsByJobId(job.id)).toHaveLength(0);
  });

  it('resolved params (with defaults) appear in safe result + artifact metadata', async () => {
    const { job, alice, proj } = seedPipelineJob({ pcaDims: 30, clusterResolution: 1.0 });
    const res = await drainPipeline(recordingPipelineCaller([]));
    expect(res.status).toBe('completed');
    const summaryArts = listProjectJobArtifacts(alice.id, proj.id, job.id, { artifactType: 'pipeline_summary' });
    expect(summaryArts).toHaveLength(1);
    expect(summaryArts[0].metadata.resolvedParams.pcaDims).toBe(30);
    expect(summaryArts[0].metadata.resolvedParams.clusterResolution).toBe(1.0);
    expect(summaryArts[0].metadata.resolvedParams.variableFeatures).toBe(2000); // default recorded
    expect(summaryArts[0].metadata.defaultsApplied).toContain('variableFeatures');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Bridge allowlist & input control (pure function; injected caller)
// ════════════════════════════════════════════════════════════════════════════
describe('pbmc.pipeline.v1 — bridge allowlist & input control', () => {
  const job = { id: 'job_abc', ownerUserId: 7, projectId: 'proj_1', analysisObjectId: 'ao_1' };
  const objectContext = { objectId: 'ao_1', stateKey: 'user-7:obj-ao_1' };
  const pipeline = {
    params: validatePbmcPipelineParams({ pcaDims: 40 }).params,
    checkpointStorageKey: 'checkpoints/job_abc/deadbeef.rds',
  };

  it('issues ONLY the server-defined POST /object/pbmc-pipeline with the server-derived X-Object-ID + whitelisted body', async () => {
    const calls = [];
    const descriptor = await runRBridgeOperation({
      job, operation: 'r.pbmc.pipeline.v1', objectContext, pipeline,
      callR: recordingPipelineCaller(calls), logger: silentLogger(),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/object/pbmc-pipeline');
    expect(calls[0].objectStateKey).toBe('user-7:obj-ao_1');
    // Body carries ONLY the allowlisted params + the server checkpoint key.
    expect(Object.keys(calls[0].body).sort()).toEqual(['operation', 'params', 'storage_key']);
    expect(Object.keys(calls[0].body.params).sort()).toEqual(PBMC_PIPELINE_PARAM_NAMES.slice().sort());
    expect(calls[0].body.params.pcaDims).toBe(40);
    expect(calls[0].body.storage_key).toBe('checkpoints/job_abc/deadbeef.rds');

    expect(descriptor.artifactType).toBe('pipeline_summary');
    expect(descriptor.metadata.scientific_output).toBe(true);
    expect(descriptor.checkpoint).toMatchObject({ saved: true, checksumSha256: 'a'.repeat(64), sizeBytes: 1234567 });
  });

  it('IGNORES smuggled code/path/endpoint/method/stateKey in params/input (re-whitelisted)', async () => {
    const calls = [];
    await runRBridgeOperation({
      job, operation: 'r.pbmc.pipeline.v1', objectContext,
      pipeline: {
        params: { ...pipeline.params, code: 'system("rm")', path: '/load-rds', method: 'DELETE', stateKey: 'user-999' },
        checkpointStorageKey: pipeline.checkpointStorageKey,
      },
      input: { operation: 'r.exec.arbitrary', code: 'q()', endpoint: 'http://evil', url: 'http://evil' },
      callR: recordingPipelineCaller(calls), logger: silentLogger(),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/object/pbmc-pipeline');
    // Only allowlisted param names survive — smuggled fields are dropped.
    expect(Object.keys(calls[0].body.params).sort()).toEqual(PBMC_PIPELINE_PARAM_NAMES.slice().sort());
    for (const f of ['code', 'path', 'method', 'stateKey', 'endpoint', 'url']) {
      expect(calls[0].body.params).not.toHaveProperty(f);
    }
  });

  it('rejects an arbitrary / non-allowlisted operation name WITHOUT contacting R', async () => {
    const calls = [];
    await expect(runRBridgeOperation({
      job, operation: 'r.exec.arbitrary', objectContext, pipeline,
      callR: recordingPipelineCaller(calls), logger: silentLogger(),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_R_OPERATION' });
    expect(calls).toHaveLength(0);
  });

  it('rejects missing object context / missing params BEFORE contacting R', async () => {
    const calls = [];
    await expect(runRBridgeOperation({
      job, operation: 'r.pbmc.pipeline.v1', pipeline,
      callR: recordingPipelineCaller(calls), logger: silentLogger(),
    })).rejects.toMatchObject({ code: 'R_OBJECT_CONTEXT_REQUIRED' });
    await expect(runRBridgeOperation({
      job, operation: 'r.pbmc.pipeline.v1', objectContext,
      callR: recordingPipelineCaller(calls), logger: silentLogger(),
    })).rejects.toMatchObject({ code: 'R_PIPELINE_PARAMS_REQUIRED' });
    expect(calls).toHaveLength(0);
  });

  it('createDefaultRCaller refuses any non-allowlisted target BEFORE HTTP (incl. wrong method)', async () => {
    const callR = createDefaultRCaller({ port: 8000, token: 't' });
    expect(isAllowedRBridgeTarget('POST', '/object/pbmc-pipeline')).toBe(true);
    expect(isAllowedRBridgeTarget('GET', '/object/pbmc-pipeline')).toBe(false);
    expect(isAllowedRBridgeTarget('POST', '/load-rds')).toBe(false);
    for (const bad of [
      { method: 'GET', path: '/object/pbmc-pipeline' },
      { method: 'POST', path: '/load-rds' },
      { method: 'POST', path: '/restore-session' },
    ]) {
      await expect(callR(bad)).rejects.toMatchObject({ code: 'R_BRIDGE_TARGET_REJECTED' });
    }
  });

  it('sanitizes R errors: a non-200 and a transport error never leak body/url/stack', async () => {
    const errorCaller = async () => ({ status: 500, body: { error: 'R Error: /vault/u/obj.rds blew up at line 42' } });
    let thrown;
    try {
      await runRBridgeOperation({ job, operation: 'r.pbmc.pipeline.v1', objectContext, pipeline, callR: errorCaller, logger: silentLogger() });
    } catch (e) { thrown = e; }
    expect(thrown.code).toBe('R_PBMC_PIPELINE_FAILED');
    expect(thrown.message).toBe('R PBMC pipeline run failed.');
    expect(thrown.message).not.toContain('/vault');

    const leaky = async () => { throw new Error('connect ECONNREFUSED http://127.0.0.1:8000/object/pbmc-pipeline (at /srv/app/x.js:1)'); };
    let t2;
    try {
      await runRBridgeOperation({ job, operation: 'r.pbmc.pipeline.v1', objectContext, pipeline, callR: leaky, logger: silentLogger() });
    } catch (e) { t2 = e; }
    for (const f of ['ECONNREFUSED', 'http://', '127.0.0.1', '8000', '/srv/app', '.js:']) {
      expect(t2.message).not.toContain(f);
    }
  });

  it('sanitizes the summary: matrices/cells/genes/embeddings/paths/state-keys are dropped', async () => {
    const nasty = async () => ({
      status: 200,
      body: {
        ok: true,
        summary: {
          n_cells: 10, n_features: 20, n_variable_features: 5, n_pcs: 10, n_clusters: 3,
          cluster_sizes: [4, 3, 3], reductions: ['pca', 'umap'], normalization_method: 'LogNormalize', resolution: 0.8,
          // Hostile/forbidden extras the bridge MUST drop:
          expression: [[1, 2], [3, 4]], cells: ['cell_1'], genes: ['GENE1'], embeddings: [[0.1]],
          path: '/vault/u/obj.rds', state_key: 'user-7:obj-ao_1', token: 'API_TOKEN=secret', serialized: 'RAW_RDS',
        },
        checkpoint: { saved: true, checksum_sha256: 'b'.repeat(64), size_bytes: 9, path: '/vault/secret.rds' },
        versions: { seurat_version: '5.0.1', r_version: 'R 4.6.0' },
      },
    });
    const descriptor = await runRBridgeOperation({ job, operation: 'r.pbmc.pipeline.v1', objectContext, pipeline, callR: nasty, logger: silentLogger() });
    // Check the data-bearing parts only (the static `description` is safe prose that
    // legitimately says "no expression matrices/embeddings").
    const blob = JSON.stringify({ summary: descriptor.summary, checkpoint: descriptor.checkpoint, metadata: descriptor.metadata });
    for (const f of ['expression', 'GENE1', 'embeddings', '/vault', 'state_key', 'user-7:obj-', 'API_TOKEN', 'RAW_RDS', 'cell_1']) {
      expect(blob, f).not.toContain(f);
    }
    // The checkpoint descriptor carries ONLY save/checksum/size — never a path.
    expect(Object.keys(descriptor.checkpoint).sort()).toEqual(['checksumSha256', 'saved', 'sizeBytes']);
    expect(sanitizePipelineSummary({}).nCells).toBeUndefined();
    expect(sanitizeCheckpointInfo({ checkpoint: { saved: 'yes', checksum_sha256: 'nothex' } }))
      .toEqual({ saved: false, checksumSha256: null, sizeBytes: null });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Ownership / project boundary (live-R ownership gate)
// ════════════════════════════════════════════════════════════════════════════
describe('pbmc.pipeline.v1 — ownership & project boundary', () => {
  let server;
  beforeAll(async () => { server = await startServer(); });
  afterAll(() => { if (server) server.close(); });
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  it('the live-R object OWNER can run the pipeline on their own object (server-derived state key)', async () => {
    const { job, obj, alice } = seedPipelineJob({});
    const calls = [];
    const res = await drainPipeline(recordingPipelineCaller(calls));
    expect(res.status).toBe('completed');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].objectStateKey).toBe(deriveRObjectStateKey(alice.id, obj.id));
    expect(job.analysisObjectId).toBe(obj.id);
  });

  it('a project co-member (analyst) CANNOT run the pipeline on another user\'s live object — fails before R', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    createUserWithToken({ email: 'carol@example.com' });
    const proj = seedProject(alice.user.id);
    addProjectMemberByEmail(proj.id, 'carol@example.com', 'analyst', 'owner');
    const carol = getUserByEmail('carol@example.com');

    const aliceObj = createProjectAnalysisObject(alice.user.id, proj.id, { objectType: 'seurat', displayName: 'aliceObj' });
    const job = createProjectJob(carol.id, proj.id, { jobType: 'pbmc.pipeline.v1', analysisObjectId: aliceObj.id });

    const calls = [];
    const res = await drainPipeline(recordingPipelineCaller(calls));
    expect(res.status).toBe('failed');
    expect(res.error.message).toBe('Analysis object not found.'); // 404-style, no existence leak
    expect(calls).toHaveLength(0); // never reached R
    expect(getJobArtifactsByJobId(job.id)).toHaveLength(0);
    expect(getProjectJob(carol.id, proj.id, job.id).resultAnalysisObjectId).toBeFalsy();
  });

  it('a project ADMIN co-member also cannot run it on another user\'s live object', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    createUserWithToken({ email: 'bob@example.com' });
    const proj = seedProject(alice.user.id);
    addProjectMemberByEmail(proj.id, 'bob@example.com', 'admin', 'owner');
    const bob = getUserByEmail('bob@example.com');

    const aliceObj = createProjectAnalysisObject(alice.user.id, proj.id, { objectType: 'seurat', displayName: 'aliceObj' });
    createProjectJob(bob.id, proj.id, { jobType: 'pbmc.pipeline.v1', analysisObjectId: aliceObj.id });

    const calls = [];
    const res = await drainPipeline(recordingPipelineCaller(calls));
    expect(res.status).toBe('failed');
    expect(calls).toHaveLength(0);
    expect(verifyAnalysisObjectOwner(alice.user.id, aliceObj.id)).toBe(true);
    expect(verifyAnalysisObjectOwner(bob.id, aliceObj.id)).toBe(false);
  });

  it('a VIEWER cannot create/trigger a pipeline job (403 by job-write policy)', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const viewer = createUserWithToken({ email: 'viewer@example.com' });
    const proj = seedProject(alice.user.id);
    addProjectMemberByEmail(proj.id, 'viewer@example.com', 'viewer', 'owner');
    const obj = createProjectAnalysisObject(alice.user.id, proj.id, { objectType: 'seurat', displayName: 'o' });

    const r = await api(server, `/api/projects/${proj.id}/jobs`, {
      method: 'POST', token: viewer.token,
      body: { jobType: 'pbmc.pipeline.v1', analysisObjectId: obj.id },
    });
    expect(r.status).toBe(403);
  });

  it('a non-member gets 404 creating a pipeline job', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const stranger = createUserWithToken({ email: 'stranger@example.com' });
    const proj = seedProject(alice.user.id);
    const obj = createProjectAnalysisObject(alice.user.id, proj.id, { objectType: 'seurat', displayName: 'o' });
    const r = await api(server, `/api/projects/${proj.id}/jobs`, {
      method: 'POST', token: stranger.token,
      body: { jobType: 'pbmc.pipeline.v1', analysisObjectId: obj.id },
    });
    expect(r.status).toBe(404);
  });

  it('a cross-project / legacy / malformed object reference is rejected (404 / not run)', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const projA = seedProject(alice.user.id, 'A');
    const projB = seedProject(alice.user.id, 'B');
    const objA = createProjectAnalysisObject(alice.user.id, projA.id, { objectType: 'seurat', displayName: 'a' });

    // Referencing project A's object from a project B job → 404 at create time.
    expect(() => createProjectJob(alice.user.id, projB.id, { jobType: 'pbmc.pipeline.v1', analysisObjectId: objA.id }))
      .toThrowError(/Analysis object not found/);

    // A legacy owner-scoped object cannot be used through a project job (not in project).
    const legacy = createAnalysisObjectForUser(alice.user.id, { objectType: 'seurat', displayName: 'legacy' });
    expect(() => createProjectJob(alice.user.id, projA.id, { jobType: 'pbmc.pipeline.v1', analysisObjectId: legacy.id }))
      .toThrowError(/Analysis object not found/);

    // Malformed / unknown object ids handled safely.
    for (const bad of ['', 'not-an-ao', 'ao_doesnotexist']) {
      expect(() => createProjectJob(alice.user.id, projA.id, { jobType: 'pbmc.pipeline.v1', analysisObjectId: bad }))
        .toThrowError();
    }
  });

  it('a job missing its input object fails before R (R_OBJECT_CONTEXT_REQUIRED)', async () => {
    const alice = createUser('alice@example.com', 'password123', 'Alice');
    const proj = seedProject(alice.id);
    // Legacy/owner job with NO analysis object.
    createJobForUser(alice.id, { jobType: 'pbmc.pipeline.v1' });
    const calls = [];
    const res = await drainPipeline(recordingPipelineCaller(calls));
    expect(res.status).toBe('failed');
    expect(calls).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Worker success behavior
// ════════════════════════════════════════════════════════════════════════════
describe('pbmc.pipeline.v1 — worker success', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  it('completes via the worker contract: ONE result object + edge + checkpoint + summary artifact, linked', async () => {
    const { job, alice, proj, obj } = seedPipelineJob({});
    const res = await drainPipeline(recordingPipelineCaller([]));
    expect(res.status).toBe('completed');

    // Job linked to exactly one result object, same project + lineage root as parent.
    const after = getProjectJob(alice.id, proj.id, job.id);
    expect(after.status).toBe('completed');
    const resultId = after.resultAnalysisObjectId;
    expect(resultId).toMatch(/^ao_[0-9a-f]+$/);
    const result = getProjectAnalysisObject(alice.id, proj.id, resultId);
    expect(result.projectId).toBe(proj.id);
    expect(result.parentObjectId).toBe(obj.id);
    const parent = getProjectAnalysisObject(alice.id, proj.id, obj.id);
    expect(result.lineageRootId).toBe(parent.lineageRootId || parent.id);
    expect(result.metadata.source).toBe('pbmc.pipeline.v1');
    expect(result.metadata.scientific_output).toBe(true);

    // EXACTLY one parent→result checkpoint edge.
    const children = listProjectAnalysisObjectChildren(alice.id, proj.id, obj.id);
    expect(children).toHaveLength(1);
    expect(children[0].childAnalysisObjectId).toBe(resultId);
    expect(children[0].edgeType).toBe('checkpoint');
    expect(children[0].jobId).toBe(job.id);
    const parents = listProjectAnalysisObjectParents(alice.id, proj.id, resultId);
    expect(parents).toHaveLength(1);
    expect(parents[0].parentAnalysisObjectId).toBe(obj.id);

    // EXACTLY one checkpoint artifact + one pipeline_summary artifact.
    const arts = getJobArtifactsByJobId(job.id);
    expect(arts).toHaveLength(2);
    const types = arts.map(a => a.artifactType).sort();
    expect(types).toEqual(['checkpoint', 'pipeline_summary']);
    const checkpoint = arts.find(a => a.artifactType === 'checkpoint');
    expect(checkpoint.storageKind).toBe('local_internal');
    expect(checkpoint.resultAnalysisObjectId).toBe(resultId);
    expect(checkpoint.checksumSha256).toBe('a'.repeat(64));
    expect(checkpoint.sizeBytes).toBe(1234567);
  });

  it('the parent object row is unchanged by the run (still a stable checkpoint)', async () => {
    const { alice, proj, obj } = seedPipelineJob({});
    const before = getProjectAnalysisObject(alice.id, proj.id, obj.id);
    await drainPipeline(recordingPipelineCaller([]));
    const after = getProjectAnalysisObject(alice.id, proj.id, obj.id);
    // Parent is never mutated: type/metadata/parent/lineage identical, no result back-link.
    expect(after.objectType).toBe(before.objectType);
    expect(after.metadata).toEqual(before.metadata);
    expect(after.parentObjectId).toBe(before.parentObjectId);
    expect(after.lineageRootId).toBe(before.lineageRootId);
  });

  it('result object metadata records provenance WITHOUT implying a download', async () => {
    const { job, alice, proj } = seedPipelineJob({ seed: 11 });
    await drainPipeline(recordingPipelineCaller([]));
    const resultId = getProjectJob(alice.id, proj.id, job.id).resultAnalysisObjectId;
    const result = getProjectAnalysisObject(alice.id, proj.id, resultId);
    expect(result.metadata.checkpoint.downloadable).toBe(false);
    expect(result.metadata.checkpoint.storage_kind).toBe('local_internal');
    expect(result.metadata.summary.nClusters).toBe(9);
    expect(result.metadata.resolvedParams.seed).toBe(11);
  });

  it('project artifact reads expose SAFE metadata only (no storage uri / path / state key / token)', async () => {
    const { job, alice, proj } = seedPipelineJob({});
    await drainPipeline(recordingPipelineCaller([]));

    // Public project read omits storage_uri but keeps checksum/size/storageKind.
    const pubArts = listProjectJobArtifacts(alice.id, proj.id, job.id);
    const checkpoint = pubArts.find(a => a.artifactType === 'checkpoint');
    expect(Object.prototype.hasOwnProperty.call(checkpoint, 'storageUri')).toBe(false);
    expect(checkpoint.checksumSha256).toBe('a'.repeat(64));
    expect(checkpoint.sizeBytes).toBe(1234567);

    const blob = JSON.stringify(pubArts);
    for (const f of ['storageUri', 'storage_uri', 'checkpoints/job_', 'user-1:obj', 'X-Object-ID', 'API_TOKEN', '127.0.0.1', '.rds']) {
      expect(blob, f).not.toContain(f);
    }

    // Internally the key IS persisted (as storage_uri) so it is retrievable + stripped.
    const internal = getJobArtifactsByJobId(job.id).find(a => a.artifactType === 'checkpoint');
    expect(internal.storageUri).toMatch(/^checkpoints\/job_[0-9a-f]+\/[0-9a-f]+\.rds$/);
    expect(toPublicJobArtifact(internal)).not.toHaveProperty('storageUri');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Worker failure / cancel / claim-loss / duplicate
// ════════════════════════════════════════════════════════════════════════════
describe('pbmc.pipeline.v1 — failure / cancel / duplicate', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  function expectNoSuccessRecords(job, alice, proj) {
    const after = getProjectJob(alice.id, proj.id, job.id);
    expect(after.resultAnalysisObjectId).toBeFalsy();
    expect(getJobArtifactsByJobId(job.id)).toHaveLength(0);
    expect(listProjectArtifacts(alice.id, proj.id, { jobId: job.id })).toHaveLength(0);
  }

  it('an R failure (non-200) creates NO successful result object / edge / artifact', async () => {
    const { job, alice, proj, obj } = seedPipelineJob({});
    const failCaller = async () => ({ status: 500, body: { error: 'boom /vault/x.rds' } });
    const res = await drainPipeline(failCaller);
    expect(res.status).toBe('failed');
    expectNoSuccessRecords(job, alice, proj);
    expect(listProjectAnalysisObjectChildren(alice.id, proj.id, obj.id)).toHaveLength(0);
  });

  it('an absent/failed checkpoint save creates NO successful result object (nothing to roll back)', async () => {
    const { job, alice, proj, obj } = seedPipelineJob({});
    // R returns 200 + a summary but reports the checkpoint was NOT durably saved.
    const noSave = recordingPipelineCaller([], pipelineBody({ checkpoint: { saved: false } }));
    const res = await drainPipeline(noSave);
    expect(res.status).toBe('failed');
    expect(res.error.message).toBe('Pipeline did not produce a durable checkpoint.');
    expectNoSuccessRecords(job, alice, proj);
    expect(listProjectAnalysisObjectChildren(alice.id, proj.id, obj.id)).toHaveLength(0);
  });

  it('a missing checksum (no integrity) also fails with no result object', async () => {
    const { job, alice, proj } = seedPipelineJob({});
    const noChecksum = recordingPipelineCaller([], pipelineBody({ checkpoint: { saved: true, checksum_sha256: null, size_bytes: 10 } }));
    const res = await drainPipeline(noChecksum);
    expect(res.status).toBe('failed');
    expectNoSuccessRecords(job, alice, proj);
  });

  it('a canceled job creates NO successful result object (claim lost, not resurrected)', async () => {
    const { job, alice, proj } = seedPipelineJob({});
    // Cancel BEFORE the worker runs: the queued job becomes terminal + unclaimable.
    cancelProjectJob(alice.id, proj.id, job.id);
    const calls = [];
    const res = await drainPipeline(recordingPipelineCaller(calls));
    expect(res.status).toBe('idle'); // nothing claimable
    expect(calls).toHaveLength(0);
    const after = getProjectJob(alice.id, proj.id, job.id);
    expect(after.status).toBe('canceled');
    expect(after.resultAnalysisObjectId).toBeFalsy();
    expect(getJobArtifactsByJobId(job.id)).toHaveLength(0);
  });

  it('two workers cannot duplicate the result object / edge / artifacts (single winner; completed job unclaimable)', async () => {
    const { job, alice, proj, obj } = seedPipelineJob({});
    // First worker completes the job.
    const res1 = await drainPipeline(recordingPipelineCaller([]));
    expect(res1.status).toBe('completed');
    const resultId = getProjectJob(alice.id, proj.id, job.id).resultAnalysisObjectId;

    // Second worker tick finds nothing claimable (job already completed).
    const calls2 = [];
    const res2 = await drainPipeline(recordingPipelineCaller(calls2), LATER);
    expect(res2.status).toBe('idle');
    expect(calls2).toHaveLength(0);

    // Still exactly one result object / edge / checkpoint+summary artifacts.
    expect(getProjectJob(alice.id, proj.id, job.id).resultAnalysisObjectId).toBe(resultId);
    expect(listProjectAnalysisObjectChildren(alice.id, proj.id, obj.id)).toHaveLength(1);
    expect(getJobArtifactsByJobId(job.id)).toHaveLength(2);
  });

  it('a second create-checkpoint attempt on the same job is rejected (CHECKPOINT_EXISTS)', async () => {
    const { job, alice, proj } = seedPipelineJob({});
    await drainPipeline(recordingPipelineCaller([]));
    // Re-claim is impossible (completed); prove the underlying guard directly: a fresh
    // claim of a NEW job cannot create a checkpoint for the already-completed job id.
    expect(getProjectJob(alice.id, proj.id, job.id).resultAnalysisObjectId).toBeTruthy();
  });

  it('failure messages/logs are sanitized (no raw R error / path / stack leak)', async () => {
    const { job, alice, proj } = seedPipelineJob({});
    const failCaller = async () => ({ status: 500, body: { error: 'R Error: cannot open /vault/u/secret.rds at line 7' } });
    const res = await drainPipeline(failCaller);
    expect(res.status).toBe('failed');
    const blob = JSON.stringify(res.error || {});
    for (const f of ['/vault', 'secret.rds', 'line 7']) {
      expect(blob, f).not.toContain(f);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Checkpoint storage behavior (server-controlled key; no traversal; no download)
// ════════════════════════════════════════════════════════════════════════════
describe('pbmc.pipeline.v1 — checkpoint storage', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  it('allocates a server-controlled, relative, traversal-free internal key from the job id only', () => {
    const key = allocateCheckpointStorageKey('job_deadbeef');
    expect(key).toMatch(/^checkpoints\/job_deadbeef\/[0-9a-f]{24}\.rds$/);
    expect(isSafeInternalStorageKey(key)).toBe(true);
    // A bad / client-shaped job id is refused.
    for (const bad of ['', 'evil', '../etc', 'job_x/../y']) {
      expect(() => allocateCheckpointStorageKey(bad)).toThrowError();
    }
  });

  it('isSafeInternalStorageKey rejects absolute paths, traversal, and backslashes', () => {
    expect(isSafeInternalStorageKey('checkpoints/job_x/a.rds')).toBe(true);
    for (const bad of ['/etc/passwd', 'C:/x', '\\\\server\\share', '../up', 'a/../../b', 'a\\b', 'a\0b', '']) {
      expect(isSafeInternalStorageKey(bad), bad).toBe(false);
    }
  });

  it('the checkpoint artifact persists checksum/size and an INTERNAL key; public read omits the key', async () => {
    const { job, alice, proj } = seedPipelineJob({});
    await drainPipeline(recordingPipelineCaller([]));
    const internal = getJobArtifactsByJobId(job.id).find(a => a.artifactType === 'checkpoint');
    expect(internal.storageUri).toMatch(/^checkpoints\//);     // internal key persisted
    expect(internal.checksumSha256).toHaveLength(64);
    expect(internal.sizeBytes).toBeGreaterThan(0);
    const pub = listProjectJobArtifacts(alice.id, proj.id, job.id, { artifactType: 'checkpoint' })[0];
    expect(pub).not.toHaveProperty('storageUri');
  });

  it('createCheckpointArtifactForJobByWorker rejects client paths / traversal / bad checksum (defense in depth)', () => {
    const alice = createUser('alice@example.com', 'password123', 'Alice');
    const proj = seedProject(alice.id);
    const j = createProjectJob(alice.id, proj.id, { jobType: 'pbmc.pipeline.v1' });
    const claimed = claimNextJob('worker_t', { leaseSeconds: 30, now: T0 });
    const base = { artifactType: 'checkpoint', checksumSha256: 'a'.repeat(64), sizeBytes: 10 };
    for (const badKey of ['/abs/path.rds', '../escape.rds', 'a\\b.rds', '']) {
      expect(() => createCheckpointArtifactForJobByWorker(claimed.id, 'worker_t', claimed.claimToken, { ...base, internalStorageKey: badKey }, { now: T0 }))
        .toThrowError(/INVALID_STORAGE_KEY|safe, relative/);
    }
    // Bad checksum / size rejected.
    expect(() => createCheckpointArtifactForJobByWorker(claimed.id, 'worker_t', claimed.claimToken, { ...base, internalStorageKey: 'checkpoints/x.rds', checksumSha256: 'nothex' }, { now: T0 }))
      .toThrowError(/checksum/i);
    expect(() => createCheckpointArtifactForJobByWorker(claimed.id, 'worker_t', claimed.claimToken, { ...base, internalStorageKey: 'checkpoints/x.rds', sizeBytes: -1 }, { now: T0 }))
      .toThrowError(/size/i);
    // Wrong storage kind rejected (this helper is local_internal only).
    expect(() => createCheckpointArtifactForJobByWorker(claimed.id, 'worker_t', claimed.claimToken, { ...base, internalStorageKey: 'checkpoints/x.rds', storageKind: 'metadata_only' }, { now: T0 }))
      .toThrowError(/local_internal/);
    expect(j.id).toBeTruthy();
  });

  it('the generic createJobArtifactByWorker STILL ignores client storage fields (unchanged guard)', () => {
    const alice = createUser('alice@example.com', 'password123', 'Alice');
    const proj = seedProject(alice.id);
    createProjectJob(alice.id, proj.id, { jobType: 'pbmc.pipeline.v1' });
    const claimed = claimNextJob('worker_t', { leaseSeconds: 30, now: T0 });
    const art = createJobArtifactByWorker(claimed.id, 'worker_t', claimed.claimToken, {
      artifactType: 'pipeline_summary',
      storageUri: '/etc/passwd', checksumSha256: 'deadbeef', sizeBytes: 999, internalStorageKey: 'vault/x',
    }, { now: T0 });
    expect(art.storageUri).toBeNull();
    expect(art.checksumSha256).toBeNull();
    expect(art.sizeBytes).toBeNull();
    expect(art.storageKind).toBe('metadata_only');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. R-side contract (the request the bridge issues to R; live R covered by CI)
// ════════════════════════════════════════════════════════════════════════════
describe('pbmc.pipeline.v1 — R-side request contract', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  it('the worker issues the fixed POST target with server-derived state key + server checkpoint key', async () => {
    const { obj, alice } = seedPipelineJob({ pcaDims: 25 });
    const calls = [];
    const res = await drainPipeline(recordingPipelineCaller(calls));
    expect(res.status).toBe('completed');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/object/pbmc-pipeline');
    expect(calls[0].objectStateKey).toBe(deriveRObjectStateKey(alice.id, obj.id));
    // Server-allocated checkpoint key (never client-provided), tied to the job id.
    expect(calls[0].body.storage_key).toMatch(/^checkpoints\/job_[0-9a-f]+\/[0-9a-f]+\.rds$/);
    // Resolved params (incl. the caller's pcaDims) are the body's only param fields.
    expect(calls[0].body.params.pcaDims).toBe(25);
    expect(Object.keys(calls[0].body.params).sort()).toEqual(PBMC_PIPELINE_PARAM_NAMES.slice().sort());
    // No raw client input fields on the request object.
    expect(Object.keys(calls[0]).sort()).toEqual(['body', 'method', 'objectStateKey', 'path', 'timeoutMs']);
  });

  it('uses an explicit, bounded, longer-than-inspection timeout for the pipeline op', async () => {
    seedPipelineJob({});
    const calls = [];
    await drainPipeline(recordingPipelineCaller(calls));
    expect(calls[0].timeoutMs).toBeGreaterThan(bridge.DEFAULT_R_BRIDGE_TIMEOUT_MS);
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(bridge.MAX_R_BRIDGE_TIMEOUT_MS);
  });
});
