// Allowed R request targets and the artifacts each operation produces.

const R_BRIDGE_OPERATIONS = Object.freeze({
  'r.runtime.check': Object.freeze({
    method: 'GET',
    path: '/health',
    artifactType: 'r_runtime_check',
    artifactName: 'R runtime check',
    artifactDescription:
      'Operational R runtime connectivity/health check. Metadata only — not a scientific result, no analysis-object data.',
    touchesAnalysisObject: false,
    requiresObjectContext: false,
    readOnly: true,
  }),
  // Read-only inspection of ONE existing live analysis object. The object is
  // addressed by a SERVER-DERIVED state key (X-Object-ID) supplied via
  // `objectContext`; it reads a sanitized summary only and mutates nothing. The
  // worker handler verifies live-R object ownership BEFORE this runs, so project
  // membership alone never reaches another user's live object.
  'r.object.inspect': Object.freeze({
    method: 'GET',
    path: '/object/inspect',
    artifactType: 'r_object_inspection',
    artifactName: 'R object inspection',
    artifactDescription:
      'Read-only inspection of a live analysis object. Metadata only — a sanitized object summary ' +
      '(class, dimensions, assay/reduction/metadata-field names, runtime versions). Not a scientific ' +
      'result: no expression matrices, cell/gene data, embeddings, or serialized object contents.',
    touchesAnalysisObject: true,
    requiresObjectContext: true,
    readOnly: true,
  }),
  // The first MUTATING bridge operation: run the existing PBMC/Seurat preprocessing
  // pipeline on a COPY of one live analysis object (the parent is never mutated) and
  // persist a durable checkpoint RDS to a SERVER-allocated internal vault key. The
  // request method/path are fixed; the X-Object-ID (parent) is server-derived; the
  // body is reconstructed by the bridge from ONLY the allowlisted, server-validated
  // params + the server-allocated checkpoint key (`carriesParams`). It returns a
  // sanitized, bounded summary — never matrices/cells/genes/embeddings. The worker
  // handler validates params + ownership BEFORE this runs; there is NO arbitrary R.
  'r.pbmc.pipeline.v1': Object.freeze({
    method: 'POST',
    path: '/object/pbmc-pipeline',
    artifactType: 'pipeline_summary',
    artifactName: 'PBMC pipeline summary',
    artifactDescription:
      'Sanitized summary of a PBMC/Seurat preprocessing run (normalize → variable features → scale → ' +
      'PCA → neighbors → clusters → UMAP) executed on a copy of the input object. Bounded counts, ' +
      'reduction names, resolved parameters, and runtime versions only — no expression matrices, ' +
      'cell/gene tables, embeddings, paths, or state keys.',
    touchesAnalysisObject: true,
    requiresObjectContext: true,
    carriesParams: true,
    mutating: true,
    readOnly: false,
    // Pipeline runs are far longer than a health/inspect call — explicit but bounded
    // so a hung R run can never wedge a worker indefinitely.
    defaultTimeoutMs: 120000,
  }),
  // Checkpoint load / reattach: load a COMPLETED durable internal checkpoint RDS back
  // into the OWNER's private live R session under the canonical object key, so later
  // jobs can use it as live input. The request method/path are fixed; the X-Object-ID
  // (the owner's canonical object key) is server-derived; the body is reconstructed by
  // the bridge from ONLY the SERVER-selected checkpoint coordinates (`carriesCheckpoint`)
  // — the internal storage key + expected checksum/size, never any client input. It
  // mutates ONLY the target live object key and returns a sanitized, bounded summary
  // (never matrices/cells/genes/embeddings/path/state-key). The worker handler verifies
  // OWNERSHIP + selects the checkpoint BEFORE this runs; there is NO arbitrary R/path.
  'r.checkpoint.load.v1': Object.freeze({
    method: 'POST',
    path: '/object/checkpoint-load',
    artifactType: 'checkpoint_load',
    artifactName: 'Checkpoint load summary',
    artifactDescription:
      "Sanitized summary of loading a durable internal checkpoint back into the owner's private live R " +
      'session (reattach). Bounded object summary (class, dimensions, assay/reduction/metadata-field ' +
      'names), checksum-verification flag, and runtime versions only — no expression matrices, ' +
      'cell/gene tables, embeddings, storage path/key, or R state key.',
    touchesAnalysisObject: true,
    requiresObjectContext: true,
    carriesCheckpoint: true,
    mutating: true,
    readOnly: false,
    // A checkpoint load reads + deserializes an RDS bundle and rebuilds the live object;
    // explicit but bounded so a hung load can never wedge a worker indefinitely.
    defaultTimeoutMs: 120000,
  }),
  // DEG / marker finding: run the existing FindAllMarkers path over ONE existing live
  // analysis object (the OWNER's, addressed by a SERVER-DERIVED X-Object-ID) and write the
  // full marker table to a SERVER-allocated internal vault key. DEG is an OUTPUT-producing
  // analysis, NOT a mutating transformation: it does NOT mutate the live object (any
  // temporary identity change is restored R-side) and creates NO new object. The request
  // method/path are fixed; the body is reconstructed by the bridge from ONLY the allowlisted,
  // server-validated params + the server-allocated result key (`carriesDegParams`). It returns
  // a sanitized, bounded marker SUMMARY (group counts, per-group counts, top-N preview with
  // safe columns) + the result-file integrity (saved/checksum/size) — never raw expression
  // matrices, cell metadata, embeddings, the storage path/key, or the R state key. The worker
  // handler verifies OWNERSHIP + validates params BEFORE this runs; there is NO arbitrary R.
  'r.deg.find_markers.v1': Object.freeze({
    method: 'POST',
    path: '/object/deg-find-markers',
    artifactType: 'deg_summary',
    artifactName: 'DEG marker summary',
    artifactDescription:
      'Sanitized, bounded summary of a DEG / FindAllMarkers run over an existing analysis object: ' +
      'resolved parameters, groups/clusters detected, total marker count + per-group counts, and a ' +
      'bounded top-N-per-group preview with safe columns only (group, gene, avg_log2FC, pct.1, pct.2, ' +
      'adjusted p-value, rank) plus runtime versions. No expression matrices, cell/gene tables, ' +
      'embeddings, storage path/key, or R state key.',
    touchesAnalysisObject: true,
    requiresObjectContext: true,
    carriesDegParams: true,
    // DEG does NOT mutate the live object (idents restored R-side); it only reads the object
    // and writes a separate output file. Marked non-mutating so the live-state invariant is
    // explicit and asserted in tests.
    mutating: false,
    readOnly: false,
    // FindAllMarkers over many clusters can run long; explicit but bounded so a hung run can
    // never wedge a worker indefinitely.
    defaultTimeoutMs: 120000,
  }),
  // Snapshot the owner-verified current live object without accepting code,
  // paths, or transformation parameters. The worker allocates the exact output
  // key and publishes the immutable child/checkpoint records only after R has
  // atomically saved the bundle.
  'r.checkpoint.save.v1': Object.freeze({
    method: 'POST',
    path: '/object/checkpoint-save',
    artifactType: 'checkpoint_save',
    artifactName: 'Saved analysis summary',
    artifactDescription:
      "Sanitized summary of an explicit durable save of the owner's current private analysis state. " +
      'No expression matrix, cell-level table, storage path, or live-state key is exposed.',
    touchesAnalysisObject: true,
    requiresObjectContext: true,
    carriesCheckpointSave: true,
    mutating: true,
    readOnly: false,
    defaultTimeoutMs: 120000,
  }),
  // Idempotent job-scoped hydration for isolated compute runtimes. Unlike the
  // user-visible checkpoint-load job, this auxiliary operation does not publish
  // a completion receipt or durable artifact; it only prepares a private runtime
  // immediately before an allowlisted analysis.
  'r.checkpoint.hydrate.v1': Object.freeze({
    method: 'POST',
    path: '/object/checkpoint-load',
    artifactType: 'checkpoint_load',
    artifactName: 'Private compute hydration',
    artifactDescription: 'Private job-scoped checkpoint hydration for isolated compute.',
    touchesAnalysisObject: true,
    requiresObjectContext: true,
    carriesCheckpoint: true,
    auxiliary: true,
    mutating: true,
    readOnly: false,
    defaultTimeoutMs: 120000,
  }),
  // Ranked GO enrichment for one selected identity versus all remaining cells. The
  // worker owns the object context, validated scientific parameters, and output key;
  // the browser cannot choose an R function, endpoint, path, or live-state key.
  'r.enrichment.gsea.v1': Object.freeze({
    method: 'POST',
    path: '/object/enrichment-gsea',
    artifactType: 'enrichment_summary',
    artifactName: 'Ranked pathway-enrichment summary',
    artifactDescription:
      'Sanitized, bounded summary of a cluster-versus-rest ranked Gene Ontology Biological Process enrichment run. ' +
      'The complete pathway table remains in private project storage; no expression matrix, cell-level data, ' +
      'storage key, R state key, or public download is included.',
    touchesAnalysisObject: true,
    requiresObjectContext: true,
    carriesEnrichmentParams: true,
    mutating: false,
    readOnly: false,
    defaultTimeoutMs: 300000,
  }),
  // Cell-cell communication inference is a fixed, single-context CellChat v2
  // workflow. It only reads the owner-verified object, samples cells under
  // server-enforced caps, writes a private candidate table, and returns a
  // bounded summary. It is deliberately not a cross-condition comparison or
  // an arbitrary metadata/code execution surface.
  'r.cellchat.infer.v1': Object.freeze({
    method: 'POST',
    path: '/object/cellchat-infer',
    artifactType: 'cellchat_summary',
    artifactName: 'Cell-cell communication summary',
    artifactDescription:
      'Sanitized, bounded summary of predicted ligand-receptor signaling candidates from one selected biological context. ' +
      'The complete candidate table remains in private project storage; no expression matrix, cell-level data, storage key, ' +
      'R state key, causal claim, or public download is included.',
    touchesAnalysisObject: true,
    requiresObjectContext: true,
    carriesCellChatParams: true,
    mutating: false,
    readOnly: false,
    defaultTimeoutMs: 600000,
  }),
  'r.explore.summarize.v1': Object.freeze({
    method: 'POST',
    path: '/object/explore-summary',
    artifactType: 'exploration_summary',
    artifactName: 'Exploratory analysis summary',
    artifactDescription:
      'Bounded aggregate exploratory-analysis output from a reviewed recipe. No raw matrix, cell table, code, path, or state key.',
    touchesAnalysisObject: true,
    requiresObjectContext: true,
    carriesExplorationParams: true,
    mutating: false,
    readOnly: true,
    defaultTimeoutMs: 120000,
  }),
  'r.condition.pseudobulk_de.v1': Object.freeze({
    method: 'POST',
    path: '/object/condition-pseudobulk-de',
    artifactType: 'condition_de_summary',
    artifactName: 'Replicate-aware condition comparison',
    artifactDescription:
      'Sanitized summary of an edgeR pseudobulk condition comparison. The complete table remains in private project storage.',
    touchesAnalysisObject: true,
    requiresObjectContext: true,
    carriesConditionComparison: true,
    mutating: false,
    readOnly: false,
    defaultTimeoutMs: 600000,
  }),
  // Dataset-backed Seurat pipeline: load one server-resolved 10x HDF5 dataset,
  // create a Seurat object, run QC/preprocessing/clustering/UMAP, and save a
  // server-allocated checkpoint. Dataset and checkpoint storage keys are rebuilt
  // from trusted worker inputs only; clients cannot choose a path or R function.
  'r.seurat.pipeline.v1': Object.freeze({
    method: 'POST',
    path: '/object/seurat-pipeline',
    artifactType: 'pipeline_summary',
    artifactName: 'Seurat pipeline summary',
    artifactDescription:
      'Sanitized summary of a dataset-backed Seurat preprocessing run over one uploaded 10x HDF5 dataset. ' +
      'Bounded counts, reduction names, resolved parameters, warnings, and runtime versions only - no ' +
      'expression matrices, cell/gene tables, embeddings, paths, or state keys.',
    touchesAnalysisObject: false,
    requiresObjectContext: false,
    carriesSeuratDatasetParams: true,
    mutating: true,
    readOnly: false,
    // A normal PBMC3K preprocessing run can exceed two minutes on the bounded
    // deployment CPUs. Keep the deadline explicit and finite, but give this
    // full-pipeline operation the same ten-minute ceiling as the other heavy
    // scientific operations so successful work does not enter receipt recovery.
    defaultTimeoutMs: 600000,
  }),
  'r.seurat.multisample.v1': Object.freeze({
    method: 'POST',
    path: '/object/seurat-pipeline',
    artifactType: 'pipeline_summary',
    artifactName: 'Multi-sample Seurat pipeline summary',
    artifactDescription:
      'Sanitized summary of a reviewed multi-sample Seurat preprocessing run over server-selected 10x HDF5 datasets. ' +
      'Bounded counts, sample and condition names, resolved parameters, warnings, and runtime versions only.',
    touchesAnalysisObject: false,
    requiresObjectContext: false,
    carriesMultiSampleSeuratParams: true,
    mutating: true,
    readOnly: false,
    defaultTimeoutMs: 600000,
  }),
  'r.spatial.seurat.v1': Object.freeze({
    method: 'POST',
    path: '/object/spatial-seurat-pipeline',
    artifactType: 'pipeline_summary',
    artifactName: 'Spatial Seurat pipeline summary',
    artifactDescription:
      'Sanitized summary of a classic 10x Visium Space Ranger bundle loaded with Seurat. ' +
      'The durable checkpoint retains the spatial assay, tissue image, and spot coordinates; ' +
      'public metadata contains only bounded counts, reductions, parameters, and warnings.',
    touchesAnalysisObject: false,
    requiresObjectContext: false,
    carriesSpatialDatasetParams: true,
    mutating: true,
    readOnly: false,
    defaultTimeoutMs: 600000,
  }),
});

const R_BRIDGE_ALLOWED_TARGETS = Object.freeze(
  new Set(Object.values(R_BRIDGE_OPERATIONS).map((s) => `${s.method} ${s.path}`))
);

function isAllowedRBridgeOperation(operation) {
  return (
    typeof operation === 'string' &&
    Object.prototype.hasOwnProperty.call(R_BRIDGE_OPERATIONS, operation)
  );
}

function isAllowedRBridgeTarget(method, path) {
  return R_BRIDGE_ALLOWED_TARGETS.has(`${method} ${path}`);
}

module.exports = {
  R_BRIDGE_OPERATIONS,
  R_BRIDGE_ALLOWED_TARGETS,
  isAllowedRBridgeOperation,
  isAllowedRBridgeTarget,
};
