import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AnalysisBranches from './AnalysisBranches';

const workspace = {
  selectedProjectId: 'proj_1',
  projects: [{ id: 'proj_1', name: 'Atlas', role: 'owner' }],
  objects: [{ id: 'ao_abc123', projectId: 'proj_1', ownerUserId: 1, displayName: 'PBMC checkpoint' }],
};

describe('AnalysisBranches', () => {
  beforeEach(() => {
    window.electronAPI = {
      listAnalysisBranches: vi.fn(async () => []),
      listAnalysisBranchReviews: vi.fn(async () => []),
      getCanonicalAnalysis: vi.fn(async () => { throw new Error('not found'); }),
      createAnalysisBranch: vi.fn(async () => ({ id: 'br_abc123' })),
      publishAnalysisBranch: vi.fn(async () => ({ id: 'br_abc123', visibility: 'project' })),
      requestAnalysisBranchReview: vi.fn(async () => ({ id: 'rev_abc123' })),
      decideAnalysisBranchReview: vi.fn(async () => ({ id: 'rev_abc123', status: 'approved' })),
      promoteAnalysisBranch: vi.fn(async () => ({ analysisObjectId: 'ao_abc123' })),
      compareAnalysisBranches: vi.fn(async () => ({ relation: 'shared_lineage' })),
      downloadReproducibilityManifest: vi.fn(async () => ({ filename: 'manifest.json' })),
      listProjectAuditEvents: vi.fn(async () => [{
        id: 'aud_abc123', action: 'branch.published', targetType: 'branch',
        targetId: 'br_right123', createdAt: '2026-08-01T12:00:00.000Z',
      }]),
      listAnalysisBranchReviewComments: vi.fn(async () => []),
      addAnalysisBranchReviewComment: vi.fn(async () => ({ id: 'com_abc123' })),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('creates private branches from the selected project object', async () => {
    render(<AnalysisBranches currentWs={workspace} datasetInfo={workspace.objects[0]} userId={1} />);
    await screen.findByText(/no final project analysis has been selected/i);

    fireEvent.change(screen.getByPlaceholderText('e.g. alternate QC strategy'), {
      target: { value: 'owner/qc-strategy' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create private branch/i }));

    await waitFor(() => expect(window.electronAPI.createAnalysisBranch).toHaveBeenCalledWith(
      'proj_1',
      expect.objectContaining({
        name: 'owner/qc-strategy',
        baseAnalysisObjectId: 'ao_abc123',
      })
    ));
  });

  it('does not offer a collaborator-owned checkpoint as a direct branch source', async () => {
    const setActiveTab = vi.fn();
    const sharedWorkspace = {
      ...workspace,
      projects: [{ id: 'proj_1', name: 'Atlas', role: 'analyst' }],
      objects: [
        workspace.objects[0],
        { id: 'ao_shared456', projectId: 'proj_1', ownerUserId: 2, displayName: 'PI checkpoint' },
      ],
    };
    render(<AnalysisBranches currentWs={sharedWorkspace} datasetInfo={sharedWorkspace.objects[1]} userId={1} setActiveTab={setActiveTab} />);

    const source = await screen.findByRole('combobox', { name: /Branch source saved analysis/i });
    expect(source).toHaveValue('ao_abc123');
    expect(screen.queryByRole('option', { name: 'PI checkpoint' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Open Runs & Results/i }));
    expect(setActiveTab).toHaveBeenCalledWith('history');
  });

  it('replaces a hostile branch error with researcher-safe recovery text', async () => {
    window.electronAPI.listAnalysisBranches.mockRejectedValueOnce(new Error(JSON.stringify({
      error: 'Rscript failed at C:\\private\\branches.R https://worker.internal/api/job_unsafe_branch',
    })));
    const { container } = render(<AnalysisBranches currentWs={workspace} datasetInfo={workspace.objects[0]} userId={1} />);

    expect(await screen.findByText('Could not load analysis branches.')).toBeInTheDocument();
    expect(container.textContent || '').not.toMatch(/C:\\private\\branches\.R|worker\.internal|job_unsafe_branch/i);
  });

  it('shows explicit share, review, approval, promotion, and comparison actions', async () => {
    const privateBranch = {
      id: 'br_left123', ownerUserId: 1, name: 'owner/method-a', visibility: 'private',
      status: 'active', headAnalysisObjectId: 'ao_abc123', version: 1,
    };
    const sharedBranch = {
      id: 'br_right123', ownerUserId: 2, name: 'analyst/method-b', visibility: 'project',
      status: 'active', headAnalysisObjectId: 'ao_def456', version: 2,
    };
    window.electronAPI.listAnalysisBranches.mockResolvedValue([privateBranch, sharedBranch]);
    window.electronAPI.listAnalysisBranchReviews.mockResolvedValue([{
      id: 'rev_open123', branchId: sharedBranch.id, title: 'Review method B',
      status: 'open', headAnalysisObjectId: sharedBranch.headAnalysisObjectId,
    }]);
    window.electronAPI.listProjectAuditEvents.mockResolvedValue([{
      id: 'aud_abc123', action: 'branch.published', targetId: 'br_right123',
      createdAt: '2026-08-01T12:00:00.000Z',
    }]);
    window.electronAPI.listAnalysisBranchReviewComments.mockResolvedValue([{
      id: 'com_abc123', authorUserId: 42, body: 'Please document the alternate normalization choice.',
    }]);

    const { container } = render(<AnalysisBranches currentWs={workspace} datasetInfo={workspace.objects[0]} userId={1} />);
    expect((await screen.findAllByText('owner/method-a')).length).toBeGreaterThan(0);
    expect(screen.getByText('Branch shared for review')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /download review record/i })[0]);
    await waitFor(() => expect(window.electronAPI.downloadReproducibilityManifest)
      .toHaveBeenCalledWith('proj_1', { branchId: privateBranch.id }));
    fireEvent.click(screen.getByRole('button', { name: /share for review/i }));
    await waitFor(() => expect(window.electronAPI.publishAnalysisBranch)
      .toHaveBeenCalledWith('proj_1', privateBranch.id));

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(window.electronAPI.decideAnalysisBranchReview)
      .toHaveBeenCalledWith('proj_1', 'rev_open123', 'approved', expect.any(String)));

    fireEvent.change(screen.getByPlaceholderText(/add a method or provenance comment/i), {
      target: { value: 'Please document the alternate normalization choice.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(window.electronAPI.addAnalysisBranchReviewComment)
      .toHaveBeenCalledWith('proj_1', 'rev_open123', 'Please document the alternate normalization choice.'));

    fireEvent.change(screen.getByLabelText('Left branch'), { target: { value: privateBranch.id } });
    fireEvent.change(screen.getByLabelText('Right branch'), { target: { value: sharedBranch.id } });
    fireEvent.click(screen.getByRole('button', { name: /compare recorded history/i }));
    expect(await screen.findByText('Shared lineage')).toBeInTheDocument();
    expect(screen.getByText('First saved version:')).toBeInTheDocument();
    expect(screen.getByText('Second saved version:')).toBeInTheDocument();

    const text = container.textContent || '';
    expect(text).not.toMatch(/ao_abc123|ao_def456|br_left123|br_right123|rev_open123|Member 42|differentialExpression|canonical|new head|shared_lineage/i);
  });

  it('keeps reviewer comments and the decision note visible to a branch author after changes are requested', async () => {
    window.electronAPI.listAnalysisBranches.mockResolvedValueOnce([{
      id: 'br_author', ownerUserId: 1, name: 'alternate normalization', visibility: 'project',
      status: 'active', baseAnalysisObjectId: 'ao_abc123', headAnalysisObjectId: 'ao_abc123', version: 1,
    }]);
    window.electronAPI.listAnalysisBranchReviews.mockResolvedValueOnce([{
      id: 'rev_changes', branchId: 'br_author', title: 'Review alternate normalization',
      summary: 'Check the normalization choice.', status: 'changes_requested',
      decisionNote: 'Document why SCTransform was selected.', headAnalysisObjectId: 'ao_abc123',
    }]);
    window.electronAPI.listAnalysisBranchReviewComments.mockResolvedValueOnce([{
      id: 'com_changes', authorUserId: 2, body: 'Add the normalization comparison figure.',
    }]);

    render(<AnalysisBranches currentWs={workspace} datasetInfo={workspace.objects[0]} userId={1} />);

    expect(await screen.findByText('Changes requested')).toBeInTheDocument();
    expect(screen.getByText(/Document why SCTransform was selected/i)).toBeInTheDocument();
    expect(screen.getByText(/Add the normalization comparison figure/i)).toBeInTheDocument();
  });
});
