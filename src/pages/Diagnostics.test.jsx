import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Diagnostics from './Diagnostics';

describe('Technical support page', () => {
  beforeEach(() => {
    window.electronAPI = {
      checkREnv: vi.fn(async () => ({
        version: 'R 4.6.0',
        supportedTarget: 'R 4.5.x',
        runtimeStatus: 'ok',
      })),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('shows only safe availability details and the version compatibility warning', async () => {
    render(<Diagnostics apiStatus="R/Seurat runtime connected" />);

    expect(await screen.findByText('R 4.6.0')).toBeInTheDocument();
    expect(screen.getByText('R 4.5.x')).toBeInTheDocument();
    expect(screen.getByText('Compute available')).toBeInTheDocument();
    expect(screen.getByText(/Detected R 4\.6\.0\. The supported local\/development target is R 4\.5\.x/i)).toBeInTheDocument();
    expect(screen.getByText(/Local paths, package probes, and runtime topology are not shown here/i)).toBeInTheDocument();
    expect(screen.queryByText(/Rscript/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Package Probe$/i)).not.toBeInTheDocument();
  });
});
