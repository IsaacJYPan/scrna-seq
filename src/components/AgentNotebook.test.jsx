import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentNotebook, { AgentWorkDock, notebookTabForAppTab } from './AgentNotebook';

const agent = { displayName: 'Analyst agent' };
const cells = [
  { kind: 'note', id: 'nbn_1', tab: 'qc', createdAt: '2026-11-20T10:00:00Z', agent, markdown: 'First I check **doublets**.' },
  { kind: 'verified', id: 'run_1', tab: 'qc', createdAt: '2026-11-20T10:01:00Z', agent, authorship: 'verified',
    study: { id: 'study_1', name: 'Doublets', objective: 'Remove doublets before clustering.' }, trialNumber: 1,
    release: { id: 'rel_1', key: 'doublets-scdblfinder', version: '1', title: 'Doublet detection (scDblFinder)' },
    choices: { dbr: 0.08 }, inputAnalysisObjectId: 'obj_1', resultAnalysisObjectId: 'obj_2', state: 'candidate_ready', acceptance: 'accepted' },
  { kind: 'agent_code', id: 'sbr_1', tab: 'cluster', tabAssigned: true, createdAt: '2026-11-20T10:05:00Z', agent,
    authorship: 'ai_written', title: 'Sub-cluster T cells', reason: 'No verified method sub-clusters one population; checked recluster-integrate.',
    sandboxName: 'T cells', runNumber: 1, scriptSha256: 'a'.repeat(64),
    steps: [{ number: 1, title: 'Subset', code: 'x <- subset(obj, idents = "T")', readable: 'x <- subset(obj, idents = "T")', hiddenLines: 0 }],
    files: [], inputAnalysisObjectId: 'obj_2', resultAnalysisObjectId: 'obj_3', state: 'draft_ready', review: { state: 'draft' } },
];
const notebook = {
  schema: 'traceomics.agent-notebook.v1',
  tabs: [{ id: 'qc', label: 'Quality Control', cellCount: 2 }, { id: 'cluster', label: 'Clustering & annotation', cellCount: 1 },
    { id: 'deg', label: 'Differential Expression', cellCount: 0 }],
  cells, hiddenSandboxRuns: 2,
};

function fakeApi() {
  return {
    getAgentNotebook: vi.fn(async () => notebook),
    getWorkflowReleaseSteps: vi.fn(async () => ({ source: { sha256: 'b'.repeat(64) },
      steps: [{ number: 1, title: 'Score doublets', code: 'scDblFinder(sce)', readable: 'scDblFinder(sce)', hiddenLines: 0 }] })),
    agentSandboxFileUrl: () => '/file',
  };
}

