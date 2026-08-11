#!/usr/bin/env Rscript

args <- commandArgs(trailingOnly = FALSE)
file_arg <- grep("^--file=", args, value = TRUE)
script_dir <- if (length(file_arg) == 1) {
  dirname(normalizePath(sub("^--file=", "", file_arg)))
} else {
  normalizePath("r-backend/tests")
}
plumber_file <- file.path(script_dir, "..", "plumber.R")
source(plumber_file, local = globalenv())

# The classic Visium extractor must preserve a Space Ranger directory layout
# while extracting only the matrix and allowlisted spatial files.
visium_fixture_root <- tempfile("traceomics-visium-fixture-")
dir.create(file.path(visium_fixture_root, "outs", "spatial"), recursive = TRUE)
writeBin(as.raw(c(0x01, 0x02)), file.path(visium_fixture_root, "outs", "filtered_feature_bc_matrix.h5"))
writeLines("barcode,in_tissue,array_row,array_col,pxl_row_in_fullres,pxl_col_in_fullres",
           file.path(visium_fixture_root, "outs", "spatial", "tissue_positions.csv"))
writeLines('{"tissue_lowres_scalef":1}',
           file.path(visium_fixture_root, "outs", "spatial", "scalefactors_json.json"))
writeBin(as.raw(c(0x89, 0x50, 0x4e, 0x47)),
         file.path(visium_fixture_root, "outs", "spatial", "tissue_lowres_image.png"))
visium_zip <- tempfile(fileext = ".zip")
prior_wd <- getwd()
setwd(visium_fixture_root)
utils::zip(visium_zip, c(
  "outs/filtered_feature_bc_matrix.h5",
  "outs/spatial/tissue_positions.csv",
  "outs/spatial/scalefactors_json.json",
  "outs/spatial/tissue_lowres_image.png"
), flags = "-q")
setwd(prior_wd)
visium_extracted <- extract_classic_visium_bundle(visium_zip)
stopifnot(
  identical(basename(visium_extracted$data_dir), "outs"),
  file.exists(file.path(visium_extracted$data_dir, "filtered_feature_bc_matrix.h5")),
  file.exists(file.path(visium_extracted$data_dir, "spatial", "tissue_positions.csv")),
  !file.exists(file.path(visium_extracted$data_dir, "spatial", "tissue_hires_image.png"))
)
unlink(c(visium_extracted$root, visium_fixture_root, visium_zip), recursive = TRUE, force = TRUE)

# The private live-state cache authenticates before key handling, accepts only
# canonical server-derived keys, and has deterministic count/byte admission.
session_env_names <- c(
  "API_TOKEN", "R_MAX_ACTIVE_SESSIONS", "R_MAX_ACTIVE_SESSIONS_PER_USER",
  "R_MAX_ACTIVE_SESSION_BYTES", "R_MAX_ACTIVE_SESSION_BYTES_PER_USER",
  "R_MAX_ACTIVE_SESSION_BYTES_PER_SESSION"
)
saved_session_env <- Sys.getenv(session_env_names, unset = NA_character_)
Sys.setenv(
  API_TOKEN = "session-cache-test-secret",
  R_MAX_ACTIVE_SESSIONS = "3",
  R_MAX_ACTIVE_SESSIONS_PER_USER = "2",
  R_MAX_ACTIVE_SESSION_BYTES = "10000000",
  R_MAX_ACTIVE_SESSION_BYTES_PER_USER = "10000000",
  R_MAX_ACTIVE_SESSION_BYTES_PER_SESSION = "10000000"
)
if (length(ls(envir = active_sessions, all.names = TRUE)) > 0) {
  rm(list = ls(envir = active_sessions, all.names = TRUE), envir = active_sessions)
}
active_session_clock <- 0
stopifnot(identical(validate_internal_state_key("user-1"), "user-1"))
stopifnot(identical(validate_internal_state_key("user-1:obj-analysis_1"), "user-1:obj-analysis_1"))
for (bad_key in c("DEFAULT", "user-x", "user-1:obj-../escape", paste0("user-1:obj-", strrep("a", 150)))) {
  stopifnot(inherits(try(validate_internal_state_key(bad_key), silent = TRUE), "try-error"))
}
unauth_req <- new.env(parent = emptyenv())
unauth_req$REQUEST_METHOD <- "OPTIONS"
unauth_req$HTTP_X_OBJECT_ID <- "user-1:obj-attacker"
unauth_res <- new.env(parent = emptyenv())
stopifnot(!authenticate_internal_request(unauth_req, unauth_res))
stopifnot(identical(unauth_res$status, 403))
auth_req <- new.env(parent = emptyenv())
auth_req$HTTP_X_API_TOKEN <- "session-cache-test-secret"
auth_res <- new.env(parent = emptyenv())
stopifnot(authenticate_internal_request(auth_req, auth_res))

