import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// ════════════════════════════════════════════════════════════════════════════
// DEG / marker finding as an allowlisted worker job
// (deg.find_markers.v1 + r.deg.find_markers.v1 + POST /object/deg-find-markers)
//
// DEG / FindAllMarkers runs over the OBJECT OWNER's private live R object (usually one
// produced by pbmc.pipeline.v1 → checkpoint.load.v1). Proves the DEG path:
//   - is OWNER-ONLY for v1: the job creator must OWN the analysis object
//     (verifyAnalysisObjectOwner) — project membership alone never runs DEG against
//     another user's live object (a co-member/admin is rejected BEFORE any R contact)
//   - validates parameters against a fixed server-side allowlist BEFORE any R contact;
//     unknown/invalid params fail the job without contacting R; no param can become R
//     code / a file path / an R function name
//   - uses a fixed internal bridge op (method/path/timeout fixed; server-built body from
//     the allowlisted params + a SERVER-allocated result key — no client storage key/path)
//   - blocks DIRECT public R-proxy execution of /object/deg-find-markers (404 before R)
//   - is an OUTPUT-producing analysis: creates NO new analysis object, NO lineage edge,
//     and does NOT mutate the live object; records ONE local_internal deg_markers full-table
//     artifact + ONE metadata-only deg_summary artifact (no public download)
//   - never leaks the internal storage key/path, R state key, token, internal URL, raw R
//     error/stack, expression matrices, cell metadata, or embeddings
//
// Live R FindAllMarkers + non-mutation are exercised by the R backend (parse-checked here;
// run under CI's R-backed suites + scripts/verify_deg_find_markers.R with real Rscript +
// Seurat). These Node tests inject a fake R caller so the contract is verified without a
// live R. See backend/degFindMarkers.js, backend/database.js
// (completeDegFindMarkersResultByWorker), backend/rWorkerBridge.js (r.deg.find_markers.v1),
// backend/jobWorker.js (degFindMarkersHandler), r-backend/plumber.R
// (POST /object/deg-find-markers), server.js (isInternalOnlyRProxyPath).
// ════════════════════════════════════════════════════════════════════════════

const dbmod = require('./database');
const {
  initDatabase, closeDatabase, createUser,
  createOrganizationForUser, createProjectForUser, addProjectMemberByEmail,
  createJobForUser, createProjectJob, createProjectAnalysisObject, createAnalysisObjectForUser,
  getProjectJob,
  claimNextJob, cancelProjectJob,
  getJobArtifactsByJobId,
  listProjectAnalysisObjectChildren,
  completeDegFindMarkersResultByWorker,
  isValidJobType, isValidArtifactType,
  listAnalysisObjectsForUser, listJobsForUser,
} = dbmod;

const deg = require('./degFindMarkers');
const {
  DEG_FIND_MARKERS_PARAM_SPEC, DEG_FIND_MARKERS_PARAM_NAMES,
  validateDegFindMarkersParams, allocateDegResultStorageKey,
} = deg;

const bridge = require('./rWorkerBridge');
const {
  runRBridgeOperation, isAllowedRBridgeOperation, isAllowedRBridgeTarget,
  R_BRIDGE_OPERATIONS, R_BRIDGE_ALLOWED_TARGETS, createDefaultRCaller,
  sanitizeDegSummary, sanitizeDegResultInfo,
} = bridge;

const worker = require('./jobWorker');
const { createJobWorker, DEFAULT_HANDLERS, degFindMarkersHandler } = worker;

const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const serverModule = require('../server.js');
const { deriveRObjectStateKey, isInternalOnlyRProxyPath, R_PROXY_INTERNAL_ONLY_PATHS } = serverModule;

// Deterministic UTC instants in SQLite's 'YYYY-MM-DD HH:MM:SS' format.
const T0 = '2030-01-01 00:00:00';

function silentLogger() { return { info() {}, warn() {}, error() {} }; }

