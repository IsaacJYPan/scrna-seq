#!/usr/bin/env Rscript
# Real-R smoke for the narrow durable CellChat v1 helper. This exercise is
# self-contained: it builds a synthetic normalized Seurat object with opaque-unsafe
# input group names, runs the fixed CellChat analysis, then validates its bounded
# private table, public receipt summary, atomic storage output, and non-mutation
# guarantees. It makes no network calls.

required <- c("Seurat", "dplyr", "Matrix", "ggplot2", "CellChat", "NMF", "digest", "jsonlite")
missing <- required[!vapply(required, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing) > 0L) {
  cat("SKIP: CellChat inference smoke dependencies are not installed: ",
      paste(missing, collapse = ", "), "\n", sep = "")
  quit(status = 0L)
}

suppressPackageStartupMessages({
  library(Seurat)
  library(CellChat)
})

workspace <- normalizePath(getwd(), winslash = "/", mustWork = TRUE)
plumber_file <- file.path(workspace, "r-backend", "plumber.R")
if (!file.exists(plumber_file)) stop("Run this script from the repository root.")
plumber_env <- new.env(parent = globalenv())
sys.source(plumber_file, envir = plumber_env)

failures <- 0L
check <- function(label, value) {
  if (isTRUE(value)) {
    cat("PASS ", label, "\n", sep = "")
  } else {
    cat("FAIL ", label, "\n", sep = "")
    failures <<- failures + 1L
  }
}
expect_error <- function(expr) {
  failed <- FALSE
  tryCatch(force(expr), error = function(e) failed <<- TRUE)
  failed
}
all_summary_strings_safe <- function(value) {
  if (is.null(value)) return(TRUE)
  if (is.list(value)) return(all(vapply(value, all_summary_strings_safe, logical(1))))
  if (is.character(value)) return(all(grepl("^[A-Za-z0-9 ._:+-]*$", value)))
  TRUE
}

set.seed(17)
# Include unrelated RNA features as a regression guard: the durable helper must
# select CellChatDB signaling genes before extracting its worker matrix, rather
# than cloning/materializing every feature in the source Seurat object.
genes <- unique(c(
  CellChat::extractGene(CellChat::CellChatDB.human), "ACTB", "GAPDH",
  paste0("NON_SIGNAL_", seq_len(250L))
))
n_primary <- 500L
n_low <- 5L
n_cells <- (2L * n_primary) + n_low
counts <- matrix(
  stats::rpois(length(genes) * n_cells, lambda = 1),
  nrow = length(genes), ncol = n_cells,
  dimnames = list(genes, paste0("cell_", seq_len(n_cells)))
)
ligands <- match(c("TGFB1", "TGFB2", "TGFB3"), genes)
receptors <- match(c("TGFBR1", "TGFBR2", "ACVR1B"), genes)
counts[ligands, seq_len(n_primary)] <- counts[ligands, seq_len(n_primary)] + 10L
counts[receptors, n_primary + seq_len(n_primary)] <-
  counts[receptors, n_primary + seq_len(n_primary)] + 10L
obj <- Seurat::CreateSeuratObject(counts = counts, min.cells = 0, min.features = 0)
obj <- Seurat::NormalizeData(obj, verbose = FALSE)
obj$seurat_clusters <- factor(c(
  rep("unsafe/group-A", n_primary),
  rep("unsafe/group-B", n_primary),
  rep("unsafe/group-C", n_low)
))

assay_before <- Seurat::DefaultAssay(obj)
idents_before <- as.character(Seurat::Idents(obj))
metadata_before <- obj@meta.data

