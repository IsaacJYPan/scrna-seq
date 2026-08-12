#!/usr/bin/env node
'use strict';

// Executed inside the Compose web container by verify-compose-private-compute.js.
// The acceptance overlay mounts this reviewed source read-only; production
// images remain pruned and do not acquire a general test runner.

const crypto = require('crypto');
const fs = require('fs');
const db = require('/app/backend/pgDatabase');
const config = require('/app/backend/config');
const { deriveRObjectStateKey } = require('/app/backend/rStateKeys');
const design = require('/app/backend/experimentalDesign');

const HTTP_BASE = 'http://127.0.0.1:3000';
const ACCEPTANCE_ORIGIN = process.env.FRONTEND_ORIGIN;

function assert(condition, message, detail = '') {
  if (!condition) throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
}

function output(value) {
  process.stdout.write(`ACCEPTANCE_JSON=${JSON.stringify(value)}\n`);
}

async function login(email, password) {
  const response = await fetch(`${HTTP_BASE}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ACCEPTANCE_ORIGIN,
      'X-Forwarded-Proto': 'https',
    },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  assert(response.status === 200, 'deployment login failed', `${response.status}/${JSON.stringify(body)}`);
  const setCookie = response.headers.get('set-cookie') || '';
  const cookieName = config.sessionCookieName();
  const escapedName = cookieName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escapedName}=([^;]+)`).exec(setCookie);
  assert(match, 'deployment login did not return the HttpOnly session cookie');
  assert(!JSON.stringify(body).match(/token|sessionVersion/i), 'login JSON exposed session material');
  return { cookie: `${cookieName}=${match[1]}`, user: body.user };
}

async function http(session, pathname, options = {}) {
  const method = options.method || 'GET';
  const headers = {
    Accept: options.accept || 'application/json',
    Cookie: session.cookie,
    Origin: ACCEPTANCE_ORIGIN,
    'X-Forwarded-Proto': 'https',
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${HTTP_BASE}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let data = null;
  if ((response.headers.get('content-type') || '').includes('application/json') && bytes.length > 0) {
    try { data = JSON.parse(bytes.toString('utf8')); } catch { data = null; }
  }
  if (options.expected !== undefined) {
    const expected = Array.isArray(options.expected) ? options.expected : [options.expected];
    assert(expected.includes(response.status), `${method} ${pathname} returned an unexpected status`,
      `${response.status}/${bytes.toString('utf8').slice(0, 500)}`);
  }
  return { status: response.status, headers: response.headers, bytes, data };
}

async function seed() {
  await db.initSchema();
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const lanes = [];
  for (let index = 1; index <= 2; index += 1) {
    const email = `private-lane-${index}-${stamp}@example.com`;
    const password = `Private-${index}-${crypto.randomBytes(18).toString('base64url')}`;
    const user = await db.createUser(
      email,
      password,
      `Private lane ${index}`
    );
    const org = await db.createOrganizationForUser(user.id, { name: `Lane ${index} org` });
    const project = await db.createProjectForUser(user.id, {
      organizationId: org.id, name: `Lane ${index} project`,
    });
    const object = await db.createProjectAnalysisObject(user.id, project.id, {
      objectType: 'seurat', displayName: `Private fixture ${index}`,
    });
    const producer = await db.createProjectJob(user.id, project.id, {
      jobType: 'checkpoint.noop', analysisObjectId: object.id,
    });
    await db.updateJobStatusForUser(user.id, producer.id, 'running');
    await db.updateJobStatusForUser(user.id, producer.id, 'completed', {
      resultAnalysisObjectId: object.id,
    });
    lanes.push({
      index, userId: user.id, projectId: project.id, objectId: object.id,
      email, password, projectName: project.name,
      producerJobId: producer.id,
      checkpointKey: `projects/${project.id}/checkpoints/${producer.id}/checkpoint.rds`,
    });
  }
  output({ lanes });
}

async function registerCheckpoints(input) {
  assert(Array.isArray(input.lanes) && input.lanes.length === 2, 'two seeded lanes are required');
  for (const lane of input.lanes) {
    const absolute = `/app/storage-volume/data/${lane.checkpointKey}`;
    const bytes = fs.readFileSync(absolute);
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
    await db.query(
      `INSERT INTO job_artifacts
         (id, project_id, job_id, result_analysis_object_id, created_by_user_id,
          artifact_type, name, mime_type, storage_kind, storage_uri,
          checksum_sha256, size_bytes, status, metadata_json)
       VALUES ($1, $2, $3, $4, $5, 'checkpoint', 'Private acceptance checkpoint',
               'application/x-r-rds', 'local_internal', $6, $7, $8, 'available', $9)`,
      [db.genId('art'), lane.projectId, lane.producerJobId, lane.objectId,
        Number(lane.userId), lane.checkpointKey, checksum, bytes.length,
        JSON.stringify({ acceptanceFixture: true, lane: lane.index })]
    );
  }
}

async function launch() {
  const input = JSON.parse(process.env.ACCEPTANCE_INPUT || '{}');
  await registerCheckpoints(input);
  const jobs = [];
  for (const lane of input.lanes) {
    const job = await db.createProjectJob(lane.userId, lane.projectId, {
      jobType: 'deg.find_markers.v1', analysisObjectId: lane.objectId,
      parameters: { groupBy: 'seurat_clusters', testUse: 'wilcox', onlyPositive: true },
    });
    jobs.push({
      id: job.id, userId: lane.userId, projectId: lane.projectId,
      objectId: lane.objectId, lane: lane.index,
    });
  }
  const queued = await db.createProjectJob(input.lanes[0].userId, input.lanes[0].projectId, {
    jobType: 'deg.find_markers.v1', analysisObjectId: input.lanes[0].objectId,
    parameters: { groupBy: 'seurat_clusters', testUse: 'wilcox', onlyPositive: true },
  });
  jobs.push({
    id: queued.id, userId: input.lanes[0].userId, projectId: input.lanes[0].projectId,
    objectId: input.lanes[0].objectId, lane: 1,
  });
  output({ jobs });
}

async function rState(port, stateKey) {
  const response = await fetch(`http://127.0.0.1:${port}/__test/session-state`, {
    headers: {
      'X-API-Token': process.env.R_API_TOKEN,
      'X-Object-ID': stateKey,
    },
  });
  assert(response.ok, 'R state diagnostic failed', `${port}/${response.status}`);
  return response.json();
}

async function waitForEmptyComputeState(label, timeoutMs = 30_000) {
  const diagnosticKey = `user-999999:obj-ao_${'0'.repeat(24)}`;
  const deadline = Date.now() + timeoutMs;
  let evidence = {};
  while (Date.now() < deadline) {
    evidence = {};
    let empty = true;
    for (const [slot, port] of [[2, 8001], [3, 8002]]) {
      const state = await rState(port, diagnosticKey);
      const keys = Array.isArray(state.active_session_keys) ? state.active_session_keys : [];
      evidence[slot] = { activeSessionKeys: keys };
      if (keys.length !== 0) empty = false;
    }
    if (empty) return evidence;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} left hydrated job state in a reusable compute runtime: ${JSON.stringify(evidence)}`);
}

async function rSessionId(port) {
  const response = await fetch(`http://127.0.0.1:${port}/session-id`, {
    headers: { 'X-API-Token': process.env.R_API_TOKEN },
  });
  assert(response.ok, 'R session identity request failed', `${port}/${response.status}`);
  const body = await response.json();
  assert(typeof body.sessionId === 'string' && body.sessionId, 'R session identity is missing');
  return body.sessionId;
}

function normalizedRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    workerId: row.worker_id,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    error: row.last_worker_error ? JSON.parse(row.last_worker_error) : null,
  }));
}

async function collectJobStateEvidence(assignments, byId) {
  const samples = await Promise.all(assignments.map(async ({ jobId, slot }) => {
    const job = byId.get(jobId);
    const port = slot === 2 ? 8001 : 8002;
    const ownKey = deriveRObjectStateKey(job.userId, `${job.objectId}-job-${job.id}`);
    const state = await rState(port, ownKey);
    const observed = state.job_session_observation;
    return {
      port, slot,
      observedAt: typeof observed?.observed_at === 'string' ? observed.observed_at : null,
      observedHasGlobalObject: observed?.has_global_obj === true,
      observedActiveSessionKeyCount: Number(observed?.active_session_key_count || 0),
      observedOwnKeyPresent: observed?.own_key_present === true,
      observedForeignKeyCount: Number(observed?.foreign_key_count || 0),
    };
  }));
  const stateEvidence = Object.fromEntries(samples.map((sample) => [sample.slot, sample]));
  assert(samples.every(({ observedAt, observedHasGlobalObject, observedActiveSessionKeyCount,
    observedOwnKeyPresent, observedForeignKeyCount }) => (
    observedAt && observedHasGlobalObject && observedActiveSessionKeyCount === 1
      && observedOwnKeyPresent && observedForeignKeyCount === 0
  )), 'each R lane must record only its own active job state', JSON.stringify(stateEvidence));
  return stateEvidence;
}

