#!/usr/bin/env Rscript
# Exercise the actual session helpers and handlers without starting a server.
runtime <- new.env(parent = globalenv())
plumber_file <- file.path("r-backend", "plumber.R")
sys.source(plumber_file, envir = runtime)
endpoint <- function(method, route) {
  lines <- readLines(plumber_file, warn = FALSE)
  marker <- paste0("#* @", method, " ", route)
  line <- which(trimws(lines) == marker)
  stopifnot(length(line) == 1)
  eval(parse(text = lines[(line + 1L):length(lines)], n = 1L)[[1]], runtime)
}
inspect <- endpoint("get", "/pipeline-state")
hydrate <- endpoint("post", "/object/checkpoint-load")
map_metadata <- endpoint("post", "/add-meta-mapping")
new_response <- function() new.env(parent = emptyenv())

main <- function() {
  storage_root <- tempfile("live-revision-storage-")
  dir.create(storage_root)
  prior_root <- Sys.getenv("STORAGE_ROOT", unset = NA_character_)
  Sys.setenv(STORAGE_ROOT = storage_root)
  on.exit({
    if (is.na(prior_root)) Sys.unsetenv("STORAGE_ROOT") else Sys.setenv(STORAGE_ROOT = prior_root)
    unlink(storage_root, recursive = TRUE)
  }, add = TRUE)

  set.seed(42)
  counts <- matrix(sample(1:9, 96, replace = TRUE), nrow = 8,
                   dimnames = list(paste0("Gene", 1:8), paste0("Cell", 1:12)))
  object <- Seurat::CreateSeuratObject(counts, min.cells = 0, min.features = 0)
  object$sample_id <- rep(c("C1", "C2", "T1", "T2"), each = 3)
  object$percent.mt <- 0
  key <- "projects/proj_fixture/checkpoints/job_fixture/input.rds"
  file <- runtime$validate_storage_key(key, for_write = TRUE)
  saveRDS(list(global = object, raw = object), file)
  checksum <- digest::digest(file = file, algo = "sha256")
  state_key <- "user-1:obj-analysis_a"
  request <- list(HTTP_X_OBJECT_ID = state_key, body = list(
    operation = "r.checkpoint.hydrate.v1", storage_key = key,
    expected_checksum_sha256 = checksum, expected_size_bytes = file.info(file)$size
  ))

  loaded <- hydrate(request, new_response())
  stopifnot(isTRUE(loaded$loaded))
  clean <- inspect(list(), new_response())
  stopifnot(isTRUE(clean$exists), identical(clean$has_unsaved_changes, FALSE))
  stopifnot(identical(runtime$load_active_session(state_key)$saved_revision, 0))
  revision <- clean$live_revision
  invisible(inspect(list(), new_response()))
  stopifnot(identical(runtime$live_revision, revision))

  # Invalid input leaves the clean baseline untouched.
  rejected_response <- new_response()
  rejected <- map_metadata(rejected_response, list(body = list(
    source_col = "missing", new_col = "condition", mapping = list(C1 = "control")
  )))
  stopifnot(!is.null(rejected$error), identical(rejected_response$status, 400))
  stopifnot(identical(runtime$live_session_revision_state()$has_unsaved_changes, FALSE))

  mapped <- map_metadata(new_response(), list(body = list(
    source_col = "sample_id", new_col = "condition",
    mapping = list(C1 = "control", C2 = "control", T1 = "treated", T2 = "treated")
  )))
  stopifnot(identical(mapped$live_state$has_unsaved_changes, TRUE))
  stopifnot(runtime$live_revision > revision)
  runtime$store_active_session(state_key, runtime$global_obj, runtime$raw_obj)
  dirty <- inspect(list(), new_response())
  stopifnot(isTRUE(dirty$has_unsaved_changes))

  # Selecting a different user's object cannot inherit the first object's flags.
  other_key <- "user-2:obj-analysis_b"
  runtime$restore_active_session(list(global = object, raw = object, live_revision = 0, saved_revision = 0))
  runtime$store_active_session(other_key, runtime$global_obj, runtime$raw_obj)
  stopifnot(identical(inspect(list(), new_response())$has_unsaved_changes, FALSE))
  runtime$restore_active_session(runtime$load_active_session(state_key))
  stopifnot(isTRUE(inspect(list(), new_response())$has_unsaved_changes))
  stopifnot(identical(unname(runtime$global_obj$condition), rep(c("control", "treated"), each = 6)))

  # Both integrity rejection and receipt failure preserve prior live revisions.
  bad_request <- request
  bad_request$body$expected_checksum_sha256 <- strrep("0", 64)
  bad_response <- new_response()
  bad <- hydrate(bad_request, bad_response)
  stopifnot(!is.null(bad$error), identical(bad_response$status, 500))
  stopifnot(identical(runtime$live_revision, dirty$live_revision))

  prior_cache <- as.list(runtime$active_sessions)
  prior_object <- runtime$global_obj
  receipt <- setNames(rep(list(NULL), length(runtime$COMPLETION_RECEIPT_BINDING_KEYS)),
                      runtime$COMPLETION_RECEIPT_BINDING_KEYS)
  receipt$version <- 1L
  receipt$job_id <- "job_receipt"
  receipt$project_id <- "proj_fixture"
  receipt$job_type <- "checkpoint.load.v1"
  receipt$r_operation <- "r.checkpoint.load.v1"
  receipt$source_analysis_object_id <- "analysis_a"
  receipt$source_checkpoint_artifact_id <- "artifact_fixture"
  receipt$target_analysis_object_id <- "analysis_a"
  receipt$receipt_storage_key <- "projects/proj_fixture/artifacts/job_receipt/completion-receipt.json"
  failed_request <- request
  failed_request$body$operation <- "r.checkpoint.load.v1"
  failed_request$body$completion_receipt <- receipt
  runtime$atomic_write_completion_receipt <- function(...) stop("simulated receipt failure")
  failed_response <- new_response()
  failed <- hydrate(failed_request, failed_response)
  stopifnot(!is.null(failed$error), identical(failed_response$status, 500))
  stopifnot(identical(runtime$live_revision, dirty$live_revision))
  stopifnot(identical(runtime$live_saved_revision, 0))
  stopifnot(identical(runtime$global_obj, prior_object))
  stopifnot(identical(as.list(runtime$active_sessions), prior_cache))

  # Reattaching the durable checkpoint resets only that object's baseline.
  stopifnot(isTRUE(hydrate(request, new_response())$loaded))
  stopifnot(identical(inspect(list(), new_response())$has_unsaved_changes, FALSE))
  stopifnot(!("condition" %in% colnames(runtime$global_obj@meta.data)))
  stopifnot(!is.null(runtime$load_active_session(other_key)))

  # Legacy entries are conservatively unsaved. Missing sessions have no live work.
  runtime$restore_active_session(list(global = object, raw = object))
  stopifnot(isTRUE(inspect(list(), new_response())$has_unsaved_changes))
  runtime$restore_active_session()
  stopifnot(identical(inspect(list(), new_response())$exists, FALSE))
  stopifnot(identical(runtime$live_session_revision_state()$has_unsaved_changes, FALSE))
  cat("PASS live revisions, private-session isolation, read-only inspection, checkpoint integrity, and rollback.
")
}
main()
