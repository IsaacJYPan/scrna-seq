import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const config = require('./config');
const dbmod = require('./pgDatabase');

const CONFIGURED = config.hasPostgresConnection();
const T0 = '2030-01-01 00:00:00';

const {
  createUser, createOrganizationForUser, createProjectForUser,
  createProjectAnalysisObject, createProjectJob, claimNextJob, completeJobByWorker,
  completePbmcPipelineResultByWorker, cancelProjectJob, getJobArtifactsByJobId,
  completeEnrichmentGseaResultByWorker, completeCellChatInferenceResultByWorker,
} = dbmod;

// Pathway enrichment and CellChat share one completion path; exercise both kinds.
const KINDS = [
  {
    name: 'enrichment',
    jobType: 'enrichment.gsea.v1',
    parameters: { targetGroup: '0', species: 'human' },
    complete: completeEnrichmentGseaResultByWorker,
    resultsType: 'enrichment_results',
    summaryType: 'enrichment_summary',
    maxRows: 100000,
    codes: {
      exists: 'ENRICHMENT_RESULT_EXISTS',
      tooLarge: 'ENRICHMENT_RESULT_TOO_LARGE',
      rows: 'INVALID_ENRICHMENT_RESULT',
      summary: 'INVALID_ENRICHMENT_SUMMARY',
    },
  },
  {
    name: 'CellChat',
    jobType: 'cellchat.infer.v1',
    parameters: {
      groupBy: 'seurat_clusters', species: 'human', databaseCategory: 'all', analysisIntent: 'single_context',
      minCellsPerGroup: 10, maxCellsPerGroup: 1000, maxTotalCells: 10000,
    },
    complete: completeCellChatInferenceResultByWorker,
    resultsType: 'cellchat_results',
    summaryType: 'cellchat_summary',
    maxRows: require('./cellChatInference').MAX_CELLCHAT_RESULT_ROWS,
    codes: {
      exists: 'CELLCHAT_RESULT_EXISTS',
      tooLarge: 'CELLCHAT_RESULT_TOO_LARGE',
      rows: 'INVALID_CELLCHAT_RESULT',
      summary: 'INVALID_CELLCHAT_SUMMARY',
    },
  },
];

async function seedCheckpointedObject() {
  const alice = await createUser('alice@example.com', 'password123', 'Alice');
  const org = await createOrganizationForUser(alice.id, { name: 'Acme' });
  const proj = await createProjectForUser(alice.id, { organizationId: org.id, name: 'P' });
  const parent = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', displayName: 'parent' });
  const producer = await createProjectJob(alice.id, proj.id, { jobType: 'pbmc.pipeline.v1', analysisObjectId: parent.id, parameters: {} });
  const claim = await claimNextJob('seed-worker', { now: T0, leaseSeconds: 30 });
  const committed = await completePbmcPipelineResultByWorker(producer.id, 'seed-worker', claim.claimToken, {
    result: { displayName: 'clustered', metadata: {} },
    checkpointArtifact: {
      artifactType: 'checkpoint', storageKind: 'local_internal',
      internalStorageKey: `projects/${proj.id}/checkpoints/${producer.id}/checkpoint.rds`,
      checksumSha256: '8'.repeat(64), sizeBytes: 1024, metadata: {},
    },
    summaryArtifact: { artifactType: 'pipeline_summary', storageKind: 'metadata_only', metadata: {} },
  }, { now: T0 });
  await completeJobByWorker(producer.id, 'seed-worker', claim.claimToken, { now: T0, resultAnalysisObjectId: committed.resultObject.id });
  return { alice, proj, obj: committed.resultObject };
}

async function seedClaimedJob(kind) {
  const { alice, proj, obj } = await seedCheckpointedObject();
  const job = await createProjectJob(alice.id, proj.id, { jobType: kind.jobType, analysisObjectId: obj.id, parameters: kind.parameters });
  const claim = await claimNextJob('worker_A', { now: T0, leaseSeconds: 30 });
  expect(claim.id).toBe(job.id);
  return { alice, proj, job, token: claim.claimToken };
}

