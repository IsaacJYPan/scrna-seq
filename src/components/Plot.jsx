import React from 'react';
import PlotlyPlot from 'react-plotly.js';

// Plotly's WebGL trace types provide a useful performance win in browsers that
// support them. Electron can run with GPU acceleration disabled, however, and
// Plotly otherwise replaces the chart with a WebGL error. The two-dimensional
// trace types below have equivalent SVG renderers, so they can remain usable.
const SVG_TRACE_TYPES = {
  scattergl: 'scatter',
  heatmapgl: 'heatmap',
};

/**
 * Return whether the active renderer can create a WebGL drawing context.
 * Keeping this probe separate makes the fallback deterministic in tests and
 * avoids trying to construct a canvas in non-browser environments.
 */
export function supportsWebGL(browserWindow = typeof window === 'undefined' ? null : window) {
  if (!browserWindow?.document?.createElement) return false;
  // JSDOM exposes enough canvas surface area to look like a browser while its
  // getContext implementation only emits a non-rendering warning. It is not a
  // usable plotting renderer, so fail closed before asking it for a context.
  if (/jsdom/i.test(browserWindow.navigator?.userAgent || '')) return false;
  // Electron can report a nominal context in remote/virtualized Windows
  // sessions and still reject Plotly's WebGL renderer. The desktop shell has a
  // reliable SVG equivalent for our 2D traces, so choose it up front rather
  // than briefly showing a broken chart before an error callback can fire.
  if (/\bElectron\//i.test(browserWindow.navigator?.userAgent || '')) return false;
  if (!browserWindow.WebGLRenderingContext && !browserWindow.WebGL2RenderingContext) return false;

  try {
    const canvas = browserWindow.document.createElement('canvas');
    return Boolean(
      canvas.getContext('webgl2')
      || canvas.getContext('webgl')
      || canvas.getContext('experimental-webgl')
    );
  } catch {
    return false;
  }
}

export function hasSvgFallbackTrace(data) {
  return Array.isArray(data) && data.some((trace) => SVG_TRACE_TYPES[trace?.type]);
}

/**
 * `svgFallback` is wrapper-only trace metadata. It is never passed through to
 * Plotly. `omit: true` lets a high-density interaction helper be skipped when
 * the equivalent SVG trace would create an excessive number of DOM nodes.
 */
export function preparePlotData(data, webglAvailable) {
  if (!Array.isArray(data)) return [];

  return data.flatMap((trace) => {
    if (!trace || typeof trace !== 'object') return [trace];

    const { svgFallback, ...plotlyTrace } = trace;
    const fallbackType = SVG_TRACE_TYPES[trace.type];
    if (webglAvailable || !fallbackType) return [plotlyTrace];

    const { omit, ...fallbackProps } = svgFallback && typeof svgFallback === 'object'
      ? svgFallback
      : {};
    if (omit) return [];

    return [{
      ...plotlyTrace,
      ...fallbackProps,
      type: fallbackType,
    }];
  });
}

export function isWebGLFailure(error) {
  const message = String(error?.message || error || '');
  return /webgl|gpu|regl|context\s+lost/i.test(message);
}

/**
 * Shared Plotly wrapper with a graceful SVG fallback for two-dimensional
 * scattergl and heatmapgl traces. It preserves WebGL where it works and also
 * downgrades after an initialization error or a lost WebGL context.
 */
export default function Plot({ data = [], onError, onWebGlContextLost, ...props }) {
  const [webglAvailable, setWebglAvailable] = React.useState(() => supportsWebGL());
  const hasConvertibleTrace = hasSvgFallbackTrace(data);
  const plotData = React.useMemo(
    () => preparePlotData(data, webglAvailable),
    [data, webglAvailable]
  );

  const fallBackToSvg = React.useCallback(() => {
    if (hasConvertibleTrace) setWebglAvailable(false);
  }, [hasConvertibleTrace]);

  const handleError = React.useCallback((error) => {
    if (isWebGLFailure(error)) fallBackToSvg();
    onError?.(error);
  }, [fallBackToSvg, onError]);

  const handleWebGlContextLost = React.useCallback((event) => {
    fallBackToSvg();
    onWebGlContextLost?.(event);
  }, [fallBackToSvg, onWebGlContextLost]);

  return (
    <PlotlyPlot
      {...props}
      data={plotData}
      onError={handleError}
      onWebGlContextLost={handleWebGlContextLost}
    />
  );
}
