# ── R Plumber API for scRNA-seq with Seurat v5 ────────
# Every endpoint wraps its result in a provenance envelope
# 
# Note: In production, Seurat must be installed.

library(Seurat)
library(dplyr)
library(Matrix)
library(ggplot2)

# ── Session ID ────────────────────────────────────────────────────
# Generated fresh on every R process start. Used by the frontend to
# detect restarts so cached pipeline steps are re-executed in R.
r_runtime_instance_id <- paste0(format(Sys.time(), "%Y%m%d%H%M%S"), "-",
                                paste0(sample(c(letters, 0:9), 16, replace = TRUE), collapse = ""))
r_session_id <- r_runtime_instance_id
cat("[R] Session ID:", r_session_id, "\n")

# Holds the physical Seurat object for stateful processing
global_obj <- NULL
# Holds the unfiltered starting point for the current object (for non-destructive QC re-runs)
raw_obj <- NULL

# ── Helper: generate a provenance envelope ────────────────────────
make_provenance <- function(result, script_text, operation = "unknown",
                            packages_used = c("Seurat"), parameters = list()) {
  list(
    provenance = list(
      id = paste0("prov-", format(Sys.time(), "%Y%m%d%H%M%S"), "-", sample(1000:9999, 1)),
      timestamp = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
      language = "R",
      languageVersion = paste0(R.version$major, ".", R.version$minor),
      packages = packages_used,
      script = script_text,
      parameters = parameters,
      operation = operation
    ),
    result = result
  )
}

# ── Validation Helpers ──────────────────────────────────────────────

# Figure-export format whitelist. `format` is used as the output filename
# extension in /export-figure, so it must be one of these exact values and must
# never be coerced from arbitrary input — otherwise a value like
# "png/../../tmp/evil" would inject a path component into the filename. This is
# the single source of truth shared by the endpoint and its regression test.
ALLOWED_EXPORT_FORMATS <- c("png", "pdf", "svg")

is_allowed_export_format <- function(format) {
  is.character(format) && length(format) == 1 && !is.na(format) && (format %in% ALLOWED_EXPORT_FORMATS)
}

unsupported_export_format_message <- function() {
  paste0("Unsupported export format. Allowed formats: ",
         paste(ALLOWED_EXPORT_FORMATS, collapse = ", "), ".")
}

