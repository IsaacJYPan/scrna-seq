'use strict';

// Drafts a Methods section from a reproducibility manifest. Everything here is
// derived from recorded job parameters, server-pinned trusted-method releases and
// the software versions the R runtime reported. It never reads user-authored
// narrative, so the text describes what ran rather than why.

const { validatePbmcPipelineParams } = require('./pbmcPipeline');
const { validateSeuratPipelineParams } = require('./seuratPipeline');
const { validateMultiSampleSeuratParams } = require('./multiSampleSeuratPipeline');
const { validateSpatialSeuratParams } = require('./spatialPipeline');
const { validateDegFindMarkersParams } = require('./degFindMarkers');
const { validateEnrichmentGseaParams } = require('./enrichmentGsea');
const { validateCellChatInferenceParams } = require('./cellChatInference');

const METHODS_TEXT_VERSION = 1;

const REFERENCES = Object.freeze({
  seurat: 'Hao Y, et al. Dictionary learning for integrative, multimodal and scalable single-cell analysis. Nat Biotechnol. 2024;42:293-304. doi:10.1038/s41587-023-01767-y',
  sctransform: 'Hafemeister C, Satija R. Normalization and variance stabilization of single-cell RNA-seq data using regularized negative binomial regression. Genome Biol. 2019;20:296. doi:10.1186/s13059-019-1874-1',
  umap: 'McInnes L, Healy J, Melville J. UMAP: Uniform Manifold Approximation and Projection for dimension reduction. arXiv:1802.03426. 2018.',
  clusterProfiler: 'Wu T, et al. clusterProfiler 4.0: a universal enrichment tool for interpreting omics data. Innovation. 2021;2:100141. doi:10.1016/j.xinn.2021.100141',
  fgsea: 'Korotkevich G, et al. Fast gene set enrichment analysis. bioRxiv. 2016. doi:10.1101/060012',
  cellchat: 'Jin S, Plikus MV, Nie Q. CellChat for systematic analysis of cell-cell communication from single-cell transcriptomics. Nat Protoc. 2025;20:180-219. doi:10.1038/s41596-024-01045-4',
  edgeR: 'Chen Y, Chen L, Lun ATL, Baldoni PL, Smyth GK. edgeR v4: powerful differential analysis of sequencing data with expanded functionality and improved support for small counts and larger datasets. Nucleic Acids Res. 2025;53:gkaf018. doi:10.1093/nar/gkaf018',
});

const SOFTWARE_LABELS = Object.freeze({
  r: 'R', seurat: 'Seurat', cellchat: 'CellChat', cellchatDb: 'CellChatDB',
  edgeR: 'edgeR', limma: 'limma', fgsea: 'fgsea', clusterProfiler: 'clusterProfiler',
  annotationDbi: 'AnnotationDbi', goDb: 'GO.db', organismDb: 'organism annotation package',
});

// Bookkeeping jobs that move checkpoints around but change no analysis.
const NON_SCIENTIFIC_JOB_TYPES = new Set(['checkpoint.save.v1', 'checkpoint.load.v1', 'checkpoint.fork.v1']);

function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? value.toLocaleString('en-US') : String(value);
}

function ordinalDims(n) {
  return n === 1 ? 'the first principal component' : `the first ${formatNumber(n)} principal components`;
}

function safeValidate(validate, parameters) {
  try {
    return validate(parameters || {}).params;
  } catch {
    // A historical job may predate a parameter change. Fall back to what was stored.
    return parameters || {};
  }
}

function inlineValue(value) {
  if (Array.isArray(value)) return value.map(inlineValue).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number') return formatNumber(value);
  if (value === '' || value == null) return '(blank)';
  return String(value);
}

const STAGE_ORDER = ['qc', 'normalize', 'pca', 'cluster', 'umap'];
function reaches(stopAfter, stage) {
  const stop = STAGE_ORDER.indexOf(stopAfter || 'umap');
  return stop < 0 || STAGE_ORDER.indexOf(stage) <= stop;
}