async function observe() {
  const input = JSON.parse(process.env.ACCEPTANCE_INPUT || '{}');
  assert(Array.isArray(input.jobs) && input.jobs.length === 3, 'three jobs are required');
  const ids = input.jobs.map((job) => job.id);
  const byId = new Map(input.jobs.map((job) => [job.id, job]));
  const runtimeIds = {
    2: await rSessionId(8001),
    3: await rSessionId(8002),
  };
  assert(runtimeIds[2] !== runtimeIds[3], 'compute lanes must expose distinct R runtime identities');

  let overlap = null;
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    const { rows } = await db.query(
      `SELECT id, status, worker_id, started_at, completed_at, last_worker_error
         FROM jobs WHERE id = ANY($1::text[]) ORDER BY created_at, id`, [ids]
    );
    const running = rows.filter((row) => row.status === 'running');
    const queued = rows.filter((row) => row.status === 'queued');
    if (!overlap && running.length === 2 && queued.length === 1) {
      const slots = running.map((row) => Number(String(row.worker_id || '').match(/^pool-(\d+):/)?.[1]));
      assert(new Set(slots).size === 2 && slots.every((slot) => slot === 2 || slot === 3),
        'overlapping jobs must be claimed by compute slots 2 and 3', JSON.stringify(slots));
      overlap = {
        observedAt: new Date().toISOString(),
        runningJobIds: running.map((row) => row.id),
        queuedJobId: queued[0].id,
        assignments: running.map((row) => ({
          jobId: row.id, slot: Number(String(row.worker_id).match(/^pool-(\d+):/)[1]),
        })),
        slots,
        runtimeIds,
        stateEvidence: null,
      };
    }
    if (rows.length === 3 && rows.every((row) => row.status === 'completed')) break;
    const terminalFailure = rows.find((row) => ['failed', 'canceled'].includes(row.status));
    if (terminalFailure) {
      throw new Error(`job ${terminalFailure.id} stopped: ${terminalFailure.last_worker_error || terminalFailure.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(overlap, 'two running jobs and one queued job were not observed');
  overlap.stateEvidence = await collectJobStateEvidence(overlap.assignments, byId);
  delete overlap.assignments;

  const { rows } = await db.query(
    `SELECT id, status, worker_id, started_at, completed_at, last_worker_error
       FROM jobs WHERE id = ANY($1::text[]) ORDER BY created_at, id`, [ids]
  );
  assert(rows.length === 3 && rows.every((row) => row.status === 'completed'),
    'all three jobs must complete', JSON.stringify(normalizedRows(rows)));
  const runningRows = overlap.runningJobIds.map((id) => rows.find((row) => row.id === id));
  const firstStart = Math.max(...runningRows.map((row) => new Date(row.started_at).getTime()));
  const firstFinish = Math.min(...runningRows.map((row) => new Date(row.completed_at).getTime()));
  assert(firstStart < firstFinish, 'the first two jobs must overlap by recorded timestamps');
  const queuedRow = rows.find((row) => row.id === overlap.queuedJobId);
  assert(new Date(queuedRow.started_at).getTime() >= firstFinish,
    'the third job must remain queued until a compute lane becomes free');
  const cleanupEvidence = await waitForEmptyComputeState('private-compute overlap jobs');

  const { rows: artifacts } = await db.query(
    `SELECT job_id, project_id, artifact_type, storage_uri, checksum_sha256, size_bytes
       FROM job_artifacts WHERE job_id = ANY($1::text[])
       ORDER BY job_id, artifact_type`, [ids]
  );
  const markerArtifacts = artifacts.filter((artifact) => artifact.artifact_type === 'deg_markers');
  assert(markerArtifacts.length === 3, 'each job must publish one private DEG result');
  const hashes = [];
  for (const artifact of markerArtifacts) {
    const job = byId.get(artifact.job_id);
    assert(artifact.project_id === job.projectId, 'artifact project must match its private job');
    assert(String(artifact.storage_uri).startsWith(`projects/${job.projectId}/`),
      'artifact bytes must stay in the owning project prefix');
    const bytes = fs.readFileSync(`/app/storage-volume/data/${artifact.storage_uri}`);
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
    assert(checksum === artifact.checksum_sha256 && bytes.length === Number(artifact.size_bytes),
      'artifact checksum and size must match exact bytes');
    hashes.push(checksum);
  }
  const hashByProject = new Map();
  for (let index = 0; index < markerArtifacts.length; index += 1) {
    if (!hashByProject.has(markerArtifacts[index].project_id)) {
      hashByProject.set(markerArtifacts[index].project_id, hashes[index]);
    }
  }
  assert(hashByProject.size === 2 && new Set(hashByProject.values()).size === 2,
    'different private project fixtures must produce different result bytes');

  output({
    overlap,
    jobs: normalizedRows(rows),
    markerArtifacts: markerArtifacts.map((artifact) => ({
      jobId: artifact.job_id,
      projectId: artifact.project_id,
      checksumSha256: artifact.checksum_sha256,
      sizeBytes: Number(artifact.size_bytes),
    })),
    cleanupEvidence,
  });
}

async function waitForCompletedJobs(jobIds, label, timeoutMs = 8 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  while (Date.now() < deadline) {
    ({ rows } = await db.query(
      `SELECT id, status, worker_id, started_at, completed_at, last_worker_error,
              owner_user_id, project_id, analysis_object_id, result_analysis_object_id
         FROM jobs WHERE id = ANY($1::text[]) ORDER BY created_at, id`, [jobIds]
    ));
    if (rows.length === jobIds.length && rows.every((row) => row.status === 'completed')) return rows;
    const stopped = rows.find((row) => ['failed', 'canceled'].includes(row.status));
    if (stopped) throw new Error(`${label} job ${stopped.id} stopped: ${stopped.last_worker_error || stopped.status}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} jobs did not complete: ${JSON.stringify(normalizedRows(rows))}`);
}

async function sameProjectLaunch() {
  const input = JSON.parse(process.env.ACCEPTANCE_INPUT || '{}');
  assert(Array.isArray(input.lanes) && input.lanes.length === 2, 'two seeded lanes are required');
  const owner = input.lanes[0];
  const analyst = input.lanes[1];
  await db.addProjectMember(owner.projectId, analyst.userId, 'analyst');

  const forkJobs = [];
  for (const userId of [owner.userId, analyst.userId]) {
    const job = await db.createProjectJob(userId, owner.projectId, {
      jobType: 'checkpoint.fork.v1', analysisObjectId: owner.objectId, parameters: {},
    });
    forkJobs.push(job);
  }
  const forkRows = await waitForCompletedJobs(
    forkJobs.map((job) => job.id), 'same-project checkpoint fork'
  );
  assert(forkRows.every((row) => row.analysis_object_id === owner.objectId),
    'both analysts must fork the same starting checkpoint');
  assert(forkRows.every((row) => typeof row.result_analysis_object_id === 'string'
    && row.result_analysis_object_id), 'each checkpoint fork must create a result object');

  const jobs = [];
  for (const fork of forkRows) {
    const userId = Number(fork.owner_user_id);
    const job = await db.createProjectJob(userId, owner.projectId, {
      jobType: 'deg.find_markers.v1', analysisObjectId: fork.result_analysis_object_id,
      parameters: { groupBy: 'seurat_clusters', testUse: 'wilcox', onlyPositive: true },
    });
    jobs.push({
      id: job.id,
      userId,
      projectId: owner.projectId,
      objectId: fork.result_analysis_object_id,
      sourceObjectId: owner.objectId,
      forkJobId: fork.id,
    });
  }
  output({ jobs, projectId: owner.projectId, sourceObjectId: owner.objectId });
}

async function sameProjectObserve() {
  const input = JSON.parse(process.env.ACCEPTANCE_INPUT || '{}');
  assert(Array.isArray(input.jobs) && input.jobs.length === 2, 'two same-project jobs are required');
  assert(new Set(input.jobs.map((job) => job.projectId)).size === 1,
    'same-project jobs must belong to one project');
  assert(new Set(input.jobs.map((job) => job.sourceObjectId)).size === 1,
    'same-project jobs must share one starting checkpoint');
  assert(new Set(input.jobs.map((job) => job.userId)).size === 2,
    'same-project jobs must be owned by two analysts');

  const ids = input.jobs.map((job) => job.id);
  const byId = new Map(input.jobs.map((job) => [job.id, job]));
  let overlap = null;
  const deadline = Date.now() + 8 * 60 * 1000;
  let rows = [];
  while (Date.now() < deadline) {
    ({ rows } = await db.query(
      `SELECT id, status, worker_id, started_at, completed_at, last_worker_error
         FROM jobs WHERE id = ANY($1::text[]) ORDER BY created_at, id`, [ids]
    ));
    const running = rows.filter((row) => row.status === 'running');
    if (!overlap && running.length === 2) {
      const assignments = running.map((row) => ({
        jobId: row.id, slot: Number(String(row.worker_id || '').match(/^pool-(\d+):/)?.[1]),
      }));
      assert(new Set(assignments.map(({ slot }) => slot)).size === 2
        && assignments.every(({ slot }) => slot === 2 || slot === 3),
      'same-project jobs must occupy both isolated compute lanes');
      overlap = { observedAt: new Date().toISOString(), assignments, stateEvidence: null };
    }
    if (rows.length === 2 && rows.every((row) => row.status === 'completed')) break;
    const stopped = rows.find((row) => ['failed', 'canceled'].includes(row.status));
    if (stopped) throw new Error(`same-project job ${stopped.id} stopped: ${stopped.last_worker_error || stopped.status}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(overlap, 'two same-project analyst jobs were not observed running concurrently');
  overlap.stateEvidence = Object.values(await collectJobStateEvidence(overlap.assignments, byId));
  delete overlap.assignments;
  assert(rows.length === 2 && rows.every((row) => row.status === 'completed'),
    'both same-project analyst jobs must complete', JSON.stringify(normalizedRows(rows)));
  const latestStart = Math.max(...rows.map((row) => new Date(row.started_at).getTime()));
  const earliestFinish = Math.min(...rows.map((row) => new Date(row.completed_at).getTime()));
  assert(latestStart < earliestFinish, 'same-project analyst job timestamps must overlap');

  const { rows: objects } = await db.query(
    `SELECT id, owner_user_id, project_id, parent_object_id
       FROM analysis_objects WHERE id = ANY($1::text[])`, [input.jobs.map((job) => job.objectId)]
  );
  assert(objects.length === 2 && objects.every((object) => object.project_id === input.projectId
    && object.parent_object_id === input.sourceObjectId),
  'forked analysis objects must retain the shared source lineage and project');
  assert(new Set(objects.map((object) => Number(object.owner_user_id))).size === 2,
    'forked analysis objects must remain privately owned by the two analysts');

  const { rows: artifacts } = await db.query(
    `SELECT job_id, project_id, artifact_type, storage_uri, checksum_sha256, size_bytes
       FROM job_artifacts WHERE job_id = ANY($1::text[]) AND artifact_type = 'deg_markers'
       ORDER BY job_id`, [ids]
  );
  assert(artifacts.length === 2, 'both same-project jobs must publish marker artifacts');
  assert(new Set(artifacts.map((artifact) => artifact.storage_uri)).size === 2,
    'same-project outputs must use distinct per-job storage keys');
  for (const artifact of artifacts) {
    assert(artifact.project_id === input.projectId
      && String(artifact.storage_uri).startsWith(`projects/${input.projectId}/artifacts/`),
    'same-project output must remain under its project artifact prefix');
    const bytes = fs.readFileSync(`/app/storage-volume/data/${artifact.storage_uri}`);
    assert(crypto.createHash('sha256').update(bytes).digest('hex') === artifact.checksum_sha256
      && bytes.length === Number(artifact.size_bytes),
    'same-project artifact integrity check failed');
  }
  const cleanupEvidence = await waitForEmptyComputeState('same-project analyst jobs');
  output({
    overlap,
    jobs: normalizedRows(rows),
    analystCount: new Set(input.jobs.map((job) => job.userId)).size,
    sharedSourceVerified: true,
    privateForkOwnershipVerified: true,
    distinctOutputKeysVerified: true,
    cleanupEvidence,
  });
}

async function scientificLaunch() {
  const input = JSON.parse(process.env.ACCEPTANCE_INPUT || '{}');
  assert(Array.isArray(input.lanes) && input.lanes.length === 2, 'two seeded lanes are required');
  const lane = input.lanes[0];
  const control = await design.createCondition(lane.userId, lane.projectId, { name: 'control' });
  const treated = await design.createCondition(lane.userId, lane.projectId, { name: 'treated' });
  const sampleSpecs = [
    [control, 'Control 1', 'C1'], [control, 'Control 2', 'C2'],
    [treated, 'Treated 1', 'T1'], [treated, 'Treated 2', 'T2'],
  ];
  for (const [condition, name, metadataValue] of sampleSpecs) {
    const sample = await design.createSample(lane.userId, lane.projectId, {
      name, conditionId: condition.id, donorCode: metadataValue,
      replicateLabel: metadataValue, organism: 'human', modality: 'scrna',
    });
    await design.bindSample(lane.userId, lane.projectId, lane.objectId, {
      sampleId: sample.id, cellMetadataColumn: 'sample_id', cellMetadataValue: metadataValue,
    });
  }
  const contrast = await design.createContrast(lane.userId, lane.projectId, {
    name: 'treated-v-control', analysisObjectId: lane.objectId,
    numeratorConditionId: treated.id, denominatorConditionId: control.id,
    unitOfReplication: 'sample', paired: false, cellTypeColumn: 'seurat_clusters',
  });
  assert(contrast.status !== 'invalid', 'replicate-aware contrast must be executable', JSON.stringify(contrast.validation));

  const specifications = [
    ['explore-overview', 'explore.summarize.v1', { recipe: 'overview' }],
    ['explore-features', 'explore.summarize.v1', {
      recipe: 'feature_by_group', features: ['IL7R', 'LST1'], groupBy: 'seurat_clusters',
    }],
    ['explore-metadata', 'explore.summarize.v1', {
      recipe: 'metadata_distribution', metadataField: 'sample_id',
    }],
    ['pseudobulk', 'condition.pseudobulk_de.v1', { contrastId: contrast.id }],
    ['enrichment', 'enrichment.gsea.v1', {
      targetGroup: '1', species: 'human', minGeneSetSize: 10, maxGeneSetSize: 500,
    }],
    ['cellchat', 'cellchat.infer.v1', {
      groupBy: 'seurat_clusters', assay: 'RNA', species: 'human',
      databaseCategory: 'all', analysisIntent: 'single_context',
      minCellsPerGroup: 5, maxCellsPerGroup: 200, maxTotalCells: 1000,
      pValueCutoff: 0.05, topInteractions: 25, topPathways: 15, randomSeed: 4100,
    }],
  ];
  const jobs = [];
  for (const [kind, jobType, parameters] of specifications) {
    const job = await db.createProjectJob(lane.userId, lane.projectId, {
      jobType, analysisObjectId: lane.objectId, parameters,
    });
    jobs.push({ id: job.id, kind, jobType, projectId: lane.projectId });
  }
  output({ jobs, contrastId: contrast.id, projectId: lane.projectId });
}

async function scientificObserve() {
  const input = JSON.parse(process.env.ACCEPTANCE_INPUT || '{}');
  assert(Array.isArray(input.jobs) && input.jobs.length === 6, 'six scientific jobs are required');
  const ids = input.jobs.map((job) => job.id);
  const deadline = Date.now() + 12 * 60 * 1000;
  let rows = [];
  while (Date.now() < deadline) {
    ({ rows } = await db.query(
      `SELECT id, status, worker_id, started_at, completed_at, last_worker_error
         FROM jobs WHERE id = ANY($1::text[]) ORDER BY created_at, id`, [ids]
    ));
    if (rows.length === ids.length && rows.every((row) => row.status === 'completed')) break;
    const failed = rows.find((row) => ['failed', 'canceled'].includes(row.status));
    if (failed) throw new Error(`scientific job ${failed.id} stopped: ${failed.last_worker_error || failed.status}`);
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  assert(rows.length === ids.length && rows.every((row) => row.status === 'completed'),
    'all scientific jobs must complete', JSON.stringify(normalizedRows(rows)));

  const { rows: artifacts } = await db.query(
    `SELECT job_id, project_id, artifact_type, storage_kind, storage_uri,
            checksum_sha256, size_bytes, metadata_json
       FROM job_artifacts WHERE job_id = ANY($1::text[]) ORDER BY job_id, artifact_type`, [ids]
  );
  const byKind = new Map(input.jobs.map((job) => [job.kind, job]));
  const artifactFor = (kind, type) => artifacts.find((artifact) => (
    artifact.job_id === byKind.get(kind).id && artifact.artifact_type === type
  ));
  const artifactMetadata = (artifact) => {
    if (!artifact) return {};
    if (typeof artifact.metadata_json === 'string') return JSON.parse(artifact.metadata_json);
    return artifact.metadata_json || {};
  };
  for (const kind of ['explore-overview', 'explore-features', 'explore-metadata']) {
    const artifact = artifactFor(kind, 'exploration_summary');
    assert(artifact && artifact.storage_kind === 'metadata_only', `${kind} must publish metadata-only aggregate output`);
    const metadata = artifactMetadata(artifact);
    assert(metadata.aggregate_only === true && metadata.summary && Array.isArray(metadata.summary.panels)
      && metadata.summary.panels.length > 0, `${kind} must contain bounded aggregate panels`);
    assert(!artifact.storage_uri && !artifact.checksum_sha256, `${kind} must not publish a private file or raw data`);
  }
  const privateTypes = [
    ['pseudobulk', 'condition_de_results'],
    ['enrichment', 'enrichment_results'],
    ['cellchat', 'cellchat_results'],
  ];
  const privateEvidence = [];
  for (const [kind, type] of privateTypes) {
    const artifact = artifactFor(kind, type);
    assert(artifact && artifact.storage_kind === 'local_internal', `${kind} must publish a private result file`);
    assert(String(artifact.storage_uri).startsWith(`projects/${input.projectId}/artifacts/`),
      `${kind} result must remain under the owning project prefix`);
    const bytes = fs.readFileSync(`/app/storage-volume/data/${artifact.storage_uri}`);
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
    assert(checksum === artifact.checksum_sha256 && bytes.length === Number(artifact.size_bytes),
      `${kind} checksum and size must match exact private bytes`);
    privateEvidence.push({ kind, checksumSha256: checksum, sizeBytes: bytes.length });
  }
  const pseudobulkSummary = artifactFor('pseudobulk', 'condition_de_summary');
  const enrichmentSummary = artifactFor('enrichment', 'enrichment_summary');
  const cellchatSummary = artifactFor('cellchat', 'cellchat_summary');
  const pseudobulkMetadata = artifactMetadata(pseudobulkSummary);
  const enrichmentMetadata = artifactMetadata(enrichmentSummary);
  const cellchatMetadata = artifactMetadata(cellchatSummary);
  assert(pseudobulkSummary && pseudobulkMetadata.summary?.testedCellTypeCount > 0,
    'pseudobulk must test at least one cell type');
  assert(pseudobulkMetadata.summary?.sampleCount === 4,
    'pseudobulk must use the four registered biological replicates');
  assert(enrichmentSummary && enrichmentMetadata.summary?.packageVersions?.clusterProfiler,
    'enrichment must record the deployment clusterProfiler version');
  assert(enrichmentMetadata.summary?.packageVersions?.fgsea,
    'enrichment must record the deployment fgsea version');
  assert(cellchatSummary && cellchatMetadata.summary?.packageVersions?.cellchat,
    'CellChat must record the deployment package version');
  assert(cellchatMetadata.summary?.analysisIntent === 'single_context'
    || cellchatMetadata.summary?.analysis_intent === 'single_context',
  'CellChat must record its single-context scientific intent');
  const cleanupEvidence = await waitForEmptyComputeState('deployment scientific jobs');
  output({
    jobs: normalizedRows(rows),
    artifactTypes: artifacts.map((row) => row.artifact_type),
    privateEvidence,
    cleanupEvidence,
  });
}

async function collaborationAcceptance() {
  const input = JSON.parse(process.env.ACCEPTANCE_INPUT || '{}');
  assert(Array.isArray(input.lanes) && input.lanes.length === 2, 'two seeded lanes are required');
  const ownerFixture = input.lanes[0];
  const analystFixture = input.lanes[1];
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const viewerPassword = `Viewer-${crypto.randomBytes(18).toString('base64url')}`;
  const outsiderPassword = `Outsider-${crypto.randomBytes(18).toString('base64url')}`;
  const viewer = await db.createUser(`collab-viewer-${stamp}@example.com`, viewerPassword, 'Collaboration viewer');
  const outsider = await db.createUser(`collab-outsider-${stamp}@example.com`, outsiderPassword, 'Collaboration outsider');
  const existingAnalystRole = await db.getProjectRole(ownerFixture.projectId, analystFixture.userId);
  if (existingAnalystRole === null) {
    await db.addProjectMemberByEmail(ownerFixture.projectId, analystFixture.email, 'analyst', 'owner');
  } else {
    assert(existingAnalystRole === 'analyst', 'the shared-project analyst role changed unexpectedly');
  }
  await db.addProjectMemberByEmail(ownerFixture.projectId, viewer.email, 'viewer', 'owner');

  const sessions = {
    owner: await login(ownerFixture.email, ownerFixture.password),
    analyst: await login(analystFixture.email, analystFixture.password),
    viewer: await login(viewer.email, viewerPassword),
    outsider: await login(outsider.email, outsiderPassword),
  };
  const projectPath = `/api/projects/${ownerFixture.projectId}`;
  const exportTableTypes = [
    'deg_markers', 'enrichment_results', 'cellchat_results', 'condition_de_results',
  ];
  const { rows: artifactRows } = await db.query(
    `SELECT DISTINCT ON (artifact_type) * FROM job_artifacts
      WHERE project_id = $1 AND created_by_user_id = $2 AND analysis_object_id = $3
        AND artifact_type = ANY($4::text[]) AND status = 'available'
      ORDER BY artifact_type, created_at DESC`,
    [ownerFixture.projectId, ownerFixture.userId, ownerFixture.objectId, exportTableTypes]
  );
  const downloadableByType = new Map(artifactRows.map((artifact) => [artifact.artifact_type, artifact]));
  assert(exportTableTypes.every((type) => downloadableByType.has(type)),
    'the collaboration session requires every real controlled-export table type',
    JSON.stringify([...downloadableByType.keys()]));
  const downloadable = downloadableByType.get('condition_de_results');
  const { rows: checkpointRows } = await db.query(
    `SELECT id FROM job_artifacts WHERE project_id = $1 AND artifact_type = 'checkpoint'
      ORDER BY created_at LIMIT 1`, [ownerFixture.projectId]
  );
  assert(checkpointRows[0], 'the collaboration session requires the source checkpoint metadata');

  const ownerBranchResponse = await http(sessions.owner, `${projectPath}/branches`, {
    method: 'POST', expected: 201,
    body: { name: 'owner/integrated-acceptance', baseAnalysisObjectId: ownerFixture.objectId },
  });
  const ownerBranch = ownerBranchResponse.data;
  const analystPrivateList = await http(sessions.analyst, `${projectPath}/branches`, { expected: 200 });
  assert(!analystPrivateList.data.some((branch) => branch.id === ownerBranch.id),
    'an unpublished owner branch leaked to an analyst');
  await http(sessions.outsider, `${projectPath}/branches`, { expected: 404 });
  await http(sessions.analyst,
    `${projectPath}/artifacts/${downloadable.id}/download`, { expected: 404, accept: '*/*' });
  await http(sessions.owner,
    `${projectPath}/artifacts/${checkpointRows[0].id}/download`, { expected: 404, accept: '*/*' });

  const published = (await http(sessions.owner,
    `${projectPath}/branches/${ownerBranch.id}/publish`, {
      method: 'POST', body: {}, expected: 200,
    })).data;
  const analystPublishedList = await http(sessions.analyst, `${projectPath}/branches`, { expected: 200 });
  assert(analystPublishedList.data.some((branch) => branch.id === ownerBranch.id),
    'an explicitly published branch was not visible to a project analyst');

  const downloadedTables = [];
  for (const artifactType of exportTableTypes) {
    const artifact = downloadableByType.get(artifactType);
    const download = await http(sessions.analyst,
      `${projectPath}/artifacts/${artifact.id}/download`, { expected: 200, accept: '*/*' });
    const downloadedSha = crypto.createHash('sha256').update(download.bytes).digest('hex');
    assert(downloadedSha === artifact.checksum_sha256
        && download.bytes.length === Number(artifact.size_bytes),
    `${artifactType} streamed bytes did not match the durable checksum and size`);
    assert(download.headers.get('content-length') === String(artifact.size_bytes),
      `${artifactType} Content-Length did not match the verified artifact size`);
    assert((download.headers.get('content-disposition') || '')
      .startsWith(`attachment; filename="${artifactType}-art_`),
    `${artifactType} filename was not server-derived from the safe artifact identity`);
    assert(download.headers.get('cache-control') === 'private, no-store',
      `${artifactType} private download must disable caching`);
    assert(!download.headers.get('content-disposition').match(/[\\/]|projects|storage/i),
      `${artifactType} download headers exposed an internal path`);
    downloadedTables.push({
      artifactType, id: artifact.id, checksumSha256: downloadedSha, sizeBytes: download.bytes.length,
    });
  }

  const firstReview = (await http(sessions.owner,
    `${projectPath}/branches/${ownerBranch.id}/reviews`, {
      method: 'POST', expected: 201,
      body: { title: 'Integrated provenance review', summary: 'Review the exact root checkpoint analysis.' },
    })).data;
  await http(sessions.viewer, `${projectPath}/reviews/${firstReview.id}/comments`, {
    method: 'POST', expected: 201, body: { body: 'The condition design and provenance are clear.' },
  });
  await http(sessions.viewer, `${projectPath}/reviews/${firstReview.id}/decision`, {
    method: 'PATCH', expected: 403, body: { status: 'approved' },
  });
  await http(sessions.owner, `${projectPath}/reviews/${firstReview.id}/decision`, {
    method: 'PATCH', expected: 200, body: { status: 'approved', note: 'Root analysis accepted.' },
  });
  const firstCanonical = (await http(sessions.owner,
    `${projectPath}/branches/${ownerBranch.id}/promote`, {
      method: 'POST', expected: 200, body: { reviewId: firstReview.id },
    })).data;
  assert(firstCanonical.analysisObjectId === ownerFixture.objectId,
    'the reviewed root was not promoted exactly');

  const childBodies = ['method-a', 'method-b'].map((label) => ({
    objectType: 'seurat', parentObjectId: ownerFixture.objectId,
    displayName: `Concurrent ${label}`,
    metadata: { acceptanceMethod: label },
  }));
  const childObjects = [];
  for (const body of childBodies) {
    childObjects.push((await http(sessions.owner, `${projectPath}/analysis-objects`, {
      method: 'POST', expected: 201, body,
    })).data);
  }
  const concurrentUpdates = await Promise.all(childObjects.map((child) => http(
    sessions.owner, `${projectPath}/branches/${ownerBranch.id}/head`, {
      method: 'PATCH', expected: [200, 409],
      body: { expectedVersion: published.version, headAnalysisObjectId: child.id },
    }
  )));
  assert(concurrentUpdates.filter((response) => response.status === 200).length === 1
      && concurrentUpdates.filter((response) => response.status === 409).length === 1,
  'two concurrent head updates did not serialize into one success and one version conflict');
  const advanced = concurrentUpdates.find((response) => response.status === 200).data;
  await http(sessions.owner, `${projectPath}/branches/${ownerBranch.id}/promote`, {
    method: 'POST', expected: 409, body: { reviewId: firstReview.id },
  });

  const currentReview = (await http(sessions.owner,
    `${projectPath}/branches/${ownerBranch.id}/reviews`, {
      method: 'POST', expected: 201,
      body: { title: 'Current-head review', summary: 'Review the winning concurrent method.' },
    })).data;
  assert(currentReview.headAnalysisObjectId === advanced.headAnalysisObjectId,
    'review did not snapshot the exact current branch head');
  await http(sessions.owner, `${projectPath}/reviews/${currentReview.id}/decision`, {
    method: 'PATCH', expected: 200, body: { status: 'approved', note: 'Current method accepted.' },
  });
  const currentCanonical = (await http(sessions.owner,
    `${projectPath}/branches/${ownerBranch.id}/promote`, {
      method: 'POST', expected: 200, body: { reviewId: currentReview.id },
    })).data;
  assert(currentCanonical.analysisObjectId === advanced.headAnalysisObjectId
      && currentCanonical.version === 2,
  'canonical promotion did not advance to the newly reviewed head');

  const analystObject = (await http(sessions.analyst, `${projectPath}/analysis-objects`, {
    method: 'POST', expected: 201,
    body: {
      objectType: 'seurat', parentObjectId: ownerFixture.objectId,
      displayName: 'Analyst alternate labels', metadata: { strategy: 'alternate-labels' },
    },
  })).data;
  const analystBranch = (await http(sessions.analyst, `${projectPath}/branches`, {
    method: 'POST', expected: 201,
    body: { name: 'analyst/alternate-labels', baseAnalysisObjectId: analystObject.id },
  })).data;
  const hiddenManifest = await http(sessions.owner,
    `${projectPath}/reproducibility-manifest?branchId=${encodeURIComponent(analystBranch.id)}`,
    { expected: 404 });
  const hiddenManifestText = hiddenManifest.bytes.toString('utf8');
  assert(!hiddenManifestText.includes('alternate-labels')
      && !hiddenManifestText.includes(analystBranch.id),
    'a private analyst branch leaked through the manifest error');
  await http(sessions.analyst, `${projectPath}/branches/${analystBranch.id}/publish`, {
    method: 'POST', expected: 200, body: {},
  });
  const comparison = await http(sessions.viewer,
    `${projectPath}/branch-comparison?leftBranchId=${encodeURIComponent(ownerBranch.id)}&rightBranchId=${encodeURIComponent(analystBranch.id)}`,
    { expected: 200 });
  assert(comparison.data.relation === 'shared_lineage'
      && !JSON.stringify(comparison.data).match(/storage|checkpoint|state.?key|ownerUserId/i),
  'published branch comparison was missing or exposed private state');

  const manifestResponse = await http(sessions.viewer,
    `${projectPath}/reproducibility-manifest?branchId=${encodeURIComponent(ownerBranch.id)}`,
    { expected: 200 });
  const manifest = manifestResponse.data;
  assert(manifest.schema === 'traceomics.reproducibility-manifest' && manifest.version === 1,
    'reproducibility manifest schema/version is invalid');
  assert(manifest.branch?.headAnalysisObjectId === advanced.headAnalysisObjectId
      && manifest.governance?.canonical?.analysisObjectId === advanced.headAnalysisObjectId,
  'manifest did not bind branch head and canonical review to the exact analysis object');
  assert(manifest.experimentalDesign?.sampleBindings?.length === 4
      && manifest.experimentalDesign?.contrasts?.length === 1,
  'manifest omitted the replicate-aware experimental design');
  assert(manifest.artifacts.some((artifact) => artifact.id === downloadable.id
      && artifact.checksumSha256 === downloadable.checksum_sha256),
  'manifest omitted the checksummed scientific artifact');
  assert(!JSON.stringify(manifest).match(/storage(_|U|u)ri|storageKey|state.?key|claimToken|workerUrl|R_API_TOKEN|script\s*:/i),
    'manifest exposed an internal storage, runtime, worker, token, or source field');
  assert((manifestResponse.headers.get('content-disposition') || '').startsWith('attachment; filename="reproducibility-ao_'),
    'manifest filename was not derived from the exported analysis object');
  assert(manifestResponse.headers.get('cache-control') === 'private, no-store',
    'reproducibility exports must disable caching');

  const badArtifactId = db.genId('art');
  await db.query(
    `INSERT INTO job_artifacts
       (id, project_id, job_id, analysis_object_id, result_analysis_object_id,
        created_by_user_id, artifact_type, name, mime_type, storage_kind, storage_uri,
        checksum_sha256, size_bytes, status, metadata_json)
     SELECT $1, project_id, job_id, analysis_object_id, result_analysis_object_id,
            created_by_user_id, artifact_type, 'Integrity rejection fixture', mime_type,
            storage_kind, storage_uri, $2, size_bytes, status, '{}'::jsonb
       FROM job_artifacts WHERE id = $3`,
    [badArtifactId, '0'.repeat(64), downloadable.id]
  );
  const integrityFailure = await http(sessions.owner,
    `${projectPath}/artifacts/${badArtifactId}/download`, { expected: 500, accept: '*/*' });
  assert(!integrityFailure.bytes.toString('utf8').match(/projects[/\\]|storage|checksum.*[0-9a-f]{64}/i),
    'integrity failure exposed a path or durable checksum');

  const auditResponse = await http(sessions.viewer, `${projectPath}/audit-events?limit=200`, { expected: 200 });
  const actions = auditResponse.data.map((event) => event.action);
  for (const action of [
    'branch.created', 'branch.advanced', 'branch.published', 'review.requested',
    'review.commented', 'review.decided', 'canonical.promoted',
    'artifact.downloaded', 'reproducibility.exported',
  ]) {
    assert(actions.includes(action), `project audit omitted ${action}`);
  }
  assert(actions.filter((action) => action === 'artifact.downloaded').length === exportTableTypes.length,
    'denied or integrity-failed downloads must not be recorded as successful downloads');
  assert(!JSON.stringify(auditResponse.data).match(/storage|state.?key|claim|worker|script|token|secret/i),
    'audit events exposed a private field');
  const auditId = auditResponse.data[0].id;
  let updateRejected = false;
  let deleteRejected = false;
  try {
    await db.query('UPDATE project_audit_events SET action = action WHERE id = $1', [auditId]);
  } catch (error) {
    updateRejected = /append-only/i.test(error.message);
  }
  try {
    await db.query('DELETE FROM project_audit_events WHERE id = $1', [auditId]);
  } catch (error) {
    deleteRejected = /append-only/i.test(error.message);
  }
  assert(updateRejected && deleteRejected, 'project audit rows were not append-only at the database boundary');

  output({
    projectId: ownerFixture.projectId,
    users: { owner: ownerFixture.userId, analyst: analystFixture.userId, viewer: viewer.id },
    branchConflict: { success: 1, conflict: 1, winningHead: advanced.headAnalysisObjectId },
    staleReviewRejected: true,
    canonicalVersion: currentCanonical.version,
    downloadedTables,
    manifest: {
      exportedAnalysisObjectId: manifest.exportedAnalysisObjectId,
      lineageObjects: manifest.lineage.objects.length,
      jobs: manifest.jobs.length,
      artifacts: manifest.artifacts.length,
      sampleBindings: manifest.experimentalDesign.sampleBindings.length,
    },
    audit: { eventCount: auditResponse.data.length, updateRejected, deleteRejected },
  });
}

async function nativeObserve() {
  const input = JSON.parse(process.env.ACCEPTANCE_INPUT || '{}');
  assert(Array.isArray(input.jobs) && input.jobs.length === 2, 'two native UI jobs are required');
  const ids = input.jobs.map(job => job.id);
  const byId = new Map(input.jobs.map(job => [job.id, job]));
  const runtimeIds = { 2: await rSessionId(8001), 3: await rSessionId(8002) };
  assert(runtimeIds[2] !== runtimeIds[3], 'native UI jobs require distinct compute R identities');
  let overlap = null;
  let rows = [];
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    ({ rows } = await db.query(
      `SELECT id, status, worker_id, started_at, completed_at, last_worker_error
         FROM jobs WHERE id = ANY($1::text[]) ORDER BY created_at, id`, [ids]
    ));
    if (!overlap && rows.length === 2 && rows.every(row => row.status === 'running')) {
      const slots = rows.map(row => Number(String(row.worker_id || '').match(/^pool-(\d+):/)?.[1]));
      assert(new Set(slots).size === 2 && slots.every(slot => slot === 2 || slot === 3),
        'native UI jobs must occupy both isolated compute slots', JSON.stringify(slots));
      // The diagnostic endpoint is single-threaded with the scientific request.
      // Each DEG route therefore snapshots its own active key in test-only state
      // before work begins; a later diagnostic read retrieves that immutable
      // in-request observation after normal cleanup has occurred.
      const samples = await Promise.all(rows.map(async (row) => {
        const job = byId.get(row.id);
        const slot = Number(String(row.worker_id).match(/^pool-(\d+):/)[1]);
        const ownKey = deriveRObjectStateKey(job.userId, `${job.objectId}-job-${job.id}`);
        const state = await rState(slot === 2 ? 8001 : 8002, ownKey);
        const observed = state.job_session_observation;
        return {
          slot,
          observedAt: typeof observed?.observed_at === 'string' ? observed.observed_at : null,
          observedHasGlobalObject: observed?.has_global_obj === true,
          observedActiveSessionKeyCount: Number(observed?.active_session_key_count || 0),
          observedOwnKeyPresent: observed?.own_key_present === true,
          observedForeignKeyCount: Number(observed?.foreign_key_count || 0),
        };
      }));
      if (samples.every(sample => sample.observedAt)) {
        const stateEvidence = Object.fromEntries(samples.map(sample => [sample.slot, sample]));
        assert(samples.every(({ observedHasGlobalObject, observedActiveSessionKeyCount,
          observedOwnKeyPresent, observedForeignKeyCount }) => (
          observedHasGlobalObject && observedActiveSessionKeyCount === 1
          && observedOwnKeyPresent && observedForeignKeyCount === 0
        )), 'each native compute lane must record only its own active job state',
        JSON.stringify(stateEvidence));
        overlap = { observedAt: new Date().toISOString(), slots, runtimeIds, stateEvidence };
      }
    }
    const failed = rows.find(row => ['failed', 'canceled'].includes(row.status));
    if (failed) throw new Error(`native UI job ${failed.id} stopped: ${failed.last_worker_error || failed.status}`);
    if (rows.length === 2 && rows.every(row => row.status === 'completed')) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert(overlap, 'two native Electron DEG jobs were not observed running concurrently', JSON.stringify({
    jobs: rows.map(row => ({
      status: row.status,
      poolSlot: Number(String(row.worker_id || '').match(/^pool-(\d+):/)?.[1]) || null,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    })),
  }));
  assert(rows.length === 2 && rows.every(row => row.status === 'completed'),
    'both native Electron DEG jobs must complete', JSON.stringify(normalizedRows(rows)));
  const latestStart = Math.max(...rows.map(row => new Date(row.started_at).getTime()));
  const earliestFinish = Math.min(...rows.map(row => new Date(row.completed_at).getTime()));
  assert(latestStart < earliestFinish, 'native Electron DEG timestamps must overlap');
  const { rows: artifacts } = await db.query(
    `SELECT job_id, project_id, artifact_type, storage_uri, checksum_sha256, size_bytes
       FROM job_artifacts WHERE job_id = ANY($1::text[]) AND artifact_type = 'deg_markers'
       ORDER BY job_id`, [ids]
  );
  assert(artifacts.length === 2, 'both native Electron jobs must publish marker artifacts');
  for (const artifact of artifacts) {
    const job = byId.get(artifact.job_id);
    assert(artifact.project_id === job.projectId
      && String(artifact.storage_uri).startsWith(`projects/${job.projectId}/`),
    'native Electron artifact escaped its private project prefix');
    const bytes = fs.readFileSync(`/app/storage-volume/data/${artifact.storage_uri}`);
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
    assert(checksum === artifact.checksum_sha256 && bytes.length === Number(artifact.size_bytes),
      'native Electron artifact integrity check failed');
  }
  const cleanupEvidence = await waitForEmptyComputeState('native Electron jobs');
  output({
    overlap,
    jobs: normalizedRows(rows),
    artifactProjects: artifacts.map(row => row.project_id),
    cleanupEvidence,
  });
}

async function main() {
  try {
    const action = process.env.ACCEPTANCE_ACTION;
    if (action === 'seed') await seed();
    else if (action === 'register-checkpoints') {
      const input = JSON.parse(process.env.ACCEPTANCE_INPUT || '{}');
      await registerCheckpoints(input);
      output({ registered: input.lanes.length });
    }
    else if (action === 'launch') await launch();
    else if (action === 'observe') await observe();
    else if (action === 'same-project-launch') await sameProjectLaunch();
    else if (action === 'same-project-observe') await sameProjectObserve();
    else if (action === 'scientific-launch') await scientificLaunch();
    else if (action === 'scientific-observe') await scientificObserve();
    else if (action === 'collaboration-acceptance') await collaborationAcceptance();
    else if (action === 'native-observe') await nativeObserve();
    else throw new Error('Unknown ACCEPTANCE_ACTION.');
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(`ACCEPTANCE_FAIL=${error.stack || error.message}`);
  process.exitCode = 1;
});