valid_raw_params <- list(
  groupBy = "seurat_clusters",
  assay = "RNA",
  species = "human",
  databaseCategory = "secreted_signaling",
  analysisIntent = "single_context",
  minCellsPerGroup = 10L,
  maxCellsPerGroup = 500L,
  maxTotalCells = 1000L,
  pValueCutoff = 0.1,
  topInteractions = 5L,
  topPathways = 5L,
  randomSeed = 17L
)
params <- plumber_env$normalize_cellchat_inference_params(valid_raw_params)
check("the strict parameter allowlist rejects unknown fields", expect_error(
  plumber_env$normalize_cellchat_inference_params(c(valid_raw_params, list(extra = "no")))
))
bad_assay <- valid_raw_params
bad_assay$assay <- "SCT"
check("the fixed RNA assay rejects alternate assays", expect_error(
  plumber_env$normalize_cellchat_inference_params(bad_assay)
))

# CellChat's public helper currently reshapes its full network. Compare the
# bounded extractor with CellChat's own internal implementation on a small,
# deterministic network before separately exercising a result larger than the
# durable CSV cap below. The equality case at the configured p-value boundary
# verifies the intentionally strict CellChat threshold semantics.
comparison_groups <- sprintf("Group_%03d", seq_len(2L))
comparison_pairs <- paste0("LR_", seq_len(4L))
comparison_prob <- array(
  0,
  dim = c(2L, 2L, 4L),
  dimnames = list(comparison_groups, comparison_groups, comparison_pairs)
)
comparison_pval <- array(
  1,
  dim = dim(comparison_prob),
  dimnames = dimnames(comparison_prob)
)
comparison_prob[1L, 1L, 1L] <- 0.9
comparison_pval[1L, 1L, 1L] <- 0.01
comparison_prob[2L, 1L, 1L] <- 0.7
comparison_pval[2L, 1L, 1L] <- params$p_value_cutoff
comparison_prob[1L, 2L, 2L] <- 0.8
comparison_pval[1L, 2L, 2L] <- 0.02
comparison_prob[2L, 2L, 3L] <- 0.6
comparison_pval[2L, 2L, 3L] <- 0.03
comparison_lr <- data.frame(
  interaction_name = comparison_pairs,
  pathway_name = c("Pathway A", "Pathway A", "Pathway B", "Pathway C"),
  ligand = paste0("L", seq_len(4L)),
  receptor = paste0("R", seq_len(4L)),
  annotation = rep("Secreted Signaling", 4L),
  stringsAsFactors = FALSE,
  row.names = comparison_pairs
)
comparison_arrays <- plumber_env$cellchat_inference_net_arrays(list(
  prob = comparison_prob,
  pval = comparison_pval
))
comparison_metadata <- plumber_env$cellchat_inference_pair_metadata(
  comparison_lr, comparison_arrays$pair_labels
)
comparison_display <- stats::setNames(
  sprintf("Group %d", seq_along(comparison_groups)), comparison_groups
)
comparison_interactions <- plumber_env$cellchat_inference_bounded_interaction_rows(
  comparison_arrays, comparison_metadata, params, comparison_display, limit = 100L
)
comparison_pathways <- plumber_env$cellchat_inference_bounded_pathway_rows(
  comparison_arrays, comparison_metadata, params, comparison_display, limit = 100L
)
cellchat_subset_internal <- getFromNamespace("subsetCommunication_internal", "CellChat")
expected_interactions <- cellchat_subset_internal(
  list(prob = comparison_prob, pval = comparison_pval),
  comparison_lr,
  comparison_groups,
  thresh = params$p_value_cutoff
)
expected_pathways <- cellchat_subset_internal(
  list(prob = comparison_prob, pval = comparison_pval),
  comparison_lr,
  comparison_groups,
  slot.name = "netP",
  thresh = params$p_value_cutoff
)
comparison_interaction_columns <- c(
  "source", "target", "interaction_name", "pathway_name", "ligand", "receptor",
  "annotation", "prob", "pval"
)
comparison_pathway_columns <- c("source", "target", "pathway_name", "prob", "pval")
comparison_interaction_order <- function(frame) {
  ordered <- frame[, comparison_interaction_columns, drop = FALSE]
  ordered[] <- lapply(ordered, function(value) {
    if (is.factor(value)) as.character(value) else value
  })
  ordered[order(ordered$source, ordered$target, ordered$interaction_name), , drop = FALSE]
}
comparison_pathway_order <- function(frame) {
  ordered <- frame[, comparison_pathway_columns, drop = FALSE]
  ordered[] <- lapply(ordered, function(value) {
    if (is.factor(value)) as.character(value) else value
  })
  ordered[order(ordered$source, ordered$target, ordered$pathway_name), , drop = FALSE]
}
check("bounded interaction extraction matches CellChat thresholded rows and count",
      identical(comparison_interactions$candidate_count, nrow(expected_interactions)) &&
        isTRUE(all.equal(
          comparison_interaction_order(comparison_interactions$rows),
          comparison_interaction_order(expected_interactions),
          check.attributes = FALSE
        )))
