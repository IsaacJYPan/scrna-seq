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

  it('shows the ledger audit, links citations to their evidence, and needs gaps acknowledged before finalizing', async () => {
    const approved = { ...report, sections: [section({ body: 'WNT-active cells [F:led_1].' })] };
    const ledgerAudit = {
      counts: { blocker: 1, review: 1, info: 0 },
      gaps: [
        { severity: 'blocker', code: 'ISSUE_OPEN', message: 'Open issue: IGKC in myeloid cluster', entryIds: ['led_2'] },
        { severity: 'review', code: 'FINDING_SINGLE_SAMPLE', message: 'Finding seen in one sample only: IFN state', entryIds: ['led_1'] },
      ],
      findings: [{ id: 'led_1', title: 'WNT', statement: 'Cluster 7 is WNT-active.', confidence: 'high', sampleSupport: 'all',
        limitations: null, evidence: [{ sandboxRunId: 'sbr_1', file: 'markers.csv', locator: 'cluster 7, LEF1', value: '3.1' }] }],
      labels: [], decisions: [], issues: [{ id: 'led_2', title: 'IGKC', observation: 'IGKC high', status: 'open', resolution: null, evidence: [] }],
      checklist: [{ key: 'qc.doublets', title: 'Doublets detected and handled', status: 'missing', entryId: null, note: null }],
      citations: { cited: 1, unknown: [], uncitedFindings: [] },
    };
    window.electronAPI.getAgentReport = vi.fn(async () => ({ report: approved, ledgerAudit }));
    render(<AgentReports projectId="proj_1" role="analyst" />);
    fireEvent.click(await screen.findByRole('button', { name: 'PBMC paper' }));
    const audit = await screen.findByRole('region', { name: 'Analysis audit' });
    expect(within(audit).getByText(/Open issue: IGKC/)).toBeInTheDocument();
    expect(within(audit).getByRole('link', { name: 'markers.csv @ cluster 7, LEF1 = 3.1' })).toHaveAttribute('href', '/files/sbr_1/markers.csv');
    const methods = screen.getByRole('article', { name: 'Section Methods' });
    expect(within(methods).getByRole('link', { name: 'F:led_1' })).toHaveAttribute('href', '#ledger-led_1');
    expect(document.getElementById('ledger-led_1')).not.toBeNull();

    const finalize = screen.getByRole('button', { name: /finalize report/i });
    expect(finalize).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /1 blocking gap/ }));
    expect(finalize).toBeEnabled();
    fireEvent.click(finalize);
    await waitFor(() => expect(window.electronAPI.finalizeAgentReport).toHaveBeenCalledWith('proj_1', 'rep_1', { acknowledgeLedgerGaps: true }));
  });
});
