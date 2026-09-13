import Plotly from 'plotly.js/lib/core';
import bar from 'plotly.js/lib/bar';
import box from 'plotly.js/lib/box';
import heatmap from 'plotly.js/lib/heatmap';
import histogram from 'plotly.js/lib/histogram';
import scattergl from 'plotly.js/lib/scattergl';
import scatter3d from 'plotly.js/lib/scatter3d';
import violin from 'plotly.js/lib/violin';

Plotly.register([bar, box, heatmap, histogram, scattergl, scatter3d, violin]);

export default Plotly;
