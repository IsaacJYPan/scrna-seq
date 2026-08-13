import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

vi.mock('../components/Plot', () => ({ default: () => <div data-testid="plot-stub" /> }));
vi.mock('../components/FigureSavePanel', () => ({ default: () => null }));
import GeneViewer from './GeneViewer';

it('uses the shared UMAP prerequisite instead of rendering blank FeaturePlot axes', async () => {
  const callApi = vi.fn(async () => ({
    gene: 'CD3E', expression: [1, 2], clusters: ['0', '1'],
  }));
  render(<GeneViewer datasetInfo={{ id: 'ao_1' }} pipelineState={{ umap: false }} callApi={callApi} />);

  fireEvent.click(screen.getByRole('button', { name: 'CD3E' }));
  fireEvent.click(await screen.findByRole('button', { name: /FeaturePlot/i }));

  expect(screen.getByText('UMAP Required')).toBeInTheDocument();
  expect(screen.getByText(/Run the UMAP step in Core Preprocessing/i)).toBeInTheDocument();
  expect(screen.queryByTestId('plot-stub')).not.toBeInTheDocument();
});
