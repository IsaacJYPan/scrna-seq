import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import FigureSavePanel from './FigureSavePanel';

describe('FigureSavePanel component', () => {
  beforeEach(() => {
    global.window.electronAPI = {
      saveFigure: vi.fn(async (_record) => ({ success: true })),
      apiRequest: vi.fn(async (_endpoint, _options) => ({
        result: { base64: 'mock_base64_string', file_path: 'test.png', file_name: 'test.png' }
      }))
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders default controls for UMAP plot', () => {
    render(
      <FigureSavePanel 
        isOpen={true} 
        onClose={() => {}} 
        plotType="UMAP" 
        baseParams={{}} 
        deploymentPolicy={{ serverFigureExportEnabled: true }}
      />
    );

    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save to figure gallery/i })).toBeInTheDocument();
  });



  it('calls save API when Save to Figure Gallery is clicked', async () => {
    const onSavedMock = vi.fn();
    render(
      <FigureSavePanel 
        isOpen={true} 
        onClose={() => {}} 
        plotType="UMAP" 
        baseParams={{}} 
        userEmail="test@example.com"
        onSaved={onSavedMock}
        deploymentPolicy={{ serverFigureExportEnabled: true }}
      />
    );

    const saveButton = screen.getByRole('button', { name: /save to figure gallery/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    
    act(() => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(global.window.electronAPI.saveFigure).toHaveBeenCalled();
    });
  });

  it('stores and displays only the filename when the export response contains a full path', async () => {
    const fullPath = 'C:\\private\\figures\\sensitive-output.png';
    const onSaved = vi.fn();
    window.electronAPI.apiRequest.mockResolvedValue({
      result: { base64: 'mock_base64_string', file_path: fullPath, file_name: fullPath },
    });
    render(
      <FigureSavePanel
        isOpen={true}
        onClose={() => {}}
        plotType="UMAP"
        baseParams={{}}
        onSaved={onSaved}
        deploymentPolicy={{ serverFigureExportEnabled: true }}
      />
    );

    const saveButton = screen.getByRole('button', { name: /save to figure gallery/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);

    await waitFor(() => expect(window.electronAPI.saveFigure).toHaveBeenCalled());
    expect(window.electronAPI.saveFigure.mock.calls[0][0]).toMatchObject({ filePath: 'sensitive-output.png' });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ filePath: 'sensitive-output.png' }));
    expect(screen.getByText('Saved as sensitive-output.png')).toBeInTheDocument();
    expect(document.body.textContent || '').not.toContain(fullPath);
  });

  it('replaces a hostile preview error with researcher-safe recovery text', async () => {
    const hostileError = 'Rscript failed at C:\\private\\preview.R https://worker.internal/api/job_unsafe_preview';
    window.electronAPI.apiRequest.mockImplementation(async (endpoint) => (
      endpoint === '/export-preview'
        ? { error: hostileError }
        : { result: { base64: 'mock_base64_string', file_path: 'test.png', file_name: 'test.png' } }
    ));
    const { container } = render(
      <FigureSavePanel
        isOpen={true}
        onClose={() => {}}
        plotType="UMAP"
        baseParams={{}}
        deploymentPolicy={{ serverFigureExportEnabled: true }}
      />
    );

    expect(await screen.findByText('Preview could not be rendered. Review the figure settings and try again.', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(container.textContent || '').not.toMatch(/C:\\private\\preview\.R|worker\.internal|job_unsafe_preview/i);
  });

  it('replaces a hostile save error with researcher-safe recovery text', async () => {
    const hostileError = 'Rscript failed at C:\\private\\export.R https://worker.internal/api/job_unsafe_export';
    window.electronAPI.apiRequest.mockImplementation(async (endpoint) => (
      endpoint === '/export-figure'
        ? { error: hostileError }
        : { result: { base64: 'mock_base64_string', file_path: 'test.png', file_name: 'test.png' } }
    ));
    const { container } = render(
      <FigureSavePanel
        isOpen={true}
        onClose={() => {}}
        plotType="UMAP"
        baseParams={{}}
        deploymentPolicy={{ serverFigureExportEnabled: true }}
      />
    );

    const saveButton = screen.getByRole('button', { name: /save to figure gallery/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);

    expect(await screen.findByText('Figure could not be saved. Review the figure settings and try again.')).toBeInTheDocument();
    expect(container.textContent || '').not.toMatch(/C:\\private\\export\.R|worker\.internal|job_unsafe_export/i);
  });

  it('sends X-Object-ID so the server can resolve the live R object for the preview', async () => {
    render(
      <FigureSavePanel
        isOpen={true}
        onClose={() => {}}
        plotType="UMAP"
        baseParams={{}}
        objectId="ao_test_123"
        deploymentPolicy={{ serverFigureExportEnabled: true }}
      />
    );
    await waitFor(() => expect(global.window.electronAPI.apiRequest).toHaveBeenCalledWith(
      '/export-preview', expect.any(Object)
    ));
    const [, options] = global.window.electronAPI.apiRequest.mock.calls.find(c => c[0] === '/export-preview');
    expect(options.headers['X-Object-ID']).toBe('ao_test_123');
  });

  it('does not call R for a feature-required plot with no genes; shows a clear notice', async () => {
    render(
      <FigureSavePanel
        isOpen={true}
        onClose={() => {}}
        plotType="DotPlot"
        baseParams={{ features: [] }}
        objectId="ao_test_123"
        deploymentPolicy={{ serverFigureExportEnabled: true }}
      />
    );
    expect(screen.getByText(/Add at least one gene to preview a DotPlot/i)).toBeInTheDocument();
    // Wait past the 800ms preview debounce to be sure no doomed R call is made.
    await new Promise(r => setTimeout(r, 900));
    expect(global.window.electronAPI.apiRequest).not.toHaveBeenCalledWith(
      '/export-preview', expect.any(Object)
    );
    expect(screen.getByRole('button', { name: /save to figure gallery/i })).toBeDisabled();
  });

  it('keeps previews available but disables server-file export in production', async () => {
    render(
      <FigureSavePanel
        isOpen={true}
        onClose={() => {}}
        plotType="UMAP"
        baseParams={{}}
        deploymentPolicy={{ serverFigureExportEnabled: false }}
      />
    );

    const saveButton = screen.getByRole('button', { name: /save to figure gallery/i });
    expect(saveButton).toBeDisabled();
    expect(screen.getByText(/Figures remain in this private gallery/i)).toBeInTheDocument();
    await waitFor(() => expect(global.window.electronAPI.apiRequest).toHaveBeenCalledWith(
      '/export-preview', expect.any(Object)
    ));
    expect(global.window.electronAPI.apiRequest).not.toHaveBeenCalledWith(
      '/export-figure', expect.any(Object)
    );
    expect(global.window.electronAPI.saveFigure).not.toHaveBeenCalled();
  });
});
