import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./config');
const db = require('./pgDatabase');
const { createJobWorker } = require('./jobWorker');
const { allocateCheckpointStorageKey } = require('./pbmcPipeline');
const { deriveRObjectStateKey } = require('./rStateKeys');
const rBridge = require('./rWorkerBridge');
const storage = require('./storage');

const CONFIGURED = config.hasPostgresConnection();
const T0 = '2030-01-01 00:00:00';
const T0_PLUS_10 = '2030-01-01 00:00:10';
const LATER = '2030-01-01 01:00:00';
const MUCH_LATER = '2030-01-01 02:00:00';
const RECEIPT_SECRET = 'focused-receipt-test-secret';
const tempStorageRoots = [];

function silentLogger() { return { info() {}, warn() {}, error() {} }; }
function verifiedStorage() {
  return {
    inspect: () => ({ ok: true }),
    remove: () => true,
  };
}

function temporaryStorageProvider() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-receipts-'));
  tempStorageRoots.push(root);
  return storage.createLocalStorageProvider({ root });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function pipelineReceiptPayload({ checksumSha256, sizeBytes, seurat = false }) {
  return {
    ok: true,
    summary: {
      n_cells: 12,
      n_features: 34,
      n_variable_features: 20,
      n_pcs: 5,
      n_clusters: 2,
      cluster_sizes: [6, 6],
      reductions: ['pca', 'umap'],
      normalization_method: 'LogNormalize',
      resolution: 0.8,
      used_seed: 42,
    },
    ...(seurat ? { warnings: [] } : {}),
    checkpoint: {
      saved: true,
      checksum_sha256: checksumSha256,
      size_bytes: sizeBytes,
    },
    versions: { seurat_version: '5.0.1', r_version: '4.5.3' },
  };
}

function degReceiptPayload({ checksumSha256, sizeBytes }) {
  return {
    ok: true,
    summary: {
      group_by: 'seurat_clusters',
      test_use: 'wilcox',
      assay: 'RNA',
      n_groups: 2,
      groups: ['0', '1'],
      n_markers_total: 2,
      markers_per_group: [{ group: '0', n: 1 }, { group: '1', n: 1 }],
      top_markers: [],
    },
    result: {
      saved: true,
      checksum_sha256: checksumSha256,
      size_bytes: sizeBytes,
      n_rows: 2,
    },
    versions: { seurat_version: '5.0.1', r_version: '4.5.3' },
  };
}

function enrichmentReceiptPayload({ checksumSha256, sizeBytes }) {
  return {
    ok: true,
    summary: {
      method: 'gsea',
      comparison: { target_group: '0', reference: 'rest' },
      group_by: 'seurat_clusters',
      assay: 'RNA',
      species: 'human',
      gene_set_collection: 'GO_BP',
      rank_metric: 'avg_log2FC',
      input_gene_count: 100,
      mapped_gene_count: 90,
      mapping_rate: 0.9,
      tested_pathway_count: 1,
      significant_pathway_count: 1,
      package_versions: {
        r: '4.5.3', seurat: '5.3.1',
        annotation_dbi: '1.72.0', go_db: '3.22.0',
        cluster_profiler: '4.16.0',
        fgsea: '1.34.0', organism_db: 'org.Hs.eg.db 3.21.0',
      },
      top_pathways: [{
        pathway_id: 'GO:0006955', pathway_name: 'immune response',
        normalized_enrichment_score: 2.1, p_value: 0.001,
        adjusted_p_value: 0.01, set_size: 25, significant: true, direction: 'positive',
      }],
      warnings: [],
    },
    result: {
      saved: true,
      checksum_sha256: checksumSha256,
      size_bytes: sizeBytes,
      n_rows: 1,
    },
  };
}

function cellChatReceiptPayload({ checksumSha256, sizeBytes }) {
  return {
    ok: true,
    summary: {
      method: 'CellChat',
      analysis_intent: 'single_context',
      group_by: 'seurat_clusters',
      assay: 'RNA',
      species: 'human',
      database_category: 'all',
      p_value_cutoff: 0.05,
      input_cell_count: 120,
      analyzed_cell_count: 100,
      input_group_count: 2,
      analyzed_group_count: 2,
      excluded_group_count: 0,
      candidate_interaction_count: 1,
      retained_interaction_count: 1,
      retained_pathway_count: 1,
      groups: [
        { group: 'Group 1', input_cells: 50, analyzed_cells: 50 },
        { group: 'Group 2', input_cells: 50, analyzed_cells: 50 },
      ],
      excluded_groups: [],
      package_versions: {
        r: '4.5.3', seurat: '5.3.1', cellchat: '2.1.2', cellchat_db: 'CellChatDB.human',
      },
      top_interactions: [{
        source: 'Group 1', target: 'Group 2', interaction: 'TGFB1.TGFBR1_TGFBR2',
        pathway: 'TGFb', probability: 0.42, p_value: 0.001, category: 'secreted_signaling',
      }],
      top_pathways: [{
        source: 'Group 1', target: 'Group 2', pathway: 'TGFb', probability: 0.42, p_value: 0.001,
      }],
      warnings: [],
    },
    result: {
      saved: true,
      checksum_sha256: checksumSha256,
      size_bytes: sizeBytes,
      n_rows: 1,
    },
  };
}

function loadReceiptPayload(runtimeInstanceId) {
  return {
    loaded: true,
    runtime_instance_id: runtimeInstanceId,
    checksum_verified: true,
    class: 'Seurat',
    n_cells: 12,
    n_features: 34,
    assays: ['RNA'],
    reductions: ['pca', 'umap'],
    n_meta_fields: 1,
    meta_fields: ['seurat_clusters'],
    seurat_version: '5.0.1',
    r_version: '4.5.3',
  };
}

function signedReceiptCaller(provider, payloadForRequest, afterReceipt) {
  let calls = 0;
  const callR = async (request) => {
    calls += 1;
    const binding = request.body && request.body.completion_receipt;
    if (!binding) throw new Error('missing completion receipt binding');
    let output = null;
    if (binding.output_storage_key) {
      output = Buffer.from(`durable-output-for-${binding.job_id}`, 'utf8');
      fs.writeFileSync(provider.prepareWrite(binding.output_storage_key), output);
    }
    const payload = payloadForRequest(request, output);
    const envelope = rBridge.createCompletionReceiptEnvelope(
      { ...binding, payload }, RECEIPT_SECRET
    );
    fs.writeFileSync(
      provider.prepareWrite(binding.receipt_storage_key),
      JSON.stringify(envelope),
      'utf8'
    );
    return afterReceipt(request, payload);
  };
  Object.defineProperty(callR, 'verifyCompletionReceipt', {
    value: (envelope) => rBridge.verifyCompletionReceiptEnvelope(envelope, RECEIPT_SECRET),
  });
  return { callR, getCalls: () => calls };
}

function timeoutAfterSignedReceipt(provider, payloadForRequest) {
  return signedReceiptCaller(provider, payloadForRequest, () => {
    throw Object.assign(new Error('R response transport became indeterminate'), {
      code: 'R_TIMEOUT',
    });
  });
}

async function seedProject(email) {
  const user = await db.createUser(email, 'password123', email.split('@')[0]);
  const org = await db.createOrganizationForUser(user.id, { name: 'Recovery org' });
  const project = await db.createProjectForUser(user.id, { organizationId: org.id, name: 'Recovery project' });
  return { user, project };
}

async function seedCheckpoint(user, project, suffix) {
  const source = await db.createProjectAnalysisObject(user.id, project.id, { objectType: 'seurat' });
  const producer = await db.createProjectJob(user.id, project.id, {
    jobType: 'pbmc.pipeline.v1', analysisObjectId: source.id, parameters: {},
  });
  const claim = await db.claimNextJob(`worker-checkpoint-seed-${suffix}`, {
    now: T0, leaseSeconds: 30,
  });
  const committed = await db.completePbmcPipelineResultByWorker(
    producer.id,
    `worker-checkpoint-seed-${suffix}`,
    claim.claimToken,
    {
      result: { displayName: 'Checkpoint source result', metadata: {} },
      checkpointArtifact: {
        artifactType: 'checkpoint', storageKind: 'local_internal',
        internalStorageKey: `projects/${project.id}/checkpoints/${producer.id}/checkpoint.rds`,
        checksumSha256: '8'.repeat(64), sizeBytes: 88, metadata: {},
      },
      summaryArtifact: {
        artifactType: 'pipeline_summary', storageKind: 'metadata_only', metadata: {},
      },
    },
    { now: T0_PLUS_10 }
  );
  await db.completeJobByWorker(
    producer.id,
    `worker-checkpoint-seed-${suffix}`,
    claim.claimToken,
    { now: T0_PLUS_10, resultAnalysisObjectId: committed.resultObject.id }
  );
  return committed;
}