check("bounded pathway extraction matches CellChat aggregation and count",
      identical(comparison_pathways$candidate_count, nrow(expected_pathways)) &&
        isTRUE(all.equal(
          comparison_pathway_order(comparison_pathways$rows),
          comparison_pathway_order(expected_pathways),
          check.attributes = FALSE
        )))

# This dense 32-group fixture has more candidate interactions than the durable
# CSV limit. The helper must count every candidate while retaining at most the
# configured cap and only a top-pathway preview, without constructing the full
# pair-level result data frame.
dense_group_count <- 32L
dense_pair_count <- 64L
dense_groups <- sprintf("Group_%03d", seq_len(dense_group_count))
dense_pairs <- sprintf("Dense_LR_%03d", seq_len(dense_pair_count))
dense_prob <- array(
  0.5,
  dim = c(dense_group_count, dense_group_count, dense_pair_count),
  dimnames = list(dense_groups, dense_groups, dense_pairs)
)
dense_pval <- array(
  0.01,
  dim = dim(dense_prob),
  dimnames = dimnames(dense_prob)
)
dense_lr <- data.frame(
  interaction_name = dense_pairs,
  pathway_name = paste0("Dense pathway ", rep(seq_len(4L), length.out = dense_pair_count)),
  ligand = paste0("Dense ligand ", seq_len(dense_pair_count)),
  receptor = paste0("Dense receptor ", seq_len(dense_pair_count)),
  annotation = rep("Secreted Signaling", dense_pair_count),
  stringsAsFactors = FALSE,
  row.names = dense_pairs
)
dense_arrays <- plumber_env$cellchat_inference_net_arrays(list(
  prob = dense_prob,
  pval = dense_pval
))
dense_metadata <- plumber_env$cellchat_inference_pair_metadata(dense_lr, dense_arrays$pair_labels)
dense_display <- stats::setNames(sprintf("Group %d", seq_len(dense_group_count)), dense_groups)
dense_interactions <- plumber_env$cellchat_inference_bounded_interaction_rows(
  dense_arrays,
  dense_metadata,
  params,
  dense_display,
  limit = plumber_env$CELLCHAT_INFERENCE_MAX_RESULT_ROWS
)
dense_pathways <- plumber_env$cellchat_inference_bounded_pathway_rows(
  dense_arrays,
  dense_metadata,
  params,
  dense_display,
  limit = params$top_pathways
)
dense_interaction_total <- dense_group_count * dense_group_count * dense_pair_count
dense_pathway_total <- dense_group_count * dense_group_count * 4L
check("bounded extraction counts a dense result while retaining only the private CSV cap",
      identical(dense_interactions$candidate_count, dense_interaction_total) &&
        nrow(dense_interactions$rows) == plumber_env$CELLCHAT_INFERENCE_MAX_RESULT_ROWS &&
        nrow(dense_interactions$rows) < dense_interactions$candidate_count)
check("bounded pathway extraction retains only the requested preview rows",
      identical(dense_pathways$candidate_count, dense_pathway_total) &&
        nrow(dense_pathways$rows) == params$top_pathways &&
        nrow(dense_pathways$rows) < dense_pathways$candidate_count)