describe('AgentNotebook', () => {
  beforeEach(() => {
    if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
    if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  });

  it('reads top to bottom with numbered cells under each analysis step', async () => {
    const api = fakeApi();
    const onOpenTab = vi.fn();
    render(<AgentNotebook projectId="proj_1" role="analyst" api={api} onOpenTab={onOpenTab} />);
    const first = await screen.findByRole('region', { name: /Cell 1: note/ });
    expect(within(first).getByText('doublets')).toBeInTheDocument();
    const verified = screen.getByRole('region', { name: 'Cell 2: verified run of Doublet detection (scDblFinder)' });
    expect(within(verified).getByTestId('verified-code-badge')).toHaveTextContent('Verified code');
    expect(within(verified).getByText('Remove doublets before clustering.')).toBeInTheDocument();
    expect(within(verified).getByRole('table', { name: 'Parameters the agent chose' })).toHaveTextContent('dbr0.08');
    const code = screen.getByRole('region', { name: 'Cell 3: agent script Sub-cluster T cells' });
    expect(within(code).getByTestId('ai-authorship-badge')).toHaveTextContent('AI-written code · Needs review');
    expect(within(code).getByText(/checked recluster-integrate/)).toBeInTheDocument();
    expect(within(code).getByRole('region', { name: 'R cell 2' })).toBeInTheDocument();

    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Quality Control', 'Clustering & annotation']);
    expect(screen.getByText(/2 agent scripts are in sandboxes you can't review/)).toBeInTheDocument();

    fireEvent.click(within(code).getByRole('button', { name: 'Review this draft in Agent access' }));
    expect(onOpenTab).toHaveBeenCalledWith('agents');
    fireEvent.click(screen.getAllByRole('button', { name: 'Open this tab' })[1]);
    expect(onOpenTab).toHaveBeenCalledWith('cluster');

    fireEvent.click(within(verified).getByRole('button', { name: 'Show the reviewed code' }));
    expect(await within(verified).findByLabelText('Reviewed code of Doublet detection (scDblFinder)')).toBeInTheDocument();
    expect(api.getWorkflowReleaseSteps).toHaveBeenCalledWith('proj_1', 'rel_1');
  });

  it('filters to one analysis step, offering only steps that have cells', async () => {
    render(<AgentNotebook projectId="proj_1" role="viewer" api={fakeApi()} />);
    const filters = await screen.findByRole('group', { name: 'Show cells from' });
    await waitFor(() => expect(within(filters).getAllByRole('button')).toHaveLength(3));
    expect(within(filters).queryByText(/Differential Expression/)).not.toBeInTheDocument();
    fireEvent.click(within(filters).getByRole('button', { name: 'Clustering & annotation (1)' }));
    expect(screen.getByRole('region', { name: 'Cell 1: agent script Sub-cluster T cells' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /verified run/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
  });

  it('shows its cells under StrictMode, which mounts components twice in development', async () => {
    render(<React.StrictMode><AgentNotebook projectId="proj_1" api={fakeApi()} /></React.StrictMode>);
    expect(await screen.findByRole('region', { name: /Cell 1: note/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All steps (3)' })).toBeInTheDocument();
  });

  it('says so when no agent has done anything yet', async () => {
    const api = { getAgentNotebook: vi.fn(async () => ({ ...notebook, cells: [], hiddenSandboxRuns: 0 })) };
    render(<AgentNotebook projectId="proj_1" api={api} />);
    expect(await screen.findByText('No agent work yet')).toBeInTheDocument();
  });
});

describe('AgentWorkDock', () => {
  it('maps app tabs to notebook steps', () => {
    expect(notebookTabForAppTab('cluster')).toBe('cluster');
    expect(notebookTabForAppTab('dotplot')).toBe('explore');
    expect(notebookTabForAppTab('history')).toBeNull();
  });

  it('shows only the open tab\'s agent cells, in a side panel', async () => {
    const onOpenNotebook = vi.fn();
    render(<AgentWorkDock projectId="proj_1" activeTab="qc" role="analyst" api={fakeApi()} onOpenNotebook={onOpenNotebook} />);
    fireEvent.click(await screen.findByRole('button', { name: /Agent work in this step · 2/ }));
    const panel = screen.getByRole('dialog', { name: 'Agent work in Quality Control' });
    expect(within(panel).getByRole('region', { name: /Cell 1: note/ })).toBeInTheDocument();
    expect(within(panel).getByRole('region', { name: /Cell 2: verified run/ })).toBeInTheDocument();
    expect(within(panel).queryByText('Sub-cluster T cells')).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: /Whole notebook/ }));
    expect(onOpenNotebook).toHaveBeenCalled();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('counts drafts awaiting review, and stays hidden on steps with no agent work', async () => {
    const { rerender } = render(<AgentWorkDock projectId="proj_1" activeTab="cluster" api={fakeApi()} />);
    expect(await screen.findByRole('button', { name: /Agent work in this step · 1\s*1 to review/ })).toBeInTheDocument();
    rerender(<AgentWorkDock projectId="proj_1" activeTab="deg" api={fakeApi()} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Agent work in this step/ })).not.toBeInTheDocument());
    rerender(<AgentWorkDock projectId="proj_1" activeTab="history" api={fakeApi()} />);
    expect(screen.queryByRole('button', { name: /Agent work/ })).not.toBeInTheDocument();
  });
});