async function seedSeuratPipelineJob(user, project, { spatial = false } = {}) {
  const fileType = spatial ? 'visium_zip' : 'tenx_h5';
  const filename = spatial ? 'input.zip' : 'input.h5';
  const dataset = await db.createDatasetForProject(user.id, project.id, {
    fileType,
    originalFilename: filename,
  });
  const uploaded = await db.markDatasetUploaded(project.id, dataset.id, {
    internalStorageKey: `projects/${project.id}/datasets/${dataset.id}/${filename}`,
    sha256: 'b'.repeat(64),
    fileSizeBytes: 123,
  });
  if (spatial) await db.setDatasetValidationResult(project.id, dataset.id, 'valid');
  const inputObject = await db.createProjectAnalysisObject(user.id, project.id, {
    objectType: 'matrix',
    datasetId: uploaded.id,
    metadata: { source: 'dataset', fileType },
  });
  const job = await db.createProjectJob(user.id, project.id, {
    jobType: spatial ? 'spatial.seurat.v1' : 'seurat.pipeline.v1',
    datasetId: uploaded.id,
    analysisObjectId: inputObject.id,
    parameters: {},
  });
  return { job, dataset: uploaded, inputObject };
}

beforeEach(async () => {
  if (!CONFIGURED) return;
  await db.resetSchemaForTests();
});

