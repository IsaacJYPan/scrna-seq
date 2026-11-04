# Standalone Seurat pipeline runner for cluster (Slurm) execution.
#
# Usage: Rscript hpc-runner.R <run_dir>
#   <run_dir>/params.json   validated pipeline parameters (from the server)
#   <run_dir>/inputs.json   [{ "file": "input/<name>.h5", "sample_name": ..., "condition_name": ..., ... }]
#   <run_dir>/output/       checkpoint.rds and result.json are written here
#
# The server stages this script and lib/seuratPipelineCore.R with each run, so
# the cluster executes the same analysis code as the R service.

args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 1L) stop("Usage: Rscript hpc-runner.R <run_dir>")
run_dir <- normalizePath(args[[1L]], mustWork = TRUE)
script_dir <- dirname(normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE)[[1L]])))

suppressPackageStartupMessages({
  library(Seurat)
  library(jsonlite)
})
if (!requireNamespace("hdf5r", quietly = TRUE)) stop("R package 'hdf5r' is required to read 10x HDF5 inputs.")
source(file.path(script_dir, "lib", "seuratPipelineCore.R"))

params <- jsonlite::fromJSON(file.path(run_dir, "params.json"), simplifyVector = FALSE)
inputs <- jsonlite::fromJSON(file.path(run_dir, "inputs.json"), simplifyVector = FALSE)
if (!is.list(inputs) || length(inputs) < 1L) stop("No inputs were staged.")

resolve_input <- function(relative) {
  if (!is.character(relative) || length(relative) != 1L || grepl("(^/|\\.\\.)", relative)) stop("Invalid staged input path.")
  path <- normalizePath(file.path(run_dir, relative), mustWork = TRUE)
  if (!startsWith(path, paste0(run_dir, "/"))) stop("Staged input escapes the run directory.")
  path
}
read_gene_expression <- function(relative) {
  mat <- Read10X_h5(filename = resolve_input(relative))
  if (is.list(mat)) {
    if ("Gene Expression" %in% names(mat)) mat <- mat[["Gene Expression"]] else mat <- mat[[1]]
  }
  mat
}

output_dir <- file.path(run_dir, "output")
dir.create(output_dir, showWarnings = FALSE)
multi_sample <- length(inputs) > 1L
result <- run_seurat_pipeline_core(
  params, read_gene_expression,
  output_path = file.path(output_dir, "checkpoint.rds"),
  single_input = if (multi_sample) NULL else inputs[[1L]]$file,
  dataset_inputs = if (multi_sample) lapply(inputs, function(input) c(input, list(storage_key = input$file))) else NULL,
  sample_names = if (multi_sample) vapply(inputs, function(input) as.character(input$sample_name), character(1)) else NULL,
  condition_names = if (multi_sample) vapply(inputs, function(input) as.character(input$condition_name), character(1)) else NULL
)
tmp <- file.path(output_dir, "result.json.tmp")
writeLines(jsonlite::toJSON(result, auto_unbox = TRUE, null = "null", digits = NA), tmp)
file.rename(tmp, file.path(output_dir, "result.json"))
cat("TRACEOMICS_RUNNER_DONE\n")
