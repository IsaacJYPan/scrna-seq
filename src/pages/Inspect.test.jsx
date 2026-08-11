import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Inspect from './Inspect';

function objectInfo() {
  return {
    n_cells: 120,
    n_features: 800,
    assays: ['RNA'],
    active_assay: 'RNA',
    reductions: [],
    identities: [],
    meta_cols: [
      { name: 'sample', type: 'categorical', n_unique: 2 },
    ],
  };
}

describe('Inspect deployment policy', () => {
  it('omits production-blocked CSV import and live subsetting while keeping bounded mapping', async () => {
    const callApi = vi.fn(async (endpoint) => {
      if (endpoint === '/object-info') return objectInfo();
      return { values: [] };
    });
    render(
      <Inspect
        obj={{ id: 'ao_policy1', name: 'Policy object' }}
        globalTab="inspect"
        workspaceObjects={[]}
        callApi={callApi}
        deploymentPolicy={{ legacyLiveMutationToolsEnabled: false }}
      />
    );

    await waitFor(() => expect(callApi).toHaveBeenCalledWith('/object-info', {}, { useCache: false }));
    expect(screen.queryByRole('button', { name: 'Subset' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add Metadata' }));
    expect(await screen.findByRole('button', { name: 'Map from Column' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import CSV' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Click to select CSV/i)).not.toBeInTheDocument();
    expect(screen.getByText(/This import and subsetting option is not available in this deployment/i)).toBeInTheDocument();
  });

  it('shows only a selected CSV filename, never its local path', async () => {
    window.electronAPI = {
      openDataFileDialog: vi.fn(async () => 'C:\\private-data\\donor-metadata.tsv'),
    };
    const callApi = vi.fn(async (endpoint) => {
      if (endpoint === '/object-info') return objectInfo();
      return { values: [] };
    });
    const { container } = render(
      <Inspect
        obj={{ id: 'ao_policy1', name: 'Policy object' }}
        globalTab="inspect"
        workspaceObjects={[]}
        callApi={callApi}
        deploymentPolicy={{ legacyLiveMutationToolsEnabled: true }}
      />
    );

    await waitFor(() => expect(callApi).toHaveBeenCalledWith('/object-info', {}, { useCache: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Metadata' }));
    fireEvent.click(await screen.findByText(/Click to select CSV/i));
    expect(await screen.findByText('donor-metadata.tsv')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/C:\\private-data|private-data/i);
    delete window.electronAPI;
  });
});