function validInput(kind, proj, job, { nRows = 3, sizeBytes = 100, summary = { n: 3 } } = {}) {
  return {
    resultsArtifact: {
      artifactType: kind.resultsType, storageKind: 'local_internal',
      internalStorageKey: `projects/${proj.id}/artifacts/${job.id}/results.csv`,
      checksumSha256: 'a'.repeat(64), sizeBytes, metadata: { nRows },
    },
    summaryArtifact: { artifactType: kind.summaryType, storageKind: 'metadata_only', metadata: summary },
  };
}

async function codeOf(promise) {
  try { await promise; } catch (error) { return error.code; }
  return null;
}

afterAll(async () => { if (CONFIGURED) await dbmod.close(); });

describe.skipIf(!CONFIGURED).each(KINDS)('$name worker result completion', (kind) => {
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });

  it('records exactly one results table and one summary', async () => {
    const { proj, job, token } = await seedClaimedJob(kind);
    const out = await kind.complete(job.id, 'worker_A', token, validInput(kind, proj, job), { now: T0 });
    expect(out.resultsArtifact.artifactType).toBe(kind.resultsType);
    expect(out.summaryArtifact.artifactType).toBe(kind.summaryType);
    const types = (await getJobArtifactsByJobId(job.id)).map(a => a.artifactType).sort();
    expect(types).toEqual([kind.resultsType, kind.summaryType].sort());
  });

  it('refuses a duplicate completion without adding artifacts', async () => {
    const { proj, job, token } = await seedClaimedJob(kind);
    await kind.complete(job.id, 'worker_A', token, validInput(kind, proj, job), { now: T0 });
    expect(await codeOf(kind.complete(job.id, 'worker_A', token, validInput(kind, proj, job), { now: T0 }))).toBe(kind.codes.exists);
    expect(await getJobArtifactsByJobId(job.id)).toHaveLength(2);
  });

  it('rejects the other kind\'s job type and artifact types', async () => {
    const other = KINDS.find(k => k !== kind);
    const { proj, job, token } = await seedClaimedJob(other);
    expect(await codeOf(kind.complete(job.id, 'worker_A', token, validInput(kind, proj, job), { now: T0 }))).toBe('INVALID_JOB_TYPE');

    await dbmod.resetSchemaForTests();
    const mine = await seedClaimedJob(kind);
    const wrong = validInput(kind, mine.proj, mine.job);
    wrong.resultsArtifact.artifactType = other.resultsType;
    expect(await codeOf(kind.complete(mine.job.id, 'worker_A', mine.token, wrong, { now: T0 }))).toBe('INVALID_ARTIFACT_TYPE');
  });

  it('enforces the result size, row count, and summary size limits', async () => {
    const { proj, job, token } = await seedClaimedJob(kind);
    const complete = input => codeOf(kind.complete(job.id, 'worker_A', token, input, { now: T0 }));
    expect(await complete(validInput(kind, proj, job, { sizeBytes: 50 * 1024 * 1024 + 1 }))).toBe(kind.codes.tooLarge);
    expect(await complete(validInput(kind, proj, job, { nRows: kind.maxRows + 1 }))).toBe(kind.codes.rows);
    expect(await complete(validInput(kind, proj, job, { nRows: -1 }))).toBe(kind.codes.rows);
    expect(await complete(validInput(kind, proj, job, { summary: { text: 'x'.repeat(129 * 1024) } }))).toBe(kind.codes.summary);
    expect(await getJobArtifactsByJobId(job.id)).toHaveLength(0);
  });

  it('writes nothing once the worker has lost its claim', async () => {
    const { alice, proj, job, token } = await seedClaimedJob(kind);
    await cancelProjectJob(alice.id, proj.id, job.id);
    expect(await codeOf(kind.complete(job.id, 'worker_A', token, validInput(kind, proj, job), { now: T0 }))).toBe('CLAIM_LOST');
    expect(await getJobArtifactsByJobId(job.id)).toHaveLength(0);
  });
});
