import { describe, expect, it, vi } from 'vitest';

import { getPlotHoverStyle, isWebGLFailure, preparePlotData, supportsWebGL } from './Plot';

describe('shared Plot hover style', () => {
  it('uses readable neutral palettes for both themes', () => {
    expect(getPlotHoverStyle('light')).toEqual({
      bgcolor: '#ffffff', bordercolor: '#cbd5e1',
      font: { color: '#334155', family: 'Inter, system-ui', size: 12 },
    });
    expect(getPlotHoverStyle('dark')).toEqual({
      bgcolor: '#182236', bordercolor: '#34445d',
      font: { color: '#f1f5f9', family: 'Inter, system-ui', size: 12 },
    });
  });
});

describe('Plot SVG fallback', () => {
  it('keeps WebGL traces untouched when a usable context exists', () => {
    const traces = [{ type: 'scattergl', x: [1], y: [2], svgFallback: { omit: true } }];

    expect(preparePlotData(traces, true)).toEqual([{ type: 'scattergl', x: [1], y: [2] }]);
  });

  it('converts two-dimensional WebGL traces to SVG and removes dense helper traces', () => {
    const traces = [
      {
        type: 'scattergl',
        x: [1, 2],
        y: [3, 4],
        hoverinfo: 'skip',
        svgFallback: { hoverinfo: 'all', hovertemplate: 'cell: %{y}' },
      },
      {
        type: 'scattergl',
        x: Array(20000).fill(0),
        y: Array(20000).fill(0),
        svgFallback: { omit: true },
      },
      { type: 'heatmapgl', z: [[1]], colorscale: 'Viridis' },
    ];

    const fallback = preparePlotData(traces, false);

    expect(fallback).toHaveLength(2);
    expect(fallback[0]).toMatchObject({
      type: 'scatter',
      x: [1, 2],
      y: [3, 4],
      hoverinfo: 'all',
      hovertemplate: 'cell: %{y}',
    });
    expect(fallback[0]).not.toHaveProperty('svgFallback');
    expect(fallback[1]).toMatchObject({ type: 'heatmap', z: [[1]] });
  });

  it('detects unavailable contexts and Plotly WebGL errors', () => {
    const getContext = vi.fn((kind) => (kind === 'webgl' ? {} : null));
    const browserWindow = {
      WebGLRenderingContext: function WebGLRenderingContext() {},
      document: { createElement: () => ({ getContext }) },
    };

    expect(supportsWebGL(browserWindow)).toBe(true);
    expect(getContext).toHaveBeenCalledWith('webgl2');
    expect(getContext).toHaveBeenCalledWith('webgl');
    expect(isWebGLFailure(new Error('WebGL is not supported by your browser'))).toBe(true);
    expect(isWebGLFailure(new Error('ordinary data validation failure'))).toBe(false);
  });

  it('uses the reliable SVG path in Electron even when Chromium exposes a nominal context', () => {
    const browserWindow = {
      navigator: { userAgent: 'Mozilla/5.0 Electron/43.2.0' },
      WebGLRenderingContext: function WebGLRenderingContext() {},
      document: { createElement: () => ({ getContext: () => ({}) }) },
    };

    expect(supportsWebGL(browserWindow)).toBe(false);
  });
});
