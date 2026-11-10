import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentWorkflows from './AgentWorkflows';

const release = {
  id: 'rel_1', key: 'seurat-qc-cluster', version: '1', title: 'Seurat QC', jobType: 'seurat.pipeline.v1', digest: 'a'.repeat(64),
  handler: [{ path: 'backend/seuratPipeline.js', sha256: 'b'.repeat(64) }],
  parameterSchema: { clusterResolution: { type: 'number', min: 0.01, max: 10, default: 0.8 },
    normalizationMethod: { type: 'enum', values: ['LogNormalize', 'SCTransform'], default: 'LogNormalize' } },
  resources: { cpus: 1, memoryMiB: 8192, maxWallSeconds: 3600 }, inputs: [], outputs: [], approval: null,
};
const run = {
  id: 'run_1', studyId: 'study_1', studyName: 'Sweep', trialNumber: 1, agent: { displayName: 'Runner' },
  choices: { clusterResolution: 0.5 }, reservation: { cpuSeconds: 3600 }, state: 'candidate_ready', acceptance: 'none',
};

describe('AgentWorkflows', () => {
  beforeEach(() => {
    window.electronAPI = {
      listWorkflowReleases: vi.fn(async () => ({ canApprove: true, releases: [release] })),
      listStudies: vi.fn(async () => ({ studies: [{ id: 'study_1', name: 'Sweep', status: 'open', variations: { clusterResolution: [0.5, 0.8] }, maxTrials: 3, maxCpuSeconds: 10800, acceptedRunId: 'run_0' }] })),
      listAgentRuns: vi.fn(async () => ({ runs: [run] })),
      listDatasets: vi.fn(async () => [{ id: 'ds_1', originalFilename: 'pbmc.h5', uploadStatus: 'uploaded' }]),
      approveWorkflowRelease: vi.fn(async () => ({})),
      createStudy: vi.fn(async () => ({})),
      acceptAgentRun: vi.fn(async () => ({})),
    };
  });
  afterEach(() => { delete window.electronAPI; vi.restoreAllMocks(); });

  it('approves the exact reviewed digest', async () => {
    render(<AgentWorkflows projectId="proj_1" role="owner" />);
    fireEvent.click(await screen.findByRole('button', { name: /approve this exact release/i }));
    await waitFor(() => expect(window.electronAPI.approveWorkflowRelease).toHaveBeenCalledWith('proj_1', 'rel_1', 'a'.repeat(64)));
  });

  it('accepts a candidate against the currently accepted baseline', async () => {
    render(<AgentWorkflows projectId="proj_1" role="analyst" />);
    fireEvent.click(await screen.findByRole('button', { name: /accept this result/i }));
    await waitFor(() => expect(window.electronAPI.acceptAgentRun).toHaveBeenCalledWith('proj_1', 'run_1', 'run_0'));
  });

  it('compares trials of a study side by side with their result metrics', async () => {
    window.electronAPI.listAgentRuns = vi.fn(async () => ({ runs: [
      { ...run, id: 'run_2', trialNumber: 2, choices: { clusterResolution: 1.2 }, summary: { n_cells: 2638, n_clusters: 11, used_seed: 7 } },
      { ...run, summary: { n_cells: 2638, n_clusters: 7, used_seed: 7 } },
    ] }));
    render(<AgentWorkflows projectId="proj_1" role="viewer" />);
    const table = await screen.findByRole('table', { name: /trials for sweep/i });
    const rows = table.querySelectorAll('tbody tr');
    expect([...rows].map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^1.*0\.5.*2,638.*7/), expect.stringMatching(/^2.*1\.2.*2,638.*11/),
    ]);
    expect(table.textContent).toContain('Clusters');
    expect(table.textContent).not.toContain('Seed');
    expect(screen.queryByRole('button', { name: /accept this result/i })).not.toBeInTheDocument();
  });

  it('creates a follow-on study on the accepted result of a clustering study', async () => {
    const markers = { ...release, id: 'rel_2', key: 'seurat-markers', title: 'Markers', jobType: 'deg.find_markers.v1',
      inputs: [{ name: 'clustering', kind: 'analysis_object', fromReleases: ['seurat-qc-cluster'] }],
      parameterSchema: { logfcThreshold: { type: 'number', min: 0, max: 10, default: 0.25 } }, approval: { id: 'wfa_2' } };
    window.electronAPI.listWorkflowReleases = vi.fn(async () => ({ canApprove: false, releases: [{ ...release, approval: { id: 'wfa_1' } }, markers] }));
    window.electronAPI.listStudies = vi.fn(async () => ({ studies: [
      { id: 'study_1', name: 'Sweep', releaseId: 'rel_1', status: 'open', variations: {}, maxTrials: 3, maxCpuSeconds: 10800, acceptedRunId: 'run_1' },
      { id: 'study_3', name: 'Unaccepted', releaseId: 'rel_1', status: 'open', variations: {}, maxTrials: 3, maxCpuSeconds: 10800, acceptedRunId: null },
    ] }));
    render(<AgentWorkflows projectId="proj_1" role="analyst" />);
    fireEvent.change(await screen.findByLabelText('Study name'), { target: { value: 'Markers' } });
    fireEvent.change(screen.getByLabelText('Approved release'), { target: { value: 'rel_2' } });
    expect(screen.queryByText('pbmc.h5')).not.toBeInTheDocument();
    const source = screen.getByLabelText(/Builds on the accepted result of/);
    expect([...source.options].map((o) => o.textContent)).toEqual(['Choose a study…', 'Sweep']);
    expect(screen.getByRole('button', { name: /create study/i })).toBeDisabled();
    fireEvent.change(source, { target: { value: 'study_1' } });
    fireEvent.click(screen.getByRole('button', { name: /create study/i }));
    await waitFor(() => expect(window.electronAPI.createStudy).toHaveBeenCalledWith('proj_1', expect.objectContaining({
      name: 'Markers', releaseId: 'rel_2', sourceStudyId: 'study_1' })));
    expect(window.electronAPI.createStudy.mock.calls[0][1].datasetIds).toBeUndefined();
  });

  it('offers accepted studies of every source release of a multi-source follow-on release', async () => {
    const multi = { ...release, id: 'rel_m', key: 'seurat-multisample', title: 'Multi-sample', approval: { id: 'wfa_m' } };
    const workbench = { ...release, id: 'rel_w', key: 'study-workbench', title: 'Workbench', jobType: 'explore.summarize.v1',
      inputs: [{ name: 'clustering', kind: 'analysis_object', fromReleases: ['seurat-qc-cluster', 'seurat-multisample'] }],
      parameterSchema: { featureNames: { type: 'geneList' } }, approval: { id: 'wfa_w' } };
    window.electronAPI.listWorkflowReleases = vi.fn(async () => ({
      canApprove: false, releases: [{ ...release, approval: { id: 'wfa_1' } }, multi, workbench],
    }));
    window.electronAPI.listStudies = vi.fn(async () => ({ studies: [
      { id: 'study_1', name: 'Single sweep', releaseId: 'rel_1', status: 'open', variations: {}, maxTrials: 3, maxCpuSeconds: 10800, acceptedRunId: 'run_1' },
      { id: 'study_2', name: 'Donor sweep', releaseId: 'rel_m', status: 'open', variations: {}, maxTrials: 3, maxCpuSeconds: 10800, acceptedRunId: 'run_2' },
    ] }));
    render(<AgentWorkflows projectId="proj_1" role="analyst" />);
    fireEvent.change(await screen.findByLabelText('Study name'), { target: { value: 'Investigate' } });
    fireEvent.change(screen.getByLabelText('Approved release'), { target: { value: 'rel_w' } });
    const source = screen.getByLabelText(/Builds on the accepted result of/);
    expect([...source.options].map((o) => o.textContent)).toEqual(['Choose a study…', 'Single sweep', 'Donor sweep']);
    fireEvent.change(source, { target: { value: 'study_2' } });
    fireEvent.click(screen.getByRole('button', { name: /create study/i }));
    await waitFor(() => expect(window.electronAPI.createStudy).toHaveBeenCalledWith('proj_1', expect.objectContaining({
      releaseId: 'rel_w', sourceStudyId: 'study_2' })));
  });

  it('opens a candidate result in the workspace', async () => {
    window.electronAPI.listAgentRuns = vi.fn(async () => ({ runs: [{ ...run, resultAnalysisObjectId: 'ao_1' }] }));
    const onOpenResult = vi.fn();
    render(<AgentWorkflows projectId="proj_1" role="viewer" onOpenResult={onOpenResult} />);
    fireEvent.click(await screen.findByRole('button', { name: /open in workspace/i }));
    expect(onOpenResult).toHaveBeenCalledWith('ao_1');
  });

  it('marks the trial the study rule recommends and sends a chosen rule', async () => {
    window.electronAPI.listStudies = vi.fn(async () => ({ studies: [{ id: 'study_1', name: 'Sweep', status: 'open', variations: {}, maxTrials: 3, maxCpuSeconds: 10800, acceptedRunId: null, selectionRule: { metric: 'nClusters', goal: 'max' } }] }));
    window.electronAPI.listAgentRuns = vi.fn(async () => ({ runs: [
      { ...run, summary: { nClusters: 7 } },
      { ...run, id: 'run_2', trialNumber: 2, summary: { nClusters: 11 } },
      { ...run, id: 'run_3', trialNumber: 3, state: 'failed', summary: { nClusters: 99 } },
    ] }));
    render(<AgentWorkflows projectId="proj_1" role="viewer" />);
    const table = await screen.findByRole('table', { name: /trials for sweep/i });
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows[1].textContent).toContain('Best by rule');
    expect(rows[0].textContent + rows[2].textContent).not.toContain('Best by rule');
    expect(screen.getByText(/rule: most Clusters/)).toBeInTheDocument();
  });

  it('creates a study with typed allowed values and hides approval from non-managers', async () => {
    window.electronAPI.listWorkflowReleases = vi.fn(async () => ({ canApprove: false, releases: [{ ...release, approval: { id: 'wfa_1' } }] }));
    render(<AgentWorkflows projectId="proj_1" role="analyst" />);
    fireEvent.change(await screen.findByLabelText('Study name'), { target: { value: 'Sweep 2' } });
    fireEvent.click(await screen.findByLabelText('pbmc.h5'));
    fireEvent.change(screen.getByLabelText('Parameter the agent may vary'), { target: { value: 'clusterResolution' } });
    fireEvent.change(screen.getByLabelText(/Allowed values/), { target: { value: '0.5, 1.2' } });
    fireEvent.change(screen.getByLabelText('Selection metric'), { target: { value: 'nClusters' } });
    fireEvent.change(screen.getByLabelText('Selection goal'), { target: { value: 'min' } });
    fireEvent.click(screen.getByRole('button', { name: /create study/i }));
    await waitFor(() => expect(window.electronAPI.createStudy).toHaveBeenCalledWith('proj_1', {
      name: 'Sweep 2', releaseId: 'rel_1', datasetIds: ['ds_1'], maxTrials: 4, variations: { clusterResolution: [0.5, 1.2] }, selectionRule: { metric: 'nClusters', goal: 'min' },
    }));
    expect(screen.queryByRole('button', { name: /^revoke$/i })).not.toBeInTheDocument();
  });

  it('offers the Slurm target only when the cluster is available and sends it with the study', async () => {
    window.electronAPI.listWorkflowReleases = vi.fn(async () => ({ canApprove: false, releases: [{ ...release, approval: { id: 'wfa_1' } }] }));
    window.electronAPI.listComputeTargets = vi.fn(async () => ({ targets: [{ name: 'local', available: true }, { name: 'slurm', available: true, partition: 'normal' }] }));
    render(<AgentWorkflows projectId="proj_1" role="analyst" />);
    fireEvent.change(await screen.findByLabelText('Study name'), { target: { value: 'HPC sweep' } });
    fireEvent.click(await screen.findByLabelText('pbmc.h5'));
    fireEvent.change(await screen.findByLabelText('Runs on'), { target: { value: 'slurm' } });
    fireEvent.click(screen.getByRole('button', { name: /create study/i }));
    await waitFor(() => expect(window.electronAPI.createStudy).toHaveBeenCalledWith('proj_1', expect.objectContaining({ executionTarget: 'slurm' })));
  });

  it('hides the target choice when no cluster is available', async () => {
    window.electronAPI.listWorkflowReleases = vi.fn(async () => ({ canApprove: false, releases: [{ ...release, approval: { id: 'wfa_1' } }] }));
    window.electronAPI.listComputeTargets = vi.fn(async () => ({ targets: [{ name: 'local', available: true }, { name: 'slurm', available: false }] }));
    render(<AgentWorkflows projectId="proj_1" role="analyst" />);
    await screen.findByLabelText('Study name');
    await waitFor(() => expect(window.electronAPI.listComputeTargets).toHaveBeenCalled());
    expect(screen.queryByLabelText('Runs on')).not.toBeInTheDocument();
  });
});