store_active_session("user-1:obj-a", list(value = 1L), NULL)
store_active_session("user-1:obj-b", list(value = 2L), NULL)
invisible(load_active_session("user-1:obj-a")) # make b the deterministic per-user LRU
store_active_session("user-1:obj-c", list(value = 3L), NULL)
stopifnot(!exists("user-1:obj-b", envir = active_sessions, inherits = FALSE))
stopifnot(all(c("user-1:obj-a", "user-1:obj-c") %in% ls(envir = active_sessions)))
store_active_session("user-2:obj-a", list(value = 4L), NULL)
store_active_session("user-2:obj-b", list(value = 5L), NULL)
stopifnot(length(ls(envir = active_sessions, all.names = TRUE)) == 3L)
stopifnot(!exists("user-1:obj-a", envir = active_sessions, inherits = FALSE))
before_empty <- ls(envir = active_sessions, all.names = TRUE)
store_active_session("user-3:obj-empty", NULL, NULL)
stopifnot(identical(ls(envir = active_sessions, all.names = TRUE), before_empty))
prior_replacement <- active_sessions[["user-1:obj-c"]]
Sys.setenv(R_MAX_ACTIVE_SESSION_BYTES_PER_SESSION = "1")
stopifnot(inherits(
  try(store_active_session("user-1:obj-c", list(value = 1:10), NULL), silent = TRUE),
  "try-error"
))
stopifnot(identical(active_sessions[["user-1:obj-c"]], prior_replacement))
stopifnot(identical(ls(envir = active_sessions, all.names = TRUE), before_empty))
stopifnot(inherits(
  try(store_active_session("user-3:obj-too-large", list(value = 1:10), NULL), silent = TRUE),
  "try-error"
))
if (length(ls(envir = active_sessions, all.names = TRUE)) > 0) {
  rm(list = ls(envir = active_sessions, all.names = TRUE), envir = active_sessions)
}

for (name in session_env_names) {
  value <- saved_session_env[[name]]
  if (is.na(value)) Sys.unsetenv(name) else do.call(Sys.setenv, setNames(list(value), name))
}

# Job-scoped compute hydration must be erased after the scientific route, while
# canonical interactive state remains cached. The helper also disables the
# postroute persistence hook so released globals cannot be written back.
job_state_key <- paste0(
  "user-1:obj-ao_", strrep("a", 24), "-job-job_", strrep("b", 24)
)
canonical_state_key <- paste0("user-1:obj-ao_", strrep("c", 24))
release_req <- new.env(parent = emptyenv())
release_req$traceomics_session_persist <- TRUE
global_obj <- list(private = 1L)
raw_obj <- list(private = 2L)
store_active_session(job_state_key, global_obj, raw_obj)
stopifnot(identical(job_scoped_active_session_key(job_state_key), job_state_key))
stopifnot(isTRUE(release_job_scoped_active_session(release_req, job_state_key)))
stopifnot(!exists(job_state_key, envir = active_sessions, inherits = FALSE))
stopifnot(is.null(global_obj), is.null(raw_obj))
stopifnot(identical(release_req$traceomics_session_persist, FALSE))

canonical_req <- new.env(parent = emptyenv())
canonical_req$traceomics_session_persist <- TRUE
global_obj <- list(interactive = 1L)
raw_obj <- NULL
store_active_session(canonical_state_key, global_obj, raw_obj)
stopifnot(is.null(job_scoped_active_session_key(canonical_state_key)))
stopifnot(identical(release_job_scoped_active_session(canonical_req, canonical_state_key), FALSE))
stopifnot(exists(canonical_state_key, envir = active_sessions, inherits = FALSE))
stopifnot(identical(canonical_req$traceomics_session_persist, TRUE))
rm(list = canonical_state_key, envir = active_sessions)
global_obj <- NULL
raw_obj <- NULL

expect_error <- function(expr, pattern) {
  error <- tryCatch({
    force(expr)
    NULL
  }, error = identity)
  stopifnot(inherits(error, "error"))
  stopifnot(grepl(pattern, conditionMessage(error), fixed = TRUE))
}

