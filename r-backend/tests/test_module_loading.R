# Rscript r-backend/tests/test_module_loading.R
args <- commandArgs(trailingOnly = FALSE)
script <- sub("^--file=", "", grep("^--file=", args, value = TRUE)[1L])
backend_dir <- dirname(dirname(normalizePath(script, mustWork = TRUE)))
plumber_file <- file.path(backend_dir, "plumber.R")
repo_dir <- dirname(backend_dir)
original_wd <- getwd()
temporary_wd <- tempfile("plumber-module-loading-")
dir.create(temporary_wd)

required_helpers <- c(
  "make_provenance", "store_active_session", "authenticate_internal_request",
  "validate_storage_key", "atomic_write_completion_receipt",
  "public_compute_admission", "normalize_enrichment_gsea_params",
  "run_cellchat_inference_analysis", "normalize_condition_pseudobulk_design"
)

tryCatch({
  for (directory in c(repo_dir, backend_dir, temporary_wd)) {
    setwd(directory)
    runtime <- new.env(parent = globalenv())
    sys.source(plumber_file, envir = runtime)
    stopifnot(all(vapply(required_helpers, function(name) {
      exists(name, envir = runtime, inherits = FALSE) &&
        is.function(runtime[[name]]) && identical(environment(runtime[[name]]), runtime)
    }, logical(1))))
    stopifnot(is.environment(runtime$active_sessions))
    stopifnot(length(ls(envir = runtime$active_sessions)) == 0L)
    stopifnot(identical(runtime$live_revision, 0))
  }

  # Plumber changes cwd while evaluating source blocks, unlike sys.source().
  setwd(temporary_wd)
  suppressPackageStartupMessages(library(plumber))
  router <- plumber::plumb(plumber_file)
  spec <- router$getApiSpec()
  annotations <- grep("^#\\* @(get|post|put|delete|patch) ",
                      readLines(plumber_file, warn = FALSE), value = TRUE)
  routes <- sub("^#\\* @[^ ]+ ", "", annotations)
  stopifnot(all(routes %in% names(spec$paths)))
}, finally = {
  setwd(original_wd)
  unlink(temporary_wd, recursive = TRUE)
})

cat("Plumber helper loading and route registration tests passed.\n")
