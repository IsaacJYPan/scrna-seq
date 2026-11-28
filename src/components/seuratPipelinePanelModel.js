
// Visium ZIPs are inspected when uploaded, so they must reach `valid`. 10x HDF5
// contents are validated by the R worker when the run starts; the server
// leaves them `pending` and admits them unless they were marked invalid (see
// backend/seuratPipeline.js). Gate the UI on the same rule.
export function datasetReadyForWorkflow(dataset) {
  if (dataset?.uploadStatus !== 'uploaded') return false;
  if (dataset?.fileType === 'visium_zip') return dataset?.validationStatus === 'valid';
  return dataset?.validationStatus !== 'invalid';
}

export function datasetResearchStatus(dataset) {
  if (dataset?.uploadStatus === 'failed' || dataset?.validationStatus === 'invalid') return 'Needs attention';
  if (dataset?.uploadStatus === 'uploaded' && dataset?.validationStatus === 'valid') return 'Ready for analysis';
  if (datasetReadyForWorkflow(dataset)) return 'Ready for analysis · contents are checked when the run starts';
  if (dataset?.uploadStatus === 'uploaded') return 'Checking data';
  return 'Preparing data';
}

const SUMMARY_LABELS = {
  completedStage: 'Completed stage',
  nCells: 'Cells',
  nFeatures: 'Genes',
  preFilterCells: 'Cells before QC',
  postFilterCells: 'Cells after QC',
  nSamples: 'Samples',
  nConditions: 'Conditions',
  cells: 'Cells',
  features: 'Genes',
  reductions: 'Reductions',
};

// Run summaries can contain nested diagnostics objects; show only readable
// scalar values (or short lists of scalars) with researcher-facing labels.
export function summaryDisplayEntries(summary) {
  if (!summary || typeof summary !== 'object') return [];
  const scalar = value => ['string', 'number', 'boolean'].includes(typeof value);
  return Object.entries(summary).flatMap(([key, value]) => {
    let text = null;
    if (scalar(value)) text = typeof value === 'number' ? value.toLocaleString() : String(value);
    else if (Array.isArray(value) && value.length && value.every(scalar)) text = value.join(', ');
    if (text === null) return [];
    const label = SUMMARY_LABELS[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
    return [[key, label, text]];
  });
}

export const CLASSIC_VISIUM_REQUIRED_FILES = [
  'filtered_feature_bc_matrix.h5',
  'spatial/tissue_positions.csv or spatial/tissue_positions_list.csv',
  'spatial/scalefactors_json.json',
  'spatial/tissue_lowres_image.png',
];

export const MAX_MULTI_SAMPLE_INPUTS = 48;
const SAFE_MULTI_SAMPLE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

export function isValidMultiSampleLabel(value, { optional = false } = {}) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return optional;
  return normalized.length <= 80 && SAFE_MULTI_SAMPLE_LABEL_PATTERN.test(normalized);
}

export function datasetValidationMessages(dataset) {
  const value = dataset?.validationErrors;
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').slice(0, 4);
  if (value && typeof value === 'object' && Array.isArray(value.errors)) {
    return value.errors.filter((item) => typeof item === 'string').slice(0, 4);
  }
  return [];
}

