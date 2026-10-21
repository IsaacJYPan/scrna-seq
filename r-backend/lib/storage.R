resolve_analysis_path <- function(user_path) {
  if (grepl("^(/|[A-Za-z]:[/\\\\]|\\\\\\\\)", user_path)) {
    return(user_path)
  }

  analysis_root <- Sys.getenv("ANALYSIS_ROOT", unset = getwd())
  file.path(analysis_root, user_path)
}

validate_path <- function(user_path, safe_dir = "vault") {
  if (is.null(user_path) || !is.character(user_path) || length(user_path) != 1 || nchar(trimws(user_path)) == 0) {
    stop("Access denied: path is required.")
  }
  if (grepl("^(/|[A-Za-z]:[/\\\\]|\\\\\\\\)", user_path)) {
    stop("Access denied: absolute paths are not accepted.")
  }
  if (grepl("(^|[/\\\\])\\.\\.($|[/\\\\])", user_path)) {
    stop("Access denied: path traversal attempt using '..'.")
  }
  safe_dir_abs <- resolve_analysis_path(safe_dir)
  dir.create(safe_dir_abs, recursive = TRUE, showWarnings = FALSE)
  real_path <- normalizePath(resolve_analysis_path(user_path), winslash = "/", mustWork = FALSE)
  safe_real <- normalizePath(safe_dir_abs, winslash = "/", mustWork = TRUE)
  safe_prefix <- paste0(safe_real, "/")
  if (!(real_path == safe_real || startsWith(real_path, safe_prefix))) {
    stop("Access denied: path traversal attempt. Path must be within the vault.")
  }
  return(real_path)
}

storage_root_path <- function() {
  configured <- Sys.getenv("STORAGE_ROOT", unset = "")
  if (nchar(trimws(configured)) > 0) return(configured)
  analysis_root <- Sys.getenv("ANALYSIS_ROOT", unset = getwd())
  file.path(analysis_root, "data")
}

validate_storage_key <- function(storage_key, for_write = FALSE) {
  if (is.null(storage_key) || !is.character(storage_key) || length(storage_key) != 1 ||
      nchar(trimws(storage_key)) == 0) {
    stop("Access denied: storage key is required.")
  }
  if (grepl("%|\\\\|^/|^[A-Za-z]:|(^|/)\\.\\.?(/|$)", storage_key)) {
    stop("Access denied: invalid storage key.")
  }
  segments <- strsplit(storage_key, "/", fixed = TRUE)[[1]]
  allowed_kinds <- c("datasets", "artifacts", "checkpoints", "reports", "bundles", "figures")
  if (length(segments) < 5 || segments[1] != "projects" ||
      !(segments[3] %in% allowed_kinds) ||
      any(!grepl("^[A-Za-z0-9._-]+$", segments))) {
    stop("Access denied: invalid project storage key.")
  }

  root <- storage_root_path()
  dir.create(root, recursive = TRUE, showWarnings = FALSE)
  safe_root <- normalizePath(root, winslash = "/", mustWork = TRUE)
  safe_prefix <- paste0(safe_root, "/")
  cursor <- safe_root
  for (segment in head(segments, -1)) {
    next_path <- file.path(cursor, segment)
    if (!file.exists(next_path)) {
      if (!isTRUE(for_write)) stop("Storage object parent is missing.")
      if (!dir.create(next_path, recursive = FALSE, showWarnings = FALSE)) {
        stop("Unable to create durable storage directory.")
      }
    }
    if (!dir.exists(next_path)) stop("Storage path contains a non-directory entry.")
    real_next <- normalizePath(next_path, winslash = "/", mustWork = TRUE)
    if (!(real_next == safe_root || startsWith(real_next, safe_prefix))) {
      stop("Access denied: storage key escapes the durable root.")
    }
    cursor <- real_next
  }
  file.path(cursor, tail(segments, 1))
}

resolve_internal_storage_key <- function(storage_key, for_write = FALSE) {
  if (is.character(storage_key) && length(storage_key) == 1 && startsWith(storage_key, "projects/")) {
    return(validate_storage_key(storage_key, for_write = for_write))
  }
  validate_path(storage_key, "vault")
}

atomic_save_rds <- function(value, destination) {
  temp_path <- paste0(destination, ".partial-", Sys.getpid(), "-", sample.int(1000000000, 1))
  completed <- FALSE
  on.exit(if (!completed && file.exists(temp_path)) unlink(temp_path), add = TRUE)
  saveRDS(value, file = temp_path)
  if (!file.rename(temp_path, destination)) stop("Unable to finalize checkpoint file.")
  completed <- TRUE
}

