import { useCallback, useEffect, useRef, useState } from 'react';
import { parseErrorMessage } from '../components/analysisRunDisplay';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);
const ANALYSIS_JOB_POLL_MS = 3000;

// Lifecycle of the latest durable job of one type for the selected saved
// analysis: restore it when the selection changes, poll until it is terminal,
// submit new runs, and cancel. Every async write is dropped if the researcher
// has since switched project or analysis, so results never land on the wrong
// selection.
export default function useProjectAnalysisJob({ jobType, activeProjectId, selectedObjectId }) {
  const [job, setJob] = useState(null);
  const [logs, setLogs] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);

  const terminal = job?.status ? TERMINAL_STATUSES.has(job.status) : false;
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
    } catch (requestError) {
      if (selectionKeyRef.current === expectedSelectionKey) setError(parseErrorMessage(requestError));
      return null;
    } finally {
      if (!silent && selectionKeyRef.current === expectedSelectionKey) setRefreshing(false);
    }
  }, [activeProjectId]);

  // A new selection starts clean and restores its latest run of this type.
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
          jobType,
          analysisObjectId: selectedObjectId,
        });
        const latest = Array.isArray(jobs) ? jobs[0] : null;
        if (!canceled && latest?.id) {
          await refreshJobState(latest.id, { silent: true, expectedSelectionKey: selectionKey });
        }
      } catch (requestError) {
        if (!canceled) setError(parseErrorMessage(requestError));
      }
    };
    restoreLatestJob();
    return () => { canceled = true; };
  }, [activeProjectId, jobType, refreshJobState, selectedObjectId, selectionKey]);

  useEffect(() => {
    if (!job?.id || terminal) return undefined;
    let canceled = false;
    const poll = async () => {
      if (!canceled) await refreshJobState(job.id, { silent: true, expectedSelectionKey: selectionKey });
    };
    const intervalId = window.setInterval(poll, ANALYSIS_JOB_POLL_MS);
    return () => {
      canceled = true;
      window.clearInterval(intervalId);
    };
  }, [job?.id, selectionKey, terminal, refreshJobState]);

  // `createJob` performs any request-time checks and returns the created job.
  const submitJob = useCallback(async createJob => {
    const requestSelectionKey = selectionKeyRef.current;
    setLoading(true);
    setLogs([]);
    setArtifacts([]);
    try {
      const created = await createJob();
      if (selectionKeyRef.current !== requestSelectionKey) return;
      setJob(created);
      setLastRefreshedAt(new Date().toISOString());
      await refreshJobState(created.id, { silent: true, expectedSelectionKey: requestSelectionKey });
    } catch (requestError) {
      if (selectionKeyRef.current === requestSelectionKey) setError(parseErrorMessage(requestError));
    } finally {
      if (selectionKeyRef.current === requestSelectionKey) setLoading(false);
    }
  }, [refreshJobState]);

  const cancelJob = useCallback(async () => {
    if (!activeProjectId || !job?.id) return;
    const api = window.electronAPI || {};
    if (!api.cancelProjectJob) {
      setError('Canceling this analysis is temporarily unavailable.');
      return;
    }
    const requestSelectionKey = selectionKeyRef.current;
    const requestJobId = job.id;
    setCanceling(true);
    setError(null);
    try {
      await api.cancelProjectJob(activeProjectId, requestJobId);
      await refreshJobState(requestJobId, { silent: true, expectedSelectionKey: requestSelectionKey });
    } catch (requestError) {
      if (selectionKeyRef.current === requestSelectionKey) setError(parseErrorMessage(requestError));
    } finally {
      if (selectionKeyRef.current === requestSelectionKey) setCanceling(false);
    }
  }, [activeProjectId, job?.id, refreshJobState]);

  return {
    job,
    logs,
    artifacts,
    loading,
    refreshing,
    canceling,
    error,
    setError,
    lastRefreshedAt,
    terminal,
    selectionKey,
    refreshJobState,
    submitJob,
    cancelJob,
  };
}
