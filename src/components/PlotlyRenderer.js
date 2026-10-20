import React from 'react';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from './plotlyRuntime';

const PlotlyPlot = createPlotlyComponent(Plotly);

// Keep exports on the same lazy boundary as the curated plotting runtime.
export function downloadPlotImage(graph, options) { return Plotly.downloadImage(graph, options); }

export default function PlotlyRenderer({ onInitialized, useResizeHandler, config, ...props }) {
  const [graph, setGraph] = React.useState(null);
  // Plotly's global zoom/legend tips outlive their page during tab navigation.
  // Keep the visible modebar controls and data hover labels without those tips.
  const plotConfig = React.useMemo(() => ({ showTips: false, ...config }), [config]);
  React.useEffect(() => {
    if (!graph || !useResizeHandler || typeof ResizeObserver === 'undefined') return;
    let timer;
    // A hidden tab can miss window.resize. Observe its own box so returning to
    // it, opening the sidebar, and wrapping a toolbar all resize the chart.
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      if (!graph.clientWidth || !graph.clientHeight) return;
      timer = setTimeout(() => {
        if (graph.isConnected && graph.clientWidth && graph.clientHeight) {
          // Navigation can hide the graph again during Plotly's resize debounce.
          Plotly.Plots.resize(graph).catch(() => {});
        }
      }, 80);
    });
    observer.observe(graph);
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [graph, useResizeHandler]);

  const handleInitialized = React.useCallback((figure, element) => {
    setGraph(element);
    onInitialized?.(figure, element);
  }, [onInitialized]);

  return React.createElement(PlotlyPlot, { ...props, config: plotConfig, useResizeHandler, onInitialized: handleInitialized });
}