// A healthy R `/object/deg-find-markers` body (the only thing the bridge reads, sanitized).
function degBody(overrides = {}) {
  return {
    ok: true,
    summary: {
      group_by: 'seurat_clusters',
      test_use: 'wilcox',
      assay: 'RNA',
      n_groups: 3,
      groups: ['0', '1', '2'],
      n_markers_total: 6,
      markers_per_group: [
        { group: '0', n: 2 }, { group: '1', n: 2 }, { group: '2', n: 2 },
      ],
      top_markers: [
        { group: '0', gene: 'CD3D', avg_log2FC: 2.51, pct_1: 0.95, pct_2: 0.10, p_val_adj: 1e-12, rank: 1 },
        { group: '0', gene: 'CD3E', avg_log2FC: 2.10, pct_1: 0.90, pct_2: 0.12, p_val_adj: 1e-10, rank: 2 },
        { group: '1', gene: 'MS4A1', avg_log2FC: 3.01, pct_1: 0.88, pct_2: 0.05, p_val_adj: 1e-14, rank: 1 },
        { group: '2', gene: 'LYZ', avg_log2FC: 2.80, pct_1: 0.92, pct_2: 0.20, p_val_adj: 1e-11, rank: 1 },
      ],
    },
    result: { saved: true, checksum_sha256: 'a'.repeat(64), size_bytes: 4096, n_rows: 6 },
    versions: { seurat_version: '5.0.1', r_version: 'R version 4.6.0' },
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
function degCaller(record, degResponse = { status: 200, body: degBody() }) {
  return recordingCaller(record, {
    '/object/deg-find-markers': () => degResponse,
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

function seedProject(ownerUserId, name = 'P') {
  const org = createOrganizationForUser(ownerUserId, { name: 'Acme' });
  return createProjectForUser(ownerUserId, { organizationId: org.id, name });
}

// Seed alice + project + an owned analysis object that DEG runs over. (The R call is faked,
// so the object only needs to exist + be owned; no real live R state is needed here.)
function seedDegInput() {
  const alice = createUser('alice@example.com', 'password123', 'Alice');
  const proj = seedProject(alice.id);
  const obj = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', displayName: 'pbmc-clustered' });
  return { alice, proj, obj };
}

function seedDegJob(creatorId, projId, objectId, extra = {}) {
  return createProjectJob(creatorId, projId, { jobType: 'deg.find_markers.v1', analysisObjectId: objectId, ...extra });
}

function degArtifacts(jobId) {
  const arts = getJobArtifactsByJobId(jobId);
  return {
    markers: arts.filter((a) => a.artifactType === 'deg_markers'),
    summary: arts.filter((a) => a.artifactType === 'deg_summary'),
    all: arts,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Scope / registration (one type + one op added; nothing else changed)
// ════════════════════════════════════════════════════════════════════════════
describe('deg.find_markers.v1 — inventory & scope', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  it('registers deg.find_markers.v1 alongside the existing handlers (existing handlers unchanged)', () => {
    expect(Object.keys(DEFAULT_HANDLERS).sort())
      .toEqual(['checkpoint.load.v1', 'checkpoint.noop', 'deg.find_markers.v1', 'generic', 'pbmc.pipeline.v1', 'r.object.inspect', 'r.runtime.check']);
    expect(DEFAULT_HANDLERS['deg.find_markers.v1']).toBe(degFindMarkersHandler);
    // Existing handlers still point at their existing functions.
    expect(DEFAULT_HANDLERS['checkpoint.load.v1']).toBe(worker.checkpointLoadHandler);
    expect(DEFAULT_HANDLERS['pbmc.pipeline.v1']).toBe(worker.pbmcPipelineHandler);
    expect(DEFAULT_HANDLERS['r.object.inspect']).toBe(worker.rObjectInspectHandler);
  });

  it('deg.find_markers.v1 is an allowed job type; deg_markers + deg_summary allowed artifact types', () => {
    expect(isValidJobType('deg.find_markers.v1')).toBe(true);
    expect(isValidArtifactType('deg_markers')).toBe(true);
    expect(isValidArtifactType('deg_summary')).toBe(true);
  });

  it('the r.deg.find_markers.v1 op is allowlisted, object-scoped, param-carrying, NON-mutating', () => {
    expect(isAllowedRBridgeOperation('r.deg.find_markers.v1')).toBe(true);
    const spec = R_BRIDGE_OPERATIONS['r.deg.find_markers.v1'];
    expect(spec.method).toBe('POST');
    expect(spec.path).toBe('/object/deg-find-markers');
    expect(spec.artifactType).toBe('deg_summary');
    expect(spec.requiresObjectContext).toBe(true);
    expect(spec.carriesDegParams).toBe(true);
    // DEG must NOT mutate the live object.
    expect(spec.mutating).toBe(false);
  });

  it('the bridge op/target sets stay exact/closed (adds only the DEG op/target)', () => {
    expect(Object.keys(R_BRIDGE_OPERATIONS).sort())
      .toEqual(['r.checkpoint.load.v1', 'r.deg.find_markers.v1', 'r.object.inspect', 'r.pbmc.pipeline.v1', 'r.runtime.check']);
    expect([...R_BRIDGE_ALLOWED_TARGETS].sort())
      .toEqual(['GET /health', 'GET /object/inspect', 'POST /object/checkpoint-load', 'POST /object/deg-find-markers', 'POST /object/pbmc-pipeline']);
  });

  it('NO pathway enrichment / CellChat job types or bridge ops are added', () => {
    for (const t of ['enrichment', 'cellchat', 'cellchat.infer',
      'enrichment.ora.v1', 'cellchat.infer.v1', 'pathway.enrichment.v1']) {
      expect(DEFAULT_HANDLERS[t]).toBeUndefined();
      expect(isValidJobType(t)).toBe(false);
    }
    for (const op of ['r.enrichment.v1', 'r.cellchat.v1', 'r.pathway.v1']) {
      expect(isAllowedRBridgeOperation(op)).toBe(false);
    }
  });

  it('the legacy "find_markers" / "deg" analytical types remain UNREGISTERED handlers (still fail terminally)', () => {
    // find_markers stays an allowed job TYPE (legacy) but has no worker HANDLER; 'deg' is not a type.
    expect(DEFAULT_HANDLERS.find_markers).toBeUndefined();
    expect(DEFAULT_HANDLERS.deg).toBeUndefined();
    expect(isValidJobType('deg')).toBe(false);
  });

  it('an unsupported job type still fails terminally (UNSUPPORTED_JOB_TYPE), no R contact', async () => {
    const alice = createUser('alice@example.com', 'password123', 'Alice');
    createJobForUser(alice.id, { jobType: 'find_markers' });
    const calls = [];
    const res = await drain(degCaller(calls));
    expect(res.status).toBe('unsupported');
    expect(calls).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Parameter validation (fixed allowlist; invalid fails before R)
// ════════════════════════════════════════════════════════════════════════════
describe('validateDegFindMarkersParams — fixed allowlist', () => {
  it('applies + records all defaults when no params are supplied', () => {
    const { params, defaultsApplied } = validateDegFindMarkersParams(undefined);
    expect(params).toEqual({
      groupBy: 'seurat_clusters', assay: 'RNA', onlyPositive: true,
      minPct: 0.1, logfcThreshold: 0.25, testUse: 'wilcox',
      maxCellsPerIdent: null, randomSeed: null, topMarkersPerCluster: 10,
    });
    expect(defaultsApplied.sort()).toEqual([...DEG_FIND_MARKERS_PARAM_NAMES].sort());
  });

  it('accepts valid params and records which were defaulted', () => {
    const { params, defaultsApplied } = validateDegFindMarkersParams({
      groupBy: 'ident', assay: 'SCT', onlyPositive: false, minPct: 0.25,
      logfcThreshold: 1.0, testUse: 'wilcox', maxCellsPerIdent: 500,
      randomSeed: 42, topMarkersPerCluster: 25,
    });
    expect(params.groupBy).toBe('ident');
    expect(params.assay).toBe('SCT');
    expect(params.onlyPositive).toBe(false);
    expect(params.maxCellsPerIdent).toBe(500);
    expect(params.topMarkersPerCluster).toBe(25);
    expect(defaultsApplied).toHaveLength(0);
  });

  it('rejects unknown parameter names (strict)', () => {
    expect(() => validateDegFindMarkersParams({ rCode: 'system("rm -rf /")' }))
      .toThrowError(/Unknown parameter/);
    expect(() => validateDegFindMarkersParams({ topMarkersPerCluster: 10, extra: 1 }))
      .toThrowError(/Unknown parameter/);
  });

  it('rejects invalid numeric params (type / range / NaN)', () => {
    expect(() => validateDegFindMarkersParams({ minPct: 2 })).toThrowError(/between 0 and 1/);
    expect(() => validateDegFindMarkersParams({ logfcThreshold: -1 })).toThrowError(/between 0 and 10/);
    expect(() => validateDegFindMarkersParams({ minPct: NaN })).toThrowError(/finite number/);
    expect(() => validateDegFindMarkersParams({ topMarkersPerCluster: 3 })).toThrowError(/between 5 and 50/);
    expect(() => validateDegFindMarkersParams({ topMarkersPerCluster: 7.5 })).toThrowError(/integer/);
  });

  it('rejects string-where-number (no coercion → nothing string-like flows to R)', () => {
    expect(() => validateDegFindMarkersParams({ minPct: '0.5' })).toThrowError(/finite number/);
    expect(() => validateDegFindMarkersParams({ maxCellsPerIdent: '500' })).toThrowError(/finite number/);
    expect(() => validateDegFindMarkersParams({ randomSeed: '42; system("x")' })).toThrowError(/finite number/);
  });

  it('restricts string params to fixed enum allowlists (no arbitrary metadata column / R function / test)', () => {
    expect(() => validateDegFindMarkersParams({ groupBy: 'orig.ident' })).toThrowError(/must be one of/);
    expect(() => validateDegFindMarkersParams({ groupBy: 'system("x")' })).toThrowError(/must be one of/);
    expect(() => validateDegFindMarkersParams({ assay: 'integrated' })).toThrowError(/must be one of/);
    // v1 only allows wilcox — no client-chosen R test function (e.g. roc/DESeq2/MAST).
    expect(() => validateDegFindMarkersParams({ testUse: 'DESeq2' })).toThrowError(/must be one of/);
    expect(() => validateDegFindMarkersParams({ testUse: 'roc' })).toThrowError(/must be one of/);
  });

  it('rejects boolean coercion + wrong-shaped containers', () => {
    expect(() => validateDegFindMarkersParams({ onlyPositive: 'true' })).toThrowError(/boolean/);
    expect(() => validateDegFindMarkersParams({ onlyPositive: 1 })).toThrowError(/boolean/);
    expect(() => validateDegFindMarkersParams([])).toThrowError(/plain JSON object/);
    expect(() => validateDegFindMarkersParams('x')).toThrowError(/plain JSON object/);
    expect(() => validateDegFindMarkersParams(5)).toThrowError(/plain JSON object/);
  });

  it('the top-marker summary limit is bounded [5, 50]', () => {
    expect(DEG_FIND_MARKERS_PARAM_SPEC.topMarkersPerCluster.min).toBe(5);
    expect(DEG_FIND_MARKERS_PARAM_SPEC.topMarkersPerCluster.max).toBe(50);
    expect(() => validateDegFindMarkersParams({ topMarkersPerCluster: 51 })).toThrowError(/between 5 and 50/);
    expect(validateDegFindMarkersParams({ topMarkersPerCluster: 50 }).params.topMarkersPerCluster).toBe(50);
  });

  it('intOrNull params accept explicit null', () => {
    const { params } = validateDegFindMarkersParams({ maxCellsPerIdent: null, randomSeed: null });
    expect(params.maxCellsPerIdent).toBeNull();
    expect(params.randomSeed).toBeNull();
  });
});

describe('allocateDegResultStorageKey — server-controlled internal key', () => {
  it('builds a safe relative key from a well-formed job id only', () => {
    const key = allocateDegResultStorageKey('job_abc123');
    expect(key).toMatch(/^deg\/job_abc123\/[0-9a-f]{24}\.csv$/);
    expect(dbmod.isSafeInternalStorageKey(key)).toBe(true);
  });
  it('refuses anything but a server-generated job id (no client input contributes)', () => {
    for (const bad of ['', 'nope', '../../etc', 'job_../x', 5, null]) {
      expect(() => allocateDegResultStorageKey(bad)).toThrowError(/server-generated job id/);
    }
  });
  it('is unique per call', () => {
    expect(allocateDegResultStorageKey('job_abc123')).not.toBe(allocateDegResultStorageKey('job_abc123'));
  });
});

describe('deg.find_markers.v1 — parameter validation at the worker (fail before R)', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  it('unknown params fail the job BEFORE any R contact (no artifact)', async () => {
    const { alice, proj, obj } = seedDegInput();
    const job = seedDegJob(alice.id, proj.id, obj.id, { parameters: { bogus: 1 } });
    const calls = [];
    const res = await drain(degCaller(calls), T0);
    expect(res.status).toBe('failed');
    expect(calls.filter((c) => c.path === '/object/deg-find-markers')).toHaveLength(0);
    expect(degArtifacts(job.id).all).toHaveLength(0);
  });

  it('invalid numeric params fail the job BEFORE any R contact (no artifact)', async () => {
    const { alice, proj, obj } = seedDegInput();
    const job = seedDegJob(alice.id, proj.id, obj.id, { parameters: { minPct: 5 } });
    const calls = [];
    const res = await drain(degCaller(calls), T0);
    expect(res.status).toBe('failed');
    expect(calls.filter((c) => c.path === '/object/deg-find-markers')).toHaveLength(0);
    expect(degArtifacts(job.id).all).toHaveLength(0);
  });

  it('resolved params (incl. defaults) appear in the safe artifact metadata on success', async () => {
    const { alice, proj, obj } = seedDegInput();
    const job = seedDegJob(alice.id, proj.id, obj.id, { parameters: { topMarkersPerCluster: 15 } });
    const res = await drain(degCaller([]), T0);
    expect(res.status).toBe('completed');
    const { summary, markers } = degArtifacts(job.id);
    expect(summary[0].metadata.resolvedParams.topMarkersPerCluster).toBe(15);
    expect(summary[0].metadata.resolvedParams.testUse).toBe('wilcox');
    expect(Array.isArray(summary[0].metadata.defaultsApplied)).toBe(true);
    expect(markers[0].metadata.resolvedParams.topMarkersPerCluster).toBe(15);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Public R-proxy block (direct /api/r/object/deg-find-markers is internal-only)
// ════════════════════════════════════════════════════════════════════════════
describe('deg.find_markers.v1 — direct R-proxy access is blocked (internal-only)', () => {
  let server;
  beforeAll(async () => { server = await startServer(); });
  afterAll(() => { if (server) server.close(); });
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  it('isInternalOnlyRProxyPath blocks every spelling of /object/deg-find-markers; allows other R paths', () => {
    expect(R_PROXY_INTERNAL_ONLY_PATHS.has('/object/deg-find-markers')).toBe(true);
    for (const p of [
      '/object/deg-find-markers', '/object/deg-find-markers/', '//object/deg-find-markers',
      '/object//deg-find-markers', '/object/deg-find-markers%2F', '\\object\\deg-find-markers',
    ]) {
      expect(isInternalOnlyRProxyPath(p), p).toBe(true);
    }
    for (const ok of ['/object/inspect', '/health', '/object/deg-find-markers-extra', '/deg-find-markers', '/deg', '']) {
      expect(isInternalOnlyRProxyPath(ok), ok).toBe(false);
    }
    // The pbmc + checkpoint-load blocks remain intact.
    expect(isInternalOnlyRProxyPath('/object/pbmc-pipeline')).toBe(true);
    expect(isInternalOnlyRProxyPath('/object/checkpoint-load')).toBe(true);
  });

  it('authenticated direct POST /api/r/object/deg-find-markers is 404 BEFORE R, with NO side effects', async () => {
    const { user, token } = createUserWithToken({ email: 'owner@example.com' });
    const owned = createAnalysisObjectForUser(user.id, { objectType: 'seurat', displayName: 'mine' });
    const r = await api(server, '/api/r/object/deg-find-markers', {
      method: 'POST', token,
      headers: { 'X-Object-ID': owned.id },
      // Even a (malicious) client-supplied storage key is irrelevant — blocked before R.
      body: { params: {}, storage_key: 'vault/owner_example_com/evil.csv' },
    });
    expect(r.status).toBe(404);
    expect(listJobsForUser(user.id, {})).toHaveLength(0);
    expect(listAnalysisObjectsForUser(user.id, {})).toHaveLength(1); // only the pre-created object
  });

  it('blocks the deg path for any method / odd spelling (still 404, no leak)', async () => {
    const { token } = createUserWithToken({ email: 'owner2@example.com' });
    for (const { method, path } of [
      { method: 'GET', path: '/api/r/object/deg-find-markers' },
      { method: 'POST', path: '/api/r/object/deg-find-markers/' },
      { method: 'PUT', path: '/api/r/object/deg-find-markers' },
      { method: 'DELETE', path: '/api/r/object/deg-find-markers' },
      { method: 'POST', path: '/api/r/object//deg-find-markers' },
    ]) {
      const r = await api(server, path, { method, token });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });

  it('unauthenticated direct call is rejected (401) and never reaches R', async () => {
    const r = await api(server, '/api/r/object/deg-find-markers', { method: 'POST', body: { params: {} } });
    expect(r.status).toBe(401);
  });

  it('does NOT over-block: a non-internal /api/r path still enforces X-Object-ID ownership before R', async () => {
    const { token } = createUserWithToken({ email: 'owner3@example.com' });
    const bad = await api(server, '/api/r/object/inspect', { method: 'GET', token, headers: { 'X-Object-ID': 'no spaces!' } });
    expect(bad.status).toBe(400);
    const unknown = await api(server, '/api/r/object/inspect', { method: 'GET', token, headers: { 'X-Object-ID': 'ao_doesnotexist' } });
    expect(unknown.status).toBe(404);
  });

  it('existing pbmc + checkpoint-load proxy blocks still 404', async () => {
    const { token } = createUserWithToken({ email: 'owner4@example.com' });
    for (const p of ['/api/r/object/pbmc-pipeline', '/api/r/object/checkpoint-load']) {
      const r = await api(server, p, { method: 'POST', token, body: {} });
      expect(r.status, p).toBe(404);
    }
  });

  it('a project co-member is blocked at the proxy for the deg path (404, no run/leak)', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const carol = createUserWithToken({ email: 'carol@example.com' });
    const proj = seedProject(alice.user.id);
    addProjectMemberByEmail(proj.id, 'carol@example.com', 'analyst', 'owner');
    const aliceObj = createProjectAnalysisObject(alice.user.id, proj.id, { objectType: 'seurat', displayName: 'a' });
    const r = await api(server, '/api/r/object/deg-find-markers', {
      method: 'POST', token: carol.token, headers: { 'X-Object-ID': aliceObj.id }, body: { params: {} },
    });
    expect(r.status).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Bridge / input control (server-built body; no client storage key/path)
// ════════════════════════════════════════════════════════════════════════════
describe('r.deg.find_markers.v1 — bridge allowlist & input control', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  const job = { id: 'job_abc', ownerUserId: 1, projectId: 'proj_1', parameters: {} };

  it('an arbitrary operation is rejected BEFORE any R contact', async () => {
    const calls = [];
    await expect(runRBridgeOperation({
      job, operation: 'r.deg.find_markers.evil', callR: async (r) => { calls.push(r); return { status: 200, body: {} }; },
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_R_OPERATION' });
    expect(calls).toHaveLength(0);
  });

  it('builds the request from SERVER-validated params + server result key only (fixed method/path; server X-Object-ID)', async () => {
    const calls = [];
    const { params } = validateDegFindMarkersParams({ topMarkersPerCluster: 12 });
    const descriptor = await runRBridgeOperation({
      job,
      operation: 'r.deg.find_markers.v1',
      objectContext: { objectId: 'ao_1', stateKey: 'user-1:obj-ao_1' },
      deg: { params, resultStorageKey: 'deg/job_abc/tok.csv' },
      // A hostile job parameters object cannot influence routing/body (input is ignored).
      input: { storage_key: '../../etc/passwd', path: '/abs/evil', endpoint: '/evil', method: 'DELETE', rCode: 'system("x")' },
      callR: async (r) => { calls.push(r); return { status: 200, body: degBody() }; },
    });
    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/object/deg-find-markers');
    expect(req.objectStateKey).toBe('user-1:obj-ao_1');
    // Body is rebuilt from server params + server key ONLY — never the client's storage_key/path.
    expect(req.body.storage_key).toBe('deg/job_abc/tok.csv');
    expect(req.body.params.topMarkersPerCluster).toBe(12);
    expect(req.body).not.toHaveProperty('path');
    expect(req.body).not.toHaveProperty('endpoint');
    expect(req.body).not.toHaveProperty('method');
    expect(req.body.params).not.toHaveProperty('rCode');
    expect(JSON.stringify(req.body)).not.toContain('etc/passwd');
    // The returned descriptor is a sanitized DEG summary + result-file integrity.
    expect(descriptor.artifactType).toBe('deg_summary');
    expect(descriptor.summary.nGroups).toBe(3);
    expect(descriptor.result.saved).toBe(true);
    expect(descriptor.metadata.scientific_output).toBe(true);
    expect(descriptor.metadata.downloadable).toBe(false);
  });

  it('re-whitelists params: a stray field on the params object cannot reach R', async () => {
    const calls = [];
    await runRBridgeOperation({
      job,
      operation: 'r.deg.find_markers.v1',
      objectContext: { objectId: 'ao_1', stateKey: 'user-1:obj-ao_1' },
      deg: { params: { topMarkersPerCluster: 10, smuggled: 'system("x")' }, resultStorageKey: 'deg/job_abc/tok.csv' },
      callR: async (r) => { calls.push(r); return { status: 200, body: degBody() }; },
    });
    expect(calls[0].body.params).not.toHaveProperty('smuggled');
    expect(JSON.stringify(calls[0].body.params)).not.toContain('system');
  });

  it('rejects a missing server result key / params BEFORE R contact', async () => {
    const calls = [];
    await expect(runRBridgeOperation({
      job,
      operation: 'r.deg.find_markers.v1',
      objectContext: { objectId: 'ao_1', stateKey: 'user-1:obj-ao_1' },
      deg: { params: { topMarkersPerCluster: 10 } }, // no resultStorageKey
      callR: async (r) => { calls.push(r); return { status: 200, body: degBody() }; },
    })).rejects.toMatchObject({ code: 'R_DEG_PARAMS_REQUIRED' });
    expect(calls).toHaveLength(0);
  });

  it('requires SERVER-derived object context (cannot run without it)', async () => {
    await expect(runRBridgeOperation({
      job, operation: 'r.deg.find_markers.v1',
      deg: { params: {}, resultStorageKey: 'deg/x.csv' },
      callR: async () => ({ status: 200, body: degBody() }),
    })).rejects.toMatchObject({ code: 'R_OBJECT_CONTEXT_REQUIRED' });
  });

  it('maps a non-200 R response to a sanitized R_DEG_FIND_MARKERS_FAILED (no raw R text)', async () => {
    let err;
    try {
      await runRBridgeOperation({
        job, operation: 'r.deg.find_markers.v1',
        objectContext: { objectId: 'ao_1', stateKey: 'user-1:obj-ao_1' },
        deg: { params: {}, resultStorageKey: 'deg/x.csv' },
        callR: async () => ({ status: 500, body: { error: 'FindAllMarkers exploded at /vault/secret/path.csv' } }),
      });
    } catch (e) { err = e; }
    expect(err.code).toBe('R_DEG_FIND_MARKERS_FAILED');
    expect(err.message).toBe('R DEG / marker finding run failed.');
    expect(err.message).not.toContain('/vault');
  });

  it('the default R caller (defense-in-depth) refuses a non-allowlisted target BEFORE HTTP', async () => {
    const callR = createDefaultRCaller({ token: 'tok' });
    await expect(callR({ method: 'POST', path: '/object/evil' }))
      .rejects.toMatchObject({ code: 'R_BRIDGE_TARGET_REJECTED' });
    expect(isAllowedRBridgeTarget('POST', '/object/deg-find-markers')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Worker success (two artifacts; no result object / lineage edge)
// ════════════════════════════════════════════════════════════════════════════
describe('deg.find_markers.v1 — worker success', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  it('runs DEG on the owner\'s object, completes, records ONE deg_markers + ONE deg_summary artifact', async () => {
    const { alice, proj, obj } = seedDegInput();
    const job = seedDegJob(alice.id, proj.id, obj.id);
    const calls = [];
    const res = await drain(degCaller(calls), T0);
    expect(res.status).toBe('completed');
    expect(res.jobId).toBe(job.id);

    // Exactly one DEG request to R, with the SERVER-allocated key + the owner's canonical key.
    const degReqs = calls.filter((c) => c.path === '/object/deg-find-markers');
    expect(degReqs).toHaveLength(1);
    expect(degReqs[0].objectStateKey).toBe(deriveRObjectStateKey(alice.id, obj.id));
    expect(degReqs[0].body.storage_key).toMatch(/^deg\/job_[0-9a-f]+\/[0-9a-f]{24}\.csv$/);

    const { markers, summary, all } = degArtifacts(job.id);
    expect(all).toHaveLength(2);
    expect(markers).toHaveLength(1);
    expect(summary).toHaveLength(1);

    // The full-table artifact: local_internal, integrity recorded, key NOT exposed publicly.
    expect(markers[0].storageKind).toBe('local_internal');
    expect(markers[0].checksumSha256).toBe('a'.repeat(64));
    expect(markers[0].sizeBytes).toBe(4096);
    // The internal projection holds storage_uri; the PUBLIC projection strips it.
    expect(markers[0].storageUri).toMatch(/^deg\//);
    expect(dbmod.toPublicJobArtifact(markers[0])).not.toHaveProperty('storageUri');

    // The summary artifact: metadata-only, bounded, scientific_output + not downloadable.
    expect(summary[0].storageKind).toBe('metadata_only');
    expect(summary[0].metadata.scientific_output).toBe(true);
    expect(summary[0].metadata.downloadable).toBe(false);
    expect(summary[0].metadata.summary.nGroups).toBe(3);
    expect(summary[0].metadata.summary.nMarkersTotal).toBe(6);
    expect(summary[0].metadata.summary.topMarkers.length).toBe(4);

    // Both artifacts associate with the INPUT object; NEITHER links a new result object.
    expect(markers[0].analysisObjectId).toBe(obj.id);
    expect(markers[0].resultAnalysisObjectId).toBeFalsy();
    expect(summary[0].resultAnalysisObjectId).toBeFalsy();
  });

  it('creates NO new analysis object and NO lineage edge (DEG is an output analysis)', async () => {
    const { alice, proj, obj } = seedDegInput();
    seedDegJob(alice.id, proj.id, obj.id);
    const before = listAnalysisObjectsForUser(alice.id, {}).length;
    const res = await drain(degCaller([]), T0);
    expect(res.status).toBe('completed');
    // The completed DEG job did not link a result object, create a child object, or an edge.
    expect(listAnalysisObjectsForUser(alice.id, {})).toHaveLength(before);
    expect(listProjectAnalysisObjectChildren(alice.id, proj.id, obj.id)).toHaveLength(0);
    expect(res.result.markersArtifactId).toBeTruthy();
    expect(res.result.summaryArtifactId).toBeTruthy();
  });

  it('public artifact metadata never leaks the storage key/path, R state key, or raw data', async () => {
    const { alice, proj, obj } = seedDegInput();
    const job = seedDegJob(alice.id, proj.id, obj.id);
    await drain(degCaller([]), T0);
    const { markers, summary } = degArtifacts(job.id);
    const pubMarkers = JSON.stringify(dbmod.toPublicJobArtifact(markers[0]));
    const pubSummary = JSON.stringify(dbmod.toPublicJobArtifact(summary[0]));
    for (const blob of [pubMarkers, pubSummary]) {
      expect(blob).not.toContain('deg/job_'); // internal storage key/path
      expect(blob).not.toContain(deriveRObjectStateKey(alice.id, obj.id)); // R state key
      expect(blob).not.toContain('barcode');
      expect(blob).not.toContain('raw_counts');
    }
  });

  it('logs are sanitized (no storage key / R state key in durable logs)', async () => {
    const { alice, proj, obj } = seedDegInput();
    const job = seedDegJob(alice.id, proj.id, obj.id);
    await drain(degCaller([]), T0);
    const wjob = dbmod.getWorkerJob ? dbmod.getWorkerJob(job.id) : null;
    const logs = JSON.stringify((wjob && wjob.logs) || dbmod.getProjectJob(alice.id, proj.id, job.id).logs || []);
    expect(logs).not.toContain('deg/job_');
    expect(logs).not.toContain(deriveRObjectStateKey(alice.id, obj.id));
  });

  it('a duplicate completion cannot duplicate the success artifacts (DEG_RESULT_EXISTS)', async () => {
    const { alice, proj, obj } = seedDegInput();
    const job = seedDegJob(alice.id, proj.id, obj.id);
    const claimed = claimNextJob('worker_A', { leaseSeconds: 30, now: T0 });
    expect(claimed.id).toBe(job.id);
    const input = {
      markersArtifact: {
        artifactType: 'deg_markers', storageKind: 'local_internal',
        internalStorageKey: 'deg/job_x/tok.csv', checksumSha256: 'a'.repeat(64), sizeBytes: 10,
        metadata: {},
      },
      summaryArtifact: { artifactType: 'deg_summary', storageKind: 'metadata_only', metadata: {} },
    };
    // First completion succeeds.
    completeDegFindMarkersResultByWorker(job.id, 'worker_A', claimed.claimToken, input, { now: T0 });
    // A second completion (duplicate) is refused — no duplicate artifacts.
    expect(() => completeDegFindMarkersResultByWorker(job.id, 'worker_A', claimed.claimToken, input, { now: T0 }))
      .toThrowError(/DEG marker result/);
    expect(degArtifacts(job.id).markers).toHaveLength(1);
    expect(degArtifacts(job.id).summary).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Worker failure / cancel (no successful artifacts)
// ════════════════════════════════════════════════════════════════════════════
describe('deg.find_markers.v1 — worker failure / cancel', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  it('an R failure (non-200) fails the job and records NO DEG artifact', async () => {
    const { alice, proj, obj } = seedDegInput();
    const job = seedDegJob(alice.id, proj.id, obj.id);
    const res = await drain(degCaller([], { status: 500, body: { error: 'boom' } }), T0);
    expect(res.status).toBe('failed');
    expect(degArtifacts(job.id).all).toHaveLength(0);
    expect(getProjectJob(alice.id, proj.id, job.id).status).toBe('failed');
  });

  it('an R result with saved:false fails the job and records NO DEG artifact', async () => {
    const { alice, proj, obj } = seedDegInput();
    const job = seedDegJob(alice.id, proj.id, obj.id);
    const body = degBody({ result: { saved: false, checksum_sha256: null, size_bytes: 0, n_rows: 0 } });
    const res = await drain(degCaller([], { status: 200, body }), T0);
    expect(res.status).toBe('failed');
    expect(degArtifacts(job.id).all).toHaveLength(0);
  });

  it('a missing checksum (write produced no integrity) fails the job and records NO DEG artifact', async () => {
    const { alice, proj, obj } = seedDegInput();
    const job = seedDegJob(alice.id, proj.id, obj.id);
    const body = degBody({ result: { saved: true, checksum_sha256: 'not-hex', size_bytes: 1, n_rows: 1 } });
    const res = await drain(degCaller([], { status: 200, body }), T0);
    expect(res.status).toBe('failed');
    expect(degArtifacts(job.id).all).toHaveLength(0);
  });

  it('a canceled job creates no successful DEG artifact (claim lost mid-run, not resurrected)', async () => {
    const { alice, proj, obj } = seedDegInput();
    const job = seedDegJob(alice.id, proj.id, obj.id);
    const cancelingCaller = async (req) => {
      if (req.path === '/object/deg-find-markers') cancelProjectJob(alice.id, proj.id, job.id);
      return { status: 200, body: degBody() };
    };
    const res = await drain(cancelingCaller, T0);
    expect(['claim_lost', 'failed']).toContain(res.status);
    expect(getProjectJob(alice.id, proj.id, job.id).status).toBe('canceled');
    expect(degArtifacts(job.id).all).toHaveLength(0);
  });

  it('a duplicate worker cannot claim a running DEG job (single-winner) → no duplicate artifact', async () => {
    const { alice, proj, obj } = seedDegInput();
    const job = seedDegJob(alice.id, proj.id, obj.id);
    const claimed = claimNextJob('worker_A', { leaseSeconds: 30, now: T0 });
    expect(claimed.id).toBe(job.id);
    const res = await drain(degCaller([]), T0, { workerId: 'worker_B' });
    expect(res.status).toBe('idle');
    expect(degArtifacts(job.id).all).toHaveLength(0);
  });

  it('a claim lost before completion does not write artifacts (stale worker cannot complete)', async () => {
    const { alice, proj, obj } = seedDegInput();
    const job = seedDegJob(alice.id, proj.id, obj.id);
    const claimed = claimNextJob('worker_A', { leaseSeconds: 30, now: T0 });
    // Cancel voids the claim; a stale completion attempt is refused (CLAIM_LOST), no artifacts.
    cancelProjectJob(alice.id, proj.id, job.id);
    expect(() => completeDegFindMarkersResultByWorker(job.id, 'worker_A', claimed.claimToken, {
      markersArtifact: { artifactType: 'deg_markers', storageKind: 'local_internal', internalStorageKey: 'deg/job_x/t.csv', checksumSha256: 'a'.repeat(64), sizeBytes: 1, metadata: {} },
      summaryArtifact: { artifactType: 'deg_summary', storageKind: 'metadata_only', metadata: {} },
    }, { now: T0 })).toThrowError(/claim/i);
    expect(degArtifacts(job.id).all).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Authorization & ownership (owner-only v1; viewer/non-member/co-member/cross-project)
// ════════════════════════════════════════════════════════════════════════════
describe('deg.find_markers.v1 — authorization & ownership', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  it('the OWNER can create + run a DEG job for their own object', async () => {
    const { alice, proj, obj } = seedDegInput();
    const job = seedDegJob(alice.id, proj.id, obj.id);
    const res = await drain(degCaller([]), T0);
    expect(res.status).toBe('completed');
    expect(res.jobId).toBe(job.id);
  });

  it('a VIEWER cannot create a DEG job (FORBIDDEN; viewers cannot create jobs)', async () => {
    const { proj, obj } = seedDegInput();
    const viewer = createUser('viewer@example.com', 'password123', 'Viewer');
    addProjectMemberByEmail(proj.id, 'viewer@example.com', 'viewer', 'owner');
    let err;
    try { seedDegJob(viewer.id, proj.id, obj.id); } catch (e) { err = e; }
    expect(err && err.code).toBe('FORBIDDEN');
  });

  it('a NON-MEMBER cannot create a DEG job (404, no project existence leak)', async () => {
    const { proj, obj } = seedDegInput();
    const stranger = createUser('stranger@example.com', 'password123', 'Stranger');
    let err;
    try { seedDegJob(stranger.id, proj.id, obj.id); } catch (e) { err = e; }
    expect(err && err.code).toBe('NOT_FOUND');
  });

  it('a co-member ANALYST who does NOT own the object is rejected BEFORE R contact (job fails, no R, no artifact)', async () => {
    const { proj, obj } = seedDegInput();
    const carol = createUser('carol@example.com', 'password123', 'Carol');
    addProjectMemberByEmail(proj.id, 'carol@example.com', 'analyst', 'owner');
    // Carol CAN create the job (object is in her project) but the worker owner-gate fails it.
    const job = seedDegJob(carol.id, proj.id, obj.id);
    const calls = [];
    const res = await drain(degCaller(calls), T0);
    expect(res.status).toBe('failed');
    expect(calls.filter((c) => c.path === '/object/deg-find-markers')).toHaveLength(0); // never reached R
    expect(degArtifacts(job.id).all).toHaveLength(0);
  });

  it('a co-member ADMIN who does NOT own the object is ALSO rejected before R contact (membership ≠ live R)', async () => {
    const { proj, obj } = seedDegInput();
    const bob = createUser('bob@example.com', 'password123', 'Bob');
    addProjectMemberByEmail(proj.id, 'bob@example.com', 'admin', 'owner');
    const job = seedDegJob(bob.id, proj.id, obj.id);
    const calls = [];
    const res = await drain(degCaller(calls), T0);
    expect(res.status).toBe('failed');
    expect(calls.filter((c) => c.path === '/object/deg-find-markers')).toHaveLength(0);
    expect(degArtifacts(job.id).all).toHaveLength(0);
  });

  it('a cross-project object cannot be referenced by a DEG job (404 at creation)', async () => {
    const { alice, proj, obj } = seedDegInput(); // eslint-disable-line no-unused-vars
    const otherProj = seedProject(alice.id, 'Other');
    expect(() => seedDegJob(alice.id, otherProj.id, obj.id)).toThrowError(/not found/i);
  });

  it('a malformed / unknown object id is rejected at job creation (404)', () => {
    const alice = createUser('alice@example.com', 'password123', 'Alice');
    const proj = seedProject(alice.id);
    expect(() => seedDegJob(alice.id, proj.id, 'ao_nope')).toThrowError(/not found/i);
  });

  it('a legacy owner-scoped object is not usable through a project DEG job (no project leak)', async () => {
    const alice = createUser('alice@example.com', 'password123', 'Alice');
    const proj = seedProject(alice.id);
    // Owner-scoped (no project) object cannot be referenced by a project job in proj.
    const legacy = createAnalysisObjectForUser(alice.id, { objectType: 'seurat', displayName: 'legacy' });
    expect(() => seedDegJob(alice.id, proj.id, legacy.id)).toThrowError(/not found/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. sanitizeDegSummary / sanitizeDegResultInfo (no raw data ever survives)
// ════════════════════════════════════════════════════════════════════════════
describe('sanitizeDegSummary — bounded, metadata-only, safe columns only', () => {
  it('keeps only the allowlisted structural + safe-column fields; drops everything else', () => {
    const out = sanitizeDegSummary({
      summary: {
        group_by: 'seurat_clusters', test_use: 'wilcox', assay: 'RNA',
        n_groups: 2, groups: ['0', '1'], n_markers_total: 3,
        markers_per_group: [{ group: '0', n: 2 }, { group: '1', n: 1 }],
        top_markers: [
          { group: '0', gene: 'CD3D', avg_log2FC: 2.5, pct_1: 0.9, pct_2: 0.1, p_val_adj: 1e-9, rank: 1,
            // Hostile extras on the row that must be dropped:
            raw_expression: [1, 2, 3], cell_barcode: 'AAACCTGAGAAACCAT', storage_key: '/vault/secret.csv' },
        ],
        // Hostile extras at the summary level that must be dropped:
        raw_counts: [[1, 2, 3]], cell_metadata: [{ barcode: 'AAA' }], embeddings: [[0.1, 0.2]],
        storage_key: 'vault/secret/path.csv', state_key: 'user-1:obj-ao_1',
      },
      versions: { seurat_version: '5.0.1', r_version: 'R version 4.6.0' },
    });
    expect(out.groupBy).toBe('seurat_clusters');
    expect(out.nGroups).toBe(2);
    expect(out.groups).toEqual(['0', '1']);
    expect(out.nMarkersTotal).toBe(3);
    expect(out.markersPerGroup).toEqual([{ group: '0', n: 2 }, { group: '1', n: 1 }]);
    expect(out.topMarkers).toEqual([{ group: '0', gene: 'CD3D', avgLog2FC: 2.5, pct1: 0.9, pct2: 0.1, pValAdj: 1e-9, rank: 1 }]);
    expect(out.seuratVersion).toBe('5.0.1');
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('vault/secret');
    expect(blob).not.toContain('AAACCTGAGAAACCAT');
    expect(blob).not.toContain('user-1:obj');
    expect(blob).not.toContain('raw_counts');
    expect(blob).not.toContain('embeddings');
  });

  it('hard-caps the top-marker rows even if R returns an unbounded table', () => {
    const huge = [];
    for (let i = 0; i < 5000; i++) huge.push({ group: '0', gene: `G${i}`, avg_log2FC: 1, pct_1: 0.5, pct_2: 0.1, p_val_adj: 0.01, rank: i });
    const out = sanitizeDegSummary({ summary: { top_markers: huge } });
    expect(out.topMarkers.length).toBeLessThanOrEqual(2000);
  });

  it('drops NaN/Infinity/oversized numeric stats', () => {
    const out = sanitizeDegSummary({ summary: { top_markers: [
      { group: '0', gene: 'X', avg_log2FC: Infinity, pct_1: NaN, pct_2: 1e20, p_val_adj: 'bad', rank: -1 },
    ] } });
    const row = out.topMarkers[0];
    expect(row).toEqual({ group: '0', gene: 'X' }); // every bad stat dropped
  });
});

describe('sanitizeDegResultInfo — file integrity only, never the path/key', () => {
  it('keeps saved + checksum + size + rows; never a path/key', () => {
    expect(sanitizeDegResultInfo({ result: { saved: true, checksum_sha256: 'b'.repeat(64), size_bytes: 99, n_rows: 7, storage_key: '/vault/x.csv' } }))
      .toEqual({ saved: true, checksumSha256: 'b'.repeat(64), sizeBytes: 99, nRows: 7 });
  });
  it('a not-saved / garbage body collapses safely', () => {
    expect(sanitizeDegResultInfo({ result: { saved: false, checksum_sha256: 'nothex', size_bytes: -1 } }))
      .toEqual({ saved: false, checksumSha256: null, sizeBytes: null, nRows: null });
    expect(sanitizeDegResultInfo(null)).toEqual({ saved: false, checksumSha256: null, sizeBytes: null, nRows: null });
  });
});