atomic_write_csv <- function(value, destination) {
  temp_path <- paste0(destination, ".partial-", Sys.getpid(), "-", sample.int(1000000000, 1))
  completed <- FALSE
  on.exit(if (!completed && file.exists(temp_path)) unlink(temp_path), add = TRUE)
  write.csv(value, file = temp_path, row.names = FALSE)
  if (!file.rename(temp_path, destination)) stop("Unable to finalize result file.")
  completed <- TRUE
}

# Durable worker completion receipts -------------------------------------------------
#
# A synchronous HTTP timeout/disconnect does not prove that an R operation stopped.
# Every real worker output/live-state operation therefore writes one small signed
# receipt, only after its file or private live-state mutation has succeeded. Node can
# adopt that receipt after the bounded lease grace instead of rerunning R.
COMPLETION_RECEIPT_VERSION <- 1L
COMPLETION_RECEIPT_MAX_BYTES <- 128L * 1024L
COMPLETION_RECEIPT_SIGNED_MAX_BYTES <- 96L * 1024L
COMPLETION_RECEIPT_FILE_NAME <- "completion-receipt.json"
COMPLETION_RECEIPT_HMAC_DOMAIN <- "TRACEOMICS_R_COMPLETION_RECEIPT_V1:"
COMPLETION_RECEIPT_ALGORITHM <- "hmac-sha256"
COMPLETION_RECEIPT_BINDING_KEYS <- c(
  "version", "job_id", "job_type", "r_operation", "project_id",
  "receipt_storage_key", "source_analysis_object_id", "source_dataset_id",
  "source_checkpoint_artifact_id", "target_analysis_object_id", "output_storage_key"
)

is_scalar_string <- function(value, allow_null = FALSE) {
  if (is.null(value)) return(isTRUE(allow_null))
  is.character(value) && length(value) == 1 && !is.na(value) && nchar(value, type = "bytes") > 0
}

validate_receipt_optional_id <- function(value) {
  if (is.null(value)) return(invisible(TRUE))
  if (!is_scalar_string(value) || !grepl("^[A-Za-z0-9._-]+$", value) || nchar(value, type = "bytes") > 160) {
    stop("Completion receipt binding is invalid.")
  }
  invisible(TRUE)
}

