import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DifferentialExpression from './DifferentialExpression';

const currentWs = {
  id: 'ws-1',
  name: 'Personal Workspace',
  projects: [{ id: 'proj_1', name: 'PBMC Project', role: 'owner' }],
  selectedProjectId: 'proj_1',
  objects: [{ id: 'ao_abc123', projectId: 'proj_1', displayName: 'PBMC 3k' }],
  selectedObjectIds: ['ao_abc123'],
};

function renderDeg(overrides = {}) {
  return render(
    <DifferentialExpression
      datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1', name: 'PBMC 3k' }}
      pipelineState={{ cluster: true }}
      currentWs={currentWs}
      userEmail="owner@example.com"
      objectId="ao_abc123"
      {...overrides}
    />
  );
}

describe('DifferentialExpression durable worker UI', () => {
  beforeEach(() => {
    window.electronAPI = {
      createDegFindMarkersJob: vi.fn(async () => ({
        id: 'job_abc123',
        status: 'queued',
        jobType: 'deg.find_markers.v1',
        analysisObjectId: 'ao_abc123',
        parameters: {},
        logs: [],
      })),
      getProjectJob: vi.fn(async () => ({
        id: 'job_abc123',
        status: 'completed',
        jobType: 'deg.find_markers.v1',
        analysisObjectId: 'ao_abc123',
        parameters: { groupBy: 'seurat_clusters', assay: 'RNA', testUse: 'wilcox' },
        logs: [],
      })),
      getProjectJobLogs: vi.fn(async () => ({
        id: 'job_abc123',
        status: 'completed',
        logs: [
          {
            ts: '2026-07-01T00:00:00.000Z',
            level: 'info',
            message: 'Recorded summary; internal file vault/private/markers.csv storageUri storageKey state_key user-1:obj-ao_abc123',
          },
        ],
      })),
      listProjectJobArtifacts: vi.fn(async () => [
        {
          id: 'art_summary',
          artifactType: 'deg_summary',
          status: 'available',
          storageKind: 'metadata_only',
          metadata: {
            summary: {
              groupBy: 'seurat_clusters',
              assay: 'RNA',
              testUse: 'wilcox',
              nGroups: 2,
              groups: ['0', '1'],
              nMarkersTotal: 3,
              markersPerGroup: [{ group: '0', n: 2 }, { group: '1', n: 1 }],
              topMarkers: [
                { group: '0', gene: 'CD3D', avgLog2FC: 2.5, pct1: 0.9, pct2: 0.1, pValAdj: 1e-9, rank: 1 },
              ],
            },
            resolvedParams: {
              groupBy: 'seurat_clusters',
              assay: 'RNA',
              onlyPositive: true,
              minPct: 0.1,
              logfcThreshold: 0.25,
              testUse: 'wilcox',
              maxCellsPerIdent: null,
              randomSeed: null,
              topMarkersPerCluster: 10,
            },
            storage_uri: 'vault/private/summary.json',
            state_key: 'user-1:obj-ao_abc123',
          },
        },
        {
          id: 'art_markers',
          artifactType: 'deg_markers',
          status: 'available',
          storageKind: 'local_internal',
          storageUri: 'vault/private/markers.csv',
          metadata: { nRows: 3, storageKey: 'vault/private/markers.csv' },
        },
      ]),
      apiRequest: vi.fn(),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('launches a durable DEG job instead of the legacy live-R endpoint', async () => {
    renderDeg();

    fireEvent.click(screen.getByRole('button', { name: /Launch Durable DEG Job/i }));

    await waitFor(() => {
      expect(window.electronAPI.createDegFindMarkersJob).toHaveBeenCalledTimes(1);
    });

    expect(window.electronAPI.createDegFindMarkersJob).toHaveBeenCalledWith(
      'proj_1',
      'ao_abc123',
      expect.objectContaining({
        groupBy: 'seurat_clusters',
        assay: 'RNA',
        onlyPositive: true,
        minPct: 0.1,
        logfcThreshold: 0.25,
        testUse: 'wilcox',
        topMarkersPerCluster: 10,
      })
    );
    expect(window.electronAPI.apiRequest).not.toHaveBeenCalled();
    expect(window.electronAPI.getProjectJob).toHaveBeenCalledWith('proj_1', 'job_abc123');
    expect(window.electronAPI.getProjectJobLogs).toHaveBeenCalledWith('proj_1', 'job_abc123');
    expect(window.electronAPI.listProjectJobArtifacts).toHaveBeenCalledWith('proj_1', 'job_abc123');

    expect(await screen.findByText('CD3D')).toBeInTheDocument();
    expect(screen.getByText(/summary available/i)).toBeInTheDocument();
    expect(screen.getByText(/art_summary/i)).toBeInTheDocument();
    expect(screen.getByText(/art_markers/i)).toBeInTheDocument();
  });

  it('does not render internal storage, state, or raw marker fields from public metadata', async () => {
    const { container } = renderDeg();

    fireEvent.click(screen.getByRole('button', { name: /Launch Durable DEG Job/i }));
    await screen.findByText('CD3D');

    const text = container.textContent || '';
    expect(text).not.toMatch(/vault\/private/i);
    expect(text).not.toMatch(/storage_uri/i);
    expect(text).not.toMatch(/storageKey/i);
    expect(text).not.toMatch(/state_key/i);
    expect(text).not.toMatch(/user-1:obj/i);
  });

  it('requires a selected DB-backed analysis object before launch', () => {
    renderDeg({
      datasetInfo: { id: 'legacy-object', projectId: 'proj_1', name: 'Legacy' },
      objectId: 'legacy-object',
    });

    expect(screen.getByRole('button', { name: /Launch Durable DEG Job/i })).toBeDisabled();
    expect(screen.getByText(/Select a DB-backed analysis object/i)).toBeInTheDocument();
  });
});