classify_seurat_pipeline_error <- function(e) {
  msg <- conditionMessage(e)
  if (grepl("hdf5r", msg, ignore.case = TRUE)) return("missing_hdf5r")
  if (grepl("Dataset file not found", msg, fixed = TRUE)) return("dataset_not_found")
  if (grepl("Access denied", msg, fixed = TRUE)) return("storage_access_denied")
  if (grepl("QC filtering would leave fewer than 3 cells", msg, fixed = TRUE)) return("qc_filter_empty")
  if (grepl("Insufficient cells/features for PCA", msg, fixed = TRUE)) return("insufficient_pca_input")
  if (grepl("Insufficient cells for UMAP", msg, fixed = TRUE)) return("insufficient_umap_input")
  "pipeline_failed"
}

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
COMPLETION_RECEIPT_HMAC_DOMAIN <- "BENCHONE_R_COMPLETION_RECEIPT_V1:"
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
  if (identical(binding$job_type, "pbmc.pipeline.v1")) {
    if (is.null(binding$source_analysis_object_id) || !is.null(binding$source_dataset_id) ||
        !is.null(binding$source_checkpoint_artifact_id) || !is.null(binding$target_analysis_object_id) ||
        !startsWith(binding$output_storage_key,
                    paste0(output_prefix, "checkpoints/", binding$job_id, "/"))) {
      stop("Completion receipt binding is invalid.")
    }
  } else if (identical(binding$job_type, "seurat.pipeline.v1")) {
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

# ── Session Management ──────────────────────────────────────────────
active_sessions <- new.env(parent = emptyenv())
active_session_clock <- 0

session_limit_number <- function(name, default_value) {
  raw <- Sys.getenv(name, unset = "")
  parsed <- suppressWarnings(as.numeric(raw))
  if (length(parsed) != 1 || is.na(parsed) || !is.finite(parsed) || parsed < 1) {
    return(as.numeric(default_value))
  }
  floor(parsed)
}

active_session_limits <- function() {
  list(
    global_count = session_limit_number("R_MAX_ACTIVE_SESSIONS", 8),
    per_user_count = session_limit_number("R_MAX_ACTIVE_SESSIONS_PER_USER", 4),
    global_bytes = session_limit_number("R_MAX_ACTIVE_SESSION_BYTES", 4 * 1024^3),
    per_user_bytes = session_limit_number("R_MAX_ACTIVE_SESSION_BYTES_PER_USER", 2 * 1024^3),
    per_session_bytes = session_limit_number("R_MAX_ACTIVE_SESSION_BYTES_PER_SESSION", 1024^3)
  )
}

validate_internal_state_key <- function(value, allow_missing = FALSE) {
  if (is.null(value) || (is.character(value) && length(value) == 1 && nchar(value) == 0)) {
    if (isTRUE(allow_missing)) return(NULL)
    stop("Invalid internal R state key.")
  }
  if (!is.character(value) || length(value) != 1 || is.na(value) ||
      nchar(value, type = "bytes") > 160 ||
      !grepl("^user-[0-9]+(:obj-[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$", value)) {
    stop("Invalid internal R state key.")
  }
  value
}

active_session_owner <- function(sid) sub(":.*$", "", sid)

active_session_size_bytes <- function(global_value, raw_value) {
  global_size <- if (is.null(global_value)) 0 else as.numeric(object.size(global_value))
  raw_size <- if (is.null(raw_value)) 0 else as.numeric(object.size(raw_value))
  size <- global_size + raw_size
  if (!is.finite(size) || size < 0) stop("Live R session size could not be measured safely.")
  size
}

next_active_session_access <- function() {
  active_session_clock <<- active_session_clock + 1
  active_session_clock
}

session_entry_size <- function(entry) {
  if (is.list(entry) && is.numeric(entry$size_bytes) && length(entry$size_bytes) == 1 &&
      is.finite(entry$size_bytes) && entry$size_bytes >= 0) {
    return(as.numeric(entry$size_bytes))
  }
  active_session_size_bytes(entry$global, entry$raw)
}

session_entry_access <- function(entry) {
  if (is.list(entry) && is.numeric(entry$last_access) && length(entry$last_access) == 1 &&
      is.finite(entry$last_access)) return(as.numeric(entry$last_access))
  0
}

active_session_keys_for_owner <- function(owner) {
  keys <- ls(envir = active_sessions, all.names = TRUE)
  keys[vapply(keys, function(key) identical(active_session_owner(key), owner), logical(1))]
}

active_session_total_bytes <- function(keys = ls(envir = active_sessions, all.names = TRUE)) {
  if (length(keys) == 0) return(0)
  sum(vapply(keys, function(key) session_entry_size(active_sessions[[key]]), numeric(1)))
}

lru_active_session_key <- function(keys) {
  if (length(keys) == 0) return(NULL)
  access <- vapply(keys, function(key) session_entry_access(active_sessions[[key]]), numeric(1))
  keys[order(access, keys)][1]
}

store_active_session <- function(sid, global_value, raw_value) {
  sid <- validate_internal_state_key(sid)
  # Never retain empty attacker-selected keys. A key begins consuming cache
  # capacity only after it holds an actual live analysis object.
  if (is.null(global_value) && is.null(raw_value)) {
    if (exists(sid, envir = active_sessions, inherits = FALSE)) {
      rm(list = sid, envir = active_sessions)
    }
    return(invisible(FALSE))
  }

  limits <- active_session_limits()
  owner <- active_session_owner(sid)
  size_bytes <- active_session_size_bytes(global_value, raw_value)
  if (size_bytes > limits$per_session_bytes || size_bytes > limits$per_user_bytes ||
      size_bytes > limits$global_bytes) {
    stop("Live R session exceeds configured memory capacity.")
  }

  # Plan every eviction against a snapshot before mutating the environment. An
  # oversized replacement or failed admission must leave the prior live object
  # and every would-be eviction victim exactly intact.
  remaining_keys <- setdiff(ls(envir = active_sessions, all.names = TRUE), sid)
  victims <- character()
  owner_keys <- remaining_keys[vapply(
    remaining_keys,
    function(key) identical(active_session_owner(key), owner),
    logical(1)
  )]
  while (length(owner_keys) + 1 > limits$per_user_count ||
         active_session_total_bytes(owner_keys) + size_bytes > limits$per_user_bytes) {
    victim <- lru_active_session_key(owner_keys)
    if (is.null(victim)) {
      stop("Live R session exceeds configured per-user capacity.")
    }
    victims <- c(victims, victim)
    remaining_keys <- setdiff(remaining_keys, victim)
    owner_keys <- setdiff(owner_keys, victim)
  }

  while (length(remaining_keys) + 1 > limits$global_count ||
         active_session_total_bytes(remaining_keys) + size_bytes > limits$global_bytes) {
    victim <- lru_active_session_key(remaining_keys)
    if (is.null(victim)) {
      stop("Live R session exceeds configured global capacity.")
    }
    victims <- c(victims, victim)
    remaining_keys <- setdiff(remaining_keys, victim)
  }

  replacement <- list(
    global = global_value,
    raw = raw_value,
    owner = owner,
    size_bytes = size_bytes,
    last_access = next_active_session_access()
  )
  impacted <- unique(c(sid, victims))
  prior <- lapply(impacted, function(key) {
    if (exists(key, envir = active_sessions, inherits = FALSE)) active_sessions[[key]] else NULL
  })
  names(prior) <- impacted
  tryCatch({
    for (victim in unique(victims)) rm(list = victim, envir = active_sessions)
    active_sessions[[sid]] <- replacement
  }, error = function(commit_error) {
    for (key in impacted) {
      if (exists(key, envir = active_sessions, inherits = FALSE)) {
        rm(list = key, envir = active_sessions)
      }
      if (!is.null(prior[[key]])) active_sessions[[key]] <- prior[[key]]
    }
    stop(commit_error)
  })
  invisible(TRUE)
}

load_active_session <- function(sid) {
  sid <- validate_internal_state_key(sid)
  if (!exists(sid, envir = active_sessions, inherits = FALSE)) return(NULL)
  entry <- active_sessions[[sid]]
  entry$last_access <- next_active_session_access()
  entry$size_bytes <- session_entry_size(entry)
  entry$owner <- active_session_owner(sid)
  active_sessions[[sid]] <- entry
  entry
}

request_has_valid_api_token <- function(req) {
  expected_token <- Sys.getenv("API_TOKEN")
  provided_token <- req$HTTP_X_API_TOKEN
  is.character(expected_token) && length(expected_token) == 1 && nchar(expected_token) > 0 &&
    is.character(provided_token) && length(provided_token) == 1 &&
    identical(provided_token, expected_token)
}

authenticate_internal_request <- function(req, res) {
  if (!request_has_valid_api_token(req)) {
    res$status <- 403
    return(FALSE)
  }
  req$benchone_authenticated <- TRUE
  TRUE
}

#* @plumber
function(pr) {
  pr %>% pr_hook("postroute", function(req, res) {
    if (!isTRUE(req$benchone_authenticated) ||
        !isTRUE(req$benchone_session_loaded) ||
        !isTRUE(req$benchone_session_persist)) return(invisible(NULL))
    sid <- validate_internal_state_key(req$HTTP_X_OBJECT_ID)
    # Save only through the global/per-user count and byte budget.
    store_active_session(sid, global_obj, raw_obj)
    invisible(NULL)
  })
}

#* @filter session_loader
function(req, res) {
  req$benchone_session_loaded <- FALSE
  req$benchone_session_persist <- FALSE
  # Authenticate before even reading an attacker-selected session key. This is
  # deliberately duplicated with the auth filter so filter declaration order
  # cannot make OPTIONS or a rejected request allocate cache entries.
  if (!authenticate_internal_request(req, res)) {
    return(list(error = "Unauthorized: Invalid or missing API token"))
  }
  sid <- tryCatch(
    validate_internal_state_key(req$HTTP_X_OBJECT_ID, allow_missing = TRUE),
    error = identity
  )
  if (inherits(sid, "error")) {
    res$status <- 400
    return(list(error = "Invalid internal R state key"))
  }
  # Health/readiness calls omit X-Object-ID and never consume live-state cache.
  if (is.null(sid)) {
    global_obj <<- NULL
    raw_obj <<- NULL
    req$benchone_session_loaded <- TRUE
    return(plumber::forward())
  }

  sess <- load_active_session(sid)
  if (!is.null(sess)) {
    global_obj <<- sess$global
    raw_obj <<- sess$raw
  } else {
    global_obj <<- NULL
    raw_obj <<- NULL
  }
  req$benchone_session_loaded <- TRUE
  req$benchone_session_persist <- TRUE
  plumber::forward()
}

# ── API Token Authentication Filter ─────────────────────────────────
#* @filter auth
function(req, res) {
  # The private R service is called only by Express/the worker, not browsers;
  # OPTIONS therefore requires the same service token as every other method.
  if (!authenticate_internal_request(req, res)) {
    return(list(error = "Unauthorized: Invalid or missing API token"))
  }
  plumber::forward()
}

# ── Plumber API ───────────────────────────────────────────────────

#* @filter cors
function(req, res) {
  # In a production app you might restrict this further, but the Auth token provides the real security
  res$setHeader("Access-Control-Allow-Origin", "http://localhost:5173")
  res$setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res$setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Token, X-Object-ID")
  if (req$REQUEST_METHOD == "OPTIONS") {
    res$status <- 200
    return(list())
  }
  plumber::forward()
}

#* Health check
#* @get /health
function(res) {
  package_available <- function(pkg) {
    requireNamespace(pkg, quietly = TRUE)
  }
  list(
    status = "ok",
    timestamp = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
    mode = "R/Seurat runtime connected",
    r_version = as.character(getRversion()),
    r_home = R.home(),
    packages = list(
      Seurat = package_available("Seurat"),
      dplyr = package_available("dplyr"),
      harmony = package_available("harmony"),
      CellChat = package_available("CellChat"),
      plumber = package_available("plumber"),
      jsonlite = package_available("jsonlite"),
      ggplot2 = package_available("ggplot2")
    )
  )
}

MAX_PLOT_FEATURES <- 50L
MAX_QC_DISTRIBUTION_VALUES <- 5000L
MAX_PLOT_PIXELS <- 8000000
MAX_PUBLIC_CELL_VALUES <- 20000L
MAX_PUBLIC_GENE_LIST <- 50000L
MAX_PUBLIC_CLUSTERS <- 200L
MAX_DOT_PLOT_GENES <- 50L
MAX_HEATMAP_GENES <- 200L
MAX_HEATMAP_CELLS <- 5000L
MAX_PUBLIC_GENE_NAME_CHARS <- 256L
MAX_PUBLIC_LABEL_CHARS <- 128L
MAX_PUBLIC_GENE_LIST_BYTES <- 2000000L
MAX_REGRESSION_VARIABLES <- 10L
MAX_PUBLIC_PARAMETER_NAME_CHARS <- 128L
MAX_NORMALIZE_SCALE_FACTOR <- 1000000L
MAX_VARIABLE_FEATURES <- 10000L
MAX_REDUCTION_DIMS <- 100L
MAX_CLUSTER_RESOLUTION <- 5
MAX_PUBLIC_PCA_FEATURES <- 10000L
MAX_PUBLIC_BATCHES <- 100L
MAX_PUBLIC_METADATA_COLUMNS <- 64L
MAX_PUBLIC_METADATA_VALUES <- 1000L
MAX_PUBLIC_MAPPING_ENTRIES <- 1000L
MAX_PUBLIC_OBJECT_BYTES <- 512 * 1024 * 1024
MAX_PUBLIC_DENSE_VALUES <- 50000000

# Public browser-driven R operations are synchronous and can duplicate large
# matrices or construct large neighbor graphs. Objects beyond this conservative
# live-compute ceiling must use a durable queued job/artifact path instead.
MAX_PUBLIC_SYNC_CELLS <- 100000L
MAX_PUBLIC_SYNC_FEATURES <- 100000L

bounded_plot_number <- function(value, default, minimum, maximum) {
  parsed <- suppressWarnings(as.numeric(value))
  if (length(parsed) != 1 || is.na(parsed) || !is.finite(parsed)) return(default)
  min(max(parsed, minimum), maximum)
}

bounded_plot_features <- function(value) {
  if (is.null(value) || length(value) == 0) return(NULL)
  head(as.character(unlist(value, use.names = FALSE)), MAX_PLOT_FEATURES)
}

bounded_sample_indices <- function(total, maximum = MAX_QC_DISTRIBUTION_VALUES) {
  total <- suppressWarnings(as.integer(total))
  maximum <- suppressWarnings(as.integer(maximum))
  if (length(total) != 1 || is.na(total) || total <= 0
      || length(maximum) != 1 || is.na(maximum) || maximum <= 0) return(integer())
  if (total <= maximum) return(seq_len(total))
  unique(as.integer(round(seq(1, total, length.out = maximum))))
}

plot_pixel_budget_ok <- function(width, height, resolution) {
  is.finite(width) && is.finite(height) && is.finite(resolution) &&
    (width * height * resolution * resolution) <= MAX_PLOT_PIXELS
}

public_bounded_integer <- function(value, name, minimum, maximum) {
  parsed <- suppressWarnings(as.numeric(value))
  if (length(parsed) != 1 || is.na(parsed) || !is.finite(parsed)
      || parsed != trunc(parsed) || parsed < minimum || parsed > maximum) {
    stop(paste0(name, " must be a whole number from ", minimum, " to ", maximum, "."))
  }
  as.integer(parsed)
}

public_bounded_number <- function(value, name, minimum, maximum) {
  parsed <- suppressWarnings(as.numeric(value))
  if (length(parsed) != 1 || is.na(parsed) || !is.finite(parsed)
      || parsed < minimum || parsed > maximum) {
    stop(paste0(name, " must be a finite number from ", minimum, " to ", maximum, "."))
  }
  parsed
}

public_choice <- function(value, name, allowed) {
  if (!is.atomic(value) || length(value) != 1 || is.na(value)) {
    stop(paste0(name, " must be one of: ", paste(allowed, collapse = ", "), "."))
  }
  parsed <- as.character(value)
  if (!(parsed %in% allowed)) {
    stop(paste0(name, " must be one of: ", paste(allowed, collapse = ", "), "."))
  }
  parsed
}

public_optional_seed <- function(value) {
  if (is.null(value) || length(value) == 0) return(NULL)
  if (length(value) == 1 && !is.na(value) && identical(trimws(as.character(value)), "")) return(NULL)
  public_bounded_integer(value, "seed", 0, .Machine$integer.max - 1L)
}

public_scalar_text <- function(value, name, maximum_chars = MAX_PUBLIC_PARAMETER_NAME_CHARS) {
  if (!is.atomic(value) || length(value) != 1L || is.na(value)) {
    stop(paste0(name, " must be one text value."))
  }
  parsed <- as.character(value)
  if (!nzchar(trimws(parsed))
      || nchar(parsed, type = "chars") > maximum_chars
      || grepl("[[:cntrl:]]", parsed)) {
    stop(paste0(name, " must be non-empty, contain no control characters, and be no longer than ",
                maximum_chars, " characters."))
  }
  parsed
}

public_metadata_column <- function(object, value, name = "column") {
  parsed <- public_scalar_text(value, name)
  columns <- tryCatch(colnames(object@meta.data), error = function(e) character())
  if (!(parsed %in% columns)) stop(paste0(name, " was not found in object metadata."))
  parsed
}

public_gene_identifier <- function(value, name = "gene") {
  if (!is.atomic(value) || length(value) != 1 || is.na(value)) {
    stop(paste0(name, " must be a single gene identifier."))
  }
  parsed <- as.character(value)
  if (nchar(trimws(parsed), type = "chars") == 0
      || nchar(parsed, type = "chars") > MAX_PUBLIC_GENE_NAME_CHARS
      || grepl("[[:cntrl:]]", parsed)) {
    stop(paste0(name, " must be a non-empty gene identifier no longer than ",
                MAX_PUBLIC_GENE_NAME_CHARS, " characters."))
  }
  parsed
}

bounded_public_labels <- function(value, maximum_chars = MAX_PUBLIC_LABEL_CHARS) {
  labels <- as.character(value)
  labels[is.na(labels)] <- ""
  labels <- gsub("[[:cntrl:]]", "", labels)
  substring(labels, 1L, maximum_chars)
}

public_identity_levels <- function(idents) {
  values <- as.character(idents)
  observed <- unique(values[!is.na(values)])
  declared <- levels(idents)
  if (is.null(declared)) return(observed)
  c(declared[declared %in% observed], setdiff(observed, declared))
}

bounded_public_gene_names <- function(value,
                                      maximum = MAX_PUBLIC_GENE_LIST,
                                      maximum_bytes = MAX_PUBLIC_GENE_LIST_BYTES) {
  genes <- as.character(value)
  valid <- !is.na(genes) & nzchar(trimws(genes))
  if (any(valid)) {
    valid[valid] <- nchar(genes[valid], type = "chars") <= MAX_PUBLIC_GENE_NAME_CHARS &
      !grepl("[[:cntrl:]]", genes[valid])
  }
  genes <- head(genes[valid], maximum)
  if (length(genes) == 0) return(character())
  encoded_bytes <- nchar(enc2utf8(genes), type = "bytes") + 3L
  genes[cumsum(encoded_bytes) <= maximum_bytes]
}

public_csv_gene_list <- function(value, maximum = MAX_DOT_PLOT_GENES) {
  if (!is.atomic(value) || length(value) != 1 || is.na(value)) {
    stop("genes must be one comma-separated list.")
  }
  raw <- as.character(value)
  if (nchar(raw, type = "chars") > maximum * (MAX_PUBLIC_GENE_NAME_CHARS + 1L)) {
    stop(paste0("genes exceeds the maximum encoded length for ", maximum, " genes."))
  }
  values <- trimws(strsplit(raw, ",", fixed = TRUE)[[1]])
  values <- values[values != ""]
  if (length(values) == 0) stop("No genes provided.")
  if (length(values) > maximum) stop(paste0("genes must contain at most ", maximum, " entries."))
  values <- vapply(values, public_gene_identifier, character(1), name = "Each gene")
  unique(unname(values))
}

public_csv_parameter_list <- function(value, name, maximum, allow_empty = TRUE) {
  if (is.null(value) || length(value) == 0) {
    if (allow_empty) return(character())
    stop(paste0(name, " is required."))
  }
  if (!is.atomic(value) || length(value) != 1 || is.na(value)) {
    stop(paste0(name, " must be one comma-separated list."))
  }
  raw <- as.character(value)
  if (identical(trimws(raw), "") && allow_empty) return(character())
  if (nchar(raw, type = "chars") > maximum * (MAX_PUBLIC_PARAMETER_NAME_CHARS + 1L)) {
    stop(paste0(name, " exceeds the maximum encoded length."))
  }
  values <- trimws(strsplit(raw, ",", fixed = TRUE)[[1]])
  values <- values[values != ""]
  if (length(values) > maximum) stop(paste0(name, " must contain at most ", maximum, " entries."))
  if (any(nchar(values, type = "chars") > MAX_PUBLIC_PARAMETER_NAME_CHARS)
      || any(grepl("[[:cntrl:]]", values))) {
    stop(paste0(name, " contains an invalid or overlong entry."))
  }
  unique(values)
}

# Deterministic, evenly spaced sampling with one anchor per observed group. This
# keeps small clusters visible while enforcing a hard global response bound.
bounded_group_sample_indices <- function(groups, maximum = MAX_PUBLIC_CELL_VALUES) {
  maximum <- suppressWarnings(as.integer(maximum))
  total <- length(groups)
  if (length(maximum) != 1 || is.na(maximum) || maximum <= 0 || total == 0) return(integer())
  if (total <= maximum) return(seq_len(total))
  labels <- as.character(groups)
  labels[is.na(labels)] <- "<NA>"
  anchors <- match(unique(labels), labels)
  if (length(anchors) >= maximum) return(sort(as.integer(head(anchors, maximum))))
  candidates <- setdiff(seq_len(total), anchors)
  remaining <- maximum - length(anchors)
  sampled <- candidates[bounded_sample_indices(length(candidates), remaining)]
  sort(as.integer(c(anchors, sampled)))
}

# Select a deterministic top-N marker set without dplyr's tie expansion. The
# returned feature count is bounded even for pathological cluster counts.
bounded_marker_features <- function(markers, top_n,
                                    maximum = MAX_HEATMAP_GENES,
                                    max_clusters = MAX_PUBLIC_CLUSTERS) {
  top_n <- public_bounded_integer(top_n, "top_n", 1, 20)
  if (!is.data.frame(markers) || !all(c("cluster", "gene") %in% names(markers))) {
    stop("Marker results are missing required columns.")
  }
  score_column <- if ("avg_log2FC" %in% names(markers)) {
    "avg_log2FC"
  } else if ("avg_logFC" %in% names(markers)) {
    "avg_logFC"
  } else {
    stop("Marker results are missing a fold-change column.")
  }
  cluster_values <- as.character(markers$cluster)
  clusters <- head(unique(cluster_values[!is.na(cluster_values)]), max_clusters)
  selected <- character()
  for (cluster in clusters) {
    rows <- which(cluster_values == cluster & !is.na(markers$gene))
    if (length(rows) == 0) next
    scores <- suppressWarnings(as.numeric(markers[[score_column]][rows]))
    genes <- as.character(markers$gene[rows])
    valid <- is.finite(scores) & !is.na(genes) & nzchar(genes) &
      nchar(genes, type = "chars") <= MAX_PUBLIC_GENE_NAME_CHARS &
      !grepl("[[:cntrl:]]", genes)
    if (!any(valid)) next
    scores <- scores[valid]
    genes <- genes[valid]
    order_idx <- order(-scores, genes, method = "radix")
    selected <- unique(c(selected, head(genes[order_idx], top_n)))
    if (length(selected) >= maximum) break
  }
  head(selected, maximum)
}

public_validation_response <- function(res, error) {
  res$status <- 400
  list(error = conditionMessage(error))
}

public_compute_admission <- function(object, operation) {
  dimensions <- suppressWarnings(as.numeric(c(
    n_features = nrow(object),
    n_cells = ncol(object)
  )))
  if (length(dimensions) != 2L || any(!is.finite(dimensions))
      || any(dimensions < 0) || any(dimensions != trunc(dimensions))) {
    stop(paste0(operation, " requires an object with valid cell and feature dimensions."))
  }
  n_features <- dimensions[[1]]
  n_cells <- dimensions[[2]]
  if (n_cells > MAX_PUBLIC_SYNC_CELLS || n_features > MAX_PUBLIC_SYNC_FEATURES) {
    stop(paste0(
      operation, " exceeds the live synchronous compute limit of ",
      MAX_PUBLIC_SYNC_CELLS, " cells and ", MAX_PUBLIC_SYNC_FEATURES,
      " features. Use a durable queued job for larger objects."
    ))
  }
  object_bytes <- suppressWarnings(as.numeric(object.size(object)))
  if (length(object_bytes) != 1L || !is.finite(object_bytes) || object_bytes < 0
      || object_bytes > MAX_PUBLIC_OBJECT_BYTES) {
    stop(paste0(
      operation, " exceeds the live synchronous in-memory object limit of ",
      MAX_PUBLIC_OBJECT_BYTES, " bytes. Use a durable queued job for larger objects."
    ))
  }
  list(
    n_cells = as.integer(n_cells),
    n_features = as.integer(n_features),
    object_bytes = object_bytes
  )
}

public_dense_allocation_admission <- function(admission, feature_count, operation,
                                              maximum_values = MAX_PUBLIC_DENSE_VALUES) {
  features <- suppressWarnings(as.numeric(feature_count))
  if (!is.list(admission) || length(admission$n_cells) != 1L
      || !is.finite(admission$n_cells) || admission$n_cells < 0
      || length(features) != 1L || !is.finite(features)
      || features != trunc(features) || features < 1
      || length(maximum_values) != 1L || !is.finite(maximum_values)
      || maximum_values < 1) {
    stop(paste0(operation, " has an invalid dense-allocation estimate."))
  }
  dense_values <- as.numeric(admission$n_cells) * features
  if (!is.finite(dense_values) || dense_values > maximum_values) {
    stop(paste0(
      operation, " exceeds the live synchronous dense-allocation limit of ",
      format(maximum_values, scientific = FALSE),
      " values. Use a durable queued job for larger objects."
    ))
  }
  list(
    n_cells = as.integer(admission$n_cells),
    n_features = as.integer(features),
    dense_values = dense_values
  )
}

public_compute_admission_response <- function(res, error) {
  res$status <- 413
  list(error = conditionMessage(error))
}

#* Standalone worker readiness check. This route is private/worker-only at the
#* Express boundary. A fresh random challenge filename proves this R process can
#* see the worker's current durable mount; stale copied marker files do not pass.
#* It returns no root path, probe content, or challenge value.
#* @get /internal/worker-readiness
function(req, res) {
  nonce <- if (!is.null(req$HTTP_X_STORAGE_PROBE_NONCE)) {
    tolower(as.character(req$HTTP_X_STORAGE_PROBE_NONCE)[1])
  } else {
    ""
  }
  expected <- "benchone-shared-storage-v1"
  shared <- FALSE
  if (grepl("^[0-9a-f]{32}$", nonce)) {
    probe_path <- file.path(storage_root_path(), paste0(".benchone-worker-storage-probe-", nonce))
    if (file.exists(probe_path) && !dir.exists(probe_path)) {
      link_target <- Sys.readlink(probe_path)
      if (length(link_target) == 1 && nchar(link_target) == 0) {
        content <- tryCatch(readLines(probe_path, warn = FALSE, n = 1), error = function(e) character())
        shared <- length(content) == 1 && identical(content[[1]], expected)
      }
    }
  }
  if (!shared) res$status <- 503
  list(
    status = if (shared) "ok" else "not_ready",
    storage_shared = shared,
    runtime_session_id = if (shared) r_runtime_instance_id else NULL
  )
}

#* Return the R process session ID (changes on every restart)
#* @get /session-id
function(res) {
  list(sessionId = r_session_id)
}

#* Test-only diagnostic for R session key isolation
#* @get /__test/session-state
function(req, res) {
  diagnostics_enabled <- identical(Sys.getenv("ENABLE_R_TEST_DIAGNOSTICS"), "true") &&
    !identical(Sys.getenv("NODE_ENV"), "production")

  if (!diagnostics_enabled) {
    res$status <- 404
    return(list(error = "Not found"))
  }

  sid <- req$HTTP_X_OBJECT_ID
  if (is.null(sid) || nchar(sid) == 0) sid <- "DEFAULT"

  list(
    x_object_id = sid,
    has_global_obj = !is.null(global_obj),
    n_cells = if (!is.null(global_obj)) ncol(global_obj) else NULL,
    n_features = if (!is.null(global_obj)) nrow(global_obj) else NULL,
    reductions = if (!is.null(global_obj)) names(global_obj@reductions) else list(),
    active_session_keys = as.list(ls(envir = active_sessions, all.names = TRUE))
  )
}

#* Get real QC distribution data from the loaded Seurat object
#* @get /qc-distributions
function(res) {
  if (is.null(global_obj)) return(list(error = "No object loaded. Load data first."))
  admission <- tryCatch(
    public_compute_admission(global_obj, "QC distributions"),
    error = identity
  )
  if (inherits(admission, "error")) {
    return(public_compute_admission_response(res, admission))
  }
  
  tryCatch({
    # Compute percent.mt if not already present
    if (!"percent.mt" %in% colnames(global_obj@meta.data)) {
      global_obj[["percent.mt"]] <<- PercentageFeatureSet(global_obj, pattern = "^[Mm][Tt]-")
    }
    
    mt_vals <- as.numeric(global_obj$percent.mt)
    feature_vals <- as.numeric(global_obj$nFeature_RNA)
    count_vals <- as.numeric(global_obj$nCount_RNA)
    total_cells <- length(mt_vals)
    sample_idx <- bounded_sample_indices(total_cells)
    
    list(
      percent_mt = round(mt_vals[sample_idx], 3),
      nFeature_RNA = feature_vals[sample_idx],
      nCount_RNA = count_vals[sample_idx],
      n_cells = total_cells,
      n_values = length(sample_idx),
      sampled = total_cells > length(sample_idx)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("Failed to compute QC distributions:", e$message))
  })
}

# ──────────────────────────────────────────────────────────────────
# PIPELINE STEP 0: Load Data
# ──────────────────────────────────────────────────────────────────

#* Load dataset into memory
#* @get /load-data
function(res, min_cells = 3, min_features = 200) {
  min_cells <- as.integer(min_cells)
  min_features <- as.integer(min_features)

  tryCatch({
    script <- paste0(
      "library(Seurat)\n",
      "# 1. Read 10X sparse matrix\n",
      "mat <- Read10X(data.dir = 'data/pbmc3k/filtered_gene_bc_matrices/hg19')\n",
      "# 2. Initialize Seurat object\n",
      "obj <- CreateSeuratObject(counts = mat, min.cells = ", min_cells, ", min.features = ", min_features, ")\n"
    )

    # Actual R execution
    data_path <- '../data/pbmc3k/filtered_gene_bc_matrices/hg19'
    
    if (!dir.exists(data_path)) {
       stop(paste("Data directory not found at:", normalizePath(data_path, mustWork = FALSE)))
    }
    
    mat <- Read10X(data.dir = data_path)
    global_obj <<- CreateSeuratObject(counts = mat, min.cells = min_cells, min.features = min_features)
    raw_obj <<- global_obj

    # Calculate real density
    nnz <- length(mat@x)
    total_elements <- as.numeric(nrow(mat)) * as.numeric(ncol(mat))
    density_val <- (nnz / total_elements) * 100
    sparsity_val <- 100 - density_val

    make_provenance(
      result = list(
        message = "Matrix successfully loaded into Seurat.",
        cells = ncol(global_obj),
        features = nrow(global_obj),
        genes = nrow(global_obj),
        sparsity = round(sparsity_val, 2),
        density = round(density_val, 2)
      ),
      script_text = script,
      operation = "load",
      parameters = list(file = "pbmc3k", engine = "Seurat")
    )
  }, error = function(e) { res$status <- 500; list(error = paste("R Error:", e$message))
  })
}

#* Load a local 10X directory (barcodes / features / matrix)
#* @get /load-local-10x
function(res, path, min_cells = 3, min_features = 200) {
  min_cells <- as.integer(min_cells)
  min_features <- as.integer(min_features)
  tryCatch({
    path <- validate_path(path, "vault")
    if (!dir.exists(path)) stop(paste("Directory not found:", path))
    mat <- Read10X(data.dir = path)
    global_obj <<- CreateSeuratObject(counts = mat, min.cells = min_cells, min.features = min_features)
    raw_obj <<- global_obj
    global_obj[["percent.mt"]] <<- PercentageFeatureSet(global_obj, pattern = "^[Mm][Tt]-")
    nnz <- length(mat@x)
    total_el <- as.numeric(nrow(mat)) * as.numeric(ncol(mat))
    density_val <- (nnz / total_el) * 100
    make_provenance(
      result = list(
        message = "Local 10X matrix loaded.",
        cells = ncol(global_obj), features = nrow(global_obj), genes = nrow(global_obj),
        sparsity = round(100 - density_val, 2), density = round(density_val, 2),
        source = "local-10x"
      ),
      script_text = paste0(
        "mat <- Read10X(data.dir = '", path, "')\n",
        "obj <- CreateSeuratObject(counts = mat, min.cells = ", min_cells,
        ", min.features = ", min_features, ")"
      ),
      operation = "load",
      parameters = list(path = path, min_cells = min_cells, min_features = min_features)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("10X load failed:", e$message)) })
}

#* Load and merge multiple 10X Cell Ranger directories into one Seurat object
#* @post /load-multi-10x
#* @parser json
function(res, req) {
  body        <- req$body
  paths       <- as.character(body$paths)
  sample_names <- as.character(body$sample_names)
  meta_col    <- if (!is.null(body$meta_col) && nchar(trimws(body$meta_col)) > 0) trimws(body$meta_col) else "orig.ident"
  min_cells   <- if (!is.null(body$min_cells))   as.integer(body$min_cells)   else 3L
  min_features <- if (!is.null(body$min_features)) as.integer(body$min_features) else 200L

  if (length(paths) == 0) return(list(error = "No paths provided."))
  if (length(sample_names) != length(paths)) {
    return(list(error = paste0("Length of sample_names (", length(sample_names),
                               ") must match length of paths (", length(paths), ").")))
  }

  tryCatch({
    paths <- vapply(paths, validate_path, character(1), safe_dir = "vault")
    # Validate all directories exist before starting
    missing_dirs <- paths[!dir.exists(paths)]
    if (length(missing_dirs) > 0) {
      stop(paste("Directories not found:", paste(missing_dirs, collapse = ", ")))
    }

    # ── Load each sample individually ──────────────────────────────
    obj_list <- vector("list", length(paths))
    per_sample_cells <- integer(length(paths))

    for (i in seq_along(paths)) {
      cat("[Multi-10X] Loading sample", i, "/", length(paths), ":", sample_names[i], "\n")
      mat_i <- Read10X(data.dir = paths[i])
      obj_i <- CreateSeuratObject(counts = mat_i, min.cells = min_cells, min.features = min_features,
                                  project = sample_names[i])
      # Assign the sample identity into the desired metadata column
      obj_i[[meta_col]] <- sample_names[i]
      
      # Assign extra metadata columns if provided
      if (!is.null(body$extra_meta)) {
        for (col_name in names(body$extra_meta)) {
          obj_i[[col_name]] <- as.character(body$extra_meta[[col_name]])[i]
        }
      }
      
      per_sample_cells[i] <- ncol(obj_i)
      obj_list[[i]] <- obj_i
    }

    # ── Merge all objects ──────────────────────────────────────────
    cat("[Multi-10X] Merging", length(obj_list), "objects...\n")
    if (length(obj_list) == 1) {
      merged <- obj_list[[1]]
    } else {
      merged <- merge(obj_list[[1]],
                      y = obj_list[-1],
                      add.cell.ids = sample_names,
                      merge.data = FALSE)
    }

    # ── Post-merge QC ─────────────────────────────────────────────
    merged[["percent.mt"]] <- PercentageFeatureSet(merged, pattern = "^[Mm][Tt]-")

    global_obj <<- merged
    raw_obj    <<- merged

    # Compute approximate density on the merged counts
    counts_mat <- tryCatch(GetAssayData(merged, layer = "counts"), error = function(e) NULL)
    density_val <- if (!is.null(counts_mat)) {
      nnz <- length(counts_mat@x)
      total <- as.numeric(nrow(counts_mat)) * as.numeric(ncol(counts_mat))
      (nnz / total) * 100
    } else NA_real_

    # ── Build a reproducible R script ─────────────────────────────
    load_lines <- paste0(
      "# Load sample: ", sample_names, "\n",
      "mat_", seq_along(paths), " <- Read10X(data.dir = '", paths, "')\n",
      "obj_", seq_along(paths), " <- CreateSeuratObject(counts = mat_", seq_along(paths),
      ", min.cells = ", min_cells, ", min.features = ", min_features,
      ", project = '", sample_names, "')\n",
      "obj_", seq_along(paths), "[['", meta_col, "']] <- '", sample_names, "'\n"
    )
    
    if (!is.null(body$extra_meta)) {
      for (col_name in names(body$extra_meta)) {
        meta_vals <- as.character(body$extra_meta[[col_name]])
        load_lines <- paste0(load_lines, "obj_", seq_along(paths), "[['", col_name, "']] <- '", meta_vals, "'\n")
      }
    }
    
    load_lines <- paste0(load_lines, collapse = "\n")
    merge_args <- paste0("obj_", seq_along(paths), collapse = ", ")
    merge_ids  <- paste0("c('", paste(sample_names, collapse = "', '"), "')")
    script_text <- paste0(
      load_lines, "\n",
      "# Merge all samples\n",
      "merged <- merge(obj_1, y = list(", paste0("obj_", seq_along(paths)[-1], collapse = ", "),
      "), add.cell.ids = ", merge_ids, ")\n",
      "merged[['percent.mt']] <- PercentageFeatureSet(merged, pattern = '^[Mm][Tt]-')\n"
    )

    per_sample_summary <- lapply(seq_along(paths), function(i) {
      list(name = sample_names[i], path = paths[i], cells = per_sample_cells[i])
    })

    make_provenance(
      result = list(
        message       = paste0("Merged ", length(paths), " 10X samples into one Seurat object."),
        cells         = ncol(global_obj),
        features      = nrow(global_obj),
        genes         = nrow(global_obj),
        density       = if (!is.na(density_val)) round(density_val, 2) else NULL,
        sparsity      = if (!is.na(density_val)) round(100 - density_val, 2) else NULL,
        source        = "multi-10x",
        meta_col      = meta_col,
        sample_names  = as.list(sample_names),
        per_sample    = per_sample_summary
      ),
      script_text   = script_text,
      operation     = "load",
      parameters    = list(paths = as.list(paths), sample_names = as.list(sample_names),
                           meta_col = meta_col, min_cells = min_cells, min_features = min_features)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("Multi-10X load failed:", e$message)) })
}


#* Load a Seurat RDS object from a local file
#* @post /load-rds
#* @parser json
function(res, req) {
  tryCatch({
    if (!identical(Sys.getenv("ALLOW_TRUSTED_RDS_LOAD"), "true")) {
      res$status <- 403
      return(list(error = "RDS loading is disabled. Set ALLOW_TRUSTED_RDS_LOAD=true only for trusted local/dev inputs."))
    }
    path <- validate_path(req$body$path, "vault")
    if (!grepl("\\.rds$", path, ignore.case = TRUE)) {
      stop("Only RDS files in the vault can be loaded.")
    }
    # Note: RDS deserialization can execute arbitrary code in R.
    # Validate the class immediately to mitigate some risk.
    if (!file.exists(path)) stop(paste("File not found:", path))
    obj <- readRDS(path)
    if (!inherits(obj, "Seurat")) stop("RDS file does not contain a Seurat object.")
    global_obj <<- obj
    raw_obj <<- obj
    if (!"percent.mt" %in% colnames(global_obj@meta.data)) {
      global_obj[["percent.mt"]] <<- PercentageFeatureSet(global_obj, pattern = "^MT-")
    }
    nnz <- tryCatch(length(GetAssayData(global_obj, layer = "counts")@x), error = function(e) NA)
    total <- as.numeric(nrow(global_obj)) * as.numeric(ncol(global_obj))
    density_val <- if (!is.na(nnz)) (nnz / total) * 100 else NA
    make_provenance(
      result = list(
        message = "Seurat RDS loaded.",
        cells = ncol(global_obj), features = nrow(global_obj), genes = nrow(global_obj),
        sparsity = if (!is.na(density_val)) round(100 - density_val, 2) else NULL,
        density = if (!is.na(density_val)) round(density_val, 2) else NULL,
        source = "rds",
        existing_reductions = names(global_obj@reductions)
      ),
      script_text = paste0("obj <- readRDS('", path, "')"),
      operation = "load",
      parameters = list(path = path)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("RDS load failed:", e$message)) })
}

#* Load an H5AD / H5Seurat file (requires SeuratDisk)
#* @get /load-h5ad
function(res, path) {
  tryCatch({
    path <- validate_path(path, "vault")
    if (!grepl("\\.(h5|h5ad|h5seurat)$", path, ignore.case = TRUE)) {
      stop("Only H5, H5AD, or H5Seurat files in the vault can be loaded.")
    }
    if (!file.exists(path)) stop(paste("File not found:", path))
    if (!requireNamespace("SeuratDisk", quietly = TRUE)) {
      stop("SeuratDisk is required for H5AD files. Install with: remotes::install_github('mojaveazure/seurat-disk')")
    }
    library(SeuratDisk)
    ext <- tolower(tools::file_ext(path))
    if (ext == "h5ad") {
      h5seurat_path <- sub("\\.h5ad$", ".h5seurat", path)
      Convert(path, dest = "h5seurat", overwrite = TRUE)
      global_obj <<- LoadH5Seurat(h5seurat_path)
    } else {
      global_obj <<- LoadH5Seurat(path)
    }
    if (!"percent.mt" %in% colnames(global_obj@meta.data)) {
      global_obj[["percent.mt"]] <<- PercentageFeatureSet(global_obj, pattern = "^MT-")
    }
    make_provenance(
      result = list(
        message = "H5AD/H5Seurat loaded.",
        cells = ncol(global_obj), features = nrow(global_obj), genes = nrow(global_obj),
        source = "h5ad",
        existing_reductions = names(global_obj@reductions)
      ),
      script_text = paste0("obj <- LoadH5Seurat('", path, "')"),
      operation = "load",
      parameters = list(path = path)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("H5AD load failed:", e$message)) })
}

#* Inspect the current Seurat object — metadata, reductions, assays
#* @get /object-info
function(res) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  admission <- tryCatch(
    public_compute_admission(global_obj, "Object inspection"),
    error = identity
  )
  if (inherits(admission, "error")) {
    return(public_compute_admission_response(res, admission))
  }
  tryCatch({
    meta <- global_obj@meta.data
    all_meta_names <- colnames(meta)
    returned_meta_names <- head(all_meta_names, MAX_PUBLIC_METADATA_COLUMNS)
    meta_cols <- lapply(returned_meta_names, function(col) {
      vals <- meta[[col]]
      if (is.numeric(vals)) {
        finite_vals <- vals[is.finite(vals)]
        list(name = bounded_public_labels(col), type = "numeric", n_unique = length(unique(vals)),
             min = if (length(finite_vals)) round(min(finite_vals), 4) else NULL,
             max = if (length(finite_vals)) round(max(finite_vals), 4) else NULL,
             mean = if (length(finite_vals)) round(mean(finite_vals), 4) else NULL,
             preview = NULL)
      } else {
        u_vals <- unique(vals)
        n_uq <- length(u_vals)
        top <- if (n_uq < 50) {
          bounded_public_labels(head(names(sort(table(as.character(vals)), decreasing = TRUE)), 5))
        } else NULL
        list(name = bounded_public_labels(col), type = if (is.factor(vals)) "factor" else "character",
             n_unique = n_uq,
             min = NULL, max = NULL, mean = NULL, preview = top)
      }
    })
    list(
      n_cells = ncol(global_obj),
      n_features = nrow(global_obj),
      active_assay = DefaultAssay(global_obj),
      assays = as.list(head(bounded_public_labels(Assays(global_obj)), 64L)),
      reductions = as.list(head(bounded_public_labels(names(global_obj@reductions)), 64L)),
      n_meta_columns = length(all_meta_names),
      returned_meta_columns = length(returned_meta_names),
      meta_columns_truncated = length(all_meta_names) > length(returned_meta_names),
      meta_cols = meta_cols
    )
  }, error = function(e) { res$status <- 500; list(error = paste("object-info failed:", e$message)) })
}

