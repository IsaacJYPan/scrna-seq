import Plotly from '../../src/components/plotlyRuntime';

const x = [1, 2, 3, 4, 5];
const y = [2, 5, 3, 4, 1];
const traces = [
  { type: 'scatter', x, y, mode: 'lines+markers' },
  { type: 'scattergl', x, y, mode: 'markers', marker: { size: 12 } },
  { type: 'scatter3d', x, y, z: [2, 1, 3, 5, 4], mode: 'markers' },
  { type: 'bar', x, y },
  { type: 'box', y },
  { type: 'histogram', x: [1, 1, 2, 3, 3, 3, 4] },
  {
    type: 'heatmap',
    z: [
      [1, 2, 3],
      [4, 3, 2],
      [2, 1, 4],
    ],
  },
  { type: 'violin', y, points: 'all' },
];

window.chartAcceptance = (async () => {
  const supported = Object.keys(Plotly.PlotSchema.get().traces);
  if (supported.some((type) => /scattergeo|choropleth|densitymap|scattermap/.test(type)))
    throw new Error('Geographic traces are registered');
  const results = [];
  for (const trace of traces) {
    const graph = document.createElement('div');
    document.getElementById('charts').append(graph);
    await Plotly.newPlot(graph, [trace], {
      width: 420,
      height: 320,
      title: { text: trace.type },
      margin: { t: 45, b: 35, l: 45, r: 20 },
    });
    if (graph._fullData[0].type !== trace.type)
      throw new Error(`${trace.type} fell back to another renderer`);
    if (graph._fullData[0].visible !== true) throw new Error(`${trace.type} is not visible`);
    if (trace.type === 'scattergl' || trace.type === 'scatter3d') {
      const canvases = [...graph.querySelectorAll('canvas')];
      if (!canvases.some((canvas) => canvas.width > 0 && canvas.height > 0)) {
        throw new Error(`${trace.type} has no WebGL canvas`);
      }
    }
    const png = await Plotly.toImage(graph, { format: 'png', width: 420, height: 320 });
    const svg = await Plotly.toImage(graph, { format: 'svg', width: 420, height: 320 });
    if (!png.startsWith('data:image/png;base64,') || png.length < 3000)
      throw new Error(`${trace.type} PNG export failed`);
    if (!svg.startsWith('data:image/svg+xml') || svg.length < 1000)
      throw new Error(`${trace.type} SVG export failed`);
    results.push(trace.type);
  }
  const mixed = document.createElement('div');
  document.getElementById('charts').append(mixed);
  await Plotly.newPlot(mixed, [traces[7], traces[1]], {
    width: 420,
    height: 320,
    title: { text: 'QC mixed traces' },
  });
  await Plotly.react(mixed, [traces[0]], {
    width: 420,
    height: 320,
    title: { text: 'Updated chart' },
  });
  if (mixed._fullData.length !== 1 || mixed._fullData[0].type !== 'scatter')
    throw new Error('Chart update failed');
  Plotly.purge(mixed);
  mixed.remove();
  return results;
})();
