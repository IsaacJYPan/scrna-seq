// LEGACY / PROTOTYPE — NOT IMPORTED.
// Pathway enrichment is not a production-integrated UI workflow; App.jsx renders a
// PlaceholderPage for the "enrichment" tab instead of this component. This file is
// kept as a legacy live-R prototype (it calls the authenticated /api/r/* proxy).
// Do not build on it without deciding the enrichment product direction first.
// See the "Implemented vs UI-wired" table in README.md.
import React, { useState, useCallback, useEffect } from 'react';
import { Microscope, Activity, ChevronRight, AlertTriangle, RefreshCw, BarChart2, Zap } from 'lucide-react';
import Plot from '../components/Plot';
import { useTabParams } from '../hooks/useTabParams';

const DB_OPTIONS = [
  { value: 'GO_BP', label: 'GO Biological Process', desc: 'Gene Ontology — biological processes' },
  { value: 'GO_MF', label: 'GO Molecular Function', desc: 'Gene Ontology — molecular functions' },
  { value: 'KEGG',  label: 'KEGG Pathways',         desc: 'Kyoto Encyclopedia of Genes and Genomes' },
  { value: 'Reactome', label: 'Reactome',            desc: 'Reactome pathway database (requires ReactomePA)' },
];

export default function Enrichment({ callApi, datasetInfo, clusterProvId, openProvenance, pipelineState, rSessionId, sessionReady, userEmail, objectId }) {
  const [computing, setComputing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [hasHydrated, setHasHydrated] = useState(false);
  const [viewMode, setViewMode] = useState('bar'); // 'bar' | 'bubble'

  // Persisted parameters
  const [params, setParam] = useTabParams('enrichment', userEmail, objectId, {
    database: 'GO_BP',
    pvalCutoff: 0.05,
    logfcThreshold: 0.25,
    topN: 20,
    targetCluster: 'all',
    excludeArtifacts: true,
  });
  const { database, pvalCutoff, logfcThreshold, topN, targetCluster, excludeArtifacts } = params;

  const runEnrichment = useCallback(async (isInitial = false) => {
    setComputing(true);
    setError(null);

    const data = await callApi(
      `/enrichment?database=${database}&pval_cutoff=${pvalCutoff}&logfc_threshold=${logfcThreshold}&top_n=${topN}&target_cluster=${encodeURIComponent(targetCluster)}&exclude_artifacts=${excludeArtifacts}`,
      {},
      {
        operation: 'enrichment',
        step: 'enrichment',
        parentIds: clusterProvId ? [clusterProvId] : [],
        useCache: true,
        cacheParams: { type: 'enrichment', database, pval_cutoff: pvalCutoff, logfc_threshold: logfcThreshold, top_n: topN, target_cluster: targetCluster, exclude_artifacts: excludeArtifacts },
        onlyIfCached: isInitial,
      }
    );

    if (data && data.result) {
      setResult(data);
    } else if (data && data.error && !isInitial) {
      setError(data.error);
    } else if (!data && !isInitial) {
      setError('R backend error. Check the R console for details.');
    }

    setComputing(false);
  }, [callApi, clusterProvId, database, pvalCutoff, logfcThreshold, topN, targetCluster, excludeArtifacts]);

  // Hydration from cache — gated by sessionReady
  useEffect(() => {
    if (datasetInfo && pipelineState?.cluster && !result && !computing && !hasHydrated && sessionReady) {
      setHasHydrated(true);
      runEnrichment(true);
    }
  }, [datasetInfo, pipelineState?.cluster, result, computing, hasHydrated, runEnrichment, sessionReady]);

  // Reset hydration when R session changes
  useEffect(() => {
    setHasHydrated(false);
  }, [rSessionId]);

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <Microscope size={48} className="mx-auto text-slate-400 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-white mb-2">No Dataset Loaded</h2>
          <p className="text-textMuted">Load a dataset in the Workspace first.</p>
        </div>
      </div>
    );
  }

  if (!pipelineState?.cluster) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <AlertTriangle size={48} className="mx-auto text-amber-500 mb-4" />
          <h2 className="text-xl font-bold text-white mb-2">Clustering Required</h2>
          <p className="text-textMuted">Complete the Clustering step before pathway enrichment. DEGs are used as the gene universe for ORA.</p>
        </div>
      </div>
    );
  }

  const pathways = result?.result?.top_pathways || [];

  // Use a smaller minimum height if there are very few pathways, so the single bar isn't huge
  const plotHeight = pathways.length <= 3 ? 200 : Math.max(380, pathways.length * 30);

  // ── Bar chart ──────────────────────────────────────────────────
  const barData = [{
    type: 'bar',
    orientation: 'h',
    x: pathways.map(p => -Math.log10(Math.max(p.p_adj, 1e-300))),
    y: pathways.map(p => {
      const name = String(p.name || '');
      const id = String(p.id || '');
      return (name.length > 40 ? name.slice(0, 37) + '… ' : name + ' ') + `(${id})`;
    }),
    marker: {
      color: pathways.map(p => -Math.log10(Math.max(p.p_adj, 1e-300))),
      colorscale: [
        [0, '#6366f1'],
        [0.5, '#a855f7'],
        [1, '#ec4899'],
      ],
      showscale: true,
      colorbar: { title: { text: '-log10(p-adj)', side: 'right' }, thickness: 12, len: 0.6, x: 1.01 }
    },
    hovertemplate: '<b>%{y}</b><br>-log10(p-adj): %{x:.2f}<extra></extra>'
  }];

  const barLayout = {
    height: plotHeight,
    margin: { l: 280, r: 100, t: 20, b: 50 },
    bargap: pathways.length <= 3 ? 0.6 : 0.2,
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: '#94a3b8', size: 10 },
    xaxis: { title: '-log10(adjusted p-value)', gridcolor: '#334155', zeroline: false },
    yaxis: { gridcolor: '#334155', autorange: 'reversed', tickfont: { size: 10 } },
    hoverlabel: { bgcolor: '#1e293b', bordercolor: '#475569', font: { color: '#e2e8f0', size: 12 } }
  };

  // ── Bubble chart ───────────────────────────────────────────────
  const bubbleData = pathways.length ? [{
    type: 'scattergl',
    mode: 'markers',
    x: pathways.map(p => {
      const r_num = p.gene_ratio_num;
      const ratio_str = String(p.ratio || '0/1');
      return r_num ?? (parseFloat(ratio_str.split('/')[0]) / (parseFloat(ratio_str.split('/')[1]) || 1));
    }),
    y: pathways.map(p => {
      const name = String(p.name || '');
      const id = String(p.id || '');
      return (name.length > 40 ? name.slice(0, 37) + '… ' : name + ' ') + `(${id})`;
    }),
    customdata: pathways.map(p => p.count),
    marker: {
      size: pathways.map(p => Math.max(8, Math.min(30, (p.count || 1) * 2.5))),
      color: pathways.map(p => -Math.log10(Math.max(p.p_adj, 1e-300))),
      colorscale: [[0, '#6366f1'], [0.5, '#a855f7'], [1, '#ec4899']],
      showscale: true,
      colorbar: { title: { text: '-log10(p-adj)', side: 'right' }, thickness: 12, len: 0.6, x: 1.01 },
      opacity: 0.85,
      line: { color: 'rgba(255,255,255,0.2)', width: 1 }
    },
    hovertemplate: '<b>%{y}</b><br>Gene Ratio: %{x:.3f}<br>Genes in term: <b>%{customdata}</b><extra></extra>'
  }] : [];

  const bubbleLayout = {
    height: plotHeight,
    margin: { l: 280, r: 100, t: 20, b: 50 },
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: '#94a3b8', size: 10 },
    xaxis: { title: 'Gene Ratio', gridcolor: '#334155', zeroline: false },
    yaxis: { gridcolor: '#334155', autorange: 'reversed', tickfont: { size: 10 } },
    hoverlabel: { bgcolor: '#1e293b', bordercolor: '#475569', font: { color: '#e2e8f0', size: 12 } }
  };

  return (
    <div className="h-full w-full flex flex-col bg-background p-8 overflow-y-auto custom-scrollbar">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white mb-1 tracking-tight">Pathway Enrichment (ORA)</h2>
          <p className="text-textMuted text-sm">Over-representation analysis against {DB_OPTIONS.find(d => d.value === database)?.desc ?? database}.</p>
        </div>
        <div className="flex gap-3">
          {result && (
            <>
              <button
                className="text-primary border border-primary/50 hover:bg-primary/10 px-3 py-2 rounded text-sm flex items-center gap-2 transition"
                onClick={() => openProvenance(result.provenance.id)}
              >📝 View Script</button>
              <button
                onClick={() => { setResult(null); setHasHydrated(false); }}
                className="btn btn-ghost border border-slate-700 text-slate-400 hover:text-white text-sm flex items-center gap-2"
              >
                <RefreshCw size={14} /> Re-run
              </button>
            </>
          )}
          <button
            onClick={() => runEnrichment()}
            disabled={computing || !!result}
            className={`btn ${result ? 'bg-success/20 text-success border border-success' : 'btn-primary'} flex items-center gap-2`}
          >
            {computing ? <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4" /> : <Activity size={18} />}
            {result ? 'Analysis Complete' : 'Run ORA'}
          </button>
        </div>
      </div>

      {/* Parameter panel */}
      {!result && !computing && (
        <div className="card p-6 mb-6 border-l-4 border-l-primary">
          <h3 className="font-bold flex items-center gap-2 text-white mb-5">
            <Zap size={16} className="text-primary" /> Enrichment Parameters
          </h3>
          <div className="grid grid-cols-3 lg:grid-cols-6 gap-5">
            <div>
              <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Target Cluster</label>
              <select
                value={targetCluster}
                onChange={e => setParam('targetCluster', e.target.value)}
                className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
              >
                <option value="all">All Clusters (Global)</option>
                {Array.from({ length: pipelineState?.clusterCount || 0 }).map((_, i) => (
                  <option key={i} value={i.toString()}>Cluster {i}</option>
                ))}
              </select>
              <p className="text-[10px] text-slate-400 mt-1">Cluster to analyze</p>
            </div>
            <div>
              <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Database</label>
              <select
                value={database}
                onChange={e => setParam('database', e.target.value)}
                className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
              >
                {DB_OPTIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
              <p className="text-[10px] text-slate-400 mt-1">Reference pathway database</p>
            </div>
            <div>
              <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">p-value cutoff</label>
              <input
                type="number" value={pvalCutoff} min={0.001} max={0.2} step={0.01}
                onChange={e => setParam('pvalCutoff', parseFloat(e.target.value))}
                className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
              />
              <p className="text-[10px] text-slate-400 mt-1">Adjusted p-value threshold (BH)</p>
            </div>
            <div>
              <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">logFC threshold</label>
              <input
                type="number" value={logfcThreshold} min={0.1} max={2} step={0.05}
                onChange={e => setParam('logfcThreshold', parseFloat(e.target.value))}
                className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
              />
              <p className="text-[10px] text-slate-400 mt-1">Min log2FC for DEGs</p>
            </div>
            <div>
              <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Top N pathways</label>
              <input
                type="number" value={topN} min={5} max={50} step={1}
                onChange={e => setParam('topN', parseInt(e.target.value))}
                className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
              />
              <p className="text-[10px] text-slate-400 mt-1">Maximum pathways shown</p>
            </div>
            <div>
              <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Clean Artifacts</label>
              <div className="flex items-center h-[42px]">
                <label className="flex items-center cursor-pointer">
                  <div className="relative">
                    <input 
                      type="checkbox" 
                      className="sr-only" 
                      checked={excludeArtifacts}
                      onChange={e => setParam('excludeArtifacts', e.target.checked)}
                    />
                    <div className={`block w-10 h-6 rounded-full transition-colors ${excludeArtifacts ? 'bg-primary' : 'bg-slate-700'}`}></div>
                    <div className={`dot absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${excludeArtifacts ? 'transform translate-x-4' : ''}`}></div>
                  </div>
                  <span className="ml-3 text-sm text-white font-medium">Exclude MT/Ribo</span>
                </label>
              </div>
              <p className="text-[10px] text-slate-400 mt-1">Drop MT-, RPL, RPS genes</p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="card p-4 mb-6 bg-danger/10 border-danger text-danger flex items-start gap-3">
          <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold mb-1">Enrichment Failed</p>
            <p className="text-xs opacity-80 whitespace-pre-wrap">{error}</p>
            <p className="text-[10px] text-danger/60 mt-2">
              Make sure clusterProfiler, org.Hs.eg.db, and ReactomePA are installed:<br />
              <code className="font-mono">BiocManager::install(c("clusterProfiler", "org.Hs.eg.db", "ReactomePA"))</code>
            </p>
          </div>
        </div>
      )}

      {!result && !computing && !error && (
        <div className="card p-12 text-center flex flex-col items-center justify-center flex-1 bg-black/10 border-dashed border-2">
          <Microscope size={56} className="text-primary opacity-40 mb-4" />
          <p className="text-slate-400 max-w-sm mb-6">
            Requires DEGs (Clustering + FindAllMarkers). Runs clusterProfiler ORA against the selected pathway database.
          </p>
          <div className="flex gap-3 flex-wrap justify-center">
            {DB_OPTIONS.map(d => (
              <div key={d.value} className={`px-3 py-1.5 rounded text-xs border transition cursor-pointer ${database === d.value ? 'bg-primary/20 border-primary text-primary' : 'bg-surface border-border text-textMuted hover:border-slate-600'}`}
                onClick={() => setParam('database', d.value)}>
                {d.label}
              </div>
            ))}
          </div>
        </div>
      )}

      {computing && (
        <div className="flex flex-col items-center justify-center flex-1">
          <div className="flex gap-2 mb-4">
            <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
          <span className="text-xs uppercase tracking-widest font-black text-primary animate-pulse">
            Running clusterProfiler ORA ({database})…
          </span>
        </div>
      )}

      {result && (
        <div className="space-y-6 flex-1">
          {/* Summary bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {result._fromCache && (
                <span className="text-[10px] bg-primary/20 text-primary px-2 py-0.5 rounded font-bold">CACHED</span>
              )}
              <span className="text-sm text-slate-400">
                <span className="text-white font-bold">{pathways.length}</span> pathways enriched
                {result.result?.gene_universe_size && (
                  <> from <span className="text-white font-bold">{result.result.gene_universe_size}</span> gene universe</>
                )}
              </span>
              <span className="text-[10px] px-2 py-0.5 bg-slate-800 rounded border border-border text-textMuted">{database}</span>
            </div>
            {/* View toggle */}
            <div className="flex bg-slate-800 rounded-lg p-1 border border-border">
              <button
                onClick={() => setViewMode('bar')}
                className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-1.5 ${viewMode === 'bar' ? 'bg-primary text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
              >
                <BarChart2 size={12} /> Bar
              </button>
              <button
                onClick={() => setViewMode('bubble')}
                className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-1.5 ${viewMode === 'bubble' ? 'bg-primary text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
              >
                ◉ Bubble
              </button>
            </div>
          </div>

          {/* Chart */}
          <div className="card p-6">
            <h3 className="text-xs font-bold text-white uppercase tracking-wider mb-3 flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-primary" />
              {viewMode === 'bar' ? 'Pathway Over-Representation' : 'Gene Ratio Bubble Plot'}
            </h3>
            <Plot
              data={viewMode === 'bar' ? barData : bubbleData}
              layout={viewMode === 'bar' ? barLayout : bubbleLayout}
              config={{ displayModeBar: false, responsive: true }}
              style={{ width: '100%' }}
            />
          </div>

          {/* Table */}
          <div className="card overflow-hidden">
            <div className="p-4 border-b border-border bg-slate-800/40 flex justify-between items-center">
              <h4 className="font-bold text-white text-xs uppercase tracking-widest">Enrichment Table</h4>
              <span className="text-[10px] text-textMuted">{pathways.length} terms</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-black/20 text-textMuted font-bold uppercase border-b border-border">
                  <tr>
                    <th className="p-3">Pathway / Term</th>
                    <th className="p-3 text-center">Count</th>
                    <th className="p-3 text-center">Gene Ratio</th>
                    <th className="p-3 text-center">p-adj (BH)</th>
                    <th className="p-3">Genes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {pathways.map((row, i) => {
                    // genes is a genuine multi-element array from R (geneID column) — handle both formats
                    const genesDisplay = Array.isArray(row.genes)
                      ? row.genes.join(', ')
                      : typeof row.genes === 'string'
                        ? row.genes.split('/').join(', ')
                        : String(row.genes ?? '');
                    return (
                      <tr key={i} className="hover:bg-white/5 transition-colors">
                        <td className="p-3 font-bold text-white flex items-center gap-2">
                          <ChevronRight size={12} className="text-primary flex-shrink-0" />
                          <span>{row.name}</span>
                        </td>
                        <td className="p-3 text-center font-mono">{row.count}</td>
                        <td className="p-3 text-center font-mono opacity-60">{row.ratio}</td>
                        <td className="p-3 text-center text-success font-mono">
                          {typeof row.p_adj === 'number' ? row.p_adj.toExponential(2) : row.p_adj}
                        </td>
                        <td className="p-3 text-slate-400 italic truncate max-w-[220px]" title={genesDisplay}>
                          {genesDisplay}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