#* Read-only inspection summary of the current live object (metadata only)
#*
#* Narrow, read-only companion to the worker-to-R object inspection bridge
#* (backend/rWorkerBridge.js, operation r.object.inspect). It returns ONLY a small,
#* sanitized structural summary of the object currently loaded for the caller's
#* server-derived X-Object-ID session: existence, class, dimensions, assay/reduction/
#* metadata-field NAMES (no values), field count, and runtime versions. It deliberately
#* returns NO expression matrices, cell-level rows, gene lists, embeddings, raw sample
#* values, or file paths. It mutates NOTHING: it never assigns to global_obj/raw_obj,
#* never writes/saves, takes no path/code input, and evaluates no client expression.
#* A missing/unloaded object is reported safely as { exists = FALSE } (not an error).
#* @get /object/inspect
function(req, res) {
  if (is.null(global_obj)) {
    return(list(exists = FALSE))
  }
  tryCatch({
    meta_names <- tryCatch(colnames(global_obj@meta.data), error = function(e) character(0))
    if (is.null(meta_names)) meta_names <- character(0)
    seurat_ver <- tryCatch(as.character(utils::packageVersion("Seurat")), error = function(e) NULL)
    list(
      exists = TRUE,
      class = class(global_obj)[1],
      n_cells = ncol(global_obj),
      n_features = nrow(global_obj),
      assays = tryCatch(Assays(global_obj), error = function(e) list()),
      reductions = tryCatch(names(global_obj@reductions), error = function(e) list()),
      n_meta_fields = length(meta_names),
      # NAMES only — never the per-cell values behind these columns.
      meta_fields = as.list(meta_names),
      seurat_version = seurat_ver,
      r_version = as.character(getRversion())
    )
  }, error = function(e) {
    # Never leak the raw R error/stack; the Node bridge also re-maps non-200s to a
    # generic, sanitized message.
    res$status <- 500
    list(error = "object inspection failed")
  })
}

# ── Internal worker-bridge pipeline: PBMC/Seurat preprocessing on a COPY ──────
# Internal-only: reached ONLY via the in-process Node worker bridge (the allowlisted
# `r.pbmc.pipeline.v1` operation calls this R backend directly). The public Express
# proxy BLOCKS this path (server.js isInternalOnlyRProxyPath → 404 before any R
# contact), so a direct `/api/r/object/pbmc-pipeline` user call can never run it — that
# enforcement lives in Node, not in this comment. The auth filter still requires the
# server API token, so nothing outside the server can call R at all.
# The input object is loaded by session_loader from the request's X-Object-ID (the
# parent's server-derived state key). We run the existing preprocessing path on a
# LOCAL COPY (`obj`) and NEVER reassign global_obj, so the postroute hook re-saves the
# PARENT unchanged — the parent stays a stable checkpoint. A durable checkpoint RDS is
# written ONLY to the SERVER-provided internal key, confined to the vault by
# validate_path(). No arbitrary code/path/function: params are typed Seurat arguments
# and the storage key is server-allocated. The response is a sanitized, bounded summary
# (no matrices/cells/genes/embeddings); the Node bridge sanitizes it again.
#* @post /object/pbmc-pipeline
#* @parser json
function(req, res) {
  # Release the heavy working set back to the OS on exit (see /object/seurat-pipeline).
  on.exit(try(gc(full = TRUE), silent = TRUE), add = TRUE)
  if (is.null(global_obj)) {
    res$status <- 400
    return(list(error = "No input object loaded."))
  }
  body <- req$body
  if (is.null(body) || is.null(body$params)) {
    res$status <- 400
    return(list(error = "Missing pipeline parameters."))
  }
  p <- body$params

  # Defensive coercion/clamps (Node already validated against its allowlist; R never
  # trusts blindly). A bad/missing value falls back to the documented default.
  as_int <- function(v, d, lo, hi) {
    x <- suppressWarnings(as.integer(v))
    if (length(x) != 1 || is.na(x)) return(d)
    max(lo, min(hi, x))
  }
  as_num <- function(v, d, lo, hi) {
    x <- suppressWarnings(as.numeric(v))
    if (length(x) != 1 || is.na(x)) return(d)
    max(lo, min(hi, x))
  }

  norm_method <- if (!is.null(p$normalizationMethod)) as.character(p$normalizationMethod)[1] else "LogNormalize"
  if (!norm_method %in% c("LogNormalize", "SCTransform")) norm_method <- "LogNormalize"
  scale_factor    <- as_num(p$scaleFactor,       10000, 1, 1e7)
  nfeatures       <- as_int(p$variableFeatures,  2000, 50, 10000)
  pca_dims        <- as_int(p$pcaDims,           50, 2, 100)
  cluster_dims    <- as_int(p$clusterDims,       15, 2, 100)
  cluster_res     <- as_num(p$clusterResolution, 0.8, 0.01, 10)
  umap_dims       <- as_int(p$umapDims,          15, 2, 100)
  umap_components <- as_int(p$umapComponents,    2, 2, 3)
  umap_neighbors  <- as_int(p$umapNeighbors,     30, 2, 200)
  umap_min_dist   <- as_num(p$umapMinDist,       0.3, 0, 1)
  used_seed <- if (is.null(p$seed) || is.na(suppressWarnings(as.integer(p$seed)))) sample.int(100000, 1) else as.integer(p$seed)

  storage_key <- body$storage_key
  if (is.null(storage_key) || !is.character(storage_key) || nchar(storage_key) == 0) {
    res$status <- 400
    return(list(error = "Missing checkpoint storage key."))
  }

  tryCatch({
    receipt_binding <- validate_completion_receipt_binding(
      body, "pbmc.pipeline.v1", "r.pbmc.pipeline.v1", storage_key
    )
    # COPY-on-modify: mutating `obj` never touches global_obj (the parent).
    obj <- global_obj
    set.seed(used_seed)

    if (norm_method == "SCTransform") {
      obj <- SCTransform(obj, verbose = FALSE)
    } else {
      obj <- NormalizeData(obj, normalization.method = norm_method, scale.factor = scale_factor, verbose = FALSE)
      obj <- FindVariableFeatures(obj, selection.method = "vst", nfeatures = nfeatures, verbose = FALSE)
      obj <- ScaleData(obj, features = rownames(obj), verbose = FALSE)
    }

    npcs <- min(pca_dims, ncol(obj) - 1, nrow(obj) - 1, 100, na.rm = TRUE)
    if (is.na(npcs) || npcs < 2) stop("Insufficient cells/features for PCA.")
    obj <- RunPCA(obj, features = VariableFeatures(object = obj), npcs = npcs, seed.use = used_seed, verbose = FALSE)

    avail_dims <- ncol(Embeddings(obj, "pca"))
    cdims <- min(cluster_dims, avail_dims)
    obj <- FindNeighbors(obj, reduction = "pca", dims = 1:cdims, verbose = FALSE)
    obj <- FindClusters(obj, resolution = cluster_res, random.seed = used_seed, verbose = FALSE)

    udims <- min(umap_dims, avail_dims)
    un <- min(umap_neighbors, ncol(obj) - 1, na.rm = TRUE)
    if (is.na(un) || un < 2) stop("Insufficient cells for UMAP.")
    obj <- RunUMAP(obj, reduction = "pca", dims = 1:udims, n.components = umap_components,
                   n.neighbors = un, min.dist = umap_min_dist, seed.use = used_seed, verbose = FALSE)

    # Durable checkpoint: server-provided key confined to internal storage.
    safe_path <- resolve_internal_storage_key(storage_key, for_write = TRUE)
    raw_for_bundle <- if (exists("raw_obj") && !is.null(raw_obj)) raw_obj else obj
    atomic_save_rds(list(global = obj, raw = raw_for_bundle), safe_path)
    size_bytes <- as.numeric(file.info(safe_path)$size)
    checksum <- tryCatch({
      if (requireNamespace("digest", quietly = TRUE)) {
        digest::digest(file = safe_path, algo = "sha256")
      } else if (requireNamespace("openssl", quietly = TRUE)) {
        as.character(openssl::sha256(file(safe_path)))
      } else {
        NA_character_
      }
    }, error = function(e) NA_character_)
    saved <- isTRUE(file.exists(safe_path)) && !is.na(checksum)

    cluster_counts <- table(obj$seurat_clusters)

    # No mutation of global_obj. Publish the signed receipt only after the
    # checkpoint and bounded response are complete.
    response_out <- list(
      ok = TRUE,
      summary = list(
        n_cells = ncol(obj),
        n_features = nrow(obj),
        n_variable_features = length(VariableFeatures(obj)),
        n_pcs = npcs,
        n_clusters = length(cluster_counts),
        cluster_sizes = as.list(as.integer(cluster_counts)),
        reductions = as.list(names(obj@reductions)),
        normalization_method = norm_method,
        resolution = cluster_res,
        used_seed = used_seed
      ),
      checkpoint = list(
        saved = saved,
        checksum_sha256 = if (is.na(checksum)) NULL else checksum,
        size_bytes = size_bytes
      ),
      versions = list(
        seurat_version = as.character(utils::packageVersion("Seurat")),
        r_version = as.character(getRversion())
      )
    )
    atomic_write_completion_receipt(receipt_binding, response_out)
    response_out
  }, error = function(e) {
    res$status <- 500
    # Log the real cause to stderr (captured by the Node parent as an [R:err] line) so
    # operators can diagnose failures. The RESPONSE body stays generic: the Node bridge
    # re-maps non-200s to a sanitized message and never forwards this text to clients.
    message(sprintf("[object/pbmc-pipeline] pipeline error: %s", conditionMessage(e)))
    list(error = "pbmc pipeline failed")
  })
}

# Internal worker-bridge pipeline: uploaded dataset -> Seurat checkpoint.
# Reached only via the Node worker bridge (`r.seurat.pipeline.v1`). Express blocks
# `/api/r/object/seurat-pipeline` from the public proxy before R contact.
#* @post /object/seurat-pipeline
#* @parser json
function(req, res) {
  # Force a GC on exit so the ~300MB working set (scaled matrix, saved bundle) is
  # released back to the OS rather than accumulating in the long-running plumber
  # process, which otherwise starves a subsequent heavy request (e.g. checkpoint load).
  on.exit(try(gc(full = TRUE), silent = TRUE), add = TRUE)
  body <- req$body
  if (is.null(body) || is.null(body$params)) {
    res$status <- 400
    return(list(error = "Missing pipeline parameters."))
  }
  p <- body$params

  # Deterministic lease-renewal coverage for the real-R CI smoke. This delay is
  # carried through the narrow child environment only when diagnostics are
  # explicitly enabled outside production; ordinary requests cannot set it.
  diagnostics_enabled <- identical(Sys.getenv("ENABLE_R_TEST_DIAGNOSTICS"), "true") &&
    !identical(Sys.getenv("NODE_ENV"), "production")
  if (diagnostics_enabled) {
    test_delay_ms <- suppressWarnings(as.integer(Sys.getenv("R_TEST_SEURAT_DELAY_MS", unset = "0")))
    if (length(test_delay_ms) == 1 && !is.na(test_delay_ms)
        && test_delay_ms > 0 && test_delay_ms <= 600000) {
      Sys.sleep(test_delay_ms / 1000)
    }
  }

  as_int <- function(v, d, lo, hi) {
    x <- suppressWarnings(as.integer(v))
    if (length(x) != 1 || is.na(x)) return(d)
    max(lo, min(hi, x))
  }
  as_num <- function(v, d, lo, hi) {
    x <- suppressWarnings(as.numeric(v))
    if (length(x) != 1 || is.na(x)) return(d)
    max(lo, min(hi, x))
  }

  dataset_storage_key <- body$dataset_storage_key
  dataset_type <- body$dataset_file_type
  storage_key <- body$storage_key
  if (is.null(dataset_storage_key) || !is.character(dataset_storage_key) || nchar(dataset_storage_key) == 0 ||
      is.null(storage_key) || !is.character(storage_key) || nchar(storage_key) == 0) {
    res$status <- 400
    return(list(error = "Missing storage key."))
  }
  if (is.null(dataset_type) || !identical(as.character(dataset_type)[1], "tenx_h5")) {
    res$status <- 400
    return(list(error = "Unsupported dataset type."))
  }

  min_cells <- as_int(p$minCells, 3, 0, 10000)
  min_features <- as_int(p$minFeatures, 200, 0, 100000)
  apply_qc <- isTRUE(p$applyQcFilter)
  min_features_filter <- as_int(p$minFeaturesFilter, 200, 0, 100000)
  max_features_filter <- as_int(p$maxFeaturesFilter, 2500, 1, 1000000)
  max_percent_mt <- as_num(p$maxPercentMt, 5, 0, 100)
  norm_method <- if (!is.null(p$normalizationMethod)) as.character(p$normalizationMethod)[1] else "LogNormalize"
  if (!norm_method %in% c("LogNormalize", "SCTransform")) norm_method <- "LogNormalize"
  scale_factor <- as_num(p$scaleFactor, 10000, 1, 1e7)
  nfeatures <- as_int(p$variableFeatures, 2000, 50, 10000)
  pca_dims <- as_int(p$pcaDims, 50, 2, 100)
  cluster_dims <- as_int(p$clusterDims, 15, 2, 100)
  cluster_res <- as_num(p$clusterResolution, 0.8, 0.01, 10)
  umap_dims <- as_int(p$umapDims, 15, 2, 100)
  umap_components <- as_int(p$umapComponents, 2, 2, 3)
  umap_neighbors <- as_int(p$umapNeighbors, 30, 2, 200)
  umap_min_dist <- as_num(p$umapMinDist, 0.3, 0, 1)
  used_seed <- if (is.null(p$seed) || is.na(suppressWarnings(as.integer(p$seed)))) sample.int(100000, 1) else as.integer(p$seed)

  tryCatch({
    receipt_binding <- validate_completion_receipt_binding(
      body, "seurat.pipeline.v1", "r.seurat.pipeline.v1", storage_key
    )
    # Read10X_h5 needs hdf5r (a Seurat *Suggests*, not a hard dependency). Fail with a
    # clear, actionable message if it is missing rather than a cryptic downstream error.
    if (!requireNamespace("hdf5r", quietly = TRUE)) {
      stop("R package 'hdf5r' is not installed; cannot read 10x HDF5 (tenx_h5). Install 'hdf5r' on the R backend.")
    }
    dataset_path <- resolve_internal_storage_key(dataset_storage_key)
    if (!file.exists(dataset_path)) stop("Dataset file not found.")
    mat <- Read10X_h5(filename = dataset_path)
    if (is.list(mat)) {
      if ("Gene Expression" %in% names(mat)) {
        mat <- mat[["Gene Expression"]]
      } else {
        mat <- mat[[1]]
      }
    }

    obj <- CreateSeuratObject(counts = mat, min.cells = min_cells, min.features = min_features)
    raw_obj <- obj
    warnings <- c()
    pre_filter_cells <- ncol(obj)

    mt_ok <- TRUE
    tryCatch({
      obj[["percent.mt"]] <- PercentageFeatureSet(obj, pattern = "^[Mm][Tt]-")
    }, error = function(e) {
      mt_ok <<- FALSE
      warnings <<- c(warnings, "percent.mt could not be computed")
      obj[["percent.mt"]] <<- 0
    })

    if (apply_qc) {
      keep <- obj$nFeature_RNA >= min_features_filter &
        obj$nFeature_RNA <= max_features_filter &
        obj$percent.mt <= max_percent_mt
      if (sum(keep) < 3) stop("QC filtering would leave fewer than 3 cells.")
      obj <- subset(obj, cells = colnames(obj)[keep])
    }
    post_filter_cells <- ncol(obj)

    set.seed(used_seed)
    if (norm_method == "SCTransform") {
      obj <- SCTransform(obj, verbose = FALSE)
    } else {
      obj <- NormalizeData(obj, normalization.method = norm_method, scale.factor = scale_factor, verbose = FALSE)
      obj <- FindVariableFeatures(obj, selection.method = "vst", nfeatures = nfeatures, verbose = FALSE)
      obj <- ScaleData(obj, features = rownames(obj), verbose = FALSE)
    }

    npcs <- min(pca_dims, ncol(obj) - 1, nrow(obj) - 1, 100, na.rm = TRUE)
    if (is.na(npcs) || npcs < 2) stop("Insufficient cells/features for PCA.")
    obj <- RunPCA(obj, features = VariableFeatures(object = obj), npcs = npcs, seed.use = used_seed, verbose = FALSE)

    avail_dims <- ncol(Embeddings(obj, "pca"))
    cdims <- min(cluster_dims, avail_dims)
    obj <- FindNeighbors(obj, reduction = "pca", dims = 1:cdims, verbose = FALSE)
    obj <- FindClusters(obj, resolution = cluster_res, random.seed = used_seed, verbose = FALSE)

    udims <- min(umap_dims, avail_dims)
    un <- min(umap_neighbors, ncol(obj) - 1, na.rm = TRUE)
    if (is.na(un) || un < 2) stop("Insufficient cells for UMAP.")
    obj <- RunUMAP(obj, reduction = "pca", dims = 1:udims, n.components = umap_components,
                   n.neighbors = un, min.dist = umap_min_dist, seed.use = used_seed, verbose = FALSE)

    safe_path <- resolve_internal_storage_key(storage_key, for_write = TRUE)
    atomic_save_rds(list(global = obj, raw = raw_obj), safe_path)
    size_bytes <- as.numeric(file.info(safe_path)$size)
    checksum <- tryCatch({
      if (requireNamespace("digest", quietly = TRUE)) {
        digest::digest(file = safe_path, algo = "sha256")
      } else if (requireNamespace("openssl", quietly = TRUE)) {
        as.character(openssl::sha256(file(safe_path)))
      } else {
        NA_character_
      }
    }, error = function(e) NA_character_)
    saved <- isTRUE(file.exists(safe_path)) && !is.na(checksum)
    cluster_counts <- table(obj$seurat_clusters)

    response_out <- list(
      ok = TRUE,
      summary = list(
        n_cells = ncol(obj),
        n_features = nrow(obj),
        pre_filter_cells = pre_filter_cells,
        post_filter_cells = post_filter_cells,
        percent_mt_available = mt_ok,
        n_variable_features = length(VariableFeatures(obj)),
        n_pcs = npcs,
        n_clusters = length(cluster_counts),
        cluster_sizes = as.list(as.integer(cluster_counts)),
        reductions = as.list(names(obj@reductions)),
        normalization_method = norm_method,
        resolution = cluster_res,
        used_seed = used_seed
      ),
      warnings = as.list(warnings),
      checkpoint = list(
        saved = saved,
        checksum_sha256 = if (is.na(checksum)) NULL else checksum,
        size_bytes = size_bytes
      ),
      versions = list(
        seurat_version = as.character(utils::packageVersion("Seurat")),
        r_version = as.character(getRversion())
      )
    )
    atomic_write_completion_receipt(receipt_binding, response_out)
    response_out
  }, error = function(e) {
    res$status <- 500
    code <- classify_seurat_pipeline_error(e)
    # Log the real cause to stderr (captured by the Node parent as an [R:err] line) so
    # operators can diagnose failures. The RESPONSE body stays generic: the Node bridge
    # re-maps non-200s to a sanitized message and never forwards this text to clients.
    message(sprintf("[object/seurat-pipeline] pipeline error: %s", conditionMessage(e)))
    list(error = "seurat pipeline failed", code = code)
  })
}

