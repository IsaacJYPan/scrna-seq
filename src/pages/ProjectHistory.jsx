import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Archive, Briefcase, Clock, FileText,
  GitBranch, ImageIcon, Loader2, RefreshCw, ShieldCheck,
} from 'lucide-react';

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatId(value) {
  return value ? String(value) : 'None';
}

function formatApiError(error, fallback) {
  if (!error) return fallback;
  try {
    const parsed = JSON.parse(error.message);
    return parsed.error || fallback;
  } catch {
    return error.message || fallback;
  }
}

function isProjectAccessError(error) {
  return error?.status === 403 || error?.status === 404;
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

function JobList({ jobs }) {
  if (!jobs.length) {
    return (
      <EmptyState title="No durable jobs yet">
        Durable jobs are implemented in the backend, but no project jobs are recorded for this project yet.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-2">
      {jobs.map(job => (
        <div key={job.id} className="rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-mono text-sm font-bold text-text">{job.id}</p>
                <StatusBadge tone={job.status === 'completed' ? 'green' : job.status === 'failed' ? 'rose' : 'amber'}>
                  {job.status || 'unknown'}
                </StatusBadge>
              </div>
              <p className="mt-1 text-sm text-textMuted">{job.jobType || 'Unknown job type'}</p>
            </div>
            <p className="text-xs text-textMuted">{formatDate(job.createdAt)}</p>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-2 text-xs text-textMuted md:grid-cols-3">
            <span>Input object: <span className="font-mono text-slate-300">{formatId(job.analysisObjectId)}</span></span>
            <span>Result object: <span className="font-mono text-slate-300">{formatId(job.resultAnalysisObjectId)}</span></span>
            <span>Dataset: <span className="font-mono text-slate-300">{formatId(job.datasetId)}</span></span>
          </div>
          {job.error?.message && (
            <div className="mt-3 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {job.error.code ? `${job.error.code}: ` : ''}{job.error.message}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ArtifactList({ artifacts, canFork, forkBusy, forkState, onFork, onOpenFork }) {
  if (!artifacts.length) {
    return (
      <EmptyState title="No artifact metadata yet">
        The backend artifact foundation exists, but this project has no checkpoint, summary, or marker artifacts to show.
      </EmptyState>
    );
  }

  const loadableCheckpointsByObject = new Map();
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
      <table className="min-w-[900px] w-full text-left text-xs">
        <thead className="bg-slate-800 text-[10px] font-bold uppercase tracking-wider text-textMuted">
          <tr>
            <th className="p-3">Artifact</th>
            <th className="p-3">Type</th>
            <th className="p-3">Status</th>
            <th className="p-3">Storage</th>
            <th className="p-3">Job</th>
            <th className="p-3">Collaboration</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40 bg-surface/70">
          {artifacts.map(artifact => {
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
            return (
            <tr key={artifact.id}>
              <td className="p-3">
                <div className="font-mono font-bold text-text">{artifact.id}</div>
                {artifact.name && <div className="mt-1 text-textMuted">{artifact.name}</div>}
              </td>
              <td className="p-3 text-textMuted">{artifact.artifactType || 'unknown'}</td>
              <td className="p-3"><StatusBadge tone={artifact.status === 'available' ? 'green' : 'amber'}>{artifact.status || 'unknown'}</StatusBadge></td>
              <td className="p-3 text-textMuted">{artifact.storageKind || 'metadata_only'}</td>
              <td className="p-3 font-mono text-textMuted">{formatId(artifact.jobId)}</td>
              <td className="p-3">
                {isAmbiguousCheckpoint ? (
                  <span className="text-textMuted">Multiple loadable checkpoints; server selection is ambiguous</span>
                ) : isCheckpoint && !isLoadableCheckpoint ? (
                  <span className="text-textMuted">Checkpoint is not loadable</span>
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
                    Open fork
                  </button>
                ) : activeFork?.job && ['queued', 'running'].includes(activeFork.job.status) ? (
                  <span role="status" className="inline-flex items-center gap-2 text-textMuted"><Loader2 size={13} className="animate-spin" /> {activeFork.job.status}</span>
                ) : (
                  <button onClick={() => onFork(artifact)} disabled={activeFork?.launching} className="btn btn-secondary text-xs">
                    {activeFork?.launching ? 'Creating…' : 'Fork checkpoint'}
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
      <EmptyState title="No project provenance records yet">
        Legacy live-R provenance may exist in the session graph, but no project-scoped provenance records are available here.
      </EmptyState>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {provenance.map(record => (
        <div key={record.id} className="rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-mono text-xs font-bold text-text">{record.id}</p>
            <StatusBadge tone="blue">{record.operation || 'operation'}</StatusBadge>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-1 text-xs text-textMuted">
            <span>Object: <span className="font-mono text-slate-300">{formatId(record.analysisObjectId)}</span></span>
            <span>Job: <span className="font-mono text-slate-300">{formatId(record.jobId)}</span></span>
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
      <EmptyState title="No selected object">
        Select a DB-backed analysis object to read its durable project lineage graph.
      </EmptyState>
    );
  }
  if (!lineage) {
    return (
      <EmptyState title="No lineage graph available">
        This object has no recorded durable lineage edges yet.
      </EmptyState>
    );
  }

  const nodes = Array.isArray(lineage.nodes) ? lineage.nodes : [];
  const edges = Array.isArray(lineage.edges) ? lineage.edges : [];

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h4 className="text-sm font-bold text-text">Objects</h4>
          <StatusBadge tone={lineage.truncated ? 'amber' : 'green'}>{lineage.truncated ? 'truncated' : 'bounded'}</StatusBadge>
        </div>
        {nodes.length === 0 ? (
          <p className="text-sm text-textMuted">No lineage nodes returned.</p>
        ) : (
          <div className="space-y-2">
            {nodes.map(node => (
              <div key={node.id} className="rounded border border-border/60 bg-black/10 p-3">
                <div className="font-mono text-xs font-bold text-text">{node.id}</div>
                <div className="mt-1 text-xs text-textMuted">{node.label || node.objectType || 'Analysis object'}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="rounded-lg border border-border bg-surface p-4">
        <h4 className="mb-3 text-sm font-bold text-text">Edges</h4>
        {edges.length === 0 ? (
          <p className="text-sm text-textMuted">No durable lineage edges recorded for this object.</p>
        ) : (
          <div className="space-y-2">
            {edges.map(edge => (
              <div key={edge.id} className="rounded border border-border/60 bg-black/10 p-3 text-xs">
                <div className="font-mono font-bold text-text">{edge.parentAnalysisObjectId}{' -> '}{edge.childAnalysisObjectId}</div>
                <div className="mt-1 text-textMuted">{edge.edgeType || 'edge'} / {edge.parentRole || 'primary'}</div>
                {edge.jobId && <div className="mt-1 text-textMuted">Job: <span className="font-mono">{edge.jobId}</span></div>}
                {edge.metadata?.checkpointArtifactId && (
                  <div className="mt-1 text-textMuted">Source checkpoint: <span className="font-mono">{edge.metadata.checkpointArtifactId}</span></div>
                )}
                {edge.createdByUserId && <div className="mt-1 text-textMuted">Created by member: {edge.createdByUserId}</div>}
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
            <p className="font-mono text-xs font-bold text-text">{figure.id}</p>
            <StatusBadge tone="blue">{figure.plotType || 'figure'}</StatusBadge>
          </div>
          <p className="mt-2 text-sm text-text">{figure.title || 'Untitled figure'}</p>
          <p className="mt-2 text-xs text-textMuted">Created: {formatDate(figure.createdAt)}</p>
        </div>
      ))}
    </div>
  );
}

export default function ProjectHistory({
  currentWs,
  datasetInfo,
  refreshAnalysisObjects,
  refreshProjects,
  onSelectAnalysisObject,
  setActiveTab,
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
  activeProjectRef.current = activeProjectId;

  const [state, setState] = useState(() => emptyHistoryState());
  const historyState = state.projectId === activeProjectId && state.selectedObjectId === selectedObjectId
    ? state
    : emptyHistoryState(activeProjectId, selectedObjectId, Boolean(activeProjectId));
  const [forkState, setForkState] = useState(null);
  const activeForkState = forkState?.projectId === activeProjectId ? forkState : null;
  const forkBusy = Boolean(
    activeForkState?.launching || ['queued', 'running'].includes(activeForkState?.job?.status)
  );

  useEffect(() => {
    forkRequestRef.current += 1;
    setForkState(null);
    return () => {
      forkRequestRef.current += 1;
    };
  }, [activeProjectId]);

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
        error: formatApiError(error, 'Failed to load project history.'),
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
  }, [loadHistory]);

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
        ? (job?.error?.message || `Checkpoint fork ${job.status}.`)
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
        ? { ...previous, error: formatApiError(error, 'Failed to refresh checkpoint fork.'), accessLost }
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
        error: formatApiError(error, 'Failed to create checkpoint fork.'),
      });
      if (typeof refreshProjects === 'function') await refreshProjects();
    }
  };

  const openFork = async objectId => {
    if (!objectId) return;
    await onSelectAnalysisObject?.(activeProjectId, objectId);
    setActiveTab?.('workspace');
  };

  if (!activeProjectId) {
    return (
      <div className="h-full w-full overflow-y-auto bg-background p-8 custom-scrollbar">
        <div className="mx-auto max-w-5xl">
          <EmptyState title="Select a backend project">
            Jobs, artifacts, project provenance, figures, and durable lineage are scoped to a backend project.
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
              Jobs & Artifacts
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-textMuted">
              Durable project history and controlled checkpoint forks. A fork creates a new private working object while preserving its source object, checkpoint, job, and lineage edge.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusBadge tone="green">durable metadata</StatusBadge>
              <StatusBadge tone="amber">no public download</StatusBadge>
              <StatusBadge tone="blue">private live forks</StatusBadge>
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
              <div className="mt-1 font-bold text-text">{activeProject?.name || activeProjectId}</div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Selected object</div>
              <div className="mt-1 font-mono text-text">{selectedObjectId || 'None'}</div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Access model</div>
              <div className="mt-1 text-text">Project metadata visibility only</div>
            </div>
          </div>
        </div>

        {historyState.error && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-danger">
            <div className="flex items-center gap-2 font-bold"><AlertTriangle size={18} /> History unavailable</div>
            <p className="mt-1 text-sm">{historyState.error}</p>
          </div>
        )}

        {historyState.loading ? (
          <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-border bg-surface">
            <Loader2 size={34} className="mb-3 animate-spin text-primary" />
            <p className="text-sm text-textMuted">Loading project history metadata...</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <SummaryCard label="Jobs" value={historyState.jobs.length} detail="Durable job records" />
              <SummaryCard label="Artifacts" value={historyState.artifacts.length} detail="Metadata only" />
              <SummaryCard label="Provenance" value={historyState.provenance.length} detail="Project-scoped records" />
              <SummaryCard label="Lineage edges" value={historyState.lineage?.edges?.length || 0} detail="Analysis-object graph" />
            </div>

            <Section title="Durable Jobs" icon={<Clock size={18} className="text-primary" />} subtitle="Backend job records are visible here. General job creation remains outside this UI section.">
              <JobList jobs={historyState.jobs} />
            </Section>

            <Section title="Artifacts And Checkpoints" icon={<Archive size={18} className="text-primary" />} subtitle="Only sanitized metadata is shown. Storage paths and keys are not rendered.">
              <ArtifactList
                artifacts={historyState.artifacts}
                canFork={canFork}
                forkBusy={forkBusy}
                forkState={activeForkState}
                onFork={launchCheckpointFork}
                onOpenFork={openFork}
              />
            </Section>

            <div className="rounded-lg border border-primary/20 bg-primary/5 p-5 text-sm text-textMuted">
              <div className="mb-2 flex items-center gap-2 font-bold text-text">
                <GitBranch size={17} className="text-primary" />
                How checkpoint forks support parallel, reproducible work
              </div>
              <p>
                The source object and checkpoint remain unchanged. The worker restores that durable checkpoint into a newly allocated analysis object owned by the collaborator and attached only to that collaborator&apos;s private live R key. The child object records its source object and checkpoint artifact, while the lineage edge records the fork job. Both branches can then evolve independently without losing where either object came from.
              </p>
            </div>

            <Section title="Lineage" icon={<GitBranch size={18} className="text-primary" />} subtitle="Durable project analysis-object lineage, separate from the legacy live-R session DAG.">
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
              Project history visibility does not grant live R object access. Live analysis still uses the caller's private transient R state.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