function describeSeuratPipeline(job, cite) {
  const pbmc = job.jobType === 'pbmc.pipeline.v1';
  const multi = job.jobType === 'seurat.multisample.v1';
  const spatial = job.jobType === 'spatial.seurat.v1';
  const validate = pbmc ? validatePbmcPipelineParams
    : multi ? validateMultiSampleSeuratParams
      : spatial ? validateSpatialSeuratParams : validateSeuratPipelineParams;
  const p = safeValidate(validate, job.parameters);
  const samples = multi && Array.isArray(job.parameters?.samples) ? job.parameters.samples : [];
  cite('seurat');
  const sentences = [];
  if (pbmc) {
    sentences.push('The PBMC 3k demonstration object loaded in the session was analysed with Seurat. Any quality-control filtering applied before this step is not part of this record.');
  } else if (spatial) {
    sentences.push('Spot-level counts from a 10x Genomics Visium (Space Ranger) output were analysed with Seurat.');
  } else if (multi) {
    sentences.push(`Counts from ${formatNumber(samples.length)} 10x Genomics HDF5 samples were merged into one Seurat object, keeping each sample's identity.`);
  } else {
    sentences.push('Counts from a 10x Genomics HDF5 file were analysed with Seurat.');
  }
  if (!pbmc) sentences.push(`At object creation, genes detected in fewer than ${formatNumber(p.minCells)} cells and cells with fewer than ${formatNumber(p.minFeatures)} detected genes were excluded.`);
  // The demo pipeline starts after interactive QC and records no thresholds.
  if (!pbmc && p.applyQcFilter) {
    const parts = [`between ${formatNumber(p.minFeaturesFilter)} and ${formatNumber(p.maxFeaturesFilter)} detected genes`];
    if (p.maxPercentMt < 100) parts.push(`at most ${formatNumber(p.maxPercentMt)}% of counts from mitochondrial genes (gene symbols starting with MT-)`);
    if (p.minCountsFilter > 0) parts.push(`at least ${formatNumber(p.minCountsFilter)} total counts`);
    sentences.push(`Cells were retained if they had ${parts.join(', ')}.`);
  } else if (!pbmc) {
    sentences.push('No additional cell-level quality-control filter was applied.');
  }
  if (reaches(p.stopAfter, 'normalize')) {
    if (p.normalizationMethod === 'SCTransform') {
      cite('sctransform');
      sentences.push('Counts were normalized and variance-stabilized with SCTransform.');
    } else {
      sentences.push(`Counts were log-normalized (LogNormalize, scale factor ${formatNumber(p.scaleFactor)}), the ${formatNumber(p.variableFeatures)} most variable genes were selected with the vst method, and these genes were scaled.`);
    }
  }
  if (reaches(p.stopAfter, 'pca')) {
    sentences.push(`Principal component analysis computed ${formatNumber(p.pcaDims)} components from the variable genes.`);
  }
  if (reaches(p.stopAfter, 'cluster')) {
    const integrated = multi && p.integrationMethod === 'rpca';
    if (integrated) {
      sentences.push('Samples were integrated with reciprocal PCA (Seurat IntegrateLayers, RPCAIntegration), and the integrated reduction was used for the neighbour graph and UMAP.');
    }
    sentences.push(`A shared nearest-neighbour graph was built on ${ordinalDims(p.clusterDims)}${integrated ? ' of the integrated reduction' : ''}, and clusters were identified with Seurat's FindClusters (Louvain algorithm) at resolution ${formatNumber(p.clusterResolution)}.`);
  }
  if (reaches(p.stopAfter, 'umap')) {
    cite('umap');
    sentences.push(`A ${formatNumber(p.umapComponents)}-dimensional UMAP embedding was computed from ${ordinalDims(p.umapDims)} (${formatNumber(p.umapNeighbors)} neighbours, minimum distance ${formatNumber(p.umapMinDist)}).`);
  }
  sentences.push(`The random seed was ${formatNumber(p.seed)}.`);
  const heading = spatial ? 'Spatial preprocessing and clustering'
    : multi ? 'Multi-sample preprocessing and clustering' : 'Preprocessing and clustering';
  return { heading, text: sentences.join(' ') };
}

