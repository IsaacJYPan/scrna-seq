// Which analysis tab a piece of agent work belongs to, so the agent notebook
// can file every cell under the step of the analysis it serves.
//
// Verified-code runs are placed by their release: built-in workflows by job
// type, trusted library methods by their catalog category. An agent's own
// script (a sandbox run) names its tab when it is submitted, from the same
// fixed list. Shared by the backend (validation, the notebook read model) and
// the app (headings, the per-tab sections).

export const AGENT_NOTEBOOK_TABS = Object.freeze([
  Object.freeze({ id: 'qc', label: 'Quality Control' }),
  Object.freeze({ id: 'normalize', label: 'Normalization' }),
  Object.freeze({ id: 'pca', label: 'PCA' }),
  Object.freeze({ id: 'integrate', label: 'Integration' }),
  Object.freeze({ id: 'cluster', label: 'Clustering & annotation' }),
  Object.freeze({ id: 'umap', label: 'UMAP' }),
  Object.freeze({ id: 'deg', label: 'Differential Expression' }),
  Object.freeze({ id: 'enrichment', label: 'Pathway Enrichment' }),
  Object.freeze({ id: 'cellchat', label: 'Cell-cell communication' }),
  Object.freeze({ id: 'explore', label: 'Exploratory analysis' }),
]);

export const AGENT_NOTEBOOK_TAB_IDS = Object.freeze(AGENT_NOTEBOOK_TABS.map((tab) => tab.id));

const TAB_ORDER = new Map(AGENT_NOTEBOOK_TAB_IDS.map((id, index) => [id, index]));

export function isAgentNotebookTab(value) {
  return typeof value === 'string' && TAB_ORDER.has(value);
}

export function agentNotebookTabLabel(id) {
  return AGENT_NOTEBOOK_TABS.find((tab) => tab.id === id)?.label || 'Exploratory analysis';
}

export function agentNotebookTabOrder(id) {
  return TAB_ORDER.has(id) ? TAB_ORDER.get(id) : TAB_ORDER.get('explore');
}

const JOB_TYPE_TABS = Object.freeze({
  'seurat.pipeline.v1': 'cluster',
  'seurat.multisample.v1': 'integrate',
  'spatial.seurat.v1': 'cluster',
  'deg.find_markers.v1': 'deg',
  'condition.pseudobulk_de.v1': 'deg',
  'enrichment.gsea.v1': 'enrichment',
  'cellchat.infer.v1': 'cellchat',
  'explore.summarize.v1': 'explore',
});

// Trusted library methods (trusted-methods/catalog.json) by category.
const METHOD_CATEGORY_TABS = Object.freeze({
  qc: 'qc',
  integration: 'integrate',
  annotation: 'cluster',
  differential: 'deg',
  scoring: 'explore',
  visualization: 'explore',
  trajectory: 'explore',
  spatial: 'explore',
});

// release: { key, jobType }; methodCategory: the trusted method's category
// when the release is a library method.
export function tabForRelease(release, { methodCategory } = {}) {
  if (methodCategory && METHOD_CATEGORY_TABS[methodCategory]) return METHOD_CATEGORY_TABS[methodCategory];
  return JOB_TYPE_TABS[release?.jobType] || 'explore';
}
