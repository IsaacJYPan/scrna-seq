import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Plot from '../components/Plot';
import { BarChart3, Loader2, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import { publicErrorMessage } from '../publicError';

const JOB_TYPE = 'explore.summarize.v1';
const TERMINAL = new Set(['completed', 'failed', 'canceled']);
const WRITE_ROLES = new Set(['owner', 'admin', 'analyst']);

function displayRunStatus(status) {
  return {
    queued: 'Waiting for compute',
    running: 'Running',
    completed: 'Complete',
    failed: 'Needs attention',
    canceled: 'Canceled',
  }[status] || 'Preparing';
}

function panelPlot(panel) {
  const rows = Array.isArray(panel?.rows) ? panel.rows : [];
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
  computeStatus,
  theme = 'light',
}) {
  const [recipe, setRecipe] = useState('overview');
  const [features, setFeatures] = useState('MS4A1, CD3D, LST1');
  const [groupBy, setGroupBy] = useState('seurat_clusters');
  const [metadataField, setMetadataField] = useState('nFeature_RNA');
  const [job, setJob] = useState(null);
  const [artifacts, setArtifacts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const projectId = datasetInfo?.projectId || currentWs?.selectedProjectId || null;
  const analysisObjectId = objectId || datasetInfo?.id || null;
  const project = (currentWs?.projects || []).find(item => item.id === projectId);
  const ownsObject = !datasetInfo?.ownerUserId || Number(datasetInfo.ownerUserId) === Number(userId);
  const canWrite = WRITE_ROLES.has(project?.role);
  const computeReady = !computeStatus?.status || computeStatus.status === 'ready';
  const summaryArtifact = artifacts.find(item => item.artifactType === 'exploration_summary');
  const summary = summaryArtifact?.metadata?.summary || null;

  const params = useMemo(() => {
    const base = { recipe, maxGroups: 24, histogramBins: 24 };
    if (recipe === 'feature_by_group') {
      return {
        ...base,
        features: [...new Set(features.split(',').map(value => value.trim()).filter(Boolean))].slice(0, 12),
        groupBy,
      };
    }
    if (recipe === 'metadata_distribution') return { ...base, metadataField: metadataField.trim() };
    return base;
  }, [features, groupBy, metadataField, recipe]);

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
    if (!job?.id || TERMINAL.has(job.status)) return undefined;
    const timer = window.setInterval(() => refresh(job.id).catch(() => {}), 2000);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status, refresh]);

  const launch = async () => {
    setError('');
    if (!userEmail || !projectId || !analysisObjectId) return setError('Select a saved analysis first.');
    if (!canWrite) return setError('Your project role cannot start analyses.');
    if (!ownsObject) return setError('Create a branch from this saved version in your private analysis workspace before exploring it.');
    if (!computeReady) return setError('Compute is currently unavailable.');
    if (recipe === 'feature_by_group' && params.features.length === 0) return setError('Enter at least one feature.');
    if (recipe === 'metadata_distribution' && !params.metadataField) return setError('Enter a metadata field.');
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
    <div className="h-full overflow-y-auto p-6 bg-background text-text">
      <div className="mx-auto max-w-6xl space-y-5">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold"><BarChart3 size={24} /> Exploratory Analysis</h2>
          <p className="mt-1 text-sm text-textMuted">
            Run guided recipes against a saved analysis. Outputs are aggregate summaries suitable for inspection and supplemental-figure drafting; no arbitrary code is accepted.
          </p>
        </div>

        <div className="grid gap-4 rounded-xl border border-border bg-surface p-4 md:grid-cols-3">
          <label className="text-sm font-medium">Recipe
            <select className="input mt-1 w-full" value={recipe} onChange={event => setRecipe(event.target.value)}>
              <option value="overview">Dataset overview</option>
              <option value="feature_by_group">Feature expression by group</option>
              <option value="metadata_distribution">Metadata distribution</option>
            </select>
          </label>
          {recipe === 'feature_by_group' && <>
            <label className="text-sm font-medium md:col-span-1">Features (comma separated)
              <input className="input mt-1 w-full" value={features} onChange={event => setFeatures(event.target.value)} />
            </label>
            <label className="text-sm font-medium">Group by
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
            <button className="btn btn-primary flex items-center gap-2" onClick={launch} disabled={busy || !computeReady}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />} Run recipe
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
          <ShieldCheck size={18} className="text-success" />
          {/* Legacy infrastructure wording intentionally withheld from the researcher UI:
          <span>Private checkpoint hydration · isolated runtime · aggregate-only result</span>
          */}
          <span>Private analysis workspace · aggregate-only result</span>
          {job?.status && <span className="ml-auto text-xs font-semibold text-textMuted">{displayRunStatus(job.status)}</span>}
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
              return <div key={`${panel.title}-${index}`} className="rounded-xl border border-border bg-surface p-3">
                <Plot
                  data={plot.data}
                  layout={{ title: { text: panel.title, font: { size: 15 } }, height: 360, margin: { l: 70, r: 20, t: 55, b: 70 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', font: { color: theme === 'dark' ? '#e2e8f0' : '#0f172a' } }}
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
