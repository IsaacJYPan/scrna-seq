import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Diagnostics from './Diagnostics';

describe('Diagnostics page', () => {
  beforeEach(() => {
    window.electronAPI = {
      checkREnv: vi.fn(async () => ({
        version: 'R 4.6.0',
        supportedTarget: 'R 4.5.x',
        rscriptPath: 'C:\\R\\R-4.6.0\\bin\\Rscript.exe',
        rscriptSource: 'PATH',
        packages: {
          Seurat: true,
          dplyr: true,
          harmony: false,
          CellChat: false,
          plumber: true,
          jsonlite: true,
          ggplot2: true
        }
      }))
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('shows detected R version, R 4.5.x target, and non-4.5 warning without hardcoded R 4.5.1', async () => {
    render(<Diagnostics apiStatus="R/Seurat runtime connected" />);

    expect(await screen.findByText('R 4.6.0')).toBeInTheDocument();
    expect(screen.getByText('R 4.5.x')).toBeInTheDocument();
    expect(screen.getByText(/Detected R 4\.6\.0\. Supported local\/dev target is R 4\.5\.x/i)).toBeInTheDocument();
    expect(screen.getByText(/R-4\.6\.0\\bin\\Rscript\.exe/i)).toBeInTheDocument();
    expect(screen.queryByText('R 4.5.1')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Rscript/i })).not.toBeInTheDocument();
  });
});
