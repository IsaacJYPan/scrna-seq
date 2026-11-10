import { describe, it, expect } from 'vitest';

const { createAdmissionService } = require('./resourceAdmission/admission');

describe('admitted agent job inputs', () => {
  it.each([false, true])('preserves dataset provenance with a follow-on study: %s', async (followOn) => {
    const dataset = { id: 'ds_test', project_id: 'p', sha256: 'b'.repeat(64), file_type: 'tenx_h5',
      upload_status: 'uploaded', validation_status: 'valid', internal_storage_key: 'projects/p/datasets/ds_test/input.h5' };
    const release = { id: 'rel_test', digest: 'a'.repeat(64),
      jobType: followOn ? 'deg.find_markers.v1' : 'seurat.pipeline.v1' };
    const inputs = { datasetId: dataset.id, datasetSha256: dataset.sha256, analysisObjectId: 'ao_test',
      ...(followOn ? { sourceRunId: 'run_source' } : {}) };
    const study = { id: 'study_test', status: 'open', project_id: 'p', release_id: release.id,
      approval_id: 'approval_test', source_study_id: followOn ? 'study_source' : null,
      inputs_json: [inputs], max_trials: 4, max_outstanding_runs: 2, max_cpu_seconds: 10000 };
    const plan = { study: { id: study.id }, release, approvalId: study.approval_id,
      inputs, resources: { cpus: 1, memoryMiB: 8192, maxWallSeconds: 60 }, parameters: {}, choices: {} };
    const canonical = JSON.stringify(plan);
    const actor = { kind: 'agent', sponsorUserId: 1, principalId: 'principal_test', credentialId: 'credential_test',
      delegation: { id: 'delegation_test', projectId: 'p', version: 1,
        policy: { maxOutstandingRuns: 2, maxReservedCpuSeconds: 10000 } } };
    let job;
    const client = { query: async (sql, args) => {
      const rows = value => ({ rows: value });
      if (sql.includes('pg_advisory_xact_lock')) return rows([]);
      if (sql.includes('FROM agent_delegations d')) return rows([{ id: actor.delegation.id }]);
      if (sql.includes('SELECT id, plan_id, plan_digest')) return rows([]);
      if (sql.includes('SELECT ep.*')) return rows([{ id: 'plan_' + '1'.repeat(24), digest: release.digest, canonical_json: canonical }]);
      if (sql.includes('FROM project_members')) return rows([{ role: 'owner' }]);
      if (sql.includes('FROM study_envelopes')) return rows([study]);
      if (sql.includes('FROM workflow_approvals')) return rows([{ id: study.approval_id }]);
      if (sql.includes('FROM datasets')) return rows([dataset]);
      if (sql.includes('FROM analysis_objects')) return rows([{ id: inputs.analysisObjectId }]);
      if (sql.includes('AS installation_outstanding')) return rows([{
        installation_outstanding: 0, sponsor_outstanding: 0, delegation_outstanding: 0,
        delegation_cpu: 0, study_trials: 0, study_outstanding: 0, study_cpu: 0,
      }]);
      if (sql.includes('INSERT INTO jobs')) { job = args; return rows([]); }
      if (sql.includes('INSERT INTO agent_runs') || sql.includes('INSERT INTO automation_audit_events')) return rows([]);
      if (sql.includes('SELECT ar.*')) return rows([{ id: args[0], canonical_json: canonical, job_status: 'queued' }]);
      throw new Error('Unexpected admission query: ' + sql);
    } };
    const service = createAdmissionService({
      db: { genId: () => 'job_test', RETRYABLE_DURABLE_JOB_TYPES: new Set(), INITIAL_JOB_STATUS: 'created' },
      withTransaction: callback => callback(client), approvals: { ensureCatalog: async () => [release] },
    });
    const result = await service.submitRun(actor, {
      planId: 'plan_' + '1'.repeat(24), planDigest: release.digest, requestId: 'input-regression',
    });
    expect(job[3]).toBe(inputs.analysisObjectId);
    expect(job[4]).toBe(followOn ? null : dataset.id);
    expect(result.run.inputs).toEqual(inputs);
  });
});