# Exercise a real CellChat object as well as the deterministic array fixture.
# This is intentionally a small subset of the same synthetic Seurat source so
# the regression compares the exact v2 package API used by production without
# asking the test to materialize a large communication table.
equivalence_group_values <- as.character(obj$seurat_clusters)
names(equivalence_group_values) <- colnames(obj)
equivalence_raw_to_internal <- stats::setNames(
  c("Group_001", "Group_002"),
  c("unsafe/group-A", "unsafe/group-B")
)
equivalence_cells <- c(
  colnames(obj)[seq_len(12L)],
  colnames(obj)[n_primary + seq_len(12L)]
)
equivalence_database <- plumber_env$cellchat_inference_database(params)
equivalence_input <- plumber_env$cellchat_inference_prepare_input(
  obj,
  params$assay,
  equivalence_cells,
  equivalence_group_values,
  equivalence_raw_to_internal,
  unname(equivalence_raw_to_internal[c("unsafe/group-A", "unsafe/group-B")]),
  equivalence_database
)
equivalence_cellchat <- suppressWarnings(CellChat::createCellChat(
  object = equivalence_input$data,
  meta = equivalence_input$metadata,
  group.by = ".traceomics_cellchat_group",
  datatype = "RNA"
))
equivalence_cellchat@DB <- equivalence_database
equivalence_cellchat <- suppressWarnings(CellChat::subsetData(equivalence_cellchat))
equivalence_cellchat <- suppressWarnings(CellChat::identifyOverExpressedGenes(
  equivalence_cellchat,
  thresh.p = params$p_value_cutoff,
  do.fast = FALSE,
  min.cells = params$min_cells_per_group
))
equivalence_cellchat <- suppressWarnings(CellChat::identifyOverExpressedInteractions(equivalence_cellchat))
equivalence_cellchat <- suppressWarnings(CellChat::computeCommunProb(
  equivalence_cellchat,
  raw.use = TRUE,
  population.size = FALSE,
  nboot = 20L,
  seed.use = params$random_seed
))
equivalence_cellchat <- suppressWarnings(CellChat::filterCommunication(
  equivalence_cellchat,
  min.cells = params$min_cells_per_group
))
equivalence_arrays <- plumber_env$cellchat_inference_net_arrays(equivalence_cellchat@net)
equivalence_metadata <- plumber_env$cellchat_inference_pair_metadata(
  equivalence_cellchat@LR$LRsig,
  equivalence_arrays$pair_labels
)
equivalence_display <- stats::setNames(
  c("Group 1", "Group 2"), c("Group_001", "Group_002")
)
equivalence_bounded_interactions <- plumber_env$cellchat_inference_bounded_interaction_rows(
  equivalence_arrays,
  equivalence_metadata,
  params,
  equivalence_display,
  limit = 100000L
)
equivalence_bounded_pathways <- plumber_env$cellchat_inference_bounded_pathway_rows(
  equivalence_arrays,
  equivalence_metadata,
  params,
  equivalence_display,
  limit = 100000L
)
equivalence_expected_interactions <- tryCatch(
  as.data.frame(CellChat::subsetCommunication(
    equivalence_cellchat,
    thresh = params$p_value_cutoff
  )),
  error = function(e) data.frame()
)
equivalence_expected_pathways <- tryCatch(
  as.data.frame(CellChat::subsetCommunication(
    equivalence_cellchat,
    slot.name = "netP",
    thresh = params$p_value_cutoff
  )),
  error = function(e) data.frame()
)
check("bounded extraction matches CellChat on a real inferred communication network",
      identical(
        equivalence_bounded_interactions$candidate_count,
        as.integer(nrow(equivalence_expected_interactions))
      ) &&
        (nrow(equivalence_expected_interactions) == 0L || isTRUE(all.equal(
          comparison_interaction_order(equivalence_bounded_interactions$rows),
          comparison_interaction_order(equivalence_expected_interactions),
          check.attributes = FALSE
        ))))
check("bounded pathway aggregation matches CellChat on a real inferred network",
      identical(
        equivalence_bounded_pathways$candidate_count,
        as.integer(nrow(equivalence_expected_pathways))
      ) &&
        (nrow(equivalence_expected_pathways) == 0L || isTRUE(all.equal(
          comparison_pathway_order(equivalence_bounded_pathways$rows),
          comparison_pathway_order(equivalence_expected_pathways),
          check.attributes = FALSE
        ))))