stopifnot(identical(bounded_plot_number(NULL, 6, 1, 12), 6))
stopifnot(identical(bounded_plot_number(1000, 6, 1, 12), 12))
stopifnot(identical(bounded_plot_number(-1000, 6, 1, 12), 1))
stopifnot(identical(length(bounded_plot_features(as.character(seq_len(500)))), 50L))
stopifnot(isTRUE(plot_pixel_budget_ok(8, 6, 300)))
stopifnot(!isTRUE(plot_pixel_budget_ok(12, 12, 300)))

small <- bounded_sample_indices(5)
stopifnot(identical(small, 1:5))
large_a <- bounded_sample_indices(100000)
large_b <- bounded_sample_indices(100000)
stopifnot(identical(large_a, large_b))
stopifnot(length(large_a) <= MAX_QC_DISTRIBUTION_VALUES)
stopifnot(large_a[[1]] == 1L)
stopifnot(large_a[[length(large_a)]] == 100000L)
stopifnot(identical(bounded_sample_indices(0), integer()))

# Public numeric parameters reject vectors, non-finite values, fractions for
# integer fields, and out-of-range values instead of silently coercing them.
stopifnot(identical(public_bounded_integer("15", "dims", 1, 100), 15L))
stopifnot(identical(public_bounded_integer(15.0, "dims", 1, 100), 15L))
expect_error(public_bounded_integer(15.5, "dims", 1, 100), "dims must be a whole number")
expect_error(public_bounded_integer(c(1, 2), "dims", 1, 100), "dims must be a whole number")
expect_error(public_bounded_integer(101, "dims", 1, 100), "dims must be a whole number")
stopifnot(identical(public_bounded_number("0.3", "min_dist", 0, 1), 0.3))
expect_error(public_bounded_number(Inf, "min_dist", 0, 1), "min_dist must be a finite number")
expect_error(public_bounded_number(-0.1, "min_dist", 0, 1), "min_dist must be a finite number")
stopifnot(identical(public_choice("LogNormalize", "method", c("LogNormalize", "SCTransform")), "LogNormalize"))
expect_error(public_choice("arbitrary", "method", c("LogNormalize", "SCTransform")), "method must be one of")
stopifnot(is.null(public_optional_seed("")))
stopifnot(identical(public_optional_seed("42"), 42L))
expect_error(public_optional_seed(-1), "seed must be a whole number")

# Browser-driven live compute has a hard object admission ceiling. Boundary
# objects pass; either an extra cell or feature is rejected before Seurat work.
cell_boundary <- matrix(0, nrow = 1, ncol = MAX_PUBLIC_SYNC_CELLS)
admitted <- public_compute_admission(cell_boundary, "Test operation")
stopifnot(admitted$n_cells == MAX_PUBLIC_SYNC_CELLS, admitted$n_features == 1L)
rm(cell_boundary)
expect_error(
  public_compute_admission(matrix(0, nrow = 1, ncol = MAX_PUBLIC_SYNC_CELLS + 1L), "Test operation"),
  "exceeds the live synchronous compute limit"
)
expect_error(
  public_compute_admission(matrix(0, nrow = MAX_PUBLIC_SYNC_FEATURES + 1L, ncol = 1), "Test operation"),
  "exceeds the live synchronous compute limit"
)

# Independent dimensions are not a memory budget. Full-object routes also cap
# the current R object, and densifying operations cap their estimated matrix.
stopifnot(public_compute_admission(matrix(0, nrow = 2, ncol = 2), "Test operation")$object_bytes > 0)
old_object_limit <- MAX_PUBLIC_OBJECT_BYTES
MAX_PUBLIC_OBJECT_BYTES <- 1
expect_error(
  public_compute_admission(matrix(0, nrow = 1, ncol = 1), "Memory test"),
  "live synchronous in-memory object limit"
)
MAX_PUBLIC_OBJECT_BYTES <- old_object_limit
dense_boundary <- public_dense_allocation_admission(
  list(n_cells = 100000L), 500L, "Dense test"
)
stopifnot(dense_boundary$dense_values == MAX_PUBLIC_DENSE_VALUES)
expect_error(
  public_dense_allocation_admission(list(n_cells = 100000L), 501L, "Dense test"),
  "live synchronous dense-allocation limit"
)

