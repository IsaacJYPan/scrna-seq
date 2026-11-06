import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentReports from './AgentReports';

const section = (over) => ({
  id: 'sec_1', key: 'methods', version: 1, heading: 'Methods', body: 'We used **Seurat**. <script>alert(1)</script>',
  figures: [], status: 'approved', reviews: [], history: [], ...over,
});
const report = {
  id: 'rep_1', title: 'PBMC paper', status: 'draft', agent: { displayName: 'Writer' },
  sections: [section(), section({ id: 'sec_2', key: 'results', heading: 'Results', body: 'Two clusters.', status: 'changes_requested',
    figures: [{ sandboxRunId: 'sbr_1', file: 'umap.png', caption: 'UMAP' }],
    reviews: [{ id: 'rvw_1', decision: 'changes_requested', comment: 'Add sizes', reviewer: { displayName: 'Ada' } }],
    version: 2, history: [{ id: 'sec_0', version: 1, body: 'Old text', reviews: [] }] })],
};

describe('AgentReports', () => {
  beforeEach(() => {
    window.electronAPI = {
      listAgentReports: vi.fn(async () => ({ reports: [{ id: 'rep_1', title: 'PBMC paper', status: 'draft', agent: { displayName: 'Writer' }, sectionCount: 2, approvedSections: 1 }] })),
      getAgentReport: vi.fn(async () => ({ report })),
      reviewAgentReportSection: vi.fn(async () => ({ report })),
      finalizeAgentReport: vi.fn(async () => ({ report: { ...report, status: 'finalized' } })),
      agentSandboxFileUrl: (p, r, n) => `/files/${r}/${n}`,
      agentReportExportUrl: () => '/export',
    };
  });
  afterEach(() => { delete window.electronAPI; vi.restoreAllMocks(); });

  it('renders sections as Markdown without raw HTML, with figures and review history', async () => {
    render(<AgentReports projectId="proj_1" role="analyst" />);
    fireEvent.click(await screen.findByRole('button', { name: 'PBMC paper' }));
    const methods = await screen.findByRole('article', { name: 'Section Methods' });
    expect(within(methods).getByText('Seurat').tagName).toBe('STRONG');
    expect(document.querySelector('script')).toBeNull();
    const results = screen.getByRole('article', { name: 'Section Results' });
    expect(within(results).getByRole('img', { name: 'UMAP' })).toHaveAttribute('src', '/files/sbr_1/umap.png');
    expect(within(results).getByText(/Add sizes/)).toBeInTheDocument();
    fireEvent.click(within(results).getByRole('button', { name: /earlier version/ }));
    expect(within(results).getByText('Old text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /finalize report/i })).toBeDisabled();
  });

  it('requests changes with a comment and approves', async () => {
    render(<AgentReports projectId="proj_1" role="analyst" />);
    fireEvent.click(await screen.findByRole('button', { name: 'PBMC paper' }));
    const results = await screen.findByRole('article', { name: 'Section Results' });
    expect(within(results).getByRole('button', { name: 'Request changes' })).toBeDisabled();
    fireEvent.change(within(results).getByLabelText(/comment on results/i), { target: { value: 'Cite the method' } });
    fireEvent.click(within(results).getByRole('button', { name: 'Request changes' }));
    await waitFor(() => expect(window.electronAPI.reviewAgentReportSection).toHaveBeenCalledWith('proj_1', 'rep_1', 'sec_2', 'changes_requested', 'Cite the method'));
    fireEvent.click(within(results).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(window.electronAPI.reviewAgentReportSection).toHaveBeenLastCalledWith('proj_1', 'rep_1', 'sec_2', 'approved', ''));
  });
});
