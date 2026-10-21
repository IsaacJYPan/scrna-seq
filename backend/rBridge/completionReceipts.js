// Sign and validate R completion receipts before recovering job outputs.

const crypto = require('crypto');
const storage = require('../storage');
const { codedError } = require('./errors');
const { R_BRIDGE_OPERATIONS } = require('./operations');
const {
  sanitizePipelineSummary,
  sanitizeCheckpointInfo,
  sanitizeNameList,
  sanitizeEnrichmentSummary,
  sanitizeEnrichmentResultInfo,
  sanitizeCellChatSummary,
  sanitizeCellChatResultInfo,
  isCompleteCellChatSummary,
  sanitizeConditionComparisonSummary,
  sanitizeDegSummary,
  sanitizeDegResultInfo,
  sanitizeLoadSummary,
} = require('./summaries');

const COMPLETION_RECEIPT_SIGNED_MAX_BYTES = 96 * 1024;

const COMPLETION_RECEIPT_ALGORITHM = 'hmac-sha256';

const COMPLETION_JOB_TO_R_OPERATION = Object.freeze({
  'pbmc.pipeline.v1': 'r.pbmc.pipeline.v1',
  'seurat.pipeline.v1': 'r.seurat.pipeline.v1',
  'seurat.multisample.v1': 'r.seurat.multisample.v1',
  'spatial.seurat.v1': 'r.spatial.seurat.v1',
  'checkpoint.save.v1': 'r.checkpoint.save.v1',
  'deg.find_markers.v1': 'r.deg.find_markers.v1',
  'enrichment.gsea.v1': 'r.enrichment.gsea.v1',
  'cellchat.infer.v1': 'r.cellchat.infer.v1',
  'condition.pseudobulk_de.v1': 'r.condition.pseudobulk_de.v1',
  'checkpoint.load.v1': 'r.checkpoint.load.v1',
  'checkpoint.fork.v1': 'r.checkpoint.load.v1',
});

const COMPLETION_RECEIPT_BINDING_KEYS = Object.freeze([
  'version',
  'job_id',
  'job_type',
  'r_operation',
  'project_id',
  'receipt_storage_key',
  'source_analysis_object_id',
  'source_dataset_id',
  'source_checkpoint_artifact_id',
  'target_analysis_object_id',
  'output_storage_key',
]);

const COMPLETION_RECEIPT_KEYS = Object.freeze([...COMPLETION_RECEIPT_BINDING_KEYS, 'payload']);

// Shared byte-for-byte with R; printable text avoids R's embedded-NUL restriction.
const COMPLETION_RECEIPT_HMAC_DOMAIN = 'TRACEOMICS_R_COMPLETION_RECEIPT_V1:';

function isPlainObject(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactObjectKeys(value, keys, code = 'R_COMPLETION_RECEIPT_INVALID') {
  if (!isPlainObject(value)) throw codedError(code, 'Completion receipt is invalid.');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw codedError(code, 'Completion receipt is invalid.');
  }
}

