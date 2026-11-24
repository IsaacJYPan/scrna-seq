import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Publication from './Publication';

describe('Publication', () => {
  const figure = {
    id: 'fig-1',
    title: 'UMAP',
    plotType: 'UMAP',
    filePath: 'C:\\private\\figures\\sensitive-output.png',
    thumbnailB64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  };

  beforeEach(() => {
    window.electronAPI = {
      getFigures: vi.fn(async () => [figure]),
      deleteFigure: vi.fn(async () => ({ success: true })),
    };
  });

  it('refreshes saved figures when the previously mounted tab becomes active', async () => {
    const { container, rerender } = render(<Publication userEmail="researcher@example.com" isActive={false} />);

    expect(window.electronAPI.getFigures).not.toHaveBeenCalled();

    rerender(<Publication userEmail="researcher@example.com" isActive />);

    await waitFor(() => expect(window.electronAPI.getFigures).toHaveBeenCalledWith('researcher@example.com'));
    expect(await screen.findByRole('img', { name: 'UMAP' })).toBeInTheDocument();
    expect(screen.getByText('sensitive-output.png')).toBeInTheDocument();
    expect(container.textContent || '').not.toContain('C:\\private\\figures\\sensitive-output.png');
    expect([...container.querySelectorAll('[title]')].map(node => node.getAttribute('title')))
      .not.toContain('C:\\private\\figures\\sensitive-output.png');
  });

  describe('project gallery', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const figures = [
      { id: 'fig_a', title: 'Clusters', plotType: 'UMAP', collection: 'Figure 1', tags: ['main'], createdByUserId: 7,
        analysisObjectId: 'ao_1', params: { pt_size: 0.5 }, thumbnailB64: png, createdAt: '2026-01-01T00:00:00Z' },
      { id: 'fig_b', title: 'Clusters v2', plotType: 'UMAP', collection: 'Figure 1', tags: ['main'], createdByUserId: 7,
        analysisObjectId: 'ao_1', params: { pt_size: 0.3, revision_of: 'fig_a' }, thumbnailB64: png, createdAt: '2026-01-02T00:00:00Z' },
      { id: 'fig_c', title: 'Markers', plotType: 'DotPlot', collection: '', tags: [], createdByUserId: 9,
        analysisObjectId: 'ao_2', params: {}, thumbnailB64: png, createdAt: '2026-01-03T00:00:00Z' },
    ];
    const bundle = {
      summary: { kept: { steps: 2, objects: 1 }, project: { steps: 5, objects: 3 } },
      omittedSteps: [{ id: 'prov_x' }], unresolved: [],
      steps: [{ id: 'prov_1', operation: 'normalize' }, { id: 'prov_2', operation: 'umap' }],
      figures: [{ id: 'fig_b', title: 'Clusters v2' }],
      order: [{ id: 'ao_1', kind: 'object' }, { id: 'prov_1', kind: 'step' }, { id: 'prov_2', kind: 'step' }, { id: 'fig_b', kind: 'figure' }],
      script: 'obj <- NormalizeData(obj)\n',
    };

    beforeEach(() => {
      window.electronAPI = {
        listProjectFigures: vi.fn(async () => figures),
        updateProjectFigure: vi.fn(async (_p, id, changes) => ({ ...figures.find((f) => f.id === id), ...changes })),
        removeProjectFigure: vi.fn(async () => null),
        exportFigureBundle: vi.fn(async () => bundle),
      };
    });

    it('shows the latest version per figure, grouped by collection, and searches', async () => {
      render(<Publication projectId="proj_1" projectName="Atlas" projectRole="analyst" userId={7} objectId="ao_1" />);
      expect(await screen.findByText('Clusters v2')).toBeInTheDocument();
      expect(screen.queryByText('Clusters')).not.toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Figure 1' })).toBeInTheDocument();
      expect(screen.getByText('2 versions')).toBeInTheDocument();
      fireEvent.change(screen.getByPlaceholderText('Search title, tag, caption'), { target: { value: 'markers' } });
      expect(screen.queryByText('Clusters v2')).not.toBeInTheDocument();
      expect(screen.getByText('Markers')).toBeInTheDocument();
    });

    it('opens a figure, saves its details, and only lets the author edit', async () => {
      render(<Publication projectId="proj_1" projectName="Atlas" projectRole="analyst" userId={7} objectId="ao_1" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Open Clusters v2' }));
      const dialog = screen.getByRole('dialog', { name: 'Clusters v2' });
      fireEvent.change(within(dialog).getByLabelText('Caption / notes'), { target: { value: 'Panel A' } });
      fireEvent.click(within(dialog).getByRole('button', { name: /save details/i }));
      await waitFor(() => expect(window.electronAPI.updateProjectFigure).toHaveBeenCalledWith('proj_1', 'fig_b',
        { title: 'Clusters v2', collection: 'Figure 1', tags: ['main'], notes: 'Panel A' }));
      expect(within(dialog).getByRole('button', { name: /edit figure/i })).not.toBeDisabled();
      expect(within(dialog).getByText(/v1 · Clusters/)).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close figure' }));

      fireEvent.click(screen.getByRole('button', { name: 'Open Markers' }));
      const other = screen.getByRole('dialog', { name: 'Markers' });
      expect(within(other).getByLabelText('Title')).toBeDisabled();
      expect(within(other).queryByRole('button', { name: /edit figure/i })).not.toBeInTheDocument();
    });

    it('exports selected figures with only the history they need', async () => {
      render(<Publication projectId="proj_1" projectName="Atlas" projectRole="viewer" userId={3} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Select Clusters v2' }));
      fireEvent.click(screen.getByRole('button', { name: /export with history/i }));
      const dialog = await screen.findByRole('dialog', { name: /export figure with history/i });
      expect(window.electronAPI.exportFigureBundle).toHaveBeenCalledWith('proj_1', { figureIds: ['fig_b'] });
      expect(await within(dialog).findByText(/1 step on the same history is not needed/)).toBeInTheDocument();
      expect(within(dialog).getByText('normalize')).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: /download r script/i })).not.toBeDisabled();
      expect(screen.queryByLabelText('Move selected figures to collection')).not.toBeInTheDocument();
    });
  });
});
