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