#* Read-only completion flags for restoring the pipeline UI after a browser restart
#* @get /pipeline-state
function(req, res) {
  if (is.null(global_obj)) return(list(exists = FALSE))
  admission <- tryCatch(
    public_compute_admission(global_obj, "Pipeline state inspection"),
    error = identity
  )
  if (inherits(admission, "error")) {
    return(public_compute_admission_response(res, admission))
  }
  tryCatch({
    has_normalized <- tryCatch({
      assay_layers <- SeuratObject::Layers(global_obj[[DefaultAssay(global_obj)]])
      any(assay_layers == "data" | startsWith(assay_layers, "data."))
    }, error = function(e) FALSE)
    has_pca <- "pca" %in% names(global_obj@reductions)
    has_clusters <- "seurat_clusters" %in% colnames(global_obj@meta.data)
    has_umap <- "umap" %in% names(global_obj@reductions)
    qc_marker <- tryCatch(isTRUE(global_obj@misc$benchone_pipeline$qc), error = function(e) FALSE)
    pca_dims <- if (has_pca) tryCatch(ncol(Embeddings(global_obj, "pca")), error = function(e) 15) else 15
    list(
      exists = TRUE,
      has_qc = qc_marker || has_normalized || has_pca || has_clusters || has_umap,
      has_normalized = has_normalized,
      has_integrated = "harmony" %in% names(global_obj@reductions),
      has_pca = has_pca,
      pca_dims = pca_dims,
      has_clusters = has_clusters,
      n_clusters = if (has_clusters) length(unique(global_obj$seurat_clusters)) else 0,
      has_umap = has_umap
    )
  }, error = function(e) {
    res$status <- 500
    list(error = "pipeline state inspection failed")
  })
}

# ── Internal worker-bridge: load a durable checkpoint back into the live session ──────
# Internal-only: reached ONLY via the in-process Node worker bridge (the allowlisted
# `r.checkpoint.load.v1` operation calls this R backend directly). The public Express
# proxy BLOCKS this path (server.js isInternalOnlyRProxyPath → 404 before any R contact),
# so a direct `/api/r/object/checkpoint-load` user call can never run it. The auth filter
# still requires the server API token, so nothing outside the server can reach R at all.
# The SERVER selects the checkpoint storage_key (never the client); it is confined to the
# vault by validate_path() (no absolute paths / `..` / backslashes / vault escape). RDS
# deserialization can run arbitrary code, so we verify the file checksum (when supplied)
# BEFORE readRDS, then validate the bundle shape + Seurat class. We reattach the loaded
# object into global_obj/raw_obj for THIS request's X-Object-ID session ONLY — the
# postroute hook persists exactly that key, so no other user's/object's live state is
# touched. The response is a sanitized, bounded summary (no matrices/cells/genes/
# embeddings/paths/state-key); the Node bridge sanitizes it again.
#* @post /object/checkpoint-load
#* @parser json
function(req, res) {
  # Release the readRDS/checksum working set back to the OS on exit (the reattached
  # object stays in global_obj/raw_obj; only transient copies are collected).
  on.exit(try(gc(full = TRUE), silent = TRUE), add = TRUE)
  body <- req$body
  storage_key <- if (!is.null(body)) body$storage_key else NULL
  if (is.null(storage_key) || !is.character(storage_key) || length(storage_key) != 1 || nchar(storage_key) == 0) {
    res$status <- 400
    return(list(error = "Missing checkpoint storage key."))
  }
  expected_checksum <- if (!is.null(body$expected_checksum_sha256)) as.character(body$expected_checksum_sha256)[1] else NULL
  expected_size <- if (!is.null(body$expected_size_bytes)) suppressWarnings(as.numeric(body$expected_size_bytes)[1]) else NULL

  tryCatch({
    receipt_binding <- validate_completion_receipt_binding(
      body, c("checkpoint.load.v1", "checkpoint.fork.v1"),
      "r.checkpoint.load.v1", NULL
    )
    # Server-provided key confined to internal storage.
    safe_path <- resolve_internal_storage_key(storage_key)
    if (!grepl("\\.rds$", safe_path, ignore.case = TRUE)) {
      stop("Only RDS checkpoints can be loaded.")
    }
    if (!file.exists(safe_path)) stop("Checkpoint file not found.")

    # Optional size check (defense-in-depth; the server passes the recorded size).
    if (!is.null(expected_size) && !is.na(expected_size)) {
      actual_size <- as.numeric(file.info(safe_path)$size)
      if (!is.na(actual_size) && actual_size != expected_size) {
        stop("Checkpoint size mismatch.")
      }
    }

    # Verify the checksum BEFORE deserializing when the server supplied one. RDS load can
    # execute arbitrary R, so integrity-check the bytes first.
    checksum_verified <- FALSE
    if (!is.null(expected_checksum) && nchar(expected_checksum) > 0) {
      actual_checksum <- tryCatch({
        if (requireNamespace("digest", quietly = TRUE)) {
          digest::digest(file = safe_path, algo = "sha256")
        } else if (requireNamespace("openssl", quietly = TRUE)) {
          as.character(openssl::sha256(file(safe_path)))
        } else {
          NA_character_
        }
      }, error = function(e) NA_character_)
      if (is.na(actual_checksum)) stop("Unable to verify checkpoint checksum.")
      if (!identical(tolower(actual_checksum), tolower(expected_checksum))) {
        stop("Checkpoint checksum mismatch.")
      }
      checksum_verified <- TRUE
    }

    bundle <- readRDS(safe_path)

    # Validate bundle shape: the pbmc checkpoint saves list(global=<Seurat>, raw=...).
    # Accept that shape or a bare Seurat object (defensive); reject anything else.
    loaded_obj <- NULL
    raw_loaded <- NULL
    if (inherits(bundle, "Seurat")) {
      loaded_obj <- bundle
      raw_loaded <- bundle
    } else if (is.list(bundle) && "global" %in% names(bundle)) {
      loaded_obj <- bundle$global
      raw_loaded <- if ("raw" %in% names(bundle)) bundle$raw else bundle$global
    } else {
      stop("Checkpoint bundle format not recognized.")
    }
    if (!inherits(loaded_obj, "Seurat")) {
      stop("Checkpoint does not contain a Seurat object.")
    }

    # Build the sanitized summary from the LOCAL object first, so a summary error can never
    # leave live state mutated ahead of a reported failure.
    meta_names <- tryCatch(colnames(loaded_obj@meta.data), error = function(e) character(0))
    if (is.null(meta_names)) meta_names <- character(0)
    seurat_ver <- tryCatch(as.character(utils::packageVersion("Seurat")), error = function(e) NULL)
    summary_out <- list(
      loaded = TRUE,
      runtime_instance_id = r_runtime_instance_id,
      checksum_verified = checksum_verified,
      class = class(loaded_obj)[1],
      n_cells = ncol(loaded_obj),
      n_features = nrow(loaded_obj),
      assays = as.list(tryCatch(Assays(loaded_obj), error = function(e) character())),
      reductions = as.list(tryCatch(names(loaded_obj@reductions), error = function(e) character())),
      n_meta_fields = length(meta_names),
      # NAMES only — never the per-cell values behind these columns.
      meta_fields = as.list(meta_names),
      seurat_version = seurat_ver,
      r_version = as.character(getRversion())
    )

    # Reattach into the live session for THIS request's X-Object-ID (the LAST step). The
    # postroute hook persists global_obj/raw_obj for that key only — no other object key
    # is mutated.
    sid <- validate_internal_state_key(req$HTTP_X_OBJECT_ID)
    prior_global <- global_obj
    prior_raw <- raw_obj
    prior_cache_keys <- ls(envir = active_sessions, all.names = TRUE)
    prior_cache <- lapply(prior_cache_keys, function(key) active_sessions[[key]])
    names(prior_cache) <- prior_cache_keys
    global_obj <<- loaded_obj
    raw_obj <<- raw_loaded

    # Persist this exact private target before publishing the receipt. If receipt
    # publication reports a definite failure, restore the exact prior session so a
    # 500 response cannot leave an unrecorded live-state mutation behind.
    tryCatch(
      {
        store_active_session(sid, global_obj, raw_obj)
        atomic_write_completion_receipt(receipt_binding, summary_out)
      },
      error = function(receipt_error) {
        global_obj <<- prior_global
        raw_obj <<- prior_raw
        current_cache_keys <- ls(envir = active_sessions, all.names = TRUE)
        if (length(current_cache_keys) > 0) {
          rm(list = current_cache_keys, envir = active_sessions)
        }
        for (key in prior_cache_keys) {
          active_sessions[[key]] <- prior_cache[[key]]
        }
        stop(receipt_error)
      }
    )
    summary_out
  }, error = function(e) {
    res$status <- 500
    # Log the real cause to stderr (captured by the Node parent as an [R:err] line) so
    # operators can diagnose failures. The RESPONSE body stays generic: the Node bridge
    # re-maps non-200s to a sanitized message and never forwards this text to clients.
    message(sprintf("[object/checkpoint-load] load error: %s", conditionMessage(e)))
    list(error = "checkpoint load failed")
  })
}

# ── Internal worker-bridge: DEG / marker finding over an existing live object ──────
# Internal-only: reached ONLY via the in-process Node worker bridge (the allowlisted
# `r.deg.find_markers.v1` operation calls this R backend directly). The public Express
# proxy BLOCKS this path (server.js isInternalOnlyRProxyPath → 404 before any R contact),
# so a direct `/api/r/object/deg-find-markers` user call can never run it. The auth filter
# still requires the server API token, so nothing outside the server can reach R at all.
# The input object is loaded by session_loader from the request's X-Object-ID (the owner's
# server-derived canonical state key). DEG is an OUTPUT-producing analysis, NOT a mutation:
# we run FindAllMarkers on a LOCAL COPY (`obj`) and NEVER reassign global_obj, so the
# postroute hook re-saves the live object UNCHANGED (idents/metadata untouched at the
# session level). The full marker table is written ONLY to the SERVER-provided internal key,
# confined to the vault by validate_path(). No arbitrary code/path/function: params are
# typed Seurat arguments validated against a fixed allowlist and the storage key is server-
# allocated. The response is a sanitized, bounded summary (no matrices/cells/embeddings);
# the Node bridge sanitizes it again.
#* @post /object/deg-find-markers
#* @parser json
function(req, res) {
  if (is.null(global_obj)) {
    res$status <- 400
    return(list(error = "No input object loaded."))
  }
  if (!inherits(global_obj, "Seurat")) {
    res$status <- 400
    return(list(error = "Loaded object is not a Seurat object."))
  }
  body <- req$body
  if (is.null(body) || is.null(body$params)) {
    res$status <- 400
    return(list(error = "Missing DEG parameters."))
  }
  p <- body$params

  storage_key <- body$storage_key
  if (is.null(storage_key) || !is.character(storage_key) || length(storage_key) != 1 || nchar(storage_key) == 0) {
    res$status <- 400
    return(list(error = "Missing DEG result storage key."))
  }

  # Defensive coercion/clamps (Node already validated against its allowlist; R never trusts
  # blindly). A bad/missing value falls back to the documented default. Strings are matched
  # against fixed allowlists only — never used to choose an R function or column arbitrarily.
  as_num <- function(v, d, lo, hi) {
    x <- suppressWarnings(as.numeric(v))
    if (length(x) != 1 || is.na(x)) return(d)
    max(lo, min(hi, x))
  }
  as_int_or_null <- function(v, lo, hi) {
    if (is.null(v)) return(NULL)
    x <- suppressWarnings(as.integer(v))
    if (length(x) != 1 || is.na(x)) return(NULL)
    as.integer(max(lo, min(hi, x)))
  }
  as_bool <- function(v, d) {
    if (is.logical(v) && length(v) == 1 && !is.na(v)) return(v)
    d
  }

  group_by <- if (!is.null(p$groupBy)) as.character(p$groupBy)[1] else "seurat_clusters"
  if (!group_by %in% c("seurat_clusters", "ident")) group_by <- "seurat_clusters"
  assay_req <- if (!is.null(p$assay)) as.character(p$assay)[1] else "RNA"
  if (!assay_req %in% c("RNA", "SCT")) assay_req <- "RNA"
  test_use <- if (!is.null(p$testUse)) as.character(p$testUse)[1] else "wilcox"
  if (!test_use %in% c("wilcox")) test_use <- "wilcox"
  only_pos     <- as_bool(p$onlyPositive, TRUE)
  min_pct      <- as_num(p$minPct, 0.1, 0, 1)
  logfc_thresh <- as_num(p$logfcThreshold, 0.25, 0, 10)
  max_cells    <- as_int_or_null(p$maxCellsPerIdent, 1, 100000)
  rand_seed    <- as_int_or_null(p$randomSeed, 0, 2147483647)
  top_n_val    <- as.integer(as_num(p$topMarkersPerCluster, 10, 5, 50))

  tryCatch({
    receipt_binding <- validate_completion_receipt_binding(
      body, "deg.find_markers.v1", "r.deg.find_markers.v1", storage_key
    )
    # COPY-on-read: any identity change happens on `obj`, never global_obj (the live object).
    obj <- global_obj

    # Pick a safe assay: the requested allowlisted assay if present, else the default.
    assay_use <- if (assay_req %in% Assays(obj)) assay_req else DefaultAssay(obj)
    DefaultAssay(obj) <- assay_use

    # Resolve grouping. 'seurat_clusters' requires that metadata column to exist; 'ident'
    # uses the object's CURRENT active identities as-is. Either way DEG needs >= 2 groups.
    if (group_by == "seurat_clusters") {
      if (!"seurat_clusters" %in% colnames(obj@meta.data)) {
        res$status <- 400
        return(list(error = "Group field 'seurat_clusters' not found. Run clustering first."))
      }
      Idents(obj) <- obj$seurat_clusters
    }
    if (length(levels(factor(Idents(obj)))) < 2) {
      res$status <- 400
      return(list(error = "DEG needs at least two identity groups."))
    }

    if (!is.null(rand_seed)) set.seed(rand_seed)

    markers <- FindAllMarkers(
      obj,
      assay = assay_use,
      only.pos = only_pos,
      min.pct = min_pct,
      logfc.threshold = logfc_thresh,
      test.use = test_use,
      max.cells.per.ident = if (is.null(max_cells)) Inf else max_cells,
      random.seed = if (is.null(rand_seed)) 1 else rand_seed,
      verbose = FALSE
    )

    if (is.null(markers) || nrow(markers) == 0) {
      res$status <- 500
      return(list(error = "No marker genes found."))
    }
    markers <- as.data.frame(markers)
    # FindAllMarkers returns a `gene` column in modern Seurat; fall back to rownames.
    if (!"gene" %in% colnames(markers)) markers$gene <- rownames(markers)

    # Write the full marker table to a server-provided key in internal storage.
    safe_path <- resolve_internal_storage_key(storage_key, for_write = TRUE)
    atomic_write_csv(markers, safe_path)
    size_bytes <- as.numeric(file.info(safe_path)$size)
    checksum <- tryCatch({
      if (requireNamespace("digest", quietly = TRUE)) {
        digest::digest(file = safe_path, algo = "sha256")
      } else if (requireNamespace("openssl", quietly = TRUE)) {
        as.character(openssl::sha256(file(safe_path)))
      } else {
        NA_character_
      }
    }, error = function(e) NA_character_)
    saved <- isTRUE(file.exists(safe_path)) && !is.na(checksum)

    # Build a BOUNDED summary. group labels + per-group counts + a top-N-per-group preview
    # with SAFE columns only. No raw matrices/cells/embeddings.
    cluster_col <- markers$cluster
    group_labels <- as.character(sort(unique(cluster_col)))
    per_group <- lapply(group_labels, function(g) {
      list(group = g, n = as.integer(sum(cluster_col == g)))
    })

    suppressMessages({ library(dplyr) })
    top_tbl <- as.data.frame(markers) %>%
      group_by(cluster) %>%
      arrange(desc(avg_log2FC), .by_group = TRUE) %>%
      slice_head(n = top_n_val) %>%
      mutate(rank = row_number()) %>%
      ungroup()

    top_markers <- lapply(seq_len(nrow(top_tbl)), function(i) {
      list(
        group = as.character(top_tbl$cluster[i]),
        gene = as.character(top_tbl$gene[i]),
        avg_log2FC = round(as.numeric(top_tbl$avg_log2FC[i]), 4),
        pct_1 = as.numeric(top_tbl$pct.1[i]),
        pct_2 = as.numeric(top_tbl$pct.2[i]),
        p_val_adj = as.numeric(top_tbl$p_val_adj[i]),
        rank = as.integer(top_tbl$rank[i])
      )
    })

    response_out <- list(
      ok = TRUE,
      summary = list(
        group_by = group_by,
        test_use = test_use,
        assay = assay_use,
        n_groups = length(group_labels),
        groups = as.list(group_labels),
        n_markers_total = nrow(markers),
        markers_per_group = per_group,
        top_markers = top_markers
      ),
      result = list(
        saved = saved,
        checksum_sha256 = if (is.na(checksum)) NULL else checksum,
        size_bytes = size_bytes,
        n_rows = nrow(markers)
      ),
      versions = list(
        seurat_version = as.character(utils::packageVersion("Seurat")),
        r_version = as.character(getRversion())
      )
    )
    atomic_write_completion_receipt(receipt_binding, response_out)
    response_out
    # NB: global_obj is never reassigned here, so the postroute hook persists the live
    # object UNCHANGED — DEG does not mutate live state.
  }, error = function(e) {
    res$status <- 500
    # Log the real cause to stderr (captured by the Node parent as an [R:err] line) so
    # operators can diagnose failures. The RESPONSE body stays generic: the Node bridge
    # re-maps non-200s to a sanitized message and never forwards this text to clients.
    message(sprintf("[object/deg-find-markers] DEG error: %s", conditionMessage(e)))
    list(error = "deg find markers failed")
  })
}

#* Get all unique values (with counts) for a metadata column
#* @get /meta-values
function(res, column) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  admission <- tryCatch(
    public_compute_admission(global_obj, "Metadata values"),
    error = identity
  )
  if (inherits(admission, "error")) {
    return(public_compute_admission_response(res, admission))
  }
  parsed_column <- tryCatch(
    public_metadata_column(global_obj, column, "column"),
    error = identity
  )
  if (inherits(parsed_column, "error")) return(public_validation_response(res, parsed_column))
  column <- parsed_column
  vals <- as.character(global_obj@meta.data[[column]])
  counts_tbl <- sort(table(vals), decreasing = TRUE)
  returned_names <- head(names(counts_tbl), MAX_PUBLIC_METADATA_VALUES)
  list(
    column = column,
    n_unique = length(counts_tbl),
    returned_count = length(returned_names),
    truncated = length(counts_tbl) > length(returned_names),
    values = lapply(seq_along(returned_names), function(index) list(
      value = bounded_public_labels(returned_names[[index]]),
      count = as.integer(counts_tbl[[returned_names[[index]]]])
    ))
  )
}

#* Read column names from a local CSV (for the metadata import UI)
#* @get /csv-columns
function(res, path) {
  path <- validate_path(path, "vault")
  tryCatch({
    if (!file.exists(path)) stop(paste("File not found:", path))
    sep <- if (grepl("\\.tsv$", path, ignore.case = TRUE)) "\t" else ","
    df <- read.table(path, sep = sep, header = TRUE, nrows = 1, check.names = FALSE)
    list(columns = colnames(df))
  }, error = function(e) { res$status <- 500; list(error = paste("CSV read failed:", e$message)) })
}

#* Import metadata from a local CSV and join to the Seurat object by barcode
#* @get /add-metadata
function(res, csv_path, key_column = "barcode", value_columns = "") {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  csv_path <- validate_path(csv_path, "vault")
  tryCatch({
    if (!file.exists(csv_path)) stop(paste("CSV not found:", csv_path))
    sep <- if (grepl("\\.tsv$", csv_path, ignore.case = TRUE)) "\t" else ","
    meta_df <- read.table(csv_path, sep = sep, header = TRUE, stringsAsFactors = FALSE, check.names = FALSE)
    if (!key_column %in% colnames(meta_df)) {
      stop(paste0("Key column '", key_column, "' not in CSV. Columns: ", paste(colnames(meta_df), collapse = ", ")))
    }
    cols_to_add <- if (nchar(trimws(value_columns)) == 0) {
      setdiff(colnames(meta_df), key_column)
    } else {
      trimws(strsplit(value_columns, ",")[[1]])
    }
    missing_cols <- setdiff(cols_to_add, colnames(meta_df))
    if (length(missing_cols) > 0) stop(paste("Columns not found in CSV:", paste(missing_cols, collapse = ", ")))

    rownames(meta_df) <- trimws(as.character(meta_df[[key_column]]))
    cell_barcodes <- colnames(global_obj)
    n_matched <- sum(cell_barcodes %in% rownames(meta_df))

    for (col in cols_to_add) {
      vals <- meta_df[cell_barcodes, col]
      global_obj[[col]] <<- vals
    }
    list(
      message = paste0("Added ", length(cols_to_add), " column(s) to ", n_matched, "/", length(cell_barcodes), " cells."),
      added_columns = cols_to_add,
      n_cells_matched = n_matched
    )
  }, error = function(e) { res$status <- 500; list(error = paste("Add metadata failed:", e$message)) })
}

