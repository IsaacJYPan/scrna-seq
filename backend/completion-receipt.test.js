import { describe, expect, it } from 'vitest';

const rBridge = require('./rWorkerBridge');
const storage = require('./storage');

const SECRET = 'completion-receipt-unit-secret';

function pipelinePayload() {
  return {
    ok: true,
    summary: {
      n_cells: 10,
      n_features: 20,
      cluster_sizes: [5, 5],
      reductions: ['pca', 'umap'],
    },
    checkpoint: {
      saved: true,
      checksum_sha256: 'a'.repeat(64),
      size_bytes: 123,
    },
    versions: { seurat_version: '5.0.1', r_version: '4.5.3' },
  };
}

function cellChatPayload() {
  return {
    ok: true,
    summary: {
      method: 'cellchat_v2_predicted_signaling',
      analysis_intent: 'single_context',
      group_by: 'seurat_clusters',
      assay: 'RNA',
      species: 'human',
      database_category: 'all',
      p_value_cutoff: 0.05,
      input_cell_count: 100,
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
        r: '4.5.3', seurat: '5.3.1', cellchat: '2.1.2', cellchat_db: 'CellChatDB.human 2.1.2',
      },
      top_interactions: [{
        source: 'Group 1', target: 'Group 2', interaction: 'TGFB1.TGFBR1_TGFBR2',
        pathway: 'TGFb', probability: 0.42, p_value: 0.001, category: 'all',
      }],
      top_pathways: [{
        source: 'Group 1', target: 'Group 2', pathway: 'TGFb', probability: 0.42, p_value: 0.001,
      }],
      warnings: [],
    },
    result: { saved: true, checksum_sha256: 'a'.repeat(64), size_bytes: 123, n_rows: 1 },
  };
}