function describeMarkers(job, cite) {
  const p = safeValidate(validateDegFindMarkersParams, job.parameters);
  cite('seurat');
  const grouping = p.groupBy === 'ident' ? 'the current cell identities' : 'Seurat clusters';
  const sentences = [
    `Marker genes for each of ${grouping} were identified with Seurat's FindAllMarkers using a two-sided Wilcoxon rank-sum test on the ${p.assay} assay, comparing each group against all other cells.`,
    `Genes had to be detected in at least ${formatNumber(Math.round(p.minPct * 10000) / 100)}% of cells in either group and show an average log2 fold change of at least ${formatNumber(p.logfcThreshold)}${p.onlyPositive ? '; only genes up-regulated in the group were reported' : ''}.`,
  ];
  if (p.maxCellsPerIdent != null) sentences.push(`Each group was down-sampled to at most ${formatNumber(p.maxCellsPerIdent)} cells.`);
  sentences.push('P values were adjusted with the Bonferroni correction over all genes, as reported by Seurat.');
  if (p.randomSeed != null) sentences.push(`The random seed was ${formatNumber(p.randomSeed)}.`);
  return { heading: 'Cluster marker genes', text: sentences.join(' ') };
}

function describeEnrichment(job, cite) {
  const p = safeValidate(validateEnrichmentGseaParams, job.parameters);
  cite('seurat'); cite('clusterProfiler'); cite('fgsea');
  const grouping = p.groupBy === 'ident' ? 'cell identity' : 'cluster';
  return {
    heading: 'Pathway enrichment',
    text: [
      `For ${grouping} "${p.targetGroup}", genes were ranked by average log2 fold change against all other cells (Seurat FindMarkers, Wilcoxon test, ${p.assay} assay, no expression or fold-change pre-filter${p.maxCellsPerIdent != null ? `, at most ${formatNumber(p.maxCellsPerIdent)} cells per group` : ''}).`,
      `The ranked list was tested for enrichment of Gene Ontology biological process gene sets (${p.species}) with clusterProfiler gseGO using the fgsea algorithm, restricted to gene sets of ${formatNumber(p.minGeneSetSize)} to ${formatNumber(p.maxGeneSetSize)} genes.`,
      `P values were adjusted with the Benjamini-Hochberg method, and pathways with an adjusted P value below ${formatNumber(p.adjustedPValueCutoff)} were called significant.`,
      `The random seed was ${formatNumber(p.randomSeed)}.`,
    ].join(' '),
  };
}

const CELLCHAT_CATEGORY = Object.freeze({
  all: 'all interaction categories',
  secreted_signaling: 'secreted-signalling interactions',
  ecm_receptor: 'ECM-receptor interactions',
  cell_cell_contact: 'cell-cell contact interactions',
});

function describeCellChat(job, cite) {
  const p = safeValidate(validateCellChatInferenceParams, job.parameters);
  cite('cellchat');
  const grouping = p.groupBy === 'ident' ? 'the current cell identities' : 'Seurat clusters';
  return {
    heading: 'Cell-cell communication',
    text: [
      `Candidate cell-cell communication between ${grouping} was inferred with CellChat from the normalized ${p.assay} expression, using the ${p.species} CellChatDB restricted to ${CELLCHAT_CATEGORY[p.databaseCategory] || p.databaseCategory}.`,
      `The analysis treated all cells as a single biological context; it does not compare conditions.`,
      `Groups with fewer than ${formatNumber(p.minCellsPerGroup)} cells were excluded, each group was capped at ${formatNumber(p.maxCellsPerGroup)} cells and the total at ${formatNumber(p.maxTotalCells)} cells.`,
      'Communication probabilities were computed without population-size weighting, because groups were capped, and interactions supported by fewer than the minimum cells per group were removed.',
      `Interactions with P < ${formatNumber(p.pValueCutoff)} were reported. The random seed was ${formatNumber(p.randomSeed)}.`,
    ].join(' '),
  };
}