#* Add a new metadata column by mapping values from an existing column
#* @post /add-meta-mapping
#* @parser json
function(res, req) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  admission <- tryCatch(
    public_compute_admission(global_obj, "Metadata mapping"),
    error = identity
  )
  if (inherits(admission, "error")) {
    return(public_compute_admission_response(res, admission))
  }

  parsed <- tryCatch({
    body <- req$body
    if (!is.list(body) || !is.list(body$mapping)) {
      stop("source_col, new_col, and a named mapping object are required.")
    }
    source_col <- public_metadata_column(global_obj, body$source_col, "source_col")
    new_col <- public_scalar_text(body$new_col, "new_col")
    mapping <- body$mapping
    mapping_names <- names(mapping)
    if (length(mapping) < 1L || length(mapping) > MAX_PUBLIC_MAPPING_ENTRIES
        || is.null(mapping_names) || length(mapping_names) != length(mapping)
        || anyDuplicated(mapping_names)) {
      stop(paste0("mapping must contain 1 to ", MAX_PUBLIC_MAPPING_ENTRIES,
                  " uniquely named entries."))
    }
    safe_names <- vapply(
      mapping_names, public_scalar_text, character(1), name = "mapping key"
    )
    safe_values <- vapply(
      mapping, public_scalar_text, character(1), name = "mapping value"
    )
    names(safe_values) <- safe_names
    list(source_col = source_col, new_col = new_col, mapping = safe_values)
  }, error = identity)
  if (inherits(parsed, "error")) return(public_validation_response(res, parsed))

  source_col <- parsed$source_col
  new_col <- parsed$new_col
  mapping <- parsed$mapping

  tryCatch({
    source_vals <- as.character(global_obj@meta.data[[source_col]])
    mapped_vals <- unname(mapping[match(source_vals, names(mapping))])
    global_obj[[new_col]] <<- mapped_vals

    list(
      message = paste0("Successfully added new metadata column: ", new_col),
      mapped_cells = sum(!is.na(mapped_vals))
    )
  }, error = function(e) { res$status <- 500; list(error = paste("Add meta mapping failed:", e$message)) })
}


#* Subset the Seurat object by a metadata column and selected values
#* @post /subset
#* @parser json
function(res, req) {
  body <- req$body
  column <- body$column
  values <- body$values
  new_name <- if (!is.null(body$new_name)) body$new_name else "Subset"
  path <- body$path

  if (is.null(global_obj)) return(list(error = "No object loaded"))
  tryCatch({
    if (!column %in% colnames(global_obj@meta.data)) stop(paste("Column not found:", column))
    vals_vec <- trimws(strsplit(values, ",")[[1]])
    cell_meta_char <- as.character(global_obj@meta.data[[column]])
    cells_keep <- rownames(global_obj@meta.data)[cell_meta_char %in% vals_vec]
    if (length(cells_keep) == 0) stop("No cells match the specified criteria.")

    # Standard Seurat practice: retain raw counts + QC meta.data, reset processed slots
    sub_obj <- subset(global_obj, cells = cells_keep)
    
    # Bundle as list for persistence
    bundle <- list(global = sub_obj, raw = sub_obj)
    
    # Update active memory immediately to ensure R is in sync with the UI's new target
    global_obj <<- sub_obj
    raw_obj    <<- sub_obj

    if (!is.null(path) && path != "") {
      # Non-destructive mode: Save child to disk
      safe_path <- validate_path(path, "vault")
      saveRDS(bundle, safe_path)
    }

    make_provenance(
      result = list(
        message = paste0("Subset: ", length(cells_keep), " cells retained (", column,
                         " \u2208 {", paste(vals_vec, collapse = ", "), "})."),
        cells = ncol(global_obj),
        features = nrow(global_obj),
        genes = nrow(global_obj),
        # Density not recomputed to save time; marked as unknown
        source = "subset",
        subset_column = column,
        subset_values = vals_vec
      ),
      script_text = paste0(
        "cells.keep <- rownames(obj@meta.data)[obj@meta.data[['", column, "']] %in% c(",
        paste0("'", vals_vec, "'", collapse = ", "), ")]\n",
        "obj <- subset(obj, cells = cells.keep)"
      ),
      operation = "subset",
      parameters = list(column = column, values = vals_vec, new_name = new_name)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("Subset failed:", e$message)) })
}

# ── Session Persistence ────────────────────────────────────────────────────────
# Save global_obj as an RDS file so the next app session can restore it without
# re-running the pipeline. A companion JSON stores the original session ID so
# the SQLite result cache (UMAP coords, PCA variance, etc.) remains valid.

#* Save current Seurat object to a local RDS file
#* @post /save-session
#* @parser json
function(res, req) {
  path <- req$body$path
  if (is.null(global_obj)) return(list(error = "No object to save"))
  tryCatch({
    safe_path <- validate_path(path, "vault")
    dir.create(dirname(safe_path), recursive = TRUE, showWarnings = FALSE)
    # Save as a list to preserve the raw checkpoint within a single file
    bundle <- list(global = global_obj, raw = raw_obj)
    saveRDS(bundle, file = safe_path)
    # Companion metadata: session ID + basic stats (used on restore)
    meta <- list(
      session_id = r_session_id,
      cells      = ncol(global_obj),
      features   = nrow(global_obj),
      reductions = names(global_obj@reductions),
      saved_at   = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z")
    )
    meta_path <- paste0(sub("\\.rds$", "", safe_path, ignore.case = TRUE), ".meta.json")
    writeLines(jsonlite::toJSON(meta, auto_unbox = TRUE), con = meta_path)
    list(success = TRUE, path = safe_path, cells = ncol(global_obj))
  }, error = function(e) { res$status <- 500; list(error = paste("Save-session failed:", e$message)) })
}

#* Check whether a session RDS file exists
#* @post /check-session
#* @parser json
function(res, req) {
  path <- req$body$path
  tryCatch({
    safe_path <- validate_path(path, "vault")
    list(exists = file.exists(safe_path), path = safe_path)
  }, error = function(e) { res$status <- 500; list(error = paste("Check-session failed:", e$message)) })
}

#* Restore global_obj from a saved session RDS
#* @post /restore-session
#* @parser json
function(res, req) {
  path <- req$body$path
  tryCatch({
    if (!identical(Sys.getenv("ALLOW_TRUSTED_RDS_LOAD"), "true")) {
      res$status <- 403
      return(list(error = "RDS loading is disabled. Set ALLOW_TRUSTED_RDS_LOAD=true only for trusted local/dev inputs."))
    }
    safe_path <- validate_path(path, "vault")
    if (!file.exists(safe_path)) stop(paste("Session file not found:", safe_path))
    bundle <- readRDS(safe_path)
    
    if (inherits(bundle, "Seurat")) {
      # Legacy support: if file is just a Seurat object, use it for both
      global_obj <<- bundle
      raw_obj <<- bundle
    } else if (is.list(bundle) && "global" %in% names(bundle)) {
      global_obj <<- bundle$global
      raw_obj <<- if ("raw" %in% names(bundle)) bundle$raw else bundle$global
    } else {
      stop("File format not recognized (expected Seurat object or Vault bundle)")
    }

    # Restore original session ID so the frontend's SQLite cache keys still match
    meta_path <- paste0(sub("\\.rds$", "", safe_path, ignore.case = TRUE), ".meta.json")
    restored_session_id <- r_session_id   # fallback to current
    if (file.exists(meta_path)) {
      tryCatch({
        meta <- jsonlite::fromJSON(paste(readLines(meta_path, warn = FALSE), collapse = ""))
        if (!is.null(meta$session_id) && nchar(meta$session_id) > 0) {
          r_session_id <<- meta$session_id
          restored_session_id <- meta$session_id
        }
      }, error = function(e) invisible(NULL))
    }

    list(
      success      = TRUE,
      session_id   = restored_session_id,
      cells        = ncol(global_obj),
      features     = nrow(global_obj),
      reductions   = names(global_obj@reductions),
      n_meta_cols  = ncol(global_obj@meta.data)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("Restore-session failed:", e$message)) })
}

#* Delete a session RDS file and its metadata
#* @post /delete-session
#* @parser json
function(res, req) {
  path <- req$body$path
  tryCatch({
    safe_path <- validate_path(path, "vault")
    if (file.exists(safe_path)) file.remove(safe_path)
    meta_path <- paste0(sub("\\.rds$", "", safe_path, ignore.case = TRUE), ".meta.json")
    if (file.exists(meta_path)) file.remove(meta_path)
    list(success = TRUE, path = safe_path)
  }, error = function(e) { res$status <- 500; list(error = paste("Delete-session failed:", e$message)) })
}
# ──────────────────────────────────────────────────────────────────────────────

#* Perform Quality Control (percent.mt, filtering)
#* @post /qc
#* @parser json
function(res, req) {
  body <- req$body
  if (is.null(global_obj)) return(list(error = "No object loaded"))

  # Use raw_obj as the base if available, otherwise fallback to global_obj
  target_base <- if (!is.null(raw_obj)) raw_obj else global_obj
  admission <- tryCatch(
    public_compute_admission(target_base, "Quality control"),
    error = identity
  )
  if (inherits(admission, "error")) {
    return(public_compute_admission_response(res, admission))
  }
  parsed <- tryCatch({
    if (!is.list(body)) stop("QC parameters are required.")
    mt_limit <- public_bounded_number(body$mt_threshold, "mt_threshold", 0, 100)
    feat_min <- public_bounded_integer(
      body$min_features, "min_features", 0, MAX_PUBLIC_SYNC_FEATURES
    )
    feat_max <- public_bounded_integer(
      body$max_features, "max_features", 0, MAX_PUBLIC_SYNC_FEATURES
    )
    count_min <- public_bounded_number(body$min_counts, "min_counts", 0, 1e12)
    if (feat_max > 0 && feat_max <= feat_min) {
      stop("max_features must be 0 (no limit) or greater than min_features.")
    }
    list(
      mt_limit = mt_limit,
      feat_min = feat_min,
      feat_max = if (feat_max == 0) 1e9 else feat_max,
      count_min = count_min
    )
  }, error = identity)
  if (inherits(parsed, "error")) return(public_validation_response(res, parsed))

  mt_limit <- parsed$mt_limit
  feat_min <- parsed$feat_min
  feat_max <- parsed$feat_max
  count_min <- parsed$count_min

  # Ensure percent.mt exists in baseline
  if (!"percent.mt" %in% colnames(target_base@meta.data)) {
    target_base[["percent.mt"]] <- PercentageFeatureSet(target_base, pattern = "^MT-")
  }
  
  # Calculate removal reasons for the summary cards
  raw_mt       <- target_base$percent.mt
  raw_features <- target_base$nFeature_RNA
  raw_counts   <- target_base$nCount_RNA
  
  removed_mt_count      <- sum(raw_mt >= mt_limit, na.rm = TRUE)
  removed_feature_count <- sum(
    raw_features <= feat_min | (feat_max < 1e9 & raw_features >= feat_max),
    na.rm = TRUE
  )
  removed_count_count   <- sum(raw_counts <= count_min, na.rm = TRUE)
  
  keep_cells <- !is.na(raw_features) & !is.na(raw_mt) & !is.na(raw_counts) &
                raw_features > feat_min &
                raw_features < feat_max &
                raw_mt < mt_limit &
                raw_counts > count_min

  tryCatch({
    temp_obj <- target_base[, keep_cells, drop = FALSE]
    if (ncol(temp_obj) == 0) {
      stop("No cells passed the selected QC thresholds. Please loosen your filters.")
    }
    if (is.null(temp_obj@misc$benchone_pipeline)) temp_obj@misc$benchone_pipeline <- list()
    temp_obj@misc$benchone_pipeline$qc <- TRUE
    global_obj <<- temp_obj
  }, error = function(e) {
    stop("QC Filter Error: Likely no cells matched these thresholds. (", e$message, ")")
  })
  
  cells_after <- ncol(global_obj)
  
  make_provenance(
    result = list(
      message = "QC metrics calculated and cells filtered.",
      post_filter_cells = cells_after,
      removed_mt = removed_mt_count,
      removed_features = removed_feature_count,
      removed_counts = removed_count_count,
      removed_doublets = 0,
      median_mt = round(median(global_obj$percent.mt), 2)
    ),
    script_text = paste0("obj <- subset(obj, subset = nFeature_RNA > ", feat_min, " & nFeature_RNA < ", feat_max, " & percent.mt < ", mt_limit, " & nCount_RNA > ", count_min, ")"),
    operation = "quality-control",
    parameters = list(
      mt_threshold = mt_limit, 
      min_features = feat_min, 
      max_features = feat_max, 
      min_counts = count_min,
      summary = list(
        message = "QC metrics calculated and cells filtered.",
        post_filter_cells = cells_after,
        removed_mt = removed_mt_count,
        removed_features = removed_feature_count,
        removed_counts = removed_count_count,
        removed_doublets = 0,
        median_mt = round(median(global_obj$percent.mt), 2)
      )
    )
  )
}

# ──────────────────────────────────────────────────────────────────
# PIPELINE STEP 2: Normalization
# ──────────────────────────────────────────────────────────────────

#* Normalize data and find variable features
#* @get /normalize
function(res, method = "LogNormalize", scale_factor = 10000, nfeatures = 2000,
         vars_to_regress = "") {
  if (is.null(global_obj)) return(list(error = "No object"))
  admission <- tryCatch(
    public_compute_admission(global_obj, "Normalization"),
    error = identity
  )
  if (inherits(admission, "error")) {
    return(public_compute_admission_response(res, admission))
  }
  parsed <- tryCatch({
    list(
      method = public_choice(method, "method", c("LogNormalize", "SCTransform")),
      scale_factor = public_bounded_integer(
        scale_factor, "scale_factor", 1, MAX_NORMALIZE_SCALE_FACTOR
      ),
      nfeatures = public_bounded_integer(nfeatures, "nfeatures", 1, MAX_VARIABLE_FEATURES),
      vars_to_regress = public_csv_parameter_list(
        vars_to_regress, "vars_to_regress", MAX_REGRESSION_VARIABLES
      )
    )
  }, error = identity)
  if (inherits(parsed, "error")) return(public_validation_response(res, parsed))
  method <- parsed$method
  scale_factor <- parsed$scale_factor
  nfeatures <- parsed$nfeatures
  vars_to_regress <- parsed$vars_to_regress
  dense_feature_count <- if (method == "SCTransform") {
    admission$n_features
  } else if (length(vars_to_regress) > 0) {
    min(nfeatures, admission$n_features)
  } else {
    NULL
  }
  if (!is.null(dense_feature_count)) {
    dense_admission <- tryCatch(
      public_dense_allocation_admission(
        admission, dense_feature_count, paste0(method, " normalization")
      ),
      error = identity
    )
    if (inherits(dense_admission, "error")) {
      return(public_compute_admission_response(res, dense_admission))
    }
  }
  missing_regressors <- setdiff(vars_to_regress, colnames(global_obj@meta.data))
  if (length(missing_regressors) > 0) {
    res$status <- 400
    return(list(error = paste0(
      "vars_to_regress contains unknown metadata columns: ",
      paste(missing_regressors, collapse = ", "), "."
    )))
  }
  regressors_literal <- paste(
    vapply(vars_to_regress, encodeString, character(1), quote = '"'),
    collapse = ", "
  )
  regressors_script <- if (length(vars_to_regress) > 0) {
    paste0("c(", regressors_literal, ")")
  } else {
    "NULL"
  }

  if (method == "SCTransform") {
    script <- paste0(
      "# SCTransform normalization\n",
      "obj <- SCTransform(obj, vars.to.regress = ", regressors_script, ", verbose = FALSE)\n"
    )
    global_obj <<- SCTransform(
      global_obj,
      vars.to.regress = if (length(vars_to_regress) > 0) vars_to_regress else NULL,
      verbose = FALSE
    )
  } else {
    script <- paste0(
      "# Log-normalize data\n",
      "obj <- NormalizeData(obj, normalization.method = '", method, "', scale.factor = ", scale_factor, ")\n",
      "# Identify highly variable features\n",
      "obj <- FindVariableFeatures(obj, selection.method = 'vst', nfeatures = ", nfeatures, ")\n",
      if (length(vars_to_regress) > 0) {
        paste0(
          "# Regress bounded metadata covariates on variable features\n",
          "obj <- ScaleData(obj, features = VariableFeatures(obj), vars.to.regress = ",
          regressors_script, ", verbose = FALSE)\n"
        )
      } else {
        ""
      }
    )
    global_obj <<- NormalizeData(global_obj, normalization.method = method, scale.factor = scale_factor)
    global_obj <<- FindVariableFeatures(global_obj, selection.method = "vst", nfeatures = nfeatures)
    if (length(vars_to_regress) > 0) {
      global_obj <<- ScaleData(
        global_obj,
        features = VariableFeatures(global_obj),
        vars.to.regress = vars_to_regress,
        verbose = FALSE
      )
    }
  }

  make_provenance(
    result = list(
      message = paste0("Normalization complete (", method, "). ", nfeatures, " variable features identified."),
      method = method,
      scale_factor = scale_factor,
      n_variable_features = length(VariableFeatures(global_obj))
    ),
    script_text = script,
    operation = "normalize",
    parameters = list(
      method = method,
      scale_factor = scale_factor,
      nfeatures = nfeatures,
      vars_to_regress = vars_to_regress
    )
  )
}

# ──────────────────────────────────────────────────────────────────
# PIPELINE STEP 2.5: Batch Integration (Optional)
# ──────────────────────────────────────────────────────────────────

#* Batch integration using Harmony or Seurat CCA
#* @get /integrate
function(res, method = "harmony", batch_col = "orig.ident", seed = "") {
  if (is.null(global_obj)) return(list(error = "No object loaded. Please run Normalization first."))
  admission <- tryCatch(
    public_compute_admission(global_obj, "Batch integration"),
    error = identity
  )
  if (inherits(admission, "error")) {
    return(public_compute_admission_response(res, admission))
  }
  parsed <- tryCatch({
    parsed_method <- public_choice(
      tolower(public_scalar_text(method, "method")),
      "method",
      c("harmony", "cca")
    )
    parsed_batch_col <- public_metadata_column(global_obj, batch_col, "batch_col")
    raw_batch_values <- as.character(global_obj@meta.data[[parsed_batch_col]])
    if (any(is.na(raw_batch_values)) || any(!nzchar(trimws(raw_batch_values)))
        || any(nchar(raw_batch_values, type = "chars") > MAX_PUBLIC_LABEL_CHARS)
        || any(grepl("[[:cntrl:]]", raw_batch_values))) {
      stop("batch_col contains missing, empty, control-character, or overlong labels.")
    }
    observed_batches <- unique(raw_batch_values)
    if (length(observed_batches) < 2L || length(observed_batches) > MAX_PUBLIC_BATCHES) {
      stop(paste0("batch_col must contain 2 to ", MAX_PUBLIC_BATCHES,
                  " observed batches."))
    }
    parsed_seed <- public_optional_seed(seed)
    list(
      method = parsed_method,
      batch_col = parsed_batch_col,
      batch_vals = observed_batches,
      seed = if (is.null(parsed_seed)) sample.int(100000L, 1L) else parsed_seed
    )
  }, error = identity)
  if (inherits(parsed, "error")) return(public_validation_response(res, parsed))

  method <- parsed$method
  batch_col <- parsed$batch_col
  batch_vals <- parsed$batch_vals
  used_seed <- parsed$seed
  pca_features <- character()
  pca_components <- 50L
  if (method == "harmony" && !"pca" %in% names(global_obj@reductions)) {
    pca_features <- head(
      intersect(as.character(VariableFeatures(global_obj)), rownames(global_obj)),
      MAX_PUBLIC_PCA_FEATURES
    )
    pca_components <- min(50L, length(pca_features) - 1L, admission$n_cells - 1L)
    if (length(pca_features) < 2L || pca_components < 2L) {
      res$status <- 400
      return(list(error = "Harmony integration requires normalized variable features and at least 3 cells."))
    }
    dense_admission <- tryCatch(
      public_dense_allocation_admission(
        admission, length(pca_features), "Harmony PCA preparation"
      ),
      error = identity
    )
    if (inherits(dense_admission, "error")) {
      return(public_compute_admission_response(res, dense_admission))
    }
  } else if (method == "cca") {
    integration_feature_count <- min(2000L, admission$n_features)
    dense_admission <- tryCatch(
      public_dense_allocation_admission(
        admission, integration_feature_count, "CCA integration"
      ),
      error = identity
    )
    if (inherits(dense_admission, "error")) {
      return(public_compute_admission_response(res, dense_admission))
    }
  }

  tryCatch({
    if (method == "harmony") {
      # ── Harmony Integration ─────────────────────────────────────────
      if (!requireNamespace("harmony", quietly = TRUE)) {
        return(list(error = paste0(
          "The 'harmony' package is required for Harmony integration.\n",
          "Install with: install.packages('harmony')"
        )))
      }
      library(harmony)

      # Ensure PCA exists; compute it if missing
      if (!"pca" %in% names(global_obj@reductions)) {
        cat("[Integrate] PCA not found — running ScaleData + RunPCA before Harmony...\n")
        global_obj <<- ScaleData(global_obj, features = pca_features, verbose = FALSE)
        set.seed(used_seed)
        global_obj <<- RunPCA(global_obj, features = pca_features,
                               npcs = pca_components, seed.use = used_seed, verbose = FALSE)
      }

      cat("[Integrate] Running Harmony on batch column '", batch_col, "'...\n")
      set.seed(used_seed)
      global_obj <<- RunHarmony(global_obj, group.by.vars = batch_col, reduction = "pca",
                                 reduction.save = "harmony", verbose = FALSE)

      script_text <- paste0(
        "library(harmony)\n",
        "# Ensure PCA is computed\n",
        "obj <- ScaleData(obj, features = rownames(obj))\n",
        "obj <- RunPCA(obj, features = VariableFeatures(obj), npcs = 50, seed.use = ", used_seed, ")\n",
        "# Run Harmony integration\n",
        "set.seed(", used_seed, ")\n",
        "obj <- RunHarmony(obj, group.by.vars = '", batch_col, "', reduction = 'pca', reduction.save = 'harmony')\n"
      )

      make_provenance(
        result = list(
          message   = paste0("Harmony integration complete on batch column '", batch_col, "' (",
                              length(batch_vals), " batches: ", paste(batch_vals, collapse = ", "), ")."),
          method    = "harmony",
          batch_col = batch_col,
          batches   = as.list(batch_vals),
          reduction = "harmony",
          n_cells   = ncol(global_obj)
        ),
        script_text   = script_text,
        operation     = "integrate",
        packages_used = c("Seurat", "harmony"),
        parameters    = list(method = "harmony", batch_col = batch_col, seed = used_seed)
      )

    } else if (method == "cca") {
      # ── CCA Integration ─────────────────────────────────────────────
      cat("[Integrate] Running Seurat CCA integration on batch column '", batch_col, "'...\n")

      # Split object by batch
      obj_list <- SplitObject(global_obj, split.by = batch_col)
      cat("[Integrate] Split into", length(obj_list), "objects.\n")

      # Normalize and find variable features per batch
      obj_list <- lapply(obj_list, function(obj) {
        obj <- NormalizeData(obj, verbose = FALSE)
        obj <- FindVariableFeatures(obj, selection.method = "vst", nfeatures = 2000, verbose = FALSE)
        obj
      })

      # Select integration features and find anchors
      features <- SelectIntegrationFeatures(
        object.list = obj_list, nfeatures = integration_feature_count
      )
      anchors  <- FindIntegrationAnchors(object.list = obj_list, anchor.features = features, verbose = FALSE)

      # Integrate data
      global_obj <<- IntegrateData(anchorset = anchors, verbose = FALSE)

      # Switch to integrated assay and re-run scaling + PCA
      DefaultAssay(global_obj) <<- "integrated"
      integrated_pca_features <- head(rownames(global_obj), integration_feature_count)
      global_obj <<- ScaleData(
        global_obj, features = integrated_pca_features, verbose = FALSE
      )
      set.seed(used_seed)
      integrated_pcs <- min(
        50L, length(integrated_pca_features) - 1L, ncol(global_obj) - 1L
      )
      if (integrated_pcs < 2L) stop("Insufficient integrated cells/features for PCA.")
      global_obj <<- RunPCA(
        global_obj, features = integrated_pca_features, npcs = integrated_pcs,
        seed.use = used_seed, verbose = FALSE
      )

      script_text <- paste0(
        "# Seurat CCA Integration\n",
        "obj_list <- SplitObject(obj, split.by = '", batch_col, "')\n",
        "obj_list <- lapply(obj_list, function(x) {\n",
        "  x <- NormalizeData(x)\n",
        "  x <- FindVariableFeatures(x, selection.method = 'vst', nfeatures = 2000)\n",
        "})\n",
        "features <- SelectIntegrationFeatures(object.list = obj_list)\n",
        "anchors  <- FindIntegrationAnchors(object.list = obj_list, anchor.features = features)\n",
        "obj <- IntegrateData(anchorset = anchors)\n",
        "DefaultAssay(obj) <- 'integrated'\n",
        "obj <- ScaleData(obj)\n",
        "obj <- RunPCA(obj, npcs = 50, seed.use = ", used_seed, ")\n"
      )

      make_provenance(
        result = list(
          message   = paste0("CCA integration complete on batch column '", batch_col, "' (",
                              length(batch_vals), " batches: ", paste(batch_vals, collapse = ", "), ")."),
          method    = "cca",
          batch_col = batch_col,
          batches   = as.list(batch_vals),
          reduction = "pca",  # CCA uses pca on integrated assay
          n_cells   = ncol(global_obj)
        ),
        script_text   = script_text,
        operation     = "integrate",
        packages_used = c("Seurat"),
        parameters    = list(method = "cca", batch_col = batch_col, seed = used_seed)
      )

    } else {
      list(error = paste0("Unknown integration method: '", method, "'. Use 'harmony' or 'cca'."))
    }
  }, error = function(e) { res$status <- 500; list(error = paste("Integration failed:", e$message))
  })
}

