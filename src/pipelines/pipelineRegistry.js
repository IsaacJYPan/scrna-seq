import {
  DEFAULT_PIPELINE_ID,
  PIPELINE_MODULES,
  getDefaultPipelineManifest,
  validatePipelineManifest,
} from '../../shared/pipelineManifest.mjs';

export {
  DEFAULT_PIPELINE_ID,
  DEFAULT_SEURAT_PIPELINE,
  PARAMETER_TEMPLATE_TYPES,
  PIPELINE_CONTRACT,
  PIPELINE_MODULES,
  RESULT_VIEW_TEMPLATES,
  getDefaultPipelineManifest,
  validatePipelineManifest,
} from '../../shared/pipelineManifest.mjs';

export function resolvePipelineManifest(manifest) {
  const safeManifest = !manifest || manifest.id === DEFAULT_PIPELINE_ID
    ? getDefaultPipelineManifest()
    : validatePipelineManifest(manifest);
  return {
    ...safeManifest,
    builtin: safeManifest.id === DEFAULT_PIPELINE_ID,
    tabs: safeManifest.tabs.map(tab => {
      const moduleDef = PIPELINE_MODULES[tab.moduleKey];
      return {
        ...tab,
        routeId: moduleDef.routeId,
        componentKey: moduleDef.componentKey,
        jobType: moduleDef.jobType || null,
        executable: moduleDef.executable === true,
        executableNow: moduleDef.executable === true,
        requiresObject: moduleDef.requiresObject === true,
        requiresProject: moduleDef.requiresProject === true,
      };
    }),
  };
}

export function buildPipelineSidebarSections(manifest, pipelineState = {}) {
  let safeManifest;
  try {
    safeManifest = resolvePipelineManifest(manifest);
  } catch {
    safeManifest = resolvePipelineManifest(getDefaultPipelineManifest());
  }
  const exploreModuleKeys = new Set(['featurePlot', 'geneExpression', 'heatmap', 'dotPlot', 'exploratoryAnalysis']);
  const outputModuleKeys = new Set(['differentialExpression', 'pathwayEnrichment', 'cellChat', 'projectHistory']);
  const mainTabs = safeManifest.tabs.filter(tab => !exploreModuleKeys.has(tab.moduleKey) && !outputModuleKeys.has(tab.moduleKey));
  const exploreTabs = safeManifest.tabs.filter(tab => exploreModuleKeys.has(tab.moduleKey));
  const outputTabs = safeManifest.tabs.filter(tab => outputModuleKeys.has(tab.moduleKey));

  const toItem = tab => ({
    id: tab.id,
    label: tab.label,
    done: Boolean(pipelineState?.[tab.id]),
    requiresObject: tab.requiresObject,
    requiresProject: tab.requiresProject,
  });

  return [
    { id: 'pipeline-main', label: safeManifest.name, items: mainTabs.map(toItem) },
    { id: 'pipeline-explore', label: 'Explore', items: exploreTabs.map(toItem) },
    { id: 'pipeline-results', label: 'Results', items: outputTabs.map(toItem) },
  ].filter(section => section.items.length > 0);
}

