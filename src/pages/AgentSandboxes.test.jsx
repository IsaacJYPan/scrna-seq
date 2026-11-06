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
  steps: [{ number: 1, title: 'Cluster', code: 'stopifnot(TRUE)\nobj <- FindClusters(obj)\nsave_figure(p, "umap.png")', readable: 'obj <- FindClusters(obj)', hiddenLines: 1 }],
  files: [{ name: 'umap.png', kind: 'image', sizeBytes: 10 }, { name: 'markers.csv', kind: 'text', sizeBytes: 20 }],
  console: [], review: { state: 'draft' }, resultAnalysisObjectId: 'obj_2',
};

describe('AgentSandboxes', () => {
  beforeEach(() => {
    if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
    if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
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

  it('shows a draft run as a notebook with outputs under the step that wrote them, and promotes it', async () => {
    render(<AgentSandboxes projectId="proj_1" role="owner" userId={7} />);
    fireEvent.click(await screen.findByRole('button', { name: /markers/i }));
    const article = await screen.findByRole('article', { name: 'Run 1' });
    const notebook = within(article).getByLabelText('Notebook for run 1');
    expect(within(notebook).getByRole('region', { name: 'Markdown cell 1' })).toHaveTextContent('1. Cluster');
    const code = within(notebook).getByRole('region', { name: 'R cell 2' });
    expect(within(code).getByLabelText('R cell 2 source')).toHaveTextContent('obj <- FindClusters(obj)');
    expect(code).toHaveTextContent('1 line of error handling hidden');
    expect(within(code).getByRole('img', { name: 'umap.png' })).toHaveAttribute('src', '/files/sbr_1/umap.png');
    fireEvent.click(within(code).getByRole('button', { name: 'Show table' }));
    expect(await within(code).findByText(/CD3E/)).toBeInTheDocument();
    fireEvent.click(within(notebook).getByRole('button', { name: 'Exact code' }));
    expect(within(notebook).getByLabelText('R cell 2 source')).toHaveTextContent('stopifnot(TRUE)');
    fireEvent.change(within(article).getByLabelText(/review note/i), { target: { value: 'Looks right' } });
    fireEvent.click(within(article).getByRole('button', { name: 'Promote' }));
    await waitFor(() => expect(window.electronAPI.reviewAgentSandboxRun).toHaveBeenCalledWith('proj_1', 'sbr_1', 'promoted', 'Looks right'));
  });

  it('saves a run as a notebook in a chosen analysis', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const body = String(url).includes('/documents')
        ? { document: { id: 'doc_1' } } : { analyses: [{ id: 'ana_1', name: 'PBMC study' }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    render(<AgentSandboxes projectId="proj_1" role="analyst" userId={7} />);
    fireEvent.click(await screen.findByRole('button', { name: /markers/i }));
    const article = await screen.findByRole('article', { name: 'Run 1' });
    fireEvent.click(within(article).getByRole('button', { name: 'Save as notebook' }));
    expect(await within(article).findByLabelText('Save to analysis')).toHaveValue('ana_1');
    fireEvent.click(within(article).getByRole('button', { name: 'Save' }));
    expect(await within(article).findByText(/Saved as a notebook in PBMC study/)).toBeInTheDocument();
    const created = calls.find((c) => c.url.endsWith('/api/projects/proj_1/analyses/ana_1/documents'));
    const body = JSON.parse(created.init.body);
    expect(body.title).toBe('Agent run 1: Cluster and plot');
    expect(body.content.cells.filter((c) => c.type === 'code').map((c) => c.source)).toEqual(['obj <- FindClusters(obj)']);
    vi.unstubAllGlobals();
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
