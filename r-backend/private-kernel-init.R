# This initializer is sourced only by the private IRkernel container. Arbitrary
# RDS inputs never enter the shared guided-analysis R process.
suppressPackageStartupMessages({ library(jsonlite); library(IRdisplay) })
options(repr.plot.width = 7, repr.plot.height = 5, repr.plot.res = 100,
        repr.matrix.max.rows = 100, repr.matrix.max.cols = 30, warn = 1)
input_manifest <- jsonlite::fromJSON('/work/input/input-manifest.json', simplifyDataFrame = TRUE)
if (!is.data.frame(input_manifest)) input_manifest <- data.frame()
input_path <- function(name_or_id) {
  if (!is.character(name_or_id) || length(name_or_id) != 1L || is.na(name_or_id)) stop('Select one input by ID or name.')
  found <- which(input_manifest$id == name_or_id | input_manifest$name == name_or_id)
  if (length(found) != 1L) stop('Input is missing or ambiguous.')
  file.path('/work/input', input_manifest$filename[[found]])
}
read_input <- function(name_or_id, ...) {
  selected <- input_path(name_or_id)
  format <- input_manifest$format[[which(file.path('/work/input', input_manifest$filename) == selected)]]
  switch(format, rds = readRDS(selected, ...), csv = utils::read.csv(selected, ...),
         tsv = utils::read.delim(selected, ...), json = jsonlite::fromJSON(selected, ...),
         txt = readLines(selected, ...), stop('Use input_path() to inspect this file with a suitable R package.'))
}
display_table <- function(value, name = NULL) {
  if (!is.data.frame(value) && !is.matrix(value)) stop('display_table expects a data frame or matrix.')
  original_rows <- nrow(value); original_columns <- ncol(value)
  value <- as.data.frame(value[seq_len(min(100L, original_rows)), seq_len(min(30L, original_columns)), drop = FALSE])
  value[] <- lapply(value, function(column) {
    if (is.factor(column)) column <- as.character(column)
    if (!is.numeric(column) && !is.character(column) && !is.logical(column)) column <- as.character(column)
    if (is.numeric(column)) column[!is.finite(column)] <- NA_real_
    if (is.character(column)) column <- substr(column, 1L, 2000L)
    column
  })
  rows <- lapply(seq_len(nrow(value)), function(i) unname(as.list(value[i, , drop = FALSE])))
  bundle <- list(columns = names(value), rows = rows,
                 truncated = original_rows > 100L || original_columns > 30L)
  if (!is.null(name)) bundle$name <- substr(as.character(name)[[1L]], 1L, 120L)
  IRdisplay::publish_mimebundle(list('application/vnd.traceomics.table+json' =
    jsonlite::toJSON(bundle, auto_unbox = TRUE, na = 'null', null = 'null')))
  invisible(value)
}
if (nrow(input_manifest)) {
  checkpoints <- which(input_manifest$role == 'checkpoint')
  if (length(checkpoints) > 1L) stop('Only one analysis checkpoint may be loaded.')
  if (length(checkpoints)) {
    suppressPackageStartupMessages(library(Seurat))
    checkpoint <- read_input(input_manifest$id[[checkpoints]])
    obj <- if (inherits(checkpoint, 'Seurat')) checkpoint else if (is.list(checkpoint) && inherits(checkpoint$global, 'Seurat')) checkpoint$global else NULL
    rm(checkpoint)
    if (is.null(obj)) stop('The selected checkpoint does not contain a Seurat object.')
  }
  input_manifest <- input_manifest[, intersect(c('id', 'versionId', 'name', 'format', 'role', 'filename', 'checksumSha256', 'sizeBytes'), names(input_manifest)), drop = FALSE]
}
setwd('/work')
