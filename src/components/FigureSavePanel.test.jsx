import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import FigureSavePanel from './FigureSavePanel';
import { FigureProjectProvider } from '../figures/FigureProjectContext';

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
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save to figure gallery/i })).toBeInTheDocument();
  });

  it('exposes a named modal dialog, focuses its close control, inerts the page, and restores focus on close', () => {
    const triggerContainer = document.createElement('div');
    const trigger = document.createElement('button');
    trigger.textContent = 'Open figure editor';
    triggerContainer.appendChild(trigger);
    document.body.appendChild(triggerContainer);
    trigger.focus();

    const onClose = vi.fn();
    const view = render(
      <FigureSavePanel isOpen={false} onClose={onClose} plotType="UMAP" baseParams={{}} />
    );
    view.rerender(
      <FigureSavePanel isOpen={true} onClose={onClose} plotType="UMAP" baseParams={{}} />
    );

    const dialog = screen.getByRole('dialog', { name: 'Save to Figure Gallery' });
    const closeButton = screen.getByRole('button', { name: 'Close figure editor' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.activeElement).toBe(closeButton);
    expect(triggerContainer).toHaveProperty('inert', true);

    view.rerender(
      <FigureSavePanel isOpen={false} onClose={onClose} plotType="UMAP" baseParams={{}} />
    );
    expect(triggerContainer).toHaveProperty('inert', false);
    expect(document.activeElement).toBe(trigger);
    triggerContainer.remove();
  });

  it('closes on Escape and wraps Tab and Shift+Tab within the dialog', () => {
    const onClose = vi.fn();
    render(
      <FigureSavePanel isOpen={true} onClose={onClose} plotType="UMAP" baseParams={{}} />
    );
    const dialog = screen.getByRole('dialog', { name: 'Save to Figure Gallery' });
    const focusable = [...dialog.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
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
    expect(screen.getByText(/file export is not available in this deployment/i)).toBeInTheDocument();
    await waitFor(() => expect(global.window.electronAPI.apiRequest).toHaveBeenCalledWith(
      '/export-preview', expect.any(Object)
    ));
    expect(global.window.electronAPI.apiRequest).not.toHaveBeenCalledWith(
      '/export-figure', expect.any(Object)
    );
    expect(global.window.electronAPI.saveFigure).not.toHaveBeenCalled();
  });

  it('saves into the project gallery, linked to the analysis object, even without file export', async () => {
    vi.useFakeTimers();
    const createProjectFigure = vi.fn(async () => ({ id: 'fig_1' }));
    const notifySaved = vi.fn();
    window.electronAPI = {
      createProjectFigure,
      saveFigure: vi.fn(),
      apiRequest: vi.fn(async () => ({ result: { base64: 'data:image/png;base64,AAAA' } })),
    };
    render(
      <FigureProjectProvider value={{ projectId: 'proj_1', projectName: 'Atlas', canWrite: true, collections: ['Figure 1'], notifySaved }}>
        <FigureSavePanel isOpen onClose={() => {}} plotType="UMAP" baseParams={{}} objectId="ao_abc"
          initialParams={{ title: 'Clusters', pt_size: 0.4 }} revisionOf="fig_0" />
      </FigureProjectProvider>
    );
    expect(screen.getByRole('dialog', { name: 'Edit figure' })).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Clusters');
    fireEvent.change(screen.getByLabelText('Collection'), { target: { value: 'Figure 1' } });
    fireEvent.change(screen.getByLabelText('Tags (comma-separated)'), { target: { value: 'main, Main, umap' } });
    await act(async () => { vi.advanceTimersByTime(900); });
    vi.useRealTimers();
    const save = screen.getByRole('button', { name: /save as new version/i });
    await waitFor(() => expect(save).not.toBeDisabled());
    await act(async () => { fireEvent.click(save); });
    await waitFor(() => expect(createProjectFigure).toHaveBeenCalled());
    const [projectId, payload] = createProjectFigure.mock.calls[0];
    expect(projectId).toBe('proj_1');
    expect(payload).toMatchObject({
      analysisObjectId: 'ao_abc', plotType: 'UMAP', title: 'Clusters', collection: 'Figure 1',
      tags: ['main', 'umap'], thumbnailB64: 'data:image/png;base64,AAAA',
    });
    expect(payload.params).toMatchObject({ pt_size: 0.4, revision_of: 'fig_0' });
    expect(window.electronAPI.saveFigure).not.toHaveBeenCalled();
    expect(notifySaved).toHaveBeenCalled();
    expect(await screen.findByText(/Saved to the Atlas gallery/)).toBeInTheDocument();
  });
});