function describeConditionComparison(job, cite, manifest) {
  cite('edgeR');
  const contrastId = job.parameters?.contrastId;
  const contrast = (manifest.experimentalDesign?.contrasts || []).find((c) => c.id === contrastId);
  const conditionNames = new Map();
  for (const binding of manifest.experimentalDesign?.sampleBindings || []) {
    if (binding.conditionId && binding.conditionName) conditionNames.set(binding.conditionId, binding.conditionName);
  }
  const sentences = [];
  if (contrast) {
    const numerator = conditionNames.get(contrast.numeratorConditionId) || 'the numerator condition';
    const denominator = conditionNames.get(contrast.denominatorConditionId) || 'the reference condition';
    sentences.push(`To compare ${numerator} with ${denominator}, raw counts were summed per ${contrast.unitOfReplication || 'biological replicate'} and cell type${contrast.cellTypeColumn ? ` (cell types from the "${contrast.cellTypeColumn}" annotation)` : ''} to form pseudobulk samples.`);
    if (contrast.paired) sentences.push('Samples were paired by donor, and donor was included in the model.');
  } else {
    sentences.push('Raw counts were summed per biological replicate and cell type to form pseudobulk samples.');
  }
  sentences.push('For each cell type, lowly expressed genes were removed with edgeR filterByExpr (minimum count 10), library sizes were TMM-normalized, dispersions were estimated robustly, and differential expression was tested with the edgeR quasi-likelihood F-test (glmQLFit, glmQLFTest).');
  sentences.push('P values were adjusted with the Benjamini-Hochberg method within each cell type.');
  return { heading: 'Condition comparison', text: sentences.join(' ') };
}

function describeTrustedMethod(job, cite, manifest, lookupMethod) {
  const stored = job.parameters || {};
  const method = typeof stored.method === 'string' ? lookupMethod(stored.method) : null;
  const title = method?.title || stored.method || 'Trusted method';
  const sentences = [];
  sentences.push(method?.summary || `The trusted method "${title}" was run.`);
  const packages = Array.isArray(method?.packages) && method.packages.length > 0
    ? ` using ${method.packages.join(', ')}` : '';
  sentences.push(`This step ran the reviewed TraceOmics method "${stored.method}" version ${stored.methodVersion || 'unknown'}${packages}${stored.methodSourceSha256 ? ` (source SHA-256 ${String(stored.methodSourceSha256).slice(0, 12)})` : ''}.`);
  const labels = new Map((method?.parameters || []).map((p) => [p.key, p.label || p.key]));
  const values = stored.values && typeof stored.values === 'object' ? Object.entries(stored.values) : [];
  if (values.length > 0) {
    sentences.push(`Parameters: ${values.map(([key, value]) => `${labels.get(key) || key} = ${inlineValue(value)}`).join('; ')}.`);
  }
  if (Array.isArray(method?.deviations) && method.deviations.length > 0) {
    sentences.push(`Differences from the upstream protocol: ${method.deviations.join(' ')}`);
  }
  if (method?.provenance?.citation) {
    cite(`method:${method.key}`, method.provenance.doi && !method.provenance.citation.includes(method.provenance.doi)
      ? `${method.provenance.citation} doi:${method.provenance.doi}` : method.provenance.citation);
  }
  return { heading: title, text: sentences.join(' ') };
}

function describeExpertR(job) {
  const sha = job.parameters?.scriptSha256;
  return {
    heading: 'Custom R analysis',
    text: `A custom R script was run in the isolated Expert R sandbox${sha ? ` (script SHA-256 ${String(sha).slice(0, 12)})` : ''}. Its content is not described here; include the script with the manuscript.`,
  };
}

function describeExploration() {
  return {
    heading: 'Summary figures',
    text: 'Summary figures were generated from the saved clustering with the standard TraceOmics figure recipes.',
  };
}