# Ordinary UI defaults remain valid at the R trust boundary.
stopifnot(identical(public_bounded_integer(10000, "scale_factor", 1, MAX_NORMALIZE_SCALE_FACTOR), 10000L))
stopifnot(identical(public_bounded_integer(2000, "nfeatures", 1, MAX_VARIABLE_FEATURES), 2000L))
stopifnot(identical(public_bounded_number(0.8, "resolution", 0.01, MAX_CLUSTER_RESOLUTION), 0.8))
stopifnot(identical(public_bounded_integer(20, "k_param", 2, 100), 20L))
stopifnot(identical(public_bounded_integer(10, "n_start", 1, 100), 10L))
stopifnot(identical(public_bounded_integer(2, "n_components", 2, 3), 2L))
stopifnot(identical(public_bounded_integer(30, "n_neighbors", 2, 100), 30L))
stopifnot(identical(public_bounded_integer(5, "top_n", 1, 20), 5L))

# Gene identifiers and comma-separated lists are scalar, length-bounded, and
# deduplicated without reordering. Oversized lists are rejected before compute.
stopifnot(identical(public_gene_identifier("MS4A1"), "MS4A1"))
expect_error(public_gene_identifier(c("A", "B")), "gene must be a single gene identifier")
expect_error(public_gene_identifier(strrep("A", MAX_PUBLIC_GENE_NAME_CHARS + 1L)), "gene must be a non-empty gene identifier")
stopifnot(identical(public_csv_gene_list(" CD3E,MS4A1,CD3E "), c("CD3E", "MS4A1")))
too_many_genes <- paste(paste0("G", seq_len(MAX_DOT_PLOT_GENES + 1L)), collapse = ",")
expect_error(public_csv_gene_list(too_many_genes), "genes must contain at most")
stopifnot(identical(public_csv_parameter_list("", "vars_to_regress", 10), character()))
stopifnot(identical(
  public_csv_parameter_list("percent.mt, nCount_RNA,percent.mt", "vars_to_regress", 10),
  c("percent.mt", "nCount_RNA")
))
too_many_regressors <- paste(paste0("meta", seq_len(MAX_REGRESSION_VARIABLES + 1L)), collapse = ",")
expect_error(
  public_csv_parameter_list(too_many_regressors, "vars_to_regress", MAX_REGRESSION_VARIABLES),
  "vars_to_regress must contain at most"
)
stopifnot(identical(bounded_public_labels(paste0("A\n", strrep("B", 200))), paste0("A", strrep("B", 127))))
stopifnot(identical(
  public_identity_levels(factor(c("b", "a", "b"), levels = c("a", "b", "unused"))),
  c("a", "b")
))
stopifnot(identical(
  bounded_public_gene_names(c("AAAA", "BBBB", "CCCC"), maximum_bytes = 14),
  c("AAAA", "BBBB")
))
stopifnot(length(bounded_public_gene_names(rep("G", MAX_PUBLIC_GENE_LIST + 1L))) == MAX_PUBLIC_GENE_LIST)

# Cell-level outputs use deterministic sampling and retain at least one point
# from every ordinary cluster while respecting the global response cap.
groups <- rep(paste0("cluster-", seq_len(25)), each = 2000)
group_sample_a <- bounded_group_sample_indices(groups, 1000)
group_sample_b <- bounded_group_sample_indices(groups, 1000)
stopifnot(identical(group_sample_a, group_sample_b))
stopifnot(length(group_sample_a) == 1000L)
stopifnot(length(unique(groups[group_sample_a])) == 25L)
stopifnot(min(group_sample_a) >= 1L && max(group_sample_a) <= length(groups))

# Marker selection is deterministic under ties and cannot expand beyond top_n
# or the global feature cap.
markers <- data.frame(
  cluster = c("0", "0", "0", "1", "1"),
  gene = c("B", "A", "C", "D", "E"),
  avg_log2FC = c(1, 1, 0.5, 2, 1),
  stringsAsFactors = FALSE
)
stopifnot(identical(bounded_marker_features(markers, 2, maximum = 3), c("A", "B", "D")))
expect_error(bounded_marker_features(markers, 21), "top_n must be a whole number")

# Extract an annotated Plumber handler without starting a server. This keeps the
# test focused on endpoint behavior while using the exact functions in plumber.R.
endpoint_handler <- function(method, route) {
  source_lines <- readLines(plumber_file, warn = FALSE)
  marker <- paste0("#* @", tolower(method), " ", route)
  line <- which(trimws(source_lines) == marker)
  stopifnot(length(line) == 1L)
  expression <- parse(text = source_lines[(line + 1L):length(source_lines)], n = 1L)[[1]]
  eval(expression, envir = globalenv())
}

