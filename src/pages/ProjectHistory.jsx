import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Archive, Briefcase, GitBranch, Loader2 } from 'lucide-react';
import ArtifactInspector from '../components/ArtifactInspector';
import ExecutionHistory from '../components/ExecutionHistory';
import RunMonitor from '../components/RunMonitor';
import SubmissionRecovery from '../components/SubmissionRecovery';
import PageHeader from '../components/PageHeader';
import RefreshButton from '../components/RefreshButton';

import {
  formatApiError, isProjectAccessError, loadableCheckpointCandidates, emptyHistoryState, displayStatus,
} from './projectHistory/historyDisplay';
import { Section, EmptyState, JobList, ArtifactList, ProvenanceList, LineageSummary, FigureList } from './projectHistory/HistoryLists';

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
  deploymentPolicy,
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
  const retryRequestRef = useRef(0);
  activeProjectRef.current = activeProjectId;

  const [state, setState] = useState(() => emptyHistoryState());
  const historyState = state.projectId === activeProjectId && state.selectedObjectId === selectedObjectId
    ? state
    : emptyHistoryState(activeProjectId, selectedObjectId, Boolean(activeProjectId));
  const [forkState, setForkState] = useState(null);
  const [attachState, setAttachState] = useState(null);
  const [retryState, setRetryState] = useState(null);
  const [executionHistoryOpen, setExecutionHistoryOpen] = useState(false);
  const [executionHistoryMounted, setExecutionHistoryMounted] = useState(false);
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
    retryRequestRef.current += 1;
    setForkState(null);
    setAttachState(null);
    setRetryState(null);
    return () => {
      forkRequestRef.current += 1;
      attachRequestRef.current += 1;
      retryRequestRef.current += 1;
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
        error: formatApiError(error, 'Failed to restore saved version.'),
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

  const launchJobRetry = async job => {
    const api = window.electronAPI || {};
    const projectId = activeProjectId;
    if (!projectId || !job?.id || !api.retryProjectJob || retryState?.launching) return;
    const requestId = ++retryRequestRef.current;
    setRetryState({ projectId, sourceJobId: job.id, requestId, launching: true, error: null });
    try {
      const retriedJob = await api.retryProjectJob(projectId, job.id);
      if (activeProjectRef.current !== projectId || retryRequestRef.current !== requestId) return;
      setRetryState({
        projectId, sourceJobId: job.id, requestId, launching: false, job: retriedJob, error: null,
      });
      await loadHistory();
    } catch (error) {
      if (activeProjectRef.current !== projectId || retryRequestRef.current !== requestId) return;
      const accessLost = isProjectAccessError(error);
      setRetryState({
        projectId,
        sourceJobId: job.id,
        requestId,
        launching: false,
        error: formatApiError(error, 'Retry could not be started. Refresh the project and review this run.'),
      });
      if (accessLost && typeof refreshProjects === 'function') await refreshProjects();
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
      <div className="page-scroll custom-scrollbar">
        <div className="page-column">
          <EmptyState title="Select a project">
            Runs and results are listed per project.
          </EmptyState>
        </div>
      </div>
    );
  }

  return (
    <div className="page-scroll custom-scrollbar">
      <div className="page-column space-y-8">
        <PageHeader title="Runs & Results" icon={Briefcase} titleAction={<RefreshButton onClick={loadHistory} disabled={historyState.loading} loading={historyState.loading} />} />

        <p className="text-sm text-textMuted">
          Selected dataset: <span className="font-medium text-text">{selectedObject?.displayName || selectedObject?.name || 'none'}</span>
        </p>

        <SubmissionRecovery projectId={activeProjectId} userId={userId} />

        {selectedObject && selectedObject.liveState !== 'attached' && (
          <section className="rounded-lg border border-primary/20 bg-primary/5 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="flex items-center gap-2 text-lg font-bold text-text">
                  Restore a saved version
                </h3>
                <p className="mt-1 max-w-3xl text-sm text-textMuted">
                  Restoring replaces the owner&apos;s private live state with this saved version; the saved version and lineage remain unchanged. Other writers can create a new private branch instead. Viewers can review recorded history only.
                </p>
              </div>
              {selectedCheckpoint && selectedObjectIsOwnedByUser && (
                <button
                  onClick={launchCheckpointAttach}
                  disabled={attachBusy || activeAttachState?.job?.status === 'completed'}
                  className="btn btn-primary inline-flex items-center gap-2 text-sm disabled:opacity-50"
                >
                  {activeAttachState?.launching ? <Loader2 size={16} className="animate-spin" /> : <Archive size={16} />}
                  {activeAttachState?.job?.status === 'completed' ? 'Saved version restored' : 'Restore saved version'}
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
              <p role="status" className="mt-3 inline-flex items-center gap-2 text-sm text-textMuted"><Loader2 size={15} className="animate-spin" /> Restoring saved version: {displayStatus(activeAttachState.job.status)}.</p>
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

        {historyState.loading && <RunMonitor key={`monitor:${activeProjectId}:${userId}`} projectId={activeProjectId} userId={userId} />}

        {historyState.loading ? (
          <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-border bg-surface">
            <Loader2 size={34} className="mb-3 animate-spin text-primary" />
            <p className="text-sm text-textMuted">Loading analysis history...</p>
          </div>
        ) : (
          <>
            {(selectedJobs.length + selectedArtifacts.length + historyState.provenance.length + (historyState.lineage?.edges?.length || 0)) > 0 && <div role="group" aria-label="Selected analysis counts" className="flex flex-wrap gap-x-5 gap-y-1 border-b border-border pb-3 text-xs text-textMuted">
              <span><strong className="text-text">{selectedJobs.length}</strong> selected run{selectedJobs.length === 1 ? '' : 's'}</span>
              <span><strong className="text-text">{selectedArtifacts.length}</strong> selected result{selectedArtifacts.length === 1 ? '' : 's'}</span>
              <span><strong className="text-text">{historyState.provenance.length}</strong> project records</span>
              <span><strong className="text-text">{historyState.lineage?.edges?.length || 0}</strong> lineage links</span>
            </div>}

            <Section title="Runs for this dataset">
              <JobList
                jobs={selectedJobs}
                analysisObjects={currentWs?.objects || []}
                userId={userId}
                onRetry={launchJobRetry}
                retryState={retryState?.projectId === activeProjectId ? retryState : null}
              />
            </Section>

            <Section title="Saved results for this dataset">
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

            {!historyState.loading && <RunMonitor key={`monitor:${activeProjectId}:${userId}`} projectId={activeProjectId} userId={userId} />}

            <div className="space-y-2">
              <button
                type="button"
                aria-expanded={executionHistoryOpen}
                aria-controls="execution-history-panel"
                onClick={() => {
                  setExecutionHistoryMounted(true);
                  setExecutionHistoryOpen(open => !open);
                }}
                className="block min-h-10 w-full text-left"
              >
                <span className="disclosure-title text-base font-semibold text-text">Execution history<span className="sr-only"> {executionHistoryOpen ? 'Hide details' : 'Show details'}</span></span>
              </button>
              <div id="execution-history-panel" hidden={!executionHistoryOpen} className="mt-3">
                {executionHistoryMounted && (
                  <ExecutionHistory key={`${activeProjectId}:${userId}`} projectId={activeProjectId} userId={userId} />
                )}
              </div>
            </div>

            <details className="space-y-2">
              <summary className="cursor-pointer text-base font-semibold text-text">Inspect or import artifact files</summary>
              <p className="mt-2 mb-4 text-sm text-textMuted">Imports stay private. Inspect exact saved versions or add a file without changing earlier contents.</p>
              <ArtifactInspector key={activeProjectId} projectId={activeProjectId} canWrite={canFork && deploymentPolicy?.demoMode !== true} userId={userId} />
            </details>

            {(otherJobs.length > 0 || otherArtifacts.length > 0) && (
              <details className="space-y-2">
                <summary className="cursor-pointer text-base font-semibold text-text">
                  Other project activity ({otherJobs.length} runs, {otherArtifacts.length} results)
                </summary>
                <p className="mb-3 mt-2 text-sm text-textMuted">
                  These records belong to other datasets in this project. Select the relevant analysis before taking a recovery action.
                </p>
                <JobList
                  jobs={otherJobs}
                  analysisObjects={currentWs?.objects || []}
                  userId={userId}
                  emptyTitle="No other project runs"
                  emptyCopy="Only their saved results are recorded."
                />
              </details>
            )}

            <Section title="Branches and derived datasets" subtitle="A branch is a new dataset in your workspace; the original is unchanged.">
              <LineageSummary lineage={historyState.lineage} selectedObjectId={selectedObjectId} />
            </Section>

            <details className="space-y-2">
              <summary className="cursor-pointer text-base font-semibold text-text">Project records</summary>
              <div className="mt-4 space-y-6">
                <Section title="Provenance">
                  <ProvenanceList provenance={historyState.provenance} />
                </Section>
                <Section title="Figures">
                  <FigureList figures={historyState.figures} />
                </Section>
              </div>
            </details>

          </>
        )}
      </div>
    </div>
  );
}
