import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, Tags } from 'lucide-react';
import { isTransientComputeBusy, publicErrorMessage } from '../publicError';

// Mirrors the R-side rule for a column that can become the active identity
// and the Study Design "cell type column" field.
const COLUMN_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const PROTECTED_COLUMNS = new Set(['seurat_clusters', 'nCount_RNA', 'nFeature_RNA', 'percent.mt']);
const MAX_LABEL_CHARS = 80;
const SOURCE_COLUMN = 'seurat_clusters';

function clusterSortKey(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

// Genes detected in few of a cluster's cells can top a fold-change ranking
// while saying little about what the cluster is. Within each cluster's preview
// (already in rank order), list widely detected markers first.
const WIDELY_DETECTED = 0.25;

export function topGenesByGroup(markers, perGroup = 5) {
  const rowsByGroup = new Map();
  for (const marker of Array.isArray(markers) ? markers : []) {
    const group = marker?.group === undefined || marker?.group === null ? null : String(marker.group);
    if (group === null || typeof marker.gene !== 'string') continue;
    rowsByGroup.set(group, [...(rowsByGroup.get(group) || []), marker]);
  }
  const byGroup = new Map();
  for (const [group, rows] of rowsByGroup) {
    const wide = rows.filter(row => !(Number(row.pct1) < WIDELY_DETECTED));
    const narrow = rows.filter(row => Number(row.pct1) < WIDELY_DETECTED);
    byGroup.set(group, [...wide, ...narrow].slice(0, perGroup).map(row => row.gene));
  }
  return byGroup;
}

export function validateAnnotation({ columnName, labels, clusters }) {
  const name = String(columnName || '').trim();
  if (!COLUMN_NAME_PATTERN.test(name)) {
    return 'Column name must start with a letter and use only letters, numbers, ".", "_" or "-" (64 characters at most).';
  }
  if (PROTECTED_COLUMNS.has(name)) return `"${name}" holds computed values. Choose a new column name, such as cell_type.`;
  const missing = clusters.filter(cluster => !String(labels[cluster] || '').trim());
  if (missing.length) return `Label every cluster before applying (${missing.length} remaining).`;
  const tooLong = clusters.find(cluster => String(labels[cluster]).trim().length > MAX_LABEL_CHARS);
  if (tooLong !== undefined) return `The label for cluster ${tooLong} is longer than ${MAX_LABEL_CHARS} characters.`;
  // eslint-disable-next-line no-control-regex
  if (clusters.some(cluster => /[\u0000-\u001f\u007f]/.test(String(labels[cluster])))) return 'Labels cannot contain control characters.';
  return null;
}

export const CLUSTERS_MISSING_MESSAGE = 'This analysis has no clusters yet. Run clustering, then refresh clusters.';
export const CLUSTERS_BUSY_MESSAGE = 'R is still busy with this analysis, for example loading a large saved version. Wait a moment, then select Refresh clusters.';

// Only a missing cluster column means clustering has not run. While R is
// loading or busy with a large object, the request is refused, times out or
// finds no object yet; saying "run clustering" then sends the researcher the
// wrong way.
export function clusterLoadErrorMessage(loadError) {
  const raw = String(loadError?.message || loadError || '');
  if (/was not found in object metadata/i.test(raw)) return CLUSTERS_MISSING_MESSAGE;
  if (/^no object loaded$/i.test(raw.trim()) || isTransientComputeBusy(loadError)) return CLUSTERS_BUSY_MESSAGE;
  return publicErrorMessage(loadError, CLUSTERS_BUSY_MESSAGE);
}

export default function ClusterAnnotationPanel({
  callApi,
  liveObjectAttached,
  markers,
  unsavedLiveChanges = false,
  onSaveCurrentAnalysis,
  checkpointSaveBusy = false,
}) {
  const [clusters, setClusters] = useState([]);
  const [labels, setLabels] = useState({});
  const [columnName, setColumnName] = useState('cell_type');
  const [setIdentity, setSetIdentity] = useState(true);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState(null);
  const [applied, setApplied] = useState(null);

  const loadClusters = useCallback(async () => {
    if (!liveObjectAttached || typeof callApi !== 'function') return;
    setLoading(true);
    setError(null);
    try {
      let data;
      // Other views on the page can briefly hold this user's shared R slot.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        data = await callApi(`/meta-values?column=${encodeURIComponent(SOURCE_COLUMN)}`, {}, { useCache: false });
        if (!isTransientComputeBusy(data?.error) || attempt === 5) break;
        await new Promise(resolve => window.setTimeout(resolve, 400 * (attempt + 1)));
      }
      if (data?.error) throw new Error(data.error);
      const values = (Array.isArray(data?.values) ? data.values : [])
        .filter(row => row && row.value !== undefined && row.value !== null)
        .map(row => ({ value: String(row.value), count: Number(row.count) || 0 }))
        .sort((a, b) => clusterSortKey(a.value) - clusterSortKey(b.value) || a.value.localeCompare(b.value));
      setClusters(values);
      setLabels(current => Object.fromEntries(values.map(row => [row.value, current[row.value] || ''])));
      if (data?.truncated) setError('This object has more clusters than can be labeled here. Use the Inspect step to map them.');
    } catch (loadError) {
      setError(clusterLoadErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [callApi, liveObjectAttached]);

  useEffect(() => { loadClusters(); }, [loadClusters]);

  const markerHints = useMemo(() => topGenesByGroup(markers), [markers]);
  const clusterIds = clusters.map(row => row.value);
  const validationError = clusters.length ? validateAnnotation({ columnName, labels, clusters: clusterIds }) : null;
  const distinctLabels = new Set(clusterIds.map(cluster => String(labels[cluster] || '').trim()).filter(Boolean));

  const apply = async () => {
    if (validationError || applying) return;
    setApplying(true);
    setError(null);
    setApplied(null);
    try {
      const mapping = Object.fromEntries(clusterIds.map(cluster => [cluster, String(labels[cluster]).trim()]));
      const data = await callApi('/add-meta-mapping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_col: SOURCE_COLUMN,
          new_col: columnName.trim(),
          mapping,
          set_identity: setIdentity,
        }),
      }, { useCache: false });
      if (data?.error) throw new Error(data.error);
      setApplied({
        column: columnName.trim(),
        identity: setIdentity,
        levels: Array.isArray(data?.identity_levels) ? data.identity_levels : [...distinctLabels],
        mappedCells: data?.mapped_cells,
      });
    } catch (applyError) {
      setError(publicErrorMessage(applyError, 'Cluster labels could not be applied.'));
    } finally {
      setApplying(false);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-surface/50 p-5" aria-labelledby="cluster-annotation-heading" data-testid="cluster-annotation-panel">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="cluster-annotation-heading" className="flex items-center gap-2 text-lg font-bold text-text">
            <Tags size={18} className="text-primary" /> Annotate clusters
          </h3>
          <p className="mt-1 max-w-3xl text-sm text-textMuted">
            Name each cluster from its marker genes. The labels are added as a new metadata column; the numeric clusters stay unchanged.
            Labels are your interpretation and are recorded as such.
          </p>
        </div>
        <button type="button" className="btn btn-secondary inline-flex items-center gap-2 text-sm" onClick={loadClusters} disabled={loading || !liveObjectAttached}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh clusters
        </button>
      </div>

      {!liveObjectAttached ? (
        <p className="text-sm text-textMuted">Open this saved version in your private analysis workspace to annotate its clusters.</p>
      ) : loading && !clusters.length ? (
        <p className="flex items-center gap-2 text-sm text-textMuted"><Loader2 size={14} className="animate-spin" /> Loading clusters…</p>
      ) : clusters.length === 0 ? (
        error
          ? <p className="text-sm text-amber-700 dark:text-amber-300" role="alert">{error}</p>
          : <p className="text-sm text-textMuted">No clusters found. Run clustering, then refresh.</p>
      ) : (
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="bg-background text-xs font-medium text-textMuted">
                <tr>
                  <th className="p-3">Cluster</th>
                  <th className="p-3">Cells</th>
                  <th className="p-3">Top markers</th>
                  <th className="p-3">Label</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40 bg-surface/70">
                {clusters.map(row => (
                  <tr key={row.value}>
                    <td className="p-3 font-mono text-text">{row.value}</td>
                    <td className="p-3 font-mono text-textMuted">{row.count.toLocaleString()}</td>
                    <td className="p-3 text-xs text-textMuted">{(markerHints.get(row.value) || []).join(', ') || '—'}</td>
                    <td className="p-3">
                      <input
                        type="text"
                        className="input w-full"
                        aria-label={`Label for cluster ${row.value}`}
                        maxLength={MAX_LABEL_CHARS}
                        value={labels[row.value] || ''}
                        placeholder="e.g. CD14+ monocytes"
                        onChange={event => setLabels(current => ({ ...current, [row.value]: event.target.value }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm text-text">
              New column name
              <input
                type="text"
                className="input mt-1 block w-full font-mono"
                aria-label="Annotation column name"
                value={columnName}
                maxLength={64}
                onChange={event => setColumnName(event.target.value)}
              />
              <span className="mt-1 block text-xs text-textMuted">Use this name as the cell type column in Study Design.</span>
            </label>
            <label className="flex items-start gap-2 text-sm text-text md:mt-6">
              <input type="checkbox" className="mt-1" checked={setIdentity} onChange={event => setSetIdentity(event.target.checked)} />
              <span>
                Use these labels as the current identities
                <span className="block text-xs text-textMuted">UMAP, dot plots, and analyses run with &ldquo;Current identities&rdquo; then group cells by label.</span>
              </span>
            </label>
          </div>

          {validationError && <p className="text-xs text-textMuted" role="status">{validationError}</p>}
          {error && <p className="text-sm text-rose-600 dark:text-rose-300" role="alert">{error}</p>}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-primary inline-flex items-center gap-2" onClick={apply} disabled={Boolean(validationError) || applying || checkpointSaveBusy}>
              {applying ? <Loader2 size={15} className="animate-spin" /> : <Tags size={15} />}
              Apply {distinctLabels.size || ''} label{distinctLabels.size === 1 ? '' : 's'}
            </button>
          </div>

          {applied && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-text" role="status">
              <div className="mb-1 flex items-center gap-2 font-bold">
                <CheckCircle2 size={16} className="text-emerald-600 dark:text-emerald-300" />
                Added <code className="font-mono">{applied.column}</code>{applied.identity ? ' and set it as the current identities' : ''}
              </div>
              <p className="text-textMuted">
                {applied.levels.length} cell type{applied.levels.length === 1 ? '' : 's'}: {applied.levels.join(', ')}.
                {' '}Save the analysis so queued runs (markers, pseudobulk, CellChat) use the labels.
              </p>
              {unsavedLiveChanges && typeof onSaveCurrentAnalysis === 'function' && (
                <button type="button" className="btn btn-secondary mt-3 text-sm" onClick={() => onSaveCurrentAnalysis()} disabled={checkpointSaveBusy}>
                  {checkpointSaveBusy ? 'Saving…' : 'Save analysis'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