validate_completion_receipt_binding <- function(body, expected_job_types,
                                                expected_r_operation,
                                                expected_output_key = NULL) {
  binding <- if (is.list(body)) body$completion_receipt else NULL
  if (!is.list(binding) || is.null(names(binding)) ||
      !setequal(names(binding), COMPLETION_RECEIPT_BINDING_KEYS) ||
      length(names(binding)) != length(COMPLETION_RECEIPT_BINDING_KEYS)) {
    stop("Completion receipt binding is required.")
  }
  if (!identical(as.integer(binding$version), COMPLETION_RECEIPT_VERSION) ||
      !is_scalar_string(binding$job_id) ||
      !is_scalar_string(binding$project_id) ||
      !is_scalar_string(binding$job_type) || !(binding$job_type %in% expected_job_types) ||
      !identical(binding$r_operation, expected_r_operation) ||
      !grepl("^[A-Za-z0-9._-]+$", binding$job_id) ||
      !grepl("^[A-Za-z0-9._-]+$", binding$project_id)) {
    stop("Completion receipt binding is invalid.")
  }
  expected_receipt_key <- paste0(
    "projects/", binding$project_id, "/artifacts/", binding$job_id, "/",
    COMPLETION_RECEIPT_FILE_NAME
  )
  if (!identical(binding$receipt_storage_key, expected_receipt_key)) {
    stop("Completion receipt binding is invalid.")
  }
  validate_receipt_optional_id(binding$source_analysis_object_id)
  validate_receipt_optional_id(binding$source_dataset_id)
  validate_receipt_optional_id(binding$source_checkpoint_artifact_id)
  validate_receipt_optional_id(binding$target_analysis_object_id)
  if (is.null(expected_output_key)) {
    if (!is.null(binding$output_storage_key)) stop("Completion receipt binding is invalid.")
  } else if (!is_scalar_string(binding$output_storage_key) ||
             !identical(binding$output_storage_key, expected_output_key)) {
    stop("Completion receipt binding is invalid.")
  }
  output_prefix <- paste0("projects/", binding$project_id, "/")
  if (binding$job_type %in% c("pbmc.pipeline.v1", "checkpoint.save.v1")) {
    if (is.null(binding$source_analysis_object_id) || !is.null(binding$source_dataset_id) ||
        !is.null(binding$source_checkpoint_artifact_id) || !is.null(binding$target_analysis_object_id) ||
        !startsWith(binding$output_storage_key,
                    paste0(output_prefix, "checkpoints/", binding$job_id, "/"))) {
      stop("Completion receipt binding is invalid.")
    }
  } else if (binding$job_type %in% c("seurat.pipeline.v1", "seurat.multisample.v1", "spatial.seurat.v1")) {
    if (is.null(binding$source_analysis_object_id) || is.null(binding$source_dataset_id) ||
        !is.null(binding$source_checkpoint_artifact_id) || !is.null(binding$target_analysis_object_id) ||
        !startsWith(binding$output_storage_key,
                    paste0(output_prefix, "checkpoints/", binding$job_id, "/"))) {
      stop("Completion receipt binding is invalid.")
    }
  } else if (identical(binding$job_type, "deg.find_markers.v1")) {
    if (is.null(binding$source_analysis_object_id) || !is.null(binding$source_dataset_id) ||
        !is.null(binding$source_checkpoint_artifact_id) || !is.null(binding$target_analysis_object_id) ||
        !startsWith(binding$output_storage_key,
                    paste0(output_prefix, "artifacts/", binding$job_id, "/"))) {
      stop("Completion receipt binding is invalid.")
    }
  } else if (identical(binding$job_type, "enrichment.gsea.v1")) {
    if (is.null(binding$source_analysis_object_id) || !is.null(binding$source_dataset_id) ||
        !is.null(binding$source_checkpoint_artifact_id) || !is.null(binding$target_analysis_object_id) ||
        !startsWith(binding$output_storage_key,
                    paste0(output_prefix, "artifacts/", binding$job_id, "/"))) {
      stop("Completion receipt binding is invalid.")
    }
  } else if (identical(binding$job_type, "cellchat.infer.v1")) {
    if (is.null(binding$source_analysis_object_id) || !is.null(binding$source_dataset_id) ||
        !is.null(binding$source_checkpoint_artifact_id) || !is.null(binding$target_analysis_object_id) ||
        !startsWith(binding$output_storage_key,
                    paste0(output_prefix, "artifacts/", binding$job_id, "/"))) {
      stop("Completion receipt binding is invalid.")
    }
  } else if (identical(binding$job_type, "condition.pseudobulk_de.v1")) {
    if (is.null(binding$source_analysis_object_id) || !is.null(binding$source_dataset_id) ||
        !is.null(binding$source_checkpoint_artifact_id) || !is.null(binding$target_analysis_object_id) ||
        !startsWith(binding$output_storage_key,
                    paste0(output_prefix, "artifacts/", binding$job_id, "/"))) {
      stop("Completion receipt binding is invalid.")
    }
  } else if (identical(binding$job_type, "checkpoint.load.v1")) {
    if (is.null(binding$source_analysis_object_id) || !is.null(binding$source_dataset_id) ||
        is.null(binding$source_checkpoint_artifact_id) ||
        !identical(binding$target_analysis_object_id, binding$source_analysis_object_id)) {
      stop("Completion receipt binding is invalid.")
    }
  } else if (identical(binding$job_type, "checkpoint.fork.v1")) {
    if (is.null(binding$source_analysis_object_id) || !is.null(binding$source_dataset_id) ||
        is.null(binding$source_checkpoint_artifact_id) || is.null(binding$target_analysis_object_id) ||
        identical(binding$target_analysis_object_id, binding$source_analysis_object_id)) {
      stop("Completion receipt binding is invalid.")
    }
  }
  # Resolve now, before expensive work, so an unsafe receipt destination can never
  # turn a successful operation into an unrecorded side effect.
  resolve_internal_storage_key(binding$receipt_storage_key, for_write = TRUE)
  binding
}

completion_receipt_safe_string <- function(value) {
  clean <- gsub("[^A-Za-z0-9 ._:+-]", "", enc2utf8(as.character(value)[1]))
  substr(clean, 1, 160)
}

