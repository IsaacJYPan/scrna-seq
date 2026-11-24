import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Plot from '../components/Plot';
import { BarChart3, Loader2, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import { publicErrorMessage } from '../publicError';
import PageHeader from '../components/PageHeader';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { TARGET_DISCONNECTED_MESSAGE } from '../runtime/executionTarget';
import { displayRunStatus } from '../components/analysisRunDisplay';

const TERMINAL = new Set(['completed', 'failed', 'canceled']);
const WRITE_ROLES = new Set(['owner', 'admin', 'analyst']);
const MAX_FEATURES_PER_RECIPE = 12;

// Enough distinct colours that a typical annotation (up to 20 groups) does not repeat.
const GROUP_COLORS = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
  '#aec7e8', '#ffbb78', '#98df8a', '#ff9896', '#c5b0d5', '#c49c94', '#f7b6d2', '#c7c7c7', '#dbdb8d', '#9edae5',
];

function compositionPlot(rows) {
  const labels = [...new Set(rows.map(row => row.label).filter(Boolean))];
  const conditionOf = new Map(rows.filter(row => row.condition).map(row => [row.label, row.condition]));
  // Keep samples of one condition together so composition shifts read left to right.
  labels.sort((a, b) => (conditionOf.get(a) || '').localeCompare(conditionOf.get(b) || '') || a.localeCompare(b, undefined, { numeric: true }));
  const tick = label => (conditionOf.has(label) ? `${conditionOf.get(label)} · ${label}` : label);
  const groups = [...new Set(rows.map(row => row.group).filter(Boolean))];
  const byKey = new Map(rows.map(row => [`${row.label}\u0000${row.group}`, row]));
  return {
    data: groups.map((group, index) => ({
      type: 'bar',
      name: group,
      x: labels.map(tick),
      y: labels.map(label => (byKey.get(`${label}\u0000${group}`)?.fraction ?? 0) * 100),
      customdata: labels.map(label => byKey.get(`${label}\u0000${group}`)?.count ?? 0),
      marker: { color: GROUP_COLORS[index % GROUP_COLORS.length] },
      hovertemplate: `%{x}<br>${group}: %{y:.1f}% (%{customdata:,} cells)<extra></extra>`,
    })),
    layout: {
      barmode: 'stack',
      height: 480,
      xaxis: { type: 'category', tickangle: -40, automargin: true },
      yaxis: { title: { text: 'Percent of cells' }, range: [0, 100] },
      legend: { font: { size: 10 } },
    },
  };
}

function panelPlot(panel) {
  const rows = Array.isArray(panel?.rows) ? panel.rows : [];
  if (panel?.type === 'composition') return compositionPlot(rows);
  if (panel?.type === 'feature_group') {
    const features = [...new Set(rows.map(row => row.feature).filter(Boolean))];
    const groups = [...new Set(rows.map(row => row.group).filter(Boolean))];
    const byKey = new Map(rows.map(row => [`${row.feature}\u0000${row.group}`, row]));
    return {
      data: [{
        type: 'heatmap',
        x: groups,
        y: features,
        z: features.map(feature => groups.map(group => byKey.get(`${feature}\u0000${group}`)?.average ?? null)),
        customdata: features.map(feature => groups.map(group => byKey.get(`${feature}\u0000${group}`)?.pctDetected ?? null)),
        colorscale: 'Viridis',
        hovertemplate: '%{y} · %{x}<br>Average: %{z:.3f}<br>Detected: %{customdata:.1f}%<extra></extra>',
      }],
      // Cluster names such as "12" are labels, not positions: show every one.
      layout: { xaxis: { type: 'category', tickmode: 'linear', dtick: 1, tickangle: 0 } },
    };
  }
  if (panel?.type === 'histogram') {
    return {
      data: [{
        type: 'bar',
        x: rows.map(row => (Number(row.start) + Number(row.end)) / 2),
        y: rows.map(row => row.count),
        marker: { color: '#2563eb' },
        hovertemplate: 'Bin center: %{x:.3f}<br>Cells: %{y}<extra></extra>',
      }],
    };
  }
  return {
    data: [{
      type: 'bar',
      x: rows.map(row => row.label),
      y: rows.map(row => row.count),
      marker: { color: '#0f766e' },
      hovertemplate: '%{x}<br>Cells: %{y}<extra></extra>',
    }],
  };
}