new_response <- function() new.env(parent = emptyenv())
expect_bad_request <- function(response, result, pattern) {
  force(result)
  stopifnot(identical(response$status, 400))
  stopifnot(is.list(result), is.character(result$error), length(result$error) == 1L)
  stopifnot(grepl(pattern, result$error, fixed = TRUE))
}
expect_compute_rejected <- function(response, result, operation) {
  force(result)
  stopifnot(identical(response$status, 413))
  stopifnot(is.list(result), is.character(result$error), length(result$error) == 1L)
  stopifnot(grepl(operation, result$error, fixed = TRUE))
  stopifnot(grepl("durable queued job", result$error, fixed = TRUE))
}

normalize_endpoint <- endpoint_handler("get", "/normalize")
qc_distributions_endpoint <- endpoint_handler("get", "/qc-distributions")
object_info_endpoint <- endpoint_handler("get", "/object-info")
pipeline_state_endpoint <- endpoint_handler("get", "/pipeline-state")
meta_values_endpoint <- endpoint_handler("get", "/meta-values")
cellchat_group_map_endpoint <- endpoint_handler("get", "/cellchat-group-map")
add_meta_mapping_endpoint <- endpoint_handler("post", "/add-meta-mapping")
qc_endpoint <- endpoint_handler("post", "/qc")
integrate_endpoint <- endpoint_handler("get", "/integrate")
pca_endpoint <- endpoint_handler("get", "/pca")
cluster_endpoint <- endpoint_handler("get", "/cluster")
umap_endpoint <- endpoint_handler("get", "/umap")
genes_endpoint <- endpoint_handler("get", "/genes")
gene_expression_endpoint <- endpoint_handler("get", "/gene-expression")
feature_values_endpoint <- endpoint_handler("get", "/feature-values")
heatmap_endpoint <- endpoint_handler("get", "/heatmap")
dot_plot_endpoint <- endpoint_handler("get", "/dot-plot")
export_preview_endpoint <- endpoint_handler("post", "/export-preview")
render_plot_endpoint <- endpoint_handler("post", "/render-plot-base64")
validate_endpoint <- endpoint_handler("get", "/validate")

# Every heavy synchronous route rejects an oversized live object before it can
# reach a Seurat operation. A plain matrix deliberately proves the early exit.
global_obj <- matrix(0, nrow = 1, ncol = MAX_PUBLIC_SYNC_CELLS + 1L)
response <- new_response()
expect_compute_rejected(response, normalize_endpoint(response), "Normalization")
response <- new_response()
expect_compute_rejected(response, cluster_endpoint(response), "Clustering")
response <- new_response()
expect_compute_rejected(response, umap_endpoint(response), "UMAP")
response <- new_response()
expect_compute_rejected(response, heatmap_endpoint(response), "Heatmap")
response <- new_response()
expect_compute_rejected(response, dot_plot_endpoint(response), "Dot plot")
response <- new_response()
expect_compute_rejected(response, qc_distributions_endpoint(response), "QC distributions")
response <- new_response()
expect_compute_rejected(response, object_info_endpoint(response), "Object inspection")
response <- new_response()
expect_compute_rejected(response, pipeline_state_endpoint(list(), response), "Pipeline state inspection")
response <- new_response()
expect_compute_rejected(response, meta_values_endpoint(response, column = "x"), "Metadata values")
response <- new_response()
expect_compute_rejected(
  response,
  add_meta_mapping_endpoint(response, list(body = list())),
  "Metadata mapping"
)
response <- new_response()
expect_compute_rejected(response, qc_endpoint(response, list(body = list())), "Quality control")
response <- new_response()
expect_compute_rejected(response, integrate_endpoint(response), "Batch integration")
response <- new_response()
expect_compute_rejected(response, pca_endpoint(response), "PCA")
response <- new_response()
expect_compute_rejected(
  response,
  export_preview_endpoint(response, list(body = list())),
  "Plot preview"
)
response <- new_response()
expect_compute_rejected(
  response,
  render_plot_endpoint(response, list(body = list())),
  "Base64 plot render"
)
response <- new_response()
expect_compute_rejected(response, validate_endpoint(response), "Validation")