# ──────────────────────────────────────────────────────────────────
# PIPELINE STEP 3: PCA
# ──────────────────────────────────────────────────────────────────

#* Run PCA on scaled data
#* @get /pca
function(res, npcs = 50, seed = "") {
  if (is.null(global_obj)) return(list(error="No object"))
  admission <- tryCatch(
    public_compute_admission(global_obj, "PCA"),
    error = identity
  )
  if (inherits(admission, "error")) {
    return(public_compute_admission_response(res, admission))
  }
  parsed <- tryCatch({
    requested_npcs <- public_bounded_integer(npcs, "npcs", 2, MAX_REDUCTION_DIMS)
    parsed_seed <- public_optional_seed(seed)
    list(
      npcs = min(requested_npcs, admission$n_cells - 1L, admission$n_features - 1L),
      seed = if (is.null(parsed_seed)) sample.int(100000L, 1L) else parsed_seed
    )
  }, error = identity)
  if (inherits(parsed, "error")) return(public_validation_response(res, parsed))
  npcs <- parsed$npcs
  used_seed <- parsed$seed
  if (npcs < 2L) {
    res$status <- 400
    return(list(error = "PCA requires at least 3 cells and 3 features."))
  }
  pca_features <- head(
    intersect(as.character(VariableFeatures(global_obj)), rownames(global_obj)),
    MAX_PUBLIC_PCA_FEATURES
  )
  if (length(pca_features) < 2L) {
    res$status <- 400
    return(list(error = "PCA requires normalized variable features. Run normalization first."))
  }
  npcs <- min(npcs, length(pca_features) - 1L)
  if (npcs < 2L) {
    res$status <- 400
    return(list(error = "PCA requires at least 3 variable features."))
  }
  dense_admission <- tryCatch(
    public_dense_allocation_admission(admission, length(pca_features), "PCA scaling"),
    error = identity
  )
  if (inherits(dense_admission, "error")) {
    return(public_compute_admission_response(res, dense_admission))
  }

  script <- paste0(
    "# Set seed for reproducibility\n",
    "set.seed(", used_seed, ")\n",
    "# Scale only the bounded variable-feature set\n",
    "pca.features <- head(VariableFeatures(obj), ", length(pca_features), ")\n",
    "obj <- ScaleData(obj, features = pca.features)\n",
    "# Run PCA\n",
    "obj <- RunPCA(obj, features = pca.features, npcs = ", npcs,
    ", seed.use = ", used_seed, ")\n"
  )
  
  tryCatch({
    global_obj <<- ScaleData(global_obj, features = pca_features, verbose = FALSE)
    set.seed(used_seed)
    global_obj <<- RunPCA(
      global_obj, features = pca_features, npcs = npcs,
      seed.use = used_seed, verbose = FALSE
    )

    # Extract true standard deviations safely
    actual_pcs <- length(global_obj[["pca"]]@stdev)
    stdevs <- global_obj[["pca"]]@stdev[1:min(npcs, actual_pcs)]
    
    # Extract top 5 positive and top 5 negative gene loadings for top 5 PCs safely
    ld <- Loadings(global_obj, "pca")
    loadings <- list()
    for (i in 1:min(5, actual_pcs)) {
      pc_name <- paste0("PC_", i)
      srt_pos <- sort(ld[, pc_name], decreasing=TRUE)
      srt_neg <- sort(ld[, pc_name], decreasing=FALSE)
      top_genes <- c(head(names(srt_pos), 5L), head(names(srt_neg), 5L))
      loadings[[paste0("PC", i)]] <- bounded_public_labels(top_genes, MAX_PUBLIC_GENE_NAME_CHARS)
    }

    make_provenance(
      result = list(
        message = paste0("PCA completed with ", npcs, " components."),
        npcs = npcs,
        stdevs = stdevs,
        gene_loadings = loadings
      ),
      script_text = script,
      operation = "pca",
      parameters = list(npcs = npcs, seed = used_seed)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("PCA failed:", e$message))
  })
}

# ──────────────────────────────────────────────────────────────────
# PIPELINE STEP 4: Clustering
# ──────────────────────────────────────────────────────────────────

#* Find neighbors and cluster cells
#* @get /cluster
function(res, dims = 15, resolution = 0.8, algorithm = 1, seed = "",
         k_param = 20, n_start = 10) {
  if (is.null(global_obj)) return(list(error="No object"))
  admission <- tryCatch(
    public_compute_admission(global_obj, "Clustering"),
    error = identity
  )
  if (inherits(admission, "error")) {
    return(public_compute_admission_response(res, admission))
  }
  parsed <- tryCatch({
    parsed_algorithm <- public_bounded_integer(algorithm, "algorithm", 1, 4)
    if (!(parsed_algorithm %in% c(1L, 4L))) {
      stop("algorithm must be 1 (Louvain) or 4 (Leiden).")
    }
    list(
      dims = public_bounded_integer(dims, "dims", 1, MAX_REDUCTION_DIMS),
      resolution = public_bounded_number(
        resolution, "resolution", 0.01, MAX_CLUSTER_RESOLUTION
      ),
      algorithm = parsed_algorithm,
      seed = public_optional_seed(seed),
      k_param = public_bounded_integer(k_param, "k_param", 2, 100),
      n_start = public_bounded_integer(n_start, "n_start", 1, 100)
    )
  }, error = identity)
  if (inherits(parsed, "error")) return(public_validation_response(res, parsed))
  dims <- parsed$dims
  resolution <- parsed$resolution
  algorithm <- parsed$algorithm
  k_param <- parsed$k_param
  n_start <- parsed$n_start
  algo_name <- if (algorithm == 4) "Leiden" else "Louvain"

  if (is.null(parsed$seed)) {
    used_seed <- sample.int(100000, 1)
  } else {
    used_seed <- parsed$seed
  }

  # Fallback if Leiden is requested but packages are missing
  if (algorithm == 4 && (!requireNamespace("leiden", quietly = TRUE) || !requireNamespace("reticulate", quietly = TRUE))) {
    cat("[WARN] Leiden packages missing, falling back to Louvain.\n")
    algorithm <- 1
    algo_name <- "Louvain"
  }

  # Auto-detect best reduction: use harmony if available, otherwise pca
  use_reduction <- if ("harmony" %in% names(global_obj@reductions)) "harmony" else "pca"
  if (!use_reduction %in% names(global_obj@reductions)) stop(paste("Reduction", use_reduction, "not found. Run PCA first."))
  
  # Clamp dims
  available_dims <- ncol(Embeddings(global_obj, use_reduction))
  dims <- min(dims, available_dims)
  k_param <- min(k_param, ncol(global_obj) - 1L)
  if (dims < 1) return(list(error = "No reduction dimensions are available. Run PCA first."))
  if (k_param < 2) return(list(error = "Insufficient cells for clustering."))

  cat("[Cluster] Using reduction:", use_reduction, "with", dims, "dims\n")

  script <- paste0(
    "# Set seed for reproducibility\n",
    "set.seed(", used_seed, ")\n",
    "# Find neighbors (reduction: ", use_reduction, ")\n",
    "obj <- FindNeighbors(obj, reduction = '", use_reduction, "', dims = 1:", dims,
    ", k.param = ", k_param, ")\n",
    "# Cluster cells\n",
    "obj <- FindClusters(obj, algorithm = ", algorithm, ", resolution = ", resolution,
    ", n.start = ", n_start, ", random.seed = ", used_seed, ")\n"
  )

  set.seed(used_seed)
  global_obj <<- FindNeighbors(
    global_obj, reduction = use_reduction, dims = 1:dims, k.param = k_param
  )
  global_obj <<- FindClusters(
    global_obj, algorithm = algorithm, resolution = resolution,
    n.start = n_start, random.seed = used_seed
  )

  # Read actual cluster outcomes
  cluster_counts <- table(global_obj$seurat_clusters)
  cluster_summary <- head(cluster_counts, MAX_PUBLIC_CLUSTERS)
  
  make_provenance(
    result = list(
      message = paste0(algo_name, " clustering complete. ", length(cluster_counts), " clusters identified."),
      n_clusters = length(cluster_counts),
      cluster_names = as.list(bounded_public_labels(paste0("Cluster ", names(cluster_summary)))),
      cluster_sizes = as.list(as.integer(cluster_summary)),
      cluster_summary_count = length(cluster_summary),
      cluster_summary_truncated = length(cluster_counts) > length(cluster_summary),
      algorithm = algo_name,
      resolution = resolution,
      dims_used = dims,
      k_param = k_param,
      n_start = n_start
    ),
    script_text = script,
    operation = "cluster",
    parameters = list(
      dims = dims, 
      resolution = resolution, 
      algorithm = algorithm, 
      algorithm_name = algo_name, 
      seed = used_seed,
      k_param = k_param,
      n_start = n_start,
      n_clusters = length(cluster_counts)
    )
  )
}

# ──────────────────────────────────────────────────────────────────
# PIPELINE STEP 5: UMAP
# ──────────────────────────────────────────────────────────────────

#* Run UMAP dimensionality reduction
#* @get /umap
function(res, dims = 15, n_components = 2, n_neighbors = 30, min_dist = 0.3, seed = "") {
  # Null-check BEFORE accessing any slots on global_obj
  if (is.null(global_obj)) return(list(error = "No object loaded. Please reload and rerun the pipeline."))
  admission <- tryCatch(
    public_compute_admission(global_obj, "UMAP"),
    error = identity
  )
  if (inherits(admission, "error")) {
    return(public_compute_admission_response(res, admission))
  }

  parsed <- tryCatch({
    parsed_components <- public_bounded_integer(n_components, "n_components", 2, 3)
    if (!(parsed_components %in% c(2L, 3L))) stop("n_components must be 2 or 3.")
    list(
      dims = public_bounded_integer(dims, "dims", 1, MAX_REDUCTION_DIMS),
      n_components = parsed_components,
      n_neighbors = public_bounded_integer(n_neighbors, "n_neighbors", 2, 100),
      min_dist = public_bounded_number(min_dist, "min_dist", 0, 1),
      seed = public_optional_seed(seed)
    )
  }, error = identity)
  if (inherits(parsed, "error")) return(public_validation_response(res, parsed))
  dims <- parsed$dims
  n_components <- parsed$n_components
  n_neighbors <- parsed$n_neighbors
  min_dist <- parsed$min_dist

  n_neighbors <- min(n_neighbors, ncol(global_obj) - 1, na.rm = TRUE)
  if (n_neighbors < 2) stop("Insufficient cells for UMAP.")

  if (is.null(parsed$seed)) {
    used_seed <- sample.int(100000, 1)
  } else {
    used_seed <- parsed$seed
  }

  # Auto-detect best reduction: use harmony if available, otherwise pca
  use_reduction <- if ("harmony" %in% names(global_obj@reductions)) "harmony" else "pca"
  cat("[UMAP] Using reduction:", use_reduction, "| reductions on obj:", paste(names(global_obj@reductions), collapse=", "), "\n")

  tryCatch({
    # Verify the required reduction actually exists
    if (!use_reduction %in% names(global_obj@reductions)) {
      return(list(error = paste0("'", use_reduction, "' reduction not found. Please re-run the PCA step before computing UMAP.")))
    }

    # Clamp dims to the number of embeddings actually computed
    available_dims <- ncol(Embeddings(global_obj, use_reduction))
    if (dims > available_dims) {
      cat("[WARN] Requested", dims, "dims but only", available_dims, "available. Clamping.\n")
      dims <- available_dims
    }
    if (dims < 1) return(list(error = "No reduction dimensions are available. Please re-run PCA."))

    script <- paste0(
      "# Set seed for reproducibility\n",
      "set.seed(", used_seed, ")\n",
      "# Run UMAP\n",
      "obj <- RunUMAP(obj, reduction = '", use_reduction, "', dims = 1:", dims, ", n.components = ", n_components, "L",
      ", n.neighbors = ", n_neighbors, ", min.dist = ", min_dist, ", seed.use = ", used_seed, ")\n"
    )

    set.seed(used_seed)
    global_obj <<- RunUMAP(global_obj, reduction = use_reduction, dims = 1:dims,
                           n.components = n_components,
                           n.neighbors = n_neighbors, min.dist = min_dist, seed.use = used_seed)

    emb <- Embeddings(global_obj, "umap")
    clusts <- Idents(global_obj)[rownames(emb)]
    all_cluster_levels <- public_identity_levels(clusts)
    returned_cluster_levels <- head(all_cluster_levels, MAX_PUBLIC_CLUSTERS)
    eligible_idx <- which(as.character(clusts) %in% returned_cluster_levels)
    sample_relative <- bounded_group_sample_indices(
      as.character(clusts)[eligible_idx], MAX_PUBLIC_CELL_VALUES
    )
    sample_idx <- eligible_idx[sample_relative]
    sampled_clusters <- as.character(clusts)[sample_idx]

    trace_data <- lapply(returned_cluster_levels, function(cl) {
      idx <- sample_idx[sampled_clusters == cl]
      name_val <- if (grepl("^[0-9]+$", as.character(cl))) paste("Cluster", cl) else as.character(cl)
      name_val <- bounded_public_labels(name_val)
      el <- list(
        name = name_val,
        x = as.numeric(emb[idx, 1]),
        y = as.numeric(emb[idx, 2])
      )
      if (n_components >= 3) {
        el$z = as.numeric(emb[idx, 3])
      }
      return(el)
    })

    make_provenance(
      result = list(
        message = paste0("UMAP computed (", n_components, "D)."),
        n_components = n_components,
        n_neighbors = n_neighbors,
        min_dist = min_dist,
        n_cells = nrow(emb),
        n_points = length(sample_idx),
        sampled = length(sample_idx) < nrow(emb),
        n_clusters = length(all_cluster_levels),
        returned_clusters = length(returned_cluster_levels),
        clusters_truncated = length(returned_cluster_levels) < length(all_cluster_levels),
        trace_data = trace_data
      ),
      script_text = script,
      operation = "umap",
      parameters = list(dims = dims, n_components = n_components, n_neighbors = n_neighbors, min_dist = min_dist, seed = used_seed)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("UMAP failed:", e$message))
  })
}

#* Annotate clusters with biological cell types
#* @post /annotate-clusters
function(res, req) {
  if (is.null(global_obj)) return(list(error = "No object loaded."))
  
  tryCatch({
    body <- jsonlite::fromJSON(req$postBody)
    mappings <- body$mappings
    
    if (is.null(mappings) || length(mappings) == 0) {
      stop("No mappings provided.")
    }
    
    if (!"seurat_clusters" %in% colnames(global_obj@meta.data)) {
      stop("Dataset has not been clustered (missing seurat_clusters).")
    }
    
    new_ids <- as.character(mappings)
    names(new_ids) <- names(mappings)
    
    script <- paste0(
      "# Reset and rename cluster identities\n",
      "Idents(obj) <- obj$seurat_clusters\n",
      "new_ids <- c(", paste(paste0('"', names(mappings), '"="', mappings, '"'), collapse=", "), ")\n",
      "obj <- RenameIdents(obj, new_ids)\n",
      "obj$cell_type <- Idents(obj)\n"
    )
    
    Idents(global_obj) <<- global_obj$seurat_clusters
    global_obj <<- RenameIdents(global_obj, new_ids)
    global_obj$cell_type <<- Idents(global_obj)
    
    make_provenance(
      result = list(
        message = "Clusters successfully annotated.",
        annotations = mappings
      ),
      script_text = script,
      operation = "annotate"
    )
  }, error = function(e) { res$status <- 500; list(error = paste("Annotation failed:", e$message))
  })
}

# ──────────────────────────────────────────────────────────────────
# ANALYSIS: Gene list
# ──────────────────────────────────────────────────────────────────

#* Get full gene list from the Seurat object
#* @get /genes
function(res) {
  if (is.null(global_obj)) {
    genes <- c("CD3E","CD4","CD8A","MS4A1","LYZ") 
  } else {
    genes <- rownames(global_obj)
  }
  total_genes <- length(genes)
  returned_genes <- bounded_public_gene_names(genes)
  list(
    genes = returned_genes,
    count = total_genes,
    returned_count = length(returned_genes),
    truncated = total_genes > length(returned_genes)
  )
}

#* Get expression data for a specific gene
#* @get /gene-expression
function(res, gene) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  parsed_gene <- tryCatch(public_gene_identifier(gene), error = identity)
  if (inherits(parsed_gene, "error")) return(public_validation_response(res, parsed_gene))
  gene <- parsed_gene
  if (!(gene %in% rownames(global_obj))) return(list(error = "Gene not found in dataset"))
  
  total_cells <- ncol(global_obj)
  sample_idx <- bounded_sample_indices(total_cells, MAX_PUBLIC_CELL_VALUES)
  sample_cells <- colnames(global_obj)[sample_idx]
  expr_data <- FetchData(global_obj, vars = gene, cells = sample_cells)
  expr_data$ident <- Idents(global_obj)[rownames(expr_data)]
  umap_coords <- tryCatch(
    Embeddings(global_obj, "umap")[rownames(expr_data), , drop = FALSE],
    error = function(e) NULL
  )
  
  result <- list(
    gene = gene,
    expression = as.numeric(expr_data[[gene]]),
    clusters = bounded_public_labels(expr_data$ident),
    n_cells = total_cells,
    n_values = nrow(expr_data),
    sampled = total_cells > nrow(expr_data)
  )
  
  if (!is.null(umap_coords)) {
    result$u1 <- as.numeric(umap_coords[, 1])
    result$u2 <- as.numeric(umap_coords[, 2])
  }
  
  result
}

#* Feature values for a gene overlaid on UMAP
#* @get /feature-values
function(res, gene) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  parsed_gene <- tryCatch(public_gene_identifier(gene), error = identity)
  if (inherits(parsed_gene, "error")) return(public_validation_response(res, parsed_gene))
  gene <- parsed_gene
  if (!(gene %in% rownames(global_obj))) return(list(error = paste("Gene not found:", gene)))
  umap_coords <- tryCatch(Embeddings(global_obj, "umap"), error = function(e) NULL)
  if (is.null(umap_coords)) return(list(error = "UMAP not computed yet. Run the UMAP step first."))
  total_cells <- ncol(global_obj)
  sample_idx <- bounded_sample_indices(total_cells, MAX_PUBLIC_CELL_VALUES)
  sample_cells <- colnames(global_obj)[sample_idx]
  expr_data <- FetchData(global_obj, vars = gene, cells = sample_cells)
  umap_coords <- umap_coords[rownames(expr_data), , drop = FALSE]
  expr <- as.numeric(expr_data[[gene]])
  list(
    gene = gene,
    expression = expr,
    u1 = as.numeric(umap_coords[, 1]),
    u2 = as.numeric(umap_coords[, 2]),
    n_cells = total_cells,
    n_values = nrow(expr_data),
    sampled = total_cells > nrow(expr_data)
  )
}

