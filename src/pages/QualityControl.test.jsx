import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The shared plot wrapper is covered separately; keep this page test focused
// on QC behavior without a real canvas in jsdom.
vi.mock('../components/Plot', () => ({
  default: () => <div data-testid="plot-stub" />,
}));

import QualityControl from './QualityControl';

const datasetInfo = { id: 'ao_abc123', projectId: 'proj_1', name: 'PBMC 3k', ownerUserId: 7 };

function baseProps(overrides = {}) {
  return {
    callApi: vi.fn(async () => ({ error: 'no object loaded' })),
    datasetInfo,
    currentProvId: null,
    openProvenance: vi.fn(),
    pipelineState: {},
    theme: 'dark',
    rSessionId: 'sess-1',
    userEmail: 'user@example.com',
    userId: 7,
    objectId: 'ao_abc123',
    currentWs: {
      selectedProjectId: 'proj_1',
      projects: [{ id: 'proj_1', role: 'owner' }],
    },
    sessionReady: true,
    ...overrides,
  };
}

describe('QualityControl', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the QC screen when a dataset is loaded', async () => {
    render(<QualityControl {...baseProps()} />);
    expect(await screen.findByText('Quality Control')).toBeInTheDocument();
  });

  it('uses the reference QC thresholds only for the PBMC3k tutorial', async () => {
    render(<QualityControl {...baseProps({ objectId:'ao_reference', datasetInfo:{...datasetInfo,source:'pbmc3k_demo'} })} />);
    expect(await screen.findByLabelText('Max Features')).toHaveValue(2500);
    expect(screen.getByLabelText('Min Features')).toHaveValue(200);
  });

  // Regression: hooks (usePipelineStep + the jitter useMemo calls) must run on
  // every render. If datasetInfo becomes null while the page is mounted (logout,
  // project switch, cleared selection) an early return placed before those hooks
  // would change the hook count and throw "Rendered fewer hooks than expected".
  it('does not crash when datasetInfo toggles to null on a mounted page', async () => {
    const { rerender } = render(<QualityControl {...baseProps()} />);
    await screen.findByText('Quality Control');

    expect(() => {
      rerender(<QualityControl {...baseProps({ datasetInfo: null })} />);
    }).not.toThrow();

    expect(screen.getByText('No Dataset Loaded')).toBeInTheDocument();
  });

  it('blocks impossible filter ranges before calling the analysis endpoint', async () => {
    const callApi = vi.fn(async () => ({ percent_mt: [1], nFeature_RNA: [100], nCount_RNA: [200] }));
    render(<QualityControl {...baseProps({ callApi })} />);
    await screen.findByText('Quality Control');
    fireEvent.change(screen.getByLabelText('Min Features'), { target: { value: '6000' } });
    fireEvent.change(screen.getByLabelText('Max Features'), { target: { value: '5000' } });
    expect(screen.getByText(/Max Features must be/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply QC Filters/i })).toBeDisabled();
    expect(callApi).toHaveBeenCalledTimes(1);
  });

  it('presents viewers with read-only filtering controls', async () => {
    const callApi = vi.fn(async () => ({ percent_mt: [1], nFeature_RNA: [100], nCount_RNA: [200] }));
    render(<QualityControl {...baseProps({
      callApi,
      currentWs: { selectedProjectId: 'proj_1', projects: [{ id: 'proj_1', role: 'viewer' }] },
    })} />);

    expect(await screen.findByText(/Read-only project view/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply QC Filters/i })).toBeDisabled();
    expect(screen.getByLabelText('Max MT %')).toBeDisabled();
    expect(screen.getByText(/Detailed distributions and plots stay private/i)).toBeInTheDocument();
    expect(screen.queryByText(/QC distribution data is unavailable/i)).not.toBeInTheDocument();
    expect(callApi).not.toHaveBeenCalled();
  });
});