function assertAllowedObjectKeys(value, allowed, required = []) {
  if (!isPlainObject(value))
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  const allowedSet = new Set(allowed);
  if (
    Object.keys(value).some((key) => !allowedSet.has(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
}

function createCompletionReceiptEnvelope(receipt, secret) {
  if (!isPlainObject(receipt) || typeof secret !== 'string' || secret.length === 0) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  const signedReceipt = JSON.stringify(receipt);
  if (Buffer.byteLength(signedReceipt, 'utf8') > COMPLETION_RECEIPT_SIGNED_MAX_BYTES) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  const signature = crypto
    .createHmac('sha256', secret)
    .update(COMPLETION_RECEIPT_HMAC_DOMAIN, 'utf8')
    .update(signedReceipt, 'utf8')
    .digest('hex');
  return {
    algorithm: COMPLETION_RECEIPT_ALGORITHM,
    signed_receipt: signedReceipt,
    signature,
  };
}

function verifyCompletionReceiptEnvelope(envelope, secret) {
  assertExactObjectKeys(
    envelope,
    ['algorithm', 'signed_receipt', 'signature'],
    'R_COMPLETION_RECEIPT_INVALID'
  );
  if (
    envelope.algorithm !== COMPLETION_RECEIPT_ALGORITHM ||
    typeof envelope.signed_receipt !== 'string' ||
    Buffer.byteLength(envelope.signed_receipt, 'utf8') === 0 ||
    Buffer.byteLength(envelope.signed_receipt, 'utf8') > COMPLETION_RECEIPT_SIGNED_MAX_BYTES ||
    typeof envelope.signature !== 'string' ||
    !/^[0-9a-f]{64}$/.test(envelope.signature) ||
    typeof secret !== 'string' ||
    secret.length === 0
  ) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  const supplied = Buffer.from(envelope.signature, 'hex');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(COMPLETION_RECEIPT_HMAC_DOMAIN, 'utf8')
    .update(envelope.signed_receipt, 'utf8')
    .digest();
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  let receipt;
  try {
    receipt = JSON.parse(envelope.signed_receipt);
  } catch {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  if (!isPlainObject(receipt)) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  return receipt;
}

function buildCompletionReceiptBinding(job, operation, args = {}) {
  const jobType = job && job.jobType;
  const expectedOperation = COMPLETION_JOB_TO_R_OPERATION[jobType];
  if (!expectedOperation) return null;
  const operationSpec = R_BRIDGE_OPERATIONS[operation];
  if (operationSpec && operationSpec.auxiliary === true) return null;
  if (
    operation !== expectedOperation ||
    typeof job.id !== 'string' ||
    job.id === '' ||
    typeof job.projectId !== 'string' ||
    job.projectId === ''
  ) {
    throw codedError(
      'R_COMPLETION_RECEIPT_CONTEXT_REQUIRED',
      'Completion receipt context is invalid.'
    );
  }

  let outputStorageKey = null;
  let outputKind = null;
  let sourceCheckpointArtifactId = null;
  let targetAnalysisObjectId = null;
  if (jobType === 'pbmc.pipeline.v1') {
    outputStorageKey = args.pipeline && args.pipeline.checkpointStorageKey;
    outputKind = 'checkpoints';
  } else if (jobType === 'checkpoint.save.v1') {
    outputStorageKey = args.checkpointSave && args.checkpointSave.checkpointStorageKey;
    outputKind = 'checkpoints';
  } else if (jobType === 'seurat.pipeline.v1') {
    outputStorageKey = args.seuratPipeline && args.seuratPipeline.checkpointStorageKey;
    outputKind = 'checkpoints';
  } else if (jobType === 'seurat.multisample.v1') {
    outputStorageKey =
      args.multiSampleSeuratPipeline && args.multiSampleSeuratPipeline.checkpointStorageKey;
    outputKind = 'checkpoints';
  } else if (jobType === 'spatial.seurat.v1') {
    outputStorageKey = args.spatialPipeline && args.spatialPipeline.checkpointStorageKey;
    outputKind = 'checkpoints';
  } else if (jobType === 'deg.find_markers.v1') {
    outputStorageKey = args.deg && args.deg.resultStorageKey;
    outputKind = 'artifacts';
  } else if (jobType === 'enrichment.gsea.v1') {
    outputStorageKey = args.enrichment && args.enrichment.resultStorageKey;
    outputKind = 'artifacts';
  } else if (jobType === 'cellchat.infer.v1') {
    outputStorageKey = args.cellChat && args.cellChat.resultStorageKey;
    outputKind = 'artifacts';
  } else if (jobType === 'condition.pseudobulk_de.v1') {
    outputStorageKey = args.conditionComparison && args.conditionComparison.resultStorageKey;
    outputKind = 'artifacts';
  } else {
    sourceCheckpointArtifactId = args.checkpoint && args.checkpoint.checkpointArtifactId;
    targetAnalysisObjectId = args.objectContext && args.objectContext.objectId;
  }
  if (
    outputKind &&
    !storage.isProjectStorageKey(outputStorageKey, {
      projectId: job.projectId,
      kind: outputKind,
    })
  ) {
    throw codedError(
      'R_COMPLETION_RECEIPT_CONTEXT_REQUIRED',
      'Completion receipt context is invalid.'
    );
  }
  if (
    (jobType === 'checkpoint.load.v1' || jobType === 'checkpoint.fork.v1') &&
    (typeof sourceCheckpointArtifactId !== 'string' ||
      sourceCheckpointArtifactId === '' ||
      typeof targetAnalysisObjectId !== 'string' ||
      targetAnalysisObjectId === '')
  ) {
    throw codedError(
      'R_COMPLETION_RECEIPT_CONTEXT_REQUIRED',
      'Completion receipt context is invalid.'
    );
  }

  return {
    version: storage.COMPLETION_RECEIPT_VERSION,
    job_id: job.id,
    job_type: jobType,
    r_operation: operation,
    project_id: job.projectId,
    receipt_storage_key: storage.completionReceiptKey(job.projectId, job.id),
    source_analysis_object_id: job.analysisObjectId || null,
    source_dataset_id: job.datasetId || null,
    source_checkpoint_artifact_id: sourceCheckpointArtifactId,
    target_analysis_object_id: targetAnalysisObjectId,
    output_storage_key: outputStorageKey,
  };
}

function validateBoundedReceiptValue(value, depth = 0, state = { nodes: 0 }) {
  state.nodes += 1;
  if (depth > 7 || state.nodes > 6000) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    return;
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 160 || !/^[A-Za-z0-9 ._:+-]*$/.test(value)) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    for (const item of value) validateBoundedReceiptValue(item, depth + 1, state);
    return;
  }
  if (!isPlainObject(value) || Object.keys(value).length > 64) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  for (const [key, child] of Object.entries(value)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    validateBoundedReceiptValue(child, depth + 1, state);
  }
}

function validateReceiptPayloadSchema(jobType, payload) {
  validateBoundedReceiptValue(payload);
  if (
    [
      'pbmc.pipeline.v1',
      'seurat.pipeline.v1',
      'seurat.multisample.v1',
      'spatial.seurat.v1',
      'checkpoint.save.v1',
    ].includes(jobType)
  ) {
    const topKeys = ['seurat.pipeline.v1', 'seurat.multisample.v1', 'spatial.seurat.v1'].includes(
      jobType
    )
      ? ['ok', 'summary', 'checkpoint', 'versions', 'warnings']
      : ['ok', 'summary', 'checkpoint', 'versions'];
    assertExactObjectKeys(payload, topKeys);
    if (payload.ok !== true)
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    assertAllowedObjectKeys(
      payload.summary,
      [
        'n_cells',
        'n_features',
        'pre_filter_cells',
        'post_filter_cells',
        'percent_mt_available',
        'n_variable_features',
        'n_pcs',
        'n_clusters',
        'cluster_sizes',
        'reductions',
        'normalization_method',
        'resolution',
        'used_seed',
        'assays',
        'n_samples',
        'conditions',
        'samples_per_condition',
      ],
      ['n_cells', 'n_features']
    );
    assertExactObjectKeys(payload.checkpoint, ['saved', 'checksum_sha256', 'size_bytes']);
    assertExactObjectKeys(payload.versions, ['seurat_version', 'r_version']);
    if (
      ['seurat.pipeline.v1', 'seurat.multisample.v1', 'spatial.seurat.v1'].includes(jobType) &&
      !Array.isArray(payload.warnings)
    ) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    if (jobType === 'seurat.multisample.v1') {
      if (
        !Array.isArray(payload.summary.conditions) ||
        !Array.isArray(payload.summary.samples_per_condition)
      ) {
        throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
      }
      for (const row of payload.summary.samples_per_condition) {
        assertExactObjectKeys(row, ['condition', 'n']);
      }
    }
    return;
  }
  if (jobType === 'deg.find_markers.v1') {
    assertExactObjectKeys(payload, ['ok', 'summary', 'result', 'versions']);
    if (payload.ok !== true)
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    assertExactObjectKeys(payload.summary, [
      'group_by',
      'test_use',
      'assay',
      'n_groups',
      'groups',
      'n_markers_total',
      'markers_per_group',
      'top_markers',
    ]);
    assertExactObjectKeys(payload.result, ['saved', 'checksum_sha256', 'size_bytes', 'n_rows']);
    assertExactObjectKeys(payload.versions, ['seurat_version', 'r_version']);
    if (
      !Array.isArray(payload.summary.groups) ||
      !Array.isArray(payload.summary.markers_per_group) ||
      !Array.isArray(payload.summary.top_markers)
    ) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    for (const row of payload.summary.markers_per_group) assertExactObjectKeys(row, ['group', 'n']);
    for (const row of payload.summary.top_markers) {
      assertExactObjectKeys(row, [
        'group',
        'gene',
        'avg_log2FC',
        'pct_1',
        'pct_2',
        'p_val_adj',
        'rank',
      ]);
    }
    return;
  }
  if (jobType === 'enrichment.gsea.v1') {
    assertExactObjectKeys(payload, ['ok', 'summary', 'result']);
    if (payload.ok !== true) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    assertExactObjectKeys(payload.summary, [
      'method',
      'comparison',
      'group_by',
      'assay',
      'species',
      'gene_set_collection',
      'rank_metric',
      'input_gene_count',
      'mapped_gene_count',
      'mapping_rate',
      'tested_pathway_count',
      'significant_pathway_count',
      'package_versions',
      'top_pathways',
      'warnings',
    ]);
    assertExactObjectKeys(payload.summary.comparison, ['target_group', 'reference']);
    assertExactObjectKeys(payload.summary.package_versions, [
      'r',
      'seurat',
      'annotation_dbi',
      'go_db',
      'cluster_profiler',
      'fgsea',
      'organism_db',
    ]);
    assertExactObjectKeys(payload.result, ['saved', 'checksum_sha256', 'size_bytes', 'n_rows']);
    if (
      !Array.isArray(payload.summary.top_pathways) ||
      !Array.isArray(payload.summary.warnings) ||
      payload.summary.top_pathways.length > 25
    ) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    for (const row of payload.summary.top_pathways) {
      assertExactObjectKeys(row, [
        'pathway_id',
        'pathway_name',
        'normalized_enrichment_score',
        'p_value',
        'adjusted_p_value',
        'set_size',
        'significant',
        'direction',
      ]);
    }
    return;
  }
  if (jobType === 'cellchat.infer.v1') {
    assertExactObjectKeys(payload, ['ok', 'summary', 'result']);
    if (payload.ok !== true) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    assertExactObjectKeys(payload.summary, [
      'method',
      'analysis_intent',
      'group_by',
      'assay',
      'species',
      'database_category',
      'p_value_cutoff',
      'input_cell_count',
      'analyzed_cell_count',
      'input_group_count',
      'analyzed_group_count',
      'excluded_group_count',
      'candidate_interaction_count',
      'retained_interaction_count',
      'retained_pathway_count',
      'groups',
      'excluded_groups',
      'package_versions',
      'top_interactions',
      'top_pathways',
      'warnings',
    ]);
    assertExactObjectKeys(payload.summary.package_versions, [
      'r',
      'seurat',
      'cellchat',
      'cellchat_db',
    ]);
    assertExactObjectKeys(payload.result, ['saved', 'checksum_sha256', 'size_bytes', 'n_rows']);
    if (
      !Array.isArray(payload.summary.groups) ||
      !Array.isArray(payload.summary.excluded_groups) ||
      !Array.isArray(payload.summary.top_interactions) ||
      !Array.isArray(payload.summary.top_pathways) ||
      !Array.isArray(payload.summary.warnings) ||
      payload.summary.groups.length > 64 ||
      payload.summary.excluded_groups.length > 64 ||
      payload.summary.top_interactions.length > 100 ||
      payload.summary.top_pathways.length > 100 ||
      payload.summary.warnings.length > 32
    ) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    for (const row of payload.summary.groups) {
      assertExactObjectKeys(row, ['group', 'input_cells', 'analyzed_cells']);
    }
    for (const row of payload.summary.excluded_groups) {
      assertExactObjectKeys(row, ['group', 'input_cells', 'reason']);
    }
    for (const row of payload.summary.top_interactions) {
      assertExactObjectKeys(row, [
        'source',
        'target',
        'interaction',
        'pathway',
        'probability',
        'p_value',
        'category',
      ]);
    }
    for (const row of payload.summary.top_pathways) {
      assertExactObjectKeys(row, ['source', 'target', 'pathway', 'probability', 'p_value']);
    }
    return;
  }
  if (jobType === 'condition.pseudobulk_de.v1') {
    assertExactObjectKeys(payload, ['ok', 'summary', 'result']);
    if (payload.ok !== true)
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    assertExactObjectKeys(payload.summary, [
      'method',
      'cell_type_column',
      'unit_of_replication',
      'paired',
      'model_formula',
      'sample_count',
      'tested_cell_type_count',
      'tested_gene_count',
      'significant_result_count',
      'skipped_cell_types',
      'top_results',
      'package_versions',
      'warnings',
    ]);
    assertExactObjectKeys(payload.summary.package_versions, ['r', 'seurat', 'edger', 'limma']);
    assertExactObjectKeys(payload.result, ['saved', 'checksum_sha256', 'size_bytes', 'n_rows']);
    if (
      !Array.isArray(payload.summary.skipped_cell_types) ||
      !Array.isArray(payload.summary.top_results) ||
      !Array.isArray(payload.summary.warnings) ||
      payload.summary.top_results.length > 50
    ) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    for (const row of payload.summary.top_results) {
      assertExactObjectKeys(row, ['cell_type', 'gene', 'log_fc', 'p_value', 'fdr']);
    }
    return;
  }
  assertExactObjectKeys(payload, [
    'loaded',
    'runtime_instance_id',
    'checksum_verified',
    'class',
    'n_cells',
    'n_features',
    'assays',
    'reductions',
    'n_meta_fields',
    'meta_fields',
    'seurat_version',
    'r_version',
  ]);
  if (payload.loaded !== true || payload.checksum_verified !== true) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  if (
    !Array.isArray(payload.assays) ||
    !Array.isArray(payload.reductions) ||
    !Array.isArray(payload.meta_fields) ||
    typeof payload.runtime_instance_id !== 'string' ||
    payload.runtime_instance_id.length === 0
  ) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
}

function descriptorFromCompletionReceipt(job, receipt, expected = {}) {
  assertExactObjectKeys(receipt, COMPLETION_RECEIPT_KEYS);
  const jobType = job && job.jobType;
  const rOperation = COMPLETION_JOB_TO_R_OPERATION[jobType];
  const receiptKey = storage.completionReceiptKey(job.projectId, job.id);
  const parsedReceiptKey = storage.parseProjectStorageKey(receipt.receipt_storage_key);
  const commonMatches =
    receipt.version === storage.COMPLETION_RECEIPT_VERSION &&
    receipt.job_id === job.id &&
    receipt.job_type === jobType &&
    receipt.r_operation === rOperation &&
    receipt.project_id === job.projectId &&
    receipt.receipt_storage_key === receiptKey &&
    parsedReceiptKey &&
    parsedReceiptKey.projectId === job.projectId &&
    parsedReceiptKey.kind === 'artifacts' &&
    parsedReceiptKey.resourceId === job.id &&
    receipt.source_analysis_object_id === (job.analysisObjectId || null) &&
    receipt.source_dataset_id === (job.datasetId || null) &&
    receipt.source_checkpoint_artifact_id === (expected.sourceCheckpointArtifactId || null) &&
    receipt.target_analysis_object_id === (expected.targetAnalysisObjectId || null) &&
    receipt.output_storage_key === (expected.outputStorageKey || null);
  if (!commonMatches) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  validateReceiptPayloadSchema(jobType, receipt.payload);
  const body = receipt.payload;
  const spec = R_BRIDGE_OPERATIONS[rOperation];
  if (
    [
      'pbmc.pipeline.v1',
      'seurat.pipeline.v1',
      'seurat.multisample.v1',
      'spatial.seurat.v1',
      'checkpoint.save.v1',
    ].includes(jobType)
  ) {
    const summary = sanitizePipelineSummary(body);
    const checkpoint = sanitizeCheckpointInfo(body);
    if (!checkpoint.saved || !checkpoint.checksumSha256 || checkpoint.sizeBytes === null) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    return {
      operation: rOperation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      resultObjectType: 'seurat',
      summary,
      checkpoint,
      metadata: {
        operation: rOperation,
        kind: 'pipeline',
        scientific_output: true,
        ranAt: new Date().toISOString(),
        ...(job.analysisObjectId ? { objectId: job.analysisObjectId } : {}),
        summary,
        ...(['seurat.pipeline.v1', 'seurat.multisample.v1', 'spatial.seurat.v1'].includes(jobType)
          ? { warnings: sanitizeNameList(body.warnings, 32, 160) }
          : {}),
      },
    };
  }
  if (jobType === 'enrichment.gsea.v1') {
    const summary = sanitizeEnrichmentSummary(body);
    const result = sanitizeEnrichmentResultInfo(body);
    if (
      !result.saved ||
      !result.checksumSha256 ||
      result.sizeBytes === null ||
      result.nRows === null
    ) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    return {
      operation: rOperation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      objectId: job.analysisObjectId,
      summary,
      result,
      metadata: {
        operation: rOperation,
        kind: 'enrichment_summary',
        scientific_output: true,
        downloadable: false,
        ranAt: new Date().toISOString(),
        objectId: job.analysisObjectId,
        summary,
      },
    };
  }
  if (jobType === 'cellchat.infer.v1') {
    const summary = sanitizeCellChatSummary(body);
    const result = sanitizeCellChatResultInfo(body);
    if (
      !isCompleteCellChatSummary(summary) ||
      !result.saved ||
      !result.checksumSha256 ||
      result.sizeBytes === null ||
      result.nRows === null
    ) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    return {
      operation: rOperation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      objectId: job.analysisObjectId,
      summary,
      result,
      metadata: {
        operation: rOperation,
        kind: 'cellchat_summary',
        scientific_output: true,
        downloadable: false,
        ranAt: new Date().toISOString(),
        objectId: job.analysisObjectId,
        summary,
      },
    };
  }
  if (jobType === 'condition.pseudobulk_de.v1') {
    const summary = sanitizeConditionComparisonSummary(body);
    const result = sanitizeEnrichmentResultInfo(body);
    if (
      !result.saved ||
      !result.checksumSha256 ||
      result.sizeBytes === null ||
      result.nRows === null
    ) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    return {
      operation: rOperation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      objectId: job.analysisObjectId,
      summary,
      result,
      metadata: {
        operation: rOperation,
        kind: 'condition_de_summary',
        scientific_output: true,
        downloadable: false,
        ranAt: new Date().toISOString(),
        objectId: job.analysisObjectId,
        summary,
      },
    };
  }
  if (jobType === 'deg.find_markers.v1') {
    const summary = sanitizeDegSummary(body);
    const result = sanitizeDegResultInfo(body);
    if (
      !result.saved ||
      !result.checksumSha256 ||
      result.sizeBytes === null ||
      result.nRows === null
    ) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    return {
      operation: rOperation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      objectId: job.analysisObjectId,
      summary,
      result,
      metadata: {
        operation: rOperation,
        kind: 'deg_summary',
        scientific_output: true,
        downloadable: false,
        ranAt: new Date().toISOString(),
        objectId: job.analysisObjectId,
        summary,
      },
    };
  }
  const loaded = sanitizeLoadSummary(body);
  if (!loaded.loaded || !loaded.checksumVerified || !loaded.runtimeInstanceHash) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  return {
    operation: rOperation,
    artifactType: spec.artifactType,
    storageKind: 'metadata_only',
    name: spec.artifactName,
    description: spec.artifactDescription,
    objectId: expected.targetAnalysisObjectId,
    loaded,
    metadata: {
      operation: rOperation,
      kind: 'checkpoint_load',
      scientific_output: false,
      live_state_mutation: true,
      loadedAt: new Date().toISOString(),
      objectId: expected.targetAnalysisObjectId,
      loaded,
    },
  };
}

module.exports = {
  isPlainObject,
  createCompletionReceiptEnvelope,
  verifyCompletionReceiptEnvelope,
  buildCompletionReceiptBinding,
  descriptorFromCompletionReceipt,
};
