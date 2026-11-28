import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFigureGallerySummary } from './useFigureGallerySummary';

afterEach(() => {
  delete window.electronAPI;
});

describe('useFigureGallerySummary', () => {
  it('counts private figures and lists sorted unique collections', async () => {
    window.electronAPI = {
      getFigures: vi.fn(async () => [
        { collection: 'Fig 2' }, { collection: 'Fig 1' }, { collection: 'Fig 2' }, {},
      ]),
    };
    const { result } = renderHook(() => useFigureGallerySummary({ userEmail: 'a@lab.edu', projectId: null, refreshKey: 0 }));
    await waitFor(() => expect(result.current.figuresCount).toBe(4));
    expect(result.current.figureCollections).toEqual(['Fig 1', 'Fig 2']);
    expect(window.electronAPI.getFigures).toHaveBeenCalledWith('a@lab.edu');
  });

  it('reads the project gallery inside a project and reloads on a new refresh key', async () => {
    window.electronAPI = {
      getFigures: vi.fn(async () => []),
      listProjectFigures: vi.fn(async () => [{ collection: 'Shared' }]),
    };
    const { result, rerender } = renderHook(
      ({ refreshKey }) => useFigureGallerySummary({ userEmail: 'a@lab.edu', projectId: 'proj_abc', refreshKey }),
      { initialProps: { refreshKey: 0 } },
    );
    await waitFor(() => expect(result.current.figuresCount).toBe(1));
    expect(window.electronAPI.getFigures).not.toHaveBeenCalled();
    rerender({ refreshKey: 1 });
    await waitFor(() => expect(window.electronAPI.listProjectFigures).toHaveBeenCalledTimes(2));
  });
});
