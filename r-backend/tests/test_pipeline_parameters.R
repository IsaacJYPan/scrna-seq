# The pipeline records what it ran: R refuses invalid parameters instead of
# replacing or clamping them, returns its effective parameters, never draws a
# random seed, and does not pretend to filter on mitochondrial content when no
# mitochondrial genes are present.
#
# Usage: Rscript r-backend/tests/test_pipeline_parameters.R
suppressPackageStartupMessages({
  library(Seurat)
  library(Matrix)
})

script_dir <- local({
  file_arg <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
  if (length(file_arg)) dirname(normalizePath(file_arg)) else file.path(getwd(), "r-backend", "tests")
})
source(file.path(normalizePath(file.path(script_dir, "..", "lib")), "seuratPipelineCore.R"))

failures <- 0L
check <- function(desc, ok) {
  cat(if (isTRUE(ok)) "PASS:" else "FAIL:", desc, "\n")
  if (!isTRUE(ok)) failures <<- failures + 1L
}
error_message <- function(expr) tryCatch({
  force(expr)
  NA_character_
}, error = function(e) conditionMessage(e))

# ---- Strict validation ----
defaults <- validate_seurat_pipeline_parameters(list())
check("an absent seed takes the fixed default, not a random draw", identical(defaults$seed, 42L))
check("defaults mirror the Node contract", identical(defaults$clusterResolution, 0.8) && identical(defaults$pcaDims, 50L))
for (case in list(
  list(name = "out-of-range resolution", params = list(clusterResolution = 50)),
  list(name = "unparseable integer", params = list(pcaDims = "fifty")),
  list(name = "fractional integer", params = list(pcaDims = 10.5)),
  list(name = "unknown normalization method", params = list(normalizationMethod = "Pearson")),
  list(name = "negative seed", params = list(seed = -1)),
  list(name = "unknown parameter", params = list(clusterResolutionX = 1))
)) {
  message <- error_message(validate_seurat_pipeline_parameters(case$params))
  check(paste("refuses", case$name), !is.na(message) && grepl("pipeline parameter", message))
}
check(
  "valid values pass through unchanged",
  identical(validate_seurat_pipeline_parameters(list(clusterResolution = 1.2, umapComponents = 3))$umapComponents, 3L)
)

# ---- Core run on genes without mitochondrial names (Ensembl-style IDs) ----
set.seed(3)
counts <- matrix(rpois(400 * 300, 2), nrow = 400)
rownames(counts) <- sprintf("ENSG%011d", seq_len(400))
colnames(counts) <- paste0("cell", seq_len(300))
reader <- function(input) as(counts, "dgCMatrix")
run <- function(params) {
  path <- tempfile(fileext = ".rds")
  on.exit(unlink(path), add = TRUE)
  run_seurat_pipeline_core(params, reader, path, single_input = "fixture")
}
small <- list(
  minFeatures = 10, variableFeatures = 200, pcaDims = 10, clusterDims = 5, umapDims = 5,
  umapNeighbors = 10, minFeaturesFilter = 0, maxFeaturesFilter = 100000
)

refused <- error_message(run(c(small, list(applyQcFilter = TRUE, maxPercentMt = 5))))
check(
  "a percent.mt filter is refused when no mitochondrial genes match",
  !is.na(refused) && grepl("mitochondrial genes", refused)
)

first <- run(c(small, list(applyQcFilter = TRUE, maxPercentMt = 100)))
check("percent.mt is reported unavailable", identical(first$summary$percent_mt_available, FALSE))
check("zero mitochondrial features are counted", identical(first$summary$n_mt_features, 0L))
check("a warning explains the missing mitochondrial genes", any(grepl("No mitochondrial genes", unlist(first$warnings))))
check("the run reports its effective parameters", identical(first$effective_parameters$maxPercentMt, 100))
check("the effective seed is the fixed default", identical(first$summary$used_seed, 42L))
check(
  "effective parameters equal the validated request",
  identical(first$effective_parameters, validate_seurat_pipeline_parameters(c(small, list(applyQcFilter = TRUE, maxPercentMt = 100))))
)

second <- run(c(small, list(applyQcFilter = TRUE, maxPercentMt = 100)))
check("two runs with the default seed give identical clusters", identical(first$summary$cluster_sizes, second$summary$cluster_sizes))

refused_range <- error_message(run(c(small, list(clusterResolution = 99))))
check("an out-of-range value sent to the core returns an error, not a result", grepl("clusterResolution", refused_range))

if (failures > 0L) {
  cat(failures, "check(s) failed\n")
  quit(status = 1L)
}
cat("All pipeline parameter checks passed\n")
