import { publicErrorMessage } from '../../publicError';
import { SUBMISSION_RECOVERY_MESSAGES } from '../../executions/submissionRecoveryMessages';

const SAFE_RESEARCHER_ERROR_MESSAGES = new Set([
  'Project not found.',
  // These say what to do next (check a saved receipt, sign in again, ...).
  ...Object.values(SUBMISSION_RECOVERY_MESSAGES),
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

export function formatApiError(error, fallback) {
  return safeApiErrorMessage(error) || fallback;
}

export function formatJobError(job) {
  const fallback = 'This analysis needs attention. Review the settings and try again.';
  const jobFallbacks = {
    'checkpoint.save.v1': 'The current live analysis could not be saved. Keep the workspace open and try Save current analysis again.',
    'expert.r.v1': 'The R script stopped with an error. Check input names, columns, and function arguments.',
    'explore.summarize.v1': 'Exploratory analysis could not read the requested data. Open the saved version and verify the selected metadata before trying again.',
    'spatial.seurat.v1': 'Spatial preprocessing could not use this Visium bundle. Review dataset validation and the required Space Ranger files before trying again.',
    'condition.pseudobulk_de.v1': 'Condition comparison could not use the registered design. Review sample bindings, replication, and the selected contrast before trying again.',
  };
  if (job?.jobType === 'expert.r.v1' || job?.jobType === 'cellchat.infer.v1' || job?.jobType === 'condition.pseudobulk_de.v1') {
    return publicErrorMessage(job.error, jobFallbacks[job.jobType] || fallback);
  }
  return formatApiError(job?.error, jobFallbacks[job?.jobType] || fallback);
}

export function isProjectAccessError(error) {
  return error?.status === 403 || error?.status === 404;
}

export function loadableCheckpointCandidates(artifacts, objectId) {
  if (!objectId) return [];
  return (Array.isArray(artifacts) ? artifacts : []).filter((artifact) => (
    artifact?.artifactType === 'checkpoint'
      && artifact?.storageKind === 'local_internal'
      && artifact?.status === 'available'
      && artifact?.resultAnalysisObjectId === objectId
  ));
}

export function emptyHistoryState(projectId = null, selectedObjectId = null, loading = false, error = null) {
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

export function badgeClass(tone = 'slate') {
  const tones = {
    blue: 'bg-primary/10 text-text border-primary/20',
    green: 'bg-success/10 text-success border-success/30',
    amber: 'bg-amber-500/10 text-amber-900 dark:text-amber-200 border-amber-500/30',
    rose: 'bg-danger/10 text-danger border-danger/30',
    slate: 'bg-slate-800 text-slate-300 border-slate-700',
  };
  return tones[tone] || tones.slate;
}

const JOB_LABELS = {
  'pbmc.pipeline.v1': 'PBMC preprocessing',
  'checkpoint.save.v1': 'Save current analysis',
  'seurat.pipeline.v1': 'Standard preprocessing',
  'spatial.seurat.v1': 'Spatial preprocessing',
  'checkpoint.load.v1': 'Restore saved version',
  'checkpoint.fork.v1': 'Create branch from saved version',
  'deg.find_markers.v1': 'Cluster marker analysis',
  'enrichment.gsea.v1': 'Pathway enrichment',
  'cellchat.infer.v1': 'CellChat candidate analysis',
  'explore.summarize.v1': 'Exploratory analysis',
  'condition.pseudobulk_de.v1': 'Condition comparison',
  'expert.r.v1': 'R console',
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
  'checkpoint.load.v1': 'Restore saved version',
  'checkpoint.fork.v1': 'Create branch from saved version',
  'deg.find_markers.v1': 'Cluster marker analysis',
  'enrichment.gsea.v1': 'Pathway enrichment',
  'cellchat.infer.v1': 'CellChat candidate analysis',
  'explore.summarize.v1': 'Exploratory analysis',
  'condition.pseudobulk_de.v1': 'Condition comparison',
  'expert.r.v1': 'R console',
};

export function displayJobLabel(jobType) {
  return JOB_LABELS[jobType] || 'Analysis run';
}

export function displayArtifactLabel(artifactType) {
  return ARTIFACT_LABELS[artifactType] || 'Saved result';
}

export function displayProvenanceLabel(operation) {
  return PROVENANCE_LABELS[operation] || 'Recorded analysis step';
}

export function displayStatus(status) {
  const labels = {
    queued: 'Waiting for compute',
    running: 'Running',
    completed: 'Complete',
    available: 'Available',
    unavailable: 'Unavailable',
    failed: 'Needs attention',
    canceled: 'Canceled',
  };
  return labels[status] || 'Unknown';
}