function collectSoftwareVersions(manifest) {
  const versions = new Map();
  const add = (key, value) => {
    if (typeof value !== 'string' || !value) return;
    if (!versions.has(key)) versions.set(key, new Set());
    versions.get(key).add(value);
  };
  for (const artifact of manifest.artifacts || []) {
    const metadata = artifact.metadata && typeof artifact.metadata === 'object' ? artifact.metadata : {};
    add('r', metadata.rVersion);
    add('seurat', metadata.seuratVersion);
    const packages = metadata.packageVersions && typeof metadata.packageVersions === 'object' ? metadata.packageVersions : {};
    for (const [key, value] of Object.entries(packages)) add(key, value);
  }
  // R and Seurat first, then the remaining packages alphabetically.
  const rank = (key) => (key === 'r' ? 0 : key.toLowerCase() === 'seurat' ? 1 : 2);
  return [...versions.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([key, values]) => `${SOFTWARE_LABELS[key] || key} ${[...values].sort().join(' / ')}`);
}

function stableKey(job) {
  return `${job.jobType}:${JSON.stringify(job.parameters || {})}`;
}

/**
 * @param {object} manifest  output of researchExports.buildReproducibilityManifest
 * @param {{ lookupMethod?: (key: string) => object | null }} [options]
 * @returns {string} Markdown
 */
function renderMethodsText(manifest, options = {}) {
  const lookupMethod = options.lookupMethod || (() => null);
  const references = new Map();
  const cite = (key, text = REFERENCES[key]) => { if (text && !references.has(key)) references.set(key, text); };

  const seen = new Set();
  const sections = [];
  for (const job of manifest.jobs || []) {
    if (job.status !== 'completed' || NON_SCIENTIFIC_JOB_TYPES.has(job.jobType)) continue;
    const key = stableKey(job);
    if (seen.has(key)) continue;
    seen.add(key);
    let section = null;
    switch (job.jobType) {
      case 'pbmc.pipeline.v1':
      case 'seurat.pipeline.v1':
      case 'seurat.multisample.v1':
      case 'spatial.seurat.v1':
        section = describeSeuratPipeline(job, cite); break;
      case 'deg.find_markers.v1': section = describeMarkers(job, cite); break;
      case 'enrichment.gsea.v1': section = describeEnrichment(job, cite); break;
      case 'cellchat.infer.v1': section = describeCellChat(job, cite); break;
      case 'condition.pseudobulk_de.v1': section = describeConditionComparison(job, cite, manifest); break;
      case 'trusted.method.v1': section = describeTrustedMethod(job, cite, manifest, lookupMethod); break;
      case 'expert.r.v1': section = describeExpertR(job); break;
      case 'explore.summarize.v1': section = describeExploration(job); break;
      default: section = { heading: job.jobType, text: `A ${job.jobType} step was run; TraceOmics has no Methods template for it.` };
    }
    sections.push(section);
  }

  const lines = [
    '# Methods (draft)',
    '',
    `_Drafted by TraceOmics from the recorded history of analysis ${manifest.exportedAnalysisObjectId}${manifest.generatedAt ? ` on ${String(manifest.generatedAt).slice(0, 10)}` : ''}. It describes the parameters that were recorded, not the reasons for choosing them. Check it against your analysis before use._`,
    '',
  ];
  if (sections.length === 0) {
    lines.push('No completed analysis steps were recorded for this analysis.', '');
  }
  for (const section of sections) {
    lines.push(`## ${section.heading}`, '', section.text, '');
  }
  const software = collectSoftwareVersions(manifest);
  lines.push('## Software', '');
  lines.push(software.length > 0
    ? `Analyses used ${software.join(', ')}.`
    : 'The runtime did not record software versions for these steps.');
  lines.push('');
  if (references.size > 0) {
    lines.push('## References', '');
    let n = 1;
    for (const text of references.values()) lines.push(`${n++}. ${text}`);
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { METHODS_TEXT_VERSION, REFERENCES, renderMethodsText };