afterEach(() => {
  while (tempStorageRoots.length) {
    const root = tempStorageRoots.pop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

afterAll(async () => {
  if (CONFIGURED) await db.close();
});

describe.skipIf(!CONFIGURED)('durable output crash-window recovery', () => {
  it.each(['demoted', 'removed'])(
    'uses a signed receipt for an ordinary retry after its creator is %s and never reruns R',
    async (membershipChange) => {
      const { user, project } = await seedProject(`ordinary-retry-${membershipChange}@example.com`);
      const successor = await db.createUser(
        `ordinary-retry-successor-${membershipChange}@example.com`,
        'password123',
        'Successor'
      );
      await db.addProjectMemberByEmail(
        project.id,
        successor.email,
        'owner',
        { userId: user.id }
      );
      const source = await db.createProjectAnalysisObject(user.id, project.id, {
        objectType: 'seurat',
      });
      const job = await db.createProjectJob(user.id, project.id, {
        jobType: 'pbmc.pipeline.v1',
        analysisObjectId: source.id,
        parameters: {},
      });
      const crashedWorkerId = `worker-ordinary-retry-${membershipChange}`;
      const claim = await db.claimNextJob(crashedWorkerId, { now: T0, leaseSeconds: 30 });

      const provider = temporaryStorageProvider();
      const outputStorageKey = allocateCheckpointStorageKey(project.id, job.id);
      const output = Buffer.from(`ordinary-retry-output-${membershipChange}`, 'utf8');
      fs.writeFileSync(provider.prepareWrite(outputStorageKey), output);
      const binding = rBridge.buildCompletionReceiptBinding(
        claim,
        'r.pbmc.pipeline.v1',
        {
          objectContext: { objectId: source.id },
          pipeline: { checkpointStorageKey: outputStorageKey },
        }
      );
      fs.writeFileSync(
        provider.prepareWrite(binding.receipt_storage_key),
        JSON.stringify(rBridge.createCompletionReceiptEnvelope({
          ...binding,
          payload: pipelineReceiptPayload({
            checksumSha256: sha256(output),
            sizeBytes: output.length,
          }),
        }, RECEIPT_SECRET)),
        'utf8'
      );

      if (membershipChange === 'removed') {
        await db.removeProjectMember(project.id, user.id, { userId: successor.id });
      } else {
        await db.updateProjectMemberRole(
          project.id,
          user.id,
          'viewer',
          { userId: successor.id }
        );
      }

      let rCalls = 0;
      const replacementCallR = async () => {
        rCalls += 1;
        throw new Error('R must not be called during recovery-only admission');
      };
      Object.defineProperty(replacementCallR, 'verifyCompletionReceipt', {
        value: (envelope) => rBridge.verifyCompletionReceiptEnvelope(envelope, RECEIPT_SECRET),
      });
      const worker = createJobWorker({
        db,
        workerId: `worker-ordinary-recovery-${membershipChange}`,
        now: () => LATER,
        callR: replacementCallR,
        deriveRObjectStateKey,
        storageProvider: provider,
        logger: silentLogger(),
      });

      await expect(worker.runOnce()).resolves.toMatchObject({
        status: 'completed',
        jobId: job.id,
      });
      expect(rCalls).toBe(0);
      expect((await db.getProjectJob(successor.id, project.id, job.id)).status).toBe('completed');
    }
  );

  it('finalizes committed output after creator removal without canceling history or rerunning R', async () => {
    const { user, project } = await seedProject('removed-creator-recovery@example.com');
    const successor = await db.createUser('recovery-successor@example.com', 'password123', 'Successor');
    await db.addProjectMemberByEmail(
      project.id, successor.email, 'owner', { userId: user.id }
    );
    const source = await db.createProjectAnalysisObject(user.id, project.id, { objectType: 'seurat' });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1', analysisObjectId: source.id, parameters: {},
    });
    const claim = await db.claimNextJob('worker-output-before-removal', {
      now: T0, leaseSeconds: 30,
    });
    await db.completePbmcPipelineResultByWorker(
      job.id,
      'worker-output-before-removal',
      claim.claimToken,
      {
        result: { displayName: 'Preserved result', metadata: {} },
        checkpointArtifact: {
          artifactType: 'checkpoint', storageKind: 'local_internal',
          internalStorageKey: `projects/${project.id}/checkpoints/${job.id}/checkpoint.rds`,
          checksumSha256: '7'.repeat(64), sizeBytes: 77, metadata: {},
        },
        summaryArtifact: {
          artifactType: 'pipeline_summary', storageKind: 'metadata_only', metadata: {},
        },
      },
      { now: T0_PLUS_10 }
    );
    await db.updateProjectMemberRole(project.id, user.id, 'viewer', { userId: successor.id });

    let rCalls = 0;
    const worker = createJobWorker({
      db,
      workerId: 'worker-recover-removed-creator',
      now: () => LATER,
      callR: async () => { rCalls += 1; throw new Error('R must not be called'); },
      deriveRObjectStateKey,
      storageProvider: verifiedStorage(),
      logger: silentLogger(),
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'completed', recovered: true, jobId: job.id,
    });
    expect(rCalls).toBe(0);
    expect((await db.getWorkerJob(job.id)).status).toBe('completed');
  });

  it('grants one recovery-only claim when output commits on the final execution attempt', async () => {
    const { user, project } = await seedProject('final-attempt-recovery@example.com');
    const source = await db.createProjectAnalysisObject(user.id, project.id, { objectType: 'seurat' });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1', analysisObjectId: source.id, parameters: {},
    });
    await db.setJobScheduling(job.id, { maxAttempts: 1 });
    const claim = await db.claimNextJob('worker-final-output-attempt', {
      now: T0, leaseSeconds: 30,
    });
    await db.completePbmcPipelineResultByWorker(
      job.id,
      'worker-final-output-attempt',
      claim.claimToken,
      {
        result: { displayName: 'Final-attempt result', metadata: {} },
        checkpointArtifact: {
          artifactType: 'checkpoint', storageKind: 'local_internal',
          internalStorageKey: `projects/${project.id}/checkpoints/${job.id}/checkpoint.rds`,
          checksumSha256: '6'.repeat(64), sizeBytes: 66, metadata: {},
        },
        summaryArtifact: {
          artifactType: 'pipeline_summary', storageKind: 'metadata_only', metadata: {},
        },
      },
      { now: T0_PLUS_10 }
    );

    let rCalls = 0;
    const worker = createJobWorker({
      db,
      workerId: 'worker-final-output-recovery',
      now: () => LATER,
      callR: async () => { rCalls += 1; throw new Error('R must not be called'); },
      deriveRObjectStateKey,
      storageProvider: verifiedStorage(),
      logger: silentLogger(),
    });
    await expect(worker.runOnce()).resolves.toMatchObject({ status: 'completed', recovered: true });
    const after = await db.getWorkerJob(job.id);
    expect(after.status).toBe('completed');
    expect(after.attempts).toBe(1);
    expect(rCalls).toBe(0);
  });

  it('resumes an already-committed PBMC output set without rerunning R', async () => {
    const { user, project } = await seedProject('pbmc-recovery@example.com');
    const source = await db.createProjectAnalysisObject(user.id, project.id, { objectType: 'seurat' });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1', analysisObjectId: source.id, parameters: {},
    });
    const firstClaim = await db.claimNextJob('worker-crashed-after-pbmc-output', {
      now: T0, leaseSeconds: 30,
    });
    const committed = await db.completePbmcPipelineResultByWorker(
      job.id,
      'worker-crashed-after-pbmc-output',
      firstClaim.claimToken,
      {
        result: { displayName: 'Recovered PBMC result', metadata: { source: 'test' } },
        checkpointArtifact: {
          artifactType: 'checkpoint', storageKind: 'local_internal',
          internalStorageKey: `projects/${project.id}/checkpoints/${job.id}/checkpoint.rds`,
          checksumSha256: '9'.repeat(64), sizeBytes: 321, metadata: {},
        },
        summaryArtifact: {
          artifactType: 'pipeline_summary', storageKind: 'metadata_only', metadata: {},
        },
      },
      { now: T0_PLUS_10 }
    );

    let rCalls = 0;
    const worker = createJobWorker({
      db,
      workerId: 'worker-pbmc-recovery',
      now: () => LATER,
      callR: async () => { rCalls += 1; throw new Error('R must not be called'); },
      deriveRObjectStateKey,
      storageProvider: verifiedStorage(),
      logger: silentLogger(),
    });
    await expect(worker.runOnce()).resolves.toMatchObject({ status: 'completed', recovered: true });
    expect(rCalls).toBe(0);
    expect((await db.getWorkerJob(job.id)).resultAnalysisObjectId).toBe(committed.resultObject.id);
  });

  it('recovers checkpoint load only while the same immutable R runtime instance is alive', async () => {
    const { user, project } = await seedProject('checkpoint-load-recovery@example.com');
    const source = await seedCheckpoint(user, project, 'load');
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'checkpoint.load.v1', analysisObjectId: source.resultObject.id, parameters: {},
    });
    const firstClaim = await db.claimNextJob('worker-crashed-after-load-output', {
      now: T0, leaseSeconds: 30,
    });
    const runtimeHash = 'e'.repeat(64);
    await db.createJobArtifactByWorker(
      job.id,
      'worker-crashed-after-load-output',
      firstClaim.claimToken,
      {
        artifactType: 'checkpoint_load', storageKind: 'metadata_only',
        metadata: { loaded: { runtimeInstanceHash: runtimeHash } },
      },
      { now: T0_PLUS_10 }
    );

    let rCalls = 0;
    const worker = createJobWorker({
      db,
      workerId: 'worker-load-recovery',
      now: () => LATER,
      claimGate: async () => ({ ready: true, rRuntimeInstanceHash: runtimeHash }),
      callR: async () => { rCalls += 1; throw new Error('R must not be called'); },
      deriveRObjectStateKey,
      storageProvider: verifiedStorage(),
      logger: silentLogger(),
    });
    await expect(worker.runOnce()).resolves.toMatchObject({ status: 'completed', recovered: true });
    expect(rCalls).toBe(0);
  });

  it('fails checkpoint-load recovery when R restarted instead of claiming live state exists', async () => {
    const { user, project } = await seedProject('checkpoint-load-r-restart@example.com');
    const source = await seedCheckpoint(user, project, 'restart');
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'checkpoint.load.v1', analysisObjectId: source.resultObject.id, parameters: {},
    });
    const firstClaim = await db.claimNextJob('worker-crashed-before-r-restart', {
      now: T0, leaseSeconds: 30,
    });
    await db.createJobArtifactByWorker(
      job.id,
      'worker-crashed-before-r-restart',
      firstClaim.claimToken,
      {
        artifactType: 'checkpoint_load', storageKind: 'metadata_only',
        metadata: { loaded: { runtimeInstanceHash: 'a'.repeat(64) } },
      },
      { now: T0_PLUS_10 }
    );

    const worker = createJobWorker({
      db,
      workerId: 'worker-after-r-restart',
      now: () => LATER,
      claimGate: async () => ({ ready: true, rRuntimeInstanceHash: 'b'.repeat(64) }),
      callR: async () => { throw new Error('R must not be called'); },
      deriveRObjectStateKey,
      storageProvider: verifiedStorage(),
      logger: silentLogger(),
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'failed', error: { code: 'LIVE_R_STATE_LOST' },
    });
    expect((await db.getProjectJob(user.id, project.id, job.id)).error.code).toBe('LIVE_R_STATE_LOST');
  });

  it('recovers a committed checkpoint fork only in the same R runtime instance', async () => {
    const { user, project } = await seedProject('checkpoint-fork-recovery@example.com');
    const source = await seedCheckpoint(user, project, 'fork');
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'checkpoint.fork.v1', analysisObjectId: source.resultObject.id, parameters: {},
    });
    const firstClaim = await db.claimNextJob('worker-crashed-after-fork-output', {
      now: T0, leaseSeconds: 30,
    });
    const runtimeHash = 'f'.repeat(64);
    const resultId = db.generateAnalysisObjectId();
    await db.completeCheckpointForkByWorker(
      job.id,
      'worker-crashed-after-fork-output',
      firstClaim.claimToken,
      {
        resultAnalysisObjectId: resultId,
        checkpointArtifactId: source.checkpointArtifact.id,
        loaded: { loaded: true, runtimeInstanceHash: runtimeHash },
      },
      { now: T0_PLUS_10 }
    );

    const worker = createJobWorker({
      db,
      workerId: 'worker-fork-recovery',
      now: () => LATER,
      claimGate: async () => ({ ready: true, rRuntimeInstanceHash: runtimeHash }),
      callR: async () => { throw new Error('R must not be called'); },
      deriveRObjectStateKey,
      storageProvider: verifiedStorage(),
      logger: silentLogger(),
    });
    await expect(worker.runOnce()).resolves.toMatchObject({ status: 'completed', recovered: true });
    expect((await db.getWorkerJob(job.id)).resultAnalysisObjectId).toBe(resultId);
  });

  it('resumes an already-committed Seurat output set without a second R call or duplicate lineage', async () => {
    const { user, project } = await seedProject('seurat-recovery@example.com');
    const dataset = await db.createDatasetForProject(user.id, project.id, {
      fileType: 'tenx_h5', originalFilename: 'sample.h5',
    });
    await db.markDatasetUploaded(project.id, dataset.id, {
      internalStorageKey: `projects/${project.id}/datasets/${dataset.id}/sample.h5`,
      sha256: 'a'.repeat(64), fileSizeBytes: 100,
    });
    const source = await db.createProjectAnalysisObject(user.id, project.id, {
      objectType: 'matrix', datasetId: dataset.id,
    });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'seurat.pipeline.v1', datasetId: dataset.id,
      analysisObjectId: source.id, parameters: {},
    });
    const firstClaim = await db.claimNextJob('worker-crashed-after-seurat-output', {
      now: T0, leaseSeconds: 30,
    });
    const committed = await db.completeSeuratPipelineResultByWorker(
      job.id,
      'worker-crashed-after-seurat-output',
      firstClaim.claimToken,
      {
        result: { displayName: 'Recovered Seurat result', metadata: { source: 'test' } },
        checkpointArtifact: {
          artifactType: 'checkpoint', storageKind: 'local_internal',
          internalStorageKey: `projects/${project.id}/checkpoints/${job.id}/checkpoint.rds`,
          checksumSha256: 'b'.repeat(64), sizeBytes: 123,
          metadata: { scientific_output: true },
        },
        summaryArtifact: {
          artifactType: 'pipeline_summary', storageKind: 'metadata_only',
          metadata: { scientific_output: true },
        },
      },
      { now: T0_PLUS_10 }
    );
    expect((await db.getWorkerJob(job.id)).status).toBe('running');

    let rCalls = 0;
    const worker = createJobWorker({
      db,
      workerId: 'worker-seurat-recovery',
      now: () => LATER,
      callR: async () => { rCalls += 1; throw new Error('R must not be called'); },
      deriveRObjectStateKey,
      storageProvider: verifiedStorage(),
      logger: silentLogger(),
    });
    const result = await worker.runOnce();
    expect(result).toMatchObject({ status: 'completed', recovered: true, jobId: job.id });
    expect(rCalls).toBe(0);

    const after = await db.getWorkerJob(job.id);
    expect(after.status).toBe('completed');
    expect(after.attempts).toBe(2);
    expect(after.resultAnalysisObjectId).toBe(committed.resultObject.id);
    const artifacts = await db.getJobArtifactsByJobId(job.id);
    expect(artifacts.map((artifact) => artifact.artifactType).sort()).toEqual(['checkpoint', 'pipeline_summary']);
    const parents = await db.listProjectAnalysisObjectParents(user.id, project.id, committed.resultObject.id);
    expect(parents).toHaveLength(1);
    expect(parents[0].jobId).toBe(job.id);
  });

  it('resumes an already-committed DEG artifact pair exactly once', async () => {
    const { user, project } = await seedProject('deg-recovery@example.com');
    const object = await db.createProjectAnalysisObject(user.id, project.id, { objectType: 'seurat' });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'deg.find_markers.v1', analysisObjectId: object.id, parameters: {},
    });
    const firstClaim = await db.claimNextJob('worker-crashed-after-deg-output', {
      now: T0, leaseSeconds: 30,
    });
    await db.completeDegFindMarkersResultByWorker(
      job.id,
      'worker-crashed-after-deg-output',
      firstClaim.claimToken,
      {
        markersArtifact: {
          artifactType: 'deg_markers', storageKind: 'local_internal',
          internalStorageKey: `projects/${project.id}/artifacts/${job.id}/markers.csv`,
          checksumSha256: 'c'.repeat(64), sizeBytes: 456, metadata: {},
        },
        summaryArtifact: {
          artifactType: 'deg_summary', storageKind: 'metadata_only', metadata: {},
        },
      },
      { now: T0_PLUS_10 }
    );

    let rCalls = 0;
    const worker = createJobWorker({
      db,
      workerId: 'worker-deg-recovery',
      now: () => LATER,
      callR: async () => { rCalls += 1; throw new Error('R must not be called'); },
      deriveRObjectStateKey,
      storageProvider: verifiedStorage(),
      logger: silentLogger(),
    });
    await expect(worker.runOnce()).resolves.toMatchObject({ status: 'completed', recovered: true });
    expect(rCalls).toBe(0);
    expect((await db.getWorkerJob(job.id)).attempts).toBe(2);
    expect((await db.getJobArtifactsByJobId(job.id)).map((artifact) => artifact.artifactType).sort())
      .toEqual(['deg_markers', 'deg_summary']);
  });

  it('fails closed when committed output bytes are missing or fail integrity verification', async () => {
    const { user, project } = await seedProject('missing-output-recovery@example.com');
    const object = await db.createProjectAnalysisObject(user.id, project.id, { objectType: 'seurat' });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'deg.find_markers.v1', analysisObjectId: object.id, parameters: {},
    });
    const firstClaim = await db.claimNextJob('worker-missing-output', { now: T0, leaseSeconds: 30 });
    await db.completeDegFindMarkersResultByWorker(
      job.id,
      'worker-missing-output',
      firstClaim.claimToken,
      {
        markersArtifact: {
          artifactType: 'deg_markers', storageKind: 'local_internal',
          internalStorageKey: `projects/${project.id}/artifacts/${job.id}/markers.csv`,
          checksumSha256: 'd'.repeat(64), sizeBytes: 99, metadata: {},
        },
        summaryArtifact: { artifactType: 'deg_summary', storageKind: 'metadata_only', metadata: {} },
      },
      { now: T0_PLUS_10 }
    );

    let rCalls = 0;
    const worker = createJobWorker({
      db,
      workerId: 'worker-missing-output-recovery',
      now: () => LATER,
      callR: async () => { rCalls += 1; return { status: 200, body: {} }; },
      deriveRObjectStateKey,
      storageProvider: {
        inspect: () => { throw new Error('missing'); },
        remove: () => true,
      },
      logger: silentLogger(),
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'failed', error: { code: 'COMMITTED_OUTPUT_INVALID' },
    });
    expect(rCalls).toBe(0);
    expect((await db.getProjectJob(user.id, project.id, job.id)).error.code)
      .toBe('COMMITTED_OUTPUT_INVALID');
  });

  it('fails closed on a partial prior output instead of rerunning R or publishing completion', async () => {
    const { user, project } = await seedProject('partial-recovery@example.com');
    const object = await db.createProjectAnalysisObject(user.id, project.id, { objectType: 'seurat' });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'deg.find_markers.v1', analysisObjectId: object.id, parameters: {},
    });
    const firstClaim = await db.claimNextJob('worker-partial-output', { now: T0, leaseSeconds: 30 });
    await db.createJobArtifactByWorker(
      job.id,
      'worker-partial-output',
      firstClaim.claimToken,
      { artifactType: 'deg_summary', storageKind: 'metadata_only', metadata: {} },
      { now: T0_PLUS_10 }
    );

    let rCalls = 0;
    const worker = createJobWorker({
      db,
      workerId: 'worker-partial-recovery',
      now: () => LATER,
      callR: async () => { rCalls += 1; return { status: 200, body: {} }; },
      deriveRObjectStateKey,
      storageProvider: verifiedStorage(),
      logger: silentLogger(),
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'failed', error: { code: 'INCOMPLETE_COMMITTED_OUTPUT' },
    });
    expect(rCalls).toBe(0);
    const after = await db.getProjectJob(user.id, project.id, job.id);
    expect(after.status).toBe('failed');
    expect(after.error.code).toBe('INCOMPLETE_COMMITTED_OUTPUT');
  });

  it.each([
    'pbmc.pipeline.v1',
    'seurat.pipeline.v1',
    'spatial.seurat.v1',
    'deg.find_markers.v1',
    'enrichment.gsea.v1',
    'cellchat.infer.v1',
    'checkpoint.load.v1',
    'checkpoint.fork.v1',
  ])('adopts a signed %s R completion receipt after timeout without a second R call', async (jobType) => {
    const emailLabel = jobType.replace(/[^a-z]/g, '-');
    const { user, project } = await seedProject(`receipt-${emailLabel}@example.com`);
    let job;
    if (jobType === 'seurat.pipeline.v1' || jobType === 'spatial.seurat.v1') {
      ({ job } = await seedSeuratPipelineJob(user, project, {
        spatial: jobType === 'spatial.seurat.v1',
      }));
    } else if (jobType === 'checkpoint.load.v1' || jobType === 'checkpoint.fork.v1') {
      const source = await seedCheckpoint(user, project, `receipt-${emailLabel}`);
      job = await db.createProjectJob(user.id, project.id, {
        jobType,
        analysisObjectId: source.resultObject.id,
        parameters: {},
      });
    } else {
      const checkpointBacked = [
        'deg.find_markers.v1', 'enrichment.gsea.v1', 'cellchat.infer.v1',
      ].includes(jobType);
      const source = checkpointBacked
        ? (await seedCheckpoint(user, project, `receipt-source-${emailLabel}`)).resultObject
        : await db.createProjectAnalysisObject(user.id, project.id, { objectType: 'seurat' });
      job = await db.createProjectJob(user.id, project.id, {
        jobType,
        analysisObjectId: source.id,
        parameters: jobType === 'enrichment.gsea.v1'
          ? { targetGroup: '0', species: 'human' }
          : (jobType === 'cellchat.infer.v1'
            ? {
              groupBy: 'seurat_clusters', species: 'human', databaseCategory: 'all',
              analysisIntent: 'single_context', minCellsPerGroup: 10,
              maxCellsPerGroup: 1000, maxTotalCells: 10000,
            }
            : {}),
      });
    }

    const provider = temporaryStorageProvider();
    const runtimeInstanceId = 'receipt-runtime-instance-0001';
    const runtimeInstanceHash = sha256(runtimeInstanceId);
    const fake = timeoutAfterSignedReceipt(provider, (_request, output) => {
      if (jobType === 'checkpoint.load.v1' || jobType === 'checkpoint.fork.v1') {
        return loadReceiptPayload(runtimeInstanceId);
      }
      const integrity = {
        checksumSha256: sha256(output),
        sizeBytes: output.length,
      };
      if (jobType === 'deg.find_markers.v1') return degReceiptPayload(integrity);
      if (jobType === 'enrichment.gsea.v1') return enrichmentReceiptPayload(integrity);
      if (jobType === 'cellchat.infer.v1') return cellChatReceiptPayload(integrity);
      return pipelineReceiptPayload({
        ...integrity,
        seurat: jobType === 'seurat.pipeline.v1' || jobType === 'spatial.seurat.v1',
      });
    });
    const callR = async (request) => {
      // Checkpoint-backed downstream jobs now perform a trusted hydration call
      // before their receipt-backed scientific operation. Hydration has no
      // completion receipt because it creates only job-scoped transient state.
      if (!request.body?.completion_receipt) {
        return { status: 200, body: loadReceiptPayload(runtimeInstanceId) };
      }
      return fake.callR(request);
    };
    Object.defineProperty(callR, 'verifyCompletionReceipt', {
      value: fake.callR.verifyCompletionReceipt,
    });
    let now = T0;
    const worker = createJobWorker({
      db,
      workerId: `worker-receipt-${emailLabel}`,
      now: () => now,
      claimGate: async () => ({
        ready: true,
        rRuntimeInstanceHash: runtimeInstanceHash,
        // Receipt recovery exercises a worker that reached the scientific R
        // operation. Enrichment now requires that capability to be explicit.
        capabilities: { pathwayEnrichment: true },
      }),
      callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'indeterminate',
      error: { code: db.R_TIMEOUT_INDETERMINATE },
    });
    expect(fake.getCalls()).toBe(1);
    expect(fs.existsSync(provider.resolveKey(
      storage.completionReceiptKey(project.id, job.id)
    ))).toBe(true);

    now = LATER;
    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'completed',
      jobId: job.id,
    });
    expect(fake.getCalls()).toBe(1);
    expect((await db.getWorkerJob(job.id)).status).toBe('completed');
    expect(fs.existsSync(provider.resolveKey(
      storage.completionReceiptKey(project.id, job.id)
    ))).toBe(false);
  });

  it('recovers file output when DB publication commits and then throws without rerunning R', async () => {
    const { user, project } = await seedProject('file-publisher-commit-then-throw@example.com');
    const source = await db.createProjectAnalysisObject(user.id, project.id, {
      objectType: 'seurat',
    });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1',
      analysisObjectId: source.id,
      parameters: {},
    });
    const provider = temporaryStorageProvider();
    const fake = signedReceiptCaller(provider, (_request, output) => pipelineReceiptPayload({
      checksumSha256: sha256(output),
      sizeBytes: output.length,
    }), (_request, payload) => ({ status: 200, body: payload }));
    let throwAfterCommit = true;
    const dbProxy = {
      ...db,
      completePbmcPipelineResultByWorker: async (...args) => {
        const committed = await db.completePbmcPipelineResultByWorker(...args);
        if (throwAfterCommit) {
          throwAfterCommit = false;
          throw new Error('database response was lost after commit');
        }
        return committed;
      },
    };
    let now = T0;
    const worker = createJobWorker({
      db: dbProxy,
      workerId: 'worker-file-publisher-ambiguity',
      now: () => now,
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ status: 'indeterminate' });
    expect(fake.getCalls()).toBe(1);
    expect(fs.existsSync(provider.resolveKey(
      storage.completionReceiptKey(project.id, job.id)
    ))).toBe(true);

    now = LATER;
    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'completed',
      recovered: true,
      jobId: job.id,
    });
    expect(fake.getCalls()).toBe(1);
    expect(fs.existsSync(provider.resolveKey(
      storage.completionReceiptKey(project.id, job.id)
    ))).toBe(false);
  });

  it('recovers live state when artifact publication commits and then throws without rerunning R', async () => {
    const { user, project } = await seedProject('live-publisher-commit-then-throw@example.com');
    const source = await seedCheckpoint(user, project, 'live-publisher-ambiguity');
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'checkpoint.load.v1',
      analysisObjectId: source.resultObject.id,
      parameters: {},
    });
    const provider = temporaryStorageProvider();
    const runtimeInstanceId = 'live-publisher-runtime-instance';
    const runtimeInstanceHash = sha256(runtimeInstanceId);
    const fake = signedReceiptCaller(
      provider,
      () => loadReceiptPayload(runtimeInstanceId),
      (_request, payload) => ({ status: 200, body: payload })
    );
    let throwAfterCommit = true;
    const dbProxy = {
      ...db,
      createJobArtifactByWorker: async (...args) => {
        const committed = await db.createJobArtifactByWorker(...args);
        if (throwAfterCommit) {
          throwAfterCommit = false;
          throw new Error('database response was lost after live-state artifact commit');
        }
        return committed;
      },
    };
    let now = T0;
    const worker = createJobWorker({
      db: dbProxy,
      workerId: 'worker-live-publisher-ambiguity',
      now: () => now,
      claimGate: async () => ({ ready: true, rRuntimeInstanceHash: runtimeInstanceHash }),
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ status: 'indeterminate' });
    expect(fake.getCalls()).toBe(1);
    expect(fs.existsSync(provider.resolveKey(
      storage.completionReceiptKey(project.id, job.id)
    ))).toBe(true);

    now = LATER;
    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'completed',
      recovered: true,
      jobId: job.id,
    });
    expect(fake.getCalls()).toBe(1);
    expect(fs.existsSync(provider.resolveKey(
      storage.completionReceiptKey(project.id, job.id)
    ))).toBe(false);
  });

  it('re-reads and completes when an adopted-receipt publisher commits and then throws', async () => {
    const { user, project } = await seedProject('adopted-publisher-commit-then-throw@example.com');
    const source = await db.createProjectAnalysisObject(user.id, project.id, {
      objectType: 'seurat',
    });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1',
      analysisObjectId: source.id,
      parameters: {},
    });
    const provider = temporaryStorageProvider();
    const fake = timeoutAfterSignedReceipt(provider, (_request, output) => pipelineReceiptPayload({
      checksumSha256: sha256(output),
      sizeBytes: output.length,
    }));
    const firstWorker = createJobWorker({
      db,
      workerId: 'worker-adopted-publisher-original',
      now: () => T0,
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });
    await expect(firstWorker.runOnce()).resolves.toMatchObject({ status: 'indeterminate' });

    let publisherCalls = 0;
    const dbProxy = {
      ...db,
      completePbmcPipelineResultByWorker: async (...args) => {
        publisherCalls += 1;
        await db.completePbmcPipelineResultByWorker(...args);
        throw new Error('publisher acknowledgement lost after commit');
      },
    };
    const recoveryWorker = createJobWorker({
      db: dbProxy,
      workerId: 'worker-adopted-publisher-recovery',
      now: () => LATER,
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });

    await expect(recoveryWorker.runOnce()).resolves.toMatchObject({
      status: 'completed',
      recovered: true,
      publicationRecovered: true,
      jobId: job.id,
    });
    expect(publisherCalls).toBe(1);
    expect(fake.getCalls()).toBe(1);
    expect(fs.existsSync(provider.resolveKey(
      storage.completionReceiptKey(project.id, job.id)
    ))).toBe(false);
  });

  it('re-reads live-state metadata when an adopted-receipt publisher commits and then throws', async () => {
    const { user, project } = await seedProject('adopted-live-publisher-commit-then-throw@example.com');
    const source = await seedCheckpoint(user, project, 'adopted-live-publisher');
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'checkpoint.load.v1',
      analysisObjectId: source.resultObject.id,
      parameters: {},
    });
    const provider = temporaryStorageProvider();
    const runtimeInstanceId = 'adopted-live-publisher-runtime';
    const runtimeInstanceHash = sha256(runtimeInstanceId);
    const fake = timeoutAfterSignedReceipt(
      provider,
      () => loadReceiptPayload(runtimeInstanceId)
    );
    const firstWorker = createJobWorker({
      db,
      workerId: 'worker-adopted-live-publisher-original',
      now: () => T0,
      claimGate: async () => ({ ready: true, rRuntimeInstanceHash: runtimeInstanceHash }),
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });
    await expect(firstWorker.runOnce()).resolves.toMatchObject({ status: 'indeterminate' });

    let publisherCalls = 0;
    const dbProxy = {
      ...db,
      createJobArtifactByWorker: async (...args) => {
        publisherCalls += 1;
        await db.createJobArtifactByWorker(...args);
        throw new Error('live publisher acknowledgement lost after commit');
      },
    };
    const recoveryWorker = createJobWorker({
      db: dbProxy,
      workerId: 'worker-adopted-live-publisher-recovery',
      now: () => LATER,
      claimGate: async () => ({ ready: true, rRuntimeInstanceHash: runtimeInstanceHash }),
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });

    await expect(recoveryWorker.runOnce()).resolves.toMatchObject({
      status: 'completed',
      recovered: true,
      publicationRecovered: true,
      jobId: job.id,
    });
    expect(publisherCalls).toBe(1);
    expect(fake.getCalls()).toBe(1);
    expect(fs.existsSync(provider.resolveKey(
      storage.completionReceiptKey(project.id, job.id)
    ))).toBe(false);
  });

  it('bounds an adopted-receipt publisher failure that did not commit without rerunning R', async () => {
    const { user, project } = await seedProject('adopted-publisher-no-commit@example.com');
    const source = await db.createProjectAnalysisObject(user.id, project.id, {
      objectType: 'seurat',
    });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1',
      analysisObjectId: source.id,
      parameters: {},
    });
    const provider = temporaryStorageProvider();
    const fake = timeoutAfterSignedReceipt(provider, (_request, output) => pipelineReceiptPayload({
      checksumSha256: sha256(output),
      sizeBytes: output.length,
    }));
    const firstWorker = createJobWorker({
      db,
      workerId: 'worker-adopted-no-commit-original',
      now: () => T0,
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });
    await expect(firstWorker.runOnce()).resolves.toMatchObject({ status: 'indeterminate' });

    let publisherCalls = 0;
    const dbProxy = {
      ...db,
      completePbmcPipelineResultByWorker: async () => {
        publisherCalls += 1;
        throw new Error('publisher failed before commit');
      },
    };
    const recoveryWorker = createJobWorker({
      db: dbProxy,
      workerId: 'worker-adopted-no-commit-recovery',
      now: () => LATER,
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });

    await expect(recoveryWorker.runOnce()).resolves.toMatchObject({
      status: 'failed',
      error: {
        code: 'HANDLER_ERROR',
        message: 'Completion publication could not be recovered.',
      },
    });
    expect(publisherCalls).toBe(1);
    expect(fake.getCalls()).toBe(1);
    expect(fs.existsSync(provider.resolveKey(
      allocateCheckpointStorageKey(project.id, job.id)
    ))).toBe(false);
    expect(fs.existsSync(provider.resolveKey(
      storage.completionReceiptKey(project.id, job.id)
    ))).toBe(false);
  });

  it('removes file output and receipt when cancellation wins after a successful R response', async () => {
    const { user, project } = await seedProject('cancel-after-r-publication@example.com');
    const source = await db.createProjectAnalysisObject(user.id, project.id, {
      objectType: 'seurat',
    });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1',
      analysisObjectId: source.id,
      parameters: {},
    });
    const provider = temporaryStorageProvider();
    const fake = signedReceiptCaller(
      provider,
      (_request, output) => pipelineReceiptPayload({
        checksumSha256: sha256(output),
        sizeBytes: output.length,
      }),
      async (_request, payload) => {
        await db.cancelProjectJob(user.id, project.id, job.id);
        return { status: 200, body: payload };
      }
    );
    const worker = createJobWorker({
      db,
      workerId: 'worker-cancel-after-r-publication',
      now: () => T0,
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'claim_lost',
      phase: 'handler',
    });
    expect(fake.getCalls()).toBe(1);
    expect(fs.existsSync(provider.resolveKey(
      allocateCheckpointStorageKey(project.id, job.id)
    ))).toBe(false);
    expect(fs.existsSync(provider.resolveKey(
      storage.completionReceiptKey(project.id, job.id)
    ))).toBe(false);
    expect(await db.getJobArtifactsByJobId(job.id)).toHaveLength(0);
    expect((await db.getProjectJob(user.id, project.id, job.id)).status).toBe('canceled');
  });

  it('cleans valid recovery evidence when cancellation wins during the initial committed-output probe', async () => {
    const { user, project } = await seedProject('cancel-during-initial-recovery-probe@example.com');
    const source = await db.createProjectAnalysisObject(user.id, project.id, {
      objectType: 'seurat',
    });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1',
      analysisObjectId: source.id,
      parameters: {},
    });
    const provider = temporaryStorageProvider();
    const fake = timeoutAfterSignedReceipt(provider, (_request, output) => pipelineReceiptPayload({
      checksumSha256: sha256(output),
      sizeBytes: output.length,
    }));
    const firstWorker = createJobWorker({
      db,
      workerId: 'worker-cancel-initial-probe-original',
      now: () => T0,
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });
    await expect(firstWorker.runOnce()).resolves.toMatchObject({ status: 'indeterminate' });

    const outputPath = provider.resolveKey(allocateCheckpointStorageKey(project.id, job.id));
    const receiptPath = provider.resolveKey(storage.completionReceiptKey(project.id, job.id));
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.existsSync(receiptPath)).toBe(true);

    const dbProxy = {
      ...db,
      resumeCommittedJobByWorker: async (...args) => {
        await db.cancelProjectJob(user.id, project.id, job.id);
        return db.resumeCommittedJobByWorker(...args);
      },
    };
    const recoveryWorker = createJobWorker({
      db: dbProxy,
      workerId: 'worker-cancel-initial-probe-recovery',
      now: () => LATER,
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });

    await expect(recoveryWorker.runOnce()).resolves.toMatchObject({
      status: 'claim_lost',
      phase: 'recover-committed-output',
    });
    expect((await db.getProjectJob(user.id, project.id, job.id)).status).toBe('canceled');
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.existsSync(receiptPath)).toBe(false);
    expect(fake.getCalls()).toBe(1);
  });

  it('cleans adopted output when cancellation wins during ambiguous-publication re-read', async () => {
    const { user, project } = await seedProject('cancel-during-adopted-reread@example.com');
    const source = await db.createProjectAnalysisObject(user.id, project.id, {
      objectType: 'seurat',
    });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1',
      analysisObjectId: source.id,
      parameters: {},
    });
    const provider = temporaryStorageProvider();
    const fake = timeoutAfterSignedReceipt(provider, (_request, output) => pipelineReceiptPayload({
      checksumSha256: sha256(output),
      sizeBytes: output.length,
    }));
    const firstWorker = createJobWorker({
      db,
      workerId: 'worker-cancel-adopted-original',
      now: () => T0,
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });
    await expect(firstWorker.runOnce()).resolves.toMatchObject({ status: 'indeterminate' });

    let resumeCalls = 0;
    const dbProxy = {
      ...db,
      completePbmcPipelineResultByWorker: async () => {
        throw new Error('publication acknowledgement is ambiguous');
      },
      resumeCommittedJobByWorker: async (...args) => {
        resumeCalls += 1;
        if (resumeCalls === 1) return db.resumeCommittedJobByWorker(...args);
        await db.cancelProjectJob(user.id, project.id, job.id);
        return db.resumeCommittedJobByWorker(...args);
      },
    };
    const recoveryWorker = createJobWorker({
      db: dbProxy,
      workerId: 'worker-cancel-adopted-reread',
      now: () => LATER,
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });

    await expect(recoveryWorker.runOnce()).resolves.toMatchObject({
      status: 'claim_lost',
      phase: 'handler',
    });
    expect(resumeCalls).toBe(2);
    expect(fake.getCalls()).toBe(1);
    expect(fs.existsSync(provider.resolveKey(
      allocateCheckpointStorageKey(project.id, job.id)
    ))).toBe(false);
    expect(fs.existsSync(provider.resolveKey(
      storage.completionReceiptKey(project.id, job.id)
    ))).toBe(false);
  });

  it('preserves output on lease-loss after R success and recovers it without rerunning R', async () => {
    const { user, project } = await seedProject('lease-loss-after-r-success@example.com');
    const source = await db.createProjectAnalysisObject(user.id, project.id, {
      objectType: 'seurat',
    });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1',
      analysisObjectId: source.id,
      parameters: {},
    });
    const provider = temporaryStorageProvider();
    const fake = signedReceiptCaller(
      provider,
      (_request, output) => pipelineReceiptPayload({
        checksumSha256: sha256(output),
        sizeBytes: output.length,
      }),
      async (_request, payload) => {
        // Simulate a stalled/partitioned worker whose lease is reaped after R has
        // returned but before the claim-guarded DB publisher starts.
        await db.reapExpiredJobs({ now: LATER });
        return { status: 200, body: payload };
      }
    );
    const firstWorker = createJobWorker({
      db,
      workerId: 'worker-lease-loss-after-r-success',
      now: () => T0,
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });

    await expect(firstWorker.runOnce()).resolves.toMatchObject({
      status: 'claim_lost',
      phase: 'handler',
    });
    const outputPath = provider.resolveKey(allocateCheckpointStorageKey(project.id, job.id));
    const receiptPath = provider.resolveKey(storage.completionReceiptKey(project.id, job.id));
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.existsSync(receiptPath)).toBe(true);
    expect(fake.getCalls()).toBe(1);

    const recoveryWorker = createJobWorker({
      db,
      workerId: 'worker-lease-loss-recovery',
      now: () => MUCH_LATER,
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });
    await expect(recoveryWorker.runOnce()).resolves.toMatchObject({
      status: 'completed',
      jobId: job.id,
    });
    expect(fake.getCalls()).toBe(1);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.existsSync(receiptPath)).toBe(false);
  });

  it('never redispatches after a worker crash marker and adopts a receipt that arrives during observation', async () => {
    const { user, project } = await seedProject('crash-dispatch-late-receipt@example.com');
    const source = await db.createProjectAnalysisObject(user.id, project.id, {
      objectType: 'seurat',
    });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1',
      analysisObjectId: source.id,
      parameters: {},
    });
    const crashedWorkerId = 'worker-crashed-after-dispatch';
    const claim = await db.claimNextJob(crashedWorkerId, { now: T0, leaseSeconds: 30 });
    await db.markRDispatchStartedByWorker(
      job.id,
      crashedWorkerId,
      claim.claimToken,
      { now: T0_PLUS_10 }
    );

    const provider = temporaryStorageProvider();
    let replacementCalls = 0;
    const replacementCallR = async () => {
      replacementCalls += 1;
      throw new Error('replacement R dispatch is forbidden');
    };
    Object.defineProperty(replacementCallR, 'verifyCompletionReceipt', {
      value: (envelope) => rBridge.verifyCompletionReceiptEnvelope(envelope, RECEIPT_SECRET),
    });
    let now = LATER;
    const worker = createJobWorker({
      db,
      workerId: 'worker-crash-recovery-observer',
      now: () => now,
      callR: replacementCallR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });

    // First reap revokes the crashed claim and starts a bounded, no-R observation
    // window. No receipt exists yet, so there is nothing to claim or redispatch.
    await expect(worker.runOnce()).resolves.toMatchObject({ status: 'idle' });
    expect(replacementCalls).toBe(0);
    expect(await db.getWorkerJob(job.id)).toMatchObject({
      status: 'running',
      lastWorkerError: expect.objectContaining({ code: db.R_TIMEOUT_INDETERMINATE }),
    });

    // The original R process finishes late and atomically publishes its output and
    // signed receipt while the replacement worker is only observing.
    const outputStorageKey = allocateCheckpointStorageKey(project.id, job.id);
    const output = Buffer.from('late-output-from-original-r-process', 'utf8');
    fs.writeFileSync(provider.prepareWrite(outputStorageKey), output);
    const binding = rBridge.buildCompletionReceiptBinding(
      claim,
      'r.pbmc.pipeline.v1',
      {
        objectContext: { objectId: source.id },
        pipeline: { checkpointStorageKey: outputStorageKey },
      }
    );
    const envelope = rBridge.createCompletionReceiptEnvelope({
      ...binding,
      payload: pipelineReceiptPayload({
        checksumSha256: sha256(output),
        sizeBytes: output.length,
      }),
    }, RECEIPT_SECRET);
    fs.writeFileSync(
      provider.prepareWrite(binding.receipt_storage_key),
      JSON.stringify(envelope),
      'utf8'
    );

    now = MUCH_LATER;
    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'completed',
      jobId: job.id,
    });
    expect(replacementCalls).toBe(0);
    expect((await db.getWorkerJob(job.id)).status).toBe('completed');
  });

  it.each([
    ['oversized response', () => {
      throw Object.assign(new Error('response exceeded local bound'), {
        code: 'R_RESPONSE_TOO_LARGE',
      });
    }],
    ['malformed 200 response', () => ({ status: 200, body: null })],
    ['non-200 response', () => ({ status: 500, body: { code: 'R_SERIALIZATION_FAILED' } })],
  ])('adopts a valid receipt after an ambiguous %s without cleanup or a second R call', async (_label, afterReceipt) => {
    const { user, project } = await seedProject(`post-contact-${_label.replace(/[^a-z]/g, '-')}@example.com`);
    const source = await db.createProjectAnalysisObject(user.id, project.id, {
      objectType: 'seurat',
    });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1',
      analysisObjectId: source.id,
      parameters: {},
    });
    const provider = temporaryStorageProvider();
    const fake = signedReceiptCaller(provider, (_request, output) => pipelineReceiptPayload({
      checksumSha256: sha256(output),
      sizeBytes: output.length,
    }), afterReceipt);
    let now = T0;
    const worker = createJobWorker({
      db,
      workerId: `worker-post-contact-${job.id}`,
      now: () => now,
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'indeterminate',
      error: { code: db.R_TIMEOUT_INDETERMINATE },
    });
    expect(fake.getCalls()).toBe(1);
    expect(fs.existsSync(provider.resolveKey(
      storage.completionReceiptKey(project.id, job.id)
    ))).toBe(true);

    now = LATER;
    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'completed',
      jobId: job.id,
    });
    expect(fake.getCalls()).toBe(1);
    expect(fs.existsSync(provider.resolveKey(
      storage.completionReceiptKey(project.id, job.id)
    ))).toBe(false);
  });

  it('terminally rejects a present cross-job signed receipt without rerunning R or deleting evidence', async () => {
    const { user, project } = await seedProject('invalid-present-receipt@example.com');
    const source = await db.createProjectAnalysisObject(user.id, project.id, {
      objectType: 'seurat',
    });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1',
      analysisObjectId: source.id,
      parameters: {},
    });
    const provider = temporaryStorageProvider();
    const fake = timeoutAfterSignedReceipt(provider, (_request, output) => pipelineReceiptPayload({
      checksumSha256: sha256(output),
      sizeBytes: output.length,
    }));
    let now = T0;
    const worker = createJobWorker({
      db,
      workerId: 'worker-invalid-present-receipt',
      now: () => now,
      callR: fake.callR,
      deriveRObjectStateKey,
      storageProvider: provider,
      logger: silentLogger(),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ status: 'indeterminate' });
    const receiptKey = storage.completionReceiptKey(project.id, job.id);
    const receiptPath = provider.resolveKey(receiptKey);
    const originalEnvelope = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const originalReceipt = JSON.parse(originalEnvelope.signed_receipt);
    fs.writeFileSync(
      receiptPath,
      JSON.stringify(rBridge.createCompletionReceiptEnvelope({
        ...originalReceipt,
        job_id: 'job_deadbeef',
      }, RECEIPT_SECRET)),
      'utf8'
    );

    now = LATER;
    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'failed',
      receiptInvalid: true,
      error: { code: 'R_COMPLETION_RECEIPT_INVALID' },
    });
    expect(fake.getCalls()).toBe(1);
    expect(fs.existsSync(receiptPath)).toBe(true);
    expect(fs.existsSync(provider.resolveKey(
      allocateCheckpointStorageKey(project.id, job.id)
    ))).toBe(true);
  });

  it.each([
    ['R_TIMEOUT', 'timeout'],
    ['R_UNREACHABLE', 'disconnect'],
  ])('keeps an R %s in repeated no-R observation when no receipt has arrived', async (bridgeCode, label) => {
    const { user, project } = await seedProject(`${label}-no-output@example.com`);
    const source = await db.createProjectAnalysisObject(user.id, project.id, { objectType: 'seurat' });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1', analysisObjectId: source.id, parameters: {},
    });
    let now = T0;
    let rCalls = 0;
    let removedOutputs = 0;
    const worker = createJobWorker({
      db,
      workerId: 'worker-timeout-no-output',
      now: () => now,
      callR: async () => {
        rCalls += 1;
        throw Object.assign(new Error('local R transport outcome is unknown'), { code: bridgeCode });
      },
      deriveRObjectStateKey,
      storageProvider: {
        inspect: () => ({ ok: true }),
        remove: () => { removedOutputs += 1; return true; },
      },
      logger: silentLogger(),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'indeterminate',
      error: { code: db.R_TIMEOUT_INDETERMINATE },
    });
    expect(await db.getWorkerJob(job.id)).toMatchObject({
      status: 'running',
      lastWorkerError: expect.objectContaining({ code: db.R_TIMEOUT_INDETERMINATE }),
    });

    now = LATER;
    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'indeterminate',
      recoveryOnly: true,
      error: { code: db.R_TIMEOUT_INDETERMINATE },
    });
    expect(rCalls).toBe(1);
    expect(removedOutputs).toBe(0);
    expect(await db.getWorkerJob(job.id)).toMatchObject({
      status: 'running',
      lastWorkerError: expect.objectContaining({ code: db.R_TIMEOUT_INDETERMINATE }),
    });

    now = MUCH_LATER;
    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'indeterminate',
      recoveryOnly: true,
    });
    expect(rCalls).toBe(1);
    expect(removedOutputs).toBe(0);
  });

  it('fails and cleans a missing receipt only after the singleton R readiness barrier', async () => {
    const { user, project } = await seedProject('missing-receipt-r-barrier@example.com');
    const source = await db.createProjectAnalysisObject(user.id, project.id, {
      objectType: 'seurat',
    });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1',
      analysisObjectId: source.id,
      parameters: {},
    });
    let now = T0;
    let rCalls = 0;
    let removedOutputs = 0;
    const worker = createJobWorker({
      db,
      workerId: 'worker-missing-receipt-r-barrier',
      now: () => now,
      claimGate: async () => ({
        ready: true,
        recoveryBarrierSafe: true,
        rRuntimeInstanceHash: 'f'.repeat(64),
      }),
      callR: async () => {
        rCalls += 1;
        throw Object.assign(new Error('R transport outcome is unknown'), {
          code: 'R_TIMEOUT',
        });
      },
      deriveRObjectStateKey,
      storageProvider: {
        inspect: () => ({ ok: true }),
        remove: () => { removedOutputs += 1; return true; },
      },
      logger: silentLogger(),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ status: 'indeterminate' });
    now = LATER;
    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'failed',
      recoveryOnly: true,
      error: { code: 'R_COMPLETION_RECEIPT_MISSING' },
    });
    expect(rCalls).toBe(1);
    expect(removedOutputs).toBe(2);
    expect((await db.getWorkerJob(job.id)).status).toBe('failed');
  });

  it('recovers an exact output committed before an indeterminate timeout without rerunning the handler', async () => {
    const { user, project } = await seedProject('timeout-committed-output@example.com');
    const source = await db.createProjectAnalysisObject(user.id, project.id, { objectType: 'seurat' });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1', analysisObjectId: source.id, parameters: {},
    });
    let now = T0;
    let handlerCalls = 0;
    let committedResultId = null;
    const worker = createJobWorker({
      db,
      workerId: 'worker-timeout-committed-output',
      now: () => now,
      handlers: {
        'pbmc.pipeline.v1': async (ctx) => {
          handlerCalls += 1;
          const committed = await ctx.completePbmcPipelineResult({
            result: { displayName: 'Timeout recovery result', metadata: {} },
            checkpointArtifact: {
              artifactType: 'checkpoint', storageKind: 'local_internal',
              internalStorageKey: `projects/${project.id}/checkpoints/${job.id}/checkpoint.rds`,
              checksumSha256: '5'.repeat(64), sizeBytes: 55, metadata: {},
            },
            summaryArtifact: {
              artifactType: 'pipeline_summary', storageKind: 'metadata_only', metadata: {},
            },
          });
          committedResultId = committed.resultObject.id;
          throw Object.assign(new Error('R runtime did not respond before the timeout.'), {
            code: 'R_TIMEOUT',
          });
        },
      },
      storageProvider: verifiedStorage(),
      logger: silentLogger(),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ status: 'indeterminate' });
    expect(committedResultId).toBeTruthy();

    now = LATER;
    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'completed', recovered: true, jobId: job.id,
    });
    expect(handlerCalls).toBe(1);
    expect(await db.getWorkerJob(job.id)).toMatchObject({
      status: 'completed', resultAnalysisObjectId: committedResultId,
    });
  });

  it('never invokes a handler when committed output disappears during a recovery-only claim', async () => {
    const { user, project } = await seedProject('committed-output-disappeared@example.com');
    const source = await db.createProjectAnalysisObject(user.id, project.id, {
      objectType: 'seurat',
    });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'pbmc.pipeline.v1',
      analysisObjectId: source.id,
      parameters: {},
    });
    await db.setJobScheduling(job.id, { maxAttempts: 1 });
    const originalWorkerId = 'worker-committed-output-disappeared';
    const claim = await db.claimNextJob(originalWorkerId, { now: T0, leaseSeconds: 30 });
    await db.completePbmcPipelineResultByWorker(
      job.id,
      originalWorkerId,
      claim.claimToken,
      {
        result: { displayName: 'Transient committed result', metadata: {} },
        checkpointArtifact: {
          artifactType: 'checkpoint',
          storageKind: 'local_internal',
          internalStorageKey: allocateCheckpointStorageKey(project.id, job.id),
          checksumSha256: '6'.repeat(64),
          sizeBytes: 66,
          metadata: {},
        },
        summaryArtifact: {
          artifactType: 'pipeline_summary',
          storageKind: 'metadata_only',
          metadata: {},
        },
      },
      { now: T0_PLUS_10 }
    );

    let handlerCalls = 0;
    let rCalls = 0;
    const dbProxy = {
      ...db,
      // Simulate the committed rows changing between reaper selection and guarded
      // claim processing. Recovery must fail closed instead of falling into R.
      resumeCommittedJobByWorker: async () => ({
        resumed: false,
        committedOutput: false,
      }),
    };
    const worker = createJobWorker({
      db: dbProxy,
      workerId: 'worker-committed-output-recovery-only',
      now: () => LATER,
      handlers: {
        'pbmc.pipeline.v1': async () => {
          handlerCalls += 1;
          throw new Error('handler must not run');
        },
      },
      callR: async () => {
        rCalls += 1;
        throw new Error('R must not run');
      },
      storageProvider: verifiedStorage(),
      logger: silentLogger(),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'indeterminate',
      recoveryOnly: true,
      error: { code: db.R_TIMEOUT_INDETERMINATE },
    });
    expect(handlerCalls).toBe(0);
    expect(rCalls).toBe(0);
  });
});
