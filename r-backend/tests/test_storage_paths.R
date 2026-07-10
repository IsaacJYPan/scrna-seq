plumber_env <- new.env(parent = globalenv())
sys.source(file.path("r-backend", "plumber.R"), envir = plumber_env)

root <- tempfile("durable-storage-")
dir.create(root, recursive = TRUE)
previous_root <- Sys.getenv("STORAGE_ROOT", unset = NA_character_)
Sys.setenv(STORAGE_ROOT = root)

on.exit({
  if (is.na(previous_root)) Sys.unsetenv("STORAGE_ROOT")
  else Sys.setenv(STORAGE_ROOT = previous_root)
  unlink(root, recursive = TRUE, force = TRUE)
}, add = TRUE)

expect_error <- function(expr) {
  failed <- FALSE
  tryCatch(force(expr), error = function(e) failed <<- TRUE)
  if (!failed) stop("Expected storage validation to fail.")
}

valid_key <- "projects/proj_abc/checkpoints/job_def/result.rds"
valid_path <- plumber_env$validate_storage_key(valid_key, for_write = TRUE)
safe_root <- normalizePath(root, winslash = "/", mustWork = TRUE)
if (!startsWith(valid_path, paste0(safe_root, "/"))) {
  stop("Valid project storage key did not stay under STORAGE_ROOT.")
}

plumber_env$atomic_save_rds(list(ok = TRUE), valid_path)
if (!isTRUE(readRDS(valid_path)$ok)) stop("Atomic RDS write did not round-trip.")
if (length(list.files(dirname(valid_path), pattern = "\\.partial-")) != 0) {
  stop("Atomic RDS write left a partial file behind.")
}

bad_keys <- c(
  "../outside.rds",
  "/absolute.rds",
  "projects/proj_abc/checkpoints/job_def/../outside.rds",
  "projects/proj_abc/secrets/job_def/file.rds",
  "projects/proj_abc/checkpoints/job_def/%2e%2e.rds",
  "projects\\proj_abc\\checkpoints\\job_def\\file.rds"
)
for (key in bad_keys) expect_error(plumber_env$validate_storage_key(key, for_write = TRUE))

outside <- tempfile("outside-storage-")
dir.create(outside)
on.exit(unlink(outside, recursive = TRUE, force = TRUE), add = TRUE)
linked_parent <- file.path(root, "projects", "proj_link")
dir.create(linked_parent, recursive = TRUE)
link_path <- file.path(linked_parent, "checkpoints")
linked <- suppressWarnings(file.symlink(outside, link_path))
if (isTRUE(linked)) {
  expect_error(plumber_env$validate_storage_key(
    "projects/proj_link/checkpoints/job_def/file.rds",
    for_write = TRUE
  ))
  if (dir.exists(file.path(outside, "job_def"))) {
    stop("Storage validation created directories through a symbolic link.")
  }
}

cat("Durable storage path tests passed.\n")