# Validation executes before expensive Seurat operations.
global_obj <- matrix(1, nrow = 1, ncol = 1, dimnames = list("G1", "C1"))
response <- new_response()
expect_bad_request(response, normalize_endpoint(response, scale_factor = 0), "scale_factor")
response <- new_response()
expect_bad_request(response, normalize_endpoint(response, method = "arbitrary"), "method")
response <- new_response()
expect_bad_request(
  response,
  normalize_endpoint(response, vars_to_regress = too_many_regressors),
  "vars_to_regress must contain at most"
)
response <- new_response()
expect_bad_request(response, cluster_endpoint(response, dims = 101), "dims")
response <- new_response()
expect_bad_request(response, cluster_endpoint(response, algorithm = 2), "algorithm")
response <- new_response()
expect_bad_request(response, umap_endpoint(response, n_components = 4), "n_components")
response <- new_response()
expect_bad_request(response, umap_endpoint(response, min_dist = 2), "min_dist")
response <- new_response()
expect_bad_request(response, pca_endpoint(response, npcs = 101), "npcs")
response <- new_response()
expect_bad_request(response, integrate_endpoint(response, method = "arbitrary"), "method")
response <- new_response()
expect_bad_request(response, meta_values_endpoint(response, column = "missing"), "column")
response <- new_response()
expect_bad_request(
  response,
  qc_endpoint(response, list(body = list(
    mt_threshold = -1, min_features = 0, max_features = 0, min_counts = 0
  ))),
  "mt_threshold"
)
response <- new_response()
expect_bad_request(response, gene_expression_endpoint(response, gene = c("G1", "G2")), "single gene")
response <- new_response()
expect_bad_request(response, feature_values_endpoint(response, gene = strrep("G", 300)), "no longer than")

# The owner-local CellChat key has its own metadata-only admission because it
# reads one grouping vector rather than duplicating the full expression object.
# It accepts only the two fixed grouping choices and keeps opaque Group N values
# distinct from raw labels. Invalid grouping input must fail generically without
# exposing a label.
private_group_label <- paste0("Private donor\n", strrep("x", 200L))
cellchat_counts <- Matrix::sparseMatrix(
  i = c(1L, 2L, 1L, 2L),
  j = c(1L, 2L, 3L, 4L),
  x = rep(1, 4L),
  dims = c(2L, 4L),
  dimnames = list(c("G1", "G2"), c("C1", "C2", "C3", "C4"))
)
global_obj <- suppressMessages(CreateSeuratObject(
  counts = cellchat_counts, min.cells = 0, min.features = 0
))
global_obj$seurat_clusters <- factor(c(
  "Alpha", private_group_label, "Alpha", private_group_label
))
Idents(global_obj) <- factor(c("Identity A", "Identity B", "Identity A", "Identity B"))

# The generic synchronous-object cap would reject this source after one cell,
# but the mapping needs only bounded metadata and remains available for a valid
# durable CellChat result.
old_sync_cell_cap <- MAX_PUBLIC_SYNC_CELLS
MAX_PUBLIC_SYNC_CELLS <- 1L
response <- new_response()
response$status <- 200L
cellchat_group_map <- cellchat_group_map_endpoint(response, group_by = "seurat_clusters")
MAX_PUBLIC_SYNC_CELLS <- old_sync_cell_cap
stopifnot(identical(response$status, 200L))
stopifnot(identical(cellchat_group_map$group_by, "seurat_clusters"))
stopifnot(identical(
  vapply(cellchat_group_map$groups, `[[`, character(1), "group"),
  c("Group 1", "Group 2")
))
stopifnot(identical(
  vapply(cellchat_group_map$groups, `[[`, integer(1), "input_cells"),
  c(2L, 2L)
))
cellchat_group_labels <- vapply(cellchat_group_map$groups, `[[`, character(1), "label")
stopifnot(identical(cellchat_group_labels[[1]], "Alpha"))
stopifnot(startsWith(cellchat_group_labels[[2]], "Private donor"))
stopifnot(nchar(cellchat_group_labels[[2]], type = "chars") == 160L)
stopifnot(!any(grepl("[[:cntrl:]]", cellchat_group_labels)))

# The dedicated map admission still rejects an implausibly large metadata
# vector before it can build a character grouping or table.
global_obj <- matrix(
  0,
  nrow = 1L,
  ncol = CELLCHAT_INFERENCE_MAX_GROUP_MAP_CELLS + 1L
)
response <- new_response()
oversized_group_map <- cellchat_group_map_endpoint(response, group_by = "seurat_clusters")
stopifnot(identical(response$status, 413L))
stopifnot(identical(
  oversized_group_map$error,
  "CellChat group mapping exceeds the supported metadata limit."
))

# Restore the small Seurat fixture for fixed-group validation below.
global_obj <- suppressMessages(CreateSeuratObject(
  counts = cellchat_counts, min.cells = 0, min.features = 0
))
global_obj$seurat_clusters <- factor(c(
  "Alpha", private_group_label, "Alpha", private_group_label
))
Idents(global_obj) <- factor(c("Identity A", "Identity B", "Identity A", "Identity B"))

