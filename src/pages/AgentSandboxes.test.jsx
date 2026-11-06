import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentSandboxes from './AgentSandboxes';

const sandbox = {
  id: 'sbx_1', name: 'Markers', objective: 'Find markers', status: 'open', maxRuns: 5, runCount: 1, draftsAwaitingReview: 1,
  inputs: [{ analysisObjectId: 'obj_1', displayName: 'Clustered PBMC' }], runtime: { network: 'none' },
};
const run = {
  id: 'sbr_1', runNumber: 1, title: 'Cluster and plot', agent: { displayName: 'Analyst agent' }, state: 'draft_ready',
  steps: [{ number: 1, title: 'Cluster', code: 'stopifnot(TRUE)\nobj <- FindClusters(obj)', readable: 'obj <- FindClusters(obj)', hiddenLines: 1 }],
  files: [{ name: 'umap.png', kind: 'image', sizeBytes: 10 }, { name: 'markers.csv', kind: 'text', sizeBytes: 20 }],
  console: [], review: { state: 'draft' }, resultAnalysisObjectId: 'obj_2',
};

describe('AgentSandboxes', () => {
  beforeEach(() => {
    window.electronAPI = {
      listAgentSandboxes: vi.fn(async () => ({ sandboxes: [sandbox] })),
      listProjectAnalysisObjects: vi.fn(async () => [{ id: 'obj_1', displayName: 'Clustered PBMC', ownerUserId: 7 },
        { id: 'obj_9', displayName: 'Someone else', ownerUserId: 8 }]),
      getAgentSandbox: vi.fn(async () => ({ sandbox: { ...sandbox, runs: [run] } })),
      createAgentSandbox: vi.fn(async () => ({ sandbox: { id: 'sbx_2' } })),
      reviewAgentSandboxRun: vi.fn(async () => ({})),
      agentSandboxFileUrl: (p, r, n, o) => `/files/${r}/${n}${o?.download ? '?download=1' : ''}`,
      readAgentSandboxText: vi.fn(async () => 'gene,p\nCD3E,0.01\n'),
    };
  });
  afterEach(() => { delete window.electronAPI; vi.restoreAllMocks(); });

  it('creates a sandbox from the person\'s own saved analyses', async () => {
    render(<AgentSandboxes projectId="proj_1" role="analyst" userId={7} />);
    const form = await screen.findByRole('form', { name: /create a sandbox/i });
    expect(within(form).queryByText('Someone else')).not.toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText(/^name/i), { target: { value: 'Explore' } });
    fireEvent.click(await within(form).findByLabelText('Clustered PBMC'));
    fireEvent.click(within(form).getByRole('button', { name: /create sandbox/i }));
    await waitFor(() => expect(window.electronAPI.createAgentSandbox).toHaveBeenCalledWith('proj_1',
      { name: 'Explore', objective: '', analysisObjectIds: ['obj_1'], maxRuns: 20 }));
  });

  it('shows a draft run as readable steps with its outputs and promotes it', async () => {
    render(<AgentSandboxes projectId="proj_1" role="owner" userId={7} />);
    fireEvent.click(await screen.findByRole('button', { name: /markers/i }));
    const article = await screen.findByRole('article', { name: 'Run 1' });
    expect(within(article).getByText('obj <- FindClusters(obj)')).toBeInTheDocument();
    expect(within(article).getByText(/1 line of error handling hidden/)).toBeInTheDocument();
    fireEvent.click(within(article).getByRole('button', { name: 'Exact code' }));
    expect(within(article).getByText(/stopifnot\(TRUE\)/)).toBeInTheDocument();
    expect(within(article).getByRole('img', { name: 'umap.png' })).toHaveAttribute('src', '/files/sbr_1/umap.png');
    fireEvent.click(within(article).getByRole('button', { name: 'Preview' }));
    expect(await within(article).findByText(/CD3E/)).toBeInTheDocument();
    fireEvent.change(within(article).getByLabelText(/review note/i), { target: { value: 'Looks right' } });
    fireEvent.click(within(article).getByRole('button', { name: 'Promote' }));
    await waitFor(() => expect(window.electronAPI.reviewAgentSandboxRun).toHaveBeenCalledWith('proj_1', 'sbr_1', 'promoted', 'Looks right'));
  });

  it('offers the cluster with per-run resources once it is qualified', async () => {
    window.electronAPI.listComputeTargets = vi.fn(async () => ({ targets: [{ name: 'slurm', configured: true, sandbox: { ready: true } }] }));
    render(<AgentSandboxes projectId="proj_1" role="analyst" userId={7} />);
    const form = await screen.findByRole('form', { name: /create a sandbox/i });
    fireEvent.change(await within(form).findByLabelText(/runs on/i), { target: { value: 'slurm' } });
    fireEvent.change(within(form).getByLabelText(/cpus per run/i), { target: { value: '8' } });
    fireEvent.change(within(form).getByLabelText(/^name/i), { target: { value: 'Big' } });
    fireEvent.click(within(form).getByLabelText('Clustered PBMC'));
    fireEvent.click(within(form).getByRole('button', { name: /create sandbox/i }));
    await waitFor(() => expect(window.electronAPI.createAgentSandbox).toHaveBeenCalledWith('proj_1', expect.objectContaining({
      executionTarget: 'slurm', cpusPerRun: 8, memoryGiBPerRun: 32, hoursPerRun: 4 })));
  });

  it('explains why an unqualified cluster cannot be chosen', async () => {
    window.electronAPI.listComputeTargets = vi.fn(async () => ({ targets: [{ name: 'slurm', configured: true, sandbox: { ready: false, reason: 'The cluster has not been qualified. Run npm run slurm:qualify.' } }] }));
    render(<AgentSandboxes projectId="proj_1" role="analyst" userId={7} />);
    expect(await screen.findByText(/has not been qualified/)).toBeInTheDocument();
    expect(screen.getByLabelText(/runs on/i)).toBeDisabled();
  });

  it('does not offer review actions to viewers', async () => {
    render(<AgentSandboxes projectId="proj_1" role="viewer" userId={7} />);
    expect(screen.queryByRole('form', { name: /create a sandbox/i })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /markers/i }));
    await screen.findByRole('article', { name: 'Run 1' });
    expect(screen.queryByRole('button', { name: 'Promote' })).not.toBeInTheDocument();
  });
});
