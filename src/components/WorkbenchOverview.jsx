import React from 'react';
import { Database, FolderTree, Lock } from 'lucide-react';

const PROJECT_WRITE_ROLES = new Set(['owner', 'admin', 'analyst']);

export default function WorkbenchOverview({
  activeProject,
  selectedObject,
  activeProjectObjects,
  pipelineState,
  setActiveTab,
  onReloadPbmcDemo,
}) {
  const hasProject = !!activeProject;
  const canWriteProject = PROJECT_WRITE_ROLES.has(activeProject?.role);
  const hasObject = !!selectedObject;
  const hasObjectsInProject = activeProjectObjects.length > 0;

  const liveAttached = selectedObject?.liveState === 'attached';
  const liveStatus = !hasObject
    ? 'Select an analysis'
    : liveAttached
      ? 'Ready in your workspace'
      : 'Open a saved version';

  let nextAction = 'Select or create a project.';
  let actionLabel = 'Create Project';
  let action = null;
  if (hasProject && !hasObject && hasObjectsInProject) {
    nextAction =
      'Select a saved analysis from the project list below before opening analysis tools.';
    actionLabel = 'Select analysis';
  } else if (hasProject && !hasObject) {
    if (canWriteProject) {
      nextAction =
        'Load the PBMC demo or use an approved workflow to add a dataset to this project.';
      // The Saved analyses empty state owns the single primary add action.
      actionLabel = 'Add analysis';
    } else {
      nextAction =
        'This project is read-only for your role. You can inspect saved analyses, results, and lineage when they are available.';
    }
  } else if (hasProject && hasObject && !liveAttached) {
    if (selectedObject?.source === 'pbmc3k_demo' && typeof onReloadPbmcDemo === 'function') {
      nextAction =
        'This PBMC demo is selected but is not open in your private analysis workspace. Reload the built-in demo to open it again.';
      actionLabel = 'Reload PBMC demo';
      action = onReloadPbmcDemo;
    } else {
      nextAction =
        'This saved analysis is not open in your private analysis workspace. Open Runs & Results to open a saved version or create a branch of your own.';
      actionLabel = 'Open Runs & Results';
      action = () => setActiveTab('history');
    }
  } else if (hasProject && hasObject && !pipelineState?.qc) {
    nextAction = 'Run quality control in your private analysis workspace.';
    actionLabel = 'Open Quality Control';
    action = () => setActiveTab('qc');
  } else if (hasProject && hasObject && !pipelineState?.normalize) {
    nextAction = 'Run normalization before PCA and clustering.';
    actionLabel = 'Open Normalize';
    action = () => setActiveTab('normalize');
  } else if (hasProject && hasObject && !pipelineState?.pca) {
    nextAction = 'Run PCA to unlock clustering and UMAP.';
    actionLabel = 'Open PCA';
    action = () => setActiveTab('pca');
  } else if (hasProject && hasObject) {
    nextAction = 'Continue through clustering, UMAP, markers, or review Runs & Results.';
    actionLabel = 'Open Runs & Results';
    action = () => setActiveTab('history');
  }

  if (!hasProject) return null;

  return (
    <section
      className="rounded-xl border border-border bg-surface/60 p-4"
      aria-label="Current analysis"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs text-textMuted">
            <FolderTree size={14} aria-hidden="true" /> {activeProject.name}
            <span className="capitalize">· {activeProject.role}</span>
          </p>
          <h3 className="mt-2 flex items-center gap-2 text-lg font-semibold text-text">
            <Database size={18} className="shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate">
              {selectedObject?.name || selectedObject?.displayName || 'No analysis selected'}
            </span>
          </h3>
          <p className="mt-1 text-sm text-textMuted">
            {hasObject
              ? liveStatus
              : `${activeProjectObjects.length} saved analyses in this project`}
          </p>
        </div>
        {action && (
          <button onClick={action} className="btn btn-primary text-sm">
            {actionLabel}
          </button>
        )}
      </div>
      <p className="mt-3 text-sm leading-relaxed text-text">
        {nextAction}
      </p>
      {hasObject && (
        <p className="mt-3 flex items-start gap-2 text-xs text-textMuted">
          <Lock size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          Your live workspace is private. Share saved versions through Runs &amp; Results.
        </p>
      )}
    </section>
  );
}
