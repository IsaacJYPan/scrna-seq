// Notifies listeners when a tracked project job reaches a terminal state.
//
// Pages poll their own jobs (pipeline runs, restores, saves, pseudobulk, ...),
// and a finished job can add or change saved versions. The API layer reports
// every job it reads here, so the app can refresh the project's object list
// once per job when it settles instead of only on page reload.

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);
const MAX_TRACKED_JOBS = 500;

const lastStatusByJob = new Map();
const listeners = new Set();

export function isTerminalJobStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

// Record the status of a job read from the backend. A job first seen already
// terminal (a restored, finished run) is not a transition and emits nothing.
export function noteProjectJobStatus(projectId, job) {
  if (!projectId || !job?.id || !job.status) return;
  const previous = lastStatusByJob.get(job.id);
  lastStatusByJob.delete(job.id);
  lastStatusByJob.set(job.id, job.status);
  if (lastStatusByJob.size > MAX_TRACKED_JOBS) {
    lastStatusByJob.delete(lastStatusByJob.keys().next().value);
  }
  if (previous === undefined || isTerminalJobStatus(previous) || !isTerminalJobStatus(job.status)) return;
  for (const listener of [...listeners]) {
    try {
      listener({ projectId, job });
    } catch (error) {
      console.error('[projectJobEvents] listener failed:', error);
    }
  }
}

export function onProjectJobSettled(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetProjectJobEventsForTests() {
  lastStatusByJob.clear();
  listeners.clear();
}
