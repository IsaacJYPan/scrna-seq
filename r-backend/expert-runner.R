# Ephemeral expert-R sandbox entrypoint. This file runs only inside a fresh,
# no-network container with a job-private /work mount. It is never sourced by
# the trusted stateful Plumber runtimes.
suppressPackageStartupMessages({
  library(Seurat)
  library(Matrix)
  library(jsonlite)
})

work_dir <- "/work"
input_path <- file.path(work_dir, "input", "checkpoint.rds")
script_path <- file.path(work_dir, "input", "analysis.R")
output_dir <- file.path(work_dir, "output")
private_input_dir <- file.path(work_dir, "input", "files")
private_input_manifest_path <- file.path(work_dir, "input", "input-manifest.json")
dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)
if (!file.exists(input_path) || !file.exists(script_path)) stop("Sandbox input is incomplete.")

empty_input_manifest <- data.frame(
  id = character(), name = character(), filename = character(),
  sizeBytes = numeric(), checksumSha256 = character(), stringsAsFactors = FALSE
)
input_manifest <- if (file.exists(private_input_manifest_path)) {
  parsed_manifest <- jsonlite::fromJSON(private_input_manifest_path, simplifyDataFrame = TRUE)
  if (is.data.frame(parsed_manifest)) parsed_manifest else empty_input_manifest
} else empty_input_manifest
input_path_for <- function(name_or_id) {
  if (!is.character(name_or_id) || length(name_or_id) != 1L || is.na(name_or_id)) {
    stop("Select one imported input by file name or input ID.")
  }
  matches <- which(input_manifest$id == name_or_id | input_manifest$name == name_or_id)
  if (length(matches) != 1L) stop("Selected input file is missing or ambiguous.")
  candidate <- file.path(private_input_dir, input_manifest$filename[[matches]])
  if (!file.exists(candidate)) stop("Selected input file is missing.")
  candidate
}
read_input <- function(name_or_id, ...) {
  selected <- input_path_for(name_or_id)
  extension <- tolower(tools::file_ext(selected))
  if (extension == "csv") return(utils::read.csv(selected, ...))
  if (extension == "tsv") return(utils::read.delim(selected, ...))
  if (extension == "json") return(jsonlite::fromJSON(selected, ...))
  if (extension == "txt") return(readLines(selected, ...))
  stop("Selected input type is not supported.")
}

bundle <- readRDS(input_path)
obj <- if (inherits(bundle, "Seurat")) bundle else if (is.list(bundle) && inherits(bundle$global, "Seurat")) bundle$global else NULL
if (is.null(obj)) stop("Checkpoint does not contain a Seurat object.")

safe_output_path <- function(file_name) {
  if (!is.character(file_name) || length(file_name) != 1L ||
      !grepl("^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$", file_name) ||
      grepl("\\.\\.", file_name, fixed = TRUE)) stop("Invalid output file name.")
  file.path(output_dir, file_name)
}
write_table <- function(value, file_name) {
  path <- safe_output_path(file_name)
  utils::write.csv(value, path, row.names = FALSE)
  invisible(path)
}
save_figure <- function(plot, file_name, width = 7, height = 5, dpi = 300) {
  if (!is.numeric(width) || width < 1 || width > 16 ||
      !is.numeric(height) || height < 1 || height > 16 ||
      !is.numeric(dpi) || dpi < 72 || dpi > 600) stop("Invalid figure dimensions.")
  path <- safe_output_path(file_name)
  ggplot2::ggsave(path, plot = plot, width = width, height = height, dpi = dpi, limitsize = TRUE)
  invisible(path)
}

analysis_environment <- new.env(parent = globalenv())
analysis_environment$obj <- obj
analysis_environment$output_dir <- output_dir
analysis_environment$input_manifest <- input_manifest[, intersect(c("id", "name", "sizeBytes", "checksumSha256"), names(input_manifest)), drop = FALSE]
analysis_environment$input_path <- input_path_for
analysis_environment$read_input <- read_input
analysis_environment$write_table <- write_table
analysis_environment$save_figure <- save_figure
source(script_path, local = analysis_environment, echo = FALSE, chdir = FALSE,
       encoding = "UTF-8")

# The untrusted container receives no writable path outside output_dir. The broker
# independently enumerates, bounds, and archives that directory after the process exits.
