import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

vi.mock('../components/Plot', () => ({ default: () => <div data-testid="plot-stub" /> }));
vi.mock('../components/FigureSavePanel', () => ({ default: () => null }));
import FeaturePlot from './FeaturePlot';

it('plots an exact typed gene and reports an unknown gene', async () => {
  const callApi = vi.fn(async path => path === '/genes'
    ? { genes: ['CD3E'] }
    : { u1: [1], u2: [2], expression: [3] });
  render(<FeaturePlot datasetInfo={{ id: 'ao_1' }} pipelineState={{ umap: true }} sessionReady userEmail="u@example.com" objectId="ao_1" callApi={callApi} />);
  await waitFor(() => expect(callApi).toHaveBeenCalledWith('/genes', expect.anything(), expect.anything()));
  const input = screen.getByPlaceholderText(/Gene symbol/i);
  fireEvent.change(input, { target: { value: 'CD3E' } });
  fireEvent.click(screen.getByRole('button', { name: 'Plot' }));
  await waitFor(() => expect(callApi).toHaveBeenCalledWith('/feature-values?gene=CD3E', expect.anything(), expect.anything()));
  fireEvent.change(input, { target: { value: 'NOT_A_GENE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Plot' }));
  expect(screen.getByText(/NOT_A_GENE.*not found/i)).toBeInTheDocument();
});