completion_receipt_safe_value <- function(value, depth = 0L,
                                          state = new.env(parent = emptyenv())) {
  if (is.null(state$nodes)) state$nodes <- 0L
  state$nodes <- state$nodes + 1L
  if (depth > 7L || state$nodes > 6000L) stop("Completion receipt payload is too large.")
  if (is.null(value)) return(NULL)

  if (is.list(value)) {
    if (length(value) > 256L) value <- value[seq_len(256L)]
    value_names <- names(value)
    if (!is.null(value_names) && any(nzchar(value_names))) {
      if (any(!grepl("^[A-Za-z0-9._-]{1,64}$", value_names))) {
        stop("Completion receipt payload is invalid.")
      }
      return(lapply(value, completion_receipt_safe_value,
                    depth = depth + 1L, state = state))
    }
    return(lapply(unname(value), completion_receipt_safe_value,
                  depth = depth + 1L, state = state))
  }

  if (length(value) > 256L) value <- value[seq_len(256L)]
  if (length(value) > 1L) {
    return(lapply(as.list(value), completion_receipt_safe_value,
                  depth = depth + 1L, state = state))
  }
  if (length(value) == 0L || is.na(value[1])) return(NULL)
  if (is.logical(value)) return(isTRUE(value[1]))
  if (is.numeric(value) || is.integer(value)) {
    number <- as.numeric(value[1])
    if (!is.finite(number) || abs(number) > 9007199254740991) {
      stop("Completion receipt payload is invalid.")
    }
    return(number)
  }
  if (is.character(value) || is.factor(value)) return(completion_receipt_safe_string(value))
  stop("Completion receipt payload is invalid.")
}

atomic_write_completion_receipt <- function(binding, payload) {
  if (!requireNamespace("jsonlite", quietly = TRUE) ||
      !requireNamespace("digest", quietly = TRUE)) {
    stop("Completion receipt dependencies are unavailable.")
  }
  token <- Sys.getenv("API_TOKEN", unset = "")
  if (!is_scalar_string(token)) stop("Completion receipt signing is unavailable.")
  safe_payload <- completion_receipt_safe_value(payload)
  receipt <- c(binding, list(payload = safe_payload))
  signed_receipt <- jsonlite::toJSON(
    receipt, auto_unbox = TRUE, null = "null", na = "null", digits = NA
  )
  signed_bytes <- nchar(enc2utf8(signed_receipt), type = "bytes")
  if (signed_bytes <= 0 || signed_bytes > COMPLETION_RECEIPT_SIGNED_MAX_BYTES) {
    stop("Completion receipt payload is too large.")
  }
  signature <- digest::hmac(
    key = token,
    object = paste0(COMPLETION_RECEIPT_HMAC_DOMAIN, signed_receipt),
    algo = "sha256",
    serialize = FALSE
  )
  envelope <- list(
    algorithm = COMPLETION_RECEIPT_ALGORITHM,
    signed_receipt = signed_receipt,
    signature = signature
  )
  envelope_json <- jsonlite::toJSON(
    envelope, auto_unbox = TRUE, null = "null", na = "null", digits = NA
  )
  envelope_raw <- charToRaw(enc2utf8(envelope_json))
  if (length(envelope_raw) <= 0L || length(envelope_raw) > COMPLETION_RECEIPT_MAX_BYTES) {
    stop("Completion receipt is too large.")
  }

  destination <- resolve_internal_storage_key(binding$receipt_storage_key, for_write = TRUE)
  if (file.exists(destination)) stop("Completion receipt already exists.")
  temp_path <- paste0(destination, ".partial-", Sys.getpid(), "-", sample.int(1000000000, 1))
  completed <- FALSE
  con <- NULL
  on.exit({
    if (!is.null(con)) try(close(con), silent = TRUE)
    if (!completed && file.exists(temp_path)) unlink(temp_path)
  }, add = TRUE)
  con <- file(temp_path, open = "wb")
  writeBin(envelope_raw, con)
  flush(con)
  close(con)
  con <- NULL
  if (!file.rename(temp_path, destination)) stop("Unable to finalize completion receipt.")
  completed <- TRUE
  invisible(destination)
}

validate_absolute_path <- function(user_path) {
  if (grepl("(^|[/\\\\])\\.\\.(|[/\\\\]|$)", user_path)) stop("Access denied: path traversal attempt using '..'")
  is_absolute <- grepl("^(/|[A-Za-z]:[/\\\\]|\\\\\\\\)", user_path)
  if (!is_absolute) stop("Access denied: path must be absolute")
  return(user_path)
}
