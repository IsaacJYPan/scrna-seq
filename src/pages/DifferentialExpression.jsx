import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Ban,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useTabParams } from '../hooks/useTabParams';
import { publicErrorMessage } from '../publicError';

const DEG_JOB_TYPE = 'deg.find_markers.v1';
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);
const JOB_WRITE_ROLES = new Set(['owner', 'admin', 'analyst']);
const POLL_MS = 3000;

const DEFAULT_PARAMS = {
  groupBy: 'seurat_clusters',
  assay: 'RNA',
  onlyPositive: true,
  minPct: 0.1,
  logfcThreshold: 0.25,
  maxCellsPerIdent: '',
  randomSeed: '',
  topMarkersPerCluster: 10,
};

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function optionalIntOrNull(value, min, max) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function asAllowed(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function buildDegParams(params) {
  return {
    groupBy: asAllowed(params.groupBy, ['seurat_clusters', 'ident'], 'seurat_clusters'),
    assay: asAllowed(params.assay, ['RNA', 'SCT'], 'RNA'),
    onlyPositive: params.onlyPositive !== false,
    minPct: clampNumber(params.minPct, 0, 1, 0.1),
    logfcThreshold: clampNumber(params.logfcThreshold, 0, 10, 0.25),
    testUse: 'wilcox',
    maxCellsPerIdent: optionalIntOrNull(params.maxCellsPerIdent, 1, 100000),
    randomSeed: optionalIntOrNull(params.randomSeed, 0, 2147483647),
    topMarkersPerCluster: Math.trunc(clampNumber(params.topMarkersPerCluster, 5, 50, 10)),
  };
}

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatNumber(value) {
  if (value === null || value === undefined || value === '') return 'NA';
  if (typeof value === 'number') {
    if (Math.abs(value) > 0 && Math.abs(value) < 0.001) return value.toExponential(2);
    return Number.isInteger(value) ? String(value) : value.toFixed(3);
  }
  return String(value);
}

function parseErrorMessage(error) {
  const raw = error?.message || String(error || 'Request failed.');
  try {
    const parsed = JSON.parse(raw);
    return publicErrorMessage(parsed?.error || raw);
  } catch {
    return publicErrorMessage(raw);
  }
}

function statusTone(status) {
  if (status === 'completed') return 'green';
  if (status === 'failed' || status === 'canceled') return 'rose';
  if (status === 'running') return 'blue';
  return 'amber';
}

function displayRunStatus(status) {
  return {
    queued: 'Waiting for compute',
    running: 'Running',
    completed: 'Complete',
    failed: 'Needs attention',
    canceled: 'Canceled',
  }[status] || 'Unknown';
}

function researcherRunNote(entry) {
  if (entry?.level === 'error') return 'This analysis needs attention.';
  const message = String(entry?.message || '');
  if (/completed|finished|published/i.test(message)) return 'Analysis finished.';
  if (/claim|start|running|comput/i.test(message)) return 'Compute started.';
  if (entry?.level === 'warn') return 'Analysis warning recorded.';
  return 'Analysis update recorded.';
}

function badgeClass(tone = 'slate') {
  const tones = {
    blue: 'bg-primary/10 text-text border-primary/20',
    green: 'bg-success/10 text-success border-success/30',
    amber: 'bg-amber-500/10 text-amber-900 dark:text-amber-200 border-amber-500/30',
    rose: 'bg-danger/10 text-danger border-danger/30',
    slate: 'bg-slate-800 text-slate-300 border-slate-700',
  };
  return tones[tone] || tones.slate;
}

function StatusBadge({ children, tone = 'slate' }) {
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${badgeClass(tone)}`}>
      {children}
    </span>
  );
}

function SummaryMetric({ label, value, detail }) {
  return (
    <div className="rounded border border-border bg-surface/70 p-4">
      <div className="text-2xl font-black text-text">{value}</div>
      <div className="mt-1 text-[10px] font-bold uppercase tracking-widest text-textMuted">{label}</div>
      {detail && <div className="mt-2 text-xs text-textMuted">{detail}</div>}
    </div>
  );
}

function EmptyNotice({ title, children }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center">
      <p className="font-bold text-text">{title}</p>
      <p className="mt-2 text-sm text-textMuted">{children}</p>
    </div>
  );
}

function JobLogs({ logs }) {
  const rows = Array.isArray(logs) ? logs : [];
  if (!rows.length) {
    return (
      <EmptyNotice title="No run notes yet">
        Run notes will appear after compute begins.
      </EmptyNotice>
    );
  }

  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-black/20 custom-scrollbar">
      {rows.map((entry, index) => (
        <div key={`${entry?.ts || index}-${index}`} className="border-b border-border/40 p-3 text-xs last:border-b-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <StatusBadge tone={entry?.level === 'error' ? 'rose' : entry?.level === 'warn' ? 'amber' : 'slate'}>
              {entry?.level || 'info'}
            </StatusBadge>
            <span className="font-mono text-textMuted">{formatDate(entry?.ts)}</span>
          </div>
          <p className="text-textMuted">{researcherRunNote(entry)}</p>
        </div>
      ))}
    </div>
  );
}

function TopMarkersTable({ markers }) {
  const rows = Array.isArray(markers) ? markers : [];
  if (!rows.length) {
    return (
      <EmptyNotice title="No top-marker preview">
        The saved summary did not include a top-marker preview.
      </EmptyNotice>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[680px] text-left text-xs">
        <thead className="bg-slate-800 text-[10px] font-bold uppercase tracking-wider text-textMuted">
          <tr>
            <th className="p-3">Group</th>
            <th className="p-3">Gene</th>
            <th className="p-3">avg log2FC</th>
            <th className="p-3">pct 1</th>
            <th className="p-3">pct 2</th>
            <th className="p-3">p adj</th>
            <th className="p-3">Rank</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40 bg-surface/70">
          {rows.map((marker, index) => (
            <tr key={`${marker.group || 'group'}-${marker.gene || 'gene'}-${index}`}>
              <td className="p-3 font-mono text-textMuted">{marker.group || 'NA'}</td>
              <td className="p-3 font-bold text-text">{marker.gene || 'NA'}</td>
              <td className="p-3 font-mono text-textMuted">{formatNumber(marker.avgLog2FC)}</td>
              <td className="p-3 font-mono text-textMuted">{formatNumber(marker.pct1)}</td>
              <td className="p-3 font-mono text-textMuted">{formatNumber(marker.pct2)}</td>
              <td className="p-3 font-mono text-textMuted">{formatNumber(marker.pValAdj)}</td>
              <td className="p-3 font-mono text-textMuted">{formatNumber(marker.rank)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DifferentialExpression({
  datasetInfo,
  pipelineState,
  currentWs,
  userEmail,
  userId,
  objectId,
  sessionReady,
  setActiveTab,
  computeStatus,
  unsavedLiveChanges = false,
  onSaveCurrentAnalysis,
  checkpointSaveBusy = false,
}) {
  const [params, setParam] = useTabParams('deg', userEmail, objectId, DEFAULT_PARAMS);
  const [job, setJob] = useState(null);
  const [logs, setLogs] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);

  const activeProjectId = datasetInfo?.projectId || currentWs?.selectedProjectId || currentWs?.projects?.[0]?.id || null;
  const selectedObjectId = objectId || datasetInfo?.id || currentWs?.selectedObjectIds?.[0] || null;
  const activeProject = (currentWs?.projects || []).find(project => project.id === activeProjectId) || null;
  const selectedAnalysis = (currentWs?.objects || []).find(object => object.id === selectedObjectId)
    || datasetInfo
    || null;
  const selectedAnalysisName = selectedAnalysis?.displayName || selectedAnalysis?.name || 'Selected analysis';
  const isDbBackedObject = typeof selectedObjectId === 'string' && /^ao_[0-9a-f]+$/i.test(selectedObjectId);
  const liveObjectAttached = datasetInfo?.liveState === 'attached';
  const canWriteProject = JOB_WRITE_ROLES.has(activeProject?.role);
  const ownsPrivateLiveObject = !datasetInfo?.ownerUserId
    || Number(datasetInfo.ownerUserId) === Number(userId);
  const computeReady = !computeStatus?.status || computeStatus.status === 'ready';
  const canCancelJob = activeProject?.role === 'owner' || activeProject?.role === 'admin';
  const canLaunch = Boolean(
    userEmail
      && activeProjectId
      && selectedObjectId
      && isDbBackedObject
      && canWriteProject
      && ownsPrivateLiveObject
      && !unsavedLiveChanges
      && !loading
  );

  const safeParams = useMemo(() => buildDegParams(params), [params]);
  const terminal = job?.status ? TERMINAL_STATUSES.has(job.status) : false;
  const summaryArtifact = artifacts.find(artifact => artifact.artifactType === 'deg_summary') || null;
  const markersArtifact = artifacts.find(artifact => artifact.artifactType === 'deg_markers') || null;
  const summary = summaryArtifact?.metadata?.summary || null;
  const resolvedParams = summaryArtifact?.metadata?.resolvedParams || job?.parameters || safeParams;
  const visibleLogs = logs.length ? logs : (Array.isArray(job?.logs) ? job.logs : []);
  const selectionKey = `${activeProjectId || ''}:${selectedObjectId || ''}`;
  const selectionKeyRef = useRef(selectionKey);
  selectionKeyRef.current = selectionKey;

  const refreshJobState = useCallback(async (
    jobId,
    { silent = false, expectedSelectionKey = selectionKeyRef.current } = {}
  ) => {
    if (!jobId || !activeProjectId) return null;
    const api = window.electronAPI || {};
    if (!api.getProjectJob || !api.getProjectJobLogs || !api.listProjectJobArtifacts) {
      if (selectionKeyRef.current === expectedSelectionKey) {
        setError('This analysis service is temporarily unavailable.');
      }
      return null;
    }

    if (!silent) setRefreshing(true);
    try {
      const [nextJob, logResponse, nextArtifacts] = await Promise.all([
        api.getProjectJob(activeProjectId, jobId),
        api.getProjectJobLogs(activeProjectId, jobId),
        api.listProjectJobArtifacts(activeProjectId, jobId),
      ]);
      if (selectionKeyRef.current !== expectedSelectionKey) return null;
      setJob(nextJob || null);
      setLogs(Array.isArray(logResponse?.logs) ? logResponse.logs : []);
      setArtifacts(Array.isArray(nextArtifacts) ? nextArtifacts : []);
      setLastRefreshedAt(new Date().toISOString());
      return nextJob || null;
    } catch (err) {
      if (selectionKeyRef.current === expectedSelectionKey) setError(parseErrorMessage(err));
      return null;
    } finally {
      if (!silent && selectionKeyRef.current === expectedSelectionKey) setRefreshing(false);
    }
  }, [activeProjectId]);

  useEffect(() => {
    let canceled = false;
    setJob(null);
    setLogs([]);
    setArtifacts([]);
    setError(null);
    setLastRefreshedAt(null);
    setRefreshing(false);
    setLoading(false);

    const api = window.electronAPI || {};
    if (!activeProjectId || !selectedObjectId || !api.listProjectJobs) {
      return () => { canceled = true; };
    }

    const restoreLatestJob = async () => {
      try {
        const jobs = await api.listProjectJobs(activeProjectId, {
          jobType: DEG_JOB_TYPE,
          analysisObjectId: selectedObjectId,
        });
        const latest = Array.isArray(jobs) ? jobs[0] : null;
        if (!canceled && latest?.id) {
          await refreshJobState(latest.id, {
            silent: true,
            expectedSelectionKey: selectionKey,
          });
        }
      } catch (err) {
        if (!canceled) setError(parseErrorMessage(err));
      }
    };
    restoreLatestJob();
    return () => { canceled = true; };
  }, [activeProjectId, refreshJobState, selectedObjectId, selectionKey]);

  useEffect(() => {
    if (!job?.id || terminal) return undefined;
    let canceled = false;
    const poll = async () => {
      if (!canceled) await refreshJobState(job.id, { silent: true, expectedSelectionKey: selectionKey });
    };
    const id = window.setInterval(poll, POLL_MS);
    return () => {
      canceled = true;
      window.clearInterval(id);
    };
  }, [job?.id, selectionKey, terminal, refreshJobState]);

  const launchDegJob = useCallback(async () => {
    setError(null);
    if (!userEmail) {
      setError('Sign in before starting marker analysis.');
      return;
    }
    if (!activeProjectId) {
      setError('Select a project before starting marker analysis.');
      return;
    }
    if (!selectedObjectId || !isDbBackedObject) {
      setError('Select a saved analysis before running marker analysis.');
      return;
    }
    if (!canWriteProject) {
      setError('Your project role can view results but cannot start analysis jobs.');
      return;
    }
    if (!ownsPrivateLiveObject) {
      setError('This analysis belongs to another member. Create a branch from its saved version in your private analysis workspace before running marker analysis.');
      return;
    }
    if (unsavedLiveChanges) {
      setError('Save the current analysis before starting this durable run. Unsaved live steps are not included in saved-checkpoint jobs.');
      return;
    }
    const api = window.electronAPI || {};
    if (!api.createDegFindMarkersJob && !api.createProjectJob) {
      setError('Marker analysis is temporarily unavailable.');
      return;
    }

    const requestSelectionKey = selectionKeyRef.current;
    setLoading(true);
    setLogs([]);
    setArtifacts([]);
    try {
      const created = api.createDegFindMarkersJob
        ? await api.createDegFindMarkersJob(activeProjectId, selectedObjectId, safeParams)
        : await api.createProjectJob(activeProjectId, {
          jobType: DEG_JOB_TYPE,
          analysisObjectId: selectedObjectId,
          parameters: safeParams,
        });
      if (selectionKeyRef.current !== requestSelectionKey) return undefined;
      setJob(created);
      setLastRefreshedAt(new Date().toISOString());
      await refreshJobState(created.id, { silent: true, expectedSelectionKey: requestSelectionKey });
    } catch (err) {
      if (selectionKeyRef.current === requestSelectionKey) setError(parseErrorMessage(err));
    } finally {
      if (selectionKeyRef.current === requestSelectionKey) setLoading(false);
    }
    return undefined;
  }, [activeProjectId, canWriteProject, isDbBackedObject, ownsPrivateLiveObject, refreshJobState, safeParams, selectedObjectId, unsavedLiveChanges, userEmail]);

  const cancelDegJob = useCallback(async () => {
    if (!activeProjectId || !job?.id || !canCancelJob) return;
    const api = window.electronAPI || {};
    if (!api.cancelProjectJob) {
      setError('Canceling this analysis is temporarily unavailable.');
      return;
    }
    const requestSelectionKey = selectionKeyRef.current;
    setCanceling(true);
    setError(null);
    try {
      await api.cancelProjectJob(activeProjectId, job.id);
      await refreshJobState(job.id, { silent: true, expectedSelectionKey: requestSelectionKey });
    } catch (err) {
      if (selectionKeyRef.current === requestSelectionKey) setError(parseErrorMessage(err));
    } finally {
      if (selectionKeyRef.current === requestSelectionKey) setCanceling(false);
    }
  }, [activeProjectId, canCancelJob, job?.id, refreshJobState]);

  if (!datasetInfo) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-8 text-center">
        <div className="max-w-sm">
          <FileText size={48} className="mx-auto mb-4 text-slate-400 opacity-50" />
          <h2 className="mb-2 text-xl font-bold text-white">No Dataset Loaded</h2>
          <p className="text-sm text-textMuted">Load or select a saved analysis before running marker analysis.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-background p-6 custom-scrollbar">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-bold tracking-tight text-white">Markers / Differential Expression</h2>
              <StatusBadge tone="slate">recorded run</StatusBadge>
              <StatusBadge tone="blue">controlled export</StatusBadge>
            </div>
            <p className="max-w-3xl text-sm text-textMuted">
              Run marker analysis with approved settings and review its saved scientific summary. Authorized result tables can be exported from Runs &amp; Results.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={launchDegJob}
              disabled={!canLaunch}
              className="btn btn-primary inline-flex items-center gap-2 text-sm shadow-lg shadow-primary/20 disabled:opacity-50"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
              Run marker analysis
            </button>
            {job?.id && (
              <button
                onClick={() => refreshJobState(job.id)}
                disabled={refreshing}
                className="btn btn-secondary inline-flex items-center gap-2 text-sm"
              >
                {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                Refresh
              </button>
            )}
          </div>
        </header>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="rounded-lg border border-border bg-surface/60 p-4">
            <div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Project</div>
            <div className="mt-1 truncate font-bold text-text">{activeProject?.name || 'Selected project'}</div>
          </div>
          <div className="rounded-lg border border-border bg-surface/60 p-4">
            <div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Saved analysis</div>
            <div className="mt-1 truncate text-text" title={selectedAnalysisName}>{selectedObjectId ? selectedAnalysisName : 'None selected'}</div>
          </div>
          <div className="rounded-lg border border-border bg-surface/60 p-4">
            <div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Private analysis workspace</div>
            <div className="mt-1 text-sm text-text">Available only to the analysis owner</div>
          </div>
        </div>

        {isDbBackedObject && ownsPrivateLiveObject && (
          <div className={`rounded-lg border p-4 text-sm ${unsavedLiveChanges ? 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200' : 'border-primary/20 bg-primary/5 text-textMuted'}`}>
            <p><span className="font-bold text-text">Saved checkpoint used by this run:</span> {selectedAnalysisName}</p>
            {unsavedLiveChanges && (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <p>Unsaved live steps will not be included. Save the current analysis before launching.</p>
                {typeof onSaveCurrentAnalysis === 'function' && <button type="button" className="btn btn-secondary text-xs" onClick={onSaveCurrentAnalysis} disabled={checkpointSaveBusy}>{checkpointSaveBusy ? 'Saving…' : 'Save current analysis'}</button>}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-danger">
            <div className="flex items-center gap-2 font-bold"><AlertTriangle size={18} /> Marker analysis unavailable</div>
            <p className="mt-1 text-sm">{publicErrorMessage(error, 'This analysis needs attention. Review the settings and try again.')}</p>
          </div>
        )}

        {!isDbBackedObject && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
            Select a saved analysis before running marker analysis.
          </div>
        )}

        {isDbBackedObject && !canWriteProject && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
            Your project role is read-only. You can inspect saved marker summaries, but only an owner, administrator, or analyst can start a new analysis.
          </div>
        )}

        {isDbBackedObject && canWriteProject && !ownsPrivateLiveObject && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
            This analysis belongs to another member. Use Runs &amp; Results to create a branch from its saved version in your own private analysis workspace.
            <button onClick={() => setActiveTab?.('history')} className="btn btn-secondary ml-3 text-xs">Open Runs &amp; Results</button>
          </div>
        )}

        {isDbBackedObject && canWriteProject && ownsPrivateLiveObject && (!sessionReady || !liveObjectAttached) && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
            Interactive plots are not available until this saved analysis is open in your private workspace. Marker analysis can still run from its private saved checkpoint.
            <button onClick={() => setActiveTab?.(datasetInfo?.source === 'pbmc3k_demo' ? 'workspace' : 'history')} className="btn btn-secondary ml-3 text-xs">
              {datasetInfo?.source === 'pbmc3k_demo' ? 'Open workspace' : 'Open Runs & Results'}
            </button>
          </div>
        )}

        {isDbBackedObject && canWriteProject && ownsPrivateLiveObject && !computeReady && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
            Compute is temporarily unavailable. You can submit this analysis now; it will wait in the durable queue until compute is available.
          </div>
        )}

        <section className="rounded-lg border border-border bg-surface/50 p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-bold text-text">Approved settings</h3>
              <p className="mt-1 text-sm text-textMuted">
                This marker analysis uses approved settings. The statistical test is fixed to Wilcoxon in v1.
              </p>
            </div>
            {!sessionReady || !liveObjectAttached ? (
              <StatusBadge tone="blue">saved checkpoint</StatusBadge>
            ) : pipelineState?.cluster ? (
              <StatusBadge tone="green">cluster groups ready</StatusBadge>
            ) : (
              <StatusBadge tone="amber">cluster groups required</StatusBadge>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">Group by</span>
              <select
                value={params.groupBy}
                onChange={event => setParam('groupBy', event.target.value)}
                className="w-full rounded border border-border bg-surface p-2.5 text-sm text-white focus:border-primary focus:outline-none"
              >
                <option value="seurat_clusters">seurat_clusters</option>
                <option value="ident">Current identities</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">Assay</span>
              <select
                value={params.assay}
                onChange={event => setParam('assay', event.target.value)}
                className="w-full rounded border border-border bg-surface p-2.5 text-sm text-white focus:border-primary focus:outline-none"
              >
                <option value="RNA">RNA</option>
                <option value="SCT">SCT</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">min.pct</span>
              <input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={params.minPct}
                onChange={event => setParam('minPct', event.target.value)}
                className="w-full rounded border border-border bg-surface p-2.5 text-sm text-white focus:border-primary focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">logfc threshold</span>
              <input
                type="number"
                min="0"
                max="10"
                step="0.05"
                value={params.logfcThreshold}
                onChange={event => setParam('logfcThreshold', event.target.value)}
                className="w-full rounded border border-border bg-surface p-2.5 text-sm text-white focus:border-primary focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">Top markers / group</span>
              <input
                type="number"
                min="5"
                max="50"
                step="1"
                value={params.topMarkersPerCluster}
                onChange={event => setParam('topMarkersPerCluster', event.target.value)}
                className="w-full rounded border border-border bg-surface p-2.5 text-sm text-white focus:border-primary focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">Max cells / ident</span>
              <input
                type="number"
                min="1"
                max="100000"
                step="1"
                value={params.maxCellsPerIdent}
                onChange={event => setParam('maxCellsPerIdent', event.target.value)}
                placeholder="No cap"
                className="w-full rounded border border-border bg-surface p-2.5 text-sm text-white placeholder:text-slate-500 focus:border-primary focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">Random seed</span>
              <input
                type="number"
                min="0"
                max="2147483647"
                step="1"
                value={params.randomSeed}
                onChange={event => setParam('randomSeed', event.target.value)}
                placeholder="None"
                className="w-full rounded border border-border bg-surface p-2.5 text-sm text-white placeholder:text-slate-500 focus:border-primary focus:outline-none"
              />
            </label>

            <label className="flex items-center gap-3 rounded border border-border bg-black/10 p-3">
              <input
                type="checkbox"
                checked={params.onlyPositive !== false}
                onChange={event => setParam('onlyPositive', event.target.checked)}
                className="h-4 w-4 rounded border-border bg-surface text-primary"
              />
              <span>
                <span className="block text-sm font-bold text-text">Only positive markers</span>
                <span className="block text-xs text-textMuted">Sent as a strict boolean.</span>
              </span>
            </label>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-surface/50 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-bold text-text">
                <Clock size={18} className="text-primary" />
                Run status
              </h3>
              <p className="mt-1 text-sm text-textMuted">
                Compute is allocated when available. When demand is high, a new analysis waits for compute.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {job?.status && <StatusBadge tone={statusTone(job.status)}>{displayRunStatus(job.status)}</StatusBadge>}
              {job?.id && !terminal && canCancelJob && (
                <button
                  onClick={cancelDegJob}
                  disabled={canceling}
                  className="btn btn-secondary inline-flex items-center gap-1.5 text-xs disabled:opacity-50"
                >
                  {canceling ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />}
                  Cancel run
                </button>
              )}
            </div>
          </div>

          {!job ? (
            <EmptyNotice title="No marker analysis run yet">
              Configure the scientific parameters and run marker analysis when compute is available.
            </EmptyNotice>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Outcome</div>
                  <div className="mt-1 text-text">{displayRunStatus(job.status)}</div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Last refreshed</div>
                  <div className="mt-1 text-text">{formatDate(lastRefreshedAt)}</div>
                </div>
              </div>

              {job.error?.message && (
                <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {publicErrorMessage(job.error, 'This analysis needs attention. Review the settings and try again.')}
                </div>
              )}

              <JobLogs logs={visibleLogs} />
            </div>
          )}
        </section>

        <section className="rounded-lg border border-border bg-surface/50 p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-bold text-text">
                <Archive size={18} className="text-primary" />
                Marker analysis summary
              </h3>
              <p className="mt-1 text-sm text-textMuted">
                This page shows a bounded scientific summary. The full marker table remains a controlled result.
              </p>
            </div>
            {summaryArtifact && <StatusBadge tone="green">summary available</StatusBadge>}
          </div>

          {summary ? (
            <div className="space-y-5">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                <SummaryMetric label="Groups" value={summary.nGroups ?? summary.groups?.length ?? 'NA'} detail={(summary.groups || []).join(', ') || 'Not reported'} />
                <SummaryMetric label="Markers" value={summary.nMarkersTotal ?? 'NA'} detail="Bounded public count" />
                <SummaryMetric label="Assay" value={summary.assay || resolvedParams.assay || 'RNA'} detail={`Group by ${summary.groupBy || resolvedParams.groupBy || 'seurat_clusters'}`} />
                <SummaryMetric label="Test" value={summary.testUse || resolvedParams.testUse || 'wilcox'} detail="Approved settings" />
              </div>

              {Array.isArray(summary.markersPerGroup) && summary.markersPerGroup.length > 0 && (
                <div className="rounded border border-border bg-black/10 p-4">
                  <h4 className="mb-3 text-sm font-bold text-text">Marker Counts By Group</h4>
                  <div className="flex flex-wrap gap-2">
                    {summary.markersPerGroup.map(row => (
                      <span key={row.group} className="rounded border border-border bg-surface px-3 py-1 text-xs text-textMuted">
                        <span className="font-mono text-text">{row.group}</span>: {row.n}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <h4 className="mb-3 text-sm font-bold text-text">Top Marker Preview</h4>
                <TopMarkersTable markers={summary.topMarkers} />
              </div>

              <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm text-textMuted">
                <div className="mb-1 flex items-center gap-2 font-bold text-text">
                  <CheckCircle2 size={16} className="text-primary" />
                  Marker analysis complete
                </div>
                A saved summary is available. The full marker table is a private, audited export in Runs &amp; Results.
              </div>
            </div>
          ) : job?.status === 'completed' ? (
            <EmptyNotice title="Marker analysis completed without a summary">
              Review the run notes. If the private marker table completed, its authorized export is available in Runs &amp; Results.
            </EmptyNotice>
          ) : (
            <EmptyNotice title="No DEG summary yet">
              A scientific summary will appear here after the analysis completes successfully.
            </EmptyNotice>
          )}

          {markersArtifact && (
            <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
              A private marker table is available through the authorized, audited export in Runs &amp; Results.
            </div>
          )}
        </section>

        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm text-textMuted">
          <div className="mb-1 flex items-center gap-2 font-bold text-text">
            <ShieldCheck size={16} className="text-primary" />
            Boundary note
          </div>
          Project membership shows metadata only. A saved analysis can be opened only in its owner&apos;s private analysis workspace. Result exports require authorization and visibility checks; saved versions are never downloadable.
        </div>
      </div>
    </div>
  );
}