for (invalid_group_by in list(
  "private_metadata_column",
  c("seurat_clusters", "private_metadata_column")
)) {
  response <- new_response()
  invalid_group_map <- cellchat_group_map_endpoint(response, group_by = invalid_group_by)
  expect_bad_request(response, invalid_group_map, "CellChat group mapping is unavailable.")
  stopifnot(!grepl("private_metadata_column", invalid_group_map$error, fixed = TRUE))
  stopifnot(!grepl("Private donor", invalid_group_map$error, fixed = TRUE))
}

# /genes returns a deterministic prefix and reports both total and returned size.
gene_names <- paste0("GENE", seq_len(MAX_PUBLIC_GENE_LIST + 5L))
global_obj <- matrix(
  numeric(length(gene_names)), nrow = length(gene_names), ncol = 1,
  dimnames = list(gene_names, "C1")
)
gene_payload <- genes_endpoint(new_response())
stopifnot(length(gene_payload$genes) == MAX_PUBLIC_GENE_LIST)
stopifnot(gene_payload$count == MAX_PUBLIC_GENE_LIST + 5L)
stopifnot(gene_payload$returned_count == MAX_PUBLIC_GENE_LIST)
stopifnot(isTRUE(gene_payload$truncated))
stopifnot(identical(gene_payload$genes[[1]], "GENE1"))
stopifnot(identical(tail(gene_payload$genes, 1), paste0("GENE", MAX_PUBLIC_GENE_LIST)))

# Build a sparse, inexpensive object just over the public cell-value cap. Both
# expression endpoints must return the same deterministic bounded cell subset.
n_cells <- MAX_PUBLIC_CELL_VALUES + 17L
cell_names <- paste0("CELL", seq_len(n_cells))
counts <- Matrix::sparseMatrix(
  i = rep(1:3, length.out = n_cells),
  j = seq_len(n_cells),
  x = rep(1, n_cells),
  dims = c(3, n_cells),
  dimnames = list(c("G1", "G2", "G3"), cell_names)
)
global_obj <- suppressMessages(CreateSeuratObject(counts = counts, min.cells = 0, min.features = 0))
global_obj <- suppressMessages(NormalizeData(global_obj, verbose = FALSE))
global_obj$seurat_clusters <- factor(rep(c("0", "1"), length.out = n_cells))
global_obj$unique_meta <- paste0("VALUE", seq_len(n_cells))
Idents(global_obj) <- "seurat_clusters"
umap_embeddings <- cbind(
  UMAP_1 = as.numeric(seq_len(n_cells)),
  UMAP_2 = -as.numeric(seq_len(n_cells))
)
rownames(umap_embeddings) <- cell_names
global_obj[["umap"]] <- CreateDimReducObject(
  embeddings = umap_embeddings, key = "UMAP_", assay = DefaultAssay(global_obj)
)

expression_payload <- gene_expression_endpoint(new_response(), gene = "G1")
feature_payload <- feature_values_endpoint(new_response(), gene = "G1")
meta_payload <- meta_values_endpoint(new_response(), column = "unique_meta")
stopifnot(length(expression_payload$expression) == MAX_PUBLIC_CELL_VALUES)
stopifnot(length(expression_payload$clusters) == MAX_PUBLIC_CELL_VALUES)
stopifnot(length(expression_payload$u1) == MAX_PUBLIC_CELL_VALUES)
stopifnot(expression_payload$n_cells == n_cells)
stopifnot(expression_payload$n_values == MAX_PUBLIC_CELL_VALUES)
stopifnot(isTRUE(expression_payload$sampled))
stopifnot(identical(expression_payload$u1, feature_payload$u1))
stopifnot(length(feature_payload$expression) == MAX_PUBLIC_CELL_VALUES)
stopifnot(feature_payload$n_cells == n_cells, isTRUE(feature_payload$sampled))
stopifnot(feature_payload$u1[[1]] == 1, tail(feature_payload$u1, 1) == n_cells)
stopifnot(meta_payload$n_unique == n_cells)
stopifnot(meta_payload$returned_count == MAX_PUBLIC_METADATA_VALUES)
stopifnot(length(meta_payload$values) == MAX_PUBLIC_METADATA_VALUES)
stopifnot(isTRUE(meta_payload$truncated))