describe('signed R completion receipts', () => {
  it('uses a bounded domain-separated HMAC and rejects forged envelopes', () => {
    const receipt = { version: 1, payload: { ok: true } };
    const envelope = rBridge.createCompletionReceiptEnvelope(receipt, SECRET);
    expect(envelope).toEqual({
      algorithm: 'hmac-sha256',
      signed_receipt: JSON.stringify(receipt),
      signature: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(rBridge.verifyCompletionReceiptEnvelope(envelope, SECRET)).toEqual(receipt);
    const forgedLast = envelope.signature.endsWith('0') ? '1' : '0';
    expect(() => rBridge.verifyCompletionReceiptEnvelope({
      ...envelope,
      signature: `${envelope.signature.slice(0, 63)}${forgedLast}`,
    }, SECRET)).toThrowError(/invalid/i);
    expect(() => rBridge.verifyCompletionReceiptEnvelope({
      ...envelope,
      extra: true,
    }, SECRET)).toThrowError(/invalid/i);
  });

  it('derives every binding field from the trusted job and operation inputs', () => {
    const job = {
      id: 'job_aaaaaaaaaaaaaaaaaaaaaaaa',
      jobType: 'pbmc.pipeline.v1',
      projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbb',
      analysisObjectId: 'ao_cccccccccccccccccccccccc',
      datasetId: null,
    };
    const outputStorageKey = storage.projectStorageFileKey(
      job.projectId, 'checkpoints', job.id, 'checkpoint.rds'
    );
    const binding = rBridge.buildCompletionReceiptBinding(job, 'r.pbmc.pipeline.v1', {
      pipeline: { checkpointStorageKey: outputStorageKey },
      input: {
        project_id: 'proj_attacker',
        job_id: 'job_attacker',
        receipt_storage_key: '../../outside',
      },
    });
    expect(binding).toEqual({
      version: 1,
      job_id: job.id,
      job_type: job.jobType,
      r_operation: 'r.pbmc.pipeline.v1',
      project_id: job.projectId,
      receipt_storage_key: storage.completionReceiptKey(job.projectId, job.id),
      source_analysis_object_id: job.analysisObjectId,
      source_dataset_id: null,
      source_checkpoint_artifact_id: null,
      target_analysis_object_id: null,
      output_storage_key: outputStorageKey,
    });
  });

  it('rejects a signed CellChat receipt that tries to republish a raw group label', () => {
    const job = {
      id: 'job_aaaaaaaaaaaaaaaaaaaaaaaa',
      jobType: 'cellchat.infer.v1',
      projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbb',
      analysisObjectId: 'ao_cccccccccccccccccccccccc',
      datasetId: null,
    };
    const outputStorageKey = storage.projectStorageFileKey(
      job.projectId, 'artifacts', job.id, 'cellchat-inference.csv'
    );
    const binding = rBridge.buildCompletionReceiptBinding(job, 'r.cellchat.infer.v1', {
      cellChat: { resultStorageKey: outputStorageKey },
    });
    const safe = rBridge.descriptorFromCompletionReceipt(
      job, { ...binding, payload: cellChatPayload() }, { outputStorageKey }
    );
    expect(safe.summary.groups.map((row) => row.group)).toEqual(['Group 1', 'Group 2']);

    const unsafe = cellChatPayload();
    unsafe.summary.groups[0].group = 'Private donor';
    unsafe.summary.top_interactions[0].source = 'Private donor';
    unsafe.summary.top_pathways[0].source = 'Private donor';
    expect(() => rBridge.descriptorFromCompletionReceipt(
      job, { ...binding, payload: unsafe }, { outputStorageKey }
    )).toThrowError(/invalid/i);
  });

  it.each([
    ['job_id', 'job_other'],
    ['project_id', 'proj_other'],
    ['receipt_storage_key', 'projects/proj_other/artifacts/job_other/completion-receipt.json'],
    ['source_analysis_object_id', 'ao_other'],
    ['output_storage_key', 'projects/proj_other/checkpoints/job_other/checkpoint.rds'],
  ])('fails strict descriptor recovery when %s crosses its trusted binding', (field, value) => {
    const job = {
      id: 'job_aaaaaaaaaaaaaaaaaaaaaaaa',
      jobType: 'pbmc.pipeline.v1',
      projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbb',
      analysisObjectId: 'ao_cccccccccccccccccccccccc',
      datasetId: null,
    };
    const outputStorageKey = storage.projectStorageFileKey(
      job.projectId, 'checkpoints', job.id, 'checkpoint.rds'
    );
    const binding = rBridge.buildCompletionReceiptBinding(job, 'r.pbmc.pipeline.v1', {
      pipeline: { checkpointStorageKey: outputStorageKey },
    });
    const receipt = { ...binding, [field]: value, payload: pipelinePayload() };
    expect(() => rBridge.descriptorFromCompletionReceipt(job, receipt, {
      outputStorageKey,
    })).toThrowError(/invalid/i);
  });

  it('binds checkpoint fork recovery to the exact source checkpoint and target object', () => {
    const job = {
      id: 'job_dddddddddddddddddddddddd',
      jobType: 'checkpoint.fork.v1',
      projectId: 'proj_eeeeeeeeeeeeeeeeeeeeeeee',
      analysisObjectId: 'ao_ffffffffffffffffffffffff',
      datasetId: null,
    };
    const sourceCheckpointArtifactId = 'art_111111111111111111111111';
    const targetAnalysisObjectId = 'ao_222222222222222222222222';
    const binding = rBridge.buildCompletionReceiptBinding(job, 'r.checkpoint.load.v1', {
      checkpoint: { checkpointArtifactId: sourceCheckpointArtifactId },
      objectContext: { objectId: targetAnalysisObjectId },
    });
    const payload = {
      loaded: true,
      runtime_instance_id: 'runtime-1',
      checksum_verified: true,
      class: 'Seurat',
      n_cells: 1,
      n_features: 1,
      assays: ['RNA'],
      reductions: [],
      n_meta_fields: 0,
      meta_fields: [],
      seurat_version: '5.0.1',
      r_version: '4.5.3',
    };
    expect(() => rBridge.descriptorFromCompletionReceipt(
      job,
      { ...binding, target_analysis_object_id: 'ao_other', payload },
      { sourceCheckpointArtifactId, targetAnalysisObjectId }
    )).toThrowError(/invalid/i);
    expect(() => rBridge.descriptorFromCompletionReceipt(
      job,
      { ...binding, source_checkpoint_artifact_id: 'art_other', payload },
      { sourceCheckpointArtifactId, targetAnalysisObjectId }
    )).toThrowError(/invalid/i);
  });
});
