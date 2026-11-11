'use strict';

// Server-registered workflow releases (docs/spec.md 8.1). Only operations in
// this catalog can ever run for an agent. A release's digest covers the bytes
// of its handler files, its parameter schema, resource profile, inputs and
// outputs, so changing any of them yields a new release identity and makes
// earlier approvals stop matching. Nothing here accepts code, paths, or
// executable parameters from a caller.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SEURAT_PIPELINE_PARAM_SPEC, validateSeuratPipelineParams } = require('../seuratPipeline');
const { DEG_FIND_MARKERS_PARAM_SPEC, validateDegFindMarkersParams } = require('../degFindMarkers');
const { validateSpatialSeuratParams } = require('../spatialPipeline');
const { validateMultiSampleSeuratParams } = require('../multiSampleSeuratPipeline');
const trustedMethods = require('./trustedMethods');
const { ENRICHMENT_GSEA_PARAM_SPEC, validateEnrichmentGseaParams } = require('../enrichmentGsea');
const { CELLCHAT_INFERENCE_PARAM_SPEC, validateCellChatInferenceParams } = require('../cellChatInference');

// Marks the named parameters of an existing job's spec as study design
// choices, which a person must fix (studies.js refuses to vary them).
function withDesignRoles(spec, names) {
  return Object.fromEntries(Object.entries(spec).map(([key, entry]) => [key, names.includes(key) ? { ...entry, role: 'design' } : entry]));
}

const ROOT = path.join(__dirname, '..', '..');

