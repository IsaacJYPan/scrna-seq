import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// react-plotly.js pulls in the full Plotly bundle; stub it so the QC page can
// render in jsdom without WebGL/canvas.
vi.mock('react-plotly.js', () => ({
  default: () => <div data-testid="plot-stub" />,
}));

import QualityControl from './QualityControl';

const datasetInfo = { id: 'ao_abc123', name: 'PBMC 3k' };

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
    objectId: 'ao_abc123',
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
});