# Use a deliberately alternating request order to prove the production helper
# keeps CellChat group metadata barcode-aligned without cloning a Seurat subset.
alignment_group_values <- as.character(obj$seurat_clusters)
names(alignment_group_values) <- colnames(obj)
alignment_raw_to_internal <- stats::setNames(
  c("Group_001", "Group_002", "Group_003"),
  c("unsafe/group-A", "unsafe/group-B", "unsafe/group-C")
)
alignment_requested_cells <- c(
  colnames(obj)[n_primary + 2L], colnames(obj)[2L],
  colnames(obj)[n_primary + 1L], colnames(obj)[1L]
)
alignment_metadata <- plumber_env$cellchat_inference_group_metadata(
  alignment_requested_cells,
  alignment_group_values,
  alignment_raw_to_internal,
  unname(alignment_raw_to_internal[c("unsafe/group-A", "unsafe/group-B")])
)
alignment_expected <- unname(
  alignment_raw_to_internal[alignment_group_values[rownames(alignment_metadata)]]
)
check("CellChat groups remain barcode-aligned without cloning a Seurat subset",
      identical(
        as.character(alignment_metadata$.traceomics_cellchat_group),
        alignment_expected
      ))

cellchat_database <- plumber_env$cellchat_inference_database(params)
prepared_alignment_input <- plumber_env$cellchat_inference_prepare_input(
  obj,
  params$assay,
  alignment_requested_cells,
  alignment_group_values,
  alignment_raw_to_internal,
  unname(alignment_raw_to_internal[c("unsafe/group-A", "unsafe/group-B")]),
  cellchat_database
)
check("CellChat extracts only bounded signaling RNA features before inference",
      ncol(prepared_alignment_input$data) == length(alignment_requested_cells) &&
        nrow(prepared_alignment_input$data) < nrow(obj) &&
        identical(colnames(prepared_alignment_input$data), rownames(prepared_alignment_input$metadata)) &&
        !any(grepl("^NON_SIGNAL_", rownames(prepared_alignment_input$data))))
admitted_feature_count <- min(
  plumber_env$CELLCHAT_INFERENCE_MAX_SIGNALING_FEATURES,
  floor(plumber_env$CELLCHAT_INFERENCE_MAX_DENSE_INPUT_BYTES / (8 * 10000L))
)
check("CellChat matrix admission accepts the documented bounded envelope",
      plumber_env$cellchat_inference_input_matrix_admission(
        admitted_feature_count, 10000L
      )$selected_cells == 10000L)
check("CellChat matrix admission rejects feature and dense-allocation overruns",
      expect_error(plumber_env$cellchat_inference_input_matrix_admission(
        plumber_env$CELLCHAT_INFERENCE_MAX_SIGNALING_FEATURES + 1L, 1L
      )) && expect_error(plumber_env$cellchat_inference_input_matrix_admission(
        admitted_feature_count + 1L, 10000L
      )))

owner_group_key <- plumber_env$cellchat_inference_owner_group_key(obj, "seurat_clusters")
check("the owner-local group key maps opaque CellChat groups without entering artifacts",
      identical(owner_group_key$group_by, "seurat_clusters") &&
        identical(vapply(owner_group_key$groups, `[[`, character(1), "group"), c("Group 1", "Group 2", "Group 3")) &&
        identical(vapply(owner_group_key$groups, `[[`, character(1), "label"),
                  c("unsafe/group-A", "unsafe/group-B", "unsafe/group-C")))
ident_group_key_obj <- obj
Seurat::Idents(ident_group_key_obj) <- ident_group_key_obj$seurat_clusters
check("the owner-local key supports the fixed current-identities grouping",
      identical(
        vapply(plumber_env$cellchat_inference_owner_group_key(ident_group_key_obj, "ident")$groups,
               `[[`, character(1), "group"),
        c("Group 1", "Group 2", "Group 3")
      ))