#* Top marker gene heatmap data (avg expression per cluster)
#* @get /heatmap
function(res, top_n = 5) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  admission <- tryCatch(
    public_compute_admission(global_obj, "Heatmap"),
    error = identity
  )
  if (inherits(admission, "error")) {
    return(public_compute_admission_response(res, admission))
  }
  parsed_top_n <- tryCatch(
    public_bounded_integer(top_n, "top_n", 1, 20),
    error = identity
  )
  if (inherits(parsed_top_n, "error")) return(public_validation_response(res, parsed_top_n))
  top_n <- parsed_top_n
  identity_values <- Idents(global_obj)
  all_clusters <- public_identity_levels(identity_values)
  if (length(all_clusters) < 2) return(list(error = "Clustering required"))
  tryCatch({
    returned_clusters <- head(all_clusters, MAX_PUBLIC_CLUSTERS)
    identity_labels <- as.character(identity_values)
    eligible_idx <- which(!is.na(identity_labels) & identity_labels %in% returned_clusters)
    sample_relative <- bounded_group_sample_indices(
      identity_labels[eligible_idx], MAX_HEATMAP_CELLS
    )
    analysis_idx <- eligible_idx[sample_relative]
    analysis_cells <- colnames(global_obj)[analysis_idx]
    analysis_obj <- if (length(analysis_cells) < ncol(global_obj)) {
      subset(global_obj, cells = analysis_cells)
    } else {
      global_obj
    }

    markers <- FindAllMarkers(analysis_obj, only.pos = TRUE, min.pct = 0.1, logfc.threshold = 0.25, verbose = FALSE)
    if (is.null(markers) || nrow(markers) == 0) return(list(error = "No marker genes found."))
    top_genes <- bounded_marker_features(as.data.frame(markers), top_n)
    if (length(top_genes) == 0) return(list(error = "No finite marker genes found."))
    avg_mat <- AverageExpression(analysis_obj, features = top_genes, assays = "RNA")$RNA
    returned_cluster_names <- head(colnames(avg_mat), MAX_PUBLIC_CLUSTERS)
    avg_mat <- avg_mat[, returned_cluster_names, drop = FALSE]
    z_list <- lapply(seq_len(nrow(avg_mat)), function(i) as.numeric(avg_mat[i, ]))
    list(
      genes    = rownames(avg_mat),
      clusters = bounded_public_labels(colnames(avg_mat)),
      z        = z_list,
      top_n = top_n,
      n_genes = nrow(avg_mat),
      feature_limit = MAX_HEATMAP_GENES,
      n_cells = ncol(global_obj),
      analysis_cells = length(analysis_cells),
      sampled = length(analysis_cells) < ncol(global_obj),
      n_clusters = length(all_clusters),
      returned_clusters = ncol(avg_mat),
      clusters_truncated = length(all_clusters) > ncol(avg_mat)
    )
  }, error = function(e) list(error = paste("Heatmap failed:", e$message)))
}

#* Dot plot data — pct expressing and avg expression per cluster per gene
#* @get /dot-plot
function(res, genes = "") {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  admission <- tryCatch(
    public_compute_admission(global_obj, "Dot plot"),
    error = identity
  )
  if (inherits(admission, "error")) {
    return(public_compute_admission_response(res, admission))
  }
  gene_vec <- tryCatch(public_csv_gene_list(genes), error = identity)
  if (inherits(gene_vec, "error")) return(public_validation_response(res, gene_vec))
  missing <- gene_vec[!gene_vec %in% rownames(global_obj)]
  if (length(missing) > 0) return(list(error = paste("Genes not found:", paste(missing, collapse = ", "))))
  identity_values <- Idents(global_obj)
  all_clusters <- public_identity_levels(identity_values)
  if (length(all_clusters) < 2) return(list(error = "Clustering required"))
  tryCatch({
    clusters <- head(all_clusters, MAX_PUBLIC_CLUSTERS)
    identity_labels <- as.character(identity_values)
    eligible_idx <- which(!is.na(identity_labels) & identity_labels %in% clusters)
    sample_relative <- bounded_group_sample_indices(
      identity_labels[eligible_idx], MAX_PUBLIC_CELL_VALUES
    )
    analysis_idx <- eligible_idx[sample_relative]
    analysis_cells <- colnames(global_obj)[analysis_idx]
    expression_data <- FetchData(global_obj, vars = gene_vec, cells = analysis_cells)
    idents <- as.character(identity_values[rownames(expression_data)])
    avg_list <- vector("list", length(gene_vec))
    pct_list <- vector("list", length(gene_vec))
    for (gi in seq_along(gene_vec)) {
      g <- gene_vec[gi]
      expr <- as.numeric(expression_data[[g]])
      avg_row <- sapply(clusters, function(cl) mean(expr[idents == cl]))
      pct_row <- sapply(clusters, function(cl) mean(expr[idents == cl] > 0))
      avg_list[[gi]] <- as.numeric(avg_row)
      pct_list[[gi]] <- as.numeric(pct_row)
    }
    list(
      genes = gene_vec,
      clusters = bounded_public_labels(clusters),
      avg_expr = avg_list,
      pct_expr = pct_list,
      n_cells = ncol(global_obj),
      analysis_cells = nrow(expression_data),
      sampled = nrow(expression_data) < ncol(global_obj),
      n_clusters = length(all_clusters),
      returned_clusters = length(clusters),
      clusters_truncated = length(all_clusters) > length(clusters)
    )
  }, error = function(e) list(error = paste("Dot plot failed:", e$message)))
}

# ──────────────────────────────────────────────────────────────────
# Remaining Mock Analysis Endpoints
# ──────────────────────────────────────────────────────────────────

#* Infer Cell-Cell Communication (CellChat)
#* @get /cellchat
function(res) {
  make_provenance(result = list(active_pathways=c("WNT")), script_text="Mock", operation="cellchat")
}

#* Find cluster marker genes (DEG)
#* @get /deg
function(res) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  
  if (length(levels(Idents(global_obj))) < 2) {
    return(list(error = "Cannot find markers: Dataset only has one identity group. Please run Clustering first."))
  }

  script <- "markers <- FindAllMarkers(global_obj, only.pos = TRUE, min.pct = 0.25, logfc.threshold = 0.25)"
  
  tryCatch({
    # Execute
    markers <- FindAllMarkers(global_obj, only.pos = TRUE, min.pct = 0.25, logfc.threshold = 0.25)
    
    # Format markers for frontend table safely (seq_len avoids 1:0 looping)
    marker_list <- list()
    if (!is.null(markers) && nrow(markers) > 0) {
      marker_list <- lapply(seq_len(nrow(markers)), function(i) {
        list(
          gene = as.character(markers$gene[i]),
          cluster = as.character(markers$cluster[i]),
          p_val = markers$p_val_adj[i],
          log2FC = round(markers$avg_log2FC[i], 2),
          pct1 = markers$pct.1[i],
          pct2 = markers$pct.2[i]
        )
      })
    }
    
    # Prep Heatmap Data (Top 5 per cluster for visual clarity)
    heatmap_genes <- character(0)
    heatmap_clusters <- character(0)
    heatmap_z <- list()
    
    if (!is.null(markers) && nrow(markers) > 0) {
      suppressMessages({
        library(dplyr)
        top5 <- as.data.frame(markers) %>% group_by(cluster) %>% top_n(n = 5, wt = avg_log2FC)
        unique_genes <- unique(top5$gene)
        unique_genes <- intersect(unique_genes, rownames(global_obj))
        assay_use <- if ("RNA" %in% Assays(global_obj)) "RNA" else DefaultAssay(global_obj)
        avg_expr <- AverageExpression(global_obj, features = unique_genes, group.by = "seurat_clusters", assays = assay_use)[[assay_use]]
        
        # Convert matrix to row-major list for Plotly heatmap (z-attribute)
        heatmap_z <- lapply(1:nrow(avg_expr), function(i) as.numeric(avg_expr[i,]))
        heatmap_genes <- rownames(avg_expr)
        heatmap_clusters <- colnames(avg_expr)
      })
    }
    
    make_provenance(
      result = list(
        message = "Differential expression identification complete.",
        total_markers = if(is.null(markers)) 0 else nrow(markers),
        markers = marker_list,
        heatmap = list(
          genes = heatmap_genes,
          clusters = heatmap_clusters,
          z = heatmap_z
        )
      ),
      script_text = script,
      operation = "deg"
    )
  }, error = function(e) { res$status <- 500; list(error = paste("DEG failed:", e$message))
  })
}

#* Pathway Enrichment using clusterProfiler (ORA)
#* @get /enrichment
function(res, database = "GO_BP", pval_cutoff = 0.05, logfc_threshold = 0.25, top_n = 20, target_cluster = "all", exclude_artifacts = "true") {
  pval_cutoff    <- as.numeric(pval_cutoff)
  logfc_threshold <- as.numeric(logfc_threshold)
  top_n          <- as.integer(top_n)
  exclude_artifacts <- as.logical(exclude_artifacts)

  if (is.null(global_obj)) return(list(error = "No object loaded"))

  if (length(levels(Idents(global_obj))) < 2) {
    return(list(error = "Dataset only has one identity group. Please run Clustering first."))
  }

  # ── Species Auto-Detection ─────────────────────────────────
  is_mouse <- any(grepl("^[A-Z][a-z]+", rownames(global_obj)[1:20]))
  org_pkg <- if (is_mouse) "org.Mm.eg.db" else "org.Hs.eg.db"
  kegg_org <- if (is_mouse) "mmu" else "hsa"
  reactome_org <- if (is_mouse) "mouse" else "human"

  # ── Package availability checks ──────────────────────────────
  missing_pkgs <- character(0)
  if (!requireNamespace("clusterProfiler", quietly = TRUE)) missing_pkgs <- c(missing_pkgs, "clusterProfiler")
  if (!requireNamespace(org_pkg,   quietly = TRUE)) missing_pkgs <- c(missing_pkgs, org_pkg)
  if (database == "Reactome" && !requireNamespace("ReactomePA", quietly = TRUE)) missing_pkgs <- c(missing_pkgs, "ReactomePA")

  if (length(missing_pkgs) > 0) {
    install_cmd <- paste0('BiocManager::install(c("', paste(missing_pkgs, collapse = '", "'), '"))')
    return(list(error = paste0(
      "Required Bioconductor packages not installed: ", paste(missing_pkgs, collapse = ", "),
      ".\nInstall with:\n  if (!requireNamespace('BiocManager', quietly=TRUE)) install.packages('BiocManager')\n  ", install_cmd
    )))
  }

  tryCatch({
    suppressMessages({
      library(clusterProfiler)
      library(org_pkg, character.only = TRUE)
      if (database == "Reactome") library(ReactomePA)
    })

    # ── Step 1: Find marker genes ────────────────────────────
    if (!is.null(target_cluster) && target_cluster != "all") {
      cat("[Enrichment] Running FindMarkers for cluster", target_cluster, "(logfc.threshold =", logfc_threshold, ")...\n")
      if (!target_cluster %in% levels(Idents(global_obj))) {
        return(list(error = paste("Cluster", target_cluster, "not found.")))
      }
      markers <- FindMarkers(
        global_obj,
        ident.1       = target_cluster,
        only.pos      = TRUE,
        min.pct       = 0.1,
        logfc.threshold = logfc_threshold,
        verbose       = FALSE
      )
      if (!is.null(markers) && nrow(markers) > 0) {
        markers$gene <- rownames(markers)
      }
    } else {
      cat("[Enrichment] Running FindAllMarkers (logfc.threshold =", logfc_threshold, ")...\n")
      markers <- FindAllMarkers(
        global_obj,
        only.pos      = TRUE,
        min.pct       = 0.1,
        logfc.threshold = logfc_threshold,
        verbose       = FALSE
      )
    }

    if (is.null(markers) || nrow(markers) == 0) {
      return(list(error = "No marker genes found. Try lowering logfc.threshold or running Clustering first."))
    }

    if (isTRUE(exclude_artifacts)) {
      cat("[Enrichment] Excluding MT- and RPL/RPS artifact genes...\n")
      markers <- markers[!grepl("^(MT-|RPL|RPS)", markers$gene, ignore.case = TRUE), ]
      if (nrow(markers) == 0) {
        return(list(error = "No marker genes left after excluding mitochondrial and ribosomal genes."))
      }
    }

    # Deduplicated top marker genes (sorted by avg_log2FC)
    markers_sorted <- markers[order(-markers$avg_log2FC), ]
    gene_symbols   <- unique(markers_sorted$gene)
    cat("[Enrichment] Using", length(gene_symbols), "unique marker genes as input.\n")

    # ── Step 2: Symbol → Entrez ID mapping ──────────────────
    entrez_map <- suppressMessages(
      bitr(gene_symbols,
           fromType = "SYMBOL",
           toType   = "ENTREZID",
           OrgDb    = get(org_pkg))
    )
    if (nrow(entrez_map) == 0) {
      return(list(error = "Could not map any gene symbols to Entrez IDs. Check that genes follow HGNC nomenclature."))
    }
    entrez_ids <- unique(entrez_map$ENTREZID)

    # Universe = all genes in the object mapped to Entrez
    universe_map <- suppressMessages(
      bitr(rownames(global_obj),
           fromType = "SYMBOL",
           toType   = "ENTREZID",
           OrgDb    = get(org_pkg))
    )
    entrez_universe <- unique(universe_map$ENTREZID)
    cat("[Enrichment] Mapped", length(entrez_ids), "/", length(gene_symbols), "genes to Entrez IDs.\n")

    # ── Step 3: ORA dispatch ──────────────────────────────────
    script_text <- paste0(
      "markers <- FindAllMarkers(obj, only.pos=TRUE, logfc.threshold=", logfc_threshold, ")\n",
      "entrez  <- bitr(unique(markers$gene), fromType='SYMBOL', toType='ENTREZID', OrgDb=", org_pkg, ")\n"
    )

    ora_result <- NULL

    if (database == "Reactome") {
      script_text <- paste0(script_text,
                            "ora <- enrichPathway(entrez$ENTREZID, organism='human', pvalueCutoff=", pval_cutoff, ")\n")
      cat("[Enrichment] Running ReactomePA::enrichPathway...\n")
      ora_result <- suppressMessages(
        ReactomePA::enrichPathway(
          gene          = entrez_ids,
          universe      = entrez_universe,
          organism      = reactome_org,
          pvalueCutoff  = pval_cutoff,
          pAdjustMethod = "BH",
          readable      = TRUE
        )
      )

    } else if (database == "KEGG") {
      script_text <- paste0(script_text,
                            "ora <- enrichKEGG(entrez$ENTREZID, organism='hsa', pvalueCutoff=", pval_cutoff, ")\n")
      cat("[Enrichment] Running clusterProfiler::enrichKEGG...\n")
      ora_result <- suppressMessages(
        enrichKEGG(
          gene          = entrez_ids,
          universe      = entrez_universe,
          organism      = kegg_org,
          pvalueCutoff  = pval_cutoff,
          pAdjustMethod = "BH"
        )
      )

    } else {
      # GO_BP or GO_MF
      ont <- if (database == "GO_MF") "MF" else "BP"
      script_text <- paste0(script_text,
                            "ora <- enrichGO(entrez$ENTREZID, OrgDb=org.Hs.eg.db, ont='", ont, "', pvalueCutoff=", pval_cutoff, ")\n")
      cat("[Enrichment] Running clusterProfiler::enrichGO (ont=", ont, ")...\n")
      ora_result <- suppressMessages(
        enrichGO(
          gene          = entrez_ids,
          universe      = entrez_universe,
          OrgDb         = get(org_pkg),
          ont           = ont,
          pvalueCutoff  = pval_cutoff,
          pAdjustMethod = "BH",
          readable      = TRUE,
          minGSSize     = 5,
          maxGSSize     = 500
        )
      )
    }

    # ── Step 4: Format results ───────────────────────────────
    if (is.null(ora_result) || nrow(as.data.frame(ora_result)) == 0) {
      return(list(error = paste0(
        "No significant pathways found in ", database,
        " at p-adj < ", pval_cutoff,
        ". Try increasing pval_cutoff, lowering logfc_threshold, or choosing a different database."
      )))
    }

    df <- as.data.frame(ora_result)
    df <- df[order(df$p.adjust), ]
    if (nrow(df) > top_n) df <- df[1:top_n, ]

    top_pathways <- lapply(seq_len(nrow(df)), function(i) {
      ratio_str   <- as.character(df$GeneRatio[i])
      ratio_parts <- strsplit(ratio_str, "/")[[1]]
      ratio_num   <- if (length(ratio_parts) == 2) as.numeric(ratio_parts[1]) / as.numeric(ratio_parts[2]) else NA

      list(
        name          = as.character(df$Description[i]),
        id            = as.character(df$ID[i]),
        count         = as.integer(df$Count[i]),
        ratio         = ratio_str,
        gene_ratio_num = round(ratio_num, 4),
        p_adj         = as.numeric(df$p.adjust[i]),
        database      = database,
        genes         = as.character(df$geneID[i])  # "/" separated in clusterProfiler
      )
    })

    make_provenance(
      result = list(
        message           = paste0("ORA complete: ", length(top_pathways), " pathways enriched (", database, ")."),
        top_pathways      = top_pathways,
        gene_universe_size = length(entrez_universe),
        n_input_genes     = length(entrez_ids),
        database          = database
      ),
      script_text = script_text,
      operation   = "enrichment",
      packages_used = c("Seurat", "clusterProfiler", "org.Hs.eg.db"),
      parameters  = list(database = database, pval_cutoff = pval_cutoff,
                         logfc_threshold = logfc_threshold, top_n = top_n)
    )

  }, error = function(e) { res$status <- 500; list(error = paste("Enrichment failed:", e$message))
  })
}
# ──────────────────────────────────────────────────────────────────
# PIPELINE STEP: CellChat Inference
# ──────────────────────────────────────────────────────────────────

#* Run CellChat inference on the current Seurat object
#* @post /cellchat-infer
#* @parser json
function(res, req) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  body <- req$body
  group_by <- body$group_by
  database <- body$database # "human" or "mouse"
  
  if (is.null(group_by)) group_by <- "seurat_clusters"
  if (!group_by %in% colnames(global_obj@meta.data)) {
    return(list(error = paste("Grouping column not found:", group_by)))
  }
  
  tryCatch({
    if (!requireNamespace("CellChat", quietly = TRUE)) {
      stop("CellChat package is not installed. Please install it via the Diagnostics tab.")
    }
    library(CellChat)
    
    # ── Step 1: Prep Data ──────────────────────────────────────
    # CellChat requires normalized data
    data.input <- GetAssayData(global_obj, assay = "RNA", layer = "data")
    meta <- global_obj@meta.data
    
    # CellChat v2 rejects group labels that are purely numeric or start with "0"
    # (e.g. default seurat_clusters values "0", "1", "2", ...).
    # Remap to "Cluster 1", "Cluster 2", ... before passing to CellChat, and
    # record the mapping so we can restore original names in the output.
    orig_labels <- as.character(meta[[group_by]])
    unique_orig <- sort(unique(orig_labels))
    label_needs_remap <- any(grepl("^0$|^[0-9]+$", unique_orig))
    if (label_needs_remap) {
      label_map <- setNames(paste0("Cluster", seq_along(unique_orig)), unique_orig)
      meta[[group_by]] <- factor(label_map[orig_labels], levels = label_map)
      cat("[CellChat] Remapped numeric cluster labels to avoid CellChat v2 '0' restriction.\n")
    } else {
      meta[[group_by]] <- as.factor(meta[[group_by]])
    }
    
    cat("[CellChat] Creating CellChat object...\n")
    cellchat <- createCellChat(object = data.input, meta = meta, group.by = group_by)

    
    # ── Step 2: Set Database ───────────────────────────────────
    if (database == "mouse") {
      CellChatDB <- CellChatDB.mouse
    } else {
      CellChatDB <- CellChatDB.human
    }
    
    # Use the default secreted signaling + ECM + Cell-Cell Contact
    # Alternatively use the whole database:
    CellChatDB.use <- CellChatDB 
    cellchat@DB <- CellChatDB.use
    
    # ── Step 3: Preprocessing ──────────────────────────────────
    cat("[CellChat] Preprocessing...\n")
    
    tryCatch({
      cellchat <- subsetData(cellchat) # subsets expression data to signaling genes
    }, error = function(e) {
      if (grepl("numeric", e$message) || grepl("AnyMatrix", e$message)) {
        stop("Too few signaling genes (1) were found in your dataset, causing CellChat to fail. Ensure your dataset uses Gene Symbols (not Ensembl IDs) or has enough genes.")
      }
      stop(paste("CellChat subsetData failed:", e$message))
    })
    
    if (nrow(cellchat@data.signaling) < 5) {
      stop(paste("Only", nrow(cellchat@data.signaling), "signaling genes overlap with the CellChat database. Ensure your dataset uses Gene Symbols instead of Ensembl IDs, and contains enough genes."))
    }
    
    # For small datasets, min.cells = 1 or 5 might be needed
    cellchat <- identifyOverExpressedGenes(cellchat)
    cellchat <- identifyOverExpressedInteractions(cellchat)
    
    # ── Step 4: Inference ──────────────────────────────────────
    cat("[CellChat] Inferring communication probabilities...\n")
    # computeCommunProb can be slow on large datasets
    cellchat <- computeCommunProb(cellchat, raw.use = TRUE, population.size = TRUE)
    
    # Filter out communications with few cells
    # Use min.cells = 10 by default, but lower it if the smallest group is smaller
    group_sizes <- table(meta[[group_by]])
    min_size <- min(group_sizes[group_sizes > 0]) # min size of present groups
    min_cells_filter <- min(10, min_size)
    
    cat(sprintf("[CellChat] Filtering communications (min.cells = %d)\n", min_cells_filter))
    cellchat <- filterCommunication(cellchat, min.cells = min_cells_filter)
    
    # Pathway level inference
    cellchat <- computeCommunProbPathway(cellchat)
    # Aggregate networks
    cellchat <- aggregateNet(cellchat)
    
    # ── Step 5: Format Output ──────────────────────────────────
    # We will return the aggregated network matrices as an edge list
    net_weight <- cellchat@net$weight
    
    edges <- list()
    if (is.null(net_weight) || length(net_weight) == 0) {
      nodes <- character(0)
    } else {
      nodes <- rownames(net_weight)
      
      for(i in seq_along(nodes)) {
        for(j in seq_along(nodes)) {
          w <- net_weight[i, j]
          if (!is.na(w) && w > 0) {
            edges[[length(edges) + 1]] <- list(
              source = nodes[i],
              target = nodes[j],
              weight = w
            )
          }
        }
      }
    }
    
    make_provenance(
      result = list(
        message = paste("CellChat inference complete on", length(nodes), "groups."),
        nodes = as.list(nodes),
        edges = edges,
        database = database
      ),
      script_text = paste0(
        "library(CellChat)\n",
        "cellchat <- createCellChat(object = obj, group.by = '", group_by, "')\n",
        "cellchat@DB <- CellChatDB.", database, "\n",
        "cellchat <- subsetData(cellchat)\n",
        "cellchat <- identifyOverExpressedGenes(cellchat)\n",
        "cellchat <- identifyOverExpressedInteractions(cellchat)\n",
        "cellchat <- computeCommunProb(cellchat, raw.use = TRUE)\n",
        "cellchat <- filterCommunication(cellchat, min.cells = 10)\n",
        "cellchat <- computeCommunProbPathway(cellchat)\n",
        "cellchat <- aggregateNet(cellchat)\n"
      ),
      operation = "cellchat",
      packages_used = c("Seurat", "CellChat"),
      parameters = list(group_by = group_by, database = database)
    )
    
  }, error = function(e) { res$status <- 500; list(error = paste("CellChat inference failed:", e$message))
  })
}


