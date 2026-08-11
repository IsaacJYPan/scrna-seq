import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Archive, Briefcase, Clock, FileText,
  GitBranch, ImageIcon, Loader2, RefreshCw, ShieldCheck,
} from 'lucide-react';
import { publicErrorMessage } from '../publicError';

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

const SAFE_RESEARCHER_ERROR_MESSAGES = new Set([
  'Project not found.',
]);

function safeApiErrorMessage(error) {
  const rawMessage = typeof error === 'string' ? error : error?.message;
  if (typeof rawMessage !== 'string') return '';
  let message = rawMessage.trim();
  try {
    const parsed = JSON.parse(message);
    message = typeof parsed?.error === 'string' ? parsed.error.trim() : '';
  } catch {
    // Only explicitly approved, whole messages may be displayed below.
  }
  return SAFE_RESEARCHER_ERROR_MESSAGES.has(message) ? message : '';
}

function formatApiError(error, fallback) {
  return safeApiErrorMessage(error) || fallback;
}

function formatJobError(job) {
  const fallback = 'This analysis needs attention. Review the settings and try again.';
  const jobFallbacks = {
    'checkpoint.save.v1': 'The current live analysis could not be saved. Keep the workspace open and try Save current analysis again.',
    'expert.r.v1': 'The R script stopped with an error. Check input names, columns, and function arguments.',
    'explore.summarize.v1': 'Exploratory analysis could not read the requested data. Open the saved version and verify the selected metadata before trying again.',
    'spatial.seurat.v1': 'Spatial preprocessing could not use this Visium bundle. Review dataset validation and the required Space Ranger files before trying again.',
    'condition.pseudobulk_de.v1': 'Condition comparison could not use the registered design. Review sample bindings, replication, and the selected contrast before trying again.',
  };
  if (job?.jobType === 'expert.r.v1') return publicErrorMessage(job.error, jobFallbacks[job.jobType]);
  return formatApiError(job?.error, jobFallbacks[job?.jobType] || fallback);
}

function isProjectAccessError(error) {
  return error?.status === 403 || error?.status === 404;
}

function loadableCheckpointCandidates(artifacts, objectId) {
  if (!objectId) return [];
  return (Array.isArray(artifacts) ? artifacts : []).filter((artifact) => (
    artifact?.artifactType === 'checkpoint'
      && artifact?.storageKind === 'local_internal'
      && artifact?.status === 'available'
      && artifact?.resultAnalysisObjectId === objectId
  ));
}

