import React from 'react';
import { Database, FolderTree } from 'lucide-react';

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
    if (selectedObject?.metadata?.curatedDemo === true) {
      nextAction =
        'Open Runs & Results to restore this saved analysis.';
      actionLabel = 'Open Runs & Results';
      action = () => setActiveTab('history');
    } else if (selectedObject?.source === 'pbmc3k_demo' && typeof onReloadPbmcDemo === 'function') {
      nextAction =
        'Reload the PBMC dataset to continue your analysis.';
      actionLabel = 'Reload PBMC demo';
      action = onReloadPbmcDemo;
    } else {
      nextAction =
        'Open a saved version from Runs & Results to continue your analysis.';
      actionLabel = 'Open Runs & Results';
      action = () => setActiveTab('history');
    }
  } else if (hasProject && hasObject && !pipelineState?.qc) {
    nextAction = 'Review cell quality and choose filtering thresholds.';
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
    nextAction = 'Explore clusters and gene expression, or review saved results.';
    actionLabel = 'Open Runs & Results';
    action = () => setActiveTab('history');
  }

  if (!hasProject) return null;

  return (
    <section
      className="border-b border-border pb-5"
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
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-textMuted">{nextAction}</p>
        </div>
        {action && (
          <button onClick={action} className="btn btn-primary text-sm">
            {actionLabel}
          </button>
        )}
      </div>
    </section>
  );
}
