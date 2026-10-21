# ── Session ID ────────────────────────────────────────────────────
# Generated fresh on every R process start. Used by the frontend to
# detect restarts so cached pipeline steps are re-executed in R.
r_runtime_instance_id <- paste0(format(Sys.time(), "%Y%m%d%H%M%S"), "-",
                                paste0(sample(c(letters, 0:9), 16, replace = TRUE), collapse = ""))
r_session_id <- r_runtime_instance_id
r_execution_generation <- digest::digest(r_runtime_instance_id, algo = "sha256", serialize = FALSE)
r_execution_order <- 0
cat("[R] Session ID:", r_session_id, "\n")

# Holds the physical Seurat object for stateful processing
global_obj <- NULL
# Holds the unfiltered starting point for the current object (for non-destructive QC re-runs)
raw_obj <- NULL

# These revisions belong to the private live session, never the scientific object.
# A trusted checkpoint load establishes a clean baseline; legacy imports have no baseline.
live_revision <- 0
live_saved_revision <- NULL

live_session_revision_state <- function() {
  list(
    live_revision = live_revision,
    saved_revision = live_saved_revision,
    has_unsaved_changes = !is.null(global_obj) &&
      (is.null(live_saved_revision) || live_revision != live_saved_revision)
  )
}

mark_live_session_changed <- function() {
  live_revision <<- live_revision + 1
  invisible(NULL)
}

restore_active_session <- function(session = NULL) {
  global_obj <<- session$global
  raw_obj <<- session$raw
  live_revision <<- if (is.null(session$live_revision)) 0 else session$live_revision
  live_saved_revision <<- session$saved_revision
  invisible(NULL)
}

# ── Helper: generate a provenance envelope ────────────────────────
make_provenance <- function(result, script_text, operation = "unknown",
                            packages_used = c("Seurat"), parameters = list()) {
  r_execution_order <<- r_execution_order + 1
  package_versions <- lapply(packages_used, function(name) {
    version <- tryCatch(as.character(utils::packageVersion(name)), error = function(error) NULL)
    list(name = name, version = version)
  })
  list(
    provenance = list(
      id = paste0("prov-", format(Sys.time(), "%Y%m%d%H%M%S"), "-", sample(1000:9999, 1)),
      timestamp = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
      language = "R",
      languageVersion = paste0(R.version$major, ".", R.version$minor),
      packages = packages_used,
      script = script_text,
      parameters = parameters,
      operation = operation,
      execution = list(generation = r_execution_generation, order = r_execution_order,
                       packages = package_versions)
    ),
    result = result,
    live_state = live_session_revision_state()
  )
}

# ── Session Management ──────────────────────────────────────────────
active_sessions <- new.env(parent = emptyenv())
active_session_clock <- 0
# Test-only records captured inside a job-scoped R request. A synchronous
# Plumber process cannot serve the external diagnostic endpoint while a long
# scientific handler is running, so post-request inspection alone would only
# see normal cleanup rather than the active job state.
test_job_session_observations <- new.env(parent = emptyenv())

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
    live_revision = live_revision,
    saved_revision = live_saved_revision,
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

# Heavy compute hydrates a durable checkpoint under an exact job-scoped key.
# That object may exist only for the lifetime of the following scientific route;
# retaining it after the route returns would let a later user's job share an R
# process containing the prior user's expression state. Canonical interactive
# keys deliberately do not match this shape and remain session-cached.
job_scoped_active_session_key <- function(value) {
  sid <- tryCatch(validate_internal_state_key(value), error = function(error) NULL)
  if (is.null(sid) ||
      !grepl("^user-[0-9]+:obj-ao_([0-9a-f]{24}|[0-9a-f]{64})-job-job_[0-9a-f]{24}$", sid)) {
    return(NULL)
  }
  sid
}

release_job_scoped_active_session <- function(req, sid) {
  sid <- job_scoped_active_session_key(sid)
  if (is.null(sid)) return(invisible(FALSE))
  # The postroute hook must not re-save the just-released globals.
  req$traceomics_session_persist <- FALSE
  restore_active_session()
  if (exists(sid, envir = active_sessions, inherits = FALSE)) {
    rm(list = sid, envir = active_sessions)
  }
  invisible(TRUE)
}

record_test_job_session_observation <- function(sid) {
  diagnostics_enabled <- identical(Sys.getenv("ENABLE_R_TEST_DIAGNOSTICS"), "true") &&
    !identical(Sys.getenv("NODE_ENV"), "production")
  sid <- job_scoped_active_session_key(sid)
  if (!diagnostics_enabled || is.null(sid)) return(invisible(FALSE))
  active_keys <- ls(envir = active_sessions, all.names = TRUE)
  test_job_session_observations[[sid]] <<- list(
    observed_at = as.character(Sys.time()),
    has_global_obj = !is.null(global_obj),
    active_session_key_count = as.integer(length(active_keys)),
    own_key_present = sid %in% active_keys,
    foreign_key_count = as.integer(sum(active_keys != sid))
  )
  invisible(TRUE)
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
  req$traceomics_authenticated <- TRUE
  TRUE
}