# ──────────────────────────────────────────────────────────────────
# PUBLICATION: Figure Export Helper
# ──────────────────────────────────────────────────────────────────

# Resolve a color palette by name, with ggsci optional + fallback to RColorBrewer
get_pub_palette <- function(name, n) {
  ggsci_map <- list(
    npg    = "ggsci::pal_npg",
    nejm   = "ggsci::pal_nejm",
    lancet = "ggsci::pal_lancet",
    jama   = "ggsci::pal_jama",
    aaas   = "ggsci::pal_aaas",
    d3     = "ggsci::pal_d3"
  )

  if (name %in% names(ggsci_map)) {
    if (requireNamespace("ggsci", quietly = TRUE)) {
      tryCatch({
        fn_name <- sub("ggsci::", "", ggsci_map[[name]])
        pal_fn  <- getExportedValue("ggsci", fn_name)
        return(pal_fn()(max(n, 1)))
      }, error = function(e) {
        cat("[PubPlot] ggsci palette failed, falling back to Set2\n")
        name <<- "Set2"
      })
    } else {
      cat("[PubPlot] ggsci not installed; falling back to Set2 palette\n")
      name <- "Set2"
    }
  }

  # RColorBrewer palettes
  tryCatch({
    max_colors <- RColorBrewer::brewer.pal.info[name, "maxcolors"]
    safe_n <- min(max(n, 3), max_colors)
    cols <- RColorBrewer::brewer.pal(safe_n, name)
    if (n > max_colors) cols <- colorRampPalette(cols)(n)
    return(cols)
  }, error = function(e) {
    # Last resort: ggplot2 default hue
    return(scales::hue_pal()(n))
  })
}

# Build a ggplot2 publication-ready DimPlot or other Seurat plot
build_pub_plot <- function(params) {
  plot_type      <- params$plot_type %||% "UMAP"
  group_by       <- params$group_by  %||% "seurat_clusters"
  features       <- bounded_plot_features(params$features)
  title_str      <- params$title     %||% ""
  subtitle_str   <- params$subtitle  %||% ""
  x_label        <- params$x_label   %||% NULL
  y_label        <- params$y_label   %||% NULL
  pt_size        <- as.numeric(params$pt_size   %||% 1.0)
  alpha_val      <- as.numeric(params$alpha     %||% 1.0)
  do_label       <- isTRUE(params$label)
  label_size     <- as.numeric(params$label_size %||% 4)
  do_repel       <- !isFALSE(params$repel)   # default TRUE
  legend_pos     <- params$legend_position  %||% "right"
  font_size      <- as.numeric(params$font_size %||% 12)
  palette_name   <- params$color_palette %||% "Set2"
  split_by       <- if (!is.null(params$split_by) && nchar(params$split_by) > 0) params$split_by else NULL
  ncol_val       <- if (!is.null(params$ncol)) {
    as.integer(bounded_plot_number(params$ncol, 1, 1, 6))
  } else NULL
  dot_scale_val  <- as.numeric(params$dot_scale %||% 6)
  log_scale_val  <- isTRUE(params$log_scale)
  top_n_val      <- as.integer(bounded_plot_number(params$top_n %||% 5, 5, 1, 10))

  n_groups <- tryCatch(length(levels(Idents(global_obj))), error = function(e) 8)
  palette_colors <- get_pub_palette(palette_name, max(n_groups, 8))

  p <- NULL

  if (plot_type == "UMAP") {
    dim_args <- list(
      object         = global_obj,
      reduction      = "umap",
      group.by       = group_by,
      pt.size        = pt_size,
      alpha          = alpha_val,
      label          = do_label,
      label.size     = label_size,
      repel          = do_repel,
      cols           = palette_colors
    )
    if (!is.null(split_by)) dim_args$split.by <- split_by
    if (!is.null(ncol_val)) dim_args$ncol <- ncol_val
    p <- do.call(DimPlot, dim_args)

  } else if (plot_type == "FeaturePlot") {
    if (is.null(features) || length(features) == 0) stop("Features required for FeaturePlot")
    valid_features <- intersect(features, rownames(global_obj))
    if (length(valid_features) == 0) stop("None of the requested features found in dataset")
    fp_args <- list(
      object   = global_obj,
      features = valid_features,
      pt.size  = pt_size,
      alpha    = alpha_val
    )
    if (log_scale_val) fp_args$log1p <- FALSE  # FeaturePlot takes log scale data already
    if (!is.null(split_by)) fp_args$split.by <- split_by
    if (!is.null(ncol_val)) fp_args$ncol <- ncol_val
    p <- do.call(FeaturePlot, fp_args)

  } else if (plot_type == "DotPlot") {
    if (is.null(features) || length(features) == 0) stop("Features required for DotPlot")
    valid_features <- intersect(features, rownames(global_obj))
    if (length(valid_features) == 0) stop("None of the requested features found in dataset")
    p <- DotPlot(global_obj, features = valid_features, group.by = group_by,
                 dot.scale = dot_scale_val, cols = c("lightgrey", palette_colors[length(palette_colors)])) +
         RotatedAxis()

  } else if (plot_type == "Heatmap") {
    if (is.null(features) || length(features) == 0) {
      stop("Explicit features are required for Heatmap preview/export; marker discovery runs as a durable DEG job.")
    }
    valid_features <- intersect(features, rownames(global_obj))
    if (length(valid_features) == 0) stop("None of the requested features found in dataset")
    p <- DoHeatmap(global_obj, features = valid_features, group.by = group_by)

  } else if (plot_type == "Violin") {
    if (is.null(features) || length(features) == 0) stop("Features required for Violin")
    valid_features <- intersect(features, rownames(global_obj))
    if (length(valid_features) == 0) stop("None of the requested features found in dataset")
    vln_args <- list(
      object   = global_obj,
      features = valid_features,
      group.by = group_by,
      pt.size  = 0,
      cols     = palette_colors
    )
    if (!is.null(split_by)) vln_args$split.by <- split_by
    if (!is.null(ncol_val)) vln_args$ncol <- ncol_val
    p <- do.call(VlnPlot, vln_args)

  } else {
    stop(paste("Unsupported plot type:", plot_type))
  }

  # Apply publication theme + labels
  p <- p + theme_classic(base_size = font_size) +
    theme(
      legend.position  = legend_pos,
      plot.title       = element_text(face = "bold", hjust = 0.5),
      plot.subtitle    = element_text(hjust = 0.5, color = "grey40"),
      axis.title       = element_text(face = "bold"),
      panel.background = element_rect(fill = "white", color = NA),
      plot.background  = element_rect(fill = "white", color = NA),
      legend.background = element_rect(fill = "white", color = NA)
    )

  title_final <- if (nchar(title_str) > 0) title_str else NULL
  sub_final   <- if (nchar(subtitle_str) > 0) subtitle_str else NULL
  x_final     <- x_label
  y_final     <- y_label

  p <- p + labs(title = title_final, subtitle = sub_final)
  if (!is.null(x_final)) p <- p + xlab(x_final)
  if (!is.null(y_final)) p <- p + ylab(y_final)

  return(p)
}


# NULL-coalescing operator
`%||%` <- function(a, b) if (!is.null(a) && length(a) > 0 && a != "") a else b

#* Export a publication-ready figure to disk
#* @post /export-figure
#* @parser json
function(res, req) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))

  body <- req$body

  tryCatch({
    # Parse params
    format   <- body$format  %||% "png"
    # SECURITY: `format` becomes the output filename extension below, so it must
    # never be allowed to introduce a path component (`/`, `\`, `..`, NUL) or any
    # other arbitrary value. Whitelist the known-safe formats and REJECT anything
    # else with a clear error rather than silently coercing it — a coerced value
    # would hide a malformed/hostile request instead of surfacing it. The check
    # lives in is_allowed_export_format() (top of file) so the regression test
    # exercises the SAME predicate the endpoint uses.
    if (!is_allowed_export_format(format)) {
      res$status <- 400
      return(list(error = unsupported_export_format_message()))
    }
    width    <- bounded_plot_number(body$width %||% 8, 8, 1, 12)
    height   <- bounded_plot_number(body$height %||% 6, 6, 1, 12)
    dpi_val  <- as.integer(bounded_plot_number(body$dpi %||% 300, 300, 72, 300))
    if (!plot_pixel_budget_ok(width, height, dpi_val)) {
      res$status <- 400
      return(list(error = "Requested figure dimensions exceed the render budget."))
    }

    # Coerce features from JSON array to character vector
    features_raw <- body$features
    if (!is.null(features_raw) && length(features_raw) > 0) {
      body$features <- bounded_plot_features(features_raw)
    }

    # ── Collision-resistant, user/object-scoped export destination ──────────
    # SECURITY: the export directory segment is derived ONLY from the
    # server-injected X-Object-ID header. Express sets that header to a
    # server-derived state key (`user-<id>[:obj-<id>]`) on every proxied
    # request and OVERRIDES any client-supplied value, so it is trusted here.
    # R must NOT trust any client-supplied user/path/export header for this:
    # do not read an export dir, user id, or filename from the request body.
    # The segment is still sanitized as defense-in-depth.
    object_seg <- req$HTTP_X_OBJECT_ID
    if (is.null(object_seg) || nchar(object_seg) == 0) object_seg <- "DEFAULT"
    object_seg <- gsub("[^A-Za-z0-9._-]", "_", object_seg)

    export_dir <- file.path(getwd(), "..", "exports", object_seg)
    if (!dir.exists(export_dir)) dir.create(export_dir, recursive = TRUE)

    # plot_type is client-supplied — sanitize it to a safe filename segment.
    plot_type <- body$plot_type %||% "Plot"
    plot_type_safe <- gsub("[^A-Za-z0-9._-]", "_", plot_type)

    # A timestamp alone collides when two users (or one user firing twice)
    # export the same plot type within the same second. Append a random suffix
    # so concurrent same-second exports cannot overwrite each other.
    timestamp <- format(Sys.time(), "%Y%m%d_%H%M%S")
    rand_suffix <- paste0(sample(c(letters, 0:9), 16, replace = TRUE), collapse = "")
    file_name <- paste0(plot_type_safe, "_", timestamp, "_", rand_suffix, ".", format)
    file_path <- file.path(export_dir, file_name)
    file_path <- normalizePath(file_path, mustWork = FALSE)

    # Build the plot
    p <- build_pub_plot(body)

    # Open output device
    if (format == "pdf") {
      pdf(file_path, width = width, height = height)
    } else if (format == "svg") {
      svg(file_path, width = width, height = height)
    } else {
      png(file_path, width = width, height = height, units = "in", res = dpi_val)
    }
    print(p)
    dev.off()

    # Generate a 150dpi JPEG thumbnail for the gallery
    thumbnail_b64 <- tryCatch({
      if (!requireNamespace("base64enc", quietly = TRUE)) stop("base64enc missing")
      tmp_thumb <- tempfile(fileext = ".jpg")
      jpeg(tmp_thumb, width = 6, height = 4.5, units = "in", res = 150, quality = 85)
      print(p)
      dev.off()
      raw_bytes <- readBin(tmp_thumb, "raw", file.info(tmp_thumb)$size)
      b64 <- base64enc::base64encode(raw_bytes)
      unlink(tmp_thumb)
      paste0("data:image/jpeg;base64,", b64)
    }, error = function(e) {
      if (dev.cur() > 1) dev.off()
      ""
    })

    make_provenance(
      result = list(
        message      = paste("Successfully exported", plot_type, "to", file_name),
        file_name    = file_name,
        thumbnail_b64 = thumbnail_b64
      ),
      script_text = paste0(
        "# Export: ", plot_type, "\n",
        "p <- build_publication_plot(params)\n",
        if (format == "pdf") paste0("pdf('server-managed-export', width=", width, ", height=", height, ")\n")
        else paste0("png('server-managed-export', width=", width, ", height=", height, ", res=", dpi_val, ", units='in')\n"),
        "print(p)\ndev.off()\n"
      ),
      operation  = "export",
      parameters = as.list(body)
    )
  }, error = function(e) {
    if (dev.cur() > 1) dev.off()
    list(error = paste("Figure export failed:", e$message))
  })
}

#* Fast preview render — returns 150dpi JPEG base64 only (no file saved, no provenance)
#* @post /export-preview
#* @parser json
function(res, req) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  admission <- tryCatch(
    public_compute_admission(global_obj, "Plot preview"),
    error = identity
  )
  if (inherits(admission, "error")) {
    return(public_compute_admission_response(res, admission))
  }

  body <- req$body
  if (!is.list(body)) {
    res$status <- 400
    return(list(error = "Plot preview parameters are required."))
  }

  # Coerce features
  features_raw <- body$features
  if (!is.null(features_raw) && length(features_raw) > 0) {
    body$features <- bounded_plot_features(features_raw)
  }

  tmp_file <- NULL
  plot_device <- NULL
  tryCatch({
    if (!requireNamespace("base64enc", quietly = TRUE)) {
      stop("Package 'base64enc' must be installed for preview rendering.")
    }

    p <- build_pub_plot(body)

    tmp_file <- tempfile(fileext = ".jpg")
    jpeg(tmp_file, width = 6, height = 4.5, units = "in", res = 150, quality = 85)
    plot_device <- dev.cur()
    print(p)
    dev.off(which = plot_device)
    plot_device <- NULL

    raw_bytes <- readBin(tmp_file, "raw", file.info(tmp_file)$size)
    b64 <- base64enc::base64encode(raw_bytes)
    list(result = list(base64 = paste0("data:image/jpeg;base64,", b64)))

  }, error = function(e) {
    list(error = paste("Preview failed:", e$message))
  }, finally = {
    if (!is.null(plot_device) && plot_device %in% dev.list()) {
      try(dev.off(which = plot_device), silent = TRUE)
    }
    if (!is.null(tmp_file) && file.exists(tmp_file)) unlink(tmp_file)
  })
}

#* @post /render-plot-base64
#* @parser json
function(res, req) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  admission <- tryCatch(
    public_compute_admission(global_obj, "Base64 plot render"),
    error = identity
  )
  if (inherits(admission, "error")) {
    return(public_compute_admission_response(res, admission))
  }

  body <- req$body
  parsed <- tryCatch({
    if (!is.list(body)) stop("Plot render parameters are required.")
    list(
      plot_type = public_choice(
        public_scalar_text(body$plot_type, "plot_type"),
        "plot_type",
        c("UMAP", "FeaturePlot", "Violin")
      ),
      features = bounded_plot_features(body$features),
      group_by = if (is.null(body$group_by) || identical(body$group_by, "")) {
        NULL
      } else {
        public_metadata_column(global_obj, body$group_by, "group_by")
      },
      width = bounded_plot_number(body$width, 6, 1, 12),
      height = bounded_plot_number(body$height, 5, 1, 12),
      resolution = bounded_plot_number(body$res, 150, 72, 300)
    )
  }, error = identity)
  if (inherits(parsed, "error")) return(public_validation_response(res, parsed))
  plot_type <- parsed$plot_type
  features <- parsed$features
  group_by <- parsed$group_by
  width <- parsed$width
  height <- parsed$height
  resolution <- parsed$resolution

  if (!plot_pixel_budget_ok(width, height, resolution)) {
    res$status <- 400
    return(list(error = "Requested plot dimensions exceed the render budget."))
  }

  tmp_file <- NULL
  plot_device <- NULL
  tryCatch({
    if (!requireNamespace("base64enc", quietly = TRUE)) {
      stop("Package 'base64enc' must be installed to use base64 rendering.")
    }

    tmp_file <- tempfile(fileext = ".png")
    png(tmp_file, width = width, height = height, units = "in", res = resolution)
    plot_device <- dev.cur()

    p <- NULL
    if (plot_type == "UMAP") {
      p <- DimPlot(global_obj, reduction = "umap", group.by = group_by,
                   label = TRUE, repel = TRUE)
    } else if (plot_type == "FeaturePlot") {
      valid_features <- intersect(as.character(unlist(features)), rownames(global_obj))
      if (length(valid_features) > 0) {
        p <- FeaturePlot(global_obj, features = valid_features[1])
      } else {
        stop("Feature not found.")
      }
    } else if (plot_type == "Violin") {
      valid_features <- intersect(as.character(unlist(features)), rownames(global_obj))
      if (length(valid_features) > 0) {
        p <- VlnPlot(global_obj, features = valid_features[1], group.by = group_by, pt.size = 0)
      } else {
        stop("Feature not found.")
      }
    } else {
      stop(paste("Unsupported plot type for base64:", plot_type))
    }

    print(p)
    dev.off(which = plot_device)
    plot_device <- NULL

    raw_bytes <- readBin(tmp_file, "raw", file.info(tmp_file)$size)
    b64 <- base64enc::base64encode(raw_bytes)
    list(result = list(base64 = paste0("data:image/png;base64,", b64)))

  }, error = function(e) {
    list(error = paste("Base64 Render failed:", e$message))
  }, finally = {
    if (!is.null(plot_device) && plot_device %in% dev.list()) {
      try(dev.off(which = plot_device), silent = TRUE)
    }
    if (!is.null(tmp_file) && file.exists(tmp_file)) unlink(tmp_file)
  })
}

#* Bit-Accurate Validation & Sanity Checks
#* @get /validate
function(res) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  admission <- tryCatch(
    public_compute_admission(global_obj, "Validation"),
    error = identity
  )
  if (inherits(admission, "error")) {
    return(public_compute_admission_response(res, admission))
  }
  
  tryCatch({
    # Compute percent.mt if not already present
    if (!"percent.mt" %in% colnames(global_obj@meta.data)) {
      global_obj[["percent.mt"]] <<- PercentageFeatureSet(global_obj, pattern = "^MT-")
    }
    
    cell_count <- ncol(global_obj)
    feature_count <- nrow(global_obj)
    median_genes <- round(median(global_obj$nFeature_RNA), 2)
    median_counts <- round(median(global_obj$nCount_RNA), 2)
    mean_mt <- round(mean(global_obj$percent.mt), 4)
    
    # Sparsity
    counts_mat <- GetAssayData(global_obj, layer = "counts")
    nnz <- length(counts_mat@x)
    total <- as.numeric(nrow(counts_mat)) * as.numeric(ncol(counts_mat))
    sparsity <- round((1 - nnz / total) * 100, 2)
    
    # Check for normalized data
    has_normalized <- tryCatch({
      d <- GetAssayData(global_obj, layer = "data")
      !identical(d, counts_mat)
    }, error = function(e) FALSE)
    
    # Check for PCA
    has_pca <- "pca" %in% names(global_obj@reductions)
    pca_stdevs <- if (has_pca) {
      tryCatch(
        if (existsFunction("Stdev")) Stdev(global_obj, reduction = "pca")
        else if (existsFunction("Stdevs")) Stdevs(global_obj, reduction = "pca")
        else global_obj[["pca"]]@stdev,
        error = function(e) global_obj[["pca"]]@stdev
      )
    } else {
      NA
    }
    pca_variance <- if (has_pca && !any(is.na(pca_stdevs))) round(pca_stdevs[1]^2 / sum(pca_stdevs^2) * 100, 3) else NA

    
    # Check for clusters
    has_clusters <- "seurat_clusters" %in% colnames(global_obj@meta.data)
    n_clusters <- if (has_clusters) length(unique(global_obj$seurat_clusters)) else NA
    
    # Check for UMAP
    has_umap <- "umap" %in% names(global_obj@reductions)
    
    make_provenance(
      result = list(
        cell_count = cell_count,
        feature_count = feature_count,
        median_genes = median_genes,
        median_counts = median_counts,
        mito_mean = paste0(mean_mt, "%"),
        sparsity = paste0(sparsity, "%"),
        has_normalized = has_normalized,
        has_pca = has_pca,
        pca_top_variance = if (!is.na(pca_variance)) paste0(pca_variance, "%") else "N/A",
        has_clusters = has_clusters,
        n_clusters = if (!is.na(n_clusters)) n_clusters else "N/A",
        has_umap = has_umap,
        pipeline_steps = paste(
          c("load",
            if (has_normalized) "normalize",
            if (has_pca) "pca",
            if (has_clusters) "cluster",
            if (has_umap) "umap"),
          collapse = " → "
        )
      ),
      script_text = "# Validation: extract bit-accurate metrics from current Seurat object",
      operation = "validation"
    )
  }, error = function(e) { res$status <- 500; list(error = paste("Validation failed:", e$message))
  })
}


