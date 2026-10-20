import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Ban,
  Clock,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useTabParams } from '../hooks/useTabParams';
import { hasAttachedLiveRObject } from '../liveRState';
import { publicErrorMessage } from '../publicError';
import PageHeader from '../components/PageHeader';

const ENRICHMENT_JOB_TYPE = 'enrichment.gsea.v1';
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);
const POLL_MS = 3000;
const JOB_WRITE_ROLES = new Set(['owner', 'admin', 'analyst']);
const SAFE_TARGET_GROUP_RE = /^[A-Za-z0-9 ._+()-]+$/;

const DEFAULT_PARAMS = {
  groupBy: 'seurat_clusters',
  assay: 'RNA',
  targetGroup: '',
  species: '',
  geneSetCollection: 'GO_BP',
  minGeneSetSize: 15,
  maxGeneSetSize: 500,
  adjustedPValueCutoff: 0.05,
  topPathways: 15,
  maxCellsPerIdent: 10000,
  randomSeed: 1,
};

function clampNumber(value, min, max, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function allowedValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function isSafeTargetGroup(value) {
  const label = String(value ?? '').trim();
  return label.length >= 1
    && label.length <= 80
    && SAFE_TARGET_GROUP_RE.test(label)
    && label !== '.'
    && label !== '..'
    && !/^(?:www\.|(?:https?|file):)/i.test(label);
}

function buildEnrichmentParams(params) {
  const minGeneSetSize = Math.trunc(clampNumber(params.minGeneSetSize, 10, 200, 15));
  const maxGeneSetSize = Math.trunc(clampNumber(params.maxGeneSetSize, 50, 2000, 500));
  return {
    groupBy: allowedValue(params.groupBy, ['seurat_clusters', 'ident'], 'seurat_clusters'),
    assay: allowedValue(params.assay, ['RNA', 'SCT'], 'RNA'),
    targetGroup: String(params.targetGroup ?? '').trim().slice(0, 80),
    species: allowedValue(params.species, ['human', 'mouse'], ''),
    geneSetCollection: 'GO_BP',
    minGeneSetSize,
    maxGeneSetSize: Math.max(minGeneSetSize, maxGeneSetSize),
    adjustedPValueCutoff: clampNumber(params.adjustedPValueCutoff, 0.000001, 1, 0.05),
    topPathways: Math.trunc(clampNumber(params.topPathways, 5, 25, 15)),
    maxCellsPerIdent: Math.trunc(clampNumber(params.maxCellsPerIdent, 10, 100000, 10000)),
    randomSeed: Math.trunc(clampNumber(params.randomSeed, 0, 2147483647, 1)),
  };
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

function redactUnsafeText(value) {
  return String(value || '')
    .replace(/[A-Za-z]:[\\/][^\s'")]+/g, '[redacted path]')
    .replace(/\/__private_vault__\/[^\s'")]+/g, '[redacted path]')
    .replace(/\bvault\/[^\s'")]+/gi, '[redacted storage]')
    .replace(/\bstorage_?(uri|key)\b/gi, '[redacted storage field]')
    .replace(/\bclaim_?token\b/gi, '[redacted worker field]')
    .replace(/\bstate_?key\b/gi, '[redacted state field]')
    .replace(/\buser-\d+:obj-[A-Za-z0-9_-]+/g, '[redacted state]');
}

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatNumber(value, digits = 3) {
  if (value === null || value === undefined || value === '') return 'NA';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (number !== 0 && Math.abs(number) < 0.001) return number.toExponential(2);
  return Number.isInteger(number) ? String(number) : number.toFixed(digits);
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'NA';
  const fraction = number > 1 ? number / 100 : number;
  return `${(fraction * 100).toFixed(1)}%`;
}

function badgeTone(status) {
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

function StatusBadge({ children, tone = 'slate' }) {
  const tones = {
    blue: 'bg-primary/10 text-text border-primary/20',
    green: 'bg-success/10 text-success border-success/30',
    amber: 'bg-amber-500/10 text-amber-900 dark:text-amber-200 border-amber-500/30',
    rose: 'bg-danger/10 text-danger border-danger/30',
    slate: 'bg-background text-textMuted border-border',
  };
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tones[tone] || tones.slate}`}>
      {children}
    </span>
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

function Metric({ label, value, detail }) {
  return (
    <div className="rounded border border-border bg-surface/70 p-4">
      <div className="text-2xl font-black text-text">{value}</div>
      <div className="mt-1 text-[10px] font-bold uppercase tracking-widest text-textMuted">{label}</div>
      {detail && <div className="mt-2 text-xs text-textMuted">{detail}</div>}
    </div>
  );
}

function JobLogs({ logs }) {
  const rows = Array.isArray(logs) ? logs : [];
  if (!rows.length) return <EmptyNotice title="No run notes yet">Run notes appear after compute begins.</EmptyNotice>;
  return (
    <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-black/20 custom-scrollbar">
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

function PathwayTable({ pathways }) {
  const rows = Array.isArray(pathways) ? pathways : [];
  if (!rows.length) {
    return <EmptyNotice title="No pathways returned">The analysis did not return any pathway rows for this comparison.</EmptyNotice>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[780px] text-left text-xs">
        <thead className="bg-background text-[10px] font-bold uppercase tracking-wider text-textMuted">
          <tr>
            <th className="p-3">Pathway</th>
            <th className="p-3">Direction in target</th>
            <th className="p-3">Enrichment score (NES)</th>
            <th className="p-3">Adjusted p-value</th>
            <th className="p-3">Set size</th>
            <th className="p-3">ID</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40 bg-surface/70">
          {rows.map((pathway, index) => (
            <tr key={`${pathway.id || pathway.name || 'pathway'}-${index}`}>
              <td className="max-w-md p-3 font-bold text-text">{pathway.name || 'Unnamed pathway'}</td>
              <td className="p-3 text-textMuted">{
                pathway.direction === 'positive'
                  ? 'higher in target'
                  : pathway.direction === 'negative'
                    ? 'lower in target'
                    : pathway.direction === 'neutral' ? 'no clear direction' : 'NA'
              }</td>
              <td className="p-3 font-mono text-textMuted">{formatNumber(pathway.normalizedEnrichmentScore)}</td>
              <td className="p-3 font-mono text-textMuted">{formatNumber(pathway.adjustedPValue)}</td>
              <td className="p-3 font-mono text-textMuted">{formatNumber(pathway.setSize, 0)}</td>
              <td className="p-3 font-mono text-textMuted">{pathway.id || 'NA'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PathwayEnrichment({
  callApi,
  datasetInfo,
  currentWs,
  userEmail,
  userId,
  objectId,
  rSessionId,
  sessionReady,
  setActiveTab,
  computeStatus,
  unsavedLiveChanges = false,
  onSaveCurrentAnalysis,
  checkpointSaveBusy = false,
}) {
  const [params, setParam] = useTabParams('enrichment', userEmail, objectId, DEFAULT_PARAMS);
  const [job, setJob] = useState(null);
  const [logs, setLogs] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [targetGroups, setTargetGroups] = useState([]);
  const [targetGroupsLoading, setTargetGroupsLoading] = useState(false);

  const activeProjectId = datasetInfo?.projectId || currentWs?.selectedProjectId || currentWs?.projects?.[0]?.id || null;
  const selectedObjectId = objectId || datasetInfo?.id || currentWs?.selectedObjectIds?.[0] || null;
  const activeProject = (currentWs?.projects || []).find(project => project.id === activeProjectId) || null;
  const selectedAnalysis = (currentWs?.objects || []).find(object => object.id === selectedObjectId)
    || datasetInfo
    || null;
  const selectedAnalysisName = selectedAnalysis?.displayName || selectedAnalysis?.name || 'Selected analysis';
  const isDbBackedObject = typeof selectedObjectId === 'string' && /^ao_[0-9a-f]+$/i.test(selectedObjectId);
  const liveObjectAttached = hasAttachedLiveRObject(datasetInfo);
  const canWriteProject = JOB_WRITE_ROLES.has(activeProject?.role);
  const ownsPrivateLiveObject = !datasetInfo?.ownerUserId
    || Number(datasetInfo.ownerUserId) === Number(userId);
  const computeReady = !computeStatus?.status || computeStatus.status === 'ready';
  // A missing or stale worker capability report must not be treated as proof
  // that the approved enrichment package profile is installed.
  const enrichmentAvailable = computeStatus?.capabilities?.pathwayEnrichment === true;
  // The API also limits analysts to cancelling only their own jobs. Until the
  // job projection carries an explicit capability, expose cancellation only to
  // roles that can cancel every project job rather than offering a dead action.
  const canCancelJob = activeProject?.role === 'owner' || activeProject?.role === 'admin';
  const targetGroupIsValid = isSafeTargetGroup(params.targetGroup);
  const targetGroupIsAvailable = params.groupBy !== 'seurat_clusters'
    || targetGroups.includes(String(params.targetGroup || '').trim());
  const safeParams = useMemo(() => buildEnrichmentParams(params), [params]);
  const geneSetSizesAreValid = safeParams.minGeneSetSize < safeParams.maxGeneSetSize;
  const canLaunch = Boolean(
    userEmail
      && activeProjectId
      && isDbBackedObject
      && canWriteProject
      && sessionReady
      && liveObjectAttached
      && ownsPrivateLiveObject
      && !unsavedLiveChanges
      && enrichmentAvailable
      && targetGroupIsValid
      && targetGroupIsAvailable
      && safeParams.species
      && geneSetSizesAreValid
      && !loading
  );
  const terminal = job?.status ? TERMINAL_STATUSES.has(job.status) : false;
  const summaryArtifact = artifacts.find(artifact => artifact.artifactType === 'enrichment_summary') || null;
  const resultsArtifact = artifacts.find(artifact => artifact.artifactType === 'enrichment_results') || null;
  const summary = summaryArtifact?.metadata?.summary || null;
  const warnings = Array.isArray(summary?.warnings)
    ? summary.warnings
    : Array.isArray(summary?.mappingWarnings) ? summary.mappingWarnings : [];
  const visibleLogs = logs.length ? logs : (Array.isArray(job?.logs) ? job.logs : []);
  const resolvedParams = {
    ...safeParams,
    ...(job?.parameters && typeof job.parameters === 'object' ? job.parameters : {}),
    ...(summaryArtifact?.metadata?.resolvedParams
      && typeof summaryArtifact.metadata.resolvedParams === 'object'
      ? summaryArtifact.metadata.resolvedParams
      : {}),
  };
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
      setError('This analysis service is temporarily unavailable.');
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
    } catch (requestError) {
      if (selectionKeyRef.current === expectedSelectionKey) {
        setError(parseErrorMessage(requestError));
      }
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
          jobType: ENRICHMENT_JOB_TYPE,
          analysisObjectId: selectedObjectId,
        });
        const latest = Array.isArray(jobs) ? jobs[0] : null;
        if (!canceled && latest?.id) {
          await refreshJobState(latest.id, {
            silent: true,
            expectedSelectionKey: selectionKey,
          });
        }
      } catch (requestError) {
        if (!canceled) setError(parseErrorMessage(requestError));
      }
    };
    restoreLatestJob();
    return () => { canceled = true; };
  }, [activeProjectId, refreshJobState, selectedObjectId, selectionKey]);

  useEffect(() => {
    let canceled = false;
    setTargetGroups([]);
    setTargetGroupsLoading(false);
    if (!callApi || !sessionReady || !liveObjectAttached
        || !datasetInfo || params.groupBy !== 'seurat_clusters') {
      return () => { canceled = true; };
    }
    setTargetGroupsLoading(true);
    callApi('/meta-values?column=seurat_clusters')
      .then(response => {
        if (canceled || response?.error || !Array.isArray(response?.values)) return;
        const values = response.values
          .map(row => String(row?.value ?? '').trim())
          .filter(isSafeTargetGroup)
          .slice(0, 100);
        setTargetGroups([...new Set(values)]);
      })
      .catch(() => {
        if (!canceled) setTargetGroups([]);
      })
      .finally(() => { if (!canceled) setTargetGroupsLoading(false); });
    return () => { canceled = true; };
  }, [callApi, datasetInfo, liveObjectAttached, params.groupBy, rSessionId, sessionReady]);

  useEffect(() => {
    if (!job?.id || terminal) return undefined;
    const intervalId = window.setInterval(() => refreshJobState(job.id, { silent: true }), POLL_MS);
    return () => window.clearInterval(intervalId);
  }, [job?.id, terminal, refreshJobState]);

  const launchJob = useCallback(async () => {
    setError(null);
    if (!userEmail) return setError('Sign in before starting pathway enrichment.');
    if (!activeProjectId) return setError('Select a project before starting pathway enrichment.');
    if (!selectedObjectId || !isDbBackedObject) {
      return setError('Select a saved analysis before starting pathway enrichment.');
    }
    if (!canWriteProject) return setError('Your project role can view results but cannot start analysis jobs.');
    if (!ownsPrivateLiveObject) {
      return setError('This analysis belongs to another member. Create a branch from its saved version in your private analysis workspace before starting pathway enrichment.');
    }
    if (!sessionReady || !liveObjectAttached) {
      return setError('Open this saved analysis in your private analysis workspace before starting pathway enrichment.');
    }
    if (!enrichmentAvailable) {
      return setError('Pathway enrichment is unavailable in the current compute profile. Ask an operator to install the approved enrichment package profile.');
    }
    if (unsavedLiveChanges) {
      return setError('Save the current analysis before starting this durable run. Unsaved clustering or other live steps are not included.');
    }
    if (!safeParams.species) return setError('Choose whether the data are human or mouse.');
    if (!targetGroupIsValid) {
      return setError('Enter a valid cluster or identity label using letters, numbers, spaces, or . _ + ( ) -.');
    }
    if (!targetGroupIsAvailable) {
      return setError('Choose a cluster available in the saved checkpoint.');
    }
    if (!geneSetSizesAreValid) {
      return setError('The smallest gene set must be smaller than the largest gene set.');
    }

    const api = window.electronAPI || {};
    if (!api.createEnrichmentGseaJob && !api.createProjectJob) {
      return setError('Pathway enrichment is temporarily unavailable.');
    }

    const requestSelectionKey = selectionKeyRef.current;
    setLoading(true);
    setLogs([]);
    setArtifacts([]);
    try {
      const created = api.createEnrichmentGseaJob
        ? await api.createEnrichmentGseaJob(activeProjectId, selectedObjectId, safeParams)
        : await api.createProjectJob(activeProjectId, {
          jobType: ENRICHMENT_JOB_TYPE,
          analysisObjectId: selectedObjectId,
          parameters: safeParams,
        });
      if (selectionKeyRef.current !== requestSelectionKey) return undefined;
      setJob(created);
      setLastRefreshedAt(new Date().toISOString());
      await refreshJobState(created.id, {
        silent: true,
        expectedSelectionKey: requestSelectionKey,
      });
    } catch (requestError) {
      if (selectionKeyRef.current === requestSelectionKey) setError(parseErrorMessage(requestError));
    } finally {
      if (selectionKeyRef.current === requestSelectionKey) setLoading(false);
    }
    return undefined;
  }, [
    activeProjectId,
    canWriteProject,
    geneSetSizesAreValid,
    enrichmentAvailable,
    isDbBackedObject,
    liveObjectAttached,
    ownsPrivateLiveObject,
    refreshJobState,
    safeParams,
    selectedObjectId,
    sessionReady,
    targetGroupIsValid,
    targetGroupIsAvailable,
    unsavedLiveChanges,
    userEmail,
  ]);

  const cancelJob = useCallback(async () => {
    if (!activeProjectId || !job?.id || !canCancelJob) return;
    const api = window.electronAPI || {};
    if (!api.cancelProjectJob) {
      setError('Canceling this analysis is temporarily unavailable.');
      return;
    }
    const requestSelectionKey = selectionKeyRef.current;
    const requestProjectId = activeProjectId;
    const requestJobId = job.id;
    setCanceling(true);
    setError(null);
    try {
      await api.cancelProjectJob(requestProjectId, requestJobId);
      await refreshJobState(requestJobId, { silent: true, expectedSelectionKey: requestSelectionKey });
    } catch (requestError) {
      if (selectionKeyRef.current === requestSelectionKey) setError(parseErrorMessage(requestError));
    } finally {
      if (selectionKeyRef.current === requestSelectionKey) setCanceling(false);
    }
  }, [activeProjectId, canCancelJob, job?.id, refreshJobState]);

  if (!datasetInfo) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-8 text-center">
        <div className="max-w-sm">
          <FileText size={48} className="mx-auto mb-4 text-slate-400 opacity-50" />
          <h2 className="mb-2 text-xl font-bold text-text">No saved analysis selected</h2>
          <p className="text-sm text-textMuted">Select a saved, clustered analysis before running pathway enrichment.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-background p-4 sm:p-6 custom-scrollbar">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <PageHeader title="Pathway Enrichment" description={<>
          Ranks genes from one cluster versus all remaining cells, then tests which Gene Ontology biological processes are concentrated near the top or bottom of that ranked list.
        </>} actions={<>

            <button onClick={launchJob} disabled={!canLaunch} className="btn btn-primary inline-flex items-center gap-2 text-sm disabled:opacity-50">
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
              Start Pathway Enrichment
            </button>
            {job?.id && (
              <button onClick={() => refreshJobState(job.id)} disabled={refreshing} className="btn btn-secondary inline-flex items-center gap-2 text-sm">
                {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                Refresh
              </button>
            )}

        </>} />

        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-5 gap-y-3 rounded-lg border border-border bg-surface/50 px-4 py-3 text-sm">
          <div className="min-w-0"><dt className="text-xs text-textMuted">Project</dt><dd className="break-words font-medium text-text">{activeProject?.name || 'Selected project'}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-textMuted">Saved analysis</dt><dd className="break-words text-text">{selectedObjectId ? selectedAnalysisName : 'None selected'}</dd></div>
          <div className="min-w-0 col-span-2 sm:col-span-1"><dt className="text-xs text-textMuted">Gene sets</dt><dd className="text-text">GO Biological Process</dd></div>
        </dl>
        {isDbBackedObject && ownsPrivateLiveObject && !unsavedLiveChanges && <p className="text-sm text-textMuted">Runs use the saved checkpoint; live changes must be saved first.</p>}

        {isDbBackedObject && ownsPrivateLiveObject && unsavedLiveChanges && (
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
            <div className="flex items-center gap-2 font-bold"><AlertTriangle size={18} /> Pathway analysis unavailable</div>
            <p className="mt-1 text-sm">{publicErrorMessage(error, 'This analysis needs attention. Review the settings and try again.')}</p>
          </div>
        )}

        {!isDbBackedObject && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
            Select a saved analysis before starting pathway enrichment.
          </div>
        )}

        {isDbBackedObject && !canWriteProject && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
            Your project role is read-only. You can inspect saved pathway results, but only an owner, administrator, or analyst can start a new analysis.
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
            This saved analysis is not open in your private analysis workspace yet. {datasetInfo?.source === 'pbmc3k_demo' && datasetInfo?.metadata?.curatedDemo !== true ? 'Return to the workspace to reload the built-in PBMC demo.' : 'Open Runs & Results to open its saved version.'}
            <button onClick={() => setActiveTab?.(datasetInfo?.source === 'pbmc3k_demo' && datasetInfo?.metadata?.curatedDemo !== true ? 'workspace' : 'history')} className="btn btn-secondary ml-3 text-xs">
              {datasetInfo?.source === 'pbmc3k_demo' && datasetInfo?.metadata?.curatedDemo !== true ? 'Open workspace' : 'Open Runs & Results'}
            </button>
          </div>
        )}

        {isDbBackedObject && canWriteProject && sessionReady && liveObjectAttached && ownsPrivateLiveObject && !computeReady && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
            Compute is temporarily unavailable. You can submit this analysis now; it will wait in the durable queue until compute is available.
          </div>
        )}

        {isDbBackedObject && !enrichmentAvailable && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger" role="alert">
            <p className="font-bold">Pathway enrichment readiness has not been confirmed.</p>
            <p className="mt-1">{computeStatus?.capabilities?.pathwayEnrichment === false
              ? 'The approved enrichment packages are not installed in this compute profile. Ask an operator to update the worker.'
              : 'Wait for a healthy worker capability report or ask an operator to check the compute service.'} Runs remain disabled until the worker reports the dependencies ready.</p>
          </div>
        )}

        <section className="rounded-lg border border-border bg-surface/50 p-5">
          <h3 className="text-lg font-bold text-text">New run settings</h3>
          <p className="mt-1 text-sm text-textMuted">Choose the cluster to compare with all other cells. Species is required because human and mouse gene identifiers use different reference databases.</p>
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">Group labels</span>
              <select value={params.groupBy} onChange={event => setParam('groupBy', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text">
                <option value="seurat_clusters">Seurat clusters</option>
                <option value="ident">Current identities</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">Assay</span>
              <select value={params.assay} onChange={event => setParam('assay', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text">
                <option value="RNA">RNA</option>
                <option value="SCT">SCT</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">Target cluster or group</span>
              {params.groupBy === 'seurat_clusters' ? (
                <select value={params.targetGroup} onChange={event => setParam('targetGroup', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text" disabled={targetGroupsLoading || targetGroups.length === 0}>
                  <option value="">{targetGroupsLoading ? 'Loading clusters…' : targetGroups.length ? 'Choose cluster' : 'No clusters available'}</option>
                  {targetGroups.map(group => <option value={group} key={group}>{group}</option>)}
                </select>
              ) : (
                <input value={params.targetGroup} onChange={event => setParam('targetGroup', event.target.value)} maxLength={80} placeholder="For example: 0 or CD8 T cells" className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text" />
              )}
              {params.groupBy === 'seurat_clusters' && !targetGroupsLoading && targetGroups.length === 0 && (
                <span className="mt-1.5 block text-xs text-amber-900 dark:text-amber-200">No clusters are available in the open saved checkpoint. Save a clustered analysis or choose Current identities.</span>
              )}
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">Species (required)</span>
              <select value={params.species} onChange={event => setParam('species', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text">
                <option value="">Choose species</option>
                <option value="human">Human</option>
                <option value="mouse">Mouse</option>
              </select>
            </label>
          </div>
          <details className="mt-4 rounded-lg border border-border bg-background/30 p-4">
            <summary className="cursor-pointer text-sm font-bold text-text">Advanced options</summary>
            <p className="mt-2 text-xs text-textMuted">Gene-set bounds, significance cutoff, display count, sampling limit, and reproducibility seed.</p>
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">Smallest gene set</span>
              <input type="number" min="10" max="200" value={params.minGeneSetSize} onChange={event => setParam('minGeneSetSize', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">Largest gene set</span>
              <input type="number" min="50" max="2000" value={params.maxGeneSetSize} onChange={event => setParam('maxGeneSetSize', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">Adjusted p-value cutoff</span>
              <input type="number" min="0.000001" max="1" step="0.01" value={params.adjustedPValueCutoff} onChange={event => setParam('adjustedPValueCutoff', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">Pathways shown</span>
              <input type="number" min="5" max="25" value={params.topPathways} onChange={event => setParam('topPathways', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">Maximum cells per group</span>
              <input type="number" min="10" max="100000" value={params.maxCellsPerIdent} onChange={event => setParam('maxCellsPerIdent', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-textMuted">Random seed</span>
              <input type="number" min="0" max="2147483647" value={params.randomSeed} onChange={event => setParam('randomSeed', event.target.value)} className="w-full rounded border border-border bg-surface p-2.5 text-sm text-text" />
            </label>
            </div>
            <p className="mt-3 text-xs text-textMuted">The cell limit controls sampling. The random seed makes sampling repeatable.</p>
          </details>
          {!geneSetSizesAreValid && (
            <p role="alert" className="mt-3 text-sm text-danger">
              The smallest gene set must be smaller than the largest gene set.
            </p>
          )}
        </section>

        <section className="rounded-lg border border-border bg-surface/50 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-bold text-text"><Clock size={18} className="text-primary" /> Run status</h3>
              <p className="mt-1 text-sm text-textMuted">Compute is allocated when available. When demand is high, a new analysis waits for compute.</p>
            </div>
            <div className="flex items-center gap-2">
              {job?.status && <StatusBadge tone={badgeTone(job.status)}>{displayRunStatus(job.status)}</StatusBadge>}
              {job?.id && !terminal && canCancelJob && (
                <button
                  onClick={cancelJob}
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
            <EmptyNotice title="No pathway analysis run yet">Choose the settings above, select the correct species, then start pathway enrichment.</EmptyNotice>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
                <div><div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Outcome</div><div className="mt-1 text-text">{displayRunStatus(job.status)}</div></div>
                <div><div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Last refreshed</div><div className="mt-1 text-text">{formatDate(lastRefreshedAt)}</div></div>
              </div>
              {job.error?.message && <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{publicErrorMessage(job.error, 'This analysis needs attention. Review the settings and try again.')}</div>}
              <JobLogs logs={visibleLogs} />
            </div>
          )}
        </section>

        <section className="rounded-lg border border-border bg-surface/50 p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-bold text-text"><Archive size={18} className="text-primary" /> Pathway summary</h3>
              <p className="mt-1 text-sm text-textMuted">Review the leading pathways here. Export the full table from Runs &amp; Results.</p>
            </div>
            {summaryArtifact && <StatusBadge tone="green">summary available</StatusBadge>}
          </div>

          {summary ? (
            <div className="space-y-5">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                <Metric label="Genes mapped" value={`${summary.mappedGeneCount ?? 'NA'} / ${summary.inputGeneCount ?? 'NA'}`} detail={formatPercent(summary.mappingRate)} />
                <Metric label="Pathways tested" value={summary.testedPathwayCount ?? 'NA'} detail="GO Biological Process" />
                <Metric label="Significant pathways" value={summary.significantPathwayCount ?? 0} detail={`Adjusted p ≤ ${formatNumber(resolvedParams.adjustedPValueCutoff)}`} />
                <Metric label="Comparison" value={summary.comparison?.targetGroup ?? resolvedParams.targetGroup} detail={`versus ${summary.comparison?.reference || 'rest'}`} />
              </div>

              {warnings.length > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
                  <div className="mb-2 font-bold">Gene mapping notes</div>
                  <ul className="list-disc space-y-1 pl-5">
                    {warnings.map((warning, index) => <li key={index}>{redactUnsafeText(warning)}</li>)}
                  </ul>
                </div>
              )}

              <div>
                <h4 className="mb-3 text-sm font-bold text-text">Top ranked pathways</h4>
                <p className="mb-3 text-xs text-textMuted">
                  The enrichment score shows whether a pathway&apos;s genes gather toward the higher or lower end of the gene ranking. The adjusted p-value accounts for testing many pathways at once.
                </p>
                <PathwayTable pathways={summary.topPathways} />
              </div>

              <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm text-textMuted">
                A saved summary is available. The result table is available only through its authorized export.
                {summary.packageVersions?.r && summary.packageVersions?.seurat && (
                  <div className="mt-2 text-xs">
                    Saved with R {summary.packageVersions.r} and Seurat {summary.packageVersions.seurat}; the complete analysis-package versions are stored with this result.
                  </div>
                )}
              </div>
            </div>
          ) : job?.status === 'completed' ? (
            <EmptyNotice title="Pathway analysis completed without a summary">Review the run notes. If the private result table completed, its authorized export is available in Runs &amp; Results.</EmptyNotice>
          ) : (
            <EmptyNotice title="No pathway summary yet">A summary appears here after pathway enrichment completes successfully.</EmptyNotice>
          )}

          {resultsArtifact && (
            <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
              A private result table is available through the authorized, audited export in Runs &amp; Results.
            </div>
          )}
        </section>

        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm text-textMuted">
          <div className="mb-1 flex items-center gap-2 font-bold text-text"><ShieldCheck size={16} className="text-primary" /> How to interpret this result</div>
          Enrichment means genes connected to a pathway are unusually high or low in this cluster-versus-rest ranking. It does not prove that the pathway is active or caused the cell state. A cluster-versus-rest comparison is descriptive; conclusions about conditions or patients need a sample-aware study design.
        </div>
      </div>
    </div>
  );
}