export default function ExploratoryAnalysis({
  currentWs,
  datasetInfo,
  objectId,
  userEmail,
  userId,
  theme = 'light',
}) {
  const { blocked } = useExecutionTarget();
  const [recipe, setRecipe] = useState('overview');
  const [features, setFeatures] = useState('MS4A1, CD3D, LST1');
  const [groupBy, setGroupBy] = useState('seurat_clusters');
  const [metadataField, setMetadataField] = useState('nFeature_RNA');
  const [splitField, setSplitField] = useState('sample_id');
  const [job, setJob] = useState(null);
  const [artifacts, setArtifacts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const projectId = datasetInfo?.projectId || currentWs?.selectedProjectId || null;
  const analysisObjectId = objectId || datasetInfo?.id || null;
  const project = (currentWs?.projects || []).find(item => item.id === projectId);
  const ownsObject = !datasetInfo?.ownerUserId || Number(datasetInfo.ownerUserId) === Number(userId);
  const canWrite = WRITE_ROLES.has(project?.role);
  const canLaunch = canWrite && ownsObject;
  const summaryArtifact = artifacts.find(item => item.artifactType === 'exploration_summary');
  const summary = summaryArtifact?.metadata?.summary || null;

  const requestedFeatures = useMemo(
    () => [...new Set(features.split(',').map(value => value.trim()).filter(Boolean))],
    [features],
  );
  const params = useMemo(() => {
    // The server's largest group budget, so typical cluster counts are not cut.
    const base = { recipe, maxGroups: 32, histogramBins: 24 };
    if (recipe === 'feature_by_group') {
      return {
        ...base,
        features: requestedFeatures.slice(0, MAX_FEATURES_PER_RECIPE),
        groupBy,
      };
    }
    if (recipe === 'metadata_distribution') return { ...base, metadataField: metadataField.trim() };
    if (recipe === 'group_composition') return { ...base, metadataField: splitField.trim(), groupBy };
    return base;
  }, [requestedFeatures, groupBy, metadataField, splitField, recipe]);

  const refresh = useCallback(async (jobId) => {
    const api = window.electronAPI || {};
    if (!projectId || !jobId || !api.getProjectJob) return null;
    const [nextJob, nextArtifacts] = await Promise.all([
      api.getProjectJob(projectId, jobId),
      api.listProjectJobArtifacts(projectId, jobId),
    ]);
    setJob(nextJob);
    setArtifacts(Array.isArray(nextArtifacts) ? nextArtifacts : []);
    return nextJob;
  }, [projectId]);

  useEffect(() => {
    if (blocked || !job?.id || TERMINAL.has(job.status)) return undefined;
    const timer = window.setInterval(() => refresh(job.id).catch(() => {}), 2000);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status, refresh, blocked]);

  const launch = async () => {
    setError('');
    if (blocked) return setError(TARGET_DISCONNECTED_MESSAGE);
    if (!userEmail || !projectId || !analysisObjectId) return setError('Select a dataset first.');
    if (!canWrite) return setError('Your project role cannot start analyses.');
    if (!ownsObject) return setError('Create a branch from this saved version in your private analysis workspace before exploring it.');
    if (recipe === 'feature_by_group' && params.features.length === 0) return setError('Enter at least one feature.');
    if ((recipe === 'metadata_distribution' || recipe === 'group_composition') && !params.metadataField) return setError('Enter a metadata field.');
    const api = window.electronAPI || {};
    if (!api.createExploratoryAnalysisJob) return setError('Exploratory analysis is unavailable.');
    setBusy(true);
    setArtifacts([]);
    try {
      const created = await api.createExploratoryAnalysisJob(projectId, analysisObjectId, params);
      setJob(created);
      await refresh(created.id);
    } catch (requestError) {
      setError(publicErrorMessage(requestError, 'Exploratory analysis could not be started.'));
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 bg-background text-text">
      <div className="mx-auto max-w-6xl space-y-5">
        <PageHeader title="Exploratory Analysis" icon={BarChart3} description="Run guided recipes against a dataset. Outputs are aggregate summaries suitable for inspection and supplemental-figure drafting; no arbitrary code is accepted." />
        {blocked && <p role="status" className="rounded border border-amber-300 p-3 text-sm">{TARGET_DISCONNECTED_MESSAGE} Previously loaded summaries remain available.</p>}

        {!canLaunch && (
          <div role="note" className="rounded-lg border border-primary/25 bg-primary/5 p-3 text-sm text-textMuted">
            {canWrite
              ? 'Create a private checkpoint copy before starting exploratory analysis from a collaborator’s saved version.'
              : 'This is a read-only project view. Your role can inspect recorded results but cannot start a new analysis.'}
          </div>
        )}
        <fieldset disabled={blocked || !canLaunch || busy} className="grid gap-4 rounded-xl border border-border bg-surface p-4 md:grid-cols-3 disabled:opacity-60">
          <label className="text-sm font-medium">Recipe
            <select className="input mt-1 w-full" value={recipe} onChange={event => setRecipe(event.target.value)}>
              <option value="overview">Dataset overview</option>
              <option value="feature_by_group">Feature expression by group</option>
              <option value="metadata_distribution">Metadata distribution</option>
              <option value="group_composition">Group composition by sample</option>
            </select>
          </label>
          {recipe === 'feature_by_group' && <>
            <label className="text-sm font-medium md:col-span-1">Features (comma separated, up to {MAX_FEATURES_PER_RECIPE})
              <input className="input mt-1 w-full" value={features} onChange={event => setFeatures(event.target.value)} />
              {requestedFeatures.length > MAX_FEATURES_PER_RECIPE && (
                <span role="status" className="mt-1 block text-xs font-normal text-amber-800 dark:text-amber-200">
                  Only the first {MAX_FEATURES_PER_RECIPE} genes will be used: {requestedFeatures.slice(MAX_FEATURES_PER_RECIPE).join(', ')} will be left out.
                </span>
              )}
            </label>
            <label className="text-sm font-medium">Group by
              <select className="input mt-1 w-full" value={groupBy} onChange={event => setGroupBy(event.target.value)}>
                <option value="seurat_clusters">Seurat clusters</option>
                <option value="ident">Current identities</option>
              </select>
            </label>
          </>}
          {recipe === 'group_composition' && <>
            <label className="text-sm font-medium">Split cells by (metadata column)
              <input className="input mt-1 w-full" value={splitField} onChange={event => setSplitField(event.target.value)} />
              <span className="mt-1 block text-xs font-normal text-textMuted">Usually sample_id or condition. Each bar shows the share of each group.</span>
            </label>
            <label className="text-sm font-medium">Groups
              <select className="input mt-1 w-full" value={groupBy} onChange={event => setGroupBy(event.target.value)}>
                <option value="seurat_clusters">Seurat clusters</option>
                <option value="ident">Current identities</option>
              </select>
            </label>
          </>}
          {recipe === 'metadata_distribution' && <label className="text-sm font-medium md:col-span-2">Metadata field
            <input className="input mt-1 w-full" value={metadataField} onChange={event => setMetadataField(event.target.value)} />
          </label>}
          <div className="flex items-end">
            <button type="button" className="btn btn-primary flex items-center gap-2" onClick={launch} disabled={blocked || busy || !canLaunch}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />} Run recipe
            </button>
          </div>
        </fieldset>

        <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
          <ShieldCheck size={18} className="text-success" />
          <span>Private analysis workspace · aggregate-only result</span>
          {job?.status && <span className="ml-auto text-xs font-semibold text-textMuted">{displayRunStatus(job.status, 'Preparing')}</span>}
          {job?.id && <button className="btn btn-secondary p-2" onClick={() => refresh(job.id)} aria-label="Refresh result"><RefreshCw size={14} /></button>}
        </div>
        {error && <div className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div>}

        {summary && <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-lg border border-border bg-surface p-3"><div className="text-xs text-textMuted">Cells</div><div className="text-xl font-bold">{summary.nCells?.toLocaleString?.() ?? '—'}</div></div>
            <div className="rounded-lg border border-border bg-surface p-3"><div className="text-xs text-textMuted">Features</div><div className="text-xl font-bold">{summary.nFeatures?.toLocaleString?.() ?? '—'}</div></div>
            <div className="rounded-lg border border-border bg-surface p-3"><div className="text-xs text-textMuted">Recipe</div><div className="text-sm font-semibold">{summary.recipe}</div></div>
            <div className="rounded-lg border border-border bg-surface p-3"><div className="text-xs text-textMuted">Panels</div><div className="text-xl font-bold">{summary.panels?.length || 0}</div></div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {(summary.panels || []).map((panel, index) => {
              const plot = panelPlot(panel);
              return <div key={`${panel.title}-${index}`} className={`rounded-xl border border-border bg-surface p-3${panel.type === 'composition' ? ' lg:col-span-2' : ''}`}>
                <Plot
                  data={plot.data}
                  layout={{ title: { text: panel.title, font: { size: 15 } }, height: 360, margin: { l: 70, r: 20, t: 55, b: 70 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', font: { color: theme === 'dark' ? '#e2e8f0' : '#0f172a' }, ...(plot.layout || {}) }}
                  config={{ responsive: true, displaylogo: false }}
                  useResizeHandler
                  style={{ width: '100%' }}
                />
              </div>;
            })}
          </div>
        </>}
      </div>
    </div>
  );
}
