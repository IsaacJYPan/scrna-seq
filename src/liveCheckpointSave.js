const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);

function workflowError(message, { durableSaved = false, code = 'SAVE_WORKFLOW_FAILED' } = {}) {
  const error = new Error(message);
  error.code = code;
  error.durableSaved = durableSaved;
  return error;
}

export async function waitForProjectJob(api, projectId, jobId, options = {}) {
  const pollMs = Number.isInteger(options.pollMs) && options.pollMs >= 0 ? options.pollMs : 1000;
  const maxPolls = Number.isInteger(options.maxPolls) && options.maxPolls > 0 ? options.maxPolls : 900;
  const wait = typeof options.wait === 'function'
    ? options.wait
    : (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  if (!api?.getProjectJob || !projectId || !jobId) {
    throw workflowError('Saved-analysis status could not be checked.', { code: 'INVALID_JOB_CONTEXT' });
  }
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const job = await api.getProjectJob(projectId, jobId);
    if (job && TERMINAL_STATUSES.has(job.status)) return job;
    if (poll + 1 < maxPolls) await wait(pollMs);
  }
  throw workflowError(
    'The save is still finishing. Keep this window open and check Runs & Results before continuing.',
    { code: 'JOB_POLL_TIMEOUT' }
  );
}

export async function saveAndOpenCurrentAnalysis(api, projectId, analysisObjectId, options = {}) {
  if (!api?.createCheckpointSaveJob || !api?.createCheckpointLoadJob) {
    throw workflowError('Saved-analysis persistence is unavailable.', { code: 'SAVE_UNAVAILABLE' });
  }
  const onPhase = typeof options.onPhase === 'function' ? options.onPhase : () => {};
  const waitForJob = typeof options.waitForJob === 'function'
    ? options.waitForJob
    : (jobId) => waitForProjectJob(api, projectId, jobId, options);

  onPhase('saving');
  const saveJob = await api.createCheckpointSaveJob(projectId, analysisObjectId);
  const saved = await waitForJob(saveJob?.id);
  if (saved?.status !== 'completed' || !saved.resultAnalysisObjectId) {
    throw workflowError('The current analysis was not saved. Review Runs & Results and try again.');
  }

  const resultAnalysisObjectId = saved.resultAnalysisObjectId;
  onPhase('opening', { resultAnalysisObjectId });
  let loadJob;
  try {
    loadJob = await api.createCheckpointLoadJob(projectId, resultAnalysisObjectId);
    const opened = await waitForJob(loadJob?.id);
    if (opened?.status !== 'completed') {
      throw workflowError(
        'The saved version was created, but it could not be opened in the live workspace.',
        { durableSaved: true, code: 'SAVED_VERSION_OPEN_FAILED' }
      );
    }
  } catch (error) {
    if (error?.durableSaved) throw error;
    throw workflowError(
      'The saved version was created, but it could not be opened in the live workspace.',
      { durableSaved: true, code: error?.code || 'SAVED_VERSION_OPEN_FAILED' }
    );
  }

  onPhase('completed', { resultAnalysisObjectId });
  return { resultAnalysisObjectId, saveJobId: saveJob.id, loadJobId: loadJob.id };
}