oversized_mapping <- as.list(setNames(
  paste0("mapped", seq_len(MAX_PUBLIC_MAPPING_ENTRIES + 1L)),
  paste0("source", seq_len(MAX_PUBLIC_MAPPING_ENTRIES + 1L))
))
response <- new_response()
expect_bad_request(
  response,
  add_meta_mapping_endpoint(response, list(body = list(
    source_col = "seurat_clusters",
    new_col = "mapped_cluster",
    mapping = oversized_mapping
  ))),
  "uniquely named entries"
)

# Render errors after opening a device must close it and unlink the temp image.
forced_render_path <- file.path(tempdir(), "traceomics-public-render-cleanup.png")
if (file.exists(forced_render_path)) unlink(forced_render_path)
had_tempfile <- exists("tempfile", envir = globalenv(), inherits = FALSE)
if (had_tempfile) original_tempfile <- get("tempfile", envir = globalenv())
assign("tempfile", function(...) forced_render_path, envir = globalenv())
device_before <- dev.cur()
render_error <- tryCatch(
  render_plot_endpoint(
    new_response(),
    list(body = list(
      plot_type = "FeaturePlot", features = "NOT_A_REAL_FEATURE",
      group_by = "seurat_clusters", width = 2, height = 2, res = 72
    ))
  ),
  finally = {
    if (had_tempfile) {
      assign("tempfile", original_tempfile, envir = globalenv())
    } else {
      rm("tempfile", envir = globalenv())
    }
  }
)
stopifnot(is.list(render_error), grepl("Feature not found", render_error$error, fixed = TRUE))
stopifnot(!file.exists(forced_render_path), dev.cur() == device_before)

dot_payload <- dot_plot_endpoint(new_response(), genes = "G1,G2")
stopifnot(dot_payload$n_cells == n_cells)
stopifnot(dot_payload$analysis_cells == MAX_PUBLIC_CELL_VALUES)
stopifnot(isTRUE(dot_payload$sampled))
stopifnot(length(dot_payload$genes) == 2L, length(dot_payload$clusters) == 2L)
stopifnot(all(lengths(dot_payload$avg_expr) == 2L))
stopifnot(all(lengths(dot_payload$pct_expr) == 2L))

# Stub only the marker statistics so the real heatmap handler can prove it
# subsets the Seurat object before marker discovery and aggregation.
had_find_all_markers <- exists("FindAllMarkers", envir = globalenv(), inherits = FALSE)
had_average_expression <- exists("AverageExpression", envir = globalenv(), inherits = FALSE)
if (had_find_all_markers) original_find_all_markers <- get("FindAllMarkers", envir = globalenv())
if (had_average_expression) original_average_expression <- get("AverageExpression", envir = globalenv())
captured_heatmap_cells <- NA_integer_
assign("FindAllMarkers", function(object, ...) {
  captured_heatmap_cells <<- ncol(object)
  data.frame(
    cluster = c("0", "1"),
    gene = c("G1", "G2"),
    avg_log2FC = c(2, 1),
    stringsAsFactors = FALSE
  )
}, envir = globalenv())
assign("AverageExpression", function(object, features, assays, ...) {
  clusters <- public_identity_levels(Idents(object))
  values <- matrix(
    seq_len(length(features) * length(clusters)),
    nrow = length(features),
    dimnames = list(features, clusters)
  )
  result <- list(values)
  names(result) <- assays[[1]]
  result
}, envir = globalenv())
heatmap_payload <- tryCatch(
  heatmap_endpoint(new_response(), top_n = 1),
  finally = {
    if (had_find_all_markers) {
      assign("FindAllMarkers", original_find_all_markers, envir = globalenv())
    } else {
      rm("FindAllMarkers", envir = globalenv())
    }
    if (had_average_expression) {
      assign("AverageExpression", original_average_expression, envir = globalenv())
    } else {
      rm("AverageExpression", envir = globalenv())
    }
  }
)
stopifnot(captured_heatmap_cells == MAX_HEATMAP_CELLS)
stopifnot(heatmap_payload$n_cells == n_cells)
stopifnot(heatmap_payload$analysis_cells == MAX_HEATMAP_CELLS)
stopifnot(isTRUE(heatmap_payload$sampled))
stopifnot(length(heatmap_payload$genes) == 2L, heatmap_payload$returned_clusters == 2L)

# Heatmap and dot-plot list limits reject before marker discovery or FetchData.
response <- new_response()
expect_bad_request(response, heatmap_endpoint(response, top_n = 21), "top_n")
response <- new_response()
expect_bad_request(response, dot_plot_endpoint(response, genes = too_many_genes), "at most")

cat("Public R endpoint bounds: OK\n")
