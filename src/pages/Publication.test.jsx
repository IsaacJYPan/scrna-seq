import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
});