function emptyHistoryState(projectId = null, selectedObjectId = null, loading = false, error = null) {
  return {
    projectId,
    selectedObjectId,
    loading,
    error,
    jobs: [],
    artifacts: [],
    provenance: [],
    figures: [],
    lineage: null,
  };
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

const JOB_LABELS = {
  'pbmc.pipeline.v1': 'PBMC preprocessing',
  'checkpoint.save.v1': 'Save current analysis',
  'seurat.pipeline.v1': 'Standard preprocessing',
  'spatial.seurat.v1': 'Spatial preprocessing',
  'checkpoint.load.v1': 'Open saved version',
  'checkpoint.fork.v1': 'Create branch from saved version',
  'deg.find_markers.v1': 'Cluster marker analysis',
  'enrichment.gsea.v1': 'Pathway enrichment',
  'cellchat.infer.v1': 'CellChat candidate analysis',
  'explore.summarize.v1': 'Exploratory analysis',
  'condition.pseudobulk_de.v1': 'Condition comparison',
  'expert.r.v1': 'Advanced analysis',
};

const ARTIFACT_LABELS = {
  checkpoint: 'Saved version',
  checkpoint_save: 'Saved-version summary',
  deg_markers: 'Marker results',
  deg_summary: 'Marker summary',
  enrichment_results: 'Pathway enrichment results',
  enrichment_summary: 'Pathway enrichment summary',
  cellchat_results: 'CellChat candidate results',
  cellchat_summary: 'CellChat candidate summary',
  condition_de_results: 'Condition comparison results',
  condition_de_summary: 'Condition comparison summary',
  expert_r_bundle: 'R analysis output',
  pipeline_summary: 'Analysis summary',
  object_summary: 'Analysis summary',
  explore_summary: 'Exploratory analysis summary',
};

const PROVENANCE_LABELS = {
  normalize: 'Normalization',
  'pbmc.pipeline.v1': 'PBMC preprocessing',
  'checkpoint.save.v1': 'Save current analysis',
  'seurat.pipeline.v1': 'Standard preprocessing',
  'spatial.seurat.v1': 'Spatial preprocessing',
  'checkpoint.load.v1': 'Open saved version',
  'checkpoint.fork.v1': 'Create branch from saved version',
  'deg.find_markers.v1': 'Cluster marker analysis',
  'enrichment.gsea.v1': 'Pathway enrichment',
  'cellchat.infer.v1': 'CellChat candidate analysis',
  'explore.summarize.v1': 'Exploratory analysis',
  'condition.pseudobulk_de.v1': 'Condition comparison',
  'expert.r.v1': 'Advanced analysis',
};

function displayJobLabel(jobType) {
  return JOB_LABELS[jobType] || 'Analysis run';
}

function displayArtifactLabel(artifactType) {
  return ARTIFACT_LABELS[artifactType] || 'Saved result';
}

function displayProvenanceLabel(operation) {
  return PROVENANCE_LABELS[operation] || 'Recorded analysis step';
}

function displayStatus(status) {
  const labels = {
    queued: 'Waiting for compute',
    running: 'Running',
    completed: 'Complete',
    available: 'Available',
    failed: 'Needs attention',
    canceled: 'Canceled',
  };
  return labels[status] || 'Unknown';
}

function Section({ title, icon, subtitle, children }) {
  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-bold text-text">
            {icon}
            {title}
          </h3>
          {subtitle && <p className="mt-1 text-sm text-textMuted">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function EmptyState({ title, children }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center">
      <p className="font-bold text-text">{title}</p>
      <p className="mt-2 text-sm text-textMuted">{children}</p>
    </div>
  );
}

function SummaryCard({ label, value, detail }) {
  return (
    <div className="card p-4 bg-surface/70">
      <div className="text-2xl font-black text-text">{value}</div>
      <div className="mt-1 text-[10px] font-bold uppercase tracking-widest text-text">{label}</div>
      {detail && <div className="mt-2 text-xs text-textMuted">{detail}</div>}
    </div>
  );
}

function JobList({ jobs, analysisObjects = [], userId, emptyTitle = 'No analysis runs yet', emptyCopy = 'No recorded analysis runs are associated with this analysis.' }) {
  if (!jobs.length) {
    return (
      <EmptyState title={emptyTitle}>
        {emptyCopy}
      </EmptyState>
    );
  }

  const analysisNamesById = new Map(analysisObjects.map((analysis) => [
    analysis.id, analysis.displayName || analysis.name || 'Saved analysis',
  ]));

  return (
    <div className="space-y-2">
      {jobs.map(job => {
        const sourceName = analysisNamesById.get(job.analysisObjectId);
        const resultName = analysisNamesById.get(job.resultAnalysisObjectId);
        const owner = Number(job.ownerUserId) === Number(userId) ? 'You' : 'Project collaborator';
        return (
        <div key={job.id} className="rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-bold text-text">{displayJobLabel(job.jobType)}</p>
                <StatusBadge tone={job.status === 'completed' ? 'green' : job.status === 'failed' ? 'rose' : 'amber'}>
                  {displayStatus(job.status)}
                </StatusBadge>
              </div>
              <div className="mt-2 grid gap-1 text-xs text-textMuted sm:grid-cols-2">
                <span>Owner: <span className="text-text">{owner}</span></span>
                <span>Input: <span className="text-text">{sourceName || 'No saved-analysis input'}</span></span>
                {resultName && <span>Saved result: <span className="text-text">{resultName}</span></span>}
              </div>
            </div>
            <p className="text-xs text-textMuted">{formatDate(job.createdAt)}</p>
          </div>
          {(job.status === 'failed' || job.error) && (
            <div className="mt-3 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {formatJobError(job)}
              <div className="mt-1 text-textMuted">Recovery: review the input and settings, then start a new run from the named input analysis.</div>
            </div>
          )}
        </div>
      );})}
    </div>
  );
}

const DOWNLOADABLE_ARTIFACT_TYPES = new Set([
  'deg_markers', 'enrichment_results', 'cellchat_results',
  'condition_de_results', 'expert_r_bundle',
]);

function ArtifactList({ artifacts, jobs = [], analysisObjects = [], canFork, forkBusy, forkState, onFork, onOpenFork, onDownload }) {
  const [downloadState, setDownloadState] = useState(null);
  if (!artifacts.length) {
    return (
      <EmptyState title="No saved results yet">
        This project has no saved versions, summaries, or result tables to show yet.
      </EmptyState>
    );
  }

  const loadableCheckpointsByObject = new Map();
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const analysisNamesById = new Map(analysisObjects.map((analysis) => [analysis.id, analysis.displayName || analysis.name]));
  for (const artifact of artifacts) {
    if (artifact.artifactType === 'checkpoint'
        && artifact.storageKind === 'local_internal'
        && artifact.status === 'available'
        && artifact.resultAnalysisObjectId) {
      const candidates = loadableCheckpointsByObject.get(artifact.resultAnalysisObjectId) || [];
      candidates.push(artifact);
      loadableCheckpointsByObject.set(artifact.resultAnalysisObjectId, candidates);
    }
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="min-w-[560px] w-full text-left text-xs">
        <thead className="bg-slate-800 text-[10px] font-bold uppercase tracking-wider text-textMuted">
          <tr>
            <th className="p-3">Saved result</th>
            <th className="p-3">Status</th>
            <th className="p-3">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40 bg-surface/70">
          {artifacts.map(artifact => {
            const sourceJob = jobsById.get(artifact.jobId);
            const sourceAnalysisId = artifact.analysisObjectId || sourceJob?.analysisObjectId;
            const sourceAnalysisName = analysisNamesById.get(sourceAnalysisId);
            const recordedAt = artifact.createdAt || sourceJob?.createdAt;
            const isCheckpoint = artifact.artifactType === 'checkpoint';
            const isLoadableCheckpoint = isCheckpoint
              && artifact.storageKind === 'local_internal'
              && artifact.status === 'available'
              && Boolean(artifact.resultAnalysisObjectId);
            const checkpointCandidates = isLoadableCheckpoint
              ? (loadableCheckpointsByObject.get(artifact.resultAnalysisObjectId) || [])
              : [];
            const isAmbiguousCheckpoint = checkpointCandidates.length > 1;
            const isForkableCheckpoint = isLoadableCheckpoint && checkpointCandidates.length === 1;
            const activeFork = forkState?.artifactId === artifact.id ? forkState : null;
            const canDownload = artifact.status === 'available'
              && artifact.storageKind === 'local_internal'
              && DOWNLOADABLE_ARTIFACT_TYPES.has(artifact.artifactType);
            return (
            <tr key={artifact.id}>
              <td className="p-3">
                <div className="font-bold text-text">{displayArtifactLabel(artifact.artifactType)}</div>
                {sourceAnalysisName && <div className="mt-1 text-xs text-textMuted">From {sourceAnalysisName}</div>}
                {recordedAt && <div className="mt-1 text-xs text-textMuted">Recorded: {formatDate(recordedAt)}</div>}
              </td>
              <td className="p-3"><StatusBadge tone={artifact.status === 'available' ? 'green' : 'amber'}>{displayStatus(artifact.status)}</StatusBadge></td>
              <td className="p-3">
                {canDownload ? (
                  <div>
                    <button
                      onClick={async () => {
                        setDownloadState({ artifactId: artifact.id, loading: true, error: '' });
                        try {
                          await onDownload(artifact);
                          setDownloadState(null);
                        } catch (error) {
                          setDownloadState({
                            artifactId: artifact.id,
                            loading: false,
                            error: formatApiError(error, 'Download failed.'),
                          });
                        }
                      }}
                      disabled={downloadState?.artifactId === artifact.id && downloadState.loading}
                      className="btn btn-secondary text-xs"
                    >
                      {downloadState?.artifactId === artifact.id && downloadState.loading
                        ? 'Preparing…' : 'Download result'}
                    </button>
                    {downloadState?.artifactId === artifact.id && downloadState.error && (
                      <div className="mt-2 max-w-xs text-danger">{downloadState.error}</div>
                    )}
                  </div>
                ) : isAmbiguousCheckpoint ? (
                  <span className="text-textMuted">Multiple saved versions are available, so this version cannot be selected automatically.</span>
                ) : isCheckpoint && !isLoadableCheckpoint ? (
                  <span className="text-textMuted">This saved version is unavailable.</span>
                ) : !isForkableCheckpoint ? (
                  <span className="text-textMuted">—</span>
                ) : !canFork ? (
                  <span className="text-textMuted">Writer role required</span>
                ) : forkBusy && !activeFork ? (
                  <span className="text-textMuted">Another fork is in progress</span>
                ) : activeFork?.accessLost ? (
                  <span className="text-danger">Project access changed; refresh required</span>
                ) : activeFork?.job?.status === 'completed' && activeFork.job.resultAnalysisObjectId ? (
                  <button onClick={() => onOpenFork(activeFork.job.resultAnalysisObjectId)} className="btn btn-primary text-xs">
                    Open branch
                  </button>
                ) : activeFork?.job && ['queued', 'running'].includes(activeFork.job.status) ? (
                  <span role="status" className="inline-flex items-center gap-2 text-textMuted"><Loader2 size={13} className="animate-spin" /> {displayStatus(activeFork.job.status)}</span>
                ) : !activeFork?.launching ? (
                  <button onClick={() => onFork(artifact)} className="btn btn-secondary text-xs">
                    Create branch from this version
                  </button>
                ) : (
                  <button onClick={() => onFork(artifact)} disabled={activeFork?.launching} className="btn btn-secondary text-xs">
                    Creating branch…
                  </button>
                )}
                {activeFork?.error && <div className="mt-2 max-w-xs text-danger">{activeFork.error}</div>}
              </td>
            </tr>
          );})}
        </tbody>
      </table>
    </div>
  );
}

function ProvenanceList({ provenance }) {
  if (!provenance.length) {
    return (
      <EmptyState title="No recorded analysis steps yet">
        No recorded analysis steps are available for this project yet.
      </EmptyState>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {provenance.map(record => (
        <div key={record.id} className="rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold text-text">Recorded analysis step</p>
            <StatusBadge tone="blue">{displayProvenanceLabel(record.operation)}</StatusBadge>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-1 text-xs text-textMuted">
            <span>Created: {formatDate(record.createdAt || record.timestamp)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function LineageSummary({ lineage, selectedObjectId }) {
  if (!selectedObjectId) {
    return (
      <EmptyState title="No analysis selected">
        Select a saved analysis to view its recorded lineage.
      </EmptyState>
    );
  }
  if (!lineage) {
    return (
      <EmptyState title="No lineage graph available">
        This analysis has no recorded relationships yet.
      </EmptyState>
    );
  }

  const nodes = Array.isArray(lineage.nodes) ? lineage.nodes : [];
  const edges = Array.isArray(lineage.edges) ? lineage.edges : [];

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h4 className="text-sm font-bold text-text">Saved analyses</h4>
          <StatusBadge tone={lineage.truncated ? 'amber' : 'green'}>{lineage.truncated ? 'truncated' : 'bounded'}</StatusBadge>
        </div>
        {nodes.length === 0 ? (
          <p className="text-sm text-textMuted">No lineage nodes returned.</p>
        ) : (
          <div className="space-y-2">
            {nodes.map(node => (
              <div key={node.id} className="rounded border border-border/60 bg-black/10 p-3">
                <div className="text-sm font-bold text-text">{node.label || 'Saved analysis'}</div>
                <div className="mt-1 text-xs text-textMuted">Saved analysis</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="rounded-lg border border-border bg-surface p-4">
        <h4 className="mb-3 text-sm font-bold text-text">Edges</h4>
        {edges.length === 0 ? (
          <p className="text-sm text-textMuted">No recorded relationships for this analysis.</p>
        ) : (
          <div className="space-y-2">
            {edges.map(edge => (
              <div key={edge.id} className="rounded border border-border/60 bg-black/10 p-3 text-xs">
                <div className="font-bold text-text">Source analysis → derived analysis</div>
                <div className="mt-1 text-textMuted">Recorded lineage relationship</div>
                {edge.createdAt && <div className="mt-1 text-textMuted">Recorded: {formatDate(edge.createdAt)}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FigureList({ figures }) {
  if (!figures.length) {
    return (
      <EmptyState title="No project figure metadata yet">
        Project-scoped figure metadata is readable here when present. Figure bytes and downloads are not exposed.
      </EmptyState>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {figures.map(figure => (
        <div key={figure.id} className="rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold text-text">{figure.title || 'Saved figure'}</p>
            <StatusBadge tone="blue">{figure.plotType || 'Figure'}</StatusBadge>
          </div>
          <p className="mt-2 text-xs text-textMuted">Created: {formatDate(figure.createdAt)}</p>
        </div>
      ))}
    </div>
  );
}

export default function ProjectHistory({
  currentWs,
  datasetInfo,
  userId,
  refreshAnalysisObjects,
  refreshProjects,
  onSelectAnalysisObject,
  onLiveObjectAttached,
  setActiveTab,
  historyRefreshToken,
}) {
  const activeProjectId = currentWs?.selectedProjectId || datasetInfo?.projectId || currentWs?.projects?.[0]?.id || null;
  const activeProject = currentWs?.projects?.find(project => project.id === activeProjectId) || null;
  const selectedIds = currentWs?.selectedObjectIds || [];
  const selectedObject = (currentWs?.objects || []).find(object => (
    object.projectId === activeProjectId && selectedIds.includes(object.id)
  )) || (
    datasetInfo?.projectId === activeProjectId && selectedIds.includes(datasetInfo.id)
      ? datasetInfo
      : null
  );
  const selectedObjectId = selectedObject?.id || null;
  const canFork = ['owner', 'admin', 'analyst'].includes(activeProject?.role);
  const activeProjectRef = useRef(activeProjectId);
  const historyRequestRef = useRef(0);
  const forkRequestRef = useRef(0);
  const attachRequestRef = useRef(0);
  activeProjectRef.current = activeProjectId;

  const [state, setState] = useState(() => emptyHistoryState());
  const historyState = state.projectId === activeProjectId && state.selectedObjectId === selectedObjectId
    ? state
    : emptyHistoryState(activeProjectId, selectedObjectId, Boolean(activeProjectId));
  const [forkState, setForkState] = useState(null);
  const [attachState, setAttachState] = useState(null);
  const activeForkState = forkState?.projectId === activeProjectId ? forkState : null;
  const activeAttachState = attachState?.projectId === activeProjectId
    && attachState?.objectId === selectedObjectId
    ? attachState
    : null;
  const forkBusy = Boolean(
    activeForkState?.launching || ['queued', 'running'].includes(activeForkState?.job?.status)
  );
  const attachBusy = Boolean(
    activeAttachState?.launching || ['queued', 'running'].includes(activeAttachState?.job?.status)
  );
  const checkpointCandidates = loadableCheckpointCandidates(historyState.artifacts, selectedObjectId);
  const selectedCheckpoint = checkpointCandidates.length === 1 ? checkpointCandidates[0] : null;
  const selectedObjectIsOwnedByUser = Number.isInteger(Number(userId))
    && Number(selectedObject?.ownerUserId) === Number(userId);
  const selectedJobs = selectedObjectId
    ? historyState.jobs.filter((job) => (
      job.analysisObjectId === selectedObjectId || job.resultAnalysisObjectId === selectedObjectId
    ))
    : [];
  const selectedJobIds = new Set(selectedJobs.map((job) => job.id));
  const selectedArtifacts = selectedObjectId
    ? historyState.artifacts.filter((artifact) => (
      artifact.analysisObjectId === selectedObjectId
      || artifact.resultAnalysisObjectId === selectedObjectId
      || selectedJobIds.has(artifact.jobId)
    ))
    : [];
  const otherJobs = historyState.jobs.filter((job) => !selectedJobIds.has(job.id));
  const selectedArtifactIds = new Set(selectedArtifacts.map((artifact) => artifact.id));
  const otherArtifacts = historyState.artifacts.filter((artifact) => !selectedArtifactIds.has(artifact.id));

  useEffect(() => {
    forkRequestRef.current += 1;
    attachRequestRef.current += 1;
    setForkState(null);
    setAttachState(null);
    return () => {
      forkRequestRef.current += 1;
      attachRequestRef.current += 1;
    };
  }, [activeProjectId, selectedObjectId]);

  const loadHistory = useCallback(async () => {
    const requestId = ++historyRequestRef.current;
    const projectId = activeProjectId;
    const objectId = selectedObjectId;
    if (!activeProjectId) {
      setState(emptyHistoryState());
      return;
    }

    const api = window.electronAPI || {};
    setState(emptyHistoryState(projectId, objectId, true));
    try {
      const [jobs, artifacts, provenance, figures, lineage] = await Promise.all([
        api.listProjectJobs ? api.listProjectJobs(projectId) : [],
        api.listProjectArtifacts ? api.listProjectArtifacts(projectId) : [],
        api.listProjectProvenance ? api.listProjectProvenance(projectId) : [],
        api.listProjectFigures ? api.listProjectFigures(projectId) : [],
        objectId && api.getProjectAnalysisObjectLineage
          ? api.getProjectAnalysisObjectLineage(projectId, objectId)
          : null,
      ]);

      if (activeProjectRef.current !== projectId || historyRequestRef.current !== requestId) return;
      setState({
        projectId,
        selectedObjectId: objectId,
        loading: false,
        error: null,
        jobs: Array.isArray(jobs) ? jobs : [],
        artifacts: Array.isArray(artifacts) ? artifacts : [],
        provenance: Array.isArray(provenance) ? provenance : [],
        figures: Array.isArray(figures) ? figures : [],
        lineage: lineage && typeof lineage === 'object' && !lineage.error ? lineage : null,
      });
    } catch (error) {
      if (activeProjectRef.current !== projectId || historyRequestRef.current !== requestId) return;
      setState({
        projectId,
        selectedObjectId: objectId,
        loading: false,
        error: formatApiError(error, 'Failed to load Runs & Results.'),
        jobs: [],
        artifacts: [],
        provenance: [],
        figures: [],
        lineage: null,
      });
      if (isProjectAccessError(error) && typeof refreshProjects === 'function') {
        await refreshProjects();
      }
    }
  }, [activeProjectId, refreshProjects, selectedObjectId]);

  useEffect(() => {
    loadHistory();
    return () => {
      historyRequestRef.current += 1;
    };
  }, [historyRefreshToken, loadHistory]);

  const refreshForkJob = useCallback(async () => {
    if (!activeProjectId || !activeForkState?.job?.id) return;
    const projectId = activeProjectId;
    const requestId = activeForkState.requestId;
    const jobId = activeForkState.job.id;
    const api = window.electronAPI || {};
    if (!api.getProjectJob) return;
    try {
      const job = await api.getProjectJob(projectId, jobId);
      if (activeProjectRef.current !== projectId || forkRequestRef.current !== requestId) return;
      const jobError = ['failed', 'canceled'].includes(job?.status)
        ? formatApiError(job?.error, `Creating a branch from the saved version ${displayStatus(job.status).toLowerCase()}.`)
        : null;
      const accessLost = job?.error?.code === 'PROJECT_ACCESS_REVOKED';
      setForkState(previous => previous?.requestId === requestId
        ? { ...previous, job, error: jobError, accessLost }
        : previous);
      if (accessLost && typeof refreshProjects === 'function') {
        await refreshProjects();
      }
      if (job?.status === 'completed') {
        if (typeof refreshAnalysisObjects === 'function') await refreshAnalysisObjects(projectId);
        if (activeProjectRef.current !== projectId || forkRequestRef.current !== requestId) return;
        await loadHistory();
      }
    } catch (error) {
      if (activeProjectRef.current !== projectId || forkRequestRef.current !== requestId) return;
      const accessLost = isProjectAccessError(error);
      setForkState(previous => previous?.requestId === requestId
        ? { ...previous, error: formatApiError(error, 'Failed to refresh saved-version branch.'), accessLost }
        : previous);
      if (accessLost && typeof refreshProjects === 'function') {
        await refreshProjects();
      }
    }
  }, [activeForkState?.job?.id, activeForkState?.requestId, activeProjectId, loadHistory, refreshAnalysisObjects, refreshProjects]);

  useEffect(() => {
    if (!activeForkState?.job?.id || activeForkState.accessLost
        || !['queued', 'running'].includes(activeForkState.job.status)) return undefined;
    let canceled = false;
    let timer = null;
    const poll = async () => {
      await refreshForkJob();
      if (!canceled) timer = window.setTimeout(poll, 2500);
    };
    timer = window.setTimeout(poll, 2500);
    return () => {
      canceled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [activeForkState?.accessLost, activeForkState?.job?.id, activeForkState?.job?.status, refreshForkJob]);

  const refreshAttachJob = useCallback(async () => {
    if (!activeProjectId || !selectedObjectId || !activeAttachState?.job?.id) return;
    const projectId = activeProjectId;
    const objectId = selectedObjectId;
    const requestId = activeAttachState.requestId;
    const jobId = activeAttachState.job.id;
    const api = window.electronAPI || {};
    if (!api.getProjectJob) return;
    try {
      const job = await api.getProjectJob(projectId, jobId);
      if (activeProjectRef.current !== projectId || attachRequestRef.current !== requestId) return;
      const jobError = ['failed', 'canceled'].includes(job?.status)
        ? formatApiError(job?.error, `Opening the saved version ${displayStatus(job.status).toLowerCase()}.`)
        : null;
      setAttachState(previous => previous?.requestId === requestId
        ? { ...previous, job, error: jobError }
        : previous);
      if (job?.status === 'completed') {
        if (typeof refreshAnalysisObjects === 'function') await refreshAnalysisObjects(projectId);
        if (activeProjectRef.current !== projectId || attachRequestRef.current !== requestId) return;
        onLiveObjectAttached?.(projectId, objectId);
        await loadHistory();
      }
    } catch (error) {
      if (activeProjectRef.current !== projectId || attachRequestRef.current !== requestId) return;
      setAttachState(previous => previous?.requestId === requestId
        ? { ...previous, error: formatApiError(error, 'Failed to refresh saved version.') }
        : previous);
    }
  }, [activeAttachState?.job?.id, activeAttachState?.requestId, activeProjectId, loadHistory, onLiveObjectAttached, refreshAnalysisObjects, selectedObjectId]);

  useEffect(() => {
    if (!activeAttachState?.job?.id || !['queued', 'running'].includes(activeAttachState.job.status)) {
      return undefined;
    }
    let canceled = false;
    let timer = null;
    const poll = async () => {
      await refreshAttachJob();
      if (!canceled) timer = window.setTimeout(poll, 2500);
    };
    timer = window.setTimeout(poll, 2500);
    return () => {
      canceled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [activeAttachState?.job?.id, activeAttachState?.job?.status, refreshAttachJob]);

  const launchCheckpointAttach = async () => {
    const api = window.electronAPI || {};
    const projectId = activeProjectId;
    const objectId = selectedObjectId;
    if (!projectId || !objectId || !selectedCheckpoint || !selectedObjectIsOwnedByUser
        || !api.createCheckpointLoadJob || attachBusy) return;
    const requestId = ++attachRequestRef.current;
    setAttachState({ projectId, objectId, requestId, launching: true, job: null, error: null });
    try {
      const job = await api.createCheckpointLoadJob(projectId, objectId);
      if (activeProjectRef.current !== projectId || attachRequestRef.current !== requestId) return;
      setAttachState({ projectId, objectId, requestId, launching: false, job, error: null });
    } catch (error) {
      if (activeProjectRef.current !== projectId || attachRequestRef.current !== requestId) return;
      setAttachState({
        projectId,
        objectId,
        requestId,
        launching: false,
        job: null,
        error: formatApiError(error, 'Failed to open saved version.'),
      });
    }
  };

  const launchCheckpointFork = async artifact => {
    const api = window.electronAPI || {};
    const sourceObjectId = artifact?.resultAnalysisObjectId;
    const projectId = activeProjectId;
    if (!projectId || !sourceObjectId || !api.createCheckpointForkJob || forkBusy) return;
    const requestId = ++forkRequestRef.current;
    setForkState({ projectId, requestId, artifactId: artifact.id, sourceObjectId, launching: true, job: null, error: null });
    try {
      const job = await api.createCheckpointForkJob(projectId, sourceObjectId);
      if (activeProjectRef.current !== projectId || forkRequestRef.current !== requestId) return;
      setForkState({ projectId, requestId, artifactId: artifact.id, sourceObjectId, launching: false, job, error: null });
    } catch (error) {
      if (activeProjectRef.current !== projectId || forkRequestRef.current !== requestId) return;
      setForkState({
        projectId,
        requestId,
        artifactId: artifact.id,
        sourceObjectId,
        launching: false,
        job: null,
        error: formatApiError(error, 'Failed to create branch from saved version.'),
      });
      if (typeof refreshProjects === 'function') await refreshProjects();
    }
  };

  const openFork = async objectId => {
    if (!objectId) return;
    await onSelectAnalysisObject?.(activeProjectId, objectId);
    if (activeForkState?.job?.status === 'completed'
        && activeForkState.job.resultAnalysisObjectId === objectId) {
      onLiveObjectAttached?.(activeProjectId, objectId);
    }
    setActiveTab?.('workspace');
  };

  if (!activeProjectId) {
    return (
      <div className="h-full w-full overflow-y-auto bg-background p-8 custom-scrollbar">
        <div className="mx-auto max-w-5xl">
          <EmptyState title="Select a project">
            Analysis runs, saved results, provenance, figures, and lineage are scoped to a project.
          </EmptyState>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-background p-8 custom-scrollbar">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
          <div>
            <h2 className="flex items-center gap-3 text-2xl font-black tracking-tight text-text">
              <Briefcase size={24} className="text-primary" />
              Runs & Results
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-textMuted">
              Review recorded analysis runs, saved results, and branches. Creating a branch preserves its source version and lineage while giving each researcher a private analysis workspace.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusBadge tone="green">analysis history</StatusBadge>
              <StatusBadge tone="blue">reviewed exports</StatusBadge>
              <StatusBadge tone="blue">private workspaces</StatusBadge>
            </div>
          </div>
          <button
            onClick={loadHistory}
            disabled={historyState.loading}
            className="btn btn-secondary inline-flex items-center gap-2 text-sm"
          >
            {historyState.loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Refresh
          </button>
        </header>

        <div className="rounded-lg border border-border bg-surface/40 p-4">
          <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Project</div>
              <div className="mt-1 font-bold text-text">{activeProject?.name || 'Selected project'}</div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Selected analysis</div>
              <div className="mt-1 text-text">{selectedObject?.displayName || selectedObject?.name || 'None selected'}</div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Access model</div>
              <div className="mt-1 text-text">Project metadata visibility only</div>
            </div>
          </div>
        </div>

        {selectedObject && selectedObject.liveState !== 'attached' && (
          <section className="rounded-lg border border-primary/20 bg-primary/5 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="flex items-center gap-2 text-lg font-bold text-text">
                  <Archive size={18} className="text-primary" />
                  Open a saved version
                </h3>
                <p className="mt-1 max-w-3xl text-sm text-textMuted">
                  A saved version can be opened only in its owner&apos;s private analysis workspace. Other writers can create their own branch from it; viewers can review recorded history only.
                </p>
              </div>
              {selectedCheckpoint && selectedObjectIsOwnedByUser && (
                <button
                  onClick={launchCheckpointAttach}
                  disabled={attachBusy || activeAttachState?.job?.status === 'completed'}
                  className="btn btn-primary inline-flex items-center gap-2 text-sm disabled:opacity-50"
                >
                  {activeAttachState?.launching ? <Loader2 size={16} className="animate-spin" /> : <Archive size={16} />}
                  {activeAttachState?.job?.status === 'completed' ? 'Saved version opened' : 'Open saved version'}
                </button>
              )}
              {selectedCheckpoint && !selectedObjectIsOwnedByUser && canFork && (
                <button
                  onClick={() => launchCheckpointFork(selectedCheckpoint)}
                  disabled={forkBusy}
                  className="btn btn-primary inline-flex items-center gap-2 text-sm disabled:opacity-50"
                >
                  {activeForkState?.launching ? <Loader2 size={16} className="animate-spin" /> : <GitBranch size={16} />}
                  Create branch from this version
                </button>
              )}
            </div>
            {checkpointCandidates.length > 1 && (
              <p className="mt-3 text-sm text-danger">Multiple saved versions are available, so one cannot be selected automatically.</p>
            )}
            {checkpointCandidates.length === 0 && (
              <p className="mt-3 text-sm text-textMuted">No eligible saved version exists for this selected analysis.</p>
            )}
            {selectedCheckpoint && !selectedObjectIsOwnedByUser && !canFork && (
              <p className="mt-3 text-sm text-textMuted">Your Viewer role cannot create a branch from this version.</p>
            )}
            {activeAttachState?.job && ['queued', 'running'].includes(activeAttachState.job.status) && (
              <p role="status" className="mt-3 inline-flex items-center gap-2 text-sm text-textMuted"><Loader2 size={15} className="animate-spin" /> Opening saved version: {displayStatus(activeAttachState.job.status)}.</p>
            )}
            {activeAttachState?.error && <p role="alert" className="mt-3 text-sm text-danger">{activeAttachState.error}</p>}
            {activeForkState?.artifactId === selectedCheckpoint?.id && activeForkState?.error && (
              <p role="alert" className="mt-3 text-sm text-danger">{activeForkState.error}</p>
            )}
          </section>
        )}

        {historyState.error && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-danger">
            <div className="flex items-center gap-2 font-bold"><AlertTriangle size={18} /> History unavailable</div>
            <p className="mt-1 text-sm">{historyState.error}</p>
          </div>
        )}

        {historyState.loading ? (
          <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-border bg-surface">
            <Loader2 size={34} className="mb-3 animate-spin text-primary" />
            <p className="text-sm text-textMuted">Loading analysis history...</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <SummaryCard label="Selected runs" value={selectedJobs.length} detail="Runs tied to the selected analysis" />
              <SummaryCard label="Selected results" value={selectedArtifacts.length} detail="Saved results tied to the selection" />
              <SummaryCard label="Provenance" value={historyState.provenance.length} detail="Project records" />
              <SummaryCard label="Lineage" value={historyState.lineage?.edges?.length || 0} detail="Saved-analysis relationships" />
            </div>

            <Section title="Selected Analysis Runs" icon={<Clock size={18} className="text-primary" />} subtitle="Only runs whose input or saved result is the selected analysis are shown here.">
              <JobList jobs={selectedJobs} analysisObjects={currentWs?.objects || []} userId={userId} />
            </Section>

            <Section title="Selected Analysis Results" icon={<Archive size={18} className="text-primary" />} subtitle="Only saved results associated with the selected analysis are shown here. Reviewed result tables and Expert R bundles have authenticated, audited downloads; saved versions are never downloadable.">
              <ArtifactList
                artifacts={selectedArtifacts}
                jobs={historyState.jobs}
                analysisObjects={currentWs?.objects || []}
                canFork={canFork}
                forkBusy={forkBusy}
                forkState={activeForkState}
                onFork={launchCheckpointFork}
                onOpenFork={openFork}
                onDownload={(artifact) => window.electronAPI.downloadProjectArtifact(
                  activeProjectId, artifact.id
                )}
              />
            </Section>

            {(otherJobs.length > 0 || otherArtifacts.length > 0) && (
              <details className="rounded-lg border border-border bg-surface/50 p-4">
                <summary className="cursor-pointer font-bold text-text">
                  Other project activity ({otherJobs.length} runs, {otherArtifacts.length} results)
                </summary>
                <p className="mb-3 mt-2 text-sm text-textMuted">
                  These records belong to other saved analyses in this project. Select the relevant analysis before taking a recovery action.
                </p>
                <JobList
                  jobs={otherJobs}
                  analysisObjects={currentWs?.objects || []}
                  userId={userId}
                  emptyTitle="No other project runs"
                  emptyCopy="Only saved results from other analyses are recorded."
                />
              </details>
            )}

            <div className="rounded-lg border border-primary/20 bg-primary/5 p-5 text-sm text-textMuted">
              <div className="mb-2 flex items-center gap-2 font-bold text-text">
                <GitBranch size={17} className="text-primary" />
                How branches support parallel, reproducible work
              </div>
              <p>
                The source analysis and saved version remain unchanged. Creating a branch opens that version in a new analysis owned by the collaborator, within only that collaborator&apos;s private analysis workspace. Both branches can then evolve independently while preserving their shared lineage.
              </p>
            </div>

            <Section title="Lineage" icon={<GitBranch size={18} className="text-primary" />} subtitle="Recorded relationships between saved analyses.">
              <LineageSummary lineage={historyState.lineage} selectedObjectId={selectedObjectId} />
            </Section>

            <Section title="Project Provenance" icon={<FileText size={18} className="text-primary" />} subtitle="Project-scoped provenance records. Scripts and parameters are not expanded here.">
              <ProvenanceList provenance={historyState.provenance} />
            </Section>

            <Section title="Project Figures" icon={<ImageIcon size={18} className="text-primary" />} subtitle="Figure metadata only. File bytes and downloads are not exposed.">
              <FigureList figures={historyState.figures} />
            </Section>

            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm text-textMuted">
              <div className="mb-1 flex items-center gap-2 font-bold text-text">
                <ShieldCheck size={16} className="text-primary" />
                Boundary note
              </div>
              Runs &amp; Results visibility does not grant access to another researcher&apos;s private analysis workspace.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
