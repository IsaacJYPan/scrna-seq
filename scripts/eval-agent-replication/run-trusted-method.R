# Runs one trusted library method (trusted-methods/) outside the app, for
# offline evaluations. It provides what the app's workflow-package wrapper
# provides: `inputs$analysis`, typed `params` (catalog defaults overridden by
# key=value arguments), `seed`, and `write_output()` for the declared
# outputs. The method's R file is used as is.
#
#   Rscript run-trusted-method.R <method-key> <analysis.rds> <out-dir> [key=value ...]
#
# Tables are written as CSV, figures as PNG, metrics as JSON, analyses as RDS.
suppressPackageStartupMessages({ library(Seurat); library(jsonlite) })
args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 3) stop("usage: run-trusted-method.R <method-key> <analysis.rds> <out-dir> [key=value ...]")
script_dir <- dirname(normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))))
library_dir <- normalizePath(file.path(script_dir, "..", "..", "trusted-methods"))
catalog <- fromJSON(file.path(library_dir, "catalog.json"), simplifyVector = FALSE)
method <- Filter(function(m) identical(m$key, args[[1]]), catalog$methods)
if (!length(method)) stop("No trusted method named ", args[[1]])
method <- method[[1]]
out_dir <- args[[3]]
dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)

params <- list()
for (p in method$parameters) params[[p$key]] <- p$default
for (assignment in args[-(1:3)]) {
  key <- sub("=.*$", "", assignment)
  value <- sub("^[^=]*=", "", assignment)
  spec <- Filter(function(p) identical(p$key, key), method$parameters)
  if (!length(spec)) stop("Unknown parameter for ", method$key, ": ", key)
  spec <- spec[[1]]
  params[[key]] <- switch(spec$type,
    integer = { v <- as.integer(value); if (is.na(v) || v < spec$min || v > spec$max) stop(key, " must be an integer from ", spec$min, " to ", spec$max); v },
    number = { v <- as.numeric(value); if (is.na(v) || v < spec$min || v > spec$max) stop(key, " must be from ", spec$min, " to ", spec$max); v },
    choice = { if (!value %in% unlist(spec$options)) stop(key, " must be one of ", paste(unlist(spec$options), collapse = ", ")); value },
    value)
}
seed <- if (!is.null(params$seed)) as.integer(params$seed) else 1L
inputs <- list(analysis = readRDS(args[[2]]))

write_output <- function(name, value, width = 8, height = 6) {
  spec <- method$outputs[[name]]
  if (is.null(spec)) stop("Undeclared output: ", name)
  path <- file.path(out_dir, name)
  switch(spec$type,
    rds = saveRDS(value, paste0(path, ".rds")),
    table = utils::write.csv(value, paste0(path, ".csv"), row.names = FALSE),
    metrics = writeLines(toJSON(value, auto_unbox = TRUE, pretty = TRUE, digits = NA), paste0(path, ".json")),
    figure = ggplot2::ggsave(paste0(path, ".png"), value, width = width, height = height, dpi = 120, limitsize = FALSE),
    stop("Unsupported output type: ", spec$type))
  invisible(NULL)
}

for (pkg in unlist(method$packages)) suppressPackageStartupMessages(library(pkg, character.only = TRUE))
source(file.path(library_dir, method$entry), local = TRUE)
cat("trusted method", method$key, method$version, "wrote", paste(list.files(out_dir), collapse = ", "), "\n")