// Summary fields a study may rank trials by (selection rules). Each has a kind:
// descriptive and quality metrics may be selected; inferential ones
// (significance counts, test statistics) are reported but never optimized,
// because ranking trials by them hides how many analyses were tried.
const PIPELINE_METRICS = [
  { key: 'nClusters', label: 'clusters', kind: 'descriptive' },
  { key: 'postFilterCells', label: 'cells kept after QC', kind: 'quality' },
  { key: 'nVariableFeatures', label: 'variable features', kind: 'descriptive' }
];

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Library methods whose output is a new Seurat analysis (for example an
// integrated or annotated object) can feed any release that reads one.
function analysisProducingMethodKeys() {
  return trustedMethods.loadLibrary().methods.filter((m) => m.outputs.analysis).map((m) => m.key);
}

const DEFINITIONS = [
  {
    key: 'seurat-qc-cluster',
    version: '1',
    title: 'Seurat QC, normalization and clustering (10x HDF5)',
    jobType: 'seurat.pipeline.v1',
    // seuratPipelineCore.R holds the analysis steps themselves; plumber.R only
    // sources it, so it must be digested in its own right.
    handlerFiles: [
      'backend/seuratPipeline.js',
      'backend/jobs/pipelineHandlers.js',
      'r-backend/plumber.R',
      'r-backend/lib/seuratPipelineCore.R'
    ],
    readableSource: 'r-backend/lib/seuratPipelineCore.R',
    inputs: [{ name: 'dataset', fileTypes: ['tenx_h5'] }],
    outputs: [{ name: 'result', kind: 'analysis_object', objectType: 'seurat' }],
    parameterSchema: SEURAT_PIPELINE_PARAM_SPEC,
    // Accounting reservation per run. The local worker runs one job at a time;
    // physical CPU/memory limits come from the R runtime's container settings.
    resources: { cpus: 1, memoryMiB: 8192, maxWallSeconds: 3600 },
    validation: ['job.completed', 'result.analysis_object.present'],
    validateParameters: params => validateSeuratPipelineParams(params).params,
    selectableMetrics: PIPELINE_METRICS
  },
  {
    // A follow-on step: it runs on the accepted clustering of a source study
    // (see studies.js), never on an arbitrary object, and reads it without
    // changing it. Its output is a marker table plus a bounded summary.
    key: 'seurat-markers',
    version: '1',
    title: 'Cluster marker genes (on an accepted clustering)',
    jobType: 'deg.find_markers.v1',
    handlerFiles: ['backend/degFindMarkers.js', 'backend/jobs/analysisHandlers.js', 'r-backend/plumber.R'],
    inputs: [
      {
        name: 'clustering',
        kind: 'analysis_object',
        fromReleases: ['seurat-qc-cluster', 'seurat-multisample', 'spatial-seurat', ...analysisProducingMethodKeys()],
        requiresStage: 'cluster'
      }
    ],
    outputs: [{ name: 'markers', kind: 'artifact', artifactType: 'deg_summary' }],
    parameterSchema: DEG_FIND_MARKERS_PARAM_SPEC,
    resources: { cpus: 1, memoryMiB: 8192, maxWallSeconds: 1800 },
    validation: ['job.completed', 'result.artifact.present'],
    validateParameters: params => validateDegFindMarkersParams(params).params,
    selectableMetrics: [
      { key: 'nGroups', label: 'groups', kind: 'descriptive' },
      { key: 'nMarkersTotal', label: 'marker genes', kind: 'inferential' }
    ]
  },
  {
    // Ranked GO Biological Process enrichment for one group versus the rest.
    // The group and species are study design choices.
    key: 'pathway-gsea',
    version: '1',
    title: 'Ranked GO pathway enrichment for one group (fgsea)',
    jobType: 'enrichment.gsea.v1',
    handlerFiles: [
      'backend/enrichmentGsea.js',
      'backend/jobs/analysisHandlers.js',
      'r-backend/plumber.R',
      'r-backend/lib/enrichmentGsea.R'
    ],
    inputs: [
      {
        name: 'clustering',
        kind: 'analysis_object',
        fromReleases: ['seurat-qc-cluster', 'seurat-multisample', 'spatial-seurat', ...analysisProducingMethodKeys()]
      }
    ],
    outputs: [{ name: 'pathways', kind: 'artifact', artifactType: 'enrichment_summary' }],
    parameterSchema: withDesignRoles(ENRICHMENT_GSEA_PARAM_SPEC, [
      'groupBy',
      'targetGroup',
      'species',
      'geneSetCollection',
      'adjustedPValueCutoff'
    ]),
    resources: { cpus: 1, memoryMiB: 8192, maxWallSeconds: 1800 },
    validation: ['job.completed', 'result.artifact.present'],
    validateParameters: params => validateEnrichmentGseaParams(params).params,
    selectableMetrics: [
      { key: 'mappingRate', label: 'gene mapping rate', kind: 'quality' },
      { key: 'testedPathwayCount', label: 'pathways tested', kind: 'descriptive' },
      { key: 'significantPathwayCount', label: 'significant pathways', kind: 'inferential' }
    ]
  },
  {
    // Single-context CellChat ligand-receptor candidates. The intent is fixed
    // to one context: it is not a cross-condition comparison.
    key: 'cellchat-single-context',
    version: '1',
    title: 'Cell-cell communication candidates in one context (CellChat)',
    jobType: 'cellchat.infer.v1',
    handlerFiles: [
      'backend/cellChatInference.js',
      'backend/jobs/analysisHandlers.js',
      'r-backend/plumber.R',
      'r-backend/lib/cellChatInference.R'
    ],
    inputs: [
      {
        name: 'clustering',
        kind: 'analysis_object',
        fromReleases: ['seurat-qc-cluster', 'seurat-multisample', 'spatial-seurat', ...analysisProducingMethodKeys()]
      }
    ],
    outputs: [{ name: 'interactions', kind: 'artifact', artifactType: 'cellchat_summary' }],
    parameterSchema: withDesignRoles(CELLCHAT_INFERENCE_PARAM_SPEC, [
      'groupBy',
      'species',
      'databaseCategory',
      'analysisIntent',
      'pValueCutoff',
      'minCellsPerGroup',
      'maxCellsPerGroup',
      'maxTotalCells'
    ]),
    resources: { cpus: 1, memoryMiB: 16384, maxWallSeconds: 3600 },
    validation: ['job.completed', 'result.artifact.present'],
    validateParameters: params => validateCellChatInferenceParams(params).params,
    selectableMetrics: []
  },
  {
    // Several 10x HDF5 captures merged with a sample sheet (sample, condition,
    // donor, batch). The sheet is a design choice: a person fixes it in the
    // study; it names exactly the study's pinned datasets.
    key: 'seurat-multisample',
    version: '1',
    title: 'Seurat multi-sample QC, normalization and clustering (10x HDF5 + sample sheet)',
    jobType: 'seurat.multisample.v1',
    handlerFiles: [
      'backend/multiSampleSeuratPipeline.js',
      'backend/seuratPipeline.js',
      'backend/jobs/pipelineHandlers.js',
      'r-backend/plumber.R'
    ],
    inputs: [{ name: 'datasets', fileTypes: ['tenx_h5'], multiple: true }],
    outputs: [{ name: 'result', kind: 'analysis_object', objectType: 'seurat' }],
    parameterSchema: {
      samples: { type: 'sampleSheet', role: 'design', label: 'Sample sheet' },
      ...SEURAT_PIPELINE_PARAM_SPEC
    },
    resources: { cpus: 1, memoryMiB: 16384, maxWallSeconds: 7200 },
    validation: ['job.completed', 'result.analysis_object.present'],
    validateParameters: params => {
      const { params: resolved, samples } = validateMultiSampleSeuratParams(params);
      return { samples, ...resolved };
    },
    selectableMetrics: PIPELINE_METRICS
  },
  {
    // Classic 10x Visium (Space Ranger bundle). Same parameter contract and
    // analysis core as the single-cell pipeline, loaded with Load10X_Spatial.
    key: 'spatial-seurat',
    version: '1',
    title: 'Seurat spatial QC, normalization and clustering (10x Visium)',
    jobType: 'spatial.seurat.v1',
    handlerFiles: [
      'backend/spatialPipeline.js',
      'backend/seuratPipeline.js',
      'backend/jobs/pipelineHandlers.js',
      'r-backend/plumber.R'
    ],
    inputs: [{ name: 'dataset', fileTypes: ['visium_zip'] }],
    outputs: [{ name: 'result', kind: 'analysis_object', objectType: 'seurat' }],
    parameterSchema: SEURAT_PIPELINE_PARAM_SPEC,
    resources: { cpus: 1, memoryMiB: 8192, maxWallSeconds: 3600 },
    validation: ['job.completed', 'result.analysis_object.present'],
    validateParameters: params => validateSpatialSeuratParams(params).params,
    selectableMetrics: PIPELINE_METRICS
  }
];
// Follow-on releases that read an accepted clustering. Exactly one release per
// job type: pathway enrichment and CellChat are covered by pathway-gsea and
// cellchat-single-context above, whose design parameters a person fixes.
// The two explore.summarize.v1 releases below have disjoint recipe enums.
const CLUSTERED_SOURCES = ['seurat-qc-cluster', 'seurat-multisample'];

DEFINITIONS.push(
  {
    key: 'standard-figures',
    version: '1',
    title: 'Standard publication figure recipes',
    jobType: 'explore.summarize.v1',
    handlerFiles: ['backend/jobs/analysisHandlers.js', 'r-backend/plumber.R', 'r-backend/lib/standardFigures.R'],
    inputs: [{ name: 'clustering', kind: 'analysis_object', fromReleases: CLUSTERED_SOURCES, requiresStage: 'cluster' }],
    outputs: [{ name: 'result', kind: 'artifact', artifactType: 'exploration_summary' }],
    parameterSchema: {
      recipe: {
        type: 'enum',
        values: ['figure_qc', 'figure_pca', 'figure_umap', 'figure_heatmap', 'figure_dot', 'figure_feature'],
        default: 'figure_umap'
      }
    },
    resources: { cpus: 1, memoryMiB: 8192, maxWallSeconds: 3600 },
    validation: ['job.completed', 'result.artifact.present'],
    validateParameters: p => require('../exploratoryAnalysis').validateExploratoryAnalysisParams(p).params,
    selectableMetrics: [{ key: 'nCells', label: 'cells', kind: 'descriptive' }]
  },
  {
    // The contrast is registered by a person on the accepted input and pinned
    // by digest at planning time (workflowTrust/design.js).
    key: 'condition-pseudobulk',
    version: '1',
    title: 'Replicate-aware condition DE',
    jobType: 'condition.pseudobulk_de.v1',
    handlerFiles: ['backend/jobs/analysisHandlers.js', 'r-backend/plumber.R', 'r-backend/lib/conditionComparison.R'],
    inputs: [{ name: 'clustering', kind: 'analysis_object', fromReleases: CLUSTERED_SOURCES, requiresStage: 'cluster' }],
    outputs: [{ name: 'result', kind: 'artifact', artifactType: 'condition_de_summary' }],
    parameterSchema: { contrastId: { type: 'contrastId', required: true, role: 'design' } },
    resources: { cpus: 1, memoryMiB: 8192, maxWallSeconds: 3600 },
    validation: ['job.completed', 'result.artifact.present'],
    validateParameters: p => require('../conditionComparison').validateConditionComparisonParams(p).params,
    selectableMetrics: [
      { key: 'sampleCount', label: 'samples', kind: 'descriptive' },
      { key: 'testedCellTypeCount', label: 'cell types tested', kind: 'descriptive' },
      { key: 'testedGeneCount', label: 'genes tested', kind: 'descriptive' },
      { key: 'significantResultCount', label: 'significant results', kind: 'inferential' }
    ]
  },
  {
    // What the study asks (contrast, populations, condition, target group) is
    // fixed by a person. Only the displayed gene panel may vary.
    key: 'study-workbench',
    version: '1',
    title: 'Multi-condition biological investigation and figures',
    jobType: 'explore.summarize.v1',
    handlerFiles: [
      'backend/exploratoryAnalysis.js',
      'backend/jobs/analysisHandlers.js',
      'r-backend/plumber.R',
      'r-backend/lib/conditionStudy.R',
      'r-backend/lib/conditionComparison.R'
    ],
    inputs: [{ name: 'clustering', kind: 'analysis_object', fromReleases: CLUSTERED_SOURCES, requiresStage: 'cluster' }],
    outputs: [
      { name: 'result', kind: 'artifact', artifactType: 'exploration_summary' },
      { name: 'inference', kind: 'artifact', artifactType: 'study_inference_summary' }
    ],
    parameterSchema: {
      recipe: {
        type: 'enum',
        values: ['study_composition', 'study_expression', 'study_qc', 'study_de', 'study_pathways', 'study_communication']
      },
      featureNames: { type: 'geneList' },
      groupMap: { type: 'groupMap', role: 'design' },
      conditionName: { type: 'safeLabel', role: 'design' },
      contrastId: { type: 'contrastId', role: 'design' },
      targetGroup: { type: 'populationLabel', role: 'design' },
      species: { type: 'enum', values: ['human', 'mouse'], role: 'design' }
    },
    resources: { cpus: 1, memoryMiB: 12288, maxWallSeconds: 3600 },
    validation: ['job.completed', 'result.artifact.present'],
    validateParameters: p => require('../exploratoryAnalysis').validateExploratoryAnalysisParams(p).params,
    selectableMetrics: [{ key: 'nCells', label: 'cells', kind: 'descriptive' }]
  }
);

// Files every trusted-method release runs through, in addition to its own R file.
const TRUSTED_METHOD_HANDLER_FILES = [
  'backend/workflowTrust/trustedMethods.js',
  'backend/jobs/trustedMethodHandler.js',
  'backend/workflowRuntime.js',
  'backend/workflowOutputs.js',
];

function sourceReleaseKey(source) {
  return source.startsWith('trusted:') ? source.slice('trusted:'.length) : source;
}

// One release per library method (trusted-methods/catalog.json). Its digest
// covers the method's R bytes, catalog entry, provenance, and the shared
// executor files, so editing any of them requires a fresh approval.
function trustedMethodDefinitions() {
  return trustedMethods.loadLibrary().methods.map((method) => ({
    key: method.key,
    version: method.version,
    title: method.title,
    jobType: trustedMethods.JOB_TYPE,
    handlerFiles: [...TRUSTED_METHOD_HANDLER_FILES, `trusted-methods/${method.entry}`],
    inputs: [{ name: 'analysis', kind: 'analysis_object', fromReleases: method.accepts.map(sourceReleaseKey) }],
    outputs: [{ name: 'result', kind: 'analysis_object', objectType: method.outputs.analysis ? 'seurat' : 'generic' }],
    parameterSchema: trustedMethods.releaseParameterSchema(method),
    resources: method.resources,
    validation: ['job.completed', 'result.analysis_object.present', 'outputs.typed', `summary.${method.summaryOutput}`],
    method: {
      category: method.category,
      modalities: method.modalities,
      packages: method.packages,
      provenance: method.provenance,
      deviations: method.deviations,
      outputs: method.outputs,
      metrics: method.metrics,
      runtimeProfileId: trustedMethods.loadLibrary().runtimeProfileId,
    },
    validateParameters: (params) => trustedMethods.resolveMethodParameters(method, params),
    selectableMetrics: method.metrics.map(({ key, label, kind }) => ({ key, label, kind })),
  }));
}

function allDefinitions() {
  return [...DEFINITIONS, ...trustedMethodDefinitions()];
}

// Artifact types that count as a release's declared result (spec 13.1).
const RESULT_ARTIFACT_TYPES = Object.freeze(
  [...new Set(allDefinitions().flatMap((d) => d.outputs.filter((o) => o.kind === 'artifact').map((o) => o.artifactType)))]
);

// Type/range check for one parameter value against a release schema entry,
// without defaults. Cross-parameter constraints are checked at planning time.
function validateScalar(schema, name, value) {
  const spec = schema[name];
  if (!spec) throw new Error(`Unknown parameter '${name}'.`);
  const fail = (why) => { throw new Error(`Parameter '${name}' ${why}.`); };
  if (['geneList', 'groupMap', 'populationLabel'].includes(spec.type)) {
    require('../scientificChoices').scientificText(spec.type, value);
    return;
  }
  if (spec.type === 'contrastId') {
    if (typeof value !== 'string' || !/^contrast_[a-f0-9]+$/.test(value)) fail('must be a registered contrast id');
    return;
  }
  if (spec.type === 'enum') { if (!spec.values.includes(value)) fail(`must be one of: ${spec.values.join(', ')}`); return; }
  if (spec.type === 'bool') { if (typeof value !== 'boolean') fail('must be a boolean'); return; }
  if (spec.type === 'safeLabel') {
    if (typeof value !== 'string' || !/^[A-Za-z0-9 ._+()-]{1,80}$/.test(value.trim())) fail('must be a group label');
    return;
  }
  if (spec.type === 'sampleSheet') {
    validateMultiSampleSeuratParams({ samples: value });
    return;
  }
  if (spec.type === 'text') {
    trustedMethods.checkValue({ key: name, type: 'text', pattern: spec.pattern, maxLength: spec.maxLength }, value);
    return;
  }
  if ((spec.type === 'intOrNull' || spec.nullMeansDefault) && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('must be a finite number');
  if ((spec.type === 'int' || spec.type === 'intOrNull') && !Number.isInteger(value)) fail('must be an integer');
  if (value < spec.min || value > spec.max) fail(`must be between ${spec.min} and ${spec.max}`);
}

function fileDigest(relative) {
  const bytes = fs.readFileSync(path.join(ROOT, relative));
  return { path: relative, sha256: sha256(bytes) };
}

function buildRelease(definition, trust = require('./manifest').trustManifest()) {
  const identity = {
    schema: 'traceomics.workflow-release.v1',
    key: definition.key,
    version: definition.version,
    jobType: definition.jobType,
    handler: definition.handlerFiles.map(fileDigest),
    parameterSchema: definition.parameterSchema,
    inputs: definition.inputs,
    outputs: definition.outputs,
    resources: definition.resources,
    validation: definition.validation,
    selectableMetrics: definition.selectableMetrics,
    ...(definition.method ? { method: definition.method } : {}),
    trust,
  };
  const digest = sha256(canonicalJson(identity));
  return {
    id: `rel_${digest.slice(0, 24)}`,
    key: definition.key,
    version: definition.version,
    title: definition.title,
    jobType: definition.jobType,
    digest,
    definition: { ...identity, title: definition.title },
    readableSource: definition.readableSource || null,
    validateParameters: definition.validateParameters,
  };
}

function currentReleases() {
  const trust = require('./manifest').trustManifest();
  return allDefinitions().map(definition => buildRelease(definition, trust));
}

// Registers the current releases and supersedes older digests of the same key.
async function syncReleaseCatalog(db, releases = currentReleases()) {
  const pool = await db.connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('workflow-release-catalog'))");
    for (const release of releases) {
      await client.query(
        `UPDATE workflow_releases SET status = 'superseded', superseded_at = now()
          WHERE release_key = $1 AND digest <> $2 AND status = 'current'`,
        [release.key, release.digest]
      );
      await client.query(
        `INSERT INTO workflow_releases (id, release_key, version, job_type, digest, definition_json, status)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'current')
         ON CONFLICT (digest) DO UPDATE SET status = 'current', superseded_at = NULL`,
        [release.id, release.key, release.version, release.jobType, release.digest, JSON.stringify(release.definition)]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return releases;
}

function releaseByKey(key) {
  return currentReleases().find((release) => release.key === key) || null;
}

module.exports = {
  RESULT_ARTIFACT_TYPES,
  validateScalar,
  canonicalJson,
  sha256,
  currentReleases,
  syncReleaseCatalog,
  releaseByKey,
  buildRelease
};
