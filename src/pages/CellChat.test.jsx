import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CellChat from './CellChat';

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
    <CellChat
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
      callApi={vi.fn(async (path) => path.includes('preflight=true')
        ? { ready: true }
        : { error: 'Owner group key unavailable.' })}
      {...overrides}
    />
  );
}

describe('CellChat durable worker UI', () => {
  beforeEach(() => {
    localStorage.clear();
    window.electronAPI = {
      createCellChatInferenceJob: vi.fn(async () => ({
        id: 'job_cellchat123',
        status: 'queued',
        jobType: 'cellchat.infer.v1',
        analysisObjectId: 'ao_abc123',
        parameters: {},
      })),
      getProjectJob: vi.fn(async () => ({
        id: 'job_cellchat123',
        status: 'completed',
        jobType: 'cellchat.infer.v1',
        analysisObjectId: 'ao_abc123',
        parameters: {
          groupBy: 'seurat_clusters',
          assay: 'RNA',
          species: 'human',
          databaseCategory: 'all',
          analysisIntent: 'single_context',
        },
      })),
      getProjectJobLogs: vi.fn(async () => ({
        logs: [{
          ts: '2026-07-18T00:00:00.000Z',
          level: 'info',
          message: 'Wrote vault/private/cellchat.csv with storage_key projects/proj_1/state_key user-1:obj-ao_abc123',
        }],
      })),
      listProjectJobArtifacts: vi.fn(async () => [
        {
          id: 'art_cellchat_summary',
          artifactType: 'cellchat_summary',
          status: 'available',
          storageKind: 'metadata_only',
          metadata: {
            resolvedParams: {
              groupBy: 'seurat_clusters',
              assay: 'RNA',
              species: 'human',
              databaseCategory: 'all',
              analysisIntent: 'single_context',
            },
            summary: {
              groupBy: 'seurat_clusters',
              assay: 'RNA',
              species: 'human',
              databaseCategory: 'all',
              analysisIntent: 'single_context',
              inputCellCount: 1800,
              analyzedCellCount: 1500,
              inputGroupCount: 4,
              analyzedGroupCount: 3,
              excludedGroupCount: 1,
              candidateInteractionCount: 120,
              retainedInteractionCount: 12,
              retainedPathwayCount: 3,
              groups: [
                { group: 'Group 1', inputCells: 600, analyzedCells: 500 },
                { group: 'Private donor identity', inputCells: 600, analyzedCells: 500 },
              ],
              excludedGroups: [
                { group: 'Group 4', inputCells: 4, reason: 'Below minimum cell count' },
                { group: 'Private donor identity', inputCells: 4, reason: 'Below minimum cell count' },
              ],
              topInteractions: [{
                source: 'Group 1',
                target: 'Group 2',
                ligand: 'IL7',
                receptor: 'IL7R',
                pathway: 'IL7',
                probability: 0.82,
                pValue: 0.01,
              }, {
                source: 'Private donor identity',
                target: 'Group 2',
                interaction: 'Unsafe ligand candidate',
                pathway: 'IL7',
                probability: 0.5,
                pValue: 0.01,
              }],
              topPathways: [{
                source: 'Group 1',
                target: 'Group 2',
                pathway: 'IL7',
                probability: 0.82,
                pValue: 0.01,
              }, {
                source: 'Group 1',
                target: 'Private donor identity',
                pathway: 'Unsafe pathway',
                probability: 0.5,
                pValue: 0.01,
              }],
              packageVersions: { r: '4.5.3', seurat: '5.3.1', cellchat: '2.1.2' },
              warnings: ['The private details are at C:/private/cellchat.csv storage_key projects/proj_1'],
              storageUri: 'vault/private/summary.json',
            },
            storageUri: 'vault/private/summary.json',
          },
        },
        {
          id: 'art_cellchat_results',
          artifactType: 'cellchat_results',
          status: 'available',
          storageKind: 'local_internal',
          storageUri: 'vault/private/cellchat.csv',
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

  it('requires explicit scientific choices and launches only the fixed CellChat v1 contract', async () => {
    const { container } = renderPage();
    const launchButton = screen.getByRole('button', { name: /Start CellChat Inference/i });
    expect(launchButton).toBeDisabled();

    fireEvent.change(screen.getByRole('combobox', { name: /Group labels/i }), { target: { value: 'seurat_clusters' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Species/i }), { target: { value: 'human' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Database category/i }), { target: { value: 'all' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Analysis intent/i }), { target: { value: 'single_context' } });
    expect(launchButton).not.toBeDisabled();

    fireEvent.click(launchButton);

    await waitFor(() => expect(window.electronAPI.createCellChatInferenceJob).toHaveBeenCalledTimes(1));
    expect(window.electronAPI.createCellChatInferenceJob).toHaveBeenCalledWith(
      'proj_1',
      'ao_abc123',
      {
        groupBy: 'seurat_clusters',
        assay: 'RNA',
        species: 'human',
        databaseCategory: 'all',
        analysisIntent: 'single_context',
        minCellsPerGroup: 10,
        maxCellsPerGroup: 5000,
        maxTotalCells: 10000,
        pValueCutoff: 0.05,
        topInteractions: 25,
        topPathways: 15,
        randomSeed: 1,
      }
    );
    expect(window.electronAPI.apiRequest).not.toHaveBeenCalled();

    expect((await screen.findAllByText('IL7')).length).toBeGreaterThan(0);
    expect(screen.getByText('IL7–IL7R')).toBeInTheDocument();
    expect(screen.getByText('600 input cells')).toBeInTheDocument();
    expect(screen.getByText('500 analyzed cells')).toBeInTheDocument();
    expect(screen.getAllByRole('cell', { name: 'Group 1' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('cell', { name: 'Group 2' }).length).toBeGreaterThan(0);
    expect(screen.getByText(/A saved summary is available/i)).toBeInTheDocument();
    expect(screen.getByText(/full interaction table is available only through its authorized export/i)).toBeInTheDocument();
    expect(screen.queryByText(/art_cellchat_summary|art_cellchat_results/i)).not.toBeInTheDocument();

    const text = container.textContent || '';
    expect(text).not.toMatch(/r 4\.5\.3/i);
    expect(text).not.toMatch(/vault\/private/i);
    expect(text).not.toMatch(/C:\/private/i);
    expect(text).not.toMatch(/storage_key/i);
    expect(text).not.toMatch(/state_key/i);
    expect(text).not.toMatch(/user-1:obj/i);
    expect(text).not.toMatch(/Private donor identity/i);
    expect(text).not.toMatch(/Unsafe ligand candidate|Unsafe pathway/i);
    expect(text).not.toMatch(/art_cellchat_summary|art_cellchat_results|job_cellchat/i);
  });

  it('renders a private owner-local group key without persisting labels into the durable summary', async () => {
    const callApi = vi.fn(async (path) => path.includes('preflight=true') ? { ready: true } : ({
        group_by: 'seurat_clusters',
        groups: [
          { group: 'Group 1', label: 'CD4 T cells', input_cells: 600 },
          { group: 'Group 2', label: 'B cells', input_cells: 600 },
        ],
      }));
    renderPage({ callApi });
    const launchButton = screen.getByRole('button', { name: /Start CellChat Inference/i });
    fireEvent.change(screen.getByRole('combobox', { name: /Group labels/i }), { target: { value: 'seurat_clusters' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Species/i }), { target: { value: 'human' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Database category/i }), { target: { value: 'all' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Analysis intent/i }), { target: { value: 'single_context' } });
    fireEvent.click(launchButton);

    await waitFor(() => expect(callApi).toHaveBeenCalledWith(
      '/cellchat-group-map?group_by=seurat_clusters',
      {},
      { useCache: false },
    ));
    expect(await screen.findByText('CD4 T cells')).toBeInTheDocument();
    expect(screen.getByText('B cells')).toBeInTheDocument();
    expect(screen.getByText(/not saved with the shared result/i)).toBeInTheDocument();
    expect(window.electronAPI.listProjectJobArtifacts.mock.calls[0]).toBeDefined();
  });

  it('shows a specific preflight remediation and does not queue an invalid run', async () => {
    const callApi = vi.fn(async () => ({ ready: false, code: 'CELLCHAT_MIN_GROUP_CELLS' }));
    renderPage({ callApi });
    fireEvent.change(screen.getByRole('combobox', { name: /Group labels/i }), { target: { value: 'seurat_clusters' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Species/i }), { target: { value: 'human' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Database category/i }), { target: { value: 'all' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Analysis intent/i }), { target: { value: 'single_context' } });
    fireEvent.click(screen.getByRole('button', { name: /Start CellChat Inference/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/At least two groups must meet the minimum cell threshold/i);
    expect(window.electronAPI.createCellChatInferenceJob).not.toHaveBeenCalled();
  });

  it('states that CellChat results are candidate predictions, not causal or condition comparisons', () => {
    renderPage();

    expect(screen.getByText(/CellChat produces candidate predictions/i)).toBeInTheDocument();
    expect(screen.getByText(/does not prove that cells communicated, physically contacted, or caused a response/i)).toBeInTheDocument();
    expect(screen.getByText(/This v1 supports one biological context only/i)).toBeInTheDocument();
    expect(screen.getByText(/condition or patient comparisons/i)).toBeInTheDocument();
  });

  it('lets project viewers inspect saved summaries but not start new CellChat work', () => {
    renderPage({
      currentWs: {
        ...currentWs,
        projects: currentWs.projects.map(project => ({ ...project, role: 'viewer' })),
      },
    });

    expect(screen.getByRole('button', { name: /Start CellChat Inference/i })).toBeDisabled();
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

    expect(screen.getByRole('button', { name: /Start CellChat Inference/i })).toBeDisabled();
    expect(screen.getByText(/not open in your private analysis workspace/i)).toBeInTheDocument();
  });

  it.each([true, false])('routes the PBMC recovery action consistently when curatedDemo=%s', curatedDemo => {
    const setActiveTab = vi.fn();
    renderPage({ setActiveTab, datasetInfo: { id: 'ao_abc123', projectId: 'proj_1', name: 'PBMC 3k',
      liveState: 'not_attached', source: 'pbmc3k_demo', metadata: { curatedDemo } } });
    const button = screen.getByRole('button', { name: curatedDemo ? 'Open Runs & Results' : 'Open workspace', exact: true });
    fireEvent.click(button);
    expect(setActiveTab).toHaveBeenCalledWith(curatedDemo ? 'history' : 'workspace');
    expect(window.electronAPI.createCellChatInferenceJob).not.toHaveBeenCalled();
  });

  it('restores the latest saved CellChat job for the selected object', async () => {
    window.electronAPI.listProjectJobs.mockResolvedValueOnce([{
      id: 'job_cellchat123',
      status: 'completed',
      jobType: 'cellchat.infer.v1',
      analysisObjectId: 'ao_abc123',
    }]);

    renderPage();

    await waitFor(() => expect(window.electronAPI.listProjectJobs).toHaveBeenCalledWith(
      'proj_1',
      { jobType: 'cellchat.infer.v1', analysisObjectId: 'ao_abc123' }
    ));
    expect(await screen.findByText('IL7–IL7R')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Recorded run settings/i })).toBeInTheDocument();
    expect(screen.getByText('Advanced options')).toBeInTheDocument();
  });

  it('requires saving live clustering changes before a durable CellChat run', () => {
    const save = vi.fn();
    renderPage({ unsavedLiveChanges: true, onSaveCurrentAnalysis: save });

    expect(screen.getByRole('button', { name: /Start CellChat Inference/i })).toBeDisabled();
    expect(screen.getByText(/Unsaved live steps will not be included/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save current analysis/i }));
    expect(save).toHaveBeenCalledOnce();
    expect(window.electronAPI.createCellChatInferenceJob).not.toHaveBeenCalled();
  });
});
