import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectHistory from './ProjectHistory';

const currentWs = {
  id: 'ws-1',
  name: 'Personal Workspace',
  type: 'personal',
  projects: [{ id: 'proj_1', name: 'PBMC Project', role: 'owner', isBackendProject: true }],
  selectedProjectId: 'proj_1',
  objects: [{ id: 'ao_abc123', projectId: 'proj_1', displayName: 'PBMC 3k' }],
  selectedObjectIds: ['ao_abc123'],
};

describe('ProjectHistory', () => {
  beforeEach(() => {
    window.electronAPI = {
      listProjectJobs: vi.fn(async () => [{
        id: 'job_safe_1',
        status: 'completed',
        jobType: 'pbmc.pipeline.v1',
        analysisObjectId: 'ao_abc123',
        resultAnalysisObjectId: 'ao_result123',
        datasetId: 'ds_1',
        createdAt: '2026-06-30T00:00:00.000Z',
        storageUri: 'vault/private/job-output.rds',
        storage_uri: 'vault/private/job-output-snake.rds',
        storage_key: 'vault/private/job-key.rds',
        workerId: 'worker-internal-1',
        stateKey: 'user-101:obj-ao_abc123',
        state_key: 'user-101:obj-ao_abc123:snake',
        claim_token: 'secret-claim-token-snake',
        error: {
          code: 'R_RUNTIME_ERROR',
          message: 'sanitized job error',
          stack: 'Error: raw R stack trace text at vault/private/stack.R:42',
        },
      }]),
      listProjectArtifacts: vi.fn(async () => [{
        id: 'artifact_safe_1',
        name: 'QC checkpoint',
        artifactType: 'checkpoint',
        status: 'available',
        storageKind: 'vault',
        jobId: 'job_safe_1',
        internalStorageKey: 'private/artifacts/checkpoint.rds',
        internal_storage_key: 'vault/private/artifacts/checkpoint-snake.rds',
        claimToken: 'secret-claim-token',
        claim_token: 'secret-claim-token-snake',
        storage_uri: 'vault/private/artifact-storage.rds',
        storage_key: 'vault/private/artifact-key.rds',
      }]),
      listProjectProvenance: vi.fn(async () => [{
        id: 'prov_safe_1',
        operation: 'normalize',
        analysisObjectId: 'ao_result123',
        jobId: 'job_safe_1',
        createdAt: '2026-06-30T00:02:00.000Z',
        params: {
          storageKey: 'private/provenance.json',
          storage_key: 'vault/private/provenance-snake.json',
          state_key: 'user-101:obj-ao_result123',
          rawRStackTrace: 'raw R stack trace text: traceback() vault/private/provenance.R',
        },
      }]),
      listProjectFigures: vi.fn(async () => [{
        id: 'fig_safe_1',
        title: 'UMAP overview',
        plotType: 'UMAP',
        createdAt: '2026-06-30T00:03:00.000Z',
        filePath: '/__private_vault__/umap.png',
        storage_key: 'vault/private/figure-key.png',
      }]),
      getProjectAnalysisObjectLineage: vi.fn(async () => ({
        projectId: 'proj_1',
        objectId: 'ao_abc123',
        rootObjectId: 'ao_abc123',
        nodes: [
          {
            id: 'ao_abc123',
            label: 'PBMC 3k',
            objectType: 'seurat',
            storageUri: 'vault/private/root.rds',
            storage_uri: 'vault/private/root-snake.rds',
            objectHash: 'object-hash-secret-camel',
            object_hash: 'object-hash-secret-snake',
            state_key: 'user-101:obj-ao_abc123:lineage',
          },
          { id: 'ao_result123', label: 'Normalized PBMC', objectType: 'seurat', object_hash: 'object-hash-result-secret' },
        ],
        edges: [{
          id: 'edge_safe_1',
          parentAnalysisObjectId: 'ao_abc123',
          childAnalysisObjectId: 'ao_result123',
          edgeType: 'derived_from',
          parentRole: 'input',
          storageKey: 'private/edge.json',
          storage_key: 'vault/private/edge-snake.json',
          internal_storage_key: 'vault/private/edge-internal.json',
          claim_token: 'secret-claim-token-edge',
        }],
        truncated: false,
      })),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('renders read-only project history without leaking private storage or live-R state fields', async () => {
    const { container } = render(<ProjectHistory currentWs={currentWs} datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }} />);

    expect(screen.getByText('Jobs & Artifacts')).toBeInTheDocument();
    expect(screen.getByText(/read-only metadata/i)).toBeInTheDocument();
    expect(screen.getByText(/no public download/i)).toBeInTheDocument();
    expect(screen.getByText(/durable backend state/i)).toBeInTheDocument();

    expect((await screen.findAllByText('job_safe_1')).length).toBeGreaterThan(0);
    expect(screen.getByText('artifact_safe_1')).toBeInTheDocument();
    expect(screen.getByText('prov_safe_1')).toBeInTheDocument();
    expect(screen.getByText('fig_safe_1')).toBeInTheDocument();
    expect(screen.getByText('UMAP overview')).toBeInTheDocument();
    expect(screen.getByText(/ao_abc123 -> ao_result123/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(window.electronAPI.listProjectJobs).toHaveBeenCalledWith('proj_1');
      expect(window.electronAPI.getProjectAnalysisObjectLineage).toHaveBeenCalledWith('proj_1', 'ao_abc123');
    });

    const text = container.textContent || '';
    expect(text).not.toMatch(/vault\/private/i);
    expect(text).not.toMatch(/vault\//i);
    expect(text).not.toMatch(/__private_vault__/i);
    expect(text).not.toMatch(/C:\\Users/i);
    expect(text).not.toMatch(/C:\/Users/i);
    expect(text).not.toMatch(/storage_uri/i);
    expect(text).not.toMatch(/internalStorageKey/i);
    expect(text).not.toMatch(/internal_storage_key/i);
    expect(text).not.toMatch(/storageKey/i);
    expect(text).not.toMatch(/storage_key/i);
    expect(text).not.toMatch(/objectHash/i);
    expect(text).not.toMatch(/object_hash/i);
    expect(text).not.toMatch(/claimToken/i);
    expect(text).not.toMatch(/claim_token/i);
    expect(text).not.toMatch(/secret-claim-token/i);
    expect(text).not.toMatch(/worker-internal/i);
    expect(text).not.toMatch(/stateKey/i);
    expect(text).not.toMatch(/state_key/i);
    expect(text).not.toMatch(/user-101:obj/i);
    expect(text).not.toMatch(/raw R stack trace text/i);
    expect(text).not.toMatch(/traceback/i);
    expect(text).not.toMatch(/object-hash-secret/i);
  });

  it('shows a project-scoped empty state when no project is selected', () => {
    render(<ProjectHistory currentWs={{ ...currentWs, projects: [], selectedProjectId: null }} datasetInfo={null} />);

    expect(screen.getByText(/Select a backend project/i)).toBeInTheDocument();
    expect(screen.getByText(/scoped to a backend project/i)).toBeInTheDocument();
  });

  it('does not load object lineage when no object is selected in the active project', async () => {
    render(
      <ProjectHistory
        currentWs={{ ...currentWs, selectedObjectIds: [] }}
        datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }}
      />
    );

    await waitFor(() => {
      expect(window.electronAPI.listProjectJobs).toHaveBeenCalledWith('proj_1');
    });
    expect(window.electronAPI.getProjectAnalysisObjectLineage).not.toHaveBeenCalled();
    expect(screen.getByText(/No selected object/i)).toBeInTheDocument();
  });
});
