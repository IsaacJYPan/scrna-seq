// LEGACY / PROTOTYPE — NOT IMPORTED.
// CellChat is not a production-integrated UI workflow; App.jsx renders a
// PlaceholderPage for the "cellchat" tab instead of this component. This file is
// kept as a legacy live-R prototype (it calls the authenticated /api/r/* proxy).
// Do not build on it without deciding the CellChat product direction first.
// See the "Implemented vs UI-wired" table in README.md.
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MessageSquare, Play, Loader2, AlertCircle, Download, Search } from 'lucide-react';
import Plot from 'react-plotly.js';
import { usePipelineStep } from '../hooks/usePipelineStep';

// ─── Publication color palette (matches CellChat R package defaults) ───────────
const CELL_COLORS = [
  '#E41A1C','#377EB8','#4DAF4A','#984EA3','#FF7F00',
  '#A65628','#F781BF','#999999','#66C2A5','#FC8D62',
  '#8DA0CB','#E78AC3','#A6D854','#FFD92F','#E5C494',
  '#B3B3B3','#8DD3C7','#FFFFB3','#BEBADA','#FB8072',
];

function getColor(i) { return CELL_COLORS[i % CELL_COLORS.length]; }

// ─── Circle (Chord) Plot ─────────────────────────────────────────────────────
function CirclePlot({ nodes, edges, threshold }) {
  const svgRef = useRef(null);
  const [hovered, setHovered] = useState(null);
  const [tooltip, setTooltip] = useState(null);

  const filtered = edges.filter(e => e.weight >= threshold);
  const maxW = filtered.length ? Math.max(...filtered.map(e => e.weight)) : 1;

  const N = nodes.length;
  const cx = 250, cy = 250, R = 185, nodeR = 14;

  const angle = (i) => (2 * Math.PI * i / N) - Math.PI / 2;
  const px = (i) => cx + R * Math.cos(angle(i));
  const py = (i) => cy + R * Math.sin(angle(i));

  const nodeIndex = Object.fromEntries(nodes.map((n, i) => [n, i]));

  // build bezier path from node i to node j
  const arcPath = (i, j, isSelf) => {
    if (isSelf) {
      // small loop outside the circle
      const ax = px(i), ay = py(i);
      const outR = nodeR + 18;
      const nx = ax + outR * Math.cos(angle(i));
      const ny = ay + outR * Math.sin(angle(i));
      const lx = ax + outR * Math.cos(angle(i) - 0.35);
      const ly = ay + outR * Math.sin(angle(i) - 0.35);
      const rx = ax + outR * Math.cos(angle(i) + 0.35);
      const ry = ay + outR * Math.sin(angle(i) + 0.35);
      return `M ${lx} ${ly} Q ${nx + Math.cos(angle(i))*22} ${ny + Math.sin(angle(i))*22} ${rx} ${ry}`;
    }
    const x1 = px(i), y1 = py(i);
    const x2 = px(j), y2 = py(j);
    // pull control point towards center
    const cpx = cx + (x1 + x2 - 2 * cx) * 0.15;
    const cpy = cy + (y1 + y2 - 2 * cy) * 0.15;
    return `M ${x1} ${y1} Q ${cpx} ${cpy} ${x2} ${y2}`;
  };

  const isActive = (e) => {
    if (hovered === null) return true;
    const si = nodeIndex[e.source], ti = nodeIndex[e.target];
    return si === hovered || ti === hovered;
  };

  // counts for summary sidebar
  const outCount = hovered !== null ? filtered.filter(e => nodeIndex[e.source] === hovered).length : 0;
  const inCount  = hovered !== null ? filtered.filter(e => nodeIndex[e.target] === hovered).length : 0;
  const outStr   = hovered !== null ? filtered.filter(e => nodeIndex[e.source] === hovered).reduce((s,e)=>s+e.weight,0).toFixed(3) : 0;
  const inStr    = hovered !== null ? filtered.filter(e => nodeIndex[e.target] === hovered).reduce((s,e)=>s+e.weight,0).toFixed(3) : 0;

  return (
    <div className="flex gap-4 h-full">
      <div className="flex-1 relative">
        <svg
          ref={svgRef}
          viewBox="0 0 500 500"
          className="w-full h-full"
          style={{ maxHeight: 480 }}
        >
          {/* arrowhead marker defs */}
          <defs>
            {nodes.map((n, i) => (
              <marker
                key={i}
                id={`arrow-${i}`}
                markerWidth="6" markerHeight="6"
                refX="5" refY="3"
                orient="auto"
              >
                <path d="M0,0 L0,6 L6,3 z" fill={getColor(i)} />
              </marker>
            ))}
            <marker id="arrow-dim" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" fill="#cbd5e1" />
            </marker>
          </defs>

          {/* edges */}
          {filtered.map((e, idx) => {
            const si = nodeIndex[e.source], ti = nodeIndex[e.target];
            const isSelf = si === ti;
            const active = isActive(e);
            const isOut = hovered !== null && si === hovered;
            const strokeW = Math.max(0.8, (e.weight / maxW) * 6);
            const color = active ? (isOut ? getColor(si) : (hovered !== null && ti === hovered ? getColor(si) : getColor(si))) : '#cbd5e1';
            const opacity = active ? (hovered !== null ? 0.85 : 0.45) : 0.12;
            return (
              <path
                key={idx}
                d={arcPath(si, ti, isSelf)}
                stroke={color}
                strokeWidth={strokeW}
                fill="none"
                opacity={opacity}
                markerEnd={active && !isSelf ? `url(#arrow-${si})` : undefined}
                style={{ transition: 'opacity 0.2s' }}
                onMouseEnter={(ev) => {
                  const rect = svgRef.current.getBoundingClientRect();
                  setTooltip({
                    x: ev.clientX - rect.left,
                    y: ev.clientY - rect.top,
                    text: `${e.source} → ${e.target}: ${e.weight.toFixed(4)}`
                  });
                }}
                onMouseLeave={() => setTooltip(null)}
              />
            );
          })}

          {/* nodes */}
          {nodes.map((n, i) => {
            const dim = hovered !== null && hovered !== i;
            return (
              <g key={i}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                style={{ cursor: 'pointer' }}
              >
                <circle
                  cx={px(i)} cy={py(i)} r={nodeR}
                  fill={getColor(i)}
                  stroke="#fff" strokeWidth={2}
                  opacity={dim ? 0.35 : 1}
                  style={{ transition: 'opacity 0.2s' }}
                />
                {/* label */}
                {(() => {
                  const a = angle(i);
                  const labelR = R + nodeR + 12;
                  const lx = cx + labelR * Math.cos(a);
                  const ly = cy + labelR * Math.sin(a);
                  const anchor = Math.cos(a) > 0.1 ? 'start' : Math.cos(a) < -0.1 ? 'end' : 'middle';
                  return (
                    <text
                      x={lx} y={ly}
                      textAnchor={anchor}
                      dominantBaseline="central"
                      fontSize={10}
                      fontFamily="Inter, sans-serif"
                      fontWeight={hovered === i ? '700' : '500'}
                      fill={dim ? '#94a3b8' : '#1e293b'}
                      style={{ transition: 'fill 0.2s, font-weight 0.1s', userSelect: 'none' }}
                    >
                      {n}
                    </text>
                  );
                })()}
              </g>
            );
          })}
        </svg>

        {/* SVG tooltip */}
        {tooltip && (
          <div
            className="absolute z-10 pointer-events-none bg-slate-900 text-white text-xs px-2 py-1 rounded shadow-lg"
            style={{ left: tooltip.x + 8, top: tooltip.y - 20 }}
          >
            {tooltip.text}
          </div>
        )}
      </div>

      {/* Sidebar summary */}
      <div className="w-44 flex flex-col gap-3 justify-center shrink-0">
        {hovered !== null ? (
          <>
            <div className="rounded-lg p-3 border" style={{ borderColor: getColor(hovered), background: getColor(hovered) + '18' }}>
              <div className="text-xs font-bold mb-1" style={{ color: getColor(hovered) }}>{nodes[hovered]}</div>
              <div className="text-xs text-slate-500 mb-2">Outgoing signals</div>
              <div className="text-lg font-black text-slate-800">{outCount}</div>
              <div className="text-xs text-slate-400">interactions</div>
              <div className="text-sm font-semibold text-slate-600 mt-1">{outStr}</div>
              <div className="text-xs text-slate-400">total strength</div>
            </div>
            <div className="rounded-lg p-3 border border-slate-200 bg-slate-50">
              <div className="text-xs text-slate-500 mb-2">Incoming signals</div>
              <div className="text-lg font-black text-slate-800">{inCount}</div>
              <div className="text-xs text-slate-400">interactions</div>
              <div className="text-sm font-semibold text-slate-600 mt-1">{inStr}</div>
              <div className="text-xs text-slate-400">total strength</div>
            </div>
          </>
        ) : (
          <div className="text-center text-xs text-slate-400 px-2">
            Hover a node to see its signaling statistics
          </div>
        )}
        {/* legend */}
        <div className="mt-4 space-y-1">
          {nodes.map((n, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full shrink-0" style={{ background: getColor(i) }} />
              <span className="text-xs text-slate-600 truncate">{n}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Interaction Heatmap ─────────────────────────────────────────────────────
function InteractionHeatmap({ nodes, edges, threshold }) {
  const filtered = edges.filter(e => e.weight >= threshold);
  const matrix = Array.from({ length: nodes.length }, () => Array(nodes.length).fill(0));
  const nodeIdx = Object.fromEntries(nodes.map((n, i) => [n, i]));
  filtered.forEach(e => { matrix[nodeIdx[e.source]][nodeIdx[e.target]] += e.weight; });

  const zValues = matrix;
  const maxZ = Math.max(...zValues.flat());

  return (
    <Plot
      data={[{
        type: 'heatmap',
        z: zValues,
        x: nodes,
        y: nodes,
        colorscale: [
          [0, '#f8fafc'],
          [0.001, '#dbeafe'],
          [0.3, '#3b82f6'],
          [0.7, '#1d4ed8'],
          [1, '#172554'],
        ],
        zmin: 0,
        zmax: maxZ || 1,
        showscale: true,
        hoverongaps: false,
        colorbar: {
          title: { text: 'Communication<br>Probability', side: 'right', font: { size: 11, color: '#475569' } },
          thickness: 14,
          len: 0.8,
          tickfont: { size: 10, color: '#475569' },
          outlinecolor: '#e2e8f0',
          outlinewidth: 1,
        },
        hovertemplate: '<b>Sender:</b> %{y}<br><b>Receiver:</b> %{x}<br><b>Prob:</b> %{z:.4f}<extra></extra>',
      }]}
      layout={{
        paper_bgcolor: '#ffffff',
        plot_bgcolor: '#ffffff',
        margin: { t: 20, l: 90, r: 20, b: 100 },
        xaxis: {
          title: { text: 'Receiver', font: { size: 12, color: '#475569' }, standoff: 12 },
          tickfont: { size: 10, color: '#374151' },
          tickangle: -40,
          showgrid: false,
          linecolor: '#e2e8f0',
          side: 'bottom',
        },
        yaxis: {
          title: { text: 'Sender', font: { size: 12, color: '#475569' }, standoff: 8 },
          tickfont: { size: 10, color: '#374151' },
          showgrid: false,
          linecolor: '#e2e8f0',
          autorange: 'reversed',
        },
        autosize: true,
        font: { family: 'Inter, sans-serif' },
      }}
      useResizeHandler
      className="w-full h-full min-h-[420px]"
      config={{ displayModeBar: false, responsive: true }}
    />
  );
}

// ─── Interaction Count Bubble Plot ───────────────────────────────────────────
function BubblePlot({ nodes, edges, threshold }) {
  const filtered = edges.filter(e => e.weight >= threshold);
  const nodeIdx = Object.fromEntries(nodes.map((n, i) => [n, i]));

  // Build sender × receiver interaction count and mean probability
  const countMatrix = Array.from({ length: nodes.length }, () => Array(nodes.length).fill(0));
  const sumMatrix   = Array.from({ length: nodes.length }, () => Array(nodes.length).fill(0));
  filtered.forEach(e => {
    const si = nodeIdx[e.source], ti = nodeIdx[e.target];
    countMatrix[si][ti]++;
    sumMatrix[si][ti] += e.weight;
  });

  const xArr = [], yArr = [], sizeArr = [], colorArr = [], textArr = [];
  nodes.forEach((sender, si) => {
    nodes.forEach((receiver, ti) => {
      const cnt = countMatrix[si][ti];
      if (cnt > 0) {
        xArr.push(receiver);
        yArr.push(sender);
        sizeArr.push(cnt);
        colorArr.push(sumMatrix[si][ti] / cnt);
        textArr.push(`${sender} → ${receiver}<br>Interactions: ${cnt}<br>Mean prob: ${(sumMatrix[si][ti]/cnt).toFixed(4)}`);
      }
    });
  });

  const maxSize = Math.max(...sizeArr, 1);
  const bubbleSizes = sizeArr.map(s => 8 + (s / maxSize) * 28);

  return (
    <Plot
      data={[{
        type: 'scatter',
        mode: 'markers',
        x: xArr,
        y: yArr,
        text: textArr,
        hovertemplate: '%{text}<extra></extra>',
        marker: {
          size: bubbleSizes,
          color: colorArr,
          colorscale: [
            [0, '#f0fdf4'],
            [0.3, '#86efac'],
            [0.6, '#16a34a'],
            [1, '#052e16'],
          ],
          showscale: true,
          colorbar: {
            title: { text: 'Mean<br>Prob.', side: 'right', font: { size: 11, color: '#475569' } },
            thickness: 14,
            len: 0.75,
            tickfont: { size: 10, color: '#475569' },
            outlinecolor: '#e2e8f0',
            outlinewidth: 1,
          },
          line: { color: '#fff', width: 1 },
          sizemode: 'diameter',
        },
      }]}
      layout={{
        paper_bgcolor: '#ffffff',
        plot_bgcolor: '#f8fafc',
        margin: { t: 20, l: 100, r: 20, b: 110 },
        xaxis: {
          title: { text: 'Receiver', font: { size: 12, color: '#475569' }, standoff: 14 },
          tickfont: { size: 10, color: '#374151' },
          tickangle: -40,
          showgrid: true,
          gridcolor: '#e2e8f0',
          linecolor: '#e2e8f0',
          zeroline: false,
        },
        yaxis: {
          title: { text: 'Sender', font: { size: 12, color: '#475569' }, standoff: 8 },
          tickfont: { size: 10, color: '#374151' },
          showgrid: true,
          gridcolor: '#e2e8f0',
          linecolor: '#e2e8f0',
          zeroline: false,
          autorange: 'reversed',
        },
        autosize: true,
        font: { family: 'Inter, sans-serif' },
      }}
      useResizeHandler
      className="w-full h-full min-h-[420px]"
      config={{ displayModeBar: false, responsive: true }}
    />
  );
}

// ─── Interactions Table ──────────────────────────────────────────────────────
function InteractionsTable({ nodes, edges, threshold }) {
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState('weight');
  const [sortAsc, setSortAsc] = useState(false);

  const filtered = edges
    .filter(e => e.weight >= threshold)
    .filter(e => {
      const q = search.toLowerCase();
      return !q || e.source.toLowerCase().includes(q) || e.target.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const va = a[sortField] ?? 0, vb = b[sortField] ?? 0;
      if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortAsc ? va - vb : vb - va;
    });

  const handleSort = (field) => {
    if (sortField === field) setSortAsc(!sortAsc);
    else { setSortField(field); setSortAsc(field === 'source' || field === 'target'); }
  };

  const exportCSV = () => {
    const rows = [['Sender', 'Receiver', 'Weight'], ...filtered.map(e => [e.source, e.target, e.weight])];
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'cellchat_interactions.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <span className="ml-1 text-slate-300">↕</span>;
    return <span className="ml-1 text-blue-500">{sortAsc ? '↑' : '↓'}</span>;
  };

  const thClass = 'px-4 py-2 text-left text-xs font-bold text-slate-500 uppercase tracking-wider cursor-pointer select-none hover:text-slate-700 whitespace-nowrap';
  const tdClass = 'px-4 py-2 text-sm text-slate-700';

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by cell type..."
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white text-slate-700 focus:outline-none focus:border-blue-400"
          />
        </div>
        <span className="text-xs text-slate-400">{filtered.length} interactions</span>
        <button onClick={exportCSV} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-50 text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors ml-auto">
          <Download size={13} /> Export CSV
        </button>
      </div>

      <div className="flex-1 overflow-auto rounded-lg border border-slate-200">
        <table className="w-full border-collapse bg-white">
          <thead className="sticky top-0 bg-slate-50 border-b border-slate-200">
            <tr>
              <th className={thClass} onClick={() => handleSort('source')}>Sender <SortIcon field="source" /></th>
              <th className={thClass} onClick={() => handleSort('target')}>Receiver <SortIcon field="target" /></th>
              <th className={thClass} onClick={() => handleSort('weight')}>Comm. Probability <SortIcon field="weight" /></th>
              <th className={`${thClass} w-32`}>Strength</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((e, idx) => {
              const si = nodes.indexOf(e.source);
              const maxW = Math.max(...edges.map(x => x.weight));
              const pct = ((e.weight / maxW) * 100).toFixed(0);
              return (
                <tr key={idx} className="hover:bg-blue-50/40 transition-colors">
                  <td className={tdClass}>
                    <span className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: getColor(si) }} />
                      {e.source}
                    </span>
                  </td>
                  <td className={tdClass}>
                    <span className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: getColor(nodes.indexOf(e.target)) }} />
                      {e.target}
                    </span>
                  </td>
                  <td className={tdClass + ' font-mono'}>{e.weight.toExponential(3)}</td>
                  <td className={tdClass}>
                    <div className="w-full bg-slate-100 rounded-full h-1.5">
                      <div className="h-1.5 rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="text-center py-12 text-slate-400 text-sm">No interactions match the current filter.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main CellChat Page ──────────────────────────────────────────────────────
const VIEWS = [
  { id: 'circle',  label: 'Circle Plot' },
  { id: 'heatmap', label: 'Heatmap' },
  { id: 'bubble',  label: 'Bubble Plot' },
  { id: 'table',   label: 'Interactions' },
];

export default function CellChat({
  callApi,
  datasetInfo,
  pipelineState,
  rSessionId,
  sessionReady,
  clusterProvId,
}) {
  const [groupBy, setGroupBy]   = useState('seurat_clusters');
  const [database, setDatabase] = useState('human');
  const [columns, setColumns]   = useState([]);
  const [viewMode, setViewMode] = useState('circle');
  const [threshold, setThreshold] = useState(0);
  const [maxWeight, setMaxWeight] = useState(1);

  const { running, result, error, runStep } = usePipelineStep({
    callApi,
    endpoint: '/cellchat-infer',
    payload: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_by: groupBy, database }),
    },
    ipcContext: {
      operation: 'cellchat',
      step: 'cellchat',
      parentIds: clusterProvId ? [clusterProvId] : [],
      useCache: true,
      cacheParams: { type: 'cellchat', groupBy, database },
    },
    readyToHydrate: false,
    sessionReady,
    rSessionId,
  });

  useEffect(() => {
    if (datasetInfo) {
      callApi('/object-info').then(data => {
        if (data?.meta_cols) {
          const catCols = data.meta_cols.filter(c => c.type !== 'numeric').map(c => c.name);
          setColumns(catCols);
          if (catCols.includes('seurat_clusters')) setGroupBy('seurat_clusters');
          else if (catCols.length > 0) setGroupBy(catCols[0]);
        }
      });
    }
  }, [datasetInfo, callApi]);

  // update threshold range when new results arrive
  useEffect(() => {
    if (result?.result?.edges?.length) {
      const weights = result.result.edges.map(e => e.weight);
      const mx = Math.max(...weights);
      setMaxWeight(mx);
      setThreshold(0);
    }
  }, [result]);

  const hasResult = !!(result?.result?.edges?.length);
  const nodes  = hasResult ? result.result.nodes  : [];
  const edges  = hasResult ? result.result.edges  : [];
  const activeCount = edges.filter(e => e.weight >= threshold).length;

  if (!datasetInfo) {
    return <div className="p-8 text-center text-textMuted">Please load a dataset first.</div>;
  }
  if (!pipelineState?.normalize) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-md">
          <AlertCircle size={48} className="mx-auto text-amber-500 mb-4" />
          <h2 className="text-xl font-bold text-white mb-2">Normalization Required</h2>
          <p className="text-slate-400 text-sm">CellChat requires normalized expression data. Please run Normalization first.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-6 bg-background overflow-hidden">
      <div className="max-w-6xl w-full mx-auto h-full flex flex-col gap-5">

        {/* Header */}
        <header>
          <h1 className="text-3xl font-black text-text flex items-center gap-3">
            <MessageSquare className="text-primary" size={32} />
            CellChat Inference
          </h1>
          <p className="text-textMuted mt-1">
            Infer cell-cell communication networks from single-cell gene expression data.
          </p>
        </header>

        {/* Controls */}
        <section className="bg-surface border border-border rounded-xl p-5 shadow-sm shrink-0">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
            <div>
              <label htmlFor="cc-group" className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Cell Grouping</label>
              <select
                id="cc-group"
                value={groupBy}
                onChange={e => setGroupBy(e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-4 py-2 text-text text-sm focus:outline-none focus:border-primary"
              >
                {columns.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="cc-db" className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Ligand-Receptor Database</label>
              <select
                id="cc-db"
                value={database}
                onChange={e => setDatabase(e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-4 py-2 text-text text-sm focus:outline-none focus:border-primary"
              >
                <option value="human">Human (CellChatDB.human)</option>
                <option value="mouse">Mouse (CellChatDB.mouse)</option>
              </select>
            </div>
            <div>
              <button
                onClick={() => runStep()}
                disabled={running}
                className="btn btn-primary w-full flex items-center justify-center gap-2"
              >
                {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                {running ? 'Inferring…' : 'Run CellChat'}
              </button>
            </div>
          </div>
          {error && (
            <div className="mt-4 p-3 bg-danger/10 border border-danger/30 rounded-lg text-danger text-sm flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span className="whitespace-pre-wrap">{error}</span>
            </div>
          )}
        </section>

        {/* Results panel */}
        <section className="flex-1 bg-surface border border-border rounded-xl shadow-sm min-h-0 flex flex-col overflow-hidden">

          {/* Toolbar — only visible once we have data */}
          {hasResult && (
            <div className="flex items-center gap-4 px-5 py-3 border-b border-border shrink-0 flex-wrap">
              {/* view mode tabs */}
              <div className="flex rounded-lg overflow-hidden border border-border">
                {VIEWS.map(v => (
                  <button
                    key={v.id}
                    onClick={() => setViewMode(v.id)}
                    className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                      viewMode === v.id
                        ? 'bg-primary text-white'
                        : 'bg-surface text-textMuted hover:text-text'
                    }`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>

              {/* threshold slider */}
              <div className="flex items-center gap-3 flex-1 min-w-[200px] max-w-sm">
                <span className="text-xs text-slate-400 whitespace-nowrap">Min. prob.</span>
                <input
                  type="range"
                  min={0} max={maxWeight}
                  step={maxWeight / 200}
                  value={threshold}
                  onChange={e => setThreshold(parseFloat(e.target.value))}
                  className="flex-1 accent-primary h-1"
                />
                <span className="text-xs font-mono text-textMuted w-16 text-right">
                  {threshold.toExponential(2)}
                </span>
              </div>

              {/* interaction count badge */}
              <span className="ml-auto text-xs text-textMuted">
                <span className="font-bold text-text">{activeCount}</span> / {edges.length} interactions
              </span>
            </div>
          )}

          {/* Chart area */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {!running && !hasResult && (
              <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-2">
                <MessageSquare size={40} className="opacity-20" />
                <p className="text-sm text-slate-300">Configure parameters and click <strong>Run CellChat</strong> to begin.</p>
              </div>
            )}
            {running && (
              <div className="h-full flex flex-col items-center justify-center text-slate-400">
                <Loader2 size={36} className="animate-spin mb-4 text-primary" />
                <p>Computing communication probabilities…</p>
                <p className="text-xs mt-2 text-slate-500">This may take several minutes for large datasets.</p>
              </div>
            )}

            {!running && hasResult && (
              /* White "paper" wrapper — publication feel */
              <div className="h-full overflow-auto bg-white p-5">
                {viewMode === 'circle'  && <CirclePlot  nodes={nodes} edges={edges} threshold={threshold} />}
                {viewMode === 'heatmap' && <InteractionHeatmap nodes={nodes} edges={edges} threshold={threshold} />}
                {viewMode === 'bubble'  && <BubblePlot  nodes={nodes} edges={edges} threshold={threshold} />}
                {viewMode === 'table'   && <InteractionsTable nodes={nodes} edges={edges} threshold={threshold} />}
              </div>
            )}
          </div>
        </section>

      </div>
    </div>
  );
}
