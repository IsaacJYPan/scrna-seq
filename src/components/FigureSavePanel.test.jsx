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
      />
    );

    const saveButton = screen.getByRole('button', { name: /save to figure gallery/i });
    
    act(() => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(global.window.electronAPI.saveFigure).toHaveBeenCalled();
    });
  });
});