# The alignment regression itself creates a temporary Seurat subset. Snapshot
# the shared RNG immediately before the actual inference helper so this check
# isolates the helper's documented RNG restoration behavior.
rng_before <- get(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
analysis <- plumber_env$run_cellchat_inference_analysis(obj, params)
expected_columns <- c(
  "source_group", "target_group", "interaction_name", "pathway_name", "ligand",
  "receptor", "probability", "p_value", "database_annotation", "requested_database_category"
)
expected_summary_names <- c(
  "method", "analysis_intent", "group_by", "assay", "species", "database_category",
  "p_value_cutoff", "input_cell_count", "analyzed_cell_count", "input_group_count",
  "analyzed_group_count", "excluded_group_count", "candidate_interaction_count",
  "retained_interaction_count", "retained_pathway_count", "groups", "excluded_groups",
  "package_versions", "top_interactions", "top_pathways", "warnings"
)
check("the real helper returns the durable private CSV schema",
      identical(colnames(analysis$table), expected_columns))
check("the response summary has the exact bounded receipt shape",
      identical(names(analysis$summary), expected_summary_names))
check("the result has retained CellChat candidates", nrow(analysis$table) > 0L &&
        analysis$summary$retained_interaction_count == nrow(analysis$table))
check("every durable interaction respects the requested communication p value cutoff",
      all(is.finite(analysis$table$p_value)) &&
        all(analysis$table$p_value <= params$p_value_cutoff))
check("the cell cap and group accounting are recorded",
      identical(analysis$summary$input_cell_count, as.integer(n_cells)) &&
        identical(analysis$summary$analyzed_cell_count, 1000L) &&
        identical(analysis$summary$input_group_count, 3L) &&
        identical(analysis$summary$analyzed_group_count, 2L) &&
        identical(analysis$summary$excluded_group_count, 1L))
check("summary arrays are bounded", length(analysis$summary$groups) <= 64L &&
        length(analysis$summary$excluded_groups) <= 64L &&
        length(analysis$summary$top_interactions) <= 100L &&
        length(analysis$summary$top_pathways) <= 100L &&
        length(analysis$summary$warnings) <= 32L)
check("group presentation labels are opaque and do not leak raw metadata labels",
      !grepl("unsafe/group", jsonlite::toJSON(analysis$summary, auto_unbox = TRUE), fixed = TRUE) &&
        all(vapply(analysis$summary$groups, function(row) grepl("^Group [0-9]+$", row$group), logical(1))) &&
        all(vapply(analysis$summary$excluded_groups, function(row) grepl("^Group [0-9]+$", row$group), logical(1))))
check("all receipt summary strings use the public safe character set",
      all_summary_strings_safe(analysis$summary))
check("preview interaction categories use the canonical request enum",
      all(vapply(analysis$summary$top_interactions,
                 function(row) identical(row$category, "secreted_signaling"), logical(1))))
check("the private table distinguishes CellChat DB annotation from requested scope",
      all(analysis$table$requested_database_category == "secreted_signaling") &&
        all(nzchar(analysis$table$database_annotation)))
check("capped group sampling does not imply abundance-weighted probabilities",
      any(grepl("do not encode original population abundance", unlist(analysis$summary$warnings), fixed = TRUE)))
check("the result records the fixed CellChat software provenance fields",
      identical(names(analysis$summary$package_versions), c("r", "seurat", "cellchat", "cellchat_db")))
check("the input object's default assay is unchanged", identical(Seurat::DefaultAssay(obj), assay_before))
check("the input object's identities are unchanged",
      identical(as.character(Seurat::Idents(obj)), idents_before))
check("the input object's metadata is unchanged", identical(obj@meta.data, metadata_before))
check("the shared R random-number state is unchanged",
      identical(get(".Random.seed", envir = .GlobalEnv, inherits = FALSE), rng_before))

storage_root <- tempfile("cellchat-storage-")
dir.create(storage_root, recursive = TRUE)
old_storage_root <- Sys.getenv("STORAGE_ROOT", unset = NA_character_)
old_api_token <- Sys.getenv("API_TOKEN", unset = NA_character_)
Sys.setenv(STORAGE_ROOT = storage_root, API_TOKEN = paste(rep("a", 64L), collapse = ""))
on.exit({
  if (is.na(old_storage_root)) Sys.unsetenv("STORAGE_ROOT") else Sys.setenv(STORAGE_ROOT = old_storage_root)
  if (is.na(old_api_token)) Sys.unsetenv("API_TOKEN") else Sys.setenv(API_TOKEN = old_api_token)
  unlink(storage_root, recursive = TRUE, force = TRUE)
}, add = TRUE)

project_id <- "proj_cellchat"
job_id <- "job_cellchat"
storage_key <- paste0("projects/", project_id, "/artifacts/", job_id, "/cellchat-inference.csv")
binding <- list(
  version = 1L,
  job_id = job_id,
  job_type = "cellchat.infer.v1",
  r_operation = "r.cellchat.infer.v1",
  project_id = project_id,
  receipt_storage_key = paste0("projects/", project_id, "/artifacts/", job_id, "/completion-receipt.json"),
  source_analysis_object_id = "ao_cellchat",
  source_dataset_id = NULL,
  source_checkpoint_artifact_id = NULL,
  target_analysis_object_id = NULL,
  output_storage_key = storage_key
)
receipt_binding <- plumber_env$validate_completion_receipt_binding(
  list(completion_receipt = binding), "cellchat.infer.v1", "r.cellchat.infer.v1", storage_key
)
destination <- plumber_env$resolve_internal_storage_key(storage_key, for_write = TRUE)
plumber_env$atomic_write_csv(analysis$table, destination)
checksum <- digest::digest(file = destination, algo = "sha256")
response_out <- list(
  ok = TRUE,
  summary = analysis$summary,
  result = list(
    saved = TRUE,
    checksum_sha256 = checksum,
    size_bytes = as.numeric(file.info(destination)$size),
    n_rows = nrow(analysis$table)
  )
)
plumber_env$atomic_write_completion_receipt(receipt_binding, response_out)
receipt_path <- plumber_env$resolve_internal_storage_key(binding$receipt_storage_key, for_write = FALSE)
check("the private CSV and signed receipt are atomically persisted",
      file.exists(destination) && file.info(destination)$size > 0L &&
        file.exists(receipt_path) && file.info(receipt_path)$size > 0L)
check("the durable endpoint success response has only ok summary and result",
      identical(names(response_out), c("ok", "summary", "result")) &&
        identical(names(response_out$result), c("saved", "checksum_sha256", "size_bytes", "n_rows")))

# The optional Node interop harness uses this exact R-produced envelope to prove
# that the worker's verifier can recover a CellChat completion receipt created
# by Plumber. Keep this test-only handoff outside the private storage root so
# the normal on.exit cleanup above still exercises its lifecycle.
interop_output <- Sys.getenv("CELLCHAT_SMOKE_INTEROP_OUTPUT", unset = "")
if (nzchar(interop_output)) {
  receipt_size <- as.numeric(file.info(receipt_path)$size)
  receipt_raw <- readBin(receipt_path, what = "raw", n = receipt_size)
  jsonlite::write_json(
    list(
      envelope_json = rawToChar(receipt_raw),
      r_api_token = Sys.getenv("API_TOKEN"),
      job = list(
        id = job_id,
        jobType = "cellchat.infer.v1",
        projectId = project_id,
        analysisObjectId = "ao_cellchat",
        datasetId = NULL
      ),
      expected = list(outputStorageKey = storage_key)
    ),
    interop_output,
    auto_unbox = TRUE,
    null = "null",
    digits = NA
  )
}

if (failures > 0L) {
  stop(sprintf("CellChat inference real-R smoke failed: %d check(s).", failures))
}
cat("CELLCHAT INFERENCE REAL-R SMOKE PASSED\n")