export function defaultSampleName(dataset) {
  const raw = String(dataset?.originalFilename || dataset?.name || 'sample')
    .replace(/\.h5$/i, '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '_')
    .trim()
    .slice(0, 80);
  return /^[A-Za-z0-9]/.test(raw) ? raw : `sample_${raw}`.slice(0, 80);
}

// Removed API constant
// ── Load Object Modal ──────────────────────────────────────────────

export function safeMessage(value) {
  return String(value || '')
    .replace(/[A-Za-z]:[\\/][^\s'")]+/g, '[redacted path]')
    .replace(/\/__private_vault__\/[^\s'")]+/g, '[redacted path]')
    .replace(/\bvault\/[^\s'")]+/gi, '[redacted storage]')
    .replace(/\bstorage_?(uri|key)\b/gi, '[redacted storage field]')
    .replace(/\bclaim_?token\b/gi, '[redacted worker field]')
    .replace(/\bstate_?key\b/gi, '[redacted state field]')
    .replace(/\buser-\d+:obj-[A-Za-z0-9_-]+/g, '[redacted state]');
}

export function isSupportedTenxH5File(file) {
  return !!file?.name && /\.h5$/i.test(file.name);
}

export function isSupportedClassicVisiumZipFile(file) {
  return !!file?.name && /\.zip$/i.test(file.name);
}

export const DEFAULT_SEURAT_PIPELINE_PARAMS = Object.freeze({
  minCells: 3,
  minFeatures: 200,
  applyQcFilter: true,
  minFeaturesFilter: 200,
  maxFeaturesFilter: 2500,
  maxPercentMt: 5,
  normalizationMethod: 'LogNormalize',
  scaleFactor: 10000,
  variableFeatures: 2000,
  pcaDims: 50,
  clusterDims: 15,
  clusterResolution: 0.8,
  umapDims: 15,
  umapComponents: 2,
  umapNeighbors: 30,
  umapMinDist: 0.3,
  seed: null,
});

export const SEURAT_NUMERIC_CONTROLS = Object.freeze([
  { key: 'minCells', label: 'Min cells', min: 0, max: 10000, step: 1 },
  { key: 'minFeatures', label: 'Min features', min: 0, max: 100000, step: 1 },
  { key: 'minFeaturesFilter', label: 'QC min features', min: 0, max: 100000, step: 1 },
  { key: 'maxFeaturesFilter', label: 'QC max features', min: 1, max: 1000000, step: 1 },
  { key: 'maxPercentMt', label: 'Max percent MT', min: 0, max: 100, step: 0.1 },
  { key: 'scaleFactor', label: 'Scale factor', min: 1, max: 10000000, step: 1 },
  { key: 'variableFeatures', label: 'Variable features', min: 50, max: 10000, step: 1 },
  { key: 'pcaDims', label: 'PCA dims', min: 2, max: 100, step: 1 },
  { key: 'clusterDims', label: 'Cluster dims', min: 2, max: 100, step: 1 },
  { key: 'clusterResolution', label: 'Cluster resolution', min: 0.01, max: 10, step: 0.01 },
  { key: 'umapDims', label: 'UMAP dims', min: 2, max: 100, step: 1 },
  { key: 'umapNeighbors', label: 'UMAP neighbors', min: 2, max: 200, step: 1 },
  { key: 'umapMinDist', label: 'UMAP min dist', min: 0, max: 1, step: 0.01 },
]);

function datasetDisplayName(dataset) {
  return dataset?.originalFilename || dataset?.name || dataset?.id || 'Dataset';
}

export function rawDatasetObjectName(dataset) {
  const base = datasetDisplayName(dataset).replace(/\.[^.]+$/, '');
  return `${base} raw input`;
}

export function scrubEmptyParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== '') out[key] = value !== null && (key === 'seed' || key === 'umapComponents' || SEURAT_NUMERIC_CONTROLS.some(control => control.key === key))
      ? Number(value) : value;
  }
  return out;
}

// A multi-sample run is described by its samples, not by the first file,
// which the job records only as an internal anchor.
export function runInputLabel({ job, multiSampleMode, multiSampleRows = [], activeDataset }) {
  const recorded = Array.isArray(job?.parameters?.samples) ? job.parameters.samples : null;
  const samples = recorded || (multiSampleMode ? multiSampleRows : []);
  if (samples.length >= 2 || (multiSampleMode && samples.length)) {
    const conditions = new Set(samples
      .map(sample => String(sample?.conditionName || '').trim().toLocaleLowerCase('en-US'))
      .filter(Boolean));
    const sampleText = `${samples.length} ${samples.length === 1 ? 'sample' : 'samples'}`;
    const conditionText = conditions.size ? ` across ${conditions.size} ${conditions.size === 1 ? 'condition' : 'conditions'}` : '';
    return { label: 'Input', value: `${sampleText}${conditionText}` };
  }
  return { label: 'Dataset', value: activeDataset?.originalFilename || activeDataset?.displayName || 'Selected dataset' };
}
