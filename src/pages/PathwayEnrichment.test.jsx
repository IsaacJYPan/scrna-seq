import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PathwayEnrichment from './PathwayEnrichment';

const currentWs = {
  id: 'ws-1',
  name: 'Personal Workspace',
  projects: [{ id: 'proj_1', name: 'PBMC Project', role: 'owner' }],
  selectedProjectId: 'proj_1',
  objects: [{ id: 'ao_abc123', projectId: 'proj_1', displayName: 'PBMC 3k' }],
  selectedObjectIds: ['ao_abc123'],
};

function renderPage(overrides = {}) {
  return render(
    <PathwayEnrichment
      datasetInfo={{
        id: 'ao_abc123',
        projectId: 'proj_1',
        name: 'PBMC 3k',
        liveState: 'attached',
      }}
      currentWs={currentWs}
      userEmail="owner@example.com"
      objectId="ao_abc123"
      sessionReady
      callApi={vi.fn(async () => ({ values: [{ value: '0', count: 100 }] }))}
      {...overrides}
    />
  );
}

describe('PathwayEnrichment durable worker UI', () => {
  beforeEach(() => {
    localStorage.clear();
    window.electronAPI = {
      createEnrichmentGseaJob: vi.fn(async () => ({
        id: 'job_enrich123',
        status: 'queued',
        jobType: 'enrichment.gsea.v1',
        analysisObjectId: 'ao_abc123',
        parameters: {},
      })),
      getProjectJob: vi.fn(async () => ({
        id: 'job_enrich123',
        status: 'completed',
        jobType: 'enrichment.gsea.v1',
        analysisObjectId: 'ao_abc123',
        parameters: { targetGroup: '0', species: 'human' },
      })),
      getProjectJobLogs: vi.fn(async () => ({
        logs: [{
          ts: '2026-07-17T00:00:00.000Z',
          level: 'info',
          message: 'Finished result in vault/private/enrichment.csv with state_key user-1:obj-ao_abc123',
        }],
      })),
      listProjectJobArtifacts: vi.fn(async () => [
        {
          id: 'art_enrichment_summary',
          artifactType: 'enrichment_summary',
          status: 'available',
          storageKind: 'metadata_only',
          metadata: {
            resolvedParams: {
              targetGroup: '0',
              species: 'human',
              adjustedPValueCutoff: 0.01,
            },
            summary: {
              method: 'gsea',
              comparison: { targetGroup: '0', reference: 'rest' },
              groupBy: 'seurat_clusters',
              assay: 'RNA',
              species: 'human',
              geneSetCollection: 'GO_BP',
              rankMetric: 'avg_log2FC',
              inputGeneCount: 19000,
              mappedGeneCount: 18000,
              mappingRate: 0.947,
              testedPathwayCount: 6120,
              significantPathwayCount: 2,
              packageVersions: {
                r: '4.5.3',
                seurat: '5.3.1',
                annotationDbi: '1.72.0',
                goDb: '3.22.0',
                clusterProfiler: '4.16.0',
                fgsea: '1.34.0',
                organismDb: 'org.Hs.eg.db 3.21.0',
              },
              topPathways: [{
                id: 'GO:0006955',
                name: 'immune response',
                normalizedEnrichmentScore: 2.14,
                pValue: 0.00001,
                adjustedPValue: 0.002,
                setSize: 140,
                direction: 'positive',
              }],
              warnings: ['Some symbols were not mapped; details at C:/private/mapping.txt storage_key'],
            },
            storageUri: 'vault/private/summary.json',
          },
        },
        {
          id: 'art_enrichment_results',
          artifactType: 'enrichment_results',
          status: 'available',
          storageKind: 'local_internal',
          storageUri: 'vault/private/enrichment.csv',
        },
      ]),
      listProjectJobs: vi.fn(async () => []),
      apiRequest: vi.fn(),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('requires an explicit species and launches the fixed durable GSEA job', async () => {
    const { container } = renderPage();
    const launchButton = screen.getByRole('button', { name: /Start Pathway Enrichment/i });
    expect(launchButton).toBeDisabled();

    await waitFor(() => expect(screen.getByRole('combobox', { name: /Target cluster or group/i })).not.toBeDisabled());
    fireEvent.change(screen.getByRole('combobox', { name: /Target cluster or group/i }), { target: { value: '0' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Species/i }), { target: { value: 'human' } });
    expect(launchButton).not.toBeDisabled();
    fireEvent.click(launchButton);

    await waitFor(() => expect(window.electronAPI.createEnrichmentGseaJob).toHaveBeenCalledTimes(1));
    expect(window.electronAPI.createEnrichmentGseaJob).toHaveBeenCalledWith(
      'proj_1',
      'ao_abc123',
      expect.objectContaining({
        groupBy: 'seurat_clusters',
        assay: 'RNA',
        targetGroup: '0',
        species: 'human',
        geneSetCollection: 'GO_BP',
        minGeneSetSize: 15,
        maxGeneSetSize: 500,
        adjustedPValueCutoff: 0.05,
        topPathways: 15,
        maxCellsPerIdent: 10000,
        randomSeed: 1,
      })
    );
    expect(window.electronAPI.apiRequest).not.toHaveBeenCalled();

    expect(await screen.findByText('immune response')).toBeInTheDocument();
    expect(screen.getByText('higher in target')).toBeInTheDocument();
    expect(screen.getByText(/Adjusted p ≤ 0\.010/)).toBeInTheDocument();
    expect(screen.getByText(/94.7%/i)).toBeInTheDocument();
    expect(screen.getByText(/A saved summary is available/i)).toBeInTheDocument();
    expect(screen.getByText(/private result table is available/i)).toBeInTheDocument();
    expect(screen.queryByText(/art_enrichment_summary|art_enrichment_results/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Saved with R 4\.5\.3 and Seurat 5\.3\.1/i)).toBeInTheDocument();

    const text = container.textContent || '';
    expect(text).not.toMatch(/vault\/private/i);
    expect(text).not.toMatch(/C:\/private/i);
    expect(text).not.toMatch(/state_key/i);
    expect(text).not.toMatch(/user-1:obj/i);
    expect(text).not.toMatch(/art_enrichment_summary|art_enrichment_results|job_enrichment/i);
  });

  it('explains that enrichment is descriptive and is not proof of pathway activity', () => {
    renderPage();

    expect(screen.getByText(/does not prove that the pathway is active/i)).toBeInTheDocument();
    expect(screen.getByText(/sample-aware study design/i)).toBeInTheDocument();
    expect(screen.getByText(/human and mouse gene identifiers use different reference databases/i)).toBeInTheDocument();
  });

  it('does not allow launch for an unsaved legacy object', () => {
    renderPage({
      datasetInfo: {
        id: 'legacy-object',
        projectId: 'proj_1',
        name: 'Legacy',
        liveState: 'attached',
      },
      objectId: 'legacy-object',
    });

    expect(screen.getByRole('button', { name: /Start Pathway Enrichment/i })).toBeDisabled();
    expect(screen.getByText(/Select a saved analysis before starting pathway enrichment/i)).toBeInTheDocument();
  });

  it('restores the latest saved pathway job for the selected object', async () => {
    window.electronAPI.listProjectJobs.mockResolvedValueOnce([{
      id: 'job_enrich123',
      status: 'completed',
      jobType: 'enrichment.gsea.v1',
      analysisObjectId: 'ao_abc123',
    }]);

    renderPage();

    await waitFor(() => expect(window.electronAPI.listProjectJobs).toHaveBeenCalledWith(
      'proj_1',
      { jobType: 'enrichment.gsea.v1', analysisObjectId: 'ao_abc123' }
    ));
    expect(await screen.findByText('immune response')).toBeInTheDocument();
  });

  it('lets project viewers inspect saved results but not start a new job', () => {
    renderPage({
      currentWs: {
        ...currentWs,
        projects: currentWs.projects.map(project => ({ ...project, role: 'viewer' })),
      },
    });

    expect(screen.getByRole('button', { name: /Start Pathway Enrichment/i })).toBeDisabled();
    expect(screen.getByText(/project role is read-only/i)).toBeInTheDocument();
  });

  it('does not start work until the selected object is attached to private R state', () => {
    renderPage({
      datasetInfo: {
        id: 'ao_abc123',
        projectId: 'proj_1',
        name: 'PBMC 3k',
        liveState: 'not_attached',
      },
    });

    expect(screen.getByRole('button', { name: /Start Pathway Enrichment/i })).toBeDisabled();
    expect(screen.getByText(/not open in your private analysis workspace/i)).toBeInTheDocument();
  });

  it('offers bounded cluster labels from the attached private R object', async () => {
    const callApi = vi.fn(async () => ({
      values: [{ value: '2', count: 40 }, { value: 'CD8 T cells', count: 20 }],
    }));
    const { container } = renderPage({ callApi, rSessionId: 'session-1' });

    await waitFor(() => expect(callApi).toHaveBeenCalledWith('/meta-values?column=seurat_clusters'));
    expect(container.querySelector('option[value="2"]')).not.toBeNull();
    expect(container.querySelector('option[value="CD8 T cells"]')).not.toBeNull();
  });

  it('blocks stale-checkpoint launches while live changes are unsaved', async () => {
    const save = vi.fn();
    renderPage({ unsavedLiveChanges: true, onSaveCurrentAnalysis: save });

    expect(screen.getByRole('button', { name: /Start Pathway Enrichment/i })).toBeDisabled();
    expect(screen.getByText(/Unsaved live steps will not be included/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save current analysis/i }));
    expect(save).toHaveBeenCalledOnce();
  });

  it('disables enrichment when the compute worker lacks its approved package profile', () => {
    renderPage({ computeStatus: { status: 'ready', capabilities: { pathwayEnrichment: false } } });

    expect(screen.getByRole('button', { name: /Start Pathway Enrichment/i })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/not installed in this compute profile/i);
  });
});
